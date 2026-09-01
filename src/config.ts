import type { Config } from "@opencode-ai/plugin"

export const INTERNAL_AGENT_ID = "opencode-translator"

export type Terms = Record<string, string> | string[]

// ---------------------------------------------------------------------------
// Local-install defaults.
// The auto-discovery plugin directory cannot pass options, so edit these to
// change behaviour when installing from `.opencode/plugin/`. A published
// package can still override every value through the config plugin tuple.
// ---------------------------------------------------------------------------

export const DEFAULT_COMMAND = "t"

export const DEFAULT_TEMPERATURE = 0

export const DEFAULT_STYLE_GUIDE = [
  "面向简体中文技术读者。",
  "使用书面语，句子简洁清晰，避免机翻腔和多余修饰。",
  "代码、命令、文件名、路径、API 名称、报错信息保留英文原文，不翻译、不额外加空格。",
  "产品名、公司名、协议名等专有名词保留英文。",
  "同一术语在全文中保持一致的译法。",
  "保留原文的 Markdown、HTML、代码块、缩进、换行与空行结构。",
].join("\n")

export const DEFAULT_TERMS: Terms = {
  OpenCode: "OpenCode",
  Claude: "Claude",
  Anthropic: "Anthropic",
  plugin: "插件",
  prompt: "提示词",
  "system prompt": "系统提示词",
  token: "token",
  LLM: "大模型",
  agent: "代理",
  API: "API",
  CLI: "CLI",
  repository: "仓库",
  commit: "提交",
}

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
  const terms = raw.terms === undefined ? DEFAULT_TERMS : raw.terms as Terms
  const options: NormalizedOptions = {
    command: raw.command === undefined ? DEFAULT_COMMAND : raw.command as string,
    temperature: raw.temperature === undefined ? DEFAULT_TEMPERATURE : raw.temperature as number,
    styleGuide: raw.styleGuide === undefined ? DEFAULT_STYLE_GUIDE : raw.styleGuide as string,
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
  const mutableConfig = config as unknown as {
    command?: Record<string, unknown>
    agent?: Record<string, unknown>
  }
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
    permission: { "*": "deny" },
    prompt: AGENT_PROMPT,
  }
}
