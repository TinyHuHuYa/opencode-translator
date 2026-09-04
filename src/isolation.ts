import { INTERNAL_AGENT_ID } from "./config"

export type TransformMessage = {
  info: { role: string; agent?: string; sessionID: string }
  parts: { type: string; text?: string }[]
}

export type ExpectedPrompt = (sessionID: string) => string | undefined

/**
 * When the newest message belongs to the translator agent, reduce the model's
 * message list to just the current translation request: drop conversation
 * history and any text other plugins injected into the request (for example
 * Superpowers' `<EXTREMELY_IMPORTANT>` bootstrap block).
 *
 * The kept part is chosen by exact allowlist: the text this plugin rendered for
 * the session. Only when that prompt is unknown does it fall back to the last
 * text part. This makes the result independent of whether another
 * `experimental.chat.messages.transform` plugin ran before or after us, as long
 * as we run at all — anything that is not the rendered prompt is discarded.
 *
 * Only the model input is changed; the stored conversation is untouched.
 */
export function isolateTranslationSource(
  messages: TransformMessage[],
  expectedPrompt: ExpectedPrompt,
): void {
  let latest: TransformMessage | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].info.role === "user") {
      latest = messages[index]
      break
    }
  }
  if (!latest || latest.info.agent !== INTERNAL_AGENT_ID) return

  const expected = expectedPrompt(latest.info.sessionID)
  let sourcePart: TransformMessage["parts"][number] | undefined
  if (expected !== undefined) {
    sourcePart = latest.parts.find((part) => part.type === "text" && part.text === expected)
  }
  if (!sourcePart) {
    for (let index = latest.parts.length - 1; index >= 0; index--) {
      if (latest.parts[index].type === "text") {
        sourcePart = latest.parts[index]
        break
      }
    }
  }
  if (!sourcePart) return

  messages.splice(0, messages.length, { info: latest.info, parts: [sourcePart] })
}
