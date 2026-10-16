// todo-supervisor — typed wrapper around `ctx.storage` (PLAN.md §5.3).
//
// Keys:
//   todos/<sessionID>  → { version: 1, sessionID, items, updatedAt }
//   subs/<sessionID>   → { version: 1, sessionID, files, removed, updatedAt }
//
// A full in-memory cache keeps the per-request context hook (§5.5)
// synchronous. Supervision counters are NOT stored — restart resets them.
export type TodoStatus = "pending" | "in_progress" | "completed" | "canceled"
export type TodoPriority = "high" | "medium" | "low"

export type TodoItem = {
  /**
   * Stable per-session identifier (a numeric string, e.g. `"3"`), assigned by
   * the store when an item is first written and preserved across full-list
   * rewrites by matching content. Optional in the type so callers and tests can
   * build ad-hoc items; anything reaching storage is normalised by
   * {@link assignIds}.
   */
  id?: string
  content: string
  status: TodoStatus
  priority?: TodoPriority
}

export type TodoState = {
  version: 1
  sessionID: string
  items: TodoItem[]
  updatedAt: number
}

export type SubsState = {
  version: 1
  sessionID: string
  files: string[]
  removed: string[]
  updatedAt: number
}

/** Structural subset of `ctx.storage` (keeps this module testable). */
export interface StorageLike {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function parseTodoState(value: unknown): TodoState | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (typeof value.sessionID !== "string" || !Array.isArray(value.items)) return undefined
  const items: TodoItem[] = []
  for (const entry of value.items) {
    if (!isRecord(entry) || typeof entry.content !== "string") continue
    const status = entry.status
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "canceled") continue
    const item: TodoItem = { content: entry.content, status }
    if (typeof entry.id === "string" && entry.id !== "") item.id = entry.id
    if (entry.priority === "high" || entry.priority === "medium" || entry.priority === "low") {
      item.priority = entry.priority
    }
    items.push(item)
  }
  return {
    version: 1,
    sessionID: value.sessionID,
    // Legacy rows predate ids; backfill them deterministically on load.
    items: assignIds(items),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  }
}

export function parseSubsState(value: unknown): SubsState | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (typeof value.sessionID !== "string") return undefined
  const files = Array.isArray(value.files) ? value.files.filter((f): f is string => typeof f === "string") : []
  const removed = Array.isArray(value.removed) ? value.removed.filter((f): f is string => typeof f === "string") : []
  return {
    version: 1,
    sessionID: value.sessionID,
    files,
    removed,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  }
}

const todosKey = (sessionID: string) => `todos/${sessionID}`
const subsKey = (sessionID: string) => `subs/${sessionID}`

export class TodoStore {
  private readonly todos = new Map<string, TodoState>()
  private readonly subs = new Map<string, SubsState>()

  constructor(private readonly storage: StorageLike) {}

  // ---- todos ---------------------------------------------------------------

  /** Cache-only read (kept in sync by every write, load and scan). */
  getTodos(sessionID: string): TodoState | undefined {
    return this.todos.get(sessionID)
  }

  /** Load one list from storage into the cache. */
  async loadTodos(sessionID: string): Promise<TodoState | undefined> {
    const parsed = parseTodoState(await this.storage.get(todosKey(sessionID)))
    if (parsed) this.todos.set(sessionID, parsed)
    return parsed
  }

  /** Re-read one list from shared storage; drops the cache entry when the row is gone. */
  async refreshTodos(sessionID: string): Promise<TodoState | undefined> {
    const parsed = parseTodoState(await this.storage.get(todosKey(sessionID)))
    if (parsed) this.todos.set(sessionID, parsed)
    else this.todos.delete(sessionID)
    return parsed
  }

  async setTodos(sessionID: string, items: TodoItem[]): Promise<TodoState> {
    // Central id assignment: every stored list has stable ids, and a rewrite
    // that keeps an item's content keeps its id (see assignIds).
    const previous = this.todos.get(sessionID)?.items ?? []
    const state: TodoState = { version: 1, sessionID, items: assignIds(items, previous), updatedAt: Date.now() }
    await this.storage.set(todosKey(sessionID), state)
    this.todos.set(sessionID, state)
    return state
  }

