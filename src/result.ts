export type ModelRef = { providerID: string; modelID: string }

export class TranslationFormatError extends Error {
  readonly expectedSeparators: number
  readonly actualSeparators: number
  readonly output: string

  constructor(expectedSeparators: number, actualSeparators: number, output: string) {
    super(`Translation separator count mismatch: expected ${expectedSeparators}, got ${actualSeparators}`)
    this.name = "TranslationFormatError"
    this.expectedSeparators = expectedSeparators
    this.actualSeparators = actualSeparators
    this.output = output
  }
}

export function extractAssistantText(parts: readonly unknown[]): string {
  let output = ""
  for (const part of parts) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) continue
    const value = part as Record<string, unknown>
    if (value.type === "text" && typeof value.text === "string") output += value.text
  }
  return output
}

function countSeparators(value: string): number {
  let count = 0
  let index = 0
  while ((index = value.indexOf("%%", index)) !== -1) {
    count++
    index += 2
  }
  return count
}

/**
 * Remove `%%` markers the model added on its own. Only used when the source
 * had none, so every `%%` in the output is a stray separator: collapse the
 * canonical `\n\n%%\n\n` paragraph break first, then drop any loose `%%`
 * along with the whitespace it introduced.
 */
function removeStraySeparators(output: string): string {
  return output
    .replace(/\n{2,}[^\S\n]*%%[^\S\n]*\n{2,}/g, "\n\n")
    .replace(/[^\S\n]*%%[^\S\n]*/g, "")
    .trim()
}

export function validateTranslation(source: string, output: string): string {
  if (!output.trim()) throw new Error("Translation output is empty")
  const expectedSeparators = countSeparators(source)
  const actualSeparators = countSeparators(output)
  if (expectedSeparators === actualSeparators) return output
  if (expectedSeparators === 0) {
    const cleaned = removeStraySeparators(output)
    if (!cleaned) throw new Error("Translation output is empty")
    return cleaned
  }
  throw new TranslationFormatError(expectedSeparators, actualSeparators, output)
}

export function toPublicError(error: unknown, model?: ModelRef): Error {
  let message = "Translation failed"
  if (error instanceof TranslationFormatError &&
    Number.isSafeInteger(error.expectedSeparators) &&
    Number.isSafeInteger(error.actualSeparators)) {
    message = `Translation separator count mismatch: expected ${error.expectedSeparators}, got ${error.actualSeparators}`
  } else if (error instanceof Error && error.message === "Translation output is empty") {
    message = error.message
  }
  const modelLabel = model && model.providerID && model.modelID
    ? ` (${model.providerID}/${model.modelID})`
    : ""
  return new Error(`${message}${modelLabel}`)
}
