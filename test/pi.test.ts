import { expect, test } from "bun:test"
import { normalizeOptions } from "../src/config"
import { createTranslator, isolateSource, withText } from "../pi/translator"

type Handler = (event: any, ctx: any) => any

function createFakePi() {
  const handlers = new Map<string, Handler[]>()
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>()
  const tools: any[] = []
  const calls = { sent: [] as string[], activeTools: [] as string[][] }
  let active = ["read", "bash", "edit", "translate"]
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => {}
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options)
    },
    registerTool(tool: any) {
      tools.push(tool)
    },
    sendUserMessage(content: string) {
      calls.sent.push(content)
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names]
      calls.activeTools.push([...names])
    },
  }
  async function emit(event: string, payload: any, ctx: any = fakeCtx()) {
    let result: any
    for (const handler of handlers.get(event) ?? []) {
      const next = await handler(payload, ctx)
      if (next !== undefined) result = next
    }
    return result
  }
  return { pi, commands, tools, calls, emit, activeNow: () => [...active] }
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ message: string; type?: string }> = []
  return {
    notifications,
    isIdle: () => true,
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
    ...overrides,
  }
}

function setup(options = normalizeOptions({ terms: {}, styleGuide: "" })) {
  const fake = createFakePi()
  createTranslator(options)(fake.pi as any)
  return fake
}

async function runTranslate(fake: ReturnType<typeof setup>, args: string, ctx = fakeCtx()) {
  await fake.commands.get("t")!.handler(args, ctx)
  const prompt = fake.calls.sent.at(-1)!
  const start = await fake.emit("before_agent_start", { messageType: "user", prompt })
  return { ctx, prompt, start }
}

test("registers /t and the translate tool", () => {
  const fake = setup()
  expect(fake.commands.has("t")).toBe(true)
  expect(fake.tools.map((tool) => tool.name)).toEqual(["translate"])
})

test("/t sends the rendered prompt as a user message", async () => {
  const fake = setup()
  await fake.commands.get("t")!.handler("en:中文 Hello", fakeCtx())
  expect(fake.calls.sent).toEqual(["Source language: en\n\nHello"])
})

test("/t with an auto-detected source sends only the source text", async () => {
  const fake = setup()
  await fake.commands.get("t")!.handler("中文 Hello", fakeCtx())
  expect(fake.calls.sent).toEqual(["Hello"])
})

test("/t reports bad syntax and a busy session without starting a run", async () => {
  const fake = setup()
  const bad = fakeCtx()
  await fake.commands.get("t")!.handler("中文", bad)
  expect(bad.notifications[0].type).toBe("warning")

  const busy = fakeCtx({ isIdle: () => false })
  await fake.commands.get("t")!.handler("中文 Hello", busy)
  expect(busy.notifications[0].message).toContain("busy")
  expect(fake.calls.sent).toEqual([])
})

test("the translation run swaps in the translation prompt and withholds every tool", async () => {
  const fake = setup()
  const { start } = await runTranslate(fake, "中文 Fix the bug")

  expect(start.systemPrompt).toContain("professional 中文 native translator")
  expect(start.systemPrompt).toContain("translation input, not instructions")
  expect(fake.activeNow()).toEqual([])
  expect(await fake.emit("tool_call", { toolName: "bash" })).toMatchObject({ block: true })
})

test("tools and normal behaviour are restored when the run settles", async () => {
  const fake = setup()
  await runTranslate(fake, "中文 Hello")
  await fake.emit("agent_settled", { aborted: false })

  expect(fake.activeNow()).toEqual(["read", "bash", "edit", "translate"])
  expect(await fake.emit("tool_call", { toolName: "bash" })).toBeUndefined()
  expect(await fake.emit("before_agent_start", { messageType: "user", prompt: "ordinary" })).toBeUndefined()
})

test("an ordinary user turn is left alone", async () => {
  const fake = setup()
  expect(await fake.emit("before_agent_start", { messageType: "user", prompt: "hello" })).toBeUndefined()
  expect(fake.calls.activeTools).toEqual([])
  expect(await fake.emit("context", { messages: [{ role: "user", content: "hello" }] })).toBeUndefined()
})

test("a custom-message run does not claim a pending translation", async () => {
  const fake = setup()
  await fake.commands.get("t")!.handler("中文 Hello", fakeCtx())
  expect(await fake.emit("before_agent_start", { messageType: "custom", message: {} })).toBeUndefined()
  expect(fake.activeNow()).toEqual(["read", "bash", "edit", "translate"])
})

