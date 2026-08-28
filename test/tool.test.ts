import { expect, test } from "bun:test"
import { tool as defineTool, type PluginInput } from "@opencode-ai/plugin"
import { normalizeOptions } from "../src/config"
import { ModelTracker } from "../src/model"
import { TranslationFormatError } from "../src/result"
import { createSessionGateway, createTranslateTool, type SessionGateway } from "../src/tool"

class FakeGateway implements SessionGateway {
  readonly createdParents: string[] = []
  readonly promptInputs: Parameters<SessionGateway["promptChild"]>[0][] = []
  readonly deletedSessions: string[] = []
  readonly cleanupLogs: Array<{ sessionID: string; message: string }> = []
  promptResult: readonly unknown[] = [{ type: "text", text: "bonjour" }]
  promptFailure: unknown
  deleteFailure: unknown
  cleanupLogFailure: unknown

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
    if (this.cleanupLogFailure) throw this.cleanupLogFailure
  }
}

function createSdkClient() {
  const calls: Record<string, unknown[]> = {
    create: [], prompt: [], delete: [], messages: [], log: [],
  }
  const responses: Record<string, unknown> = {
    create: { data: { id: "sdk-child" } },
    prompt: { data: { parts: [{ type: "text", text: "bonjour" }] } },
    delete: { data: true },
    messages: { data: [{ info: { role: "user" } }] },
    log: { data: true },
  }
  const client = {
    session: {
      create: async (input: unknown) => {
        calls.create.push(input)
        return responses.create
      },
      prompt: async (input: unknown) => {
        calls.prompt.push(input)
        return responses.prompt
      },
      delete: async (input: unknown) => {
        calls.delete.push(input)
        return responses.delete
      },
      messages: async (input: unknown) => {
        calls.messages.push(input)
        return responses.messages
      },
    },
    app: {
      log: async (input: unknown) => {
        calls.log.push(input)
        return responses.log
      },
    },
  } as unknown as PluginInput["client"]
  return { client, calls, responses }
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
    text: "Source language: English\n\nhello",
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
    message: "Failed to delete translation child session: cleanup failed",
  }])
})

test("keeps the primary translation error when cleanup also fails", async () => {
  const { gateway, tool } = createSubject()
  gateway.promptFailure = new Error("authorization=secret")
  gateway.deleteFailure = new Error("token=cleanup-secret")

  const error = await tool.execute({ to: "French", text: "source text" }, context()).catch((value) => value)

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe("Translation failed (provider/model)")
  expect(gateway.cleanupLogs).toHaveLength(1)
  expect(gateway.cleanupLogs[0].message).toContain("cleanup failed")
  expect(gateway.cleanupLogs[0].message).not.toContain("cleanup-secret")
  expect(gateway.cleanupLogs[0].message).not.toContain("source text")
})

test("keeps a successful translation when cleanup logging fails", async () => {
  const { gateway, tool } = createSubject()
  gateway.deleteFailure = new Error("token=cleanup-secret")
  gateway.cleanupLogFailure = new Error("log unavailable")

  await expect(tool.execute({ to: "French", text: "hello" }, context())).resolves.toBe("bonjour")

  expect(gateway.cleanupLogs).toHaveLength(1)
})

test("records only numeric HTTP status in cleanup diagnostics", async () => {
  const first = createSubject()
  first.gateway.deleteFailure = Object.assign(new Error("token=first-secret source text"), {
    name: "source-text",
    code: "secret-token",
    status: 404,
  })
  const second = createSubject()
  second.gateway.deleteFailure = Object.assign(new Error("responseBody=second-secret"), {
    name: "authorization",
    code: "response-body",
    status: 503,
  })

  await expect(first.tool.execute({ to: "French", text: "source text" }, context())).resolves.toBe("bonjour")
  await expect(second.tool.execute({ to: "French", text: "source text" }, context())).resolves.toBe("bonjour")

  const firstDiagnostic = first.gateway.cleanupLogs[0].message
  const secondDiagnostic = second.gateway.cleanupLogs[0].message
  expect(firstDiagnostic).toBe("Failed to delete translation child session: status=404")
  expect(secondDiagnostic).toBe("Failed to delete translation child session: status=503")
  expect(firstDiagnostic).not.toBe(secondDiagnostic)
  for (const diagnostic of [firstDiagnostic, secondDiagnostic]) {
    expect(diagnostic).not.toContain("secret")
    expect(diagnostic).not.toContain("source text")
    expect(diagnostic).not.toContain("responseBody")
    expect(diagnostic).not.toContain("source-text")
    expect(diagnostic).not.toContain("secret-token")
    expect(diagnostic).not.toContain("authorization")
    expect(diagnostic).not.toContain("response-body")
  }
})

