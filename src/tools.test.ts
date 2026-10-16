import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import type { Plugin } from "@opencode/plugin"
import { FakeStorage } from "./storage.test"
import { TodoStore, type TodoItem } from "./storage"
import { DEFAULTS } from "./options"
import { MarkdownCache } from "./markdown"
import {
  makeContextInjector,
  makeTodoAdd,
  makeTodoRead,
  makeTodoRemove,
  makeTodoSubscribe,
  makeTodoUnsubscribe,
  makeTodoWrite,
  normalizeItems,
  registerExecuteAfterHook,
  renderList,
  renderSummary,
  renderTodoContext,
} from "./tools"

describe("normalizeItems", () => {
  test("trims, drops empties and dedupes", () => {
    const { items } = normalizeItems([
      { content: "  a  ", status: "pending" },
      { content: "a", status: "pending" },
      { content: "   ", status: "pending" },
      { content: "b", status: "in_progress" },
    ])
    expect(items).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "in_progress" },
    ])
  })

  test("keeps at most one in_progress and notes the demotion", () => {
    const { items, notes } = normalizeItems([
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "in_progress" },
    ])
    expect(items.map((i) => i.status)).toEqual(["in_progress", "pending", "pending"])
    expect(notes.join(" ")).toContain("demoted 2 extra in_progress")
  })
})

describe("renderers", () => {
  test("renderList uses the checklist markers", () => {
    const list: TodoItem[] = [
      { content: "done", status: "completed" },
      { content: "doing", status: "in_progress" },
      { content: "open", status: "pending" },
      { content: "nope", status: "canceled" },
    ]
    expect(renderList(list)).toBe("- [x] done\n- [~] doing\n- [ ] open\n- [–] nope")
    expect(renderList([])).toBe("No todos.")
  })

  test("renderList prefixes ids when present", () => {
    const list: TodoItem[] = [
      { id: "1", content: "done", status: "completed" },
      { id: "2", content: "open", status: "pending", priority: "high" },
    ]
    expect(renderList(list)).toBe("- #1 [x] done\n- #2 [ ] open (high)")
  })

  test("renderSummary counts and flags open work", () => {
    const summary = renderSummary([
      { content: "done", status: "completed" },
      { content: "doing", status: "in_progress" },
      { content: "open", status: "pending" },
    ])
    expect(summary).toContain("3 items: 1 in_progress, 1 pending, 1 completed.")
    expect(summary).toContain("2 open")

    const doneSummary = renderSummary([{ content: "done", status: "completed" }])
    expect(doneSummary).toContain("All items are done.")
  })
})

