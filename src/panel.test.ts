// todo-supervisor — pure panel helper tests (aspect 12).
import { describe, expect, test } from "bun:test"
import {
  buildRows,
  clampCursor,
  countOpen,
  dialogWidth,
  footerHints,
  idTag,
  isSelectable,
  itemColumns,
  moveCursor,
  panelKeys,
  popoverBodyHeight,
  popoverKeys,
  priorityTag,
  progressBar,
  quietLabel,
  statusMark,
  supervisorChip,
  truncate,
  visibleWindow,
  type PanelSnapshot,
} from "./panel"

const snapshot = (): PanelSnapshot => ({
  items: [
    { id: "1", content: "first task", status: "pending", priority: "high" },
    { id: "2", content: "second task", status: "in_progress" },
    { id: "3", content: "third task", status: "completed" },
  ],
  files: [
    {
      path: "/proj/docs/TODO.md",
      exists: true,
      items: [
        { content: "file item one", status: "pending", line: 3 },
        { content: "file item two", status: "completed", line: 4 },
      ],
    },
    { path: "/proj/GONE.md", exists: false, items: [] },
  ],
  supervisor: { registered: true, status: "idle", quietMs: 12_000, terminal: true, nudges: 2 },
})

describe("panel formatting", () => {
  test("status marks and open counts match todo_read", () => {
    expect([statusMark("completed"), statusMark("in_progress"), statusMark("canceled"), statusMark("pending")]).toEqual([
      "[x]",
      "[~]",
      "[~]",
      "[ ]",
    ])
    expect(countOpen([{ status: "completed" }, { status: "pending" }, { status: "in_progress" }])).toBe(2)
  })

  test("progress bar fills by ratio and degrades safely", () => {
    expect(progressBar(0, 8, 8)).toBe("░░░░░░░░")
    expect(progressBar(4, 8, 8)).toBe("████░░░░")
    expect(progressBar(8, 8, 8)).toBe("████████")
    expect(progressBar(1, 3, 0)).toBe("")
    expect(progressBar(0, 0, 4)).toBe("░░░░")
  })

  test("truncate collapses whitespace and ellipsises", () => {
    expect(truncate("  a   b  ", 10)).toBe("a b")
    expect(truncate("exact", 5)).toBe("exact")
    expect(truncate("too long here", 6)).toBe("too l…")
    expect(truncate("abc", 1)).toBe("…")
    expect(truncate("abc", 0)).toBe("")
  })

  test("quiet labels and the supervisor chip describe state", () => {
    expect(quietLabel(3_400)).toBe("3s")
    expect(quietLabel(80_000)).toBe("1m20s")
    expect(quietLabel(undefined)).toBe("—")

    expect(supervisorChip(undefined)).toBe("not supervised")
    expect(supervisorChip({ registered: false })).toBe("not supervised")
    expect(supervisorChip({ registered: true, paused: true, pauseReason: "no-progress", nudges: 3 })).toBe(
      "paused (no-progress) · nudges 3",
    )
    expect(
      supervisorChip({ registered: true, runningTools: 1, runningShells: 2, quietMs: 4_000 }),
    ).toBe("working: 1 tool · 2 shells · quiet 4s")
    expect(supervisorChip({ registered: true, terminal: false, quietMs: 90_000 })).toBe(
      "waiting for turn end · quiet 1m30s",
    )
    expect(supervisorChip({ registered: true, status: "idle", terminal: true, quietMs: 2_000, nudges: 1 })).toBe(
      "idle · quiet 2s · nudges 1",
    )
  })
})

describe("panel rows", () => {
  test("builds the session section, file sections and items", () => {
    const rows = buildRows(snapshot())
    expect(rows.map((row) => row.kind)).toEqual([
      "section",
      "item",
      "item",
      "item",
      "file",
      "item",
      "item",
      "file",
    ])
    const sessionHeader = rows[0]!
    expect(sessionHeader.kind === "section" && sessionHeader.detail).toBe("2 open of 3")
    const firstItem = rows[1]!
    expect(firstItem.kind === "item" && firstItem.key).toBe("session:0")
    expect(firstItem.kind === "item" && firstItem.id).toBe("1")
    expect(firstItem.kind === "item" && firstItem.priority).toBe("high")
    const fileRow = rows[4]!
    expect(fileRow.kind === "file" && fileRow.open).toBe(1)
    expect(fileRow.kind === "file" && fileRow.exists).toBe(true)
    const missing = rows[7]!
    expect(missing.kind === "file" && missing.exists).toBe(false)
  })

  test("collapsed files hide their items; formatPath is applied", () => {
    const rows = buildRows(snapshot(), { collapsed: new Set(["/proj/docs/TODO.md"]), formatPath: () => "docs/TODO.md" })
    expect(rows.filter((row) => row.kind === "item" && row.source === "file").length).toBe(0)
    const fileRow = rows.find((row) => row.kind === "file")!
    expect(fileRow.kind === "file" && fileRow.label).toBe("docs/TODO.md")
    expect(fileRow.kind === "file" && fileRow.collapsed).toBe(true)
  })

  test("filter hides non-matching items and whole sections", () => {
    const rows = buildRows(snapshot(), { filter: "FILE ITEM ONE" })
    expect(rows.filter((row) => row.kind === "item").map((row) => row.kind === "item" && row.content)).toEqual([
      "file item one",
    ])
    expect(rows.some((row) => row.kind === "section")).toBe(false)
    const none = buildRows(snapshot(), { filter: "zzz" })
    expect(none.length).toBe(1)
    expect(none[0]!.kind === "section" && none[0]!.label).toBe("no matches")
  })

  test("empty and all-done states", () => {
    const empty = buildRows({ items: [], files: [] })
    expect(empty[0]!.kind === "section" && empty[0]!.label).toBe("no todos")
    const done = buildRows({ items: [{ content: "done", status: "completed" }], files: [] })
    expect(done.some((row) => row.kind === "section" && row.key === "section:done")).toBe(true)
    expect(done.some((row) => row.kind === "item")).toBe(true)
  })
})

