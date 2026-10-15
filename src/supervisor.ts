// todo-supervisor — the core state machine (PLAN.md §5.4).
//
// One instance per plugin location. Everything is driven by the public event
// stream; the registry is fed exclusively by events + a startup reconcile.
// The scheduler only ever holds `setTimeout`s per session; every entry point
// is wrapped so a single throwing handler can never kill the loop.
//
// Hot reloads can leave an older plugin generation alive for a while (the
// runtime may not call the previous cleanup). Two defences keep that from
// causing duplicate nudges:
//   1. per-session *ownership claims* in storage — every registration writes
//      `{tag, at}` and a nudge is only sent when no strictly newer claim
//      exists (the newest generation owns the session);
//   2. the event loop stops on its abort signal, so superseded generations
//      stop consuming events as soon as they see one.
import { effectiveFiles, MarkdownCache, openMarkdownItems, renderFileSection, type MarkdownItem, type ParsedFile } from "./markdown"
import type { Options } from "./options"
import { openItems, type TodoItem, type TodoStore } from "./storage"
import { renderList } from "./tools"

export type NormalizedEvent = {
  type: string
  data: Record<string, unknown>
}

export function normalizeEvent(raw: unknown): NormalizedEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const source = raw as Record<string, unknown>
  const type = typeof source.type === "string" ? source.type : undefined
  if (!type) return undefined

  const rawData = source.data
  const data =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : source
  return { type, data }
}

