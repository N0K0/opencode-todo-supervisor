import { describe, expect, test } from "bun:test"
import { normalizeEvent, truncate } from "./supervisor"

describe("normalizeEvent", () => {
  test("accepts the SSE envelope shape", () => {
    const event = normalizeEvent({ id: "evt_1", type: "session.idle", data: { sessionID: "ses_1" } })
    expect(event).toEqual({ type: "session.idle", data: { sessionID: "ses_1" } })
  })

  test("accepts a bare event object", () => {
    const event = normalizeEvent({ type: "session.idle", sessionID: "ses_1" })
    expect(event).toEqual({ type: "session.idle", data: { type: "session.idle", sessionID: "ses_1" } })
  })

  test("falls back to the source when data is not an object", () => {
    const event = normalizeEvent({ type: "session.updated", data: "nope", sessionID: "ses_2" })
    expect(event?.type).toBe("session.updated")
    expect(event?.data.sessionID).toBe("ses_2")
  })

  test("rejects unusable input", () => {
    expect(normalizeEvent(undefined)).toBeUndefined()
    expect(normalizeEvent("session.idle")).toBeUndefined()
    expect(normalizeEvent({})).toBeUndefined()
    expect(normalizeEvent({ data: { sessionID: "ses_1" } })).toBeUndefined()
  })
})

describe("truncate", () => {
  test("passes short strings through", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  test("truncates long strings with a marker", () => {
    expect(truncate("x".repeat(20), 5)).toBe("xxxxx…(15 more)")
  })
})
