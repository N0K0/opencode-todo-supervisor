// todo-supervisor — todo tools + rendering (PLAN.md §5.2, §5.3).
import { isAbsolute, resolve as resolvePath } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { effectiveFiles, MarkdownCache, renderFileSection, resolveMarkdownPath } from "./markdown"
import type { Options } from "./options"
import { nextId, openItems, type TodoItem, type TodoPriority, type TodoStore, type TodoStatus } from "./storage"

export interface ToolHooks {
  /** Fired after a successful `todo_write` (supervisor reset, RPC notify, …). */
  onTodosChanged?(sessionID: string): void
  /** Logger: storage failures are recorded and returned as tool errors. */
  log?(...args: unknown[]): void
}

const STATUS_ORDER: readonly TodoStatus[] = ["in_progress", "pending", "completed", "canceled"]

const MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
  canceled: "[–]",
}

/**
 * Trim content, drop empty entries, dedupe by content, keep at most one
 * `in_progress` (extra ones are demoted to `pending`, noted in the output).
 */
export function normalizeItems(raw: readonly TodoItem[]): { items: TodoItem[]; notes: string[] } {
  const notes: string[] = []
  const items: TodoItem[] = []
  const seen = new Set<string>()

  for (const entry of raw) {
    if (!entry || typeof entry.content !== "string") continue
    const content = entry.content.trim()
    if (!content) continue
    if (seen.has(content)) continue
    seen.add(content)

    let status: TodoStatus = "pending"
    if (entry.status === "in_progress" || entry.status === "completed" || entry.status === "canceled") {
      status = entry.status
    } else if (entry.status !== "pending") {
      notes.push(`unknown status ${JSON.stringify(entry.status)} treated as pending`)
    }

    const item: TodoItem = { content, status }
    if (typeof entry.id === "string" && entry.id.trim() !== "") item.id = entry.id.trim()
    if (entry.priority === "high" || entry.priority === "medium" || entry.priority === "low") {
      item.priority = entry.priority
    }
    items.push(item)
  }

  const inProgress = items.filter((item) => item.status === "in_progress")
  if (inProgress.length > 1) {
    let kept = false
    for (const item of items) {
      if (item.status !== "in_progress") continue
      if (kept) item.status = "pending"
      kept = true
    }
    notes.push(`demoted ${inProgress.length - 1} extra in_progress item(s) to pending`)
  }

  return { items, notes }
}

export function renderList(items: readonly TodoItem[]): string {
  if (items.length === 0) return "No todos."
  return items
    .map((item) => {
      const tag = item.id ? `#${item.id} ` : ""
      return `- ${tag}${MARKERS[item.status]} ${item.content}${item.priority ? ` (${item.priority})` : ""}`
    })
    .join("\n")
}

export function renderSummary(items: readonly TodoItem[], notes: readonly string[] = []): string {
  const noteText = notes.length > 0 ? ` ${notes.join("; ")}.` : ""

  if (items.length === 0) return `Todos updated — the list is empty.${noteText}`

  const counts = STATUS_ORDER.map((status) => [status, items.filter((item) => item.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)

  const open = openItems(items).length
  const openNote =
    open === 0
      ? "All items are done."
      : `${open} open — continue working until every item is completed or canceled.`

  return `Todos updated — ${items.length} item${items.length === 1 ? "" : "s"}: ${counts.join(", ")}.${noteText} ${openNote}`
}

const TODO_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    content: { type: "string" },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "canceled"] },
    priority: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["content", "status"],
  additionalProperties: false,
} as const

const WRITE_DESCRIPTION =
  "Replace the session's todo list. Use this to plan multi-step work and keep progress visible: " +
  "send the complete list every time (it replaces the previous one). Keep exactly one item `in_progress`. " +
  "Before ending your turn every item must be `completed` or `canceled` — a supervisor will continue the session while items remain open. " +
  "Each item has a stable `id`; include it to keep the same item across rewrites (otherwise it is matched by content)."

const ADD_DESCRIPTION =
  "Add one item to the session's todo list without resending the whole list. Returns the new item's id. " +
  "Prefer this (or todo_write) over rewriting the list to append a single task."

const REMOVE_DESCRIPTION =
  "Remove one item from the session's todo list by its id (see the ids in todo_read / the injected todo block)."

const READ_DESCRIPTION =
  "Read the session's current todo list (canonical state as stored by todo_write). " +
  "The list is also injected into your context automatically; use this only to double-check exact state."

const SUBSCRIBE_ITEM_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
} as const

const SUBSCRIBE_DESCRIPTION =
  "Subscribe this session to markdown files: unchecked GFM checklist items (- [ ]) in them count as todos. " +
  "Mark an item done by editing the file (- [x]); the supervisor keeps nudging while items remain open. " +
  "Paths are relative to the project directory (or absolute) and must end in .md/.markdown."

