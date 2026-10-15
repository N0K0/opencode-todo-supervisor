# todo-supervisor

An [OpenCode](https://opencode.ai) **V2** plugin that gives every session a proper todo list and then *keeps the agent working on it*:

- `todo_write` / `todo_read` tools (V2 ships none), stored per session;
- a supervisor that re-prompts an idle session whenever its list still has open items — and stays quiet while the agent is actually working (thinking, preparing a tool, a running tool or `task` subagent, background shells, child sessions), nudging only after that work goes silent;
- **Markdown mode**: subscribe any number of markdown files whose GFM checklists (`- [ ]`) count as todos — and check them off from the panel;
- a TUI strip + panel, slash command, palette entry, and toasts.

Nudges are delivered as synthetic session input, so the model sees them as normal instructions. Every nudge is self-contained: counts, the open items (with priorities), a short explainer of why it fired and how to finish.

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

- The package directory needs its dependencies once: `bun install` (the loader does not install them for local-path entries).
- Config content changes and plugin source edits are hot-reloaded by the running service.
- Logs: the plugin appends to `~/.local/share/opencode/log/todo-supervisor.log` (log lines are prefixed `[todo-supervisor]` / `[todo-supervisor/tui]`). `console.log` inside plugins is swallowed; use the log file.

## Tools

| Tool | Input | Purpose |
| --- | --- | --- |
| `todo_write` | `{ todos: [{ content, status, priority? }] }` | Replace the session list (`pending` / `in_progress` / `completed` / `canceled`; at most one `in_progress`) |
| `todo_read` | `{}` | Rendered list, merged with subscribed markdown files (`path:line` refs) |
| `todo_subscribe` | `{ files: [{ path }] }` | Markdown mode: treat the file's checklist as todos (`.md`/`.markdown`, relative to the project dir or absolute) |
| `todo_unsubscribe` | `{ files: [{ path }] }` | Stop supervising a file (also shadows a config default) |

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
| `scope` | `"project"` | Only supervise sessions of the plugin's own project (`"project"`) |
| `pauseOnInterrupt` | `true` | Pause supervision after an interrupted execution until the user continues |
| `debugEvents` | `false` | Log the raw event stream |

## Supervision semantics

The supervisor tracks **activity spans** rather than trusting a session status flag:

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

- **Idle nudge**: only when *nothing* is open and the last signal was a real end of turn — `step.ended` with `finish:"stop"`, `execution.succeeded/failed/interrupted` or `status idle`. `settleMs` is just a debounce after that. A step ending with `finish:"tool-calls"` always means "the turn continues" and never arms a nudge.
- **Stall nudge**: if work is still open but has produced no events for `stallMinutes`, a nudge names what is quiet: `subagent ses_…`, `background shell "cmd"`, `tool subagent "Add the panel"`, `open step`, `thinking (no deltas)`.
- **Runtimes without end-of-turn signals**: if no terminal signal was ever seen for a session, the idle rule falls back to the `stallMinutes` window (more conservative, never chatty).
- **Backstop**: `maxNoProgressNudges` consecutive nudges whose open-item hash did not change pause supervision (`pause … backing off until the list changes`); the next `todo_write` resumes it (`resume …`).
- **Interrupts**: an interrupted execution pauses supervision so the agent never talks over a user decision.
- **Done**: a session is done when no open items remain across all sources. `clear` (RPC/panel) drops the session list; checking items off is the normal path.
- **Hot reloads**: overlapping plugin generations each register; storage ownership claims ensure exactly one of them sends any given nudge.

## Markdown mode

Subscribe files with `todo_subscribe`, the panel (`a` / `d`), or config. Effective subscriptions are `config.markdownFiles ∪ stored files − removed` per session.

- Conventions: `- [ ]` open, `- [x]`/`- [X]` completed, `- [~]` canceled. `-`, `*`, `+`, numbered and indented items all count; fenced code blocks are ignored.
- Completion by the agent happens by **editing the file** (`- [x]`); nudge text says so explicitly. The **panel can toggle a file item too** (`x`/`space` on a markdown row): the plugin rewrites only that line's marker (indentation, bullet, trailing text and CRLF endings are preserved) and refuses paths that are not subscribed.
- Item references are `path:line`, both in `todo_read` and in nudges (items grouped: session list first, then one section per file).
- Missing files are valid subscriptions (0 tasks); they are picked up when created (logged once).
- `evaluate()`, RPC `list` and `todo_read` re-parse fresh; an `execute.after` hook re-parses immediately when an `edit`/`write`/`patch` touches a subscribed file and emits RPC `updated`. There is no filesystem watcher — edits made outside OpenCode are picked up at the next evaluation or UI read.

## TUI

- **Composer strip** (`session.composer.top`): `📋 ███░░░░░ 8/17 open` (plus `⏸` while paused), hidden when there is neither a list nor subscriptions.
- **Panel** `todo.todos` (`/todos`, palette "Todo: open list"):
  - header: progress bar, `open/total`, and a supervision chip (`idle · quiet 12s · nudges 2`, `working: 1 tool · 1 shell · quiet 4s`, `paused (no-progress)`, `not supervised`);
  - body: a `SESSION` section, then one collapsible section per subscribed file (`n open of m`, `(missing)` badge, `:line` refs); the selected row is highlighted and kept on screen;
  - keys: `↑↓`/`jk` move, `pgup`/`pgdn`, `home`/`end`/`g`/`G`, `space`/`x` toggle (session item, markdown item, or collapse a file row), `enter` collapse, `n` nudge now, `s` pause/resume supervision, `a` add file, `d` remove file, `r` refresh, `/` filter, `f` fullscreen, `c` clear (confirm), `?` help, `escape` close;
  - the panel re-reads every 3 s while open, so edits made outside OpenCode show up without waiting for an event.
- `/todos add <path>` and `/todos remove <path>` manage subscriptions from the prompt.
- **Toasts** on `nudged` (idle vs stalled wording) and on the all-done transition.

## RPC

Contract id `todo` (`opencode-todo-supervisor/rpc`): methods `list`, `clear`, `nudge`, `setEnabled`, `toggle`, `toggleFile`, `subscribe`, `unsubscribe`; events `updated`, `nudged`. The TUI uses `context.client.rpc(TodoRpc)` and `rpc.events.on(...)`.

Over HTTP (service credentials required):

```bash
opencode2 api POST /api/rpc/todo/list \
  -H 'content-type:application/json' \
  -d '{"input":{"sessionID":"ses_…"}}'
# → {"output": { items, files, supervisor }}
```

The body/response are wrapped in `{ "input": … }` / `{ "output": … }`.

## Development

- Edit any file in this directory → the running service hot-reloads the plugin (source edits and config content changes; `touch` alone does not).
- `opencode2 reload` forces reconciliation; `opencode2 service restart` only as a last resort (it interrupts sessions).
- Tests: `bun test` (101 tests across parser, storage, tools, RPC, state machine, panel helpers).
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

- The TUI panel/keyboard actions and toasts need a running TUI; the strip counts refresh on RPC `updated` (i.e. immediately after `todo_write`).
- Markdown write-back edits your files: `x` on a markdown row rewrites that checkbox in place (temp file + atomic rename, only for subscribed paths). Use the panel filter and `d` if you only want to read.
- `pauseOnInterrupt` relies on the execution-interrupted event: after an interrupt, supervision resumes on the next `todo_write`/status event.
- No filesystem watcher: external edits are picked up at the next evaluation, at the next UI read, or by the panel's 3 s poll while it is open (see Markdown mode).
- Subscription reads can briefly lag across roles right after a write (supervision and the UI re-read per call and are unaffected).
- Runtimes that never emit an end-of-turn signal fall back to the `stallMinutes` window for idle nudges (see Supervision semantics).
