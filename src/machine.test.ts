// todo-supervisor — state-machine tests (PLAN.md §5.4, aspects 6–9).
//
// Real timers with millisecond-scale options keep the harness honest without
// mocking: `settleMs: 20`, `minNudgeIntervalMs: 120`, `stallMinutes: 0.005`
// (= 300 ms), `maxNoProgressNudges: 3`.
import { describe, expect, test } from "bun:test"
import type { MarkdownCache, MarkdownItem, MarkdownState, ParsedFile } from "./markdown"
import { parseOptions } from "./options"
import type { TodoItem, TodoStore } from "./storage"
import { Supervisor, type ClaimsStore, type SessionRef, type SupervisorDeps } from "./supervisor"

type SyntheticCall = {
  sessionID: string
  text: string
  description?: string
  metadata?: Record<string, unknown>
}

type Shared = {
  todos: Map<string, TodoItem[]>
  sessions: Map<string, SessionRef>
  claims: Map<string, unknown>
  /** When set, `refreshTodos` throws — storage-failure injection (§AC aspect 13). */
  failRefresh?: boolean
}

const shared = (): Shared => ({ todos: new Map(), sessions: new Map(), claims: new Map() })

function makeHarness(state: Shared = shared(), overrides: Record<string, unknown> = {}, tag = "test#1@aaa") {
  const calls: SyntheticCall[] = []
  const logs: string[] = []
  const failures = { remaining: 0 }
  const cache = new Map<string, TodoItem[]>()
  const subs = new Map<
    string,
    { version: 1; sessionID: string; files: string[]; removed: string[]; updatedAt: number }
  >()
  const mdFiles = new Map<string, ParsedFile>()
  const rpcEvents: { name: string; payload: Record<string, unknown> }[] = []
  const options = parseOptions({
    settleMs: 20,
    minNudgeIntervalMs: 120,
    stallMinutes: 0.005,
    maxNoProgressNudges: 3,
    ...overrides,
  })

  const claims: ClaimsStore = {
    get: async (key) => state.claims.get(key),
    set: async (key, value) => void state.claims.set(key, value),
    remove: async (key) => void state.claims.delete(key),
  }

  // getTodos is cache-only like the real store; refreshTodos re-reads the shared
  // "storage" (state.todos), so tests can simulate writes from another role.
  const store = {
    getTodos: (sessionID: string) =>
      cache.has(sessionID)
        ? { version: 1, sessionID, items: cache.get(sessionID)!, updatedAt: 0 }
        : undefined,
    refreshTodos: async (sessionID: string) => {
      if (state.failRefresh) throw new Error("storage offline")
      const items = state.todos.get(sessionID)
      if (items) {
        cache.set(sessionID, items)
        return { version: 1, sessionID, items, updatedAt: 0 }
      }
      cache.delete(sessionID)
      return undefined
    },
    scanAll: async () => {
      const out = [...state.todos.entries()].map(([sessionID, items]) => {
        cache.set(sessionID, items)
        return { version: 1, sessionID, items, updatedAt: 0 }
      })
      return out
    },
    removeTodos: async (sessionID: string) => {
      cache.delete(sessionID)
      state.todos.delete(sessionID)
    },
    removeSubs: async (sessionID: string) => void subs.delete(sessionID),
    loadSubs: async (sessionID: string) => subs.get(sessionID),
    setSubs: async (sessionID: string, files: string[], removed: string[]) => {
      const subsState = { version: 1 as const, sessionID, files, removed, updatedAt: 0 }
      subs.set(sessionID, subsState)
      return subsState
    },
  } as unknown as TodoStore

  const deps: SupervisorDeps = {
    options,
    store,
    projectID: "proj-1",
    tag,
    log: (...args) => void logs.push(args.map(String).join(" ")),
    claims,
    retry: { delayMs: 30, attempts: 3 },
    emitRpcEvent: (name, payload) => void rpcEvents.push({ name, payload }),
    synthetic: async (input) => {
      if (failures.remaining > 0) {
        failures.remaining -= 1
        throw new Error("session busy (409)")
      }
      calls.push(input)
    },
    getSession: async (sessionID) => state.sessions.get(sessionID),
    markdown: {
      parse: (path: string) => mdFiles.get(path) ?? { path, exists: false, items: [] },
    } as unknown as MarkdownCache,
    directory: "/proj",
  }

  return { sup: new Supervisor(deps), calls, logs, failures, state, options, cache, rpcEvents, subs, mdFiles }
}

type H = ReturnType<typeof makeHarness>

