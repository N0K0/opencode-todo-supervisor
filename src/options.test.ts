import { describe, expect, test } from "bun:test"
import { DEFAULTS, parseOptions } from "./options"

describe("parseOptions", () => {
  test("uses defaults for absent input", () => {
    expect(parseOptions(undefined)).toEqual(DEFAULTS)
    expect(parseOptions(null)).toEqual(DEFAULTS)
    expect(parseOptions({})).toEqual(DEFAULTS)
  })

  test("invalid values fall back to defaults", () => {
    const options = parseOptions({
      stallMinutes: "x",
      settleMs: -5,
      enabled: "yes",
      scope: "nope",
      allowMultipleActive: 1,
      markdownFiles: [1, 2],
      minNudgeIntervalMs: Number.NaN,
    })
    expect(options).toEqual(DEFAULTS)
  })

  test("non-object input falls back to defaults", () => {
    expect(parseOptions("nope")).toEqual(DEFAULTS)
    expect(parseOptions([1, 2])).toEqual(DEFAULTS)
  })

  test("valid values are taken; unknown keys ignored", () => {
    const options = parseOptions({
      stallMinutes: 2,
      scope: "all",
      enabled: false,
      allowMultipleActive: true,
      markdownFiles: [" TODO.md ", "", "plans/x.md"],
      unknown: true,
    })
    expect(options.stallMinutes).toBe(2)
    expect(options.scope).toBe("all")
    expect(options.enabled).toBe(false)
    expect(options.allowMultipleActive).toBe(true)
    expect(options.markdownFiles).toEqual(["TODO.md", "plans/x.md"])
    expect((options as Record<string, unknown>)["unknown"]).toBeUndefined()
  })

  test("allowMultipleActive defaults to off and rejects non-booleans", () => {
    expect(DEFAULTS.allowMultipleActive).toBe(false)
    expect(parseOptions({ allowMultipleActive: true }).allowMultipleActive).toBe(true)
    expect(parseOptions({ allowMultipleActive: false }).allowMultipleActive).toBe(false)
    expect(parseOptions({ allowMultipleActive: "yes" }).allowMultipleActive).toBe(false)
  })
})