export function truncate(value: string, max = 500): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(${value.length - max} more)`
}

// "running" is fed by `session.status` `{type:"busy"}`; "requires_action" by
// pending permission/form blockers; the event status union is idle|retry|busy (§12).
type SStatus = "idle" | "running" | "requires_action" | "unknown"

type Shell = {
  startedAt: number
  lastActivityAt: number
  command?: string
}

type Stalled = {
  children: string[]
  shells: string[]
  quietMs?: number
}

type SessionState = {
  sessionID: string
  parentID?: string
  projectID: string
  status: SStatus
  lastActivityAt: number
  blocked: Set<"permission" | "form">
  children: Set<string>
  shells: Map<string, Shell>
  evaluateTimer?: ReturnType<typeof setTimeout>
  retryTimer?: ReturnType<typeof setTimeout>
  sending: boolean
  nudges: number
  noProgress: number
  lastNudgedHash?: string
  nextEligibleAt: number
  paused: boolean
  pauseReason?: "interrupt" | "no-progress" | "disabled"
  /** Timestamp of this instance's ownership claim (see claims below). */
  claimedAt: number
}

export type SessionRef = {
  projectID: string
  parentID?: string
}

/** Minimal storage shape used for ownership claims (`ctx.storage` satisfies it). */
export interface ClaimsStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export interface SupervisorDeps {
  options: Options
  store: TodoStore
  /** Project of the plugin instance's location (`ctx.location.project.id`). */
  projectID: string
  /** Unique tag of this plugin instance, used in logs and ownership claims. */
  tag: string
  /** Prefixed logger (bound by the plugin entry point). */
  log(...args: unknown[]): void
  /** `ctx.session.synthetic` — durably admit synthetic input. */
  synthetic(input: {
    sessionID: string
    text: string
    description?: string
    metadata?: Record<string, unknown>
  }): Promise<void>
  /** `ctx.session.get` — used by startup reconcile. */
  getSession(sessionID: string): Promise<SessionRef | undefined>
  /** Ownership claims; when absent, claim checks are skipped (unit tests). */
  claims?: ClaimsStore
  /** Busy/409 retry tuning (tests shrink this). Defaults: 5 s, 5 attempts. */
  retry?: { delayMs?: number; attempts?: number }
  /** Aspect 11 — emit `updated`/`nudged` RPC events. */
  emitRpcEvent?(name: "updated" | "nudged", payload: Record<string, unknown>): void
  /** Markdown mode (§5.8): shared per-file parse cache. */
  markdown: MarkdownCache
  /** Location directory: relative subscription paths resolve against it. */
  directory: string
}

const RETRY_MS = 5000
const RETRY_ATTEMPTS = 5
const TIMER_EPSILON_MS = 500

/** Merged supervision sources (§5.8): the session list plus subscribed markdown files. */
type Sources = {
  sessionItems: TodoItem[]
  sessionOpen: TodoItem[]
  files: ParsedFile[]
  fileOpen: MarkdownItem[]
  paths: string[]
  total: number
  open: number
  supervised: boolean
}

/** No-progress hash: open texts only, line numbers excluded (§5.8). */
function hashSources(sources: Sources): string {
  return [
    ...sources.sessionOpen.map((item) => item.content),
    ...sources.fileOpen.map((item) => item.text),
  ].join("\u0000")
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function formatQuiet(quietMs: number | undefined, stallMinutes: number): string {
  if (quietMs === undefined) return `~${stallMinutes} min`
  if (quietMs < 60_000) return "less than a minute"
  const minutes = quietMs / 60_000
  return `~${minutes < 10 ? minutes.toFixed(1) : Math.round(minutes)} min`
}

function parseClaim(value: unknown): { tag: string; at: number } | undefined {
  const record = rec(value)
  const tag = str(record?.["tag"])
  const at = record?.["at"]
  if (!tag || typeof at !== "number") return undefined
  return { tag, at }
}

const claimKey = (sessionID: string) => `claims/${sessionID}`

export class Supervisor {
  private readonly registry = new Map<string, SessionState>()
  /** shellID → owning sessionID; shell events are location-scoped (§12). */
  private readonly shellSessions = new Map<string, string>()
  /** Paths already reported missing (§5.8: log once on the transition). */
  private readonly missingFiles = new Set<string>()
  private readonly log: (...args: unknown[]) => void
  private disposed = false

  constructor(private readonly deps: SupervisorDeps) {
    this.log = deps.log ?? (() => {})
  }

  // ---- registry ------------------------------------------------------------

  registerSession(sessionID: string, ref: SessionRef): SessionState {
    let st = this.registry.get(sessionID)
    let fresh = false
    if (!st) {
      st = {
        sessionID,
        parentID: ref.parentID,
        projectID: ref.projectID,
        status: "unknown",
        lastActivityAt: Date.now(),
        blocked: new Set(),
        children: new Set(),
        shells: new Map(),
        sending: false,
        nudges: 0,
        noProgress: 0,
        nextEligibleAt: 0,
        paused: false,
        claimedAt: Date.now(),
      }
      this.registry.set(sessionID, st)
      fresh = true
      this.log(`register ${sessionID} (project=${ref.projectID}${ref.parentID ? ` parent=${ref.parentID}` : ""})`)
    } else {
      if (ref.parentID) st.parentID = ref.parentID
      st.projectID = ref.projectID
    }
    if (ref.parentID) {
      const parent = this.registry.get(ref.parentID)
      if (parent) parent.children.add(sessionID)
    }
    // Claim ownership so overlapping plugin generations agree on one nudger.
    void this.deps.claims
      ?.set(claimKey(sessionID), { tag: this.deps.tag, at: st.claimedAt })
      .catch((err) => this.log(`claim write failed (${sessionID}): ${String(err)}`))
    if (fresh) this.log(`claim ${sessionID} (tag=${this.deps.tag})`)
    return st
  }

  private async ownsSession(sessionID: string): Promise<boolean> {
    if (!this.deps.claims) return true
    let claim: { tag: string; at: number } | undefined
    try {
      claim = parseClaim(await this.deps.claims.get(claimKey(sessionID)))
    } catch (err) {
      // Fail open: a storage blip must not silence supervision entirely.
      this.log(`claim read failed (${sessionID}) — assuming ownership: ${String(err)}`)
      return true
    }
    if (!claim || claim.tag === this.deps.tag) return true
    const st = this.registry.get(sessionID)
    const mine = st?.claimedAt ?? 0
    const newer = claim.at > mine || (claim.at === mine && claim.tag > this.deps.tag)
    return !newer
  }

  private unregisterSession(sessionID: string): void {
    const st = this.registry.get(sessionID)
    if (!st) return
    if (st.evaluateTimer) clearTimeout(st.evaluateTimer)
    if (st.retryTimer) clearTimeout(st.retryTimer)
    if (st.parentID) {
      const parent = this.registry.get(st.parentID)
      if (parent) parent.children.delete(sessionID)
    }
    this.registry.delete(sessionID)
    this.log(`unregister ${sessionID}`)
  }

  private inScope(projectID: string): boolean {
    return this.deps.options.scope === "all" || projectID === this.deps.projectID
  }

  getState(sessionID: string): SessionState | undefined {
    return this.registry.get(sessionID)
  }

  /** Per-session kill switch (RPC `setEnabled`, aspect 11). */
  setEnabled(sessionID: string, enabled: boolean): void {
    const st = this.registry.get(sessionID)
    if (!st) return
    if (enabled) {
      st.paused = false
      st.pauseReason = undefined
      this.scheduleEvaluate(sessionID, this.deps.options.settleMs)
    } else {
      st.paused = true
      st.pauseReason = "disabled"
      if (st.evaluateTimer) clearTimeout(st.evaluateTimer)
      st.evaluateTimer = undefined
    }
  }

  /** Read-only view used by RPC `list` (aspect 11). */
  snapshot(sessionID: string): Record<string, unknown> {
    const st = this.registry.get(sessionID)
    if (!st) return { registered: false }
    let runningChildren = 0
    for (const childID of st.children) {
      if (this.registry.get(childID)?.status === "running") runningChildren += 1
    }
    return {
      registered: true,
      status: st.status,
      paused: st.paused,
      pauseReason: st.pauseReason ?? null,
      blocked: st.blocked.size,
      runningChildren,
      runningShells: st.shells.size,
      nudges: st.nudges,
      noProgress: st.noProgress,
    }
  }

  /**
   * Manual wake-up (RPC `nudge`, aspect 11): explicit user intent bypasses the
   * quiet-time and busy-state checks, but a disabled or paused session stays
   * quiet. Ownership claims still apply.
   */
  forceNudge(sessionID: string): void {
    if (this.disposed) return
    if (!this.registry.has(sessionID)) return
    void this.nudge(sessionID, "open-todos", undefined, true)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const st of this.registry.values()) {
      if (st.evaluateTimer) clearTimeout(st.evaluateTimer)
      if (st.retryTimer) clearTimeout(st.retryTimer)
    }
    this.log(`disposed (sessions=${this.registry.size})`)
    this.registry.clear()
    this.shellSessions.clear()
  }

  // ---- scheduling ----------------------------------------------------------

  private scheduleEvaluate(sessionID: string, delayMs: number): void {
    if (this.disposed) return
    const st = this.registry.get(sessionID)
    if (!st) return
    if (st.evaluateTimer) clearTimeout(st.evaluateTimer)
    st.evaluateTimer = setTimeout(() => {
      st.evaluateTimer = undefined
      void this.evaluate(sessionID).catch((err) => this.log(`evaluate failed (${sessionID}): ${String(err)}`))
    }, Math.max(0, delayMs))
  }

  private cancelEvaluate(sessionID: string): void {
    const st = this.registry.get(sessionID)
    if (st?.evaluateTimer) {
      clearTimeout(st.evaluateTimer)
      st.evaluateTimer = undefined
    }
  }

  /** Called by the tools after `todo_write` (§5.2): reset counters, re-evaluate. */
  notifyTodosChanged(sessionID: string): void {
    const st = this.registry.get(sessionID)
    if (!st) {
      // Session existed before the plugin loaded (or was out of scope until now):
      // register lazily, then evaluate.
      void this.deps
        .getSession(sessionID)
        .then((ref) => {
          if (!ref || !this.inScope(ref.projectID)) return
          this.registerSession(sessionID, ref)
          this.scheduleEvaluate(sessionID, this.deps.options.settleMs)
        })
        .catch((err) => this.log(`lazy register failed (${sessionID}): ${String(err)}`))
      return
    }
    st.noProgress = 0
    if (st.paused && st.pauseReason !== "disabled") {
      this.log(`resume ${sessionID}: list changed — supervision re-enabled (was ${st.pauseReason})`)
      st.paused = false
      st.pauseReason = undefined
    }
    this.scheduleEvaluate(sessionID, this.deps.options.settleMs)
  }

  // ---- startup reconcile ---------------------------------------------------

  async reconcile(): Promise<void> {
    const states = await this.deps.store.scanAll()
    for (const state of states) {
      try {
        const ref = await this.deps.getSession(state.sessionID)
        if (!ref) {
          this.log(`reconcile: session ${state.sessionID} not found — dropping stored list`)
          await this.deps.store.removeTodos(state.sessionID)
          continue
        }
        if (!this.inScope(ref.projectID)) continue
        this.registerSession(state.sessionID, ref)
        this.scheduleEvaluate(state.sessionID, this.deps.options.settleMs)
      } catch (err) {
        this.log(`reconcile: lookup failed for ${state.sessionID} — keeping list: ${String(err)}`)
      }
    }
  }

  // ---- event ingestion -----------------------------------------------------

  /** Entry point for the subscription loop. Never throws. */
  async handle(raw: unknown): Promise<void> {
    if (this.disposed) return
    const event = normalizeEvent(raw)
    if (!event) return

    const { type, data } = event
    if (type === "shell.created" || type === "shell.exited" || type === "shell.deleted") {
      try {
        this.handleShellEvent(type, data)
      } catch (err) {
        this.log(`event handler error (${type}): ${String(err)}`)
      }
      return
    }
    const sessionID = str(data.sessionID) ?? str(rec(data.form)?.sessionID)
    if (!sessionID) return

    try {
      await this.dispatch(type, sessionID, data)
    } catch (err) {
      this.log(`event handler error (${type} ${sessionID}): ${String(err)}`)
    }
  }

  /** Shell events have no sessionID in `data`; the owner is in `info.metadata` (§12). */
  private handleShellEvent(type: string, data: Record<string, unknown>): void {
    if (type === "shell.created") {
      const info = rec(data.info)
      const shellID = str(info?.id)
      const owner = str(rec(info?.metadata)?.["sessionID"])
      if (!shellID || !owner || str(info?.status) !== "running") return
      const st = this.registry.get(owner)
      if (!st) return
      st.shells.set(shellID, {
        startedAt: num(rec(info?.time)?.["started"]) ?? Date.now(),
        lastActivityAt: Date.now(),
        command: str(info?.command),
      })
      this.shellSessions.set(shellID, owner)
      return
    }
    const shellID = str(data.id)
    if (!shellID) return
    const owner = this.shellSessions.get(shellID)
    if (!owner) return
    this.registry.get(owner)?.shells.delete(shellID)
    this.shellSessions.delete(shellID)
  }

  private async dispatch(type: string, sessionID: string, data: Record<string, unknown>): Promise<void> {
    const options = this.deps.options

    switch (type) {
      case "session.created": {
        const projectID = str(data.projectID)
        if (!projectID || !this.inScope(projectID)) return
        const parentID = str(data.parentID)
        this.registerSession(sessionID, { projectID, parentID })
        if (this.deps.store.getTodos(sessionID)) this.scheduleEvaluate(sessionID, options.settleMs)
        return
      }

      case "session.deleted": {
        const st = this.registry.get(sessionID)
        if (!st) return
        this.unregisterSession(sessionID)
        for (const [shellID, owner] of this.shellSessions) {
          if (owner === sessionID) this.shellSessions.delete(shellID)
        }
        void this.deps.claims
          ?.remove(claimKey(sessionID))
          .catch((err) => this.log(`claim remove failed (${sessionID}): ${String(err)}`))
        await this.deps.store.removeTodos(sessionID)
        await this.deps.store.removeSubs(sessionID)
        this.deps.emitRpcEvent?.("updated", { sessionID })
        return
      }

      case "session.status": {
        const st = this.registry.get(sessionID)
        if (!st) return
        const statusType = str(rec(data.status)?.type)
        if (statusType === "idle") {
          st.status = "idle"
          this.scheduleEvaluate(sessionID, options.settleMs)
        } else {
          // busy | retry — actively working
          st.status = "running"
          this.cancelEvaluate(sessionID)
        }
        return
      }

      case "session.idle": {
        // Deprecated in 2.0.24 but still emitted; stays idempotent with session.status.
        const st = this.registry.get(sessionID)
        if (!st) return
        st.status = "idle"
        this.scheduleEvaluate(sessionID, options.settleMs)
        return
      }

      case "session.execution.started": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.status = "running"
        this.cancelEvaluate(sessionID)
        return
      }

      case "session.execution.succeeded":
      case "session.execution.failed": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.status = "idle"
        this.scheduleEvaluate(sessionID, options.settleMs)
        return
      }

      case "session.execution.interrupted": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.status = "idle"
        if (options.pauseOnInterrupt) {
          st.paused = true
          st.pauseReason = "interrupt"
          this.log(`pause ${sessionID}: execution interrupted — waiting for user input`)
        }
        this.scheduleEvaluate(sessionID, options.settleMs)
        return
      }

      case "session.tool.input.started":
      case "session.tool.input.ended":
      case "session.tool.input.delta":
      case "session.text.delta":
      case "session.text.started":
      case "session.text.ended":
      case "session.reasoning.delta":
      case "session.reasoning.started":
      case "session.reasoning.ended":
      case "session.step.started":
      case "session.step.streamed":
      case "session.step.ended":
      case "session.step.failed":
      case "message.part.updated": {
        const st = this.registry.get(sessionID)
        if (st) st.lastActivityAt = Date.now()
        return
      }

      case "session.tool.progress": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.lastActivityAt = Date.now()
        const shellID = str(rec(data.metadata)?.["shellID"])
        if (shellID) {
          const shell = st.shells.get(shellID)
          if (shell) shell.lastActivityAt = Date.now()
        }
        return
      }

      case "session.tool.called": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.lastActivityAt = Date.now()
        return
      }

      case "session.tool.success":
      case "session.tool.failed": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.lastActivityAt = Date.now()
        return
      }

      case "permission.asked": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.blocked.add("permission")
        st.status = "requires_action"
        return
      }

      case "permission.replied": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.blocked.delete("permission")
        if (st.blocked.size === 0 && st.status === "requires_action") st.status = "idle"
        this.scheduleEvaluate(sessionID, options.settleMs)
        return
      }

      case "form.created": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.blocked.add("form")
        st.status = "requires_action"
        return
      }

      case "form.replied":
      case "form.cancelled": {
        const st = this.registry.get(sessionID)
        if (!st) return
        st.blocked.delete("form")
        if (st.blocked.size === 0 && st.status === "requires_action") st.status = "idle"
        this.scheduleEvaluate(sessionID, options.settleMs)
        return
      }

      case "session.inbox.enqueued": {
        const st = this.registry.get(sessionID)
        if (!st) return
        const item = rec(data.item)
        const payload = rec(item?.["payload"])
        const metadata = rec(payload?.["metadata"])
        const synthetic =
          item?.["type"] === "synthetic" || metadata?.["source"] === "todo-supervisor"
        if (synthetic) return
        // Real user input resumes a paused session and resets the backstop.
        st.paused = false
        st.pauseReason = undefined
        st.noProgress = 0
        this.scheduleEvaluate(sessionID, options.settleMs)
        return
      }

      default:
        // Unknown/unused events are ignored by design (§11 Aspect 6).
        return
    }
  }

  // ---- evaluation ----------------------------------------------------------

  /** Debug-gated decision log (aspect 9/13): why an evaluation stopped early. */
  private debugSkip(sessionID: string, reason: string): void {
    if (this.deps.options.debugEvents) this.log(`evaluate ${sessionID}: skipped (${reason})`)
  }

  /**
   * Merged sources (§5.8): the session list (fresh from storage) plus every
   * subscribed markdown file (parsed via the shared cache). Never throws.
   */
  private async collectSources(sessionID: string): Promise<Sources> {
    const sessionItems = this.deps.store.getTodos(sessionID)?.items ?? []
    let files: ParsedFile[] = []
    let paths: string[] = []
    try {
      const subs = await this.deps.store.loadSubs(sessionID)
      paths = effectiveFiles(this.deps.options, this.deps.directory, subs)
      files = paths.map((path) => this.deps.markdown.parse(path))
      for (const file of files) {
        if (!file.exists && !this.missingFiles.has(file.path)) {
          this.missingFiles.add(file.path)
          this.log(`markdown file missing (${file.path}) — 0 tasks until it exists`)
        } else if (file.exists) {
          this.missingFiles.delete(file.path)
        }
      }
    } catch (err) {
      this.log(`markdown sources failed (${sessionID}): ${String(err)}`)
    }
    const sessionOpen = openItems(sessionItems)
    const fileOpen = openMarkdownItems(files)
    return {
      sessionItems,
      sessionOpen,
      files,
      fileOpen,
      paths,
      total: sessionItems.length + files.reduce((sum, file) => sum + file.items.length, 0),
      open: sessionOpen.length + fileOpen.length,
      supervised: sessionItems.length > 0 || paths.length > 0,
    }
  }

  async evaluate(sessionID: string): Promise<void> {
    if (this.disposed) return
    const st = this.registry.get(sessionID)
    if (!st) return
    if (st.status === "running") return

    const options = this.deps.options
    // Writes from the role that hosts tool execution are invisible to this cache:
    // re-read shared storage before deciding (§12 stale-cache fix).
    try {
      await this.deps.store.refreshTodos(sessionID)
    } catch (err) {
      this.log(`refresh failed (${sessionID}): ${String(err)}`)
    }
    const sources = await this.collectSources(sessionID)
    if (!sources.supervised || sources.open === 0) {
      this.debugSkip(sessionID, sources.supervised ? "done" : "no sources")
      return
    }
    if (!options.enabled) {
      this.debugSkip(sessionID, "plugin disabled")
      return
    }
    if (st.paused) {
      this.debugSkip(sessionID, `paused (${st.pauseReason ?? "paused"})`)
      return
    }
    if (st.blocked.size > 0) {
      this.debugSkip(sessionID, `blocked (${st.blocked.size})`)
      return
    }
    if (st.status === "requires_action") {
      this.debugSkip(sessionID, "requires_action")
      return
    }

    const now = Date.now()
    const stallMs = options.stallMinutes * 60_000

    const runningChildren = this.runningChildren(st)
    const activeShells = [...st.shells.entries()]
    const quiet = this.quietMs(st, runningChildren)

    // `session.execution.*` fires per step, so `status` can read `idle` while the
    // model is still thinking, streaming or preparing an edit. Only a session
    // (and its children/shells) that has been quiet for the whole threshold is
    // nudged (§12 busy-state fix).
    if (runningChildren.length > 0 || activeShells.length > 0) {
      if (quiet < stallMs) {
        this.debugSkip(sessionID, `work quiet ${(quiet / 1000).toFixed(1)}s < ${options.stallMinutes}min`)
        this.scheduleEvaluate(sessionID, stallMs - quiet + TIMER_EPSILON_MS)
        return
      }
      const stalled = {
        children: runningChildren.map((child) => child.sessionID),
        shells: activeShells.map(([, shell]) => shell.command ?? "(background shell)"),
        quietMs: quiet,
      }
      await this.nudge(sessionID, "stalled-task", stalled)
      return
    }

    if (quiet < options.settleMs) {
      this.debugSkip(sessionID, `recent activity (${quiet}ms < settleMs ${options.settleMs}ms)`)
      this.scheduleEvaluate(sessionID, options.settleMs - quiet + TIMER_EPSILON_MS)
      return
    }

    if (now < st.nextEligibleAt) {
      this.scheduleEvaluate(sessionID, st.nextEligibleAt - now + TIMER_EPSILON_MS)
      return
    }
    await this.nudge(sessionID, "open-todos")
  }

  /** Running direct children of a session (registry subset). */
  private runningChildren(st: SessionState): SessionState[] {
    return [...st.children]
      .map((id) => this.registry.get(id))
      .filter((child): child is SessionState => !!child && child.status === "running")
  }

  /**
   * Milliseconds since the newest activity across the session, its running
   * children and its tracked shells — the "is this really idle?" clock (§12).
   */
  private quietMs(st: SessionState, runningChildren?: SessionState[]): number {
    const children = runningChildren ?? this.runningChildren(st)
    const newest = Math.max(
      0,
      st.lastActivityAt,
      ...children.map((child) => child.lastActivityAt),
      ...[...st.shells.values()].map((shell) => Math.max(shell.startedAt, shell.lastActivityAt)),
    )
    return Date.now() - newest
  }

  // ---- nudging -------------------------------------------------------------

  private renderNudge(
    reason: "open-todos" | "stalled-task",
    nudgeNumber: number,
    sources: Sources,
    stalled?: Stalled,
  ): string {
    const inProgress = sources.sessionItems.filter((item) => item.status === "in_progress").length
    const status =
      `${sources.open} of ${sources.total} todo${sources.total === 1 ? "" : "s"} left` +
      (inProgress > 0 ? `, ${inProgress} in progress` : "")

    // Group by source: session list first, then one `path:line` section per file.
    const blocks: string[] = []
    if (sources.sessionOpen.length > 0) blocks.push(renderList(sources.sessionOpen))
    for (const file of sources.files) {
      if (!file.exists || file.items.some((item) => item.state === "open")) {
        blocks.push(renderFileSection(file, this.deps.directory, { openOnly: true }))
      }
    }
    const list = blocks.join("\n\n")

    const markdownNote =
      sources.fileOpen.length > 0 ? " Markdown items are checked off by editing the file (`- [x]`)." : ""
    const footer =
      sources.sessionItems.length > 0
        ? "Continue working through the list (start with the [~] item when present). Keep it updated with " +
          "todo_write, and only end your turn once every item is completed or canceled." +
          markdownNote
        : "Continue with the open checklist items; edit the subscribed file and mark items `- [x]` when done."

    if (reason === "stalled-task" && stalled) {
      const who = [
        ...stalled.children.map((id) => `subagent ${id}`),
        ...stalled.shells.map((cmd) => `background shell "${cmd}"`),
      ].join(" / ")
      return (
        `[todo-supervisor] Stall nudge #${nudgeNumber} — no activity for ${formatQuiet(stalled.quietMs, this.deps.options.stallMinutes)} ` +
        `from: ${who} (stall threshold ${this.deps.options.stallMinutes} min).\n` +
        `Status: ${status}. Check its status, recover or restart it if stuck, then continue:\n${list}\n\n` +
        `Keep the list updated with todo_write; only end your turn once every item is completed or canceled.` +
        markdownNote
      )
    }
    return (
      `[todo-supervisor] Idle nudge #${nudgeNumber} — the session went idle with ${status}.\n${list}\n\n${footer}`
    )
  }

  private async nudge(
    sessionID: string,
    reason: "open-todos" | "stalled-task",
    stalled?: Stalled,
    manual = false,
  ): Promise<void> {
    await this.sendNudge(sessionID, reason, stalled, 1, manual)
  }

  private async sendNudge(
    sessionID: string,
    reason: "open-todos" | "stalled-task",
    stalled: Stalled | undefined,
    attempt: number,
    manual = false,
  ): Promise<void> {
    if (this.disposed) return
    const st = this.registry.get(sessionID)
    if (!st || st.sending) return

    // Re-validate at send time: an evaluation or a retry can be in flight while
    // the session becomes busy, disabled, paused or blocked (§12 busy-state fix).
    const options = this.deps.options
    if (!options.enabled || (st.paused && st.pauseReason === "disabled")) {
      this.debugSkip(sessionID, "nudge aborted (disabled)")
      return
    }
    if (!manual) {
      if (st.paused) {
        this.debugSkip(sessionID, `nudge aborted (paused (${st.pauseReason ?? "paused"}))`)
        return
      }
      if (st.blocked.size > 0 || st.status === "requires_action") {
        this.debugSkip(sessionID, "nudge aborted (blocked)")
        return
      }
      if (st.status === "running") {
        this.debugSkip(sessionID, "nudge aborted (running)")
        return
      }
      const threshold = reason === "stalled-task" ? options.stallMinutes * 60_000 : options.settleMs
      const quiet = this.quietMs(st)
      if (quiet < threshold) {
        this.debugSkip(sessionID, `nudge aborted (quiet ${quiet}ms < ${threshold}ms)`)
        return
      }
    }

    // Retries and manual nudges must also render the latest list (§12 stale-cache fix).
    try {
      await this.deps.store.refreshTodos(sessionID)
    } catch (err) {
      this.log(`refresh failed (${sessionID}): ${String(err)}`)
    }
    const sources = await this.collectSources(sessionID)
    if (!sources.supervised || sources.open === 0) return

    // A newer plugin generation owns this session — stay silent.
    if (!(await this.ownsSession(sessionID))) {
      this.log(`nudge skipped (${sessionID} ${reason}) — newer supervisor owns the session`)
      return
    }

    const hash = hashSources(sources)
    if (hash === st.lastNudgedHash) {
      st.noProgress += 1
      if (st.noProgress >= this.deps.options.maxNoProgressNudges) {
        st.paused = true
        st.pauseReason = "no-progress"
        this.log(
          `pause ${sessionID}: ${st.noProgress} nudges with no list change — backing off until the list changes`,
        )
        return
      }
    } else {
      st.noProgress = 0
    }

    const text = this.renderNudge(reason, st.nudges + 1, sources, stalled)
    st.sending = true
    try {
      await this.deps.synthetic({
        sessionID,
        text,
        description: "todo-supervisor",
        metadata: { source: "todo-supervisor", reason },
      })
    } catch (err) {
      st.sending = false
      const attempts = this.deps.retry?.attempts ?? RETRY_ATTEMPTS
      const delayMs = this.deps.retry?.delayMs ?? RETRY_MS
      if (attempt < attempts) {
        this.log(`nudge busy (${sessionID} ${reason}) — retry ${attempt}/${attempts} in ${delayMs / 1000}s: ${String(err)}`)
        if (st.retryTimer) clearTimeout(st.retryTimer)
        st.retryTimer = setTimeout(() => {
          st.retryTimer = undefined
          void this.sendNudge(sessionID, reason, stalled, attempt + 1, manual).catch((e) =>
            this.log(`nudge retry failed (${sessionID}): ${String(e)}`),
          )
        }, delayMs)
      } else {
        this.log(`nudge dropped (${sessionID} ${reason}) after ${attempts} attempts: ${String(err)}`)
      }
      return
    }
    st.sending = false

    st.nudges += 1
    st.lastNudgedHash = hash
    st.nextEligibleAt = Date.now() + this.deps.options.minNudgeIntervalMs
    this.log(`nudged ${sessionID} (${reason}) #${st.nudges} noProgress=${st.noProgress}`)
    this.deps.emitRpcEvent?.("nudged", { sessionID, reason })
  }
}
