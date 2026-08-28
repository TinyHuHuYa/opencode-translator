import { expect, test } from "bun:test"
import { extractAssistantText, toPublicError, validateTranslation } from "../src/result"

test("concatenates text parts without trimming", () => {
  expect(extractAssistantText([
    { type: "text", text: " first" },
    { type: "reasoning", text: "hidden" },
    { type: "text", text: "\nsecond " },
  ])).toBe(" first\nsecond ")
})

test("returns empty text when a response has no text parts", () => {
  expect(extractAssistantText([{ type: "reasoning", text: "hidden" }])).toBe("")
})

test("rejects separators added by the model", () => {
  expect(() => validateTranslation("hello", "你好 %%")).toThrow("separator")
})

test("accepts a translation with no separators when source has none", () => {
  expect(validateTranslation("hello", "你好")).toBe("你好")
})

test("accepts the same separator count", () => {
  expect(validateTranslation("A %% B", "甲 %% 乙")).toBe("甲 %% 乙")
})

test("requires exactly the same number of separators", () => {
  expect(() => validateTranslation("A %% B %% C", "甲 %% 乙")).toThrow("separator")
})

test("rejects an empty translation", () => {
  expect(() => validateTranslation("hello", " \n\t ")).toThrow("Translation output is empty")
})

test("redacts headers tokens and response bodies", () => {
  const error = toPublicError({
    message: "request failed",
    data: { responseHeaders: { authorization: "secret" }, responseBody: "token=secret" },
  }, { providerID: "deepseek", modelID: "deepseek-chat" })
  expect(error.message).toContain("deepseek/deepseek-chat")
  expect(error.message).not.toContain("secret")
  expect(error.message).not.toContain("responseBody")
})

test("does not expose unknown error payloads", () => {
  const error = toPublicError({ message: "safe", source: "original text", apiKey: "secret-key" })
  expect(error.message).toBe("safe")
  expect(error.message).not.toContain("original text")
  expect(error.message).not.toContain("secret-key")
})
