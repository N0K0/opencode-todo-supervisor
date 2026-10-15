import { describe, expect, test } from "bun:test"
import {
  hashList,
  isDone,
  openItems,
  TodoStore,
  type StorageLike,
  type TodoItem,
} from "./storage"

export class FakeStorage implements StorageLike {
  readonly map = new Map<string, unknown>()

  async get(key: string): Promise<unknown> {
    return this.map.get(key)
  }
  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
  async scan(options: { prefix: string; after?: string; limit?: number }) {
    const limit = options.limit ?? 100
    const keys = [...this.map.keys()].filter((k) => k.startsWith(options.prefix)).sort()
    const start = options.after ? keys.indexOf(options.after) + 1 : 0
    const slice = keys.slice(start, start + limit)
    const last = slice[slice.length - 1]
    return {
      entries: slice.map((key) => ({ key, value: this.map.get(key) })),
      next: start + slice.length < keys.length && last !== undefined ? last : undefined,
    }
  }
}

const items = (n: number): TodoItem[] =>
  Array.from({ length: n }, (_, i) => ({ content: `task ${i}`, status: "pending" as const }))

describe("TodoStore", () => {
  test("round-trips items identically in order", async () => {
    const storage = new FakeStorage()
    const store = new TodoStore(storage)
    const written = items(3)
    await store.setTodos("ses_1", written)
    expect(store.getTodos("ses_1")?.items).toEqual(written)

    const fresh = new TodoStore(storage)
    const loaded = await fresh.loadTodos("ses_1")
    expect(loaded?.items).toEqual(written)
  })

  test("scanAll paginates through more than one page", async () => {
    const storage = new FakeStorage()
    const store = new TodoStore(storage)
    for (let i = 0; i < 5; i++) {
      await storage.set(`todos/ses_${i}`, { version: 1, sessionID: `ses_${i}`, items: items(1), updatedAt: 0 })
    }
    await storage.set("subs/ses_9", { version: 1, sessionID: "ses_9", files: [], removed: [], updatedAt: 0 })

    const fresh = new TodoStore(storage)
    const all = await fresh.scanAll({ limit: 2 })
    expect(all.map((s) => s.sessionID).sort()).toEqual(["ses_0", "ses_1", "ses_2", "ses_3", "ses_4"])
    expect(fresh.getTodos("ses_4")?.items).toEqual(items(1))
    expect(fresh.getSubs("ses_9")).toBeUndefined()
  })

  test("removeTodos deletes the key and the cache entry", async () => {
    const storage = new FakeStorage()
    const store = new TodoStore(storage)
    await store.setTodos("ses_1", items(1))
    await store.removeTodos("ses_1")
    expect(storage.map.has("todos/ses_1")).toBe(false)
    expect(store.getTodos("ses_1")).toBeUndefined()
  })

  test("garbage in storage is tolerated", async () => {
    const storage = new FakeStorage()
    await storage.set("todos/bad", { version: 2, items: "nope" })
    await storage.set("todos/bad2", { version: 1, sessionID: "bad2", items: [{ content: "ok", status: "weird" }] })
    const store = new TodoStore(storage)
    const all = await store.scanAll()
    expect(all.map((s) => s.sessionID)).toEqual(["bad2"])
    expect(all[0]?.items).toEqual([])
  })
})

describe("helpers", () => {
  test("openItems / isDone", () => {
    expect(openItems([{ content: "a", status: "completed" }, { content: "b", status: "pending" }])).toHaveLength(1)
    expect(isDone([])).toBe(false)
    expect(isDone([{ content: "a", status: "completed" }, { content: "b", status: "canceled" }])).toBe(true)
    expect(isDone([{ content: "a", status: "pending" }])).toBe(false)
  })

  test("hashList is stable and order/content sensitive", () => {
    const a: TodoItem[] = [{ content: "a", status: "pending", priority: "high" }]
    const b: TodoItem[] = [{ content: "a", status: "pending", priority: "high" }]
    expect(hashList(a)).toBe(hashList(b))
    expect(hashList(a)).not.toBe(hashList([{ content: "a", status: "completed", priority: "high" }]))
  })
})