test("uses the fixed cleanup summary for a non-HTTP status", async () => {
  const { gateway, tool } = createSubject()
  gateway.deleteFailure = Object.assign(new Error("token=secret"), {
    name: "source-text",
    code: "secret-token",
    status: 700,
  })

  await expect(tool.execute({ to: "French", text: "hello" }, context())).resolves.toBe("bonjour")

  expect(gateway.cleanupLogs[0].message).toBe("Failed to delete translation child session: cleanup failed")
})

test("rejects a translation whose separator count differs from the source", async () => {
  const { gateway, tool } = createSubject()
  gateway.promptResult = [{ type: "text", text: "bonjour monde" }]

  await expect(tool.execute({ to: "French", text: "hello %% world" }, context())).rejects.toThrow(
    "Translation separator count mismatch: expected 1, got 0 (provider/model)",
  )

  expect(gateway.deletedSessions).toEqual(["child-session"])
})

test("keeps raw format output in an error cause but not its public message or cleanup log", async () => {
  const { gateway, tool } = createSubject()
  const rawOutput = "untranslated %% delimiter"
  gateway.promptResult = [{ type: "text", text: rawOutput }]
  gateway.deleteFailure = new Error("cleanup failed")

  const error = await tool.execute({ to: "French", text: "hello" }, context()).catch((value) => value)

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).not.toContain(rawOutput)
  expect((error as Error).cause).toBeInstanceOf(TranslationFormatError)
  expect(((error as Error).cause as TranslationFormatError).output).toBe(rawOutput)
  expect(gateway.cleanupLogs[0].message).not.toContain(rawOutput)
})

