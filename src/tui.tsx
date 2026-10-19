/** @jsxImportSource @opentui/solid */
// todo-supervisor — OpenCode V2 CLI (TUI) plugin (PLAN.md §6, aspect 12).
//
// Contributions:
// - composer strip (`session.composer.top`): one-line progress chip;
// - **popover**: `context.ui.dialog.show()` renders the todo list as a centered
//   overlay, exactly like the host's own dialogs (`/todos` and the palette);
// - side panel (`session.panel`, name `todo.todos`): the same list, docked to
//   the session panel (palette "Todo: open side panel");
// - toasts on `nudged` and on the all-done transition;
// - RPC events (`updated`/`nudged`) keep a memory-store snapshot fresh.
//
// All layout math lives in ./panel.ts (pure, unit-tested); this file only maps
// rows to OpenTUI elements. Only the server plugin may write markdown files —
// the UI calls RPC `toggleFile`, which rewrites the checkbox in place.
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { Plugin, usePlugin, type Context } from "@opencode/plugin/tui"
import { logFile } from "./log"
import {
  buildRows,
  clampCursor,
  countOpen,
  dialogWidth,
  footerHints,
  idTag,
  itemColumns,
  moveCursor,
  panelKeys,
  popoverBodyHeight,
  popoverKeys,
  priorityTag,
  progressBar,
  rowIndex,
  statusMark,
  supervisorChip,
  truncate,
  type DialogSizeName,
  type PanelSnapshot,
  type Row,
} from "./panel"
import { TodoRpc } from "./rpc"

type Store = { snapshots: Record<string, PanelSnapshot>; seenOpen: Record<string, number> }
type DialogSize = DialogSizeName

const SIZE_ORDER: DialogSize[] = ["medium", "large", "xlarge"]
/** The popover opens at the widest preset the host offers. */
const DEFAULT_DIALOG_SIZE: DialogSize = "xlarge"

