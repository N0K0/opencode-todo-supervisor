// todo-supervisor — RPC contract + handler unit tests (aspect 11).
import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import type { Plugin } from "@opencode/plugin"
import { MarkdownCache } from "./markdown"
import { DEFAULTS, type Options } from "./options"
import { registerTodoRpc, resolveMarkdownPath, TodoRpc } from "./rpc"
import type { TodoItem, TodoStore } from "./storage"
import type { Supervisor } from "./supervisor"

type SubRecord = { version: 1; sessionID: string; files: string[]; removed: string[]; updatedAt: number }

function makeWorld(seedItems: TodoItem[] = []) {
  const todos = new Map<string, TodoItem[]>([["s1", seedItems]])
  const subs = new Map<string, SubRecord>()
  const calls: string[] = []
  const emitted: { name: string; payload: Record<string, unknown> }[] = []

  const store = {
    getTodos: (sessionID: string) =>
      todos.has(sessionID)
        ? { version: 1 as const, sessionID, items: todos.get(sessionID)!, updatedAt: 0 }
        : undefined,
    refreshTodos: async (sessionID: string) =>
      todos.has(sessionID)
        ? { version: 1 as const, sessionID, items: todos.get(sessionID)!, updatedAt: 0 }
        : undefined,
    setTodos: async (sessionID: string, items: TodoItem[]) => {
      todos.set(sessionID, items)
      return { version: 1 as const, sessionID, items, updatedAt: 0 }
    },
    removeTodos: async (sessionID: string) => void todos.delete(sessionID),
    loadSubs: async (sessionID: string) => subs.get(sessionID),
    setSubs: async (sessionID: string, files: string[], removed: string[]) => {
      const state: SubRecord = { version: 1, sessionID, files, removed, updatedAt: 0 }
      subs.set(sessionID, state)
      return state
    },
  } as unknown as TodoStore

  const supervisor = {
    snapshot: () => ({ registered: true, status: "idle" }),
    notifyTodosChanged: (sessionID: string) => void calls.push(`changed ${sessionID}`),
    forceNudge: (sessionID: string) => void calls.push(`nudge ${sessionID}`),
    setEnabled: (sessionID: string, enabled: boolean) => void calls.push(`enabled ${sessionID} ${enabled}`),
  } as unknown as Supervisor

  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {}
  const ctx = {
    rpc: {
      register: async (_definition: unknown, registered: typeof handlers) => {
        Object.assign(handlers, registered)
        return {
          events: {
            emit: async (name: string, payload: Record<string, unknown>) => void emitted.push({ name, payload }),
          },
          dispose: async () => {},
        }
      },
    },
  } as unknown as Plugin.Context

  return { store, supervisor, calls, emitted, handlers, ctx, todos, subs }
}

