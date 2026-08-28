import { expect, test } from "bun:test"
import { COMMAND_ENVELOPE_PREFIX, decodeCommandEnvelope, encodeCommandEnvelope, parseCommandArguments } from "../src/command"

test("parses an unquoted target", () => {
  expect(parseCommandArguments("中文 Hello world")).toEqual({ to: "中文", text: "Hello world" })
})

test("parses a quoted target and preserves multiline text", () => {
  expect(parseCommandArguments('"Simplified Chinese" First\n\nSecond')).toEqual({
    to: "Simplified Chinese",
    text: "First\n\nSecond",
  })
})

test("reads a colon-separated source language", () => {
  expect(parseCommandArguments("en:中文 Hello world")).toEqual({
    from: "en",
    to: "中文",
    text: "Hello world",
  })
  // Spaces around the colon require quoting the language pair.
  expect(parseCommandArguments('"English ： 简体中文" Hi')).toEqual({
    from: "English",
    to: "简体中文",
    text: "Hi",
  })
  expect(parseCommandArguments('"English:Simplified Chinese" Hi')).toEqual({
    from: "English",
    to: "Simplified Chinese",
    text: "Hi",
  })
})

test("treats an empty source side as auto-detect and a missing target as an error", () => {
  expect(parseCommandArguments(":中文 Hello")).toEqual({ to: "中文", text: "Hello" })
  expect(() => parseCommandArguments("en: Hello")).toThrow("/t")
})

test("round-trips a colon-specified source language through the envelope", () => {
  const request = { from: "English", to: "日本語", text: "Hello %% World" }
  expect(decodeCommandEnvelope(encodeCommandEnvelope(request))).toEqual(request)
})

test("rejects an envelope carrying an unexpected extra field", () => {
  const forged = `${COMMAND_ENVELOPE_PREFIX}${Buffer.from(
    JSON.stringify({ to: "中文", text: "Hi", evil: "x" }),
    "utf8",
  ).toString("base64url")}`
  expect(decodeCommandEnvelope(forged)).toBeUndefined()
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

test("rejects valid envelopes with trailing invalid base64url characters", () => {
  const envelope = encodeCommandEnvelope({ to: "中文", text: "Hello" })
  expect(decodeCommandEnvelope(`${envelope}!`)).toBeUndefined()
  expect(decodeCommandEnvelope(`${envelope}=`)).toBeUndefined()
  expect(decodeCommandEnvelope(`${envelope}\n`)).toBeUndefined()
})

test("preserves trailing whitespace in command source text", () => {
  expect(parseCommandArguments("中文 Hello  \n")).toEqual({ to: "中文", text: "Hello  \n" })
})
