// todo-supervisor — markdown checklist mode (PLAN.md §5.8, aspect 14).
//
// Sessions may subscribe to any number of markdown files whose GFM checklist
// items act as todos. This module owns: the fence-aware parser, path
// resolution/validation, the effective-subscription merge, a per-file parse
// cache and the shared renderer for `path:line` sections.
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, relative, resolve as resolvePath } from "node:path"

export type MarkdownState = "open" | "completed" | "canceled"

export type MarkdownItem = {
  path: string
  /** 1-based line number for `path:line` references. */
  line: number
  text: string
  indent: string
  state: MarkdownState
}

export type ParsedFile = {
  path: string
  exists: boolean
  error?: string
  items: MarkdownItem[]
}

// GFM checkbox: any bullet or ordered marker, any indentation (§5.8). The trailing
// `\r?` keeps a CRLF file whose last line has no final newline parseable.
const ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+\[( |x|X|~)\]\s+(.*?)\r?$/
const FENCE_RE = /^\s*(`{3,}|~{3,})/

/** Fence-aware checklist parse; code fences are skipped (§5.8). */
export function parseChecklist(content: string, path: string): MarkdownItem[] {
  const items: MarkdownItem[] = []
  const lines = content.split(/\r?\n/)
  let fence: string | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (!fence) fence = marker[0]
      else if (marker[0] === fence) fence = undefined
      continue
    }
    if (fence) continue
    const match = ITEM_RE.exec(line)
    if (!match) continue
    const [, indent, marker, text] = match
    const state: MarkdownState =
      marker === "x" || marker === "X" ? "completed" : marker === "~" ? "canceled" : "open"
    items.push({ path, line: index + 1, text: text!.trim(), indent: indent!, state })
  }
  return items
}

/** `.md` / `.markdown` only; relative paths resolve against the location directory (§5.8). */
export function resolveMarkdownPath(directory: string, raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === "") throw new Error(`invalid input: "path" must be a non-empty string`)
  const abs = isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(directory, trimmed)
  if (!/\.(md|markdown)$/i.test(abs)) {
    throw new Error(`invalid input: "${raw}" is not a markdown file (.md or .markdown)`)
  }
  return abs
}

/** Effective set (§5.8): config `markdownFiles` ∪ stored `files`, minus `removed`. */
export function effectiveFiles(
  options: { readonly markdownFiles: readonly string[] },
  directory: string,
  subs: { readonly files: readonly string[]; readonly removed: readonly string[] } | undefined,
): string[] {
  const set = new Set<string>()
  for (const raw of options.markdownFiles) {
    set.add(isAbsolute(raw) ? resolvePath(raw) : resolvePath(directory, raw))
  }
  for (const path of subs?.files ?? []) set.add(path)
  for (const path of subs?.removed ?? []) set.delete(path)
  return [...set].sort()
}

/** Per-file parse cache keyed by mtime + size; `parse` is synchronous and cheap. */
export class MarkdownCache {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedFile }>()

  parse(path: string): ParsedFile {
    try {
      const stat = statSync(path)
      const hit = this.cache.get(path)
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed
      const parsed: ParsedFile = { path, exists: true, items: parseChecklist(readFileSync(path, "utf8"), path) }
      this.cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, parsed })
      return parsed
    } catch (err) {
      const parsed: ParsedFile = { path, exists: false, error: String(err), items: [] }
      this.cache.delete(path)
      return parsed
    }
  }

  invalidate(path?: string): void {
    if (path === undefined) this.cache.clear()
    else this.cache.delete(path)
  }
}

/** Open markdown items across the given files. */
export function openMarkdownItems(files: readonly ParsedFile[]): MarkdownItem[] {
  return files.flatMap((file) => file.items.filter((item) => item.state === "open"))
}

/**
 * Toggle one checklist item in place (§5.8 panel write-back). Only lines the
 * fence-aware parser reports as items are eligible, and only the marker is
 * rewritten — bullet, indentation, trailing text and the file's line endings are
 * preserved. Writes via a temp file + rename so a crash cannot truncate the file.
 * Callers invalidate the parse cache. Returns the new state.
 */
export function toggleMarkdownItem(path: string, line: number): MarkdownState {
  const content = readFileSync(path, "utf8")
  const item = parseChecklist(content, path).find((entry) => entry.line === line)
  if (!item) throw new Error(`no checklist item at ${path}:${line} (fenced or missing?)`)
  const next: MarkdownState = item.state === "completed" ? "open" : "completed"
  const marker = next === "completed" ? "x" : next === "canceled" ? "~" : " "
  const lines = content.split("\n")
  const index = line - 1
  const target = lines[index]
  if (target === undefined) throw new Error(`no line ${line} in ${path}`)
  const rewritten = target.replace(/\[( |x|X|~)\]/, `[${marker}]`)
  if (rewritten === target) throw new Error(`could not rewrite the checklist marker at ${path}:${line}`)
  lines[index] = rewritten
  const tmp = `${path}.todo-supervisor.tmp`
  writeFileSync(tmp, lines.join("\n"), "utf8")
  renameSync(tmp, path)
  return next
}

/** Path for display: relative to the location directory when inside it. */
export function displayPath(directory: string, path: string): string {
  const rel = relative(directory, path)
  return rel === "" || rel.startsWith("..") ? path : rel
}

/** Shared `path:line` section renderer (§5.3 `todo_read`, §5.4 nudges). */
export function renderFileSection(
  file: ParsedFile,
  directory: string,
  options: { openOnly?: boolean } = {},
): string {
  const shown = displayPath(directory, file.path)
  if (!file.exists) return `## ${shown} — missing (0 tasks)`
  const open = file.items.filter((item) => item.state === "open").length
  const marker = (state: MarkdownState) => (state === "completed" ? "[x]" : state === "canceled" ? "[~]" : "[ ]")
  const shownItems = options.openOnly ? file.items.filter((item) => item.state === "open") : file.items
  const rows = shownItems.map((item) => `- ${marker(item.state)} ${item.text}  (${shown}:${item.line})`)
  return [`## ${shown} (${open} open of ${file.items.length})`, ...rows].join("\n")
}