/** Defensive theme reader: unknown token shapes degrade to no color. */
function themeColor(theme: unknown, path: string): string | undefined {
  let node: unknown = theme
  for (const key of path.split(".")) {
    if (!node || typeof node !== "object") return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return typeof node === "string" ? node : undefined
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

      // Render-region width, kept reactive for resize (renderer.width is the
      // region the TUI owns; `terminalWidth` would include any split footer).
      const rendererWidth = () => {
        const renderer = context.renderer as unknown as {
          width?: number
          root?: { width?: number }
        }
        const width = renderer.width ?? renderer.root?.width
        return typeof width === "number" && width > 0 ? width : 100
      }
      const [viewportWidth, setViewportWidth] = createSignal(rendererWidth())
      // Render-region height, reactive for resize (bounds the popover body).
      const rendererHeight = () => {
        const renderer = context.renderer as unknown as {
          height?: number
          root?: { height?: number }
        }
        const height = renderer.height ?? renderer.root?.height
        return typeof height === "number" && height > 0 ? height : 24
      }
      const [viewportHeight, setViewportHeight] = createSignal(rendererHeight())
      // The tty's own row count. The renderer's height can overstate the visible
      // area, and the dialog card hugs its content — so this is the hard ceiling
      // the card has to fit inside.
      const terminalRows = () => {
        const rows = (process as unknown as { stdout?: { rows?: number } }).stdout?.rows
        return typeof rows === "number" && rows > 0 ? rows : undefined
      }
      const onResize = (width: number, height: number) => {
        if (typeof width === "number" && width > 0) setViewportWidth(width)
        if (typeof height === "number" && height > 0) setViewportHeight(height)
      }
      try {
        context.renderer.on?.("resize" as never, onResize as never)
      } catch (err) {
        logFile("tui", `resize subscribe failed: ${String(err)}`)
      }

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

      const notify = (message: string, variant: "info" | "success" | "warning" = "info"): void => {
        try {
          context.ui.toast.show({ title: "todo-supervisor", message, variant })
        } catch (err) {
          logFile("tui", `toast failed: ${String(err)}`)
        }
      }

      const refresh = async (sessionID: string) => {
        try {
          const result = (await rpc.list({ sessionID })) as PanelSnapshot | undefined
          const items = Array.isArray(result?.items) ? result.items : []
          const files = Array.isArray(result?.files) ? result.files : []
          const open = countOpen(items) + files.reduce((sum, file) => sum + countOpen(file.items ?? []), 0)
          const total = items.length + files.reduce((sum, file) => sum + (file.items?.length ?? 0), 0)
          const before = state.seenOpen[sessionID]
          update((draft) => {
            draft.snapshots[sessionID] = { items, files, supervisor: result?.supervisor }
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
        const data = event.data as { sessionID?: unknown; reason?: unknown }
        if (typeof data.sessionID === "string") {
          void refresh(data.sessionID)
          try {
            context.ui.toast.show({
              title: "todo-supervisor",
              message: data.reason === "stalled-task" ? "Checking stalled work…" : "Continuing open todos…",
              variant: data.reason === "stalled-task" ? "warning" : "info",
              sessionID: data.sessionID,
            })
          } catch (err) {
            logFile("tui", `nudged toast failed: ${String(err)}`)
          }
        }
      })

      // ---- composer strip ---------------------------------------------------

      function Strip(props: { sessionID: string }) {
        const themed = usePlugin()
        createEffect(() => {
          void refresh(props.sessionID)
        })
        const snap = () => state.snapshots[props.sessionID]
        const items = () => snap()?.items ?? []
        const files = () => snap()?.files ?? []
        const total = () => items().length + files().reduce((sum, file) => sum + (file.items?.length ?? 0), 0)
        const open = () => countOpen(items()) + files().reduce((sum, file) => sum + countOpen(file.items ?? []), 0)
        const paused = () => snap()?.supervisor?.paused === true
        const label = () => {
          if (!snap()) return "📋 …"
          if (total() === 0) return "📋 no todos"
          return (
            "📋 " +
            progressBar(total() - open(), total(), 8) +
            " " +
            open() +
            "/" +
            total() +
            " open" +
            (paused() ? " · ⏸" : "")
          )
        }
        return (
          <text fg={total() > 0 ? themeColor(themed.theme, "text.base") : themeColor(themed.theme, "text.muted")}>
            {label()}
          </text>
        )
      }

      // ---- the list (shared by the popover and the side panel) --------------

      type ListProps = {
        sessionID: string
        /** Keymap layer is only live while this is true. */
        active: () => boolean
        /** Available content width (dialog width or panel width). */
        width: () => number
        /** Bounded body rows (popover); undefined lets the host size the panel. */
        height?: () => number
        close: () => void
        /** Popover only: cycle the dialog size (medium → large → xlarge). */
        cycleSize?: () => void
      }

      function TodoList(props: ListProps) {
        const themed = usePlugin()
        const [selected, setSelected] = createSignal<string | undefined>(undefined)
        const [filter, setFilter] = createSignal("")
        const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set<string>())
        let scrollNode: {
          scrollChildIntoView?: (id: string) => void
          scrollTop?: number
        } | undefined

        const sessionID = () => props.sessionID
        const width = () => Math.max(30, props.width())
        const snap = (): PanelSnapshot => state.snapshots[sessionID()] ?? { items: [], files: [] }
        const rows = createMemo(() =>
          buildRows(snap(), {
            filter: filter(),
            collapsed: collapsed(),
            formatPath: (path) => context.ui.format.path(path),
          }),
        )
        const cursor = createMemo(() => clampCursor(rows(), selected()))
        const current = createMemo(() => rows().find((row) => row.key === cursor()))
        const rowId = (key: string) => `todo-row-${key}`

        const base = () => themeColor(themed.theme, "text.base")
        const muted = () => themeColor(themed.theme, "text.muted")
        const accent = () => themeColor(themed.theme, "text.action.primary.base") ?? base()
        const selectedBg = () =>
          themeColor(themed.theme, "background.raised.high") ?? themeColor(themed.theme, "background.raised.base")

        createEffect(() => {
          void refresh(sessionID())
        })
        const poll = setInterval(() => void refresh(sessionID()), 3000)
        onCleanup(() => clearInterval(poll))

        // Keep the selected row on screen without owning the viewport height:
        // `scrollChildIntoView` uses nearest-edge behaviour; `scrollTop = index`
        // (row height is one line) is a guaranteed-visible fallback.
        createEffect(() => {
          const key = cursor()
          if (!key || !scrollNode) return
          try {
            if (typeof scrollNode.scrollChildIntoView === "function") {
              scrollNode.scrollChildIntoView(rowId(key))
              return
            }
            if (typeof scrollNode.scrollTop === "number") {
              scrollNode.scrollTop = Math.max(0, rowIndex(rows(), key))
            }
          } catch {
            // scrolling is best-effort
          }
        })

        const move = (delta: number) => setSelected(moveCursor(rows(), cursor(), delta))
        const jumpHome = () => setSelected(moveCursor(rows(), undefined, 0))
        const jumpEnd = () => setSelected(moveCursor(rows(), cursor(), Number.MAX_SAFE_INTEGER))

        const toggleCollapse = (path: string) =>
          setCollapsed((previous) => {
            const next = new Set(previous)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
          })

        const toggleSelected = () => {
          const row = current()
          if (!row) return
          if (row.kind === "file") {
            toggleCollapse(row.path)
            return
          }
          if (row.kind !== "item") return
          if (row.source === "session" && row.index !== undefined) {
            guard("toggle", () => rpc.toggle({ sessionID: sessionID(), index: row.index! }))
            return
          }
          if (row.path && row.line !== undefined) {
            guard("toggle file item", () => rpc.toggleFile({ sessionID: sessionID(), path: row.path!, line: row.line! }))
          }
        }

        const addFile = () =>
          guard("add file", async () => {
            const path = await context.ui.dialog.prompt({
              title: "Subscribe to a markdown file",
              description: "Checklist items in the file count as todos.",
              placeholder: "TODO.md",
            })
            if (!path) return
            await rpc.subscribe({ sessionID: sessionID(), path })
            notify(`Subscribed: ${path}`, "success")
          })

        const removeFile = () =>
          guard("remove file", async () => {
            const row = current()
            const direct = row && row.kind === "file" ? row.path : row && row.kind === "item" ? row.path : undefined
            const files = snap().files
            if (files.length === 0) {
              notify("No subscribed files", "warning")
              return
            }
            const path =
              direct ??
              (await context.ui.dialog.select({
                title: "Unsubscribe file",
                options: files.map((file) => ({ title: context.ui.format.path(file.path), value: file.path })),
              }))
            if (!path) return
            await rpc.unsubscribe({ sessionID: sessionID(), path })
            notify("Unsubscribed", "success")
          })

        const addTask = () =>
          guard("add task", async () => {
            const content = await context.ui.dialog.prompt({
              title: "Add todo",
              description: "Press p on the new row to set its priority.",
              placeholder: "what needs doing?",
            })
            if (!content || !content.trim()) return
            const result = (await rpc.addItem({ sessionID: sessionID(), content })) as { id?: string } | undefined
            notify(result?.id ? `Added #${result.id}` : "Added", "success")
          })

        /** The selected row, when it is an editable session item. */
        const selectedSessionItem = (): Extract<Row, { kind: "item" }> | undefined => {
          const row = current()
          return row && row.kind === "item" && row.source === "session" && row.id ? row : undefined
        }

        const removeTask = () => {
          const row = current()
          if (!row || row.kind !== "item") {
            notify("Select a task first", "warning")
            return
          }
          if (row.source === "file" || !row.id) {
            notify("File items are removed by editing the file", "warning")
            return
          }
          const { id, content } = row
          guard("remove task", async () => {
            const ok = await context.ui.dialog.confirm({
              title: "Remove task",
              message: `Remove #${id}: ${truncate(content, 48)}?`,
              label: { confirm: "Remove", cancel: "Cancel" },
            })
            if (!ok) return
            await rpc.removeItem({ sessionID: sessionID(), id })
            notify(`Removed #${id}`, "success")
          })
        }

        const cyclePriority = () => {
          const row = selectedSessionItem()
          if (!row || !row.id) {
            notify("Select a task first", "warning")
            return
          }
          const id = row.id
          const next =
            row.priority === undefined
              ? "low"
              : row.priority === "low"
                ? "medium"
                : row.priority === "medium"
                  ? "high"
                  : "none"
          guard("priority", async () => {
            await rpc.setPriority({ sessionID: sessionID(), id, priority: next })
            notify(next === "none" ? `#${id} priority cleared` : `#${id} priority: ${next}`, "success")
          })
        }

        const pauseResume = () => {
          const paused = snap().supervisor?.paused === true
          guard("supervision", async () => {
            await rpc.setEnabled({ sessionID: sessionID(), enabled: paused })
            notify(paused ? "Supervision resumed" : "Supervision paused", paused ? "success" : "warning")
          })
        }

        const applyFilter = () =>
          guard("filter", async () => {
            const value = await context.ui.dialog.prompt({
              title: "Filter todos",
              description: "Case-insensitive substring match; empty clears the filter.",
              value: filter() ?? undefined,
              placeholder: "search",
            })
            if (value === undefined) return
            setFilter(value)
            setSelected(undefined)
          })

        context.keymap.layer(() => ({
          // "global" keeps the layer mode-agnostic; the actual gating is done
          // per command below.
          mode: "global",
          priority: 10,
          commands: [
            { title: "Todo: select next", bind: "down", run: () => move(1) },
            { title: "Todo: select previous", bind: "up", run: () => move(-1) },
            { bind: "j", run: () => move(1) },
            { bind: "k", run: () => move(-1) },
            { title: "Todo: next page", bind: "pagedown", run: () => move(10) },
            { title: "Todo: previous page", bind: "pageup", run: () => move(-10) },
            { title: "Todo: first", bind: "home", run: jumpHome },
            { title: "Todo: last", bind: "end", run: jumpEnd },
            { bind: "g", run: jumpHome },
            { bind: "G", run: jumpEnd },
            { title: "Todo: toggle item", bind: "space", run: toggleSelected },
            { title: "Todo: toggle item", bind: "x", run: toggleSelected },
            {
              title: "Todo: collapse section",
              bind: "enter",
              run: () => {
                const row = current()
                if (row?.kind === "file") toggleCollapse(row.path)
              },
            },
            {
              title: "Todo: nudge now",
              bind: "n",
              run: () =>
                guard("nudge", async () => {
                  await rpc.nudge({ sessionID: sessionID() })
                  notify("Nudge sent", "success")
                }),
            },
            { title: "Todo: pause/resume supervision", bind: "s", run: pauseResume },
            { title: "Todo: add task", bind: "a", run: addTask },
            { title: "Todo: remove task", bind: "d", run: removeTask },
            { title: "Todo: cycle priority", bind: "p", run: cyclePriority },
            { title: "Todo: add markdown file", bind: "A", run: addFile },
            { title: "Todo: remove markdown file", bind: "D", run: removeFile },
            {
              title: "Todo: refresh",
              bind: "r",
              run: () =>
                guard("refresh", async () => {
                  await refresh(sessionID())
                  notify("Refreshed")
                }),
            },
            { title: "Todo: filter", bind: "/", run: applyFilter },
            {
              title: "Todo: resize",
              bind: "f",
              run: () => props.cycleSize?.(),
            },
            {
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
              title: "Todo: help",
              bind: "?",
              run: () =>
                guard("help", async () => {
                  await context.ui.dialog.alert({
                    title: "Todo panel",
                    message:
                      "↑↓/jk move · space/x toggle · enter collapse · n nudge · s pause/resume\n" +
                      "a add task · d remove task · p priority · A add file · D remove file\n" +
                      "r refresh · / filter · f resize · c clear · esc close",
                  })
                }),
            },
            { title: "Todo: close", bind: "escape", run: () => props.close() },
            // The host drops a *layer*-level `enabled`; the *command*-level one
            // is consulted on every dispatch. Gate each key here so it yields —
            // and falls through — the moment an overlay (model picker, palette,
            // completion list, composer) owns the keyboard while a todo surface
            // happens to still be focused.
          ].map((command) => ({ ...command, enabled: () => props.active() })),
        }))

        const totals = () => {
          const current = snap()
          const total = current.items.length + current.files.reduce((sum, file) => sum + file.items.length, 0)
          const open = countOpen(current.items) + current.files.reduce((sum, file) => sum + countOpen(file.items), 0)
          return { total, open }
        }

        /** Selected position among selectable rows, e.g. `2/9` (windowed lists). */
        const position = () => {
          const selectable = rows().filter((row) => row.kind !== "section")
          const key = cursor()
          const index = selectable.findIndex((row) => row.key === key)
          return index === -1 ? undefined : { index: index + 1, total: selectable.length }
        }

        const bodyHeight = () => {
          const available = props.height?.()
          if (available === undefined) return undefined
          // The filter line, when shown, takes one row from the body budget.
          const filtered = (filter() ?? "") !== "" ? 1 : 0
          return Math.max(3, available - filtered)
        }

        // The scroll box never needs to be taller than the rows it holds, but a
        // short list still gets a proper panel rather than a sliver: fill a
        // comfortable share of the budget by default.
        const scrollHeight = () => {
          const budget = bodyHeight()
          if (budget === undefined) return undefined
          const floor = Math.max(8, Math.ceil(budget * 0.6))
          return Math.max(1, Math.min(budget, Math.max(rows().length, floor)))
        }

        const barWidth = () => Math.max(6, Math.min(40, Math.floor(width() * 0.25)))

        // Column widths for the `#id` / priority columns, sized to the list.
        const columns = createMemo(() => {
          const current = snap()
          return itemColumns([...current.items, ...current.files.flatMap((file) => file.items)])
        })
        const contentWidth = () =>
          Math.max(
            8,
            width() -
              6 -
              (columns().id > 0 ? columns().id + 2 : 0) -
              (columns().priority > 0 ? columns().priority + 2 : 0),
          )

        const renderRow = (row: Row) => {
          const isCurrent = () => row.key === cursor()
          const prefix = () => (isCurrent() ? "❯ " : "  ")
          const background = () => (isCurrent() ? selectedBg() : undefined)
          if (row.kind === "section") {
            return (
              <text fg={muted()} wrapMode="none">
                {prefix() + truncate(row.label + (row.detail ? "  ·  " + row.detail : ""), width() - 6)}
              </text>
            )
          }
          if (row.kind === "file") {
            const label = row.exists ? row.label : `${row.label} (missing)`
            const detail = `${row.open} open of ${row.total}`
            return (
              <box backgroundColor={background()}>
                <text fg={isCurrent() ? accent() : base()} wrapMode="none">
                  {prefix() + (row.collapsed ? "▸ " : "▾ ") + truncate(`${label}  ·  ${detail}`, width() - 6)}
                </text>
              </box>
            )
          }
          const cols = columns()
          const parts = [prefix() + statusMark(row.status)]
          if (cols.id > 0) parts.push(idTag(row.id).padEnd(cols.id))
          if (cols.priority > 0) parts.push(priorityTag(row.priority).padEnd(cols.priority))
          parts.push(truncate(row.content + (row.line !== undefined ? `  :${row.line}` : ""), contentWidth()))
          return (
            <box backgroundColor={background()}>
              <text fg={row.status === "completed" ? muted() : isCurrent() ? accent() : base()} wrapMode="none">
                {parts.join("  ")}
              </text>
            </box>
          )
        }

        return (
          <box flexDirection="column">
            <text height={1} fg={base()} wrapMode="none">
              {truncate(
                "Todos  " +
                  progressBar(totals().total - totals().open, totals().total, barWidth()) +
                  "  " +
                  `${totals().open}/${totals().total} open` +
                  (position() ? `  ·  row ${position()!.index}/${position()!.total}` : ""),
                width() - 2,
              )}
            </text>
            <text height={1} fg={muted()} wrapMode="none">
              {truncate("supervision: " + supervisorChip(snap().supervisor), width() - 2)}
            </text>
            <Show when={(filter() ?? "") !== ""}>
              <text height={1} fg={muted()} wrapMode="none">
                {truncate(`filter: "${filter()}"  (press / to change)`, width() - 2)}
              </text>
            </Show>
            <scrollbox
              ref={(node: unknown) => (scrollNode = node as typeof scrollNode)}
              height={scrollHeight()}
              flexGrow={scrollHeight() === undefined ? 1 : undefined}
            >
              <For each={rows()}>
                {(row) => (
                  <box id={rowId(row.key)} flexDirection="row">
                    {renderRow(row)}
                  </box>
                )}
              </For>
            </scrollbox>
            <text fg={muted()} wrapMode="none">
              {truncate(footerHints(width()).join("  ·  "), Math.max(10, width() - 2))}
            </text>
          </box>
        )
      }

      // ---- popover (an overlay dialog, like the host's own panes) -----------

      function TodoPopover(props: { sessionID: string }) {
        const [size, setSize] = createSignal<DialogSize>(DEFAULT_DIALOG_SIZE)
        // The host defaults a dialog to *not* centered (the card is pinned a
        // quarter of the way down and only the first `f` used to flip it). Assert
        // it as soon as we are the active dialog, so it opens where the user
        // expects and `f` only ever changes the size.
        createEffect(() => {
          try {
            context.ui.dialog.set({ size: size(), centered: true })
          } catch (err) {
            logFile("tui", `dialog apply failed: ${String(err)}`)
          }
        })
        const cycleSize = () => {
          const next = SIZE_ORDER[(SIZE_ORDER.indexOf(size()) + 1) % SIZE_ORDER.length]!
          setSize(next)
        }
        return (
          <TodoList
            sessionID={props.sessionID}
            active={() => popoverKeys(context.keymap.mode.current())}
            width={() => dialogWidth(size(), viewportWidth())}
            height={() => popoverBodyHeight(viewportHeight(), 0, terminalRows())}
            close={() => context.ui.dialog.clear()}
            cycleSize={cycleSize}
          />
        )
      }

      const openPopover = (sessionID: string): boolean => {
        try {
          context.ui.dialog.show(
            () => <TodoPopover sessionID={sessionID} />,
            () => logFile("tui", "popover closed"),
          )
          // `show` resets the presentation (it sets `centered` back to false), so
          // the options have to be applied *after* it, or the popover opens
          // anchored a quarter of the way down.
          context.ui.dialog.set({ size: DEFAULT_DIALOG_SIZE, centered: true })
          return true
        } catch (err) {
          toastError("open popover", err)
          return false
        }
      }

      // ---- slots, commands --------------------------------------------------

      const disposeStrip = context.ui.slot({
        append: "session.composer.top",
        render: (input) => <Strip sessionID={input.sessionID} />,
      })
      const disposePanel = context.ui.slot({
        append: "session.panel",
        render: (panel: PanelInput) => (
          <Show when={panel.name === "todo.todos"}>
            <TodoList
              sessionID={panel.sessionID}
              active={() => panelKeys(panel.focused, context.keymap.mode.current())}
              width={() => panel.width}
              close={() => panel.close()}
              cycleSize={() => panel.toggleFullscreen()}
            />
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
            title: "Todo: open todos",
            description: "Open the todo popover; /todos add <path> or /todos remove <path> manages files",
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
                  notify("Open a session first", "warning")
                  return
                }
                guard("todos", () => action(sessionID))
              }
              if (args[0] === "add" && args[1]) {
                const path = args[1]
                inSession(async (id) => {
                  await rpc.subscribe({ sessionID: id, path })
                  notify(`Subscribed: ${path}`, "success")
                })
                return
              }
              if (args[0] === "remove" && args[1]) {
                const path = args[1]
                inSession(async (id) => {
                  await rpc.unsubscribe({ sessionID: id, path })
                  notify("Unsubscribed", "success")
                })
                return
              }
              if (!sessionID) {
                notify("Open a session first", "warning")
                return
              }
              openPopover(sessionID)
            },
          },
          {
            id: "todo-supervisor.open-panel",
            title: "Todo: open side panel",
            description: "Dock the todo list to the session panel instead of the popover",
            group: "Todo",
            palette: true,
            run: () => {
              if (!context.ui.panel.open("todo.todos")) {
                notify("Open a session to view todos", "warning")
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
        try {
          context.renderer.off?.("resize" as never, onResize as never)
        } catch {
          // best-effort
        }
        logFile("tui", "disposed")
      }
    }
  },
})
