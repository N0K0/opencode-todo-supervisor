// todo-supervisor — pure presentation helpers for the TUI todo panel (§6, aspect 12).
//
// Everything here is framework-free: layout math, row building, cursor movement
// and truncation are unit-tested without an OpenTUI renderer. src/tui.tsx only
// maps these rows to <text>/<box> elements.

export type PanelItem = { content: string; status: string; priority?: string }
export type PanelFileItem = { content: string; status: string; line?: number }
export type PanelFile = { path: string; exists: boolean; items: PanelFileItem[] }

/** RPC `list` → `supervisor` payload (see Supervisor.snapshot). */
export type PanelSupervisor = {
  registered?: boolean
  status?: string
  paused?: boolean
  pauseReason?: string | null
  blocked?: number
  runningChildren?: number
  runningShells?: number
  runningTools?: number
  spans?: string[]
  quietMs?: number
  terminal?: boolean
  nudges?: number
  noProgress?: number
}

export type PanelSnapshot = {
  items: PanelItem[]
  files: PanelFile[]
  supervisor?: PanelSupervisor
}

export type Row =
  | { kind: "section"; key: string; label: string; detail?: string; muted?: boolean }
  | {
      kind: "file"
      key: string
      path: string
      label: string
      open: number
      total: number
      exists: boolean
      collapsed: boolean
    }
  | {
      kind: "item"
      key: string
      source: "session" | "file"
      content: string
      status: string
      priority?: string
      path?: string
      line?: number
      index?: number
    }

export type ItemRow = Extract<Row, { kind: "item" }>
export type FileRow = Extract<Row, { kind: "file" }>

export function isSelectable(row: Row): row is ItemRow | FileRow {
  return row.kind === "item" || row.kind === "file"
}

/** `[ ]` / `[~]` (in progress or canceled) / `[x]` — matches todo_read. */
export function statusMark(status: string): string {
  if (status === "completed") return "[x]"
  if (status === "in_progress" || status === "canceled") return "[~]"
  return "[ ]"
}

export function countOpen(items: readonly { status: string }[]): number {
  return items.filter((item) => item.status !== "completed").length
}

/** `████░░░░` filled by completion ratio; `░` when there is nothing to do. */
export function progressBar(done: number, total: number, width: number): string {
  const cells = Math.max(0, Math.floor(width))
  if (cells === 0) return ""
  if (total <= 0) return "░".repeat(cells)
  const filled = Math.max(0, Math.min(cells, Math.round((done / total) * cells)))
  return "█".repeat(filled) + "░".repeat(cells - filled)
}

/** Single-line, whitespace-collapsed, ellipsised to `width` cells. */
export function truncate(text: string, width: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (width <= 0) return ""
  if (clean.length <= width) return clean
  if (width === 1) return "…"
  return `${clean.slice(0, width - 1)}…`
}