test("concatenates multiple assistant text parts in response order", async () => {
  const { gateway, tool } = createSubject()
  gateway.promptResult = [
    { type: "text", text: "bon" },
    { type: "reasoning", text: "hidden" },
    { type: "text", text: "jour" },
  ]

  await expect(tool.execute({ to: "French", text: "hello" }, context())).resolves.toBe("bonjour")
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

test("exposes required and terms validation through the actual tool schema", () => {
  const { tool } = createSubject()
  const schema = defineTool.schema.object(tool.args)

  expect(schema.safeParse({ text: "hello" }).success).toBeFalse()
  expect(schema.safeParse({ to: "French" }).success).toBeFalse()
  expect(schema.safeParse({ to: "French", text: "" }).success).toBeFalse()
  expect(schema.safeParse({ to: "French", text: "hello", terms: ["hello => bonjour"] }).success).toBeTrue()
  expect(schema.safeParse({ to: "French", text: "hello", terms: { hello: "bonjour" } }).success).toBeTrue()
  expect(schema.safeParse({ to: "French", text: "hello", terms: { hello: 1 } }).success).toBeFalse()
  expect(schema.safeParse({ to: "French", text: "hello", terms: [1] }).success).toBeFalse()
})

test("maps every session gateway operation to its typed OpenCode SDK request", async () => {
  const { client, calls } = createSdkClient()
  const gateway = createSessionGateway(client, "D:/project")
  const controller = new AbortController()

  await expect(gateway.createChild("parent")).resolves.toBe("sdk-child")
  await expect(gateway.promptChild({
    sessionID: "sdk-child",
    agent: "ignored-agent",
    model: { providerID: "provider", modelID: "model" },
    system: "system prompt",
    text: "source text",
    signal: controller.signal,
  })).resolves.toEqual([{ type: "text", text: "bonjour" }])
  await expect(gateway.deleteSession("sdk-child")).resolves.toBeUndefined()
  await expect(gateway.loadHistory("parent")).resolves.toEqual([{ info: { role: "user" } }])
  await expect(gateway.logCleanupFailure("sdk-child", "safe diagnostic")).resolves.toBeUndefined()

  expect(calls.create).toEqual([{
    body: { parentID: "parent", title: "Translation" },
    query: { directory: "D:/project" },
  }])
  expect(calls.prompt).toEqual([{
    path: { id: "sdk-child" },
    query: { directory: "D:/project" },
    signal: controller.signal,
    body: {
      agent: "opencode-translator",
      model: { providerID: "provider", modelID: "model" },
      system: "system prompt",
      parts: [{ type: "text", text: "source text" }],
    },
  }])
  expect(calls.delete).toEqual([{ path: { id: "sdk-child" }, query: { directory: "D:/project" } }])
  expect(calls.messages).toEqual([{ path: { id: "parent" }, query: { directory: "D:/project" } }])
  expect(calls.log).toEqual([{
    query: { directory: "D:/project" },
    body: {
      service: "opencode-translator",
      level: "warn",
      message: "safe diagnostic",
      extra: { sessionID: "sdk-child" },
    },
  }])
})

test("fails safely for every OpenCode SDK operation that returns no data", async () => {
  const operations = ["create", "prompt", "delete", "messages", "log"] as const

  for (const operation of operations) {
    const { client, responses } = createSdkClient()
    responses[operation] = { error: { authorization: "secret", responseBody: "source text" } }
    const gateway = createSessionGateway(client, "D:/project")
    const request = operation === "create"
      ? gateway.createChild("parent")
      : operation === "prompt"
        ? gateway.promptChild({
          sessionID: "sdk-child",
          agent: "agent",
          model: { providerID: "provider", modelID: "model" },
          system: "system",
          text: "source text",
          signal: new AbortController().signal,
        })
        : operation === "delete"
          ? gateway.deleteSession("sdk-child")
          : operation === "messages"
            ? gateway.loadHistory("parent")
            : gateway.logCleanupFailure("sdk-child", "safe diagnostic")

    const error = await request.catch((value) => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("OpenCode session request failed")
    expect((error as Error).message).not.toContain("secret")
    expect((error as Error).message).not.toContain("source text")
  }
})

test("keeps tool outcomes stable when SDK cleanup or cleanup logging has no data", async () => {
  const deleteFailure = createSdkClient()
  deleteFailure.responses.delete = { error: { authorization: "delete-secret" } }
  const deleteGateway = createSessionGateway(deleteFailure.client, "D:/project")
  const deleteModels = new ModelTracker()
  deleteModels.remember("parent-session", { providerID: "provider", modelID: "model" })
  const deleteTool = createTranslateTool({
    gateway: deleteGateway,
    models: deleteModels,
    options: normalizeOptions(),
  })

  await expect(deleteTool.execute({ to: "French", text: "hello" }, context())).resolves.toBe("bonjour")
  expect(deleteFailure.calls.log).toHaveLength(1)

  const logFailure = createSdkClient()
  logFailure.responses.delete = { error: { authorization: "delete-secret" } }
  logFailure.responses.log = { error: { authorization: "log-secret" } }
  const logGateway = createSessionGateway(logFailure.client, "D:/project")
  const logModels = new ModelTracker()
  logModels.remember("parent-session", { providerID: "provider", modelID: "model" })
  const logTool = createTranslateTool({
    gateway: logGateway,
    models: logModels,
    options: normalizeOptions(),
  })

  await expect(logTool.execute({ to: "French", text: "hello" }, context())).resolves.toBe("bonjour")
  expect(logFailure.calls.log).toHaveLength(1)
})
