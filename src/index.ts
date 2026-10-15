// todo-supervisor — OpenCode V2 server plugin.
//
// Aspect 1 (scaffold & loading) done: registers, logs setup/unload, options
// flow. Aspect 2 wired the raw event stream behind `debugEvents` for payload
// verification. Aspects 3–5 added options parsing, storage and the todo tools.
// Aspect 6+ wires the event stream into the supervisor state machine
// (src/supervisor.ts, PLAN.md §5.4).
//
// Hot-reload note: the runtime may start a new plugin generation before/without
// disposing the old one. Every instance therefore gets a unique tag, the event
// loop stops as soon as its abort signal fires, cleanup is idempotent and the
// supervisor uses storage ownership claims to make duplicate nudges impossible.
import { basename } from "node:path"
import { Plugin } from "@opencode/plugin"
import { log } from "./log"
import { MarkdownCache } from "./markdown"
import { parseOptions } from "./options"
import { registerTodoRpc } from "./rpc"
import { makeStore } from "./storage"
import { normalizeEvent, Supervisor, truncate } from "./supervisor"
import { makeContextInjector, registerExecuteAfterHook, registerTools } from "./tools"

// Module-level probe: if this counter keeps growing across reloads, plugin
// generations share one module instance (a truth we want to know).
let moduleLoads = 0
let instanceSeq = 0

export default Plugin.define({
  id: "todo-supervisor",
  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const tag = `${basename(ctx.location.directory)}#${++instanceSeq}@${Math.random().toString(36).slice(2, 6)}`
    const instanceLog = (...args: unknown[]) => log(`(${tag})`, ...args)

    instanceLog(`module load #${++moduleLoads}`)
    instanceLog(`setup — OpenCode ${ctx.app.version} · location=${ctx.location.directory} · project=${ctx.location.project.id}`)
    instanceLog(`options: ${JSON.stringify(options)}`)

    const store = makeStore(ctx.storage)
    const markdown = new MarkdownCache()
    // RPC events (aspect 11): the emitter is swapped in once the registration
    // exists; until then (and if registration fails) it is a no-op.
    let rpcEmit: (name: "updated" | "nudged", payload: Record<string, unknown>) => void = () => {}
    const supervisor = new Supervisor({
      options,
      store,
      projectID: ctx.location.project.id,
      tag,
      log: instanceLog,
      emitRpcEvent: (name, payload) => rpcEmit(name, payload),
      markdown,
      directory: ctx.location.directory,
      synthetic: async (input) => {
        await ctx.session.synthetic(input)
      },
      getSession: async (sessionID) => {
        const info = await ctx.session.get({ sessionID })
        return { projectID: info.projectID, parentID: info.parentID }
      },
      claims: ctx.storage,
    })

    const tools = await registerTools(ctx, store, {
      log: instanceLog,
      onTodosChanged(sessionID) {
        supervisor.notifyTodosChanged(sessionID)
        rpcEmit("updated", { sessionID })
      },
    }, options, { markdown, directory: ctx.location.directory })

    // Context injection (§5.5, aspect 10): a system block on every model request.
    let contextRegistration: { dispose(): Promise<void> } | undefined
    try {
      const injector = makeContextInjector(store, options, instanceLog)
      contextRegistration = await ctx.session.hook("context", (event) => injector(event))
      instanceLog(`context hook registered (injectTodoContext=${options.injectTodoContext})`)
    } catch (err) {
      instanceLog(`context hook registration failed: ${String(err)}`)
    }

    // RPC (§5.6, aspect 11): contract registration + event emitter.
    let rpcRegistration: { dispose(): Promise<void> } | undefined
    try {
      const reg = await registerTodoRpc(ctx, {
        store,
        supervisor,
        options,
        markdown,
        directory: ctx.location.directory,
        log: instanceLog,
      })
      rpcRegistration = reg
      rpcEmit = (name, payload) => reg.emit(name, payload)
      instanceLog("rpc registered (todo.list/clear/nudge/setEnabled/toggle/toggleFile/subscribe/unsubscribe)")
    } catch (err) {
      instanceLog(`rpc registration failed: ${String(err)}`)
    }

    // Markdown refresh on edits of subscribed files (§5.8, aspect 14c).
    let toolHookRegistration: { dispose(): Promise<void> } | undefined
    try {
      toolHookRegistration = await registerExecuteAfterHook(ctx, {
        store,
        markdown,
        options,
        directory: ctx.location.directory,
        onChanged: (sessionID) => {
          supervisor.notifyTodosChanged(sessionID)
          rpcEmit("updated", { sessionID })
        },
        log: instanceLog,
      })
      instanceLog("execute.after hook registered (markdown refresh)")
    } catch (err) {
      instanceLog(`execute.after hook registration failed: ${String(err)}`)
    }

    const ac = new AbortController()
    void runEventLoop(ctx, supervisor, instanceLog, { debugEvents: options.debugEvents }, ac.signal)

    // Startup reconcile: adopt stored lists whose sessions still exist (§5.4).
    void supervisor
      .reconcile()
      .catch((err) => instanceLog(`reconcile failed: ${String(err)}`))

    let cleaned = false
    return async () => {
      if (cleaned) return
      cleaned = true
      instanceLog("cleanup — disposing supervisor")
      ac.abort()
      supervisor.dispose()
      await tools.dispose()
      if (contextRegistration) {
        try {
          await contextRegistration.dispose()
        } catch (err) {
          instanceLog(`context hook dispose failed: ${String(err)}`)
        }
      }
      if (rpcRegistration) {
        try {
          await rpcRegistration.dispose()
        } catch (err) {
          instanceLog(`rpc dispose failed: ${String(err)}`)
        }
      }
      if (toolHookRegistration) {
        try {
          await toolHookRegistration.dispose()
        } catch (err) {
          instanceLog(`execute.after hook dispose failed: ${String(err)}`)
        }
      }
      instanceLog("unloaded")
    }
  },
})

async function runEventLoop(
  ctx: Plugin.Context,
  supervisor: Supervisor,
  instanceLog: (...args: unknown[]) => void,
  opts: { debugEvents: boolean },
  signal: AbortSignal,
): Promise<void> {
  instanceLog("event loop started")
  try {
    for await (const raw of ctx.event.subscribe({ signal })) {
      if (signal.aborted) break
      try {
        if (opts.debugEvents) {
          const event = normalizeEvent(raw)
          if (event) instanceLog(`event ${event.type}`, truncate(JSON.stringify(event.data)))
        }
        // supervisor.handle swallows per-event errors by design (§11, Aspect 6).
        await supervisor.handle(raw)
      } catch (err) {
        instanceLog("event handler error", String(err))
      }
    }
    instanceLog(`event loop ended (aborted=${signal.aborted})`)
  } catch (err) {
    instanceLog(`event loop failed (aborted=${signal.aborted})`, String(err))
  }
}