async function setup(seedItems: TodoItem[] = [], directory = "/proj", options: Options = DEFAULTS) {
  const world = makeWorld(seedItems)
  const logs: string[] = []
  const reg = await registerTodoRpc(world.ctx, {
    store: world.store,
    supervisor: world.supervisor,
    options,
    markdown: new MarkdownCache(),
    directory,
    log: (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
  })
  return { ...world, reg, logs }
}

describe("RPC contract (§5.6)", () => {
  test("contract exposes all methods and events", () => {
    expect(TodoRpc.id).toBe("todo")
    expect(Object.keys(TodoRpc.methods).sort()).toEqual([
      "clear",
      "list",
      "nudge",
      "setEnabled",
      "subscribe",
      "toggle",
      "unsubscribe",
    ])
    expect(Object.keys(TodoRpc.events).sort()).toEqual(["nudged", "updated"])
  })

  test("list returns items, subscriptions placeholder and the supervisor snapshot", async () => {
    const w = await setup([{ content: "one", status: "pending" }])
    const result = (await w.handlers.list!({ sessionID: "s1" })) as Record<string, unknown>
    expect((result.items as TodoItem[]).length).toBe(1)
    expect(result.files).toEqual([])
    expect((result.supervisor as Record<string, unknown>).registered).toBe(true)
  })

  test("clear drops the list, notifies the supervisor and emits updated once", async () => {
    const w = await setup([{ content: "one", status: "pending" }])
    await w.handlers.clear!({ sessionID: "s1" })
    expect(w.todos.has("s1")).toBe(false)
    expect(w.calls).toContain("changed s1")
    expect(w.emitted).toEqual([{ name: "updated", payload: { sessionID: "s1" } }])
  })

  test("nudge and setEnabled delegate to the supervisor", async () => {
    const w = await setup()
    await w.handlers.nudge!({ sessionID: "s1" })
    await w.handlers.setEnabled!({ sessionID: "s1", enabled: false })
    expect(w.calls).toContain("nudge s1")
    expect(w.calls).toContain("enabled s1 false")
  })

  test("subscribe resolves, dedupes and un-shadows; unsubscribe shadows", async () => {
    const w = await setup()
    await w.handlers.subscribe!({ sessionID: "s1", path: "docs/TASKS.md" })
    expect(w.subs.get("s1")!.files).toEqual(["/proj/docs/TASKS.md"])
    await w.handlers.subscribe!({ sessionID: "s1", path: "docs/TASKS.md" })
    expect(w.subs.get("s1")!.files).toEqual(["/proj/docs/TASKS.md"])
    // a config shadow (removed) is lifted by subscribing again
    w.subs.set("s1", { version: 1, sessionID: "s1", files: [], removed: ["/proj/docs/TASKS.md"], updatedAt: 0 })
    await w.handlers.subscribe!({ sessionID: "s1", path: "/proj/docs/TASKS.md" })
    expect(w.subs.get("s1")!.files).toEqual(["/proj/docs/TASKS.md"])
    expect(w.subs.get("s1")!.removed).toEqual([])
    await w.handlers.unsubscribe!({ sessionID: "s1", path: "docs/TASKS.md" })
    expect(w.subs.get("s1")!.files).toEqual([])
    expect(w.subs.get("s1")!.removed).toEqual(["/proj/docs/TASKS.md"])
    expect(w.emitted.filter((e) => e.name === "updated").length).toBe(4)
  })

  test("toggle flips one item, notifies and emits updated", async () => {
    const w = await setup([
      { content: "one", status: "pending" },
      { content: "two", status: "completed" },
    ])
    const first = (await w.handlers.toggle!({ sessionID: "s1", index: 0 })) as Record<string, unknown>
    expect(first.status).toBe("completed")
    expect(w.todos.get("s1")![0]!.status).toBe("completed")
    const second = (await w.handlers.toggle!({ sessionID: "s1", index: 1 })) as Record<string, unknown>
    expect(second.status).toBe("pending")
    expect(w.calls.filter((call) => call === "changed s1").length).toBe(2)
    expect(w.emitted.filter((event) => event.name === "updated").length).toBe(2)
    await expect(w.handlers.toggle!({ sessionID: "s1", index: 9 })).rejects.toThrow(/range/)
  })

  test("list reports subscribed files with their existence", async () => {
    const dir = "/tmp/opencode"
    mkdirSync(dir, { recursive: true })
    const file = `${dir}/rpc-todos-${process.pid}.md`
    writeFileSync(file, "- [ ] one\n- [x] two\n")
    const w = await setup([], dir)
    await w.handlers.subscribe!({ sessionID: "s1", path: file })
    const result = (await w.handlers.list!({ sessionID: "s1" })) as Record<string, unknown>
    expect(result.files).toEqual([
      {
        path: file,
        exists: true,
        items: [
          { content: "one", status: "pending", line: 1 },
          { content: "two", status: "completed", line: 2 },
        ],
      },
    ])
  })

  test("config markdownFiles merge into list.files and unsubscribe shadows them", async () => {
    const options: Options = { ...DEFAULTS, markdownFiles: ["PLAN.md"] }
    const w = await setup([], "/proj", options)
    const before = (await w.handlers.list!({ sessionID: "s1" })) as Record<string, unknown>
    expect(before.files).toEqual([{ path: "/proj/PLAN.md", exists: false, items: [] }])
    await w.handlers.unsubscribe!({ sessionID: "s1", path: "PLAN.md" })
    const after = (await w.handlers.list!({ sessionID: "s1" })) as Record<string, unknown>
    expect(after.files).toEqual([])
  })

  test("rejects non-markdown paths and invalid input", async () => {
    const w = await setup()
    await expect(w.handlers.subscribe!({ sessionID: "s1", path: "notes.txt" })).rejects.toThrow(/markdown/)
    await expect(w.handlers.list!({})).rejects.toThrow(/sessionID/)
    await expect(w.handlers.setEnabled!({ sessionID: "s1", enabled: "yes" })).rejects.toThrow(/boolean/)
  })

  test("handler failures are logged and rethrown", async () => {
    const w = await setup([{ content: "one", status: "pending" }])
    const failing = w.store as unknown as { removeTodos: () => Promise<void> }
    failing.removeTodos = async () => {
      throw new Error("storage offline")
    }
    await expect(w.handlers.clear!({ sessionID: "s1" })).rejects.toThrow(/storage offline/)
    expect(w.logs.some((line) => line.includes("rpc clear failed"))).toBe(true)
  })

  test("resolveMarkdownPath resolves against the directory and accepts absolute paths", () => {
    expect(resolveMarkdownPath("/proj", "TODO.md")).toBe("/proj/TODO.md")
    expect(resolveMarkdownPath("/proj", "/abs/PLAN.markdown")).toBe("/abs/PLAN.markdown")
    expect(resolveMarkdownPath("/proj", "UPPER.MD")).toBe("/proj/UPPER.MD")
    expect(() => resolveMarkdownPath("/proj", "x.txt")).toThrow()
  })
})
