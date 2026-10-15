/** @jsxImportSource @opentui/solid */
// todo-supervisor — OpenCode V2 CLI (TUI) plugin (PLAN.md §6, aspect 12).
//
// Contributions:
// - composer strip (`session.composer.top`): combined open counts, hidden when
//   the session has neither todos nor subscriptions;
// - panel (`session.panel`, name `todo.todos`): session items + one block per
//   subscribed markdown file, opened via `/todos`, the palette or the `Todo:
//   open list` command; actions up/down/x/n/c/r/a/d/f/escape;
// - toasts on `nudged` and on the all-done transition;
// - RPC events (`updated`/`nudged`) keep a memory-store snapshot fresh.
//
// Files/items come from RPC `list`; the markdown parser behind it lands in
// aspect 14 — the panel already renders whatever sections `list.files` reports.
import { For, Show, createEffect, createSignal } from "solid-js"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { Plugin, usePlugin, type Context } from "@opencode/plugin/tui"
import { logFile } from "./log"
import { TodoRpc } from "./rpc"

type TodoItem = { content: string; status: string; priority?: string }
type FileItem = { content: string; status: string; line?: number }
type FileSection = { path: string; exists: boolean; items: FileItem[] }
type SupervisorView = { paused?: boolean; pauseReason?: string | null; status?: string; nudges?: number }
type Snapshot = { items: TodoItem[]; files: FileSection[]; supervisor?: SupervisorView; at: number }
type Store = { snapshots: Record<string, Snapshot>; seenOpen: Record<string, number> }

function statusMark(status: string): string {
  if (status === "completed") return "[x]"
  if (status === "in_progress") return "[~]"
  return "[ ]"
}

function openCount(items: readonly { status: string }[]): number {
  return items.filter((item) => item.status !== "completed").length
}