describe("panel cursor", () => {
  test("clamp keeps a live key and falls back to the first selectable row", () => {
    const rows = buildRows(snapshot())
    expect(clampCursor(rows, "session:1")).toBe("session:1")
    expect(clampCursor(rows, "gone")).toBe("session:0")
    expect(clampCursor(rows, undefined)).toBe("session:0")
    expect(clampCursor([], "x")).toBe(undefined)
  })

  test("movement skips section headers and clamps at both ends", () => {
    const rows = buildRows(snapshot())
    expect(isSelectable(rows[0]!)).toBe(false)
    expect(moveCursor(rows, "session:0", 1)).toBe("session:1")
    expect(moveCursor(rows, "session:2", 1)).toBe("file:/proj/docs/TODO.md")
    expect(moveCursor(rows, "session:0", -1)).toBe("session:0")
    expect(moveCursor(rows, "file:/proj/GONE.md", 1)).toBe("file:/proj/GONE.md")
    expect(moveCursor([], "x", 1)).toBe(undefined)
  })

  test("the scroll window keeps the selected row visible", () => {
    const rows = buildRows(snapshot())
    expect(visibleWindow(rows, "session:0", 20)).toEqual({ start: 0, end: rows.length })
    const window = visibleWindow(rows, "file:/proj/GONE.md", 3)
    expect(window.end - window.start).toBe(3)
    expect(window.start).toBe(rows.length - 3)
  })

  test("footer hints shrink with the terminal width", () => {
    expect(footerHints(140).length).toBe(16)
    expect(footerHints(140)).toContain("a add task")
    expect(footerHints(140)).toContain("p priority")
    expect(footerHints(90).length).toBe(8)
    expect(footerHints(40)).toEqual(["↑↓", "space toggle", "n nudge", "/ filter", "? help", "esc"])
  })

  test("popover body height scales with the terminal", () => {
    expect(popoverBodyHeight(40)).toBe(28)
    expect(popoverBodyHeight(24)).toBe(16)
    expect(popoverBodyHeight(24, 1)).toBe(15)
    expect(popoverBodyHeight(14)).toBe(6)
    expect(popoverBodyHeight(50, 2)).toBe(35)
    // Never taller than a popover on a very tall terminal.
    expect(popoverBodyHeight(200)).toBe(48)
    // The tty's row count is a hard ceiling when the renderer overstates it.
    expect(popoverBodyHeight(200, 0, 24)).toBe(16)
    expect(popoverBodyHeight(40, 0, 24)).toBe(16)
  })

  test("popover width matches the host dialog card and clamps", () => {
    expect(dialogWidth("medium", 200)).toBe(60)
    expect(dialogWidth("large", 200)).toBe(88)
    expect(dialogWidth("xlarge", 200)).toBe(116)
    expect(dialogWidth("medium", 80)).toBe(60)
    expect(dialogWidth("large", 80)).toBe(78)
    expect(dialogWidth("xlarge", 80)).toBe(78)
    // Never wider than the window (minus the host card's 2-cell inset).
    expect(dialogWidth("xlarge", 20)).toBe(20)
  })

  test("the panel layer yields to overlays that own the keyboard", () => {
    // Normal session view: live while focused.
    expect(panelKeys(true, "base")).toBe(true)
    expect(panelKeys(false, "base")).toBe(false)
    // The model picker, dialogs, menus and completions all take the keyboard.
    for (const mode of ["modal", "menu", "autocomplete", "composer"]) {
      expect(panelKeys(true, mode)).toBe(false)
    }
    // Any other mode (including the plain session view) keeps the panel live.
    expect(panelKeys(true, "base")).toBe(true)
  })

  test("the popover keeps the keyboard in its own dialog", () => {
    expect(popoverKeys("modal")).toBe(true)
    expect(popoverKeys("base")).toBe(true)
    expect(popoverKeys("menu")).toBe(false)
    expect(popoverKeys("autocomplete")).toBe(false)
    expect(popoverKeys("composer")).toBe(false)
  })

  test("id and priority tags and their column widths", () => {
    expect(idTag(undefined)).toBe("")
    expect(idTag("12")).toBe("#12")
    expect(priorityTag(undefined)).toBe("")
    expect(priorityTag("high")).toBe("high")
    expect(priorityTag("medium")).toBe("med")
    expect(priorityTag("low")).toBe("low")
    expect(itemColumns([{ id: "3", priority: "high" }, { id: "12" }])).toEqual({ id: 3, priority: 4 })
    expect(itemColumns([{ content: "x", status: "pending" }])).toEqual({ id: 0, priority: 0 })
  })
})
