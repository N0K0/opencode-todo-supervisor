// todo-supervisor — logging.
//
// Why this exists (verified 2026-10-15, OpenCode 2.0.24):
// - `console.log` inside plugins is swallowed by the plugin runtime;
// - `console.error` reaches stderr, which is visible in standalone/CLI
//   contexts (`opencode2 run --standalone --print-logs`) but is discarded by
//   the detached background service;
// - there is no logger API on the plugin context.
//
// So: mirror to stderr AND append to `<data>/opencode/log/todo-supervisor.log`
// so the background service stays greppable by the `[todo-supervisor]` prefix.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_BYTES = 2_000_000

let cached: string | undefined

function targetFile(): string | undefined {
  if (cached !== undefined) return cached || undefined
  try {
    const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    const dir = join(dataHome, "opencode", "log")
    mkdirSync(dir, { recursive: true })
    cached = join(dir, "todo-supervisor.log")
  } catch {
    cached = ""
  }
  return cached || undefined
}

function rotate(file: string) {
  try {
    if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
  } catch {
    // file missing or rename failed — appending either way is fine
  }
}

function format(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function log(...args: unknown[]): void {
  const line = `${new Date().toISOString()} [todo-supervisor] ${args.map(format).join(" ")}`
  console.error(line)
  const file = targetFile()
  if (!file) return
  try {
    rotate(file)
    appendFileSync(file, `${line}\n`)
  } catch {
    // never let logging break the plugin
  }
}

/**
 * File-only variant (no stderr) for environments that own the terminal — the
 * TUI plugin shares this log so both sides stay greppable by the prefix.
 */
export function logFile(prefix: string, ...args: unknown[]): void {
  const line = `${new Date().toISOString()} [todo-supervisor/${prefix}] ${args.map(format).join(" ")}`
  const file = targetFile()
  if (!file) return
  try {
    rotate(file)
    appendFileSync(file, `${line}\n`)
  } catch {
    // never let logging break the plugin
  }
}