const item = (content: string, status: TodoItem["status"] = "pending"): TodoItem => ({ content, status })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const dispatch = (h: H, type: string, data: Record<string, unknown>) => h.sup.handle({ type, data })
const idle = (h: H, sessionID = "s1") =>
  dispatch(h, "session.status", { sessionID, status: { type: "idle" } })

const shellCreated = (h: H, sessionID: string, shellID: string, command: string) =>
  dispatch(h, "shell.created", {
    info: { id: shellID, status: "running", command, metadata: { sessionID }, time: { started: Date.now() } },
  })

function seed(h: H, sessionID: string, items: TodoItem[], ref: SessionRef = { projectID: "proj-1" }): void {
  h.state.todos.set(sessionID, items)
  h.cache.set(sessionID, items)
  h.state.sessions.set(sessionID, ref)
  h.sup.registerSession(sessionID, ref)
}

/** Register a session without a session todo list (markdown-only supervision). */
function seedSession(h: H, sessionID: string, ref: SessionRef = { projectID: "proj-1" }): void {
  h.state.sessions.set(sessionID, ref)
  h.sup.registerSession(sessionID, ref)
}

function mdFile(path: string, rows: Array<[number, string, MarkdownState]>, exists = true): ParsedFile {
  return {
    path,
    exists,
    items: rows.map(([line, text, state]): MarkdownItem => ({ path, line, text, indent: "", state })),
  }
}

function subscribe(h: H, sessionID: string, files: string[], removed: string[] = []): void {
  h.subs.set(sessionID, { version: 1, sessionID, files, removed, updatedAt: 0 })
}

