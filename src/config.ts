import type { Config } from "@opencode-ai/plugin"

export const INTERNAL_AGENT_ID = "opencode-translator"

export type Terms = Record<string, string> | string[]

export type TranslatorOptions = {
  command?: string
  temperature?: number
  styleGuide?: string
  terms?: Terms
}

export type NormalizedOptions = {
  command: string
  temperature: number
  styleGuide: string
  terms: Terms
}

function isTerms(value: unknown): value is Terms {
  if (Array.isArray(value)) return value.every((term) => typeof term === "string")
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((term) => typeof term === "string")
}

export function normalizeOptions(raw: Record<string, unknown> = {}): NormalizedOptions {
  const terms = raw.terms === undefined ? {} : raw.terms as Terms
  const options: NormalizedOptions = {
    command: raw.command === undefined ? "t" : raw.command as string,
    temperature: raw.temperature === undefined ? 0.1 : raw.temperature as number,
    styleGuide: raw.styleGuide === undefined ? "" : raw.styleGuide as string,
    terms,
  }

  if (typeof options.command !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(options.command)) {
    throw new Error("Invalid command name: command must match /^[A-Za-z][A-Za-z0-9_-]*$/")
  }
  if (typeof options.temperature !== "number" || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2) {
    throw new Error("Invalid temperature: expected a finite number between 0 and 2")
  }
  if (typeof options.styleGuide !== "string") throw new Error("Invalid styleGuide: expected a string")
  if (!isTerms(options.terms)) throw new Error("Invalid terms: expected string[] or a string-to-string object")
  options.terms = Array.isArray(options.terms) ? [...options.terms] : { ...options.terms }
  return options
}

const AGENT_PROMPT = "You are a translation subagent. Follow the system instruction for each request exactly and return only the requested translation."

export function installPluginConfig(config: Config, options: NormalizedOptions): void {
  const mutableConfig = config as Config & { command?: Record<string, unknown>; agent?: Record<string, unknown> }
  if (mutableConfig.command?.[options.command]) {
    throw new Error(`Command '${options.command}' already exists`)
  }
  if (mutableConfig.agent?.[INTERNAL_AGENT_ID]) {
    throw new Error(`Agent '${INTERNAL_AGENT_ID}' already exists`)
  }
  mutableConfig.command ??= {}
  mutableConfig.agent ??= {}
  mutableConfig.command[options.command] = {
    agent: INTERNAL_AGENT_ID,
    subtask: false,
    template: "$ARGUMENTS",
  }
  mutableConfig.agent[INTERNAL_AGENT_ID] = {
    mode: "subagent",
    maxSteps: 1,
    temperature: options.temperature,
    tools: { "*": false },
    permission: { edit: "deny", bash: "deny", webfetch: "deny" },
    prompt: AGENT_PROMPT,
  }
}
