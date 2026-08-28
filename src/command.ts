export type CommandRequest = { to: string; text: string }

export const COMMAND_ENVELOPE_PREFIX = "__OPENCODE_TRANSLATOR_V1__:"

const COMMAND_ERROR = "Invalid /t command. Use /t <target language> <text>"

export function parseCommandArguments(input: string): CommandRequest {
  let index = 0
  while (/\s/.test(input[index] ?? "")) index++
  if (index >= input.length) throw new Error(COMMAND_ERROR)

  let to = ""
  if (input[index] === '"') {
    index++
    let closed = false
    while (index < input.length) {
      const char = input[index++]
      if (char === "\\") {
        if (index >= input.length) throw new Error(COMMAND_ERROR)
        to += input[index++]
      } else if (char === '"') {
        closed = true
        break
      } else {
        to += char
      }
    }
    if (!closed || !to) throw new Error(COMMAND_ERROR)
    if (index < input.length && !/\s/.test(input[index])) throw new Error(COMMAND_ERROR)
  } else {
    const start = index
    while (index < input.length && !/\s/.test(input[index])) index++
    to = input.slice(start, index)
  }

  const textStart = index
  while (/\s/.test(input[index] ?? "")) index++
  const text = input.slice(index)
  if (!to || !text.trim()) throw new Error(COMMAND_ERROR)
  // textStart documents that only the separator whitespace is removed; all later text is exact.
  void textStart
  return { to, text }
}

export function encodeCommandEnvelope(request: CommandRequest): string {
  return COMMAND_ENVELOPE_PREFIX + Buffer.from(JSON.stringify(request), "utf8").toString("base64url")
}

export function decodeCommandEnvelope(text: string): CommandRequest | undefined {
  if (!text.startsWith(COMMAND_ENVELOPE_PREFIX)) return undefined
  try {
    const payload = text.slice(COMMAND_ENVELOPE_PREFIX.length)
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    if (Object.keys(value).length !== 2 || typeof (value as Record<string, unknown>).to !== "string" || typeof (value as Record<string, unknown>).text !== "string") return undefined
    const request = value as CommandRequest
    return request.to && request.text ? request : undefined
  } catch {
    return undefined
  }
}