describe("idle evaluation & nudging (aspect 7)", () => {
  test("idle session with open todos gets one nudge after settleMs with status + explainer", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one"), item("two", "in_progress"), item("three", "completed")])
    await idle(h)
    expect(h.calls.length).toBe(0)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    const call = h.calls[0]!
    expect(call.sessionID).toBe("s1")
    expect(call.metadata?.["source"]).toBe("todo-supervisor")
    expect(call.text).toContain("Idle nudge #1")
    expect(call.text).toContain("2 of 3 todos left, 1 in progress")
    expect(call.text).toContain("- [ ] one")
    expect(call.text).toContain("- [~] two")
    expect(call.text).not.toContain("three")
  })

  test("priority and resume hint are visible in the nudge text", async () => {
    const h = makeHarness()
    seed(h, "s1", [
      { content: "important", status: "pending", priority: "high" },
      { content: "later", status: "pending", priority: "low" },
    ])
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    const text = h.calls[0]!.text
    expect(text).toContain("- [ ] important (high)")
    expect(text).toContain("- [ ] later (low)")
    expect(text).toContain("start with the [~] item when present")
  })

  test("nudges re-read storage so writes from another role are visible", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("old task")])
    // Another role's tool call writes shared storage, not this instance's cache:
    h.state.todos.set("s1", [item("new task"), item("old task", "completed")])
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    const text = h.calls[0]!.text
    expect(text).toContain("- [ ] new task")
    expect(text).toContain("1 of 2 todos left")
    expect(text).not.toContain("- [ ] old task")
  })

  test("nudged RPC event fires exactly once per successful nudge", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    const nudged = h.rpcEvents.filter((e) => e.name === "nudged")
    expect(nudged.length).toBe(1)
    expect(nudged[0]!.payload.sessionID).toBe("s1")
    expect(nudged[0]!.payload.reason).toBe("open-todos")
  })

  test("snapshot reports registry state for RPC list", () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    const snap = h.sup.snapshot("s1")
    expect(snap.registered).toBe(true)
    expect(snap.paused).toBe(false)
    expect(snap.status).toBe("unknown")
    expect(h.sup.snapshot("ses_missing")).toEqual({ registered: false })
  })

  test("no nudge for empty or fully done lists", async () => {
    const h = makeHarness()
    seed(h, "empty", [])
    seed(h, "done", [item("a", "completed"), item("b", "canceled")])
    await idle(h, "empty")
    await idle(h, "done")
    await sleep(80)
    expect(h.calls.length).toBe(0)
  })

  test("consecutive nudges are at least minNudgeIntervalMs apart", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    await idle(h)
    await sleep(80) // settle re-fires, but we are inside the interval
    expect(h.calls.length).toBe(1)
    await sleep(700) // interval + reschedule epsilon
    expect(h.calls.length).toBe(2)
  })

  test("running session cancels the pending evaluation", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await idle(h)
    await sleep(5)
    await dispatch(h, "session.execution.started", { sessionID: "s1" })
    await sleep(100)
    expect(h.calls.length).toBe(0)
    await dispatch(h, "session.execution.succeeded", { sessionID: "s1" })
    await sleep(80)
    expect(h.calls.length).toBe(1)
  })

  test("unknown status after reconcile waits for fresh activity to settle", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await h.sup.reconcile() // schedules an evaluation, status stays "unknown"
    await sleep(5)
    await dispatch(h, "session.tool.progress", { sessionID: "s1", id: "call_1", metadata: { shellID: "sh" } })
    await sleep(100)
    expect(h.calls.length).toBe(0)
    await sleep(600)
    expect(h.calls.length).toBe(1)
  })

  test("a busy synthetic call (409) is retried and delivered", async () => {
    const h = makeHarness()
    h.failures.remaining = 1
    seed(h, "s1", [item("one")])
    await idle(h)
    await sleep(150)
    expect(h.calls.length).toBe(1)
    expect(h.logs.some((line) => line.includes("nudge busy"))).toBe(true)
  })

  test("a storage failure during refresh is logged and supervision continues (fail-open)", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    h.state.failRefresh = true
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    expect(h.logs.some((line) => line.includes("refresh failed"))).toBe(true)
  })

  test("supervises markdown-only sessions and names path:line in the nudge", async () => {
    const h = makeHarness()
    seedSession(h, "s1")
    subscribe(h, "s1", ["/proj/TODO.md"])
    h.mdFiles.set("/proj/TODO.md", mdFile("/proj/TODO.md", [[3, "file task", "open"], [9, "already done", "completed"]]))
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    const text = h.calls[0]!.text
    expect(text).toContain("Idle nudge #1")
    expect(text).toContain("1 of 2 todos left")
    expect(text).toContain("- [ ] file task  (TODO.md:3)")
    expect(text).not.toContain("already done")
    expect(text).toContain("edit the subscribed file and mark items")
  })

  test("markdown completion stops nudges and new items resume them", async () => {
    const h = makeHarness()
    seedSession(h, "s1")
    subscribe(h, "s1", ["/proj/TODO.md"])
    h.mdFiles.set("/proj/TODO.md", mdFile("/proj/TODO.md", [[1, "task", "completed"]]))
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(0)
    h.mdFiles.set("/proj/TODO.md", mdFile("/proj/TODO.md", [[1, "task", "completed"], [2, "new", "open"]]))
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]!.text).toContain("TODO.md:2")
  })

  test("an unsubscribe shadow excludes the file from supervision", async () => {
    const h = makeHarness()
    seedSession(h, "s1")
    subscribe(h, "s1", [], ["/proj/TODO.md"])
    h.mdFiles.set("/proj/TODO.md", mdFile("/proj/TODO.md", [[1, "task", "open"]]))
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(0)
  })

  test("a missing file is a valid subscription with 0 tasks, logged once", async () => {
    const h = makeHarness()
    seedSession(h, "s1")
    subscribe(h, "s1", ["/proj/GONE.md"])
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(0)
    await idle(h)
    await sleep(80)
    expect(h.logs.filter((line) => line.includes("markdown file missing")).length).toBe(1)
  })

  test("nudges group session items first, then file sections", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("session task")])
    subscribe(h, "s1", ["/proj/TODO.md"])
    h.mdFiles.set("/proj/TODO.md", mdFile("/proj/TODO.md", [[5, "file task", "open"]]))
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    const text = h.calls[0]!.text
    expect(text).toContain("2 of 2 todos left")
    expect(text.indexOf("- [ ] session task")).toBeLessThan(text.indexOf("TODO.md:5"))
    expect(text).toContain("todo_write")
    expect(text).toContain("editing the file")
  })

  test("debugEvents logs why an evaluation was skipped (setEnabled gate)", async () => {
    const h = makeHarness(shared(), { debugEvents: true })
    seedSession(h, "s1")
    subscribe(h, "s1", ["/proj/TODO.md"])
    h.mdFiles.set("/proj/TODO.md", mdFile("/proj/TODO.md", [[1, "task", "open"]]))
    h.sup.setEnabled("s1", false)
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(0)
    expect(h.logs.some((line) => line.includes("skipped (paused (disabled))"))).toBe(true)
  })

  test("streaming activity (thinking/preparing) postpones the idle nudge", async () => {
    const h = makeHarness(shared(), { settleMs: 120, minNudgeIntervalMs: 200 })
    seed(h, "s1", [item("one")])
    await idle(h)
    for (let index = 0; index < 5; index += 1) {
      await sleep(40)
      await dispatch(h, "session.reasoning.delta", { sessionID: "s1", text: "thinking…" })
    }
    expect(h.calls.length).toBe(0)
    await sleep(900)
    expect(h.calls.length).toBe(1)
  })

  test("setEnabled(false) stops automatic nudges (disable cycle)", async () => {
    const h = makeHarness(shared(), { settleMs: 60 })
    seed(h, "s1", [item("one")])
    await idle(h)
    h.sup.setEnabled("s1", false)
    await sleep(150)
    expect(h.calls.length).toBe(0)
    h.sup.setEnabled("s1", true)
    await sleep(150)
    expect(h.calls.length).toBe(1)
  })

  test("manual nudge: blocked while disabled, allowed over an interrupt pause", async () => {
    const h = makeHarness(shared(), { settleMs: 20 })
    seed(h, "s1", [item("one")])
    h.sup.setEnabled("s1", false)
    h.sup.forceNudge("s1")
    await sleep(60)
    expect(h.calls.length).toBe(0)

    h.sup.setEnabled("s1", true)
    await dispatch(h, "session.execution.interrupted", { sessionID: "s1" })
    expect(h.sup.getState("s1")?.paused).toBe(true)
    h.sup.forceNudge("s1")
    await sleep(60)
    expect(h.calls.length).toBe(1)
  })

  test("session activity postpones the stall nudge while work runs", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await shellCreated(h, "s1", "sh_busy", "sleep 600")
    await idle(h)
    await sleep(150)
    await dispatch(h, "session.reasoning.delta", { sessionID: "s1", text: "still working…" })
    await sleep(150)
    expect(h.calls.length).toBe(0)
    await sleep(900)
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]!.text).toContain('background shell "sleep 600"')
  })

  test("nudges stop after the list completes and resume on new items", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
    h.state.todos.set("s1", [item("one", "completed")])
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(1)
  })
})

