import { describe, expect, test } from "bun:test"
import {
  DEFAULT_COMMAND,
  DEFAULT_STYLE_GUIDE,
  DEFAULT_TEMPERATURE,
  DEFAULT_TERMS,
  installPluginConfig,
  normalizeOptions,
} from "../src/config"

describe("normalizeOptions", () => {
  test("uses the configured local-install defaults", () => {
    expect(normalizeOptions()).toEqual({
      command: DEFAULT_COMMAND,
      temperature: DEFAULT_TEMPERATURE,
      styleGuide: DEFAULT_STYLE_GUIDE,
      terms: { ...(DEFAULT_TERMS as Record<string, string>) },
    })
  })

  test("does not share the default terms object between calls", () => {
    const first = normalizeOptions()
    ;(first.terms as Record<string, string>).example = "示例"
    expect(normalizeOptions().terms).toEqual({ ...(DEFAULT_TERMS as Record<string, string>) })
    expect((normalizeOptions().terms as Record<string, string>).example).toBeUndefined()
  })

  test("rejects an invalid command name", () => {
    expect(() => normalizeOptions({ command: "bad command" })).toThrow("command")
  })

  test("rejects temperature outside 0..2", () => {
    expect(() => normalizeOptions({ temperature: 2.1 })).toThrow("temperature")
  })
})

describe("installPluginConfig", () => {
  test("denies every translator tool through the active permission API", () => {
    const config: Record<string, any> = {}
    installPluginConfig(config, normalizeOptions())
    expect(config.command.t).toMatchObject({ agent: "opencode-translator", template: "$ARGUMENTS" })
    expect(config.agent["opencode-translator"].model).toBeUndefined()
    expect(config.agent["opencode-translator"].permission).toEqual({ "*": "deny" })
    expect(config.agent["opencode-translator"].tools).toBeUndefined()
  })

  test("does not overwrite an existing command", () => {
    const config: Record<string, any> = { command: { t: { template: "existing" } } }
    expect(() => installPluginConfig(config, normalizeOptions())).toThrow("already exists")
  })
})