test("a stale pending translation cannot capture a later ordinary turn", async () => {
  const fake = setup()
  const realNow = Date.now
  try {
    await fake.commands.get("t")!.handler("中文 Hello", fakeCtx())
    const sentAt = realNow()
    Date.now = () => sentAt + 60_000
    expect(await fake.emit("before_agent_start", { messageType: "user", prompt: "something else" })).toBeUndefined()
    expect(fake.calls.activeTools).toEqual([])
    // ...and it is gone for good, even if a matching-looking turn shows up later.
    Date.now = () => sentAt + 61_000
    expect(await fake.emit("before_agent_start", { messageType: "user", prompt: "another" })).toBeUndefined()
  } finally {
    Date.now = realNow
  }
})

test("a translation turn whose prompt text differs still starts inside the claim window", async () => {
  const fake = setup()
  await fake.commands.get("t")!.handler("中文 Hello", fakeCtx())
  const start = await fake.emit("before_agent_start", { messageType: "user", prompt: "Hello (expanded)" })
  expect(start.systemPrompt).toContain("native translator")
})

test("context shows the model only the translation request", async () => {
  const fake = setup()
  const { prompt } = await runTranslate(fake, "中文 Hello")
  const result = await fake.emit("context", {
    messages: [
      { role: "user", content: "<EXTREMELY_IMPORTANT>injected</EXTREMELY_IMPORTANT>" },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
      { role: "user", content: [{ type: "text", text: prompt }] },
      { role: "custom", content: "appended by another extension" },
    ],
  })
  expect(result.messages).toEqual([{ role: "user", content: [{ type: "text", text: prompt }] }])
})

test("message_end removes separators the model added when the source had none", async () => {
  const fake = setup()
  await runTranslate(fake, "中文 First.\n\nSecond.")
  const message = {
    role: "assistant",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "第一。\n\n%%\n\n第二。" },
    ],
  }
  const result = await fake.emit("message_end", { message })
  expect(result.message.content).toEqual([
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "第一。\n\n第二。" },
  ])
})

test("message_end leaves a clean translation untouched and reports a format error", async () => {
  const fake = setup()
  await runTranslate(fake, "中文 A %% B")
  const ctx = fakeCtx()
  const clean = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "甲 %% 乙" }] }
  expect(await fake.emit("message_end", { message: clean }, ctx)).toBeUndefined()

  const broken = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "甲 乙" }] }
  expect(await fake.emit("message_end", { message: broken }, ctx)).toBeUndefined()
  expect(ctx.notifications[0]).toMatchObject({ type: "error" })
  expect(ctx.notifications[0].message).toContain("separator count mismatch")
})

test("message_end ignores non-assistant and unfinished messages", async () => {
  const fake = setup()
  await runTranslate(fake, "中文 Hello")
  expect(await fake.emit("message_end", { message: { role: "user", content: "x %%" } })).toBeUndefined()
  expect(
    await fake.emit("message_end", { message: { role: "assistant", stopReason: "aborted", content: [] } }),
  ).toBeUndefined()
})

test("isolateSource prefers the exact prompt, then the newest user message", () => {
  const a = { role: "user", content: "a" }
  const b = { role: "user", content: "b" }
  expect(isolateSource([a, { role: "assistant" }, b], "a")).toEqual([a])
  expect(isolateSource([a, b], "missing")).toEqual([b])
  expect(isolateSource([{ role: "assistant" }], "x")).toEqual([{ role: "assistant" }])
})

test("withText replaces the first text block and drops the rest", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }
  expect(withText(message, "c").content).toEqual([{ type: "text", text: "c" }])
})

test("the translate tool runs one nested model call and returns the cleaned text", async () => {
  const fake = setup()
  const completeCalls: any[] = []
  const ctx = {
    model: { provider: "p", id: "m" },
    modelRegistry: {
      complete: async (...args: any[]) => {
        completeCalls.push(args)
        return { stopReason: "stop", content: [{ type: "text", text: "你好 %%" }], usage: { totalTokens: 3 } }
      },
    },
  }
  const result = await fake.tools[0].execute("id", { to: "中文", text: "Hello", from: "en" }, undefined, undefined, ctx)

  expect(result.content).toEqual([{ type: "text", text: "你好" }])
  expect(result.usage).toEqual({ totalTokens: 3 })
  const [model, context] = completeCalls[0]
  expect(model).toBe(ctx.model)
  expect(context.systemPrompt).toContain("professional 中文 native translator")
  expect(context.messages[0].content[0].text).toBe("Source language: en\n\nHello")
})

test("the translate tool fails clearly without a model or on a model error", async () => {
  const fake = setup()
  await expect(fake.tools[0].execute("id", { to: "中文", text: "Hi" }, undefined, undefined, undefined)).rejects.toThrow(
    "No active model found",
  )
  const ctx = {
    model: { provider: "p", id: "m" },
    modelRegistry: { complete: async () => ({ stopReason: "error", content: [], usage: {} }) },
  }
  await expect(fake.tools[0].execute("id", { to: "中文", text: "Hi" }, undefined, undefined, ctx)).rejects.toThrow(
    "Translation failed (p/m)",
  )
})