const UNSUBSCRIBE_DESCRIPTION =
  "Stop treating a subscribed markdown file's checklist as todos for this session (this also shadows a config default). " +
  "Paths are relative to the project directory (or absolute) and must end in .md/.markdown."

const SUBSCRIBE_INPUT = {
  type: "object",
  properties: { files: { type: "array", items: SUBSCRIBE_ITEM_SCHEMA } },
  required: ["files"],
  additionalProperties: false,
} as const

async function readSubs(store: TodoStore, sessionID: string) {
  return (await store.loadSubs(sessionID)) ?? { files: [] as string[], removed: [] as string[] }
}

type ToolContextLike = { sessionID: string }

export function makeTodoWrite(store: TodoStore, hooks: ToolHooks) {
  return {
    name: "todo_write",
    description: WRITE_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        todos: { type: "array", items: TODO_ITEM_SCHEMA },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    options: { codemode: true as const },
    async execute(input: { todos: TodoItem[] }, context: ToolContextLike) {
      try {
        const { items, notes } = normalizeItems(Array.isArray(input?.todos) ? input.todos : [])
        const state = await store.setTodos(context.sessionID, items)
        hooks.onTodosChanged?.(context.sessionID)
        const saved = state.items
        return {
          content: [{ type: "text" as const, text: `${renderSummary(saved, notes)}\n\n${renderList(saved)}` }],
          metadata: { items: saved.length, open: openItems(saved).length },
        }
      } catch (err) {
        hooks.log?.(`todo_write failed (${context.sessionID}): ${String(err)}`)
        return {
          content: [{ type: "text" as const, text: `todo_write failed: ${String(err)}` }],
          metadata: { error: String(err) },
        }
      }
    },
  }
}

export type MarkdownDeps = { markdown: MarkdownCache; directory: string }

export function makeTodoRead(store: TodoStore, hooks: ToolHooks = {}, deps?: MarkdownDeps & { options: Options }) {
  return {
    name: "todo_read",
    description: READ_DESCRIPTION,
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: true as const },
    async execute(_input: Record<string, never>, context: ToolContextLike) {
      try {
        const state = store.getTodos(context.sessionID) ?? (await store.loadTodos(context.sessionID))
        const items = state?.items ?? []
        // Markdown mode (§5.8): merged output — session items first, then a
        // section per subscribed file with `path:line` references.
        let files: ReturnType<MarkdownCache["parse"]>[] = []
        if (deps) {
          const subs = await store.loadSubs(context.sessionID)
          files = effectiveFiles(deps.options, deps.directory, subs).map((path) => deps.markdown.parse(path))
        }
        const openMarkdown = files.reduce(
          (sum, file) => sum + file.items.filter((item) => item.state === "open").length,
          0,
        )
        const total = items.length + files.reduce((sum, file) => sum + file.items.length, 0)
        const open = openItems(items).length + openMarkdown
        const header = total === 0 ? "No todos." : `${open} open of ${total} items.`
        const sections: string[] = []
        if (items.length > 0) sections.push(renderList(items))
        for (const file of files) sections.push(renderFileSection(file, deps!.directory))
        return {
          content: [{ type: "text" as const, text: [header, ...sections].join("\n\n") }],
          metadata: { items: items.length, files: files.length },
        }
      } catch (err) {
        hooks.log?.(`todo_read failed (${context.sessionID}): ${String(err)}`)
        return {
          content: [{ type: "text" as const, text: `todo_read failed: ${String(err)}` }],
          metadata: { error: String(err) },
        }
      }
    },
  }
}

function validPriority(value: unknown): TodoPriority | undefined {
  return value === "high" || value === "medium" || value === "low" ? value : undefined
}

function validStatus(value: unknown): TodoStatus | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "canceled"
    ? value
    : undefined
}