describe("todo tools round-trip", () => {
  test("write then read returns the same state", async () => {
    const store = new TodoStore(new FakeStorage())
    const changed: string[] = []
    const write = makeTodoWrite(store, { onTodosChanged: (id) => changed.push(id) })
    const read = makeTodoRead(store)

    const writeResult = await write.execute(
      { todos: [{ content: "step 1", status: "in_progress" }, { content: "step 2", status: "pending" }] },
      { sessionID: "ses_1" },
    )
    expect(writeResult.content[0]?.text).toContain("- #1 [~] step 1")
    expect(changed).toEqual(["ses_1"])

    const readResult = await read.execute({}, { sessionID: "ses_1" })
    expect(readResult.content[0]?.text).toContain("- #2 [ ] step 2")
    expect(readResult.content[0]?.text).toContain("2 open of 2 items.")
  })

  test("read without a list is empty", async () => {
    const read = makeTodoRead(new TodoStore(new FakeStorage()))
    const result = await read.execute({}, { sessionID: "ses_none" })
    expect(result.content[0]?.text).toBe("No todos.")
  })

  test("todo_write storage failure is logged and returned as a tool error", async () => {
    const storage = new FakeStorage()
    storage.set = async () => {
      throw new Error("disk full")
    }
    const logs: string[] = []
    const write = makeTodoWrite(new TodoStore(storage), {
      log: (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
    })
    const result = await write.execute({ todos: [{ content: "x", status: "pending" }] }, { sessionID: "s1" })
    expect(result.content[0]?.text).toContain("todo_write failed")
    expect(String((result.metadata as { error?: string } | undefined)?.error)).toContain("disk full")
    expect(logs.some((line) => line.includes("todo_write failed"))).toBe(true)
  })
})

describe("todo_add / todo_remove", () => {
  test("add appends with a fresh id and reports it", async () => {
    const store = new TodoStore(new FakeStorage())
    await store.setTodos("s1", [{ content: "one", status: "pending" }])
    const changed: string[] = []
    const add = makeTodoAdd(store, { onTodosChanged: (id) => changed.push(id) })
    const result = await add.execute({ content: "  two  ", priority: "high" }, { sessionID: "s1" })
    expect(result.content[0]?.text).toContain("Added #2 two (high)")
    expect((result.metadata as { id?: string }).id).toBe("2")
    expect(store.getTodos("s1")?.items.map((item) => [item.id, item.content, item.priority])).toEqual([
      ["1", "one", undefined],
      ["2", "two", "high"],
    ])
    expect(changed).toEqual(["s1"])
  })

  test("add refuses a duplicate content and an empty content", async () => {
    const store = new TodoStore(new FakeStorage())
    await store.setTodos("s1", [{ content: "one", status: "pending" }])
    const add = makeTodoAdd(store, {})
    const duplicate = await add.execute({ content: "one" }, { sessionID: "s1" })
    expect(duplicate.content[0]?.text).toContain("Already on the list as #1")
    expect(store.getTodos("s1")?.items.length).toBe(1)

    const empty = await add.execute({ content: "   " }, { sessionID: "s1" })
    expect(empty.content[0]?.text).toContain("todo_add failed")
    expect(store.getTodos("s1")?.items.length).toBe(1)
  })

  test("remove drops one item by id and reports it", async () => {
    const store = new TodoStore(new FakeStorage())
    await store.setTodos("s1", [
      { content: "one", status: "pending" },
      { content: "two", status: "pending" },
    ])
    const changed: string[] = []
    const remove = makeTodoRemove(store, { onTodosChanged: (id) => changed.push(id) })
    const result = await remove.execute({ id: "1" }, { sessionID: "s1" })
    expect(result.content[0]?.text).toContain("Removed #1: one")
    expect(store.getTodos("s1")?.items.map((item) => item.id)).toEqual(["2"])
    expect(changed).toEqual(["s1"])

    const missing = await remove.execute({ id: "9" }, { sessionID: "s1" })
    expect(missing.content[0]?.text).toContain("todo_remove failed")
  })
})

describe("markdown tools (§5.2, aspect 14)", () => {
  const dir = "/tmp/opencode"
  const file = `${dir}/tools-md-${process.pid}.md`
  const shown = `tools-md-${process.pid}.md`

  test("todo_subscribe adds files and lifts shadows; unsubscribe shadows config", async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, "- [ ] one\n- [x] two\n")
    const store = new TodoStore(new FakeStorage())
    const changed: string[] = []
    const hooks = { onTodosChanged: (id: string) => void changed.push(id), log: () => {} }
    const sub = makeTodoSubscribe(store, hooks, dir)
    const unsub = makeTodoUnsubscribe(store, hooks, dir)

    const result = await sub.execute({ files: [{ path: file }] }, { sessionID: "s1" })
    expect(result.content[0]?.text).toContain("Mark items done")
    expect((await store.loadSubs("s1"))!.files).toEqual([file])
    expect(changed).toEqual(["s1"])

    await unsub.execute({ files: [{ path: file }] }, { sessionID: "s1" })
    const after = await store.loadSubs("s1")
    expect(after!.files).toEqual([])
    expect(after!.removed).toEqual([file])

    await sub.execute({ files: [{ path: file }] }, { sessionID: "s1" })
    const back = await store.loadSubs("s1")
    expect(back!.files).toEqual([file])
    expect(back!.removed).toEqual([])

    const logs: string[] = []
    const bad = makeTodoSubscribe(new TodoStore(new FakeStorage()), {
      log: (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
    }, dir)
    const badResult = await bad.execute({ files: [{ path: "notes.txt" }] }, { sessionID: "s1" })
    expect(badResult.content[0]?.text).toContain("todo_subscribe failed")
    expect(logs.some((line) => line.includes("todo_subscribe failed"))).toBe(true)
  })

  test("todo_read merges session items and markdown file sections", async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, "- [ ] file task\n")
    const store = new TodoStore(new FakeStorage())
    await store.setTodos("s1", [{ content: "session task", status: "pending" }])
    await store.setSubs("s1", [file], [])
    const read = makeTodoRead(store, {}, { markdown: new MarkdownCache(), options: { ...DEFAULTS }, directory: dir })
    const result = await read.execute({}, { sessionID: "s1" })
    const text = result.content[0]?.text ?? ""
    expect(text).toContain("2 open of 2 items.")
    expect(text).toContain("- #1 [ ] session task")
    expect(text).toContain("- [ ] file task  (" + shown + ":1)")
  })
})

