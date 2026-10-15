// todo-supervisor — options (PLAN.md §5.1, §5.7).
//
// Field-by-field type-checked parsing of `ctx.options`; invalid values fall
// back to the default with a warning so a typo never breaks loading.
import { log } from "./log"

export type Options = {
  enabled: boolean
  settleMs: number
  minNudgeIntervalMs: number
  stallMinutes: number
  maxNoProgressNudges: number
  injectTodoContext: boolean
  markdownFiles: string[]
  scope: "project" | "all"
  pauseOnInterrupt: boolean
  debugEvents: boolean
}

export const DEFAULTS: Options = {
  enabled: true,
  settleMs: 5000,
  minNudgeIntervalMs: 45000,
  stallMinutes: 5,
  maxNoProgressNudges: 5,
  injectTodoContext: true,
  markdownFiles: [],
  scope: "project",
  pauseOnInterrupt: true,
  debugEvents: false,
}

function readNumber(
  input: Record<string, unknown>,
  key: keyof Options,
  min: number,
  apply: (value: number) => void,
): void {
  const raw = input[key]
  if (raw === undefined) return
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= min) {
    apply(raw)
    return
  }
  log(`options: invalid "${key}" (${JSON.stringify(raw)}) — using default ${String(DEFAULTS[key])}`)
}

function readBoolean(
  input: Record<string, unknown>,
  key: keyof Options,
  apply: (value: boolean) => void,
): void {
  const raw = input[key]
  if (raw === undefined) return
  if (typeof raw === "boolean") {
    apply(raw)
    return
  }
  log(`options: invalid "${key}" (${JSON.stringify(raw)}) — using default ${String(DEFAULTS[key])}`)
}

export function parseOptions(raw: unknown): Options {
  const options: Options = { ...DEFAULTS, markdownFiles: [] }

  if (raw === undefined || raw === null) return options
  if (typeof raw !== "object" || Array.isArray(raw)) {
    log(`options: expected an object, got ${Array.isArray(raw) ? "array" : typeof raw} — using defaults`)
    return options
  }

  const input = raw as Record<string, unknown>

  readNumber(input, "settleMs", 0, (v) => (options.settleMs = v))
  readNumber(input, "minNudgeIntervalMs", 0, (v) => (options.minNudgeIntervalMs = v))
  readNumber(input, "stallMinutes", 0, (v) => (options.stallMinutes = v))
  readNumber(input, "maxNoProgressNudges", 0, (v) => (options.maxNoProgressNudges = v))

  readBoolean(input, "enabled", (v) => (options.enabled = v))
  readBoolean(input, "injectTodoContext", (v) => (options.injectTodoContext = v))
  readBoolean(input, "pauseOnInterrupt", (v) => (options.pauseOnInterrupt = v))
  readBoolean(input, "debugEvents", (v) => (options.debugEvents = v))

  const scope = input["scope"]
  if (scope !== undefined) {
    if (scope === "project" || scope === "all") options.scope = scope
    else log(`options: invalid "scope" (${JSON.stringify(scope)}) — using default "project"`)
  }

  const files = input["markdownFiles"]
  if (files !== undefined) {
    if (Array.isArray(files) && files.every((entry) => typeof entry === "string")) {
      options.markdownFiles = (files as string[]).map((s) => s.trim()).filter((s) => s.length > 0)
    } else {
      log(`options: invalid "markdownFiles" — using default []`)
    }
  }

  // Unknown keys are intentionally ignored (§5.7).
  return options
}
