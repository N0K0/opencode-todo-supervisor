// todo-supervisor — RPC contract + server registration (PLAN.md §5.6, aspect 11).
//
// `TodoRpc` is the shared contract: the server registers it (handlers below)
// and the TUI imports it (via `opencode-todo-supervisor/rpc`) to build a
// client and to subscribe to `updated` / `nudged`.
//
// Schemas are portable JSON-schema descriptors (the plugin handshake cannot
// carry effect schemas), so handlers validate their input explicitly.
import type { Plugin } from "@opencode/plugin"
import { Rpc } from "@opencode/plugin/rpc"
import { effectiveFiles, MarkdownCache, resolveMarkdownPath, toggleMarkdownItem } from "./markdown"
import type { Options } from "./options"
import type { TodoStore } from "./storage"
import type { Supervisor } from "./supervisor"

// Kept for consumers/tests that import the resolver from the RPC module.
export { resolveMarkdownPath } from "./markdown"

const sessionInput = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
  additionalProperties: false,
} as const

const sessionPathInput = {
  type: "object",
  properties: { sessionID: { type: "string" }, path: { type: "string" } },
  required: ["sessionID", "path"],
  additionalProperties: false,
} as const

const objectOutput = { type: "object", additionalProperties: true } as const

export const TodoRpc = Rpc.define({
  id: "todo",
  methods: {
    /** Current list + subscriptions + supervisor snapshot. */
    list: { input: sessionInput, output: objectOutput },
    /** Drop the stored list (subscriptions stay). */
    clear: { input: sessionInput, output: objectOutput },
    /** Send the nudge now (same dedupe/ownership rules as automatic nudges). */
    nudge: { input: sessionInput, output: objectOutput },
    /** Per-session supervision kill switch. */
    setEnabled: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, enabled: { type: "boolean" } },
        required: ["sessionID", "enabled"],
        additionalProperties: false,
      } as const,
      output: objectOutput,
    },
    /** Flip one session item between completed and pending (panel `x` action, aspect 12). */
    toggle: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, index: { type: "number" } },
        required: ["sessionID", "index"],
        additionalProperties: false,
      } as const,
      output: objectOutput,
    },
    /** Toggle a checklist item inside a subscribed markdown file (§5.8, panel `x`). */
    toggleFile: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, path: { type: "string" }, line: { type: "number" } },
        required: ["sessionID", "path", "line"],
        additionalProperties: false,
      } as const,
      output: objectOutput,
    },
    /** Subscribe to a markdown checklist file (§5.8); `.md`/`.markdown` only. */
    subscribe: { input: sessionPathInput, output: objectOutput },
    /** Shadow a subscription (config default or stored) — no longer counted. */
    unsubscribe: { input: sessionPathInput, output: objectOutput },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      } as const,
    },
    nudged: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, reason: { type: "string" } },
        required: ["sessionID", "reason"],
        additionalProperties: false,
      } as const,
    },
  },
})

export interface RpcDeps {
  store: TodoStore
  supervisor: Supervisor
  options: Options
  /** Per-file parse cache shared with the tools and the supervisor (§5.8). */
  markdown: MarkdownCache
  /** Location directory: relative subscription paths resolve against it (§5.8). */
  directory: string
  log: (...args: unknown[]) => void
}