describe("execute.after markdown refresh (§5.8, aspect 14c)", () => {
  test("refreshes subscribed files and notifies; ignores other tools and paths", async () => {
    const dir = "/tmp/opencode"
    mkdirSync(dir, { recursive: true })
    const file = `${dir}/hook-md-${process.pid}.md`
    writeFileSync(file, "- [ ] one\n")
    const markdown = new MarkdownCache()
    markdown.parse(file) // prime the cache
    const store = new TodoStore(new FakeStorage())
    await store.setSubs("s1", [file], [])

    const changed: string[] = []
    const logs: string[] = []
    let captured: ((event: { tool: string; sessionID: string; input: unknown }) => Promise<void>) | undefined
    const ctx = {
      tool: {
        hook: async (_name: string, callback: typeof captured) => {
          captured = callback
          return { dispose: async () => {} }
        },
      },
    } as unknown as Plugin.Context
    const registration = await registerExecuteAfterHook(ctx, {
      store,
      markdown,
      options: { ...DEFAULTS },
      directory: dir,
      onChanged: (id) => void changed.push(id),
      log: (...args: unknown[]) => void logs.push(args.map(String).join(" ")),
    })

    writeFileSync(file, "- [ ] one\n- [x] two\n- [ ] three\n")
    await captured!({ tool: "edit", sessionID: "s1", input: { filePath: file } })
    expect(changed).toEqual(["s1"])
    expect(markdown.parse(file).items.length).toBe(3)
    expect(logs.some((line) => line.includes("markdown refreshed"))).toBe(true)

    await captured!({ tool: "read", sessionID: "s1", input: { filePath: file } })
    await captured!({ tool: "edit", sessionID: "s1", input: { filePath: `${dir}/other-${process.pid}.md` } })
    expect(changed).toEqual(["s1"])

    await registration.dispose()
  })
})

describe("context injection (§5.5)", () => {
  const storeWith = (items: TodoItem[]) => {
    const cache = new Map<string, TodoItem[]>([["s1", items]])
    return {
      getTodos: (sessionID: string) =>
        cache.has(sessionID)
          ? { version: 1, sessionID, items: cache.get(sessionID)!, updatedAt: 0 }
          : undefined,
    } as unknown as TodoStore
  }
  const noop = () => {}

  test("injects one marker block with counts, full list and policy", () => {
    const store = storeWith([
      { content: "step 1", status: "completed" },
      { content: "step 2", status: "in_progress", priority: "high" },
      { content: "step 3", status: "pending" },
    ])
    const inject = makeContextInjector(store, { ...DEFAULTS }, noop)
    const event = { sessionID: "s1", system: [] as unknown[] }
    inject(event)
    inject(event) // a duplicate registration must not double-inject
    expect(event.system.length).toBe(1)
    const text = (event.system[0] as { text: string }).text
    expect(text).toContain("[todo-supervisor] Active todo list — 2 of 3 todos left, 1 in progress")
    expect(text).toContain("- [x] step 1")
    expect(text).toContain("- [~] step 2 (high)")
    expect(text).toContain("- [ ] step 3")
    expect(text).toContain("todo_write")
  })

  test("skips when disabled or the session has no list", () => {
    const store = storeWith([{ content: "step", status: "pending" }])
    const off = makeContextInjector(store, { ...DEFAULTS, injectTodoContext: false }, noop)
    const eventOff = { sessionID: "s1", system: [] as unknown[] }
    off(eventOff)
    expect(eventOff.system.length).toBe(0)
    const inject = makeContextInjector(store, { ...DEFAULTS }, noop)
    const eventNone = { sessionID: "ses_none", system: [] as unknown[] }
    inject(eventNone)
    expect(eventNone.system.length).toBe(0)
  })

  test("renderTodoContext uses the marker and policy wording", () => {
    const text = renderTodoContext([{ content: "a", status: "pending" }])
    expect(text.startsWith("[todo-supervisor] Active todo list")).toBe(true)
    expect(text).toContain("1 of 1 todo left")
    expect(text).toContain("completed or canceled")
  })
})
