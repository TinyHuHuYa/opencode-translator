import { expect, test } from "bun:test"
import { ModelTracker } from "../src/model"

test("returns the latest remembered model", async () => {
  const tracker = new ModelTracker()
  tracker.remember("session", { providerID: "a", modelID: "one" })
  tracker.remember("session", { providerID: "b", modelID: "two" })
  expect(await tracker.resolve("session", async () => [])).toEqual({ providerID: "b", modelID: "two" })
})

test("keeps models isolated between sessions", async () => {
  const tracker = new ModelTracker()
  tracker.remember("first", { providerID: "a", modelID: "one" })

  await expect(tracker.resolve("second", async () => [])).rejects.toThrow("No active model found")
})

test("falls back to the newest user message with model metadata", async () => {
  const tracker = new ModelTracker()
  const history = [
    { info: { role: "user", model: { providerID: "a", modelID: "old" } } },
    { info: { role: "assistant" } },
    { info: { role: "user", model: { providerID: "b", modelID: "new" } } },
  ]
  expect(await tracker.resolve("session", async () => history)).toEqual({ providerID: "b", modelID: "new" })
})

test("ignores history entries without a complete user model", async () => {
  const tracker = new ModelTracker()
  const history = [
    { info: { role: "user", model: { providerID: "a", modelID: "valid" } } },
    { info: { role: "assistant", model: { providerID: "b", modelID: "wrong-role" } } },
    { info: { role: "user", model: { providerID: "", modelID: "empty-provider" } } },
  ]
  expect(await tracker.resolve("session", async () => history)).toEqual({ providerID: "a", modelID: "valid" })
})

test("forgets a session model", async () => {
  const tracker = new ModelTracker()
  tracker.remember("session", { providerID: "a", modelID: "one" })
  tracker.forget("session")

  await expect(tracker.resolve("session", async () => [])).rejects.toThrow("No active model found")
})

test("copies models when remembering and resolving", async () => {
  const tracker = new ModelTracker()
  const model = { providerID: "a", modelID: "one" }
  tracker.remember("session", model)
  model.providerID = "changed"

  const resolved = await tracker.resolve("session", async () => [])
  expect(resolved).toEqual({ providerID: "a", modelID: "one" })
  resolved.modelID = "changed"
  expect(await tracker.resolve("session", async () => [])).toEqual({ providerID: "a", modelID: "one" })
})

test("fails instead of choosing a global default", async () => {
  const tracker = new ModelTracker()
  await expect(tracker.resolve("missing", async () => [])).rejects.toThrow("No active model found")
})
