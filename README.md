# todo-supervisor

An [OpenCode](https://opencode.ai) **V2** plugin that gives every session a proper todo list and then *keeps the agent working on it*:

- `todo_write` / `todo_read` tools (V2 ships none), stored per session;
- a supervisor that re-prompts an idle session whenever its list still has open items — and waits quietly while subagents or background shells are running, nudging only after they go silent;
- **Markdown mode**: subscribe any number of markdown files whose GFM checklists (`- [ ]`) count as todos;
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
| `settleMs` | `5000` | Quiet time after activity before an idle session is nudged |
| `minNudgeIntervalMs` | `45000` | Minimum gap between two nudges for one session |
| `stallMinutes` | `5` | With subagents/shells running: minutes of silence before a *stall* nudge |
| `maxNoProgressNudges` | `5` | Consecutive nudges with an unchanged open-item set before backing off |
| `injectTodoContext` | `true` | Append the current list to every model request (survives compaction) |
| `markdownFiles` | `[]` | Markdown checklists auto-subscribed for sessions in the project |
| `scope` | `"project"` | Only supervise sessions of the plugin's own project (`"project"`) |
| `pauseOnInterrupt` | `true` | Pause supervision after an interrupted execution until the user continues |
| `debugEvents` | `false` | Log the raw event stream |

## Supervision semantics

- **When**: a session with open items that goes idle (no running children/shells) is nudged after `settleMs`, at most once per `minNudgeIntervalMs`.
- **While work runs**: running subagents and background shells put the session in *waiting* state. If none of them produces output for `stallMinutes`, a stall nudge names the quiet ones (`subagent ses_…`, `background shell "cmd"`).
- **Backstop**: `maxNoProgressNudges` consecutive nudges whose open-item hash did not change pause supervision (`pause … backing off until the list changes`); the next `todo_write` resumes it (`resume …`).
- **Interrupts**: an interrupted execution pauses supervision so the agent never talks over a user decision.
- **Done**: a session is done when no open items remain across all sources. `clear` (RPC/panel) drops the session list; checking items off is the normal path.
- **Hot reloads**: overlapping plugin generations each register; storage ownership claims ensure exactly one of them sends any given nudge.

## Markdown mode

Subscribe files with `todo_subscribe`, the panel (`a` / `d`), or config. Effective subscriptions are `config.markdownFiles ∪ stored files − removed` per session.

- Conventions: `- [ ]` open, `- [x]`/`- [X]` completed, `- [~]` canceled. `-`, `*`, `+`, numbered and indented items all count; fenced code blocks are ignored.
- Completion happens by **editing the file** (`- [x]`); nudge text says so explicitly.
- Item references are `path:line`, both in `todo_read` and in nudges (items grouped: session list first, then one section per file).
- Missing files are valid subscriptions (0 tasks); they are picked up when created (logged once).
- `evaluate()`, RPC `list` and `todo_read` re-parse fresh; an `execute.after` hook re-parses immediately when an `edit`/`write`/`patch` touches a subscribed file and emits RPC `updated`. There is no filesystem watcher — edits made outside OpenCode are picked up at the next evaluation or UI read.

## TUI

- **Composer strip** (`session.composer.top`): `📋 3 open · session 1 · files 2`, hidden when there is neither a list nor subscriptions.
- **Panel** `todo.todos` (`/todos`, palette "Todo: open list"): session section, then a section per subscribed file; `up`/`down` move, `x` toggle, `n` nudge now, `c` clear (confirm), `r` refresh, `a` add file, `d` remove file, `f` fullscreen, `escape` close. `/todos add <path>` and `/todos remove <path>` manage subscriptions from the prompt.
- **Toasts** on `nudged` and on the all-done transition.

## RPC

Contract id `todo` (`opencode-todo-supervisor/rpc`): methods `list`, `clear`, `nudge`, `setEnabled`, `toggle`, `subscribe`, `unsubscribe`; events `updated`, `nudged`. The TUI uses `context.client.rpc(TodoRpc)` and `rpc.events.on(...)`.

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
- Tests: `bun test` (77 tests across parser, storage, tools, RPC, state machine).
- Watch logs: `tail -f ~/.local/share/opencode/log/todo-supervisor.log`.

```
src/index.ts        server plugin entry (setup, event loop, RPC/tool/hook wiring)
src/supervisor.ts   state machine (events, registry, evaluate, nudges, claims)
src/tools.ts        todo_write/read/subscribe/unsubscribe + renderers + context hook
src/markdown.ts     fence-aware checklist parser, subscriptions, parse cache
src/rpc.ts          RPC contract + handlers
src/tui.tsx         TUI plugin (strip, panel, commands, toasts)
```

## Limitations

- The TUI panel/keyboard actions and toasts need a running TUI; the strip counts refresh on RPC `updated` (i.e. immediately after `todo_write`).
- `pauseOnInterrupt` relies on the execution-interrupted event: after an interrupt, supervision resumes on the next `todo_write`/status event.
- No filesystem watcher for external file edits (see Markdown mode).
- Subscription reads can briefly lag across roles right after a write (supervision and the UI re-read per call and are unaffected).