describe("running work & stall (aspect 8)", () => {
  test("no nudge while a child session is active; stall nudge names the child", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await dispatch(h, "session.created", { sessionID: "c1", projectID: "proj-1", parentID: "s1" })
    await dispatch(h, "session.execution.started", { sessionID: "c1" })
    await idle(h)
    for (let i = 0; i < 6; i++) {
      await sleep(150)
      await dispatch(h, "session.tool.progress", { sessionID: "c1", id: "call_1", metadata: { shellID: "sh" } })
    }
    expect(h.calls.length).toBe(0)
    await sleep(1000) // child goes quiet → stall
    expect(h.calls.length).toBe(1)
    const call = h.calls[0]!
    expect(call.text).toContain("Stall nudge #1")
    expect(call.text).toContain("subagent c1")
    expect(call.text).toContain("1 of 1 todo left")
    expect(call.text).toContain("no activity for less than a minute")
    expect(call.text).toContain("stall threshold")
  })

  test("background shell: stall after silence, cleared by shell.exited", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await shellCreated(h, "s1", "sh_t1", "sleep 600")
    await idle(h)
    await sleep(900)
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]!.text).toContain('background shell "sleep 600"')

    const h2 = makeHarness()
    seed(h2, "s1", [item("one")])
    await shellCreated(h2, "s1", "sh_t2", "sleep 600")
    await dispatch(h2, "shell.exited", { id: "sh_t2", status: "exited", exit: 0 })
    await idle(h2)
    await sleep(900)
    expect(h2.calls.length).toBe(1)
    expect(h2.calls[0]!.text).toContain("Idle nudge #1")
  })

  test("shell output (tool.progress shellID) resets the stall clock", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await shellCreated(h, "s1", "sh_t3", "build --watch")
    await idle(h)
    for (let i = 0; i < 6; i++) {
      await sleep(150)
      await dispatch(h, "session.tool.progress", { sessionID: "s1", id: "call_x", metadata: { shellID: "sh_t3" } })
    }
    expect(h.calls.length).toBe(0)
    await sleep(1000)
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]!.text).toContain('background shell "build --watch"')
  })

  test("exited or foreign shells never enter stall logic", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await shellCreated(h, "s1", "sh_fg", "ls")
    await dispatch(h, "shell.exited", { id: "sh_fg", status: "exited", exit: 0 })
    await shellCreated(h, "someone-else", "sh_foreign", "sleep 600")
    await idle(h)
    await sleep(900)
    expect(h.calls.length).toBe(1)
    expect(h.calls[0]!.text).toContain("Idle nudge #1")
  })
})

