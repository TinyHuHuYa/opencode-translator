export type CommandRequest = { to: string; text: string; from?: string }

export const COMMAND_ENVELOPE_PREFIX = "__OPENCODE_TRANSLATOR_V1__:"

const COMMAND_ERROR = "Invalid /t command. Use /t <target language> <text> or /t <source>:<target> <text>"

function splitLanguages(token: string): { to: string; from?: string } {
  const colon = token.search(/[:：]/)
  if (colon === -1) return { to: token.trim() }
  const from = token.slice(0, colon).trim()
  const to = token.slice(colon + 1).trim()
  return from ? { to, from } : { to }
}

export function parseCommandArguments(input: string): CommandRequest {
  let index = 0
  while (/\s/.test(input[index] ?? "")) index++
  if (index >= input.length) throw new Error(COMMAND_ERROR)

  let languages = ""
  if (input[index] === '"') {
    index++
    let closed = false
    while (index < input.length) {
      const char = input[index++]
      if (char === "\\") {
        if (index >= input.length) throw new Error(COMMAND_ERROR)
        languages += input[index++]
      } else if (char === '"') {
        closed = true
        break
      } else {
        languages += char
      }
    }
    if (!closed || !languages) throw new Error(COMMAND_ERROR)
    if (index < input.length && !/\s/.test(input[index])) throw new Error(COMMAND_ERROR)
  } else {
    const start = index
    while (index < input.length && !/\s/.test(input[index])) index++
    languages = input.slice(start, index)
  }

  const textStart = index
  while (/\s/.test(input[index] ?? "")) index++
  const text = input.slice(index)
  const { to, from } = splitLanguages(languages)
  if (!to || !text.trim()) throw new Error(COMMAND_ERROR)
  // textStart documents that only the separator whitespace is removed; all later text is exact.
  void textStart
  return from ? { to, from, text } : { to, text }
}

export function encodeCommandEnvelope(request: CommandRequest): string {
  return COMMAND_ENVELOPE_PREFIX + Buffer.from(JSON.stringify(request), "utf8").toString("base64url")
}

export function decodeCommandEnvelope(text: string): CommandRequest | undefined {
  if (!text.startsWith(COMMAND_ENVELOPE_PREFIX)) return undefined
  try {
    const payload = text.slice(COMMAND_ENVELOPE_PREFIX.length)
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined
    const decoded = Buffer.from(payload, "base64url")
    if (decoded.toString("base64url") !== payload) return undefined
    const value: unknown = JSON.parse(decoded.toString("utf8"))
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length < 2 || keys.length > 3) return undefined
    if (typeof record.to !== "string" || !record.to) return undefined
    if (typeof record.text !== "string" || !record.text) return undefined
    if (keys.length === 3 && (typeof record.from !== "string" || !record.from)) return undefined
    return keys.length === 3
      ? { to: record.to, from: record.from as string, text: record.text }
      : { to: record.to, text: record.text }
  } catch {
    return undefined
  }
}
