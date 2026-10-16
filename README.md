# todo-supervisor

An [OpenCode](https://opencode.ai) **V2** plugin that gives every session a real
todo list — and then keeps the agent working on it.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  📋 ███░░░░░ 8/17 open                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

- `todo_write` / `todo_read` tools (V2 ships none), stored per session;
- a **supervisor** that re-prompts an idle session while its list still has open
  items — and stays quiet while the agent is actually working (thinking,
  preparing a tool, a running tool or `task` subagent, background shells, child
  sessions), nudging only once that work goes silent;
- **Markdown mode**: subscribe any number of markdown files whose GFM checklists
  (`- [ ]`) count as todos — and check them off from the panel;
- a TUI strip + popover panel, slash command, palette entries, and toasts.

Nudges are delivered as synthetic session input, so the model sees them as normal
instructions. Every nudge is self-contained: counts, the open items (with
priorities), a short explainer of why it fired, and how to finish.

Tested against OpenCode `2.0.24`.

## Install

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": [
    {
      "package": "/absolute/path/to/todo",
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

- The package directory needs its dependencies once: `bun install` (the loader
  does not install them for local-path entries).
- Config content changes and plugin source edits are hot-reloaded by the running
  service.
- Published as `opencode-todo-supervisor` on npm: `opencode plugin add
  opencode-todo-supervisor` (this also loads the bundled TUI entry).
- Logs: the plugin appends to `~/.local/share/opencode/log/todo-supervisor.log`
  (prefixes `[todo-supervisor]` / `[todo-supervisor/tui]`). `console.log` inside
  plugins is swallowed; use the log file.

## What it does

OpenCode has no built-in todo list, so the model often plans in prose and then
stops early, leaving half a task done. This plugin gives the model a durable list
and makes finishing it the path of least resistance:

1. the agent calls **`todo_write`** to lay out the work;
2. it works the list, calling `todo_write` as items move;
3. if it goes idle with items still open, the **supervisor** nudges it to
   continue — and if work *looks* running but has gone silent, it nudges about
   that instead;
4. it is finished when no open items remain across all sources.

## Tools

| Tool | Input | Purpose |
| --- | --- | --- |
| `todo_write` | `{ todos: [{ content, status, priority? }] }` | Replace the session list (`pending` / `in_progress` / `completed` / `canceled`; at most one `in_progress`) |
| `todo_read` | `{}` | Rendered list, merged with subscribed markdown files (`path:line` refs) |
| `todo_subscribe` | `{ files: [{ path }] }` | Markdown mode: treat the file's checklist as todos (`.md`/`.markdown`, relative to the project dir or absolute) |
| `todo_unsubscribe` | `{ files: [{ path }] }` | Stop supervising a file (also shadows a config default) |

`todo_write` normalises input: content is trimmed, empties dropped, duplicates
removed, and only one item can be `in_progress` (extras are demoted to `pending`
and the output says so). The tool description states the contract to the model
("keep updating the list; only end your turn once every item is completed or
canceled"), and the returned text always shows the canonical list.

## Markdown mode

Subscribe files with `todo_subscribe`, the panel (`a` / `d`), or config. The
effective set is `config.markdownFiles ∪ stored files − removed` per session.

- Conventions: `- [ ]` open, `- [x]`/`- [X]` completed, `- [~]` canceled. `-`,
  `*`, `+`, numbered and indented items all count; fenced code blocks are ignored.
- Completion by the agent happens by **editing the file** (`- [x]`); nudge text
  says so explicitly. The **panel can toggle a file item too** (`x`/`space` on a
  markdown row): the plugin rewrites only that line's marker (indentation,
  bullet, trailing text and CRLF endings preserved) and refuses paths that are
  not subscribed.
- Item references are `path:line`, in both `todo_read` and nudges (grouped:
  session list first, then one section per file).
- Missing files are valid subscriptions (0 tasks) and are picked up once created.

## TUI

- **Composer strip** (`session.composer.top`): `📋 ███░░░░░ 8/17 open` (plus `⏸`
  while paused), hidden when there is neither a list nor a subscription.
- **Popover** (`/todos`, palette "Todo: open todos"): a centered overlay dialog.
  The body is height-bounded (up to 16 rows) so the key legend is always visible;
  the header shows `open/total` and the selected `row n/m`. `f` cycles the dialog
  size (medium → large → xlarge), `esc` closes it.
  - header: progress bar, `open/total`, and a supervision chip (`idle · quiet
    12s · nudges 2`, `working: 1 tool · 1 shell · quiet 4s`, `paused
    (no-progress)`, `not supervised`);
  - body: a `SESSION` section, then one collapsible section per subscribed file
    (`n open of m`, `(missing)` badge, `:line` refs);
  - keys: `↑↓`/`jk` move, `pgup`/`pgdn`, `home`/`end`/`g`/`G`, `space`/`x` toggle
    (session item, markdown item, or collapse a file row), `enter` collapse, `n`
    nudge now, `s` pause/resume, `a` add file, `d` remove file, `r` refresh, `/`
    filter, `f` resize, `c` clear (confirm), `?` help, `escape` close;
  - it re-reads every 3 s while open, so edits made outside OpenCode show up
    without waiting for an event.
- **Side panel** (palette "Todo: open side panel"): the same list docked to
  `session.panel` (`todo.todos`), with `f` for fullscreen.
- `/todos add <path>` and `/todos remove <path>` manage subscriptions from the
  prompt.
- **Toasts** on `nudged` (idle vs stalled wording) and on the all-done transition.

## RPC

Contract id `todo` (`opencode-todo-supervisor/rpc`): methods `list`, `clear`,
`nudge`, `setEnabled`, `toggle`, `toggleFile`, `subscribe`, `unsubscribe`; events
`updated`, `nudged`. The TUI uses `context.client.rpc(TodoRpc)` and
`rpc.events.on(...)`.

Over HTTP (service credentials required):

```bash
opencode2 api post /api/rpc/todo/list \
  -H 'content-type:application/json' \
  -d '{"input":{"sessionID":"ses_…"}}'
# → {"output": { items, files, supervisor }}
```

The body/response are wrapped in `{ "input": … }` / `{ "output": … }`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for supervision (tools keep working) |
| `settleMs` | `5000` | Debounce after a **confirmed end of turn** before the idle nudge |
| `minNudgeIntervalMs` | `45000` | Minimum gap between two nudges for one session |
| `stallMinutes` | `5` | With any work in flight: minutes of silence before a *stall* nudge |
| `maxNoProgressNudges` | `5` | Consecutive nudges with an unchanged open-item set before backing off |
| `injectTodoContext` | `true` | Append the current list to every model request (survives compaction) |
| `markdownFiles` | `[]` | Markdown checklists auto-subscribed for sessions in the project |
| `scope` | `"project"` | Only supervise sessions of the plugin's own project (`"project"` or `"all"`) |
| `pauseOnInterrupt` | `true` | Pause supervision after an interrupted execution until the user continues |
| `debugEvents` | `false` | Log the raw event stream |

## How it works

One server plugin instance per OpenCode location. It wires four things together
and then gets out of the way:

```
        OpenCode V2 service
        ┌──────────────────────────────────────────────────────────────┐
        │  ctx.event.subscribe() ──▶ supervisor state machine ──▶ nudge │
        │        ▲                    (activity spans, evaluate)   │    │
        │        │                                                 ▼    │
        │  session.tool.* / text / reasoning / step   ctx.session.      │
        │        │                                    synthetic()        │
        │  todo_write / todo_read ──▶ ctx.storage (todos/, subs/)       │
        │        │                                                      │
        │  session.hook("context") ──▶ system block (list + policy)     │
        │                                                               │
        └───────────────────────────┬───────────────────────────────────┘
                                    │ RPC (methods + events)
                          TUI plugin: strip · popover · commands · toasts
```

### Event-driven supervision

The supervisor subscribes to the public event stream and keeps a per-session
state machine in memory (`src/supervisor.ts`). It does **not** trust a session
"status" flag — this runtime does not reliably emit one. Instead it tracks
**activity spans**: anything the runtime is currently doing, opened by a
`*.started` (or `.called`) event and closed by its matching
`*.ended`/`.success`/`.failed`:

| Doing | Opened by | Closed by |
| --- | --- | --- |
| turn | `execution.started` | `execution.succeeded/failed/interrupted`, `status idle` |
| step | `step.started` | `step.ended` (with `finish`, see below) |
| thinking | `reasoning.started` | `reasoning.ended` |
| writing | `text.started` | `text.ended` |
| preparing a tool | `tool.input.started` | `tool.input.ended` |
| running a tool (`task`, `shell`, …) | `tool.input.started`/`tool.called` | `tool.success`/`failed` |
| background shell | `shell.created` | `shell.exited`/`deleted` |
| queued input | `inbox.enqueued` | `inbox.delivered` |

A session is idle **only when nothing is open** — no span, no in-flight tool
call, no background shell, no still-busy child, no queued inbox item. A step that
ends with `finish:"tool-calls"` means "the turn continues" and never arms a
nudge; a step ending with `finish:"stop"`, an execution `succeeded/failed/
interrupted`, or a `status idle` is a **confirmed end of turn** (`endTurn()`),
which also heals spans whose close event was lost (an interrupt or a reload
mid-call).

### `evaluate(sessionID)`

On every relevant event the supervisor (re)arms a per-session timer and
recomputes from current state:

1. if there is nothing open in any source, or supervision is paused/blocked →
   stop;
2. if work is in flight (spans, tools, shells, busy children), measure the quiet
   time — schedule a re-check if it is under `stallMinutes`, otherwise send a
   **stall nudge** naming what is quiet;
3. if nothing is open, wait for the debounce — `settleMs` after a confirmed turn
   end, or the more conservative `stallMinutes` if no end-of-turn signal was ever
   seen — then send an **idle nudge**.

### Nudging

Nudges go out through `ctx.session.synthetic({ sessionID, text, description,
metadata })`, so the model receives them as ordinary instructions rather than a
visible user turn. Each nudge:

- carries the counts, the open items (with priorities), and an explainer — e.g.
  `Idle nudge #2 — the session went idle with 3 of 7 todos left.` or
  `Stall nudge #1 — no activity for ~7.2 min from: subagent ses_… / background
  shell "sleep 200" / tool subagent "Add the panel" / open step (stall threshold
  5 min).`;
- is rate-limited (`minNudgeIntervalMs`) and de-duplicated by an open-item hash;
- backs off after `maxNoProgressNudges` nudges with an unchanged list and resumes
  on the next `todo_write` (the panel's `s` can pause/resume too).

**Output counts as progress, not just events.** A shell/task writes its stdout to
a capture file, and appending to it emits no plugin event at all — so the
supervisor stats each tracked shell's capture (`shell.created.info.file`) and uses
its mtime as activity. A task that keeps printing is never "stalled", no matter
how few events it produces. The quiet clock is also **transitive**: a parent
includes the shells and tools of its still-busy children, and a child stops
counting once it has ended its turn.

### Context injection

On every model request (`ctx.session.hook("context")`) the plugin appends a
compact system block with the current list and a one-line policy. This is read
from an in-memory cache (kept fresh by tool writes and scans), so it adds no async
work per call — and it **survives compaction**: even if the `todo_write` history
is summarized away, the list is re-injected on the next request.

### Storage

A thin wrapper over `ctx.storage` (durable JSON scoped to the plugin):

```
todos/<sessionID>   { version, sessionID, items[], updatedAt }
subs/<sessionID>    { version, sessionID, files[], removed[], updatedAt }
claims/<sessionID>  { tag, at }        # hot-reload ownership
```

On startup the plugin scans `todos/` and reconciles against `ctx.session.get()`
(session gone → drop the entry; session alive → register and evaluate once).
Supervision counters (nudge counts, no-progress, pause) are in-memory only; a
restart resets them, which is deliberate and simpler. Sessions are dropped on
`session.deleted`.

### Hot reloads

The runtime may load a new plugin generation before disposing the old one. Every
registration writes an **ownership claim** (`claims/<sessionID> = { tag, at }`),
and a nudge is only sent when no strictly newer claim exists — so exactly one
generation of the plugin nudge a given session, even while two are alive.
The event loop also stops as soon as its abort signal fires.

### Freshness

There is no filesystem watcher. Instead:

- `evaluate()`, RPC `list` and `todo_read` re-parse subscribed files fresh;
- a `ctx.tool.hook("execute.after")` re-parses immediately when an
  `edit`/`write`/`patch` touches a subscribed file and emits RPC `updated`;
- the open panel polls every 3 s.

## Development

- Edit any file in this directory → the running service hot-reloads the plugin
  (source edits and config content changes; `touch` alone does not).
- `opencode2 reload` forces reconciliation; `opencode2 service restart` only as a
  last resort (it interrupts sessions).
- Tests: `bun test` (106 tests across parser, storage, tools, RPC, state machine,
  panel helpers).
- Watch logs: `tail -f ~/.local/share/opencode/log/todo-supervisor.log`.

```
src/index.ts        server plugin entry (setup, event loop, RPC/tool/hook wiring)
src/supervisor.ts   state machine (activity spans, registry, evaluate, nudges, claims)
src/tools.ts        todo_write/read/subscribe/unsubscribe + renderers + context hook
src/markdown.ts     fence-aware checklist parser, subscriptions, parse cache, write-back
src/rpc.ts          RPC contract + handlers
src/panel.ts        pure panel helpers (rows, progress, cursor, hints) — unit-tested
src/tui.tsx         TUI plugin (strip, panel, commands, toasts)
```

## Limitations

- The TUI panel/keyboard actions and toasts need a running TUI; the strip counts
  refresh on RPC `updated` (i.e. immediately after `todo_write`).
- Markdown write-back edits your files: `x` on a markdown row rewrites that
  checkbox in place (temp file + atomic rename, only for subscribed paths). Use
  the panel filter and `d` if you only want to read.
- `pauseOnInterrupt` relies on the execution-interrupted event: after an
  interrupt, supervision resumes on the next `todo_write`/status event.
- No filesystem watcher: external edits are picked up at the next evaluation, the
  next UI read, or the panel's 3 s poll (see Freshness).
- Subscription reads can briefly lag across roles right after a write;
  supervision and the UI re-read per call and are unaffected.
- Runtimes that never emit an end-of-turn signal fall back to the `stallMinutes`
  window for idle nudges (see `evaluate`).

## License

MIT
