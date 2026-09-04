import { expect, test } from "bun:test"
import { isolateTranslationSource, type TransformMessage } from "../src/isolation"

const AGENT = "opencode-translator"

function userMsg(agent: string, parts: string[], sessionID = "s"): TransformMessage {
  return { info: { role: "user", agent, sessionID }, parts: parts.map((text) => ({ type: "text", text })) }
}

function assistantMsg(text: string): TransformMessage {
  return { info: { role: "assistant", sessionID: "s" }, parts: [{ type: "text", text }] }
}

test("keeps the exact registered prompt and drops everything else", () => {
  const messages: TransformMessage[] = [
    userMsg("build", ["<EXTREMELY_IMPORTANT>bootstrap</EXTREMELY_IMPORTANT>", "earlier question"]),
    assistantMsg("earlier answer"),
    userMsg(AGENT, ["<EXTREMELY_IMPORTANT>bootstrap</EXTREMELY_IMPORTANT>", "Translate this."]),
  ]
  isolateTranslationSource(messages, () => "Translate this.")
  expect(messages).toEqual([userMsg(AGENT, ["Translate this."])])
})

test("keeps the registered prompt even when a later part follows it", () => {
  const messages = [userMsg(AGENT, ["Translate this.", "<EXTREMELY_IMPORTANT>late injection</EXTREMELY_IMPORTANT>"])]
  isolateTranslationSource(messages, () => "Translate this.")
  expect(messages).toEqual([userMsg(AGENT, ["Translate this."])])
})

test("falls back to the last text part when the prompt is unknown", () => {
  const messages = [userMsg(AGENT, ["<EXTREMELY_IMPORTANT>bootstrap</EXTREMELY_IMPORTANT>", "Translate this."])]
  isolateTranslationSource(messages, () => undefined)
  expect(messages).toEqual([userMsg(AGENT, ["Translate this."])])
})

test("does nothing when the newest message is not from the translator agent", () => {
  const original: TransformMessage[] = [
    userMsg("build", ["hi"]),
    assistantMsg("hello"),
    userMsg("build", ["another"]),
  ]
  const messages = original.map((m) => ({ info: { ...m.info }, parts: m.parts.map((p) => ({ ...p })) }))
  isolateTranslationSource(messages, () => "hi")
  expect(messages).toEqual(original)
})

test("does nothing when there is no user message", () => {
  const messages = [assistantMsg("only assistant")]
  isolateTranslationSource(messages, () => "x")
  expect(messages).toEqual([assistantMsg("only assistant")])
})

test("looks up the prompt by the translator message's own session id", () => {
  let asked: string | undefined
  const messages = [userMsg(AGENT, ["source"], "child-42")]
  isolateTranslationSource(messages, (sessionID) => {
    asked = sessionID
    return "source"
  })
  expect(asked).toBe("child-42")
})