export default Plugin.define({
  id: "todo-supervisor.tui",
  setup(context) {
    try {
      return register(context)
    } catch (err) {
      logFile("tui", `setup failed: ${String(err)}`)
      return () => {}
    }

    function register(context: Context) {
    logFile("tui", "setup", context.app.version ?? "")
    const rpc = context.client.rpc(TodoRpc)
    // Memory store: survives plugin hot reloads (old/new generations share it).
    const [state, update] = context.storage.memory<Store>("todo-supervisor", {
      initial: { snapshots: {}, seenOpen: {} },
    })

    const toastError = (where: string, err: unknown) => {
      logFile("tui", `${where} failed: ${String(err)}`)
      try {
        context.ui.toast.show({ title: "todo-supervisor", message: `${where} failed`, variant: "error" })
      } catch {
        // toast is best-effort
      }
    }

    const guard = (label: string, action: () => Promise<unknown>): void => {
      action().catch((err) => toastError(label, err))
    }

    const refresh = async (sessionID: string) => {
      try {
        const result = (await rpc.list({ sessionID })) as {
          items?: TodoItem[]
          files?: FileSection[]
          supervisor?: SupervisorView
        }
        const items = Array.isArray(result?.items) ? result.items : []
        const files = Array.isArray(result?.files) ? result.files : []
        const open = openCount(items) + files.reduce((sum, file) => sum + openCount(file.items ?? []), 0)
        const total = items.length + files.reduce((sum, file) => sum + (file.items?.length ?? 0), 0)
        const before = state.seenOpen[sessionID]
        update((draft) => {
          draft.snapshots[sessionID] = { items, files, supervisor: result?.supervisor, at: Date.now() }
          draft.seenOpen[sessionID] = open
        })
        if (before !== undefined && before > 0 && open === 0 && total > 0) {
          context.ui.toast.show({ title: "todo-supervisor", message: "All todos done 🎉", variant: "success", sessionID })
        }
      } catch (err) {
        logFile("tui", `refresh(${sessionID}) failed: ${String(err)}`)
      }
    }

    const offUpdated = rpc.events.on("updated", (event) => {
      const sessionID = (event.data as { sessionID?: unknown }).sessionID
      if (typeof sessionID === "string") void refresh(sessionID)
    })
    const offNudged = rpc.events.on("nudged", (event) => {
      const data = event.data as { sessionID?: unknown }
      if (typeof data.sessionID === "string") {
        void refresh(data.sessionID)
        try {
          context.ui.toast.show({
            title: "todo-supervisor",
            message: "Continuing open todos…",
            variant: "info",
            sessionID: data.sessionID,
          })
        } catch (err) {
          logFile("tui", `nudged toast failed: ${String(err)}`)
        }
      }
    })

    // ---- components ---------------------------------------------------------

    function Strip(props: { sessionID: string }) {
      const themed = usePlugin()
      createEffect(() => {
        void refresh(props.sessionID)
      })
      const snap = () => state.snapshots[props.sessionID]
      const items = () => snap()?.items ?? []
      const files = () => snap()?.files ?? []
      const visible = () => items().length > 0 || files().length > 0
      const sessionOpen = () => openCount(items())
      const fileOpen = () => files().reduce((sum, file) => sum + openCount(file.items ?? []), 0)
      return (
        <Show when={visible()}>
          <text fg={themed.theme?.text?.base}>
            {"📋 " + (sessionOpen() + fileOpen()) + " open · session " + sessionOpen() + " · files " + fileOpen()}
          </text>
        </Show>
      )
    }

    function TodoPanel(props: { panel: PanelInput }) {
      const themed = usePlugin()
      const [cursor, setCursor] = createSignal(0)
      const sessionID = () => props.panel.sessionID
      const snap = () => state.snapshots[sessionID()]
      const items = () => snap()?.items ?? []
      const files = () => snap()?.files ?? []
      createEffect(() => {
        void refresh(sessionID())
      })

      const clamped = () => (items().length === 0 ? 0 : Math.min(cursor(), items().length - 1))

      context.keymap.layer(() => ({
        commands: [
          {
            id: "todo-supervisor.panel.up",
            title: "Todo: select previous",
            bind: "up",
            run: () => setCursor(Math.max(0, clamped() - 1)),
          },
          {
            id: "todo-supervisor.panel.down",
            title: "Todo: select next",
            bind: "down",
            run: () => setCursor(Math.min(Math.max(0, items().length - 1), clamped() + 1)),
          },
          {
            id: "todo-supervisor.panel.toggle",
            title: "Todo: toggle complete",
            bind: "x",
            run: () => {
              const index = clamped()
              if (!items()[index]) return
              guard("toggle", () => rpc.toggle({ sessionID: sessionID(), index }))
            },
          },
          {
            id: "todo-supervisor.panel.nudge",
            title: "Todo: nudge now",
            bind: "n",
            run: () =>
              guard("nudge", async () => {
                await rpc.nudge({ sessionID: sessionID() })
                context.ui.toast.show({ title: "todo-supervisor", message: "Nudge sent", variant: "success" })
              }),
          },
          {
            id: "todo-supervisor.panel.clear",
            title: "Todo: clear list",
            bind: "c",
            run: () =>
              guard("clear", async () => {
                const ok = await context.ui.dialog.confirm({
                  title: "Clear todos",
                  message: "Remove the session todo list? Markdown subscriptions stay.",
                  label: { confirm: "Clear", cancel: "Cancel" },
                })
                if (ok) await rpc.clear({ sessionID: sessionID() })
              }),
          },
          {
            id: "todo-supervisor.panel.refresh",
            title: "Todo: refresh",
            bind: "r",
            run: () => void refresh(sessionID()),
          },
          {
            id: "todo-supervisor.panel.add",
            title: "Todo: add file",
            bind: "a",
            run: () =>
              guard("add file", async () => {
                const path = await context.ui.dialog.prompt({
                  title: "Subscribe to a markdown file",
                  description: "Checklist items in the file count as todos.",
                  placeholder: "TODO.md",
                })
                if (!path) return
                await rpc.subscribe({ sessionID: sessionID(), path })
                context.ui.toast.show({ title: "todo-supervisor", message: `Subscribed: ${path}`, variant: "success" })
              }),
          },
          {
            id: "todo-supervisor.panel.remove",
            title: "Todo: remove file",
            bind: "d",
            run: () =>
              guard("remove file", async () => {
                const list = files()
                if (list.length === 0) {
                  context.ui.toast.show({ title: "todo-supervisor", message: "No subscribed files", variant: "warning" })
                  return
                }
                const choice = await context.ui.dialog.select({
                  title: "Unsubscribe file",
                  options: list.map((file) => ({ title: context.ui.format.path(file.path), value: file.path })),
                })
                if (!choice) return
                await rpc.unsubscribe({ sessionID: sessionID(), path: choice })
                context.ui.toast.show({ title: "todo-supervisor", message: "Unsubscribed", variant: "success" })
              }),
          },
          {
            id: "todo-supervisor.panel.fullscreen",
            title: "Todo: fullscreen",
            bind: "f",
            run: () => props.panel.toggleFullscreen(),
          },
          {
            id: "todo-supervisor.panel.close",
            title: "Todo: close",
            bind: "escape",
            run: () => props.panel.close(),
          },
        ],
      }))

      const supervisorLine = () => {
        const sup = snap()?.supervisor
        if (!sup) return "supervision: —"
        if (sup.paused === true) return "supervision: paused (" + String(sup.pauseReason ?? "paused") + ")"
        return "supervision: " + String(sup.status ?? "unknown") + " · nudges " + String(sup.nudges ?? 0)
      }

      return (
        <box flexDirection="column">
          <text>{"Todos — " + openCount(items()) + " open of " + items().length}</text>
          <text>{supervisorLine()}</text>
          <text>{"up/down move · x toggle · n nudge · c clear · r refresh · a add · d remove · f fullscreen"}</text>
          <Show when={items().length === 0}>
            <text>{"(no session todos — the agent records them with todo_write)"}</text>
          </Show>
          <For each={items()}>
            {(item, index) => (
              <text>
                {(index() === clamped() ? "> " : "  ") +
                  statusMark(item.status) +
                  " " +
                  item.content +
                  (item.priority ? " (" + item.priority + ")" : "")}
              </text>
            )}
          </For>
          <For each={files()}>
            {(file) => (
              <box flexDirection="column">
                <text>
                  {"— " +
                    (file.exists ? "" : "(missing) ") +
                    context.ui.format.path(file.path) +
                    " · " +
                    openCount(file.items ?? []) +
                    " open"}
                </text>
                <For each={file.items ?? []}>
                  {(item) => (
                    <text>
                      {"    " + statusMark(item.status) + " " + item.content + (item.line ? " :" + item.line : "")}
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      )
    }

    // ---- slots, commands ----------------------------------------------------

    const disposeStrip = context.ui.slot({
      append: "session.composer.top",
      render: (input) => <Strip sessionID={input.sessionID} />,
    })
    const disposePanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "todo.todos"}>
          <TodoPanel panel={panel} />
        </Show>
      ),
    })
    logFile("tui", "slots registered (session.composer.top, session.panel todo.todos)")

    const currentSessionID = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "todo-supervisor.open",
          title: "Todo: open list",
          description: "Open the todo panel; /todos add <path> or /todos remove <path> manages files",
          group: "Todo",
          palette: true,
          slash: { name: "todos", arguments: true },
          run: (input) => {
            const args = String(input ?? "")
              .trim()
              .split(/\s+/)
              .filter(Boolean)
            const sessionID = currentSessionID()
            const inSession = (action: (id: string) => Promise<unknown>) => {
              if (!sessionID) {
                context.ui.toast.show({ title: "todo-supervisor", message: "Open a session first", variant: "warning" })
                return
              }
              guard("todos", () => action(sessionID))
            }
            if (args[0] === "add" && args[1]) {
              const path = args[1]
              inSession(async (id) => {
                await rpc.subscribe({ sessionID: id, path })
                context.ui.toast.show({ title: "todo-supervisor", message: `Subscribed: ${path}`, variant: "success" })
              })
              return
            }
            if (args[0] === "remove" && args[1]) {
              const path = args[1]
              inSession(async (id) => {
                await rpc.unsubscribe({ sessionID: id, path })
                context.ui.toast.show({ title: "todo-supervisor", message: "Unsubscribed", variant: "success" })
              })
              return
            }
            if (!context.ui.panel.open("todo.todos")) {
              context.ui.toast.show({ title: "todo-supervisor", message: "Open a session to view todos", variant: "warning" })
            }
          },
        },
      ],
    }))

    logFile("tui", "ready")
    return () => {
      offUpdated()
      offNudged()
      disposeStrip()
      disposePanel()
      logFile("tui", "disposed")
    }
    }
  },
})