  async removeTodos(sessionID: string): Promise<void> {
    this.todos.delete(sessionID)
    await this.storage.remove(todosKey(sessionID))
  }

  /** All stored lists, page by page; also refreshes the cache. */
  async scanAll(options: { limit?: number } = {}): Promise<TodoState[]> {
    const out: TodoState[] = []
    let after: string | undefined
    for (;;) {
      const page = await this.storage.scan({ prefix: "todos/", after, limit: options.limit ?? 100 })
      for (const entry of page.entries) {
        const state = parseTodoState(entry.value)
        if (!state) continue
        out.push(state)
        this.todos.set(state.sessionID, state)
      }
      if (!page.next) break
      after = page.next
    }
    return out
  }

  // ---- markdown subscriptions ---------------------------------------------

  getSubs(sessionID: string): SubsState | undefined {
    return this.subs.get(sessionID)
  }

  async loadSubs(sessionID: string): Promise<SubsState | undefined> {
    const parsed = parseSubsState(await this.storage.get(subsKey(sessionID)))
    if (parsed) this.subs.set(sessionID, parsed)
    return parsed
  }

  async setSubs(sessionID: string, files: string[], removed: string[]): Promise<SubsState> {
    const state: SubsState = { version: 1, sessionID, files, removed, updatedAt: Date.now() }
    await this.storage.set(subsKey(sessionID), state)
    this.subs.set(sessionID, state)
    return state
  }

  async removeSubs(sessionID: string): Promise<void> {
    this.subs.delete(sessionID)
    await this.storage.remove(subsKey(sessionID))
  }
}

export function makeStore(storage: StorageLike): TodoStore {
  return new TodoStore(storage)
}

// ---- predicates / helpers (§5.3) ------------------------------------------

export function openItems(items: readonly TodoItem[]): TodoItem[] {
  return items.filter((item) => item.status !== "completed" && item.status !== "canceled")
}

export function isDone(items: readonly TodoItem[]): boolean {
  return items.length > 0 && openItems(items).length === 0
}

export function hashList(items: readonly TodoItem[]): string {
  return JSON.stringify(items.map((item) => [item.content, item.status, item.priority ?? ""]))
}

// ---- stable ids (§5.3) ------------------------------------------------------

function numericId(id: string | undefined): number {
  const value = Number(id)
  return Number.isInteger(value) && value > 0 ? value : 0
}

/** Highest numeric id in a list (0 when the list is empty or unnumbered). */
export function maxId(items: readonly TodoItem[]): number {
  return items.reduce((max, item) => Math.max(max, numericId(item.id)), 0)
}

/** Next free id for a list (one above the highest id ever used). */
export function nextId(items: readonly TodoItem[]): string {
  return String(maxId(items) + 1)
}

/**
 * Give every item a stable id. An id already on the item is kept when it is
 * valid and unique; otherwise the id of a `previous` item with the same content
 * is reused (so `todo_write`, which resends the whole list, does not renumber
 * everything); otherwise a fresh id above every id seen so far is allocated.
 *
 * Ids are deliberately not part of {@link hashList}: renumbering must never look
 * like a content change to the supervisor.
 */
export function assignIds(items: readonly TodoItem[], previous: readonly TodoItem[] = []): TodoItem[] {
  const pool = [...previous]
  const used = new Set<string>()
  let counter = Math.max(maxId(previous), maxId(items))
  const out: TodoItem[] = []

  for (const item of items) {
    let id = typeof item.id === "string" && item.id !== "" && !used.has(item.id) ? item.id : undefined
    if (id === undefined) {
      const index = pool.findIndex(
        (entry) => entry.content === item.content && typeof entry.id === "string" && !used.has(entry.id),
      )
      if (index !== -1) {
        id = pool[index]!.id
        pool.splice(index, 1)
      }
    }
    if (id === undefined) id = String(++counter)
    used.add(id)
    out.push(item.id === id ? item : { ...item, id })
  }

  return out
}
