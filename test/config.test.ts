import { describe, expect, test } from "bun:test"
import { installPluginConfig, normalizeOptions } from "../src/config"

describe("normalizeOptions", () => {
  test("uses stable defaults", () => {
    expect(normalizeOptions()).toEqual({
      command: "t",
      temperature: 0.1,
      styleGuide: "",
      terms: {},
    })
  })

  test("rejects an invalid command name", () => {
    expect(() => normalizeOptions({ command: "bad command" })).toThrow("command")
  })

  test("rejects temperature outside 0..2", () => {
    expect(() => normalizeOptions({ temperature: 2.1 })).toThrow("temperature")
  })
})

describe("installPluginConfig", () => {
  test("registers command and restricted translator agent without a model", () => {
    const config: Record<string, any> = {}
    installPluginConfig(config, normalizeOptions())
    expect(config.command.t).toMatchObject({ agent: "opencode-translator", template: "$ARGUMENTS" })
    expect(config.agent["opencode-translator"].model).toBeUndefined()
    expect(config.agent["opencode-translator"].tools).toEqual({ "*": false })
  })

  test("does not overwrite an existing command", () => {
    const config: Record<string, any> = { command: { t: { template: "existing" } } }
    expect(() => installPluginConfig(config, normalizeOptions())).toThrow("already exists")
  })
})
