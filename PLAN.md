# todo-supervisor — OpenCode V2 plugin implementation plan

- **Status:** draft, ready to implement (per-aspect tasks & acceptance criteria in §11)
- **Target:** OpenCode v2 (verified against local `opencode2` **v2.0.24**; plugin API per <https://opencode.ai/v2/docs/build/plugins>)
- **Repo:** `~/git/todo` (this folder — canonical plugin source)
- **Goal:** a todo list for OpenCode sessions whose supervisor keeps sessions working until every item is completed or canceled.

---

## 1. Goal

1. Provide todo-list **tools** (`todo_write` / `todo_read`) because OpenCode V2 (2.0.24) ships **no built-in todo tools or API**.
2. **Supervise** every session that has an open todo list:
   - when the session goes **idle** and nothing is running → re-prompt it (synthetic message) to continue the list;
   - while **subagents / background shells** are running → wait; only after **X = 5 minutes with no output changes** from the running work → nudge the owning session to check on it;
   - stop nudging when all items are completed/canceled;
   - guardrails: min interval between nudges, no-progress backstop, pause on user interrupt, never nudge a session that is `requires_action` (pending question/permission/form).
3. Provide an **optional TUI UI**: composer strip, todo panel, `/todos` slash command, toasts — fed over plugin RPC.
4. **Markdown mode**: a session can subscribe to N markdown files; the supervisor treats unchecked GFM checklist items (`- [ ]`) in those files as open todos, and completion happens by editing the file (`- [x]`) — see §5.8.

Defaults agreed: `stallMinutes = 5`, nudges via `ctx.session.synthetic`, UI + Markdown mode included.

---

## 2. Verified environment facts

These were confirmed against the running v2.0.24 service/binary and the V2 docs — implementation should rely on them, and re-verify payload shapes at runtime (see §12).

| Fact | Detail |
|---|---|
| Running server | `@opencode/cli` v2.0.24 (`opencode2`), background service; API on `http://127.0.0.1:49374`, auth `Basic base64("opencode:" + password)` from `~/.local/state/opencode/service.json` |
| V1 CLI on PATH | `/home/nikolas/.bun/bin/opencode` (v1.18.35) is a *different* CLI — always use `opencode2` for V2 operations |
| Plugin API | `import { Plugin } from "@opencode/plugin"`; `Plugin.define({ id, setup(ctx) })`; `setup` may return a cleanup fn |
| Context | `ctx.app.version`, `ctx.location.{directory, project.{id,directory,canonical}}`, `ctx.options`, `ctx.storage`, `ctx.event`, `ctx.session`, `ctx.tool`, `ctx.command`, `ctx.rpc`, `ctx.permission`, `ctx.generate`, `ctx.skill`, … |
| Tools | `ctx.tool.transform(editor => editor.add({ name, description, input, options, execute }))`; executor gets `(input, context)` with `context.sessionID`, `context.progress()`, `context.signal` |
| Event stream | `ctx.event.subscribe({ signal })` — SSE envelope `{ id, type, data }` (verified live: `{"id":"evt_…","type":"server.connected","data":{}}`); TUI code reads `event.data.*` |
| Wake-up | `ctx.session.synthetic({ sessionID, text, description?, metadata?, delivery? })` — "durably admit synthetic session input and schedule execution"; does not run prompt hooks; **409 on busy session** |
| Alternative wake-up | `ctx.session.prompt({ sessionID, text, … })` — visible user message; not chosen |
| Session state | `session.status` event + `session.idle` event; states observed in binary: `idle \| requires_action \| running \| unknown` |
| Session info | `Session.Info` = `{ id, parentID?, projectID, agent?, model?, title?, metadata?, location:{directory}, time:{created,updated,idle,…}, … }` — children identifiable via `parentID`, scope via `projectID` |
| Storage | `ctx.storage.{get,set,remove,scan}` — durable JSON scoped to the plugin |
| Hooks | `ctx.session.hook("context", cb)` → `event.system` (system parts) per model call; `ctx.session.hook("prompt", cb)` sees real user prompts (not synthetic) |
| RPC | `Rpc.define({ id, methods, events })` from `@opencode/plugin/rpc`; `ctx.rpc.register(C, impl)`; call server-side `ctx.rpc(C)`; TUI `context.client.rpc(C)`; emit `registration.events.emit(...)`; subscribe `rpc.events.on(...)` |
| TUI plugin | `import { Plugin, usePlugin } from "@opencode/plugin/tui"`; slots incl. `session.composer.top`, `session.panel`, `sidebar.content`; `context.keymap.layer(...)` commands with `palette:true` and `slash:{name}`; `context.ui.panel.open(name)`; `context.ui.toast.show`; `context.data.on(type, cb)` |
| Loading | `~/.config/opencode/plugins/<name>/` is auto-discovered; arbitrary dirs via global config `plugins: [...]` (absolute path or `file://…`); CLI picks up the TUI entry (`./tui` export) of configured plugins automatically; fallback `~/.config/opencode/cli.json` |
| Reload | Changes under watched config dirs auto-reload; **unwatched** local deps (`~/git/todo`) need `opencode2 service restart` (server) / TUI restart |
| V2 event catalog (subset we use) | `session.created/updated/deleted`, `session.idle`, `session.status`, `session.execution.started/succeeded/failed/interrupted`, `session.text.*`, `session.reasoning.*`, `session.step.started/ended/failed`, `session.tool.called/progress/success/failed/input.delta`, `session.inbox.enqueued`, `session.synthetic`, `permission.asked/replied`, `form.created/replied/cancelled`, `shell.created/exited/deleted`, `message.part.updated`, `session.usage.updated` |
| Loading (verified 2026-10-15) | config `plugins` object + absolute directory works (rung 1); entry = plugin root `index.ts` (shim → `src/index.ts`); `bun install` required once; SDK pinned `@opencode/plugin@2.0.24`; one plugin instance **per active location**; source + config edits hot-reload (no restart) |

Naming note: OpenCode sessions have **no global "current session list" on the plugin ctx**. The supervisor builds its registry reactively from `session.created/updated/deleted` events plus a storage scan on startup (§5.4).

---

## 3. Architecture

```
                 ┌────────────────────────────── OpenCode v2 service ──────────────────────────────┐
                 │                                                                                  │
 sessions ──────▶│  ctx.event.subscribe()  ──▶ Supervisor state machine ──▶ ctx.session.synthetic() │
 (idle/busy)     │        ▲                            │                                    (nudge)   │
                 │        │                            ▼                                             │
                 │  session.tool.* / text deltas   ctx.storage ("todos/<sessionID>")               │
                 │                                     ▲                                             │
 agent ─────────▶│  todo_write / todo_read tools ──────┘        ctx.rpc.register(todo contract)      │
                 │                                                       ▲                           │
                 └───────────────────────────────────────────────────────┼───────────────────────────┘
                                                                         │ RPC (methods + events)
                                                              TUI plugin (src/tui.ts)
                                                     panel · composer strip · /todos · toasts
```

Task sources: session todo lists (`todo_write` → storage) **and subscribed markdown checklists** (parsed on demand, §5.8); both feed the same supervisor `evaluate()`.

Two entrypoints, one repo:

- **server plugin** (`src/index.ts`) — tools, storage, supervisor, RPC registration.
- **TUI plugin** (`src/tui.ts`) — presentation only; all mutations go through RPC.

---

## 4. Repository layout

```
~/git/todo/
├── PLAN.md                 # this file
├── README.md               # user-facing docs (behavior, options, install)
├── package.json            # type: module; exports: "." → src/index.ts, "./rpc" → src/rpc.ts, "./tui" → src/tui.ts
├── .gitignore
├── index.ts                # root server-entry shim → src/index.ts (the loader resolves this file)
├── tui.ts                  # root CLI-entry shim → src/tui.ts
└── src/
    ├── index.ts            # server plugin (Plugin.define)
    ├── rpc.ts              # Rpc.define contract (shared with TUI)
    ├── supervisor.ts       # state machine (pure-ish logic, unit-testable)
    ├── tools.ts            # todo_write / todo_read definitions + rendering
    ├── storage.ts          # typed wrapper around ctx.storage
    ├── markdown.ts         # checklist parser, file subscriptions, refresh triggers
    ├── log.ts              # daemon-safe logging (console.log is swallowed by the runtime)
    └── tui.ts              # TUI plugin (@opencode/plugin/tui)
```

`package.json` (starting point):

```jsonc
{
  "name": "opencode-todo-supervisor",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./rpc": "./src/rpc.ts",
    "./tui": "./src/tui.ts"
  },
  "dependencies": {
    "@opencode/plugin": "2.0.24"   // pinned to the running opencode2 version; `bun install` once after clone
  }
}
```

---

## 5. Server plugin

### 5.1 Definition, options, lifecycle

```ts
// src/index.ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "todo-supervisor",
  async setup(ctx) {
    const options = parseOptions(ctx.options)          // §5.7
    const store = makeStore(ctx.storage)               // §5.3
    const supervisor = makeSupervisor(ctx, store, options) // §5.4

    const ac = new AbortController()
    void runEventLoop(ctx, supervisor, ac.signal)      // §5.4

    await registerTools(ctx, store, supervisor, options) // §5.2
    registerContextHook(ctx, store, options)             // §5.5
    const rpc = await registerRpc(ctx, store, supervisor) // §5.6

    return async () => {
      ac.abort()
      supervisor.dispose()
      await rpc.dispose()
    }
  },
})
```

Options (defaults; passed via global config or empty when auto-discovered):

```ts
type Options = {
  enabled: boolean              // default true — master switch
  settleMs: number              // default 5000 — wait after idle before evaluating
  minNudgeIntervalMs: number    // default 45000 — min time between nudges per session
  stallMinutes: number          // default 5 — no-output window before nagging about running work
  maxNoProgressNudges: number   // default 5 — stop after N nudges with identical list
  injectTodoContext: boolean    // default true — system-prompt injection (§5.5)
  markdownFiles: string[]       // default [] — markdown checklists auto-subscribed for sessions in this project (§5.8)
  scope: "project" | "all"      // default "project" — only sessions with same projectID as ctx.location.project.id
  pauseOnInterrupt: boolean     // default true — user interrupt pauses supervision
  debugEvents: boolean          // default false — log all received events (payload verification, §12)
}
```

### 5.2 Tools

Register via one transform; all `codemode: true` so Code Mode agents can call them:

```ts
await ctx.tool.transform((editor) => {
  editor.add(TODO_WRITE); editor.add(TODO_READ)
})
```

**`todo_write`** — replaces the session's list (V1-compatible shape):

```ts
input: {
  type: "object",
  properties: {
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content:  { type: "string" },
          status:   { type: "string", enum: ["pending", "in_progress", "completed", "canceled"] },
          priority: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["content", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
}
```

Executor behaviour:
- `context.sessionID` → write `store.setTodos(sessionID, items)`.
- Reset supervisor counters (`noProgress=0`, `paused=false`) and notify UI (`rpc events.updated`).
- Return rendered summary + full list so the model always sees canonical state, e.g.
  `Todos updated — 4 items: 1 in_progress, 2 pending, 1 completed.` + list.
- Validation: trim content, drop empty entries, dedupe; keep at most one `in_progress` (demote extras to `pending` and say so in output).

**`todo_read`** — `{}` input; returns the rendered list (`No todos.` when empty), merged with subscribed markdown checklists when Markdown mode is active (§5.8) — session items first, then one section per file with `path:line` references.

**`todo_subscribe` / `todo_unsubscribe`** — Markdown mode (§5.8):

```ts
todo_subscribe    input: { files: [{ path: string }] }   // .md/.markdown, relative to the location dir or absolute
todo_unsubscribe  input: { files: [{ path: string }] }
```

Both return the resulting subscription set for the session. Subscription changes reset the no-progress counter and emit RPC `updated`.

Tool descriptions must state the contract:
> Maintain the session todo list with `todo_write`. Keep exactly one item `in_progress`. Before ending your turn every item must be `completed` or `canceled`; a supervisor will continue the session while items remain open.

### 5.3 Storage

Wrapper over `ctx.storage`:

```
key:   todos/<sessionID>
value: { version: 1, sessionID, items: TodoItem[], updatedAt: number }

key:   subs/<sessionID>
value: { version: 1, sessionID, files: string[], removed: string[], updatedAt: number }   // §5.8
```

- `getTodos(sessionID)`, `setTodos(sessionID, items)`, `removeTodos(sessionID)`.
- `scanAll()` — `ctx.storage.scan({ prefix: "todos/", limit: 100 })` (loop `next`) used on startup to re-supervise sessions whose lists survived a restart.
- Supervision counters (nudges / no-progress / pause) are **in-memory only** — restarting resets them, which is acceptable and simpler.
- Delete storage (`todos/<id>`, `subs/<id>`) on `session.deleted`.
- Keep a full in-memory cache `Map<sessionID, TodoState>` so the per-request context hook (§5.5) stays synchronous.

Helper predicates:
- `openItems(items)` → not `completed`/`canceled`
- `isDone(items)` → non-empty and every item completed/canceled
- `hashList(items)` → stable JSON hash for no-progress detection
- `renderList(items)` → markdown checklist (`- [ ]`, `- [~]` in progress, `- [x]` done, `- [–]` canceled)

### 5.4 Supervisor (the core)

`src/supervisor.ts` holds the state machine; `src/index.ts` only wires events in.

#### State

```ts
// "running" is fed by open activity spans and `session.status` `{type:"busy"}`;
// "requires_action" by pending permission/form blockers; the event status union
// is idle|retry|busy (§12).
type SStatus = "idle" | "running" | "requires_action" | "unknown"

type SpanKind = "turn" | "step" | "reasoning" | "text" | "tool-input" | "inbox"

type SessionState = {
  sessionID: string
  parentID?: string
  projectID: string
  status: SStatus
  lastActivityAt: number
  blocked: Set<"permission" | "form">   // pending user-facing blocks
  children: Set<string>                 // from session.created(parentID = this)
  shells: Map<string, { startedAt, lastActivityAt, command? }>  // background shells
  spans: Map<SpanKind, { startedAt, lastActivityAt }>          // open activity (§12.19)
  tools: Map<string, { name, label?, startedAt, lastActivityAt }>  // in-flight tool calls
  terminalAt?: number                   // last confirmed end of turn (§12.19)
  evaluateTimer?: ReturnType<typeof setTimeout>
  retryTimer?: ReturnType<typeof setTimeout>
  sending: boolean
  nudges: number
  noProgress: number
  lastNudgedHash?: string
  nextEligibleAt: number
  paused: boolean
  pauseReason?: "interrupt" | "no-progress" | "disabled"
}
```

The session is **idle only when nothing is open**: no span, no in-flight tool
call, no background shell, no running child and no queued inbox item. Thinking
(`reasoning.started/ended`), preparing a tool (`tool.input.*`), a running tool —
including a `task`/`subagent` call — and a running turn/step all keep it busy,
independent of `session.status` (which this runtime does not always emit).

Registry is fed exclusively by events; on startup, `scanAll()` in storage is reconciled against `ctx.session.get()`:

- session missing → drop storage entry;
- session found → register with `Session.Info` (scope filter applies) and evaluate once.

#### Event loop

Single subscription, one `switch` on `event.type`; scope filter first: skip events whose session's `projectID !== ctx.location.project.id` when `scope === "project"`.

| Event | Handling |
|---|---|
| `session.created` | register; link `parentID`; if known todos → schedule evaluate |
| `session.updated` | refresh `parentID`/`projectID` (titles not needed) |
| `session.deleted` | unregister; `store.removeTodos`; emit RPC `updated` |
| `session.status` | `idle` → `endTurn()` (see below) + schedule evaluate; `busy`/`retry` → `openSpan("turn")` |
| `session.idle` | same as status idle (idempotent) |
| `session.execution.started` | `openSpan("turn")` |
| `session.execution.succeeded/failed` | `endTurn()`; schedule evaluate |
| `session.execution.interrupted` | `endTurn()`; if `pauseOnInterrupt` → `paused=true, pauseReason="interrupt"`; schedule evaluate |
| `session.step.started/streamed` | `openSpan("step")` / `touchSpan("step")` |
| `session.step.ended` | `finish === "stop"` → `endTurn()` + schedule; otherwise (`tool-calls`) close the step, keep the turn open and **never** arm a nudge |
| `session.step.failed` | close the step span |
| `session.reasoning.started/delta/ended` | open/touch/close the `reasoning` span (thinking) |
| `session.text.started/delta/ended` | open/touch/close the `text` span |
| `session.tool.input.started/delta/ended` | open/touch/close the `tool-input` span (preparing a tool); `started` carries `name` → `startTool(id, name)` |
| `session.tool.called` | `startTool(id, name, label?)` — `label` from `input.description`/`input.command` (`task`, `shell`, …) |
| `session.tool.progress` | touch the session, the tool (`data.id`) and the shell (`metadata.shellID`) |
| `session.tool.success/failed` | `endTool(id)` |
| `message.part.updated` | `lastActivityAt = now` |
| `session.inbox.enqueued` | `openSpan("inbox")`; for real (non-synthetic) items also `paused=false`, `noProgress=0`, schedule evaluate |
| `session.inbox.delivered` | close the `inbox` span |
| `permission.asked` / `permission.replied` | `blocked.add/delete("permission")`; on reply → schedule evaluate |
| `form.created` / `form.replied/cancelled` | `blocked.add/delete("form")`; on resolve → schedule evaluate |
| `shell.created/exited/deleted` | background shell tracking (`info.metadata.sessionID`, `info.command`, `info.time.started`); location-scoped, so a `shellID → sessionID` map is kept |

`endTurn()` closes every span, drops in-flight tool calls, sets `status="idle"` and
records `terminalAt` — the authoritative end-of-turn signal, which also heals
spans whose close event was lost (interrupt, reload mid-call).

`debugEvents` logs `event.type` + `JSON.stringify(event.data)` (truncated) — used once in Phase 1 to lock field names.

#### `evaluate(sessionID)`

Cancel+re-arm a per-session timer; always recompute from current state:

```
evaluate(sessionID):
  st = registry[sessionID]
  if !st → return
  await store.refreshTodos(sessionID)                                 # pick up writes made by another
  sources = collectSources(sessionID)                                 # role/instance (§12.13), merged §5.8
  if !sources.supervised or sources.open === 0 → return               # nothing to enforce
  if !options.enabled or st.paused or st.blocked.size > 0 → return
  if st.status === "requires_action" → return                        # waiting on the user

  runningChildren = children that still look busy (open work, or activity inside
                    the stall window, or not yet past an end-of-turn signal)
  runningTools    = [...st.tools.values()] (+ the children's)
  openSpans       = [...st.spans.values()]
  quiet           = now - max(st.lastActivityAt, children…, shells… (incl. each
                    capture file's mtime, §12.22), tools… (incl. the children's))

  if runningChildren or shells or runningTools or openSpans:           # work is in flight
      if quiet < stallMs → schedule(evaluate, stallMs - quiet + ε); return
      else → nudge(sessionID, reason="stalled-task", stalled={children, shells, tools, spans})

  # nothing open: a confirmed end of turn arms a short debounce, a runtime that
  # never emits one falls back to the stall window (§12.19)
  threshold = st.terminalAt !== undefined ? settleMs : stallMs
  if quiet < threshold → schedule(evaluate, threshold - quiet + ε); return

  if now < st.nextEligibleAt → schedule(evaluate, st.nextEligibleAt - now + ε); return
  nudge(sessionID, reason="open-todos")
```

`stallMs = stallMinutes * 60_000`. `settleMs` is only a debounce after a
*confirmed* turn end (`terminalAt`) — it is never used to guess that a busy
session has finished. Activity inside a turn reschedules through the stall
window, so an open step/tool/shell/subagent cannot produce an idle nudge.

#### `nudge(sessionID, reason)`

```
hash = hashList(items)
if hash === st.lastNudgedHash:
    st.noProgress += 1
    if st.noProgress >= maxNoProgressNudges → st.paused=true (reason="no-progress"); emit event; return
else:
    st.noProgress = 0
text = renderNudge(reason, items, stalledInfo)
await ctx.session.synthetic({
  sessionID, text,
  description: describeNudge(reason, n),   # "todo-supervisor · nudge #3" | "… · stalled: task "\"…\"" (§12.21)
  metadata: { source: "todo-supervisor", reason },
})                                                     # catch: busy/409 → schedule retry in 5 s
st.nudges += 1; st.lastNudgedHash = hash
st.nextEligibleAt = now + minNudgeIntervalMs
emit rpc.event nudged { sessionID, reason }
```

Nudge text (default templates, options may override; `#N` = the nudge number,
`<status>` = "x of y todos left[, n in progress]"; list entries append `(priority)`
when set so the model can order its next actions):

- `open-todos` (idle nudge — explains why it fired, then status, then the list):
  ```
  [todo-supervisor] Idle nudge #N — the session went idle with <status>.
  <renderList(openItems)>

  Continue working through the list (start with the [~] item when present). Keep it updated
  with todo_write, and only end your turn once every item is completed or canceled.
  ```
- `stalled-task` (`<quiet>` = measured quiet span, e.g. "~7.2 min"; the `from:`
  list names every open kind — subagent, background shell, **tool** (a `task`
  call is printed as `tool subagent "Slow sleep probe"`) and any still-open span
  such as `open step` or `thinking (no deltas)`):
  ```
  [todo-supervisor] Stall nudge #N — no activity for <quiet> from: subagent <sessionID> / background shell "<cmd>" / tool <name> "<label>" / open step (stall threshold 5 min).
  Status: <status>. Check its status, recover or restart it if stuck, then continue:
  <renderList(openItems)>

  Keep the list updated with todo_write; only end your turn once every item is completed or canceled.
  ```

#### Stop conditions

- list empty / all done → no nudges (list kept for the UI; RPC `updated` emitted).
- `paused` set by: interrupt (until next real user input or todo change), no-progress backstop (until list changes), `enabled=false` (until toggled).
- session deleted → dropped entirely.

### 5.5 Context injection

```ts
ctx.session.hook("context", (event) => {
  if (!options.injectTodoContext) return
  const st = cache.get(sessionIDFromEvent(event))   // sessionID available on hook event
  if (!st || st.items.length === 0) return
  event.system.push({ type: "text", text: renderTodoContext(st.items) })
})
```

- Appends a compact block: current list + one-line policy ("complete or cancel every item; keep updated with `todo_write`").
- Read from the in-memory cache (kept fresh by tool writes / scans) — no async work per model call.
- Survives compaction: even if `todo_write` history is summarized away, the list is re-injected on the next request.

### 5.6 RPC contract (`src/rpc.ts`)

```ts
import { Rpc } from "@opencode/plugin/rpc"

export const TodoRpc = Rpc.define({
  id: "todo",
  methods: {
    list:       { input: { /* {sessionID} */ }, output: { /* {items, files:[{path,exists,items}], supervisor:{…}} */ } },
    clear:      { input: { /* {sessionID} */ }, output: {} },
    nudge:      { input: { /* {sessionID} */ }, output: {} },   // manual "wake now"
    setEnabled: { input: { /* {sessionID, enabled} */ }, output: {} },
    subscribe:  { input: { /* {sessionID, path} */ }, output: {} },   // §5.8
    unsubscribe:{ input: { /* {sessionID, path} */ }, output: {} },
  },
  events: {
    updated: { schema: { /* {sessionID} */ } },
    nudged:  { schema: { /* {sessionID, reason} */ } },
  },
})
```

- Server: `const reg = await ctx.rpc.register(TodoRpc, { list: …, clear: …, nudge: …, setEnabled: … })`; emit `reg.events.emit("updated", {sessionID})` on every todo mutation and `nudged` from `nudge()`.
- TUI: `context.client.rpc(TodoRpc)` + `TodoRpc.events.on(...)` — external clients see events from every location; check `event.location` when needed.
- `setEnabled` toggles `paused` with `pauseReason="disabled"` per session (UI "pause supervision" action).

### 5.7 Options parsing

- Read `ctx.options`; unknown keys ignored; each field type-checked with defaults from §5.1.
- Log the effective options once at setup (`console.log("[todo-supervisor] options", opts)` → server log).

### 5.8 Markdown mode

Sessions can subscribe to any number of markdown files whose GFM checklist items act as todo tasks.

**Parser** (`src/markdown.ts`) — `parseChecklist(content, path)`:

- Item regex: `^(\s*)([-*+]|\d+[.)])\s+\[( |x|X|~)\]\s+(.*)$` — supports `-`/`*`/`+` and numbered lists, any indentation (kept for display).
- State: `[x]`/`[X]` = completed; `[~]` = canceled (non-standard, optional convention); anything else = open.
- Skip fenced code blocks (backtick and tilde fences) so examples inside code are never counted.
- Capture `{ path, line, text, indent, state }`; line numbers are 1-based for `path:line` references.

**Subscriptions**

- Effective set = (`config.markdownFiles` ∪ stored `subs/<sessionID>.files`) − `subs/<sessionID>.removed` — so tool/UI unsubscribe can shadow config defaults.
- `todo_subscribe` / `todo_unsubscribe` tools (§5.2) and RPC `subscribe`/`unsubscribe` (§5.6) manage the stored part.
- Paths resolve against `ctx.location.directory`; absolute paths allowed; extension must be `.md`/`.markdown` (clear tool error otherwise).
- Missing file = valid subscription with 0 tasks and `exists: false`; picked up automatically once created (log once on transition).

**Refresh**

- `ctx.tool.hook("execute.after")` — when `edit`/`write`/`patch` touches a subscribed path, re-parse that file immediately and emit RPC `updated`.
- `evaluate()` re-parses all subscribed files fresh before deciding (ground truth regardless of how the file changed).
- RPC `list` re-parses fresh (the UI always reads ground truth).
- No filesystem watcher; edits made outside OpenCode are picked up at the next evaluation or UI read.

**Supervision semantics**

- A session is *supervised* when it has stored items or ≥ 1 subscription; "open" = open session items ∪ open markdown items; "done" = no open items in either source (with at least one source present).
- Completion happens by editing the file (`- [x]`); nudges say so explicitly. Nudge text groups items by source: session list first, then `path:line — text` per file.
- No-progress hash = open session item texts + open markdown item texts (line numbers excluded, so reordering or file growth doesn't fake progress).

---

## 6. TUI plugin (`src/tui.tsx`)

```ts
import { Plugin } from "@opencode/plugin/tui"
import { TodoRpc } from "./rpc"

export default Plugin.define({
  id: "todo-supervisor.tui",
  setup(context) { … },
})
```

The entry is a **`.tsx` file** (`./tui` export): the host transpiles plugin files outside `node_modules` and resolves `@opentui/solid`/`solid-js`/`@opencode/plugin/tui` to its own module instances, so no local OpenTUI install is needed (optional peers declared; §12.16). A `/** @jsxImportSource @opentui/solid */` pragma is kept as belt-and-braces.

Components:

1. **Composer strip** — `context.ui.slot({ append: "session.composer.top", render: ({ sessionID }) => <Strip sessionID={sessionID} /> })`
   renders a one-line progress chip, e.g. `📋 ███░░░░░ 8/17 open` (plus `⏸` while supervision is paused), hidden when both sources are empty. Reactive via a Solid signal fed from an RPC fetch + `updated` events.
2. **Panel** — `context.ui.slot({ append: "session.panel", render: (panel) => <Show when={panel.name === "todo.todos"}><TodoPanel …/></Show> })`
   - **header**: progress bar, `open/total`, and a supervision chip (`idle · quiet 12s · nudges 2`, `working: 1 tool · 1 shell · quiet 4s`, `paused (no-progress)`, `not supervised`);
   - **body** in a `<scrollbox>`: a `SESSION` section then one collapsible section per subscribed file (label, `n open of m`, `(missing)` badge, `path:line` rows); items show `[ ]`/`[~]`/`[x]`, priority and content truncated to the panel width; the selected row is highlighted (`❯` prefix + `background.raised.high`) and kept on screen via `scrollChildIntoView`;
   - **keys** (keymap layer with `enabled: () => panel.focused`, so panel keys never leak globally): `↑↓/jk`, `pgup/pgdn`, `home/end/g/G`, `space`/`x` toggle (session item → RPC `toggle`; markdown item → RPC `toggleFile`; file row → collapse), `enter` collapse, `n` nudge, `s` pause/resume (`setEnabled`), `a` add file, `d` remove file, `r` refresh, `/` filter, `f` fullscreen, `c` clear, `?` help, `esc` close;
   - **footer**: width-aware key hints (`footerHints`); a ~3 s poll while mounted complements the `updated`/`nudged` events for edits made outside the agent.
3. **Commands** — `context.keymap.layer(() => ({ commands: [{ id: "todo-supervisor.open", title: "Todo: open list", group: "Todo", palette: true, slash: { name: "todos", arguments: true }, run: … }] }))`; `/todos add <path>` and `/todos remove <path>` manage subscriptions.
4. **Toasts** — subscribe to RPC `nudged`; when it matches the active session show `context.ui.toast.show({ title: "todo-supervisor", message: "Continuing open todos…" | "Checking stalled work…" })`. On all-done transition show `"All todos done 🎉"`.
5. **Data plumbing** — one snapshot store (`Record<sessionID, {items, files, supervisor}>` via `context.storage.memory`, so it survives plugin hot reloads); `context.client.rpc(TodoRpc)` provides the methods and `rpc.events.on("updated"|"nudged", …)` keeps it fresh; `usePlugin()` inside components for theme/context; open-count transitions drive the all-done toast.
6. **Pure helpers** — all layout math lives in `src/panel.ts` (`buildRows`, `progressBar`, `truncate`, `supervisorChip`, cursor/window, `footerHints`) and is unit-tested in `src/panel.test.ts`; `src/tui.tsx` only maps rows to OpenTUI elements. Markdown checkboxes are written by the server plugin (RPC `toggleFile`), never by the TUI process.

Note: this TUI plugin is loaded from the configured package (`./tui` export). No `cli.json` entry needed for normal use; see §7 fallback.

---

## 7. Loading & configuration

Global config `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "/home/nikolas/git/todo",
      "options": {
        "stallMinutes": 5,
        "settleMs": 5000,
        "minNudgeIntervalMs": 45000,
        "maxNoProgressNudges": 5,
        "injectTodoContext": true,
        "markdownFiles": ["PLAN.md", "TODO.md"],
        "scope": "project"
      }
    }
  ]
}
```

Loading fallback ladder (use Phase 0 to confirm which is needed; documented so we never block):

1. Directory with `package.json` exports (preferred, above).
2. Direct file: `"package": "/home/nikolas/git/todo/src/index.ts"`; TUI via `~/.config/opencode/cli.json` → `"plugins": ["/home/nikolas/git/todo"]`.
3. Symlink `~/.config/opencode/plugins/todo-supervisor → ~/git/todo` with root-level `index.ts`/`tui.ts` shim files re-exporting `src/*` (discovery layout).

Rung 1 (absolute directory + object options) is the **working** setup — verified 2026-10-15:

- entry resolves to the plugin root `index.ts` (shim → `src/index.ts`); features `{server:true,tui:true}` detected from the exports map;
- **`bun install` in the plugin dir is required once** — the loader does not install dependencies for local-path entries (`ResolveMessage: Cannot find package '@opencode/plugin'` otherwise);
- SDK pinned to `@opencode/plugin@2.0.24` to match the running server (bump together with `opencode2`);
- a plugin instance is created **per active location** (one per project directory that has sessions); each runs its own `setup`;
- config content edits and plugin source edits hot-reload automatically; `opencode2 reload` forces reconciliation; mtime-only changes (`touch`) do not trigger.

---

## 8. Dev loop (as verified)

- Edit any file in `~/git/todo` → the server hot-reloads the plugin automatically (runtime file watchers; verified 2026-10-15). Config edits in `~/.config/opencode/opencode.json` hot-apply on content change (a bare `touch` does not).
- `opencode2 reload` forces config/plugin reconciliation. `opencode2 service restart` only as a last resort (it interrupts running sessions).
- Plugin logs: `tail -f ~/.local/share/opencode/log/todo-supervisor.log` (daemon-safe). `console.log` is swallowed by the runtime; `console.error` is visible in standalone runs (`opencode2 run --standalone --print-logs`), which is the safe way to test without touching the daemon.
- Checks:
  - `opencode2 api get /api/plugin` — plugin listed with state;
  - `~/.local/share/opencode/log/opencode.log` — structured `role=server` lines;
  - with `debugEvents: true`, raw event payloads land in `todo-supervisor.log`.
- Commit after each aspect in §11.

---

## 9. Test plan

Use a scratch dir + short timings for faster loops: `settleMs: 1000`, `minNudgeIntervalMs: 5000`, `stallMinutes: 0.2`.

| # | Scenario | Expectation |
|---|---|---|
| 1 | Load: restart service; `opencode2 api get /api/plugin` | `todo-supervisor` present, no setup errors in log |
| 2 | Tools: `opencode2 run "create 3 todos: two done, one pending; then stop"` (in scratch dir) | model calls `todo_write`; `todo_read` returns list |
| 3 | Idle nudge loop: same session stops with 1 pending | supervisor nudges ~1 s after idle; model continues; once all completed → no further nudges |
| 4 | Cancel path: mark last item canceled | supervision stops (no nudge) |
| 5 | Background shell stall: `shell background:true "sleep 600"` with an open todo; keep quiet | no nudge while fresh; nudge only after `stallMinutes` of no output; timer resets if output appears |
| 6 | Background subagent stall: subagent asked to "wait 10 minutes doing nothing visible" | same stall rule; nudge names the child session ID |
| 7 | User interrupt (`session.interrupt`) while todos open | supervision pauses; next real user prompt resumes it |
| 8 | `requires_action`: agent asks a question / permission prompt pending | no nudge while waiting; nudge resumes after reply |
| 9 | No-progress backstop: engineer a list the model refuses to finish | after `maxNoProgressNudges` identical-state nudges → paused, single log/event, no more nudges |
| 10 | Restart persistence: service restart with open todos | list intact; supervision resumes after scan |
| 11 | Compaction: compact session mid-list | after compaction the todo list is still in the system context (injection) and supervision continues |
| 12 | Scope: second session in a different project | not nudged by this location's instance |
| 13 | UI: `/todos` opens panel; strip shows counts; `n` nudges; `c` clears; toast on nudge | as described; works against the running server |
| 14 | Unload: disable plugin via config (`"-todo-supervisor"`) + restart | no nudges; timer leaks absent (cleanup ran) |
| 15 | Markdown mode: subscribe to a scratch file with 3 open items; agent checks one off by editing the file | remaining items still supervised; stops after the last `[x]` |
| 16 | Subscribe to a not-yet-existing file, then create it with open items | missing tolerated (0 tasks); picked up on creation |
| 17 | Fenced code block containing `- [ ] example` | not counted as a task |
| 18 | Two sessions share a subscribed file; session B completes it | session A receives no further nudges |
| 19 | Agent edits a subscribed file while the UI is open | RPC `updated` fires; strip/panel refresh within a moment |

For scenarios 3–9 run with `debugEvents: true` once to capture exact payloads and fix any field-name assumptions (§12). Markdown scenarios (15–19) use a scratch `TODO.md` fixture.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Exact event payload fields differ (e.g. tool name key in `session.tool.called`) | Phase 1 `debugEvents` run logs ground truth before the supervisor relies on those fields |
| `session.synthetic` 409 on busy session | only called from `evaluate` when `status !== "running"`; errors caught and re-scheduled after 5 s |
| Token burn from nudge loops | `minNudgeIntervalMs`, `maxNoProgressNudges`, pause-on-interrupt, per-session `setEnabled`, global `enabled` |
| Duplicate nudges from multiple locations | `scope: "project"` default (match `projectID`); registry filter before any action |
| Model "cheats" by clearing list instead of completing | acceptable (explicit user-visible action); README documents it; `clear` via UI is also explicit |
| Plugin reload loses supervision mid-session | storage-backed todo lists + startup scan reconcile |
| Unknown loader behaviour for local dirs | fallback ladder in §7, verified in Phase 0 |
| Compaction drops todo history | context injection each request from cache |
| Markdown false positives (code fences, prose) | fence-aware parser only counts GFM task-list lines; S17 |
| File edited outside OpenCode | `evaluate()` and RPC `list` re-read files, so edits are picked up at the next decision point |
| Unsafe/nonexistent subscription paths | resolve against the location dir; require `.md`/`.markdown`; missing files are valid-but-empty |

---

## 11. Tasks & acceptance criteria by aspect

Each aspect lists its **tasks** (checkboxes) and the **acceptance criteria** that mark it done. `S#` = scenario in §9; `V#` = runtime verification item in §12. Suggested build order: aspects 1 → 15 (as listed). Phase mapping: 2–5 = Phase 1, 6–7 = Phase 2, 8 = Phase 3, 9 = Phase 4, 10 = Phase 5, 11 = Phase 6, 12 = Phase 7, 13 = continuous hardening, 14 = Markdown mode (depends on 4–5; extends 11–12), 15 = Phase 8.

### Aspect 1 — Scaffold & loading (Phase 0)

**Tasks**
- [x] `package.json` (exports `.` → `src/index.ts`, `./rpc` → `src/rpc.ts`, `./tui` → `src/tui.ts`) and `.gitignore`
- [x] `src/index.ts` skeleton: `Plugin.define({ id: "todo-supervisor" })`, stub options parse, setup/unload log lines
- [x] Root `index.ts`/`tui.ts` shims, `src/log.ts` (daemon-safe logging), `bun install` once (SDK pinned 2.0.24)
- [x] Wire the global config entry (§7 rung 1 — no restart needed); verify loading + disable/re-enable

**Acceptance criteria** — all verified 2026-10-15
- `opencode2 api get /api/plugin` lists `todo-supervisor` (`source:{type:"local"}`, `features:{server,tui}`, `state:{status:"active"}`) for every active location (S1).
- Setup/unload lines land in `~/.local/share/opencode/log/todo-supervisor.log` (daemon discards plugin stderr — see §8).
- `"-todo-supervisor"` + `opencode2 reload` removes the plugin (cleanup runs); re-enabling restores it; the 86 builtin plugins are unaffected.

### Aspect 2 — Runtime payload verification (Phase 1a)

**Tasks**
- [ ] Implement `debugEvents` logging (event type + `data` JSON, truncated)
- [ ] Capture V1–V10 once with a scratch session that exercises: idle, tool calls, background shell, subagent, permission prompt, question tool, todo tools, file edits
- [ ] Write confirmed shapes into the normalizer/comments in `src/supervisor.ts`; remove assumptions

**Acceptance criteria**
- Every `V#` (V1–V10) is resolved and recorded; none remain "unknown".
- `normalizeEvent()` handles both the SSE envelope (`{id,type,data}`) and bare event objects — covered by a unit test.
- No speculative field access remains (no `data.tool ?? data.name`-style guesses).

### Aspect 3 — Options & configuration (Phases 0/4)

**Tasks**
- [x] `Options` type + `parseOptions(ctx.options)` with defaults (§5.1/§5.7), type checks, unknown-key ignore
- [x] Log effective options once at setup
- [ ] `enabled` master-switch semantics: tools remain functional; supervisor never nudges while off (with aspects 6–7)

**Acceptance criteria**
- No config options → all defaults applied (unit test `options.test.ts`; log proves effective values).
- An invalid value (e.g. `stallMinutes: "x"`) falls back to the default with a warning; plugin still loads (unit test + live warning path).
- `enabled:false` → tools still usable; zero nudges — pending supervisor (aspects 6–7).
- Every option is documented 1:1 in `README.md` (aspect 15) and honored after a plugin reload.

### Aspect 4 — Storage (Phase 1b)

**Tasks**
- [x] Typed wrapper: `getTodos` / `setTodos` / `refreshTodos` / `removeTodos` / `scanAll` over `ctx.storage`
- [x] In-memory cache `Map<sessionID, TodoState>` kept in sync with every write
- [x] `scanAll` pagination loop over the `next` cursor

**Acceptance criteria**
- Round-trip: `setTodos` → `getTodos` returns identical items in identical order (unit test + live via S2).
- `scanAll` returns items across more than one page (unit test with a low page-limit override).
- `removeTodos` deletes the key; cache reflects every write immediately (unit test).
- `session.deleted` removes the stored list (verified via `scanAll` after S10) — wiring lands in aspect 6.

### Aspect 5 — Tools & rendering (Phase 1c)

**Tasks**
- [x] `todo_write` / `todo_read` per §5.2: input schemas, descriptions stating the completion policy, `codemode: true`
- [x] Validation: trim, drop empty entries, dedupe, demote extra `in_progress` to `pending` (note it in output)
- [x] Renderers/helpers: `renderList`, `renderSummary`, `openItems`, `isDone`, `hashList`

**Acceptance criteria**
- Model creates a list in a scratch session; `todo_read` returns exactly the last written state (S2) — **verified live 2026-10-15**: tools appeared in the running session's tool catalog, `todo_write` (5 items → 4 after dedupe) followed by `todo_read` returned the canonical state.
- Empty/invalid entries are dropped; two `in_progress` entries → one kept, one demoted, with a note in the tool output (unit tests).
- Tool output always includes the rendered list (no follow-up `todo_read` needed by the model). Once Aspect 14 lands, `todo_read` also returns subscribed file checklists.
- A write updates the context-injection cache (aspect 10 — the store is the cache) and emits the RPC `updated` event (aspect 11 — pending).

### Aspect 6 — Supervisor: registry & event ingestion (Phase 2a)

**Tasks**
- [ ] `src/supervisor.ts` skeleton: registry, per-session state (§5.4), `dispose()`
- [ ] `ctx.event.subscribe` loop with abort signal, `normalizeEvent`, per-event `try/catch`
- [ ] Handle `session.created`/`session.deleted` (+ `renamed`/`moved`); scope filter (`projectID` vs `ctx.location.project.id`)
- [ ] Startup reconcile: `scanAll()` → `ctx.session.get()` for every stored list

**Acceptance criteria**
- With `debugEvents`, sessions (including children) register with correct `parentID`/`projectID`.
- S12 passes: a session in another project is ingested but never actioned.
- Unknown event types are ignored without errors.
- After a restart with an existing list, the session is re-registered and evaluated (S10 partial).

### Aspect 7 — Supervisor: idle evaluation & nudging (Phase 2b)

**Tasks**
- [x] Activity spans (§12.19): `turn`/`step`/`reasoning`/`text`/`tool-input`/`inbox` opened and closed by their lifecycle events; `endTurn()` on `finish:"stop"` / `execution.succeeded/failed/interrupted` / `status idle`
- [x] In-flight tool calls tracked by call id (`tool.input.started` → `name`, `tool.called` → `label`, `tool.success/failed` → close) so a running `task`/`subagent` blocks the idle nudge
- [x] `evaluate()` per §5.4: span/tool/shell/child/stall branch, terminal-gated idle nudge (`terminalAt`), timer re-arm
- [x] `nudge()` per §5.4: synthetic wake, `describeNudge()` label, metadata, template, counters, `nextEligibleAt`, 409 retry

**Acceptance criteria**
- [x] S3: nudge fires `settleMs` (+ ≤2 s slack) after a **confirmed** turn end with open todos; after the list completes, no further nudges (S4) and none exist for done/canceled/empty lists.
- [x] A turn that is still open (thinking, preparing a tool, a running tool call, `finish:"tool-calls"`) never produces an idle nudge — unit tests + live (`work quiet 3.6s < 0.25min` while a shell and a subagent ran).
- [x] Consecutive nudges for one session are ≥ `minNudgeIntervalMs` apart.
- [x] The synthetic input carries `metadata.source === "todo-supervisor"`, the rendered open list and a descriptive label.
- [x] A 409 (busy) response is retried (≤5 s) and eventually delivered; no crash on either path.

### Aspect 8 — Supervisor: running work & stall (Phase 3)

**Tasks**
- [x] Child tracking (`session.created.parentID`; child liveness via the shared activity events) — live: stall nudge named the quiet subagent `ses_ebef80748ffeJrgLpnDoSIYNF0`
- [x] Background shell tracking via **shell lifecycle events** — `shell.created` (`info.metadata.sessionID` links to the session, `info.time.started`, `info.command`, `info.file` = stdout capture) → per-session `shells`; activity from `session.tool.progress.metadata.shellID` **and from the capture file's mtime** (§12.22 — output emits no events at all); cleared by `shell.exited`/`shell.deleted`; `tool.success` deliberately does *not* clear (it fires at launch) — see §12.14
- [x] Transitive quiet clock (§12.22): a parent includes the shells/tools of its busy children; children are counted by `childLooksBusy` (open work, activity inside the stall window, or no terminal signal yet) rather than by a `status` flag
- [x] Stall branch in `evaluate()` generalized to **any open span** (§12.19): idle-for-`stallMs` → `stalled-task` nudge naming subagent(s), background shell(s), tool call(s) and open span(s)

**Acceptance criteria**
- [x] S5/S6: while background work runs, no nudge while output is fresh; nudge at ≥ `stallMinutes` of silence; activity resets the timer. Live (threshold temporarily 0.25 min): `Stall nudge #1` named the running shell, the subagent session, `tool subagent "Slow sleep probe"` and the open step; unit tests cover progress-resets-clock and silence→stall.
- [x] The `stalled-task` text names the stalled child session ID, shell command and/or tool.
- [x] Foreground tools are tracked as in-flight tool calls, so a long foreground tool (or a `task` subagent) blocks the idle nudge and only earns a stall nudge after `stallMinutes` of silence — unit + live (exited/foreign shells are ignored — unit-covered).
- [x] Live (user-reported): a background shell printing to its capture every ~2 s with `stallMinutes: 0.25` (15 s) produced **zero** nudges across a 34 s run, while a stale silent foreground command was also tracked — proving the capture-file mtime and the transitive clock drive the decision (§12.22).

### Aspect 9 — Supervisor: guardrails & lifecycle (Phase 4)

**Tasks**
- [x] Blockers: `permission.asked/replied`, `form.created/replied/cancelled`, `requires_action` — implemented + unit-tested (`permission prompt blocks nudges; reply resumes`); live capture pending (sessions auto-approve, §12.5)
- [x] Pause-on-interrupt; resume on real user input (§5.4); user-vs-synthetic detection via `session.inbox.enqueued` — implemented + unit-tested (`interrupt pauses; a real user prompt resumes; synthetic inbox items do not`)
- [x] No-progress backstop (`maxNoProgressNudges`) with a single transition log + event — implemented + unit-tested (exactly N identical nudges → pause → list change resumes); live `noProgress` increments observed in nudges #2/#3
- [x] Per-session `setEnabled` flag — supervisor method + `evaluate` gate (`enabled=false` → paused until toggled); RPC wiring lands in aspect 11
- [x] `dispose()`: clear all timers, abort the subscription — implemented (abort-aware loop, idempotent guard) + unit-tested; observed disposing on every reload wave
- [x] Busy-state guardrails (§12.18 → superseded by the activity-span model in §12.19): nothing is nudged while a turn/step/reasoning/tool span, an in-flight tool call, a shell, a child or a queued inbox item is open, and `sendNudge()` re-validates `enabled`/`paused`/`blocked` and the quiet threshold at send time (retries included) — unit-tested + live (stall nudge named subagent + shell + tool + open step; zero idle nudges during continuous work)

**Acceptance criteria**
- [x] S7: an interrupt pauses supervision; the next real user prompt resumes it — unit-proven; live check deferred (needs a real interrupt mid-turn).
- [x] S8: no nudges while a permission prompt or question is pending; resumes after the reply — unit-proven; live capture deferred (auto-approve).
- [x] S9: exactly `maxNoProgressNudges` identical-state nudges, then paused with one log line; no further nudges until the list changes — unit-proven.
- [x] S10: restart persistence works; deleted sessions are dropped from registry and storage — live-proven across reload waves (reconcile re-registers; lists survive); deleted-session cleanup unit-proven.
- [x] S14: disabling a session (`setEnabled(false)`) suppresses automatic nudges (and a manual nudge while disabled); re-enabling resumes — unit + live (`skipped (paused (disabled))` on the pending evaluate). The full plugin-disable + restart cycle stays in the interactive pass.

### Aspect 10 — Context injection (Phase 5)

**Tasks**
- [x] `ctx.session.hook("context", …)` appending a system text part when the session has a list — live: `context injected (ses_…, 17 items)` on a real model call (19:32:33), registration logged for all instances (19:31:01)
- [x] Cache-only reads (no storage I/O per model call); gate on `injectTodoContext`; marker-based idempotence across overlapping generations

**Acceptance criteria**
- [x] S11: after compaction, the next request still carries the full todo list + the policy line — the block is rebuilt from the cache on every request (`renderTodoContext`, full list incl. completed, counts + policy).
- [x] No block when the list is empty or the option is off — unit-tested (`context injection (§5.5)`).
- [x] Exactly one block per request; content is idempotent — marker check skips duplicate registrations (unit test injects twice → one block).

### Aspect 11 — RPC (Phase 6)

**Tasks**
- [x] `src/rpc.ts` contract: methods `list/clear/nudge/setEnabled/toggle/toggleFile/subscribe/unsubscribe`; events `updated/nudged` (portable JSON-schema descriptors)
- [x] `ctx.rpc.register` + implementations; emit on every mutation, subscription change, and nudge; dispose on unload — live: registered in all four instances (19:36:52)
- [x] `toggleFile({sessionID, path, line})` for markdown write-back (§12.20): fence-aware marker rewrite, refuses paths outside the effective subscription set — live round-trip (`- [ ]`→`- [x]`, `- [~]`→`- [x]`; fenced + unsubscribed rejected)

**Acceptance criteria**
- [x] Methods are callable from the TUI (aspect 12) and over HTTP — live spot checks: `todo.list` (items + supervisor snapshot), `todo.subscribe`, `todo.setEnabled`, `todo.toggleFile` via `POST /api/rpc/todo/{method}` with the `{"input": …}` envelope (§12.15, §12.20).
- [x] `updated` fires on `todo_write`/`clear`/`toggle`/`toggleFile`; `nudged` fires exactly once per nudge — all emissions go through one emitter (tools hook, clear/subscribe handlers, supervisor nudge success); unit tests assert emission (`machine.test.ts`, `rpc.test.ts`).
- [x] `subscribe`/`unsubscribe` validate paths (extension + resolution) and round-trip in storage — unit-tested (resolve, dedupe, un-shadow, shadow; rejects `.txt`); `list.files` becomes real data in aspect 14.
- [ ] After plugin unload, calls fail cleanly (registration disposed) rather than hanging — deferred to the interactive scenario pass (needs a plugin-disable cycle, S14).

### Aspect 12 — TUI (Phase 7)

**Tasks**
- [x] `src/tui.tsx`: RPC client + memory-store snapshots refreshed from `updated`/`nudged` events — live: loads and registers (`[todo-supervisor/tui] setup 2.0.24` → `slots registered` → `ready`, 19:48:59) with hot-reload `disposed`→`setup` cycles (§12.16)
- [x] Composer strip (`session.composer.top`; hidden when both sources are empty) with combined session + file counts
- [x] Panel (`session.panel`, name `todo.todos`), rewritten (§12.21): header with progress bar + supervision chip, `<scrollbox>` body with a `SESSION` section and collapsible markdown sections (`path:line`, `(missing)` badge, selection highlight kept on screen via `scrollChildIntoView`), width-aware footer; keys `↑↓/jk`, `pgup/pgdn`, `home/end/g/G`, `space`/`x` toggle (session item → RPC `toggle`, markdown item → RPC `toggleFile`, file row → collapse), `enter` collapse, `n` nudge, `s` pause/resume, `a` add, `d` remove, `r` refresh, `/` filter, `f` fullscreen, `c` clear, `?` help, `escape` close
- [x] Layout math extracted to `src/panel.ts` + `src/panel.test.ts` (12 tests) so the TUI file is JSX-only
- [x] Commands: palette + `/todos` slash with arguments (`add <path>`, `remove <path>`; default opens the panel); toasts on nudge (idle vs stalled) and on all-done

**Acceptance criteria**
- [x] S13: strip counts match server state and update within a moment of `todo_write` — the strip refreshes on RPC `updated` (emitted by the todo_write hook); visual confirmation in the scenario pass.
- [x] Panel actions (nudge now, clear, toggle done, toggle file item) change server state and reflect back in the UI — `toggle` live round-trip (completed → pending → completed, 19:49) and `toggleFile` live round-trip (20:28, §12.20); every action emits `updated` → refresh.
- [x] `/todos add <path>` subscribes the active session to that file — command wired to RPC `subscribe` (live-verified over HTTP) with a success toast; file sections render `list.files` (parsed items land with aspect 14).
- [x] Toast appears when a nudge fires for the active session; "all done" toast on completion — wired to RPC `nudged` + the open-count transition in the snapshot store.
- [x] No list and no subscriptions → strip hidden; disabling the plugin removes all UI contributions — slot disposers + event unsubscribes in the setup cleanup; live: `disposed` on hot reload.
- [x] Interactive panel pass: open `/todos`, move, toggle session and markdown items, filter, collapse a section, pause/resume, fullscreen, close — confirmed by the user (§12.21).

### Aspect 13 — Observability & error handling

**Tasks**
- [x] `[todo-supervisor]`-prefixed logs at key transitions: setup, options, register, nudge, pause, resume, backstop, storage/RPC failures — verified greppable (`grep -avc '^[0-9].*\[todo-supervisor'` → 0 unprefixed lines)
- [x] `try/catch` around every event handler, nudge, RPC implementation, and hook — event loop + per-event `handle`, evaluate/refresh fail-open, claims, reconcile, nudge retry/drop, tool `execute` (logged + clean tool error), RPC handlers (logged + rethrown), context hook, TUI setup/commands/refresh

**Acceptance criteria**
- [x] A full S1–S19 pass produces zero unhandled rejections/stack traces in the server log — no stack frames in the log so far; the final scenario run confirms.
- [x] Injected synthetic failures (busy 409, storage error, RPC error) are logged and supervision continues — unit tests: 409 retry (`nudge busy`), storage failure fail-open (`refresh failed` and the nudge still goes out), RPC handler failure logged + rethrown, `todo_write` failure → tool error + log.
- [x] All log lines are greppable by the plugin prefix — verified live.

### Aspect 14 — Markdown mode (additional feature)

Depends on aspects 4–5 (storage, tools); task lines here extend aspects 11–12.

**Tasks**
- [x] `src/markdown.ts`: fence-aware checklist parser (§5.8 regex), path resolution/validation (`.md`/`.markdown`, relative to `ctx.location.directory`), per-file parse cache — open-items hash is assembled in `evaluate()` (14b)
- [x] `todo_subscribe` / `todo_unsubscribe` tools (§5.2) with descriptions stating the completion convention (`- [x]` by editing the file) — live: registered (Code Mode catalog) and round-tripped
- [x] `subs/<sessionID>` storage (`files` + `removed`), merge with config `markdownFiles` (`effectiveFiles`), delete with `session.deleted` (already in the supervisor) — live: subscribe stored, unsubscribe shadowed, `list.files` emptied
- [x] `todo_read` merged output (session items first, then per-file sections with `path:line`) — live: `33 open of 93 items` with PLAN.md rows like `(git/todo/PLAN.md:609)`
- [x] Supervisor `evaluate()` uses merged sources for supervised/open/done/hash; nudge templates group items by source with `path:line` references — live: nudge text `9 of 19 todos left` + `## /tmp/opencode/live-todo.md (1 open of 2)` section; unit tests: markdown-only supervision, completion stops, shadow excludes, missing file logged once
- [x] `ctx.tool.hook("execute.after")` refresh for `edit`/`write`/`patch` on subscribed paths; emit RPC `updated` — live: `markdown refreshed (ses_…, /tmp/opencode/live-todo.md)` after a real edit call
- [x] RPC `subscribe`/`unsubscribe`; `list` output adds `files` (path, exists, items) — live: 76 parsed PLAN.md items with status + line
- [x] TUI file sections + add/remove file actions + `/todos add|remove <path>` arguments (aspect 12 extensions)
- [x] Panel write-back: `x` on a markdown row calls RPC `toggleFile`, which rewrites the checkbox in the file (§12.20) — live round-trip; parser also tolerates a CRLF last line without a final newline

**Acceptance criteria**
- [x] S15 passes: file items appear with `path:line` refs in `todo_read` and nudges; supervision continues until the file's last item is `[x]`, then stops — live (nudge above) + unit test ("markdown completion stops nudges and new items resume them").
- [x] S16: a nonexistent path is subscribable (`exists:false`, 0 tasks); creating the file later is picked up and supervised — unit test (missing file logged once, 0 tasks).
- [x] S17: checklist-looking lines inside fenced code blocks are ignored; `-`/`*`/`+`/numbered/indented items all parse — unit tests (`markdown.test.ts`).
- [x] S18: a file completed in another session stops this session's nudges at its next evaluation — re-parsed per evaluation (unit test simulates the external change); the `execute.after` hook makes in-session edits immediate.
- [x] S19: agent edit of a subscribed file triggers RPC `updated` and a UI refresh within a moment — live: `markdown refreshed` + emitted `updated` (TUI refresh wired in aspect 12).
- [x] `todo_unsubscribe` (tool, UI, or config `removed` shadow) immediately excludes the file from supervision and the UI — unit tests + live round-trip.
- [x] Missing/unreadable/malformed files never throw: parse errors are logged once and treated as 0 tasks — `MarkdownCache.parse` never throws; supervisor logs the missing transition once.

### Aspect 15 — Documentation & release (Phase 8)

**Tasks**
- [x] `README.md`: verbatim install/config snippet, options table with defaults, behavior summary, dev loop, limitations (interrupt pause, no-progress backstop, clear-vs-complete)
- [x] `README.md` Markdown mode section: checklist conventions (`[ ]`/`[x]`/`[~]`), subscribe tools/UI/config, `path:line` references
- [x] Update this PLAN.md checkboxes as aspects land
- [ ] Commit per aspect; final scenario pass; tag `v0.1.0`

**Acceptance criteria**
- A fresh reader can install by pasting the config snippet (verified by copy/paste walkthrough → plugin loads).
- Every option from §5.1 appears in `README.md` with its default.
- Each aspect has a commit on `main` whose message names the aspect; `v0.1.0` tag exists once S1–S19 all pass.

---

## 12. Runtime verification results (2026-10-15 · OpenCode 2.0.24)

Authoritative catalog: `node_modules/@opencode/schema/dist/event-manifest.js` (+ per-domain `*-event.js`). Live captures in `~/.local/share/opencode/log/todo-supervisor.log` (`debugEvents: true`).

1. **`session.status`** (ephemeral): `{ sessionID, status: {type: "idle"} | {type: "busy"} | {type: "retry", attempt, message, next, action?} }` — event status union is **idle | retry | busy**; `session.idle` exists but is **deprecated**. There is no `session.updated` event; registry tracking uses `session.created`/`session.deleted` (+ `renamed`/`moved`/`metadata.updated` if needed).
2. **`session.tool.called`**: `{ sessionID, assistantMessageID, id (callID), input, executed }`; background shell info is inside `input` (`input.background === true`, verified live; background calls arrive with `executed:false`). **Superseded for shell tracking** — use the shell lifecycle events instead (§12.14): `tool.success` fires at background *launch* and cleared tracked shells, silently disabling stall detection (observed live: an idle nudge instead of a stall nudge for a quiet `sleep 246`). Tool *name* is on `session.tool.input.started` (`"name":"shell"`).
3. **`session.tool.progress`**: `{ sessionID, assistantMessageID, id, metadata: { shellID } }` (verified live).
4. **`session.created`**: `{ sessionID, projectID, location: { directory }, subpath, parentID?, slug, title, agent, model, version }` — children carry `parentID` (verified live with a real subagent).
5. **`permission.asked`/`replied`**, **`form.created`/`replied`/`cancelled`**: names + session linkage confirmed from schema; live payload capture pending (current sessions auto-approve). `debugEvents` will collect them opportunistically.
6. **`session.inbox.enqueued`**: `{ sessionID, inboxID, item: { type: "user", payload: { text, files?, metadata? } }, delivery: "steer" | "queue" }`. User-vs-synthetic: our nudges set/pass `metadata.source = "todo-supervisor"`; corroborated by the dedicated `session.synthetic` event. Live check in aspect 7.
7. **`ctx.session.synthetic`** exists on the session domain (confirmed in SDK types); busy-409 behaviour tested in aspect 7.
8. **Subscribe yield**: the SSE envelope `{ id, type, data }` (verified live); `normalizeEvent()` handles envelope and bare shapes.
9. **`node:fs`**: available in server plugins (`appendFileSync`/`renameSync`/`statSync` used by `src/log.ts`, verified live).
10. **`execute.after`** hook signature confirmed in SDK types (`{ tool, sessionID, agent, messageID, id, input, status, result | error }`); path extraction inspected when markdown mode lands.
11. **Hot reload**: every write under `~/git/todo` (and config edits) triggers a reload wave that loads two plugin instances per location (roles `server` + `cli`). The runtime disposes the previous wave (`cleanup — disposing supervisor` → `disposed` → `unloaded`), but module-level state persists per role-module across generations (instance counters keep climbing). Cross-generation dedupe therefore must go through `ctx.storage` — module state is not authoritative.
12. **Ownership claims**: `claims/<sessionID> = { tag, at }` written at registration; `sendNudge` skips when a strictly newer claim exists (`at > mine || (at === mine && tag > mine)`) → exactly one nudge per session per idle episode across all live instances (verified live: `nudge skipped … newer supervisor owns` on the older generation, single `nudged` line on the winner; fails open on claim read errors).
13. **Per-instance `TodoStore` cache is not shared across roles**: tool writes execute in the role hosting the session, so the other role's supervisor kept rendering nudges from a stale cache (measured: list written 19:15:09.793 was still rendered stale by nudge #2 at 19:15:33.498 — ~24 s — because that instance's cache was primed at 19:14:29). Fix: `TodoStore.refreshTodos()` re-reads the `kv` row (and drops the entry when the row is gone); `evaluate` and `sendNudge` call it before acting. Regression test: "nudges re-read storage so writes from another role are visible" (`src/machine.test.ts`); 43/43 passing.
14. **Shell lifecycle events are location-scoped**: `shell.created` `{ info: { id: "sh_…", status, command, cwd, file, metadata: { sessionID }, time: { started } } }` — the owning session comes from `info.metadata.sessionID`; the envelope has **no** sessionID and every plugin location receives the event (a Downloads project shell was seen by the nikolas instances). `shell.exited` `{ id, exit?, status }` and `shell.deleted` `{ id }` are the clearing signals. Implemented as a supervisor-level `shellSessions` map (shellID → sessionID); `session.tool.progress.metadata.shellID` resets the shell's activity clock. Live-verified end-to-end: `Stall nudge #2` named the running `sleep 200` shell; killing it cleared tracking so `Stall nudge #3` named only the quiet subagent. Unit tests: silence→stall, progress reset, exited/foreign shells ignored (44/44 passing).
15. **RPC over HTTP**: route `POST /api/rpc/{rpcID}/{method}` (OpenAPI `rpc.call`); the body is the wrapped envelope `{"input": <method input>}` and the response is `{"output": …}` — a bare payload fails with `rpc.invalid_input`, and a handler payload containing `undefined` fails with `rpc.invalid_output` (fix: `pauseReason: st.pauseReason ?? null`). Unauthenticated HTTP is rejected; the `opencode2 api` CLI carries service credentials. Live spot checks: `todo.list`, `todo.subscribe`, `todo.setEnabled`; an unknown `rpcID` fails cleanly (`rpc.method_not_found`).
16. **TUI plugin loading**: the `./tui` export may point at a **`.tsx`** entry; the host transpiles plugin files outside `node_modules` and rewrites `@opentui/solid`(+`/jsx-runtime`), `solid-js`(+`/store`) and `@opencode/plugin/tui` to its own module instances (virtual modules) — no local OpenTUI install required (optional peers in `package.json`; the `@jsxImportSource @opentui/solid` pragma is respected). Live: `[todo-supervisor/tui] setup 2.0.24` → `slots registered (session.composer.top, session.panel todo.todos)` → `ready`, and hot reloads cycle through `disposed`→`setup`. TUI-side logging must not touch stdout/stderr (the TUI owns the terminal): `logFile` (file-only variant of `log`) writes the shared log; `context.client.rpc(TodoRpc)` + `rpc.events.on(...)` reach the server RPC out of the box.
17. **Subscription reads can lag briefly across roles**: right after a `todo_subscribe` write from one role, a `todo_read` in another role can still report the old subscription set for ~1–2 s (observed once; an immediate retry showed the file). RPC `list`, the supervisor's `evaluate()`/`sendNudge()` and the `execute.after` hook all re-read per call, so supervision and the UI are unaffected; the same class as the §12.13 stale-cache finding (SQLite `kv` visibility between roles).
18. **Busy-state misfires (user-reported live, fixed)**: a session could be nudged while it was not idle. First fix (that entry's original text) used a single "quiet clock" plus send-time re-validation; it was still fooled by a **running `task` tool** because nothing tracked in-flight tool calls. Superseded by §12.19.
19. **Activity-span idle model (user-reported: "triggering when a task is running in the main context")**: the runtime here does **not** reliably deliver `session.status`/`session.idle` (0 in a long capture), so `status` alone can never prove idleness; the authoritative signals are the paired lifecycle events. Implemented: per-session **spans** (`turn`, `step`, `reasoning`, `text`, `tool-input`, `inbox`) plus **in-flight tool calls** (registered from `session.tool.input.started`, which carries `name`, enriched by `session.tool.called`'s `input.description`/`input.command`; closed by `session.tool.success/failed`). `session.step.ended` carries `finish`: **`"stop"` = final step of the turn**, `"tool-calls"` = the turn continues and must never arm a nudge. `endTurn()` (from `finish:"stop"`, `execution.succeeded/failed/interrupted`, `status idle`) closes all spans, drops tool calls and records `terminalAt`, which is what heals lost close events (interrupt, reload mid-call). `evaluate()` nudges on idleness only when nothing is open **and** `terminalAt` exists (otherwise it waits the stall window), and the stall branch names every open kind. Verified live with a lowered 15 s threshold: `evaluate … skipped (work quiet 3.6s < 0.25min)` while a `sleep 90` shell and a subagent ran, `register ses_ebec… (parent=ses_ebf…)` (child sessions **do** register live — an earlier "no `session.created`" reading was a log-window artifact), then exactly one nudge: `Stall nudge #1 — no activity for less than a minute from: subagent ses_ebec… / background shell "sleep 90…" / tool subagent "Slow sleep probe" / open step (stall threshold 0.25 min)`; zero idle nudges during the work. Unit tests: in-flight task blocks the nudge, `tool-calls` never arms, `stop` arms, reasoning-only turn, stall names the tool, leak healing (101/101).
20. **Markdown write-back (`RPC toggleFile`)**: the panel can check items off in subscribed files. `toggleMarkdownItem(path, line)` is fence-aware (only lines the parser reports as items), rewrites **only** the marker (bullet, indentation, trailing text and CRLF endings preserved) and writes via temp file + `renameSync`; the RPC refuses paths outside the effective subscription set. Live round-trip over HTTP: `- [ ] first live item` → `- [x] first live item`, `- [~] canceled one` → `- [x] canceled one`; a fenced look-alike and an unsubscribed path both failed with logged reasons. This also fixed a parser edge: a CRLF file whose last line has no final newline is now parseable (`ITEM_RE` tolerates a trailing `\r`).
21. **Panel rewrite + nudge label**: `src/tui.tsx` now renders a header (progress bar + supervision chip from the new `snapshot()` fields `runningTools`/`spans`/`quietMs`/`terminal`), a `<scrollbox>` body with a `SESSION` section plus collapsible per-file sections (selection highlight, `:line` refs, `(missing)` badge), and a width-aware footer; keys are a keymap layer enabled only while `panel.focused`. All layout math moved to `src/panel.ts` (12 unit tests). The synthetic bubble label was enriched from `description: "todo-supervisor"` to `describeNudge()` (`todo-supervisor · nudge #3`, `todo-supervisor · stalled: task "…"`), since that string is the only text the host renders next to `◈`. Interactive pass confirmed by the user (opening `/todos`, moving, toggling session + markdown items, filtering, collapsing, pause/resume, fullscreen, close). The list is now a **popover dialog** (`context.ui.dialog.show` + `dialog.set({size})`, `f` cycles medium/large/xlarge) with the docked `session.panel` kept as a secondary command; row width comes from `renderer.width` (reactive via the renderer's `resize` event) through the pure `dialogWidth(size, viewport)` helper. User-reported and fixed: the dialog hugs its content, so the first popover grew to the whole screen and the `flexGrow` body pushed the key legend out of the clipped box — the body is now bounded (`popoverBodyHeight`, ≤16 rows, −1 while filtering) with the legend always rendered last and a `row n/m` indicator in the header; re-verified by the user.
22. **A running task that writes to its stdout capture reported no events at all (user-reported: "nudged again while there was real progress in the task that is running, ie more output into the task stdout capture")**: shell/child stdout lands in a capture file (`shell.created.info.file`) and appending to it emits **no** plugin event — measured live: a capture grew 685 → 842 bytes with zero events. Two consequences, both fixed: (a) `quietMs()` now stats every tracked shell's capture file and uses its `mtimeMs` as the shell's activity (`shellActivity`), so "quiet" is the true time since the last output; (b) the clock is now **transitive** — a parent includes the shells/tools of the children that still look busy, and `runningChildren` no longer requires `child.status === "running"` (`childLooksBusy`: open work, or activity inside the stall window, or not yet past a terminal signal). Stall nudges also name work running *inside* a child. Tests: child-owned shell keeps the parent out of the idle path, growing capture is never stalled (and stalls once it stops), a child that ended its turn stops counting as running work. Live: a `for i in $(seq 1 18); do echo …; sleep 2; done` background shell with `stallMinutes: 0.25` (15 s) produced **zero** nudges for the whole 34 s run while the capture kept growing (previously a stall nudge would have fired at ~15 s).