export function makeTodoAdd(store: TodoStore, hooks: ToolHooks) {
  return {
    name: "todo_add",
    description: ADD_DESCRIPTION,
    input: {
      type: "object",
      properties: {
        content: { type: "string" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "canceled"] },
      },
      required: ["content"],
      additionalProperties: false,
    },
    options: { codemode: true as const },
    async execute(input: { content?: string; priority?: string; status?: string }, context: ToolContextLike) {
      try {
        const content = String(input?.content ?? "").trim()
        if (!content) throw new Error('"content" must be a non-empty string')
        const state = await store.refreshTodos(context.sessionID)
        const existing = state?.items ?? []
        const duplicate = existing.find((item) => item.content === content)
        if (duplicate) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Already on the list as #${duplicate.id ?? "?"}: ${content}\n\n${renderList(existing)}`,
              },
            ],
            metadata: { items: existing.length, open: openItems(existing).length, id: duplicate.id },
          }
        }
        const item: TodoItem = { id: nextId(existing), content, status: validStatus(input?.status) ?? "pending" }
        const priority = validPriority(input?.priority)
        if (priority) item.priority = priority
        const saved = await store.setTodos(context.sessionID, [...existing, item])
        hooks.onTodosChanged?.(context.sessionID)
        const added = saved.items[saved.items.length - 1]!
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Added #${added.id} ${added.content}${added.priority ? ` (${added.priority})` : ""}.\n\n` +
                `${renderSummary(saved.items)}\n\n${renderList(saved.items)}`,
            },
          ],
          metadata: { items: saved.items.length, open: openItems(saved.items).length, id: added.id },
        }
      } catch (err) {
        hooks.log?.(`todo_add failed (${context.sessionID}): ${String(err)}`)
        return {
          content: [{ type: "text" as const, text: `todo_add failed: ${String(err)}` }],
          metadata: { error: String(err) },
        }
      }
    },
  }
}

export function makeTodoRemove(store: TodoStore, hooks: ToolHooks) {
  return {
    name: "todo_remove",
    description: REMOVE_DESCRIPTION,
    input: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    options: { codemode: true as const },
    async execute(input: { id?: string }, context: ToolContextLike) {
      try {
        const id = String(input?.id ?? "").trim()
        if (!id) throw new Error('"id" must be a non-empty string')
        const state = await store.refreshTodos(context.sessionID)
        const existing = state?.items ?? []
        const removed = existing.find((item) => item.id === id)
        if (!removed) throw new Error(`no todo with id ${JSON.stringify(id)}`)
        const saved = await store.setTodos(
          context.sessionID,
          existing.filter((item) => item.id !== id),
        )
        hooks.onTodosChanged?.(context.sessionID)
        return {
          content: [
            {
              type: "text" as const,
              text: `Removed #${id}: ${removed.content}\n\n${renderSummary(saved.items)}\n\n${renderList(saved.items)}`,
            },
          ],
          metadata: { items: saved.items.length, open: openItems(saved.items).length, id },
        }
      } catch (err) {
        hooks.log?.(`todo_remove failed (${context.sessionID}): ${String(err)}`)
        return {
          content: [{ type: "text" as const, text: `todo_remove failed: ${String(err)}` }],
          metadata: { error: String(err) },
        }
      }
    },
  }
}

export function makeTodoSubscribe(store: TodoStore, hooks: ToolHooks, directory: string) {
  return {
    name: "todo_subscribe",
    description: SUBSCRIBE_DESCRIPTION,
    input: SUBSCRIBE_INPUT,
    options: { codemode: true as const },
    async execute(input: { files?: Array<{ path?: string }> }, context: ToolContextLike) {
      try {
        const paths = (Array.isArray(input?.files) ? input.files : []).map((entry) =>
          resolveMarkdownPath(directory, String(entry?.path ?? "")),
        )
        const current = await readSubs(store, context.sessionID)
        const files = [...new Set([...current.files, ...paths])]
        const removed = current.removed.filter((entry) => !paths.includes(entry))
        await store.setSubs(context.sessionID, files, removed)
        hooks.onTodosChanged?.(context.sessionID)
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Subscribed (${paths.length} path(s)); ${files.length} active: ${files.join(", ") || "none"}.\n` +
                "Mark items done by editing the file (`- [x]`).",
            },
          ],
          metadata: { files: files.length },
        }
      } catch (err) {
        hooks.log?.(`todo_subscribe failed (${context.sessionID}): ${String(err)}`)
        return {
          content: [{ type: "text" as const, text: `todo_subscribe failed: ${String(err)}` }],
          metadata: { error: String(err) },
        }
      }
    },
  }
}

export function makeTodoUnsubscribe(store: TodoStore, hooks: ToolHooks, directory: string) {
  return {
    name: "todo_unsubscribe",
    description: UNSUBSCRIBE_DESCRIPTION,
    input: SUBSCRIBE_INPUT,
    options: { codemode: true as const },
    async execute(input: { files?: Array<{ path?: string }> }, context: ToolContextLike) {
      try {
        const paths = (Array.isArray(input?.files) ? input.files : []).map((entry) =>
          resolveMarkdownPath(directory, String(entry?.path ?? "")),
        )
        const current = await readSubs(store, context.sessionID)
        const files = current.files.filter((entry) => !paths.includes(entry))
        const removed = [...new Set([...current.removed, ...paths])]
        await store.setSubs(context.sessionID, files, removed)
        hooks.onTodosChanged?.(context.sessionID)
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Unsubscribed (${paths.length} path(s)); ${files.length} active: ${files.join(", ") || "none"}.\n` +
                "Config defaults are shadowed until re-subscribed.",
            },
          ],
          metadata: { files: files.length },
        }
      } catch (err) {
        hooks.log?.(`todo_unsubscribe failed (${context.sessionID}): ${String(err)}`)
        return {
          content: [{ type: "text" as const, text: `todo_unsubscribe failed: ${String(err)}` }],
          metadata: { error: String(err) },
        }
      }
    },
  }
}

