import { expect, test } from "bun:test"
import { decodeCommandEnvelope, encodeCommandEnvelope, parseCommandArguments } from "../src/command"

test("parses an unquoted target", () => {
  expect(parseCommandArguments("中文 Hello world")).toEqual({ to: "中文", text: "Hello world" })
})

test("parses a quoted target and preserves multiline text", () => {
  expect(parseCommandArguments('"Simplified Chinese" First\n\nSecond')).toEqual({
    to: "Simplified Chinese",
    text: "First\n\nSecond",
  })
})

test("round-trips unicode command content through the internal envelope", () => {
  const request = { to: "日本語", text: "你好 %% 世界" }
  expect(decodeCommandEnvelope(encodeCommandEnvelope(request))).toEqual(request)
})

test("rejects missing source text", () => {
  expect(() => parseCommandArguments("中文   ")).toThrow("/t")
})

test("does not mistake malformed prefixed user text for an envelope", () => {
  expect(decodeCommandEnvelope("__OPENCODE_TRANSLATOR_V1__:not-valid")).toBeUndefined()
  expect(decodeCommandEnvelope("ordinary text")).toBeUndefined()
})