export interface TodoRpcRegistration {
  dispose(): Promise<void>
  /** Fire-and-forget event emission (failures are logged, never thrown). */
  emit(name: "updated" | "nudged", payload: Record<string, unknown>): void
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid input: expected an object")
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid input: "${field}" must be a non-empty string`)
  }
  return value
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`invalid input: "${field}" must be a boolean`)
  return value
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`invalid input: "${field}" must be a non-negative integer`)
  }
  return value
}

export type RpcFileItem = { content: string; status: "pending" | "completed" | "canceled"; line: number }
export type RpcFileSection = { path: string; exists: boolean; items: RpcFileItem[] }

/** Effective subscription set (§5.8): parsed fresh on every `list` call. */
async function collectFiles(store: TodoStore, deps: RpcDeps, sessionID: string): Promise<RpcFileSection[]> {
  const subs = await store.loadSubs(sessionID)
  return effectiveFiles(deps.options, deps.directory, subs).map((path) => {
    const parsed = deps.markdown.parse(path)
    return {
      path,
      exists: parsed.exists,
      items: parsed.items.map((item) => ({
        content: item.text,
        status: item.state === "completed" ? "completed" : item.state === "canceled" ? "canceled" : "pending",
        line: item.line,
      })),
    }
  })
}

type RpcHandler = (raw: unknown, context?: unknown) => Promise<unknown>

/** Log and rethrow handler failures (the framework maps them to `rpc.internal`). */
function wrapHandlers<H extends Record<string, RpcHandler>>(handlers: H, log: (...args: unknown[]) => void): H {
  const wrapped: Record<string, RpcHandler> = {}
  for (const [name, handler] of Object.entries(handlers)) {
    wrapped[name] = async (raw, context) => {
      try {
        return await handler(raw, context)
      } catch (err) {
        log(`rpc ${name} failed: ${String(err)}`)
        throw err
      }
    }
  }
  return wrapped as H
}

export async function registerTodoRpc(ctx: Plugin.Context, deps: RpcDeps): Promise<TodoRpcRegistration> {
  const { store, supervisor, log } = deps
  let emitEvent: (name: "updated" | "nudged", payload: Record<string, unknown>) => Promise<void> = async () => {}

  const registration = await ctx.rpc.register(TodoRpc, wrapHandlers({
    list: async (raw) => {
      const sessionID = requireString(requireObject(raw).sessionID, "sessionID")
      await store.refreshTodos(sessionID)
      return {
        sessionID,
        items: store.getTodos(sessionID)?.items ?? [],
        files: await collectFiles(store, deps, sessionID),
        supervisor: supervisor.snapshot(sessionID),
      }
    },
    clear: async (raw) => {
      const sessionID = requireString(requireObject(raw).sessionID, "sessionID")
      await store.removeTodos(sessionID)
      supervisor.notifyTodosChanged(sessionID)
      await emitEvent("updated", { sessionID })
      log(`rpc clear (${sessionID})`)
      return { sessionID }
    },
    nudge: async (raw) => {
      const sessionID = requireString(requireObject(raw).sessionID, "sessionID")
      supervisor.forceNudge(sessionID)
      log(`rpc nudge (${sessionID})`)
      return { sessionID }
    },
    setEnabled: async (raw) => {
      const input = requireObject(raw)
      const sessionID = requireString(input.sessionID, "sessionID")
      const enabled = requireBoolean(input.enabled, "enabled")
      supervisor.setEnabled(sessionID, enabled)
      log(`rpc setEnabled (${sessionID}) enabled=${enabled}`)
      return { sessionID, enabled }
    },
    toggle: async (raw) => {
      const input = requireObject(raw)
      const sessionID = requireString(input.sessionID, "sessionID")
      const index = requireNumber(input.index, "index")
      const state = await store.refreshTodos(sessionID)
      const items = state?.items ?? []
      const item = items[index]
      if (!item) throw new Error(`invalid input: "index" ${index} is out of range`)
      const status: "pending" | "completed" = item.status === "completed" ? "pending" : "completed"
      const next = items.map((entry, i) => (i === index ? { ...entry, status } : entry))
      await store.setTodos(sessionID, next)
      supervisor.notifyTodosChanged(sessionID)
      await emitEvent("updated", { sessionID })
      log(`rpc toggle (${sessionID}) index=${index} → ${status}`)
      return { sessionID, index, status }
    },
    toggleFile: async (raw) => {
      const input = requireObject(raw)
      const sessionID = requireString(input.sessionID, "sessionID")
      const line = requireNumber(input.line, "line")
      if (line < 1) throw new Error(`invalid input: "line" must be a positive line number`)
      const path = resolveMarkdownPath(deps.directory, requireString(input.path, "path"))
      // Only files that are actually supervised may be edited (§5.8); arbitrary
      // paths are rejected so the panel cannot write anywhere on disk.
      const subscribed = effectiveFiles(deps.options, deps.directory, await store.loadSubs(sessionID))
      if (!subscribed.includes(path)) throw new Error(`invalid input: "${path}" is not a subscribed markdown file`)
      const state = toggleMarkdownItem(path, line)
      deps.markdown.invalidate(path)
      supervisor.notifyTodosChanged(sessionID)
      await emitEvent("updated", { sessionID })
      log(`rpc toggleFile (${sessionID}) ${path}:${line} → ${state}`)
      return { sessionID, path, line, state }
    },
    subscribe: async (raw) => {
      const input = requireObject(raw)
      const sessionID = requireString(input.sessionID, "sessionID")
      const path = resolveMarkdownPath(deps.directory, requireString(input.path, "path"))
      const current = (await store.loadSubs(sessionID)) ?? { files: [], removed: [] }
      const files = current.files.includes(path) ? current.files : [...current.files, path]
      const removed = current.removed.filter((entry) => entry !== path)
      await store.setSubs(sessionID, files, removed)
      await emitEvent("updated", { sessionID })
      log(`rpc subscribe (${sessionID}) ${path}`)
      return { sessionID, path }
    },
    unsubscribe: async (raw) => {
      const input = requireObject(raw)
      const sessionID = requireString(input.sessionID, "sessionID")
      const path = resolveMarkdownPath(deps.directory, requireString(input.path, "path"))
      const current = (await store.loadSubs(sessionID)) ?? { files: [], removed: [] }
      const files = current.files.filter((entry) => entry !== path)
      const removed = current.removed.includes(path) ? current.removed : [...current.removed, path]
      await store.setSubs(sessionID, files, removed)
      await emitEvent("updated", { sessionID })
      log(`rpc unsubscribe (${sessionID}) ${path}`)
      return { sessionID, path }
    },
  }, log))

  emitEvent = async (name, payload) => {
    try {
      await registration.events.emit(name, payload)
    } catch (err) {
      log(`rpc emit ${name} failed: ${String(err)}`)
    }
  }

  return {
    dispose: () => registration.dispose(),
    emit: (name, payload) => {
      void emitEvent(name, payload)
    },
  }
}