export async function registerTools(
  ctx: Plugin.Context,
  store: TodoStore,
  hooks: ToolHooks,
  options: Options,
  markdownDeps: MarkdownDeps,
): Promise<{ dispose: () => Promise<void> }> {
  const registration = await ctx.tool.transform((editor) => {
    editor.add(makeTodoWrite(store, hooks))
    editor.add(makeTodoRead(store, hooks, { ...markdownDeps, options }))
    editor.add(makeTodoAdd(store, hooks))
    editor.add(makeTodoRemove(store, hooks))
    editor.add(makeTodoSubscribe(store, hooks, markdownDeps.directory))
    editor.add(makeTodoUnsubscribe(store, hooks, markdownDeps.directory))
  })
  return { dispose: () => registration.dispose() }
}

// ---- execute.after refresh (§5.8, aspect 14c) -------------------------------

export type ExecuteAfterDeps = {
  store: TodoStore
  markdown: MarkdownCache
  options: Options
  directory: string
  onChanged?: (sessionID: string) => void
  log?: (...args: unknown[]) => void
}

const FILE_TOOLS = new Set(["edit", "write", "patch", "multiedit"])

function inputPath(input: unknown): string | undefined {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined
  if (!record) return undefined
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/**
 * `execute.after` refresh (§5.8): when an `edit`/`write`/`patch` touches a
 * subscribed markdown file, re-parse it immediately and notify (RPC `updated`
 * + supervisor re-evaluation). No filesystem watcher — other edits are picked
 * up at the next evaluation or UI read.
 */
export async function registerExecuteAfterHook(
  ctx: Plugin.Context,
  deps: ExecuteAfterDeps,
): Promise<{ dispose: () => Promise<void> }> {
  const registration = await ctx.tool.hook("execute.after", async (event) => {
    try {
      if (!FILE_TOOLS.has(event.tool)) return
      const sessionID = event.sessionID
      if (!sessionID) return
      const raw = inputPath(event.input)
      if (!raw) return
      const abs = isAbsolute(raw) ? resolvePath(raw) : resolvePath(deps.directory, raw)
      const subs = await deps.store.loadSubs(sessionID)
      if (!effectiveFiles(deps.options, deps.directory, subs).includes(abs)) return
      deps.markdown.invalidate(abs)
      deps.markdown.parse(abs)
      deps.onChanged?.(sessionID)
      deps.log?.(`markdown refreshed (${sessionID}) ${abs}`)
    } catch (err) {
      deps.log?.(`markdown refresh failed: ${String(err)}`)
    }
  })
  return { dispose: () => registration.dispose() }
}

// ---- context injection (§5.5, aspect 10) -----------------------------------

const CONTEXT_MARKER = "[todo-supervisor] Active todo list"

/** Compact block appended to every model request while the session has a list. */
export function renderTodoContext(items: readonly TodoItem[]): string {
  const open = openItems(items)
  const inProgress = items.filter((item) => item.status === "in_progress").length
  const status =
    `${open.length} of ${items.length} todo${items.length === 1 ? "" : "s"} left` +
    (inProgress > 0 ? `, ${inProgress} in progress` : "")
  return (
    `${CONTEXT_MARKER} — ${status}. Keep it updated with todo_write; ` +
    `only end the turn once every item is completed or canceled.\n${renderList(items)}`
  )
}

/**
 * Build the `session.hook("context")` callback (§5.5): synchronous, cache-only.
 * Idempotent — when two generations register on the same request (hot-reload
 * overlap), the second sees the marker block and skips.
 */
export function makeContextInjector(
  store: TodoStore,
  options: Options,
  log: (...args: unknown[]) => void,
): (event: { readonly sessionID: string; system: unknown[] }) => void {
  return (event) => {
    try {
      if (!options.injectTodoContext) return
      const items = store.getTodos(event.sessionID)?.items ?? []
      if (items.length === 0) return
      const system = event.system as Array<{ type?: unknown; text?: unknown }>
      if (system.some((part) => typeof part?.text === "string" && part.text.startsWith(CONTEXT_MARKER))) return
      system.push({ type: "text", text: renderTodoContext(items) })
      if (options.debugEvents) log(`context injected (${event.sessionID}, ${items.length} items)`)
    } catch (err) {
      log(`context injection failed (${String(err)})`)
    }
  }
}