describe("guardrails & lifecycle (aspect 9)", () => {
  test("permission prompt blocks nudges; reply resumes", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await dispatch(h, "permission.asked", { sessionID: "s1", id: "per_1" })
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(0)
    await dispatch(h, "permission.replied", { sessionID: "s1", requestID: "per_1", reply: "once" })
    await sleep(80)
    expect(h.calls.length).toBe(1)
  })

  test("interrupt pauses; a real user prompt resumes; synthetic inbox items do not", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await dispatch(h, "session.execution.interrupted", { sessionID: "s1" })
    await idle(h)
    await sleep(80)
    expect(h.calls.length).toBe(0)
    await dispatch(h, "session.inbox.enqueued", {
      sessionID: "s1",
      item: { type: "synthetic", payload: { text: "nudge" } },
      delivery: "queue",
    })
    await sleep(80)
    expect(h.calls.length).toBe(0)
    await dispatch(h, "session.inbox.enqueued", {
      sessionID: "s1",
      item: { type: "user", payload: { text: "hello" } },
      delivery: "queue",
    })
    await sleep(80)
    expect(h.calls.length).toBe(1)
  })

  test("no-progress backstop pauses after maxNoProgressNudges identical nudges", async () => {
    const h = makeHarness(undefined, { maxNoProgressNudges: 2, minNudgeIntervalMs: 60 })
    seed(h, "s1", [item("one")])
    await idle(h)
    await sleep(100)
    expect(h.calls.length).toBe(1)
    await idle(h)
    await sleep(100)
    expect(h.calls.length).toBe(2)
    await idle(h)
    await sleep(100)
    expect(h.calls.length).toBe(2)
    expect(h.logs.some((line) => line.includes("backing off"))).toBe(true)
    // a list change resets the backstop
    h.state.todos.set("s1", [item("two")])
    h.sup.notifyTodosChanged("s1")
    await sleep(100)
    expect(h.calls.length).toBe(3)
  })

  test("session.deleted drops registry, storage and claims", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    expect(h.sup.getState("s1")).toBeDefined()
    await dispatch(h, "session.deleted", { sessionID: "s1" })
    expect(h.sup.getState("s1")).toBeUndefined()
    expect(h.state.todos.has("s1")).toBe(false)
    expect(h.state.claims.has("claims/s1")).toBe(false)
  })

  test("dispose stops all pending work", async () => {
    const h = makeHarness()
    seed(h, "s1", [item("one")])
    await idle(h)
    h.sup.dispose()
    await sleep(100)
    expect(h.calls.length).toBe(0)
    await idle(h) // post-dispose events are ignored
    await sleep(50)
    expect(h.calls.length).toBe(0)
  })
})

describe("registry & scope (aspect 6)", () => {
  test("sessions from other projects are ignored", async () => {
    const h = makeHarness()
    await dispatch(h, "session.created", { sessionID: "x1", projectID: "other-proj" })
    expect(h.sup.getState("x1")).toBeUndefined()
    h.state.todos.set("x1", [item("one")])
    await idle(h, "x1")
    await sleep(80)
    expect(h.calls.length).toBe(0)
  })

  test("scope 'all' registers foreign projects", async () => {
    const h = makeHarness(undefined, { scope: "all" })
    await dispatch(h, "session.created", { sessionID: "x1", projectID: "other-proj" })
    expect(h.sup.getState("x1")).toBeDefined()
  })

  test("unknown event types are ignored without errors", async () => {
    const h = makeHarness()
    await dispatch(h, "session.teleported", { sessionID: "s1" })
    await dispatch(h, "mystery.event", {})
    expect(h.logs.filter((line) => line.includes("event handler error")).length).toBe(0)
  })

  test("newer supervisor generations win the session via ownership claims", async () => {
    const state = shared()
    const older = makeHarness(state, {}, "gen-a")
    const newer = makeHarness(state, {}, "gen-b")
    older.state.todos.set("s1", [item("one")])
    older.state.sessions.set("s1", { projectID: "proj-1" })
    older.sup.registerSession("s1", { projectID: "proj-1" })
    await sleep(5)
    newer.sup.registerSession("s1", { projectID: "proj-1" })
    await idle(older)
    await sleep(80)
    expect(older.calls.length).toBe(0)
    expect(older.logs.some((line) => line.includes("newer supervisor owns"))).toBe(true)
    await idle(newer)
    await sleep(80)
    expect(newer.calls.length).toBe(1)
  })
})
