// todo-supervisor — markdown mode unit tests (§5.8, aspect 14a).
import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import {
  displayPath,
  effectiveFiles,
  MarkdownCache,
  openMarkdownItems,
  parseChecklist,
  renderFileSection,
  resolveMarkdownPath,
  toggleMarkdownItem,
} from "./markdown"

describe("markdown parser (§5.8)", () => {
  test("parses bullets, ordered lists, indentation and states with 1-based line numbers", () => {
    const content = [
      "# Title",
      "- [ ] first",
      "  * [x] nested done",
      "1. [ ] ordered",
      "3) [X] upper done",
      "- [~] canceled",
      "plain text",
      "- not a checkbox",
    ].join("\n")
    const items = parseChecklist(content, "/p/TODO.md")
    expect(items.map((entry) => [entry.line, entry.state, entry.text])).toEqual([
      [2, "open", "first"],
      [3, "completed", "nested done"],
      [4, "open", "ordered"],
      [5, "completed", "upper done"],
      [6, "canceled", "canceled"],
    ])
    expect(items[1]!.indent).toBe("  ")
  })

  test("skips backtick and tilde fenced code blocks", () => {
    const content = [
      "- [ ] real",
      "```md",
      "- [ ] inside backticks",
      "```",
      "~~~",
      "- [ ] inside tildes",
      "~~~",
      "- [x] after",
    ].join("\n")
    const items = parseChecklist(content, "/p/TODO.md")
    expect(items.map((entry) => entry.text)).toEqual(["real", "after"])
  })

  test("handles CRLF line endings", () => {
    const items = parseChecklist("- [ ] a\r\n- [~] b\r\n", "/p/TODO.md")
    expect(items.map((entry) => entry.state)).toEqual(["open", "canceled"])
  })
})

describe("markdown subscriptions (§5.8)", () => {
  test("resolves and validates paths", () => {
    expect(resolveMarkdownPath("/proj", "docs/TODO.md")).toBe("/proj/docs/TODO.md")
    expect(resolveMarkdownPath("/proj", "/abs/PLAN.markdown")).toBe("/abs/PLAN.markdown")
    expect(resolveMarkdownPath("/proj", "UPPER.MD")).toBe("/proj/UPPER.MD")
    expect(() => resolveMarkdownPath("/proj", "notes.txt")).toThrow(/markdown/)
    expect(() => resolveMarkdownPath("/proj", "   ")).toThrow()
  })

  test("merges config, stored files and removed shadows", () => {
    const options = { markdownFiles: ["PLAN.md", "/abs/OTHER.md"] }
    const subs = { files: ["/proj/docs/TODO.md", "/abs/OTHER.md"], removed: ["/proj/PLAN.md"] }
    expect(effectiveFiles(options, "/proj", subs)).toEqual(["/abs/OTHER.md", "/proj/docs/TODO.md"])
    expect(effectiveFiles(options, "/proj", undefined)).toEqual(["/abs/OTHER.md", "/proj/PLAN.md"])
  })
})

describe("markdown cache + renderer", () => {
  test("caches by mtime/size, invalidates, and reports missing files", () => {
    const dir = "/tmp/opencode"
    mkdirSync(dir, { recursive: true })
    const file = `${dir}/md-cache-${process.pid}.md`
    writeFileSync(file, "- [ ] one\n")
    const cache = new MarkdownCache()
    const first = cache.parse(file)
    expect(first.exists).toBe(true)
    expect(first.items.length).toBe(1)
    expect(cache.parse(file)).toBe(first)
    cache.invalidate(file)
    expect(cache.parse(file)).not.toBe(first)
    const missing = cache.parse(`${dir}/missing-${process.pid}.md`)
    expect(missing.exists).toBe(false)
    expect(missing.items).toEqual([])
  })

  test("toggles a checklist item in place, fence-aware and format-preserving", () => {
    const dir = "/tmp/opencode"
    mkdirSync(dir, { recursive: true })
    const file = `${dir}/md-toggle-${process.pid}.md`
    writeFileSync(
      file,
      ["# List", "  - [ ] nested item  ", "```md", "- [ ] fenced", "```", "1) [x] done\r"].join("\r\n"),
    )
    // open -> completed, indentation/bullet/trailing spaces preserved
    expect(toggleMarkdownItem(file, 2)).toBe("completed")
    expect(readFileSync(file, "utf8")).toContain("  - [x] nested item  ")
    // completed -> open
    expect(toggleMarkdownItem(file, 6)).toBe("open")
    expect(readFileSync(file, "utf8")).toContain("1) [ ] done")
    // CRLF line endings survive the rewrite
    expect(readFileSync(file, "utf8").split("\n").length).toBe(6)
    // a fenced look-alike is not an item
    expect(() => toggleMarkdownItem(file, 4)).toThrow(/no checklist item/)
    // a plain line is not an item either
    expect(() => toggleMarkdownItem(file, 1)).toThrow(/no checklist item/)
  })

  test("renders path:line sections and open items", () => {
    const path = "/proj/docs/TODO.md"
    const parsed = {
      path,
      exists: true,
      items: [
        { path, line: 3, text: "do it", indent: "", state: "open" as const },
        { path, line: 4, text: "done", indent: "", state: "completed" as const },
      ],
    }
    const section = renderFileSection(parsed, "/proj")
    expect(section).toContain("## docs/TODO.md (1 open of 2)")
    expect(section).toContain("- [ ] do it  (docs/TODO.md:3)")
    expect(section).toContain("- [x] done  (docs/TODO.md:4)")
    expect(openMarkdownItems([parsed]).map((item) => item.text)).toEqual(["do it"])
    expect(displayPath("/proj", path)).toBe("docs/TODO.md")
    expect(displayPath("/proj", "/elsewhere/x.md")).toBe("/elsewhere/x.md")
    expect(renderFileSection({ path: "/proj/gone.md", exists: false, items: [] }, "/proj")).toContain("missing")
  })
})
