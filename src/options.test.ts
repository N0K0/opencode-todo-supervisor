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
      markdownFiles: [" TODO.md ", "", "plans/x.md"],
      unknown: true,
    })
    expect(options.stallMinutes).toBe(2)
    expect(options.scope).toBe("all")
    expect(options.enabled).toBe(false)
    expect(options.markdownFiles).toEqual(["TODO.md", "plans/x.md"])
    expect((options as Record<string, unknown>)["unknown"]).toBeUndefined()
  })
})
