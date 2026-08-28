import { expect, test } from "bun:test"
import { normalizeOptions } from "../src/config"
import { ModelTracker } from "../src/model"
import { createTranslateTool, type SessionGateway } from "../src/tool"

class FakeGateway implements SessionGateway {
  readonly createdParents: string[] = []
  readonly promptInputs: Parameters<SessionGateway["promptChild"]>[0][] = []
  readonly deletedSessions: string[] = []
  readonly cleanupLogs: Array<{ sessionID: string; message: string }> = []
  promptResult: readonly unknown[] = [{ type: "text", text: "bonjour" }]
  promptFailure: unknown
  deleteFailure: unknown

  async createChild(parentID: string): Promise<string> {
    this.createdParents.push(parentID)
    return "child-session"
  }

  async promptChild(input: Parameters<SessionGateway["promptChild"]>[0]): Promise<readonly unknown[]> {
    this.promptInputs.push(input)
    if (this.promptFailure) throw this.promptFailure
    return this.promptResult
  }

  async deleteSession(sessionID: string): Promise<void> {
    this.deletedSessions.push(sessionID)
    if (this.deleteFailure) throw this.deleteFailure
  }

  async loadHistory(): Promise<readonly unknown[]> {
    return []
  }

  async logCleanupFailure(sessionID: string, message: string): Promise<void> {
    this.cleanupLogs.push({ sessionID, message })
  }
}

function createSubject(gateway = new FakeGateway()) {
  const models = new ModelTracker()
  models.remember("parent-session", { providerID: "provider", modelID: "model" })
  return {
    gateway,
    tool: createTranslateTool({
      gateway,
      models,
      options: normalizeOptions({ terms: { hello: "DEFAULT" }, styleGuide: "DEFAULT STYLE" }),
    }),
  }
}

function context(signal = new AbortController().signal) {
  return {
    sessionID: "parent-session",
    messageID: "message",
    agent: "agent",
    directory: "D:/project",
    worktree: "D:/project",
    abort: signal,
    metadata() {},
    async ask() {},
  }
}

test("returns the translation and deletes its child session", async () => {
  const { gateway, tool } = createSubject()

  await expect(tool.execute({
    to: "French",
    text: "hello",
    from: "English",
    title: "Greeting",
    summary: "A short greeting",
    terms: { hello: "bonjour" },
    styleGuide: "Use formal French",
  }, context())).resolves.toBe("bonjour")

  expect(gateway.createdParents).toEqual(["parent-session"])
  expect(gateway.deletedSessions).toEqual(["child-session"])
  expect(gateway.promptInputs).toHaveLength(1)
  expect(gateway.promptInputs[0]).toMatchObject({
    sessionID: "child-session",
    agent: "opencode-translator",
    model: { providerID: "provider", modelID: "model" },
    text: "Source language: English\nTarget language: French\n\nhello",
  })
  expect(gateway.promptInputs[0].system).toContain("bonjour")
  expect(gateway.promptInputs[0].system).toContain("Use formal French")
  expect(gateway.promptInputs[0].system).not.toContain("DEFAULT")
})

test("deletes its child session when the model request fails", async () => {
  const { gateway, tool } = createSubject()
  gateway.promptFailure = new Error("authorization=secret")

  await expect(tool.execute({ to: "French", text: "hello" }, context())).rejects.toThrow(
    "Translation failed (provider/model)",
  )

  expect(gateway.deletedSessions).toEqual(["child-session"])
})

test("deletes its child session when the request is cancelled", async () => {
  const { gateway, tool } = createSubject()
  const controller = new AbortController()
  controller.abort()
  gateway.promptFailure = new DOMException("cancelled", "AbortError")

  await expect(tool.execute({ to: "French", text: "hello" }, context(controller.signal))).rejects.toThrow(
    "Translation failed (provider/model)",
  )

  expect(gateway.promptInputs[0].signal).toBe(controller.signal)
  expect(gateway.deletedSessions).toEqual(["child-session"])
})

test("keeps a successful translation when child-session cleanup fails", async () => {
  const { gateway, tool } = createSubject()
  gateway.deleteFailure = new Error("cleanup unavailable")

  await expect(tool.execute({ to: "French", text: "hello" }, context())).resolves.toBe("bonjour")

  expect(gateway.deletedSessions).toEqual(["child-session"])
  expect(gateway.cleanupLogs).toEqual([{
    sessionID: "child-session",
    message: "Failed to delete translation child session",
  }])
})

test("rejects a translation whose separator count differs from the source", async () => {
  const { gateway, tool } = createSubject()
  gateway.promptResult = [{ type: "text", text: "bonjour monde" }]

  await expect(tool.execute({ to: "French", text: "hello %% world" }, context())).rejects.toThrow(
    "Translation separator count mismatch: expected 1, got 0 (provider/model)",
  )

  expect(gateway.deletedSessions).toEqual(["child-session"])
})

test("fails explicitly without creating a child when the parent has no active model", async () => {
  const gateway = new FakeGateway()
  const tool = createTranslateTool({
    gateway,
    models: new ModelTracker(),
    options: normalizeOptions(),
  })

  await expect(tool.execute({ to: "French", text: "hello" }, context())).rejects.toThrow(
    "No active model found for session",
  )

  expect(gateway.createdParents).toEqual([])
  expect(gateway.deletedSessions).toEqual([])
})