/** `3s` / `1m20s` — compact quiet-time label. */
export function quietLabel(ms: number | undefined): string {
  if (ms === undefined) return "—"
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/** One-line supervision summary for the panel header. */
export function supervisorChip(supervisor: PanelSupervisor | undefined): string {
  if (!supervisor || supervisor.registered === false) return "not supervised"
  const nudges = supervisor.nudges ?? 0
  if (supervisor.paused) return `paused (${supervisor.pauseReason ?? "paused"}) · nudges ${nudges}`
  const work: string[] = []
  const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`
  if (supervisor.runningTools) work.push(plural(supervisor.runningTools, "tool"))
  if (supervisor.runningChildren) work.push(plural(supervisor.runningChildren, "subagent"))
  if (supervisor.runningShells) work.push(plural(supervisor.runningShells, "shell"))
  if (work.length > 0) return `working: ${work.join(" · ")} · quiet ${quietLabel(supervisor.quietMs)}`
  if (supervisor.terminal === false) return `waiting for turn end · quiet ${quietLabel(supervisor.quietMs)}`
  return `idle · quiet ${quietLabel(supervisor.quietMs)} · nudges ${nudges}`
}

export type BuildOptions = {
  /** Case-insensitive substring filter over item content. */
  filter?: string
  /** Collapsed markdown file paths (their items are hidden). */
  collapsed?: ReadonlySet<string>
  /** Path display, e.g. `context.ui.format.path` (defaults to identity). */
  formatPath?: (path: string) => string
}

function matches(text: string, filter: string): boolean {
  return filter === "" || text.toLowerCase().includes(filter)
}

/**
 * Flatten a snapshot into panel rows: `SESSION` section, then one section per
 * subscribed file (collapsible), each item selectable. Filters hide items and
 * whole sections that no longer match; the cursor is kept by row key elsewhere.
 */
export function buildRows(snapshot: PanelSnapshot, options: BuildOptions = {}): Row[] {
  const filter = (options.filter ?? "").trim().toLowerCase()
  const collapsed = options.collapsed ?? new Set<string>()
  const formatPath = options.formatPath ?? ((path: string) => path)
  const rows: Row[] = []

  const sessionVisible = snapshot.items.filter((item) => matches(item.content, filter))
  if (snapshot.items.length > 0 && sessionVisible.length > 0) {
    rows.push({
      kind: "section",
      key: "section:session",
      label: "SESSION",
      detail: `${countOpen(snapshot.items)} open of ${snapshot.items.length}`,
    })
    for (const item of sessionVisible) {
      const index = snapshot.items.indexOf(item)
      rows.push({
        kind: "item",
        key: `session:${index}`,
        source: "session",
        index,
        content: item.content,
        status: item.status,
        priority: item.priority,
      })
    }
  }

  for (const file of snapshot.files) {
    const visible = file.items.filter((item) => matches(item.content, filter))
    if (filter !== "" && visible.length === 0) continue
    const isCollapsed = collapsed.has(file.path)
    rows.push({
      kind: "file",
      key: `file:${file.path}`,
      path: file.path,
      label: formatPath(file.path),
      open: countOpen(file.items),
      total: file.items.length,
      exists: file.exists,
      collapsed: isCollapsed,
    })
    if (isCollapsed) continue
    for (const item of visible) {
      rows.push({
        kind: "item",
        key: `file:${file.path}:${item.line ?? item.content}`,
        source: "file",
        path: file.path,
        line: item.line,
        content: item.content,
        status: item.status,
      })
    }
  }

  if (rows.length === 0) {
    rows.push({
      kind: "section",
      key: "section:empty",
      label: snapshot.items.length > 0 || snapshot.files.length > 0 ? "no matches" : "no todos",
      detail:
        snapshot.items.length > 0 || snapshot.files.length > 0
          ? "clear the filter to see everything"
          : "the agent records todos with todo_write; /todos add <path> subscribes a file",
      muted: true,
    })
  } else if (countOpen(snapshot.items) + snapshot.files.reduce((sum, file) => sum + countOpen(file.items), 0) === 0) {
    rows.push({ kind: "section", key: "section:done", label: "all todos done 🎉", muted: true })
  }

  return rows
}

/** Keeps a row key valid after a refresh; falls back to the first selectable row. */
export function clampCursor(rows: readonly Row[], key: string | undefined): string | undefined {
  const selectable = rows.filter(isSelectable)
  if (selectable.length === 0) return undefined
  if (key && selectable.some((row) => row.key === key)) return key
  return selectable[0]!.key
}

/** Moves by `delta` over selectable rows only, clamped to the ends. */
export function moveCursor(rows: readonly Row[], key: string | undefined, delta: number): string | undefined {
  const selectable = rows.filter(isSelectable)
  if (selectable.length === 0) return undefined
  const current = selectable.findIndex((row) => row.key === key)
  const index = current === -1 ? 0 : current
  const next = Math.max(0, Math.min(selectable.length - 1, index + delta))
  return selectable[next]!.key
}

export function rowIndex(rows: readonly Row[], key: string | undefined): number {
  return key === undefined ? -1 : rows.findIndex((row) => row.key === key)
}

/** Scroll window that keeps the selected row visible within `height` rows. */
export function visibleWindow(
  rows: readonly Row[],
  key: string | undefined,
  height: number,
): { start: number; end: number } {
  const size = Math.max(1, Math.floor(height))
  if (rows.length <= size) return { start: 0, end: rows.length }
  const index = Math.max(0, rowIndex(rows, key))
  const start = Math.max(0, Math.min(index - Math.floor(size / 2), rows.length - size))
  return { start, end: start + size }
}

/** Width-aware key hints for the footer (wide terminals get the long form). */
export function footerHints(width: number): string[] {
  const wide = [
    "↑↓ move",
    "space toggle",
    "enter collapse",
    "n nudge",
    "s pause",
    "a add",
    "d remove",
    "r refresh",
    "/ filter",
    "f resize",
    "esc close",
  ]
  if (width >= 110) return wide
  if (width >= 80) return wide.slice(0, 8)
  return ["↑↓", "space toggle", "n nudge", "/ filter", "esc"]
}

export type DialogSizeName = "medium" | "large" | "xlarge"

/**
 * Content width for the popover dialog. The host owns the dialog box, so the
 * list sizes its rows from the render region instead and clamps for small
 * terminals (a wider dialog just shows more of each row).
 */
export function dialogWidth(size: DialogSizeName, viewportWidth: number): number {
  const total = Math.max(40, viewportWidth)
  const bySize =
    size === "xlarge" ? total - 8 : size === "large" ? total - 16 : Math.min(72, Math.max(48, total - 24))
  return Math.max(36, Math.min(bySize, 140))
}
