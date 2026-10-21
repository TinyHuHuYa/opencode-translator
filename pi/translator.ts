import { Type } from "@earendil-works/pi-ai"
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { parseCommandArguments } from "../src/command"
import { normalizeOptions, type NormalizedOptions, type Terms } from "../src/config"
import { renderSystemPrompt, renderUserPrompt } from "../src/prompt"
import { toPublicError, validateTranslation } from "../src/result"

/**
 * Pi (https://pi.dev) port of the translator.
 *
 * `/t` runs as an ordinary agent turn so every client — the TUI, RPC clients
 * such as Pi Desktop — shows the translation as a normal assistant message.
 * While that turn runs the extension (1) replaces the system prompt with the
 * translation prompt, (2) shows the model only the source text, (3) withholds
 * every tool, and (4) removes `%%` markers the model added on its own.
 */

type Run = { prompt: string; system: string; source: string; at: number }

// A /t run starts right after the command sends it; older pending state is stale.
const CLAIM_WINDOW_MS = 5_000

type MessageLike = { role?: string; content?: unknown }
type Block = { type?: string; text?: string }

function textOf(message: MessageLike): string {
  const { content } = message
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block: Block) => block?.type === "text" && typeof block.text === "string")
    .map((block: Block) => block.text)
    .join("")
}

/**
 * Reduce the model's view to the translation request alone: drop history and
 * anything else that is not the user message we rendered. Prefers the message
 * whose text equals the rendered prompt, then the newest user message.
 */
export function isolateSource<T extends MessageLike>(messages: readonly T[], prompt: string): T[] {
  let newestUser: T | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "user") continue
    if (textOf(message) === prompt) return [message]
    newestUser ??= message
  }
  return newestUser ? [newestUser] : [...messages]
}

/** Replace the text of an assistant message, keeping thinking and other blocks. */
export function withText<T extends MessageLike>(message: T, text: string): T {
  const content = Array.isArray(message.content) ? (message.content as Block[]) : []
  const next: Block[] = []
  let placed = false
  for (const block of content) {
    if (block?.type === "text") {
      if (!placed) next.push({ type: "text", text })
      placed = true
    } else {
      next.push(block)
    }
  }
  if (!placed) next.push({ type: "text", text })
  return { ...message, content: next }
}

export function createTranslator(options: NormalizedOptions = normalizeOptions()) {
  return function translatorExtension(pi: ExtensionAPI): void {
    // Set by /t until its run starts; active while that run is in progress.
    let pending: Run | undefined
    let active: Run | undefined
    let savedTools: string[] | undefined

    const finishRun = () => {
      pending = undefined
      active = undefined
      if (savedTools) {
        const tools = savedTools
        savedTools = undefined
        pi.setActiveTools(tools)
      }
    }

    pi.registerCommand(options.command, {
      description: "Translate text: /t <target> <text> or /t <source>:<target> <text>",
      handler: async (args, ctx) => {
        let request
        try {
          request = parseCommandArguments(args)
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : "Invalid /t command", "warning")
          return
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("Pi is busy. Run /t again when the current turn finishes.", "warning")
          return
        }
        const prompt = renderUserPrompt({ to: request.to, from: request.from, text: request.text })
        pending = {
          prompt,
          source: request.text,
          at: Date.now(),
          system: renderSystemPrompt({
            to: request.to,
            terms: options.terms,
            styleGuide: options.styleGuide,
          }),
        }
        try {
          pi.sendUserMessage(prompt)
        } catch (error) {
          pending = undefined
          throw error
        }
      },
    })

    pi.on("before_agent_start", (event) => {
      // The first user turn right after /t belongs to it (same text, or at least
      // started within the claim window); anything else is not ours.
      if (
        pending &&
        event.messageType === "user" &&
        (event.prompt === pending.prompt || Date.now() - pending.at <= CLAIM_WINDOW_MS)
      ) {
        active = pending
        pending = undefined
        savedTools = pi.getActiveTools()
        pi.setActiveTools([])
        return { systemPrompt: active.system }
      }
      if (event.messageType === "user") pending = undefined
      if (active || savedTools) finishRun()
      return undefined
    })

    pi.on("context", (event) => {
      if (!active) return undefined
      return { messages: isolateSource(event.messages as MessageLike[], active.prompt) as typeof event.messages }
    })

    // Backstop for the case where the tool set could not be emptied.
    pi.on("tool_call", () => {
      if (active) return { block: true, reason: "Tools are disabled while translating." }
      return undefined
    })

    pi.on("message_end", (event, ctx) => {
      if (!active) return undefined
      const message = event.message as MessageLike & { stopReason?: string }
      if (message.role !== "assistant" || message.stopReason !== "stop") return undefined
      const text = textOf(message)
      try {
        const cleaned = validateTranslation(active.source, text)
        if (cleaned === text) return undefined
        return { message: withText(message, cleaned) as typeof event.message }
      } catch (error) {
        ctx.ui.notify(toPublicError(error).message, "error")
        return undefined
      }
    })

    pi.on("agent_settled", () => finishRun())
    pi.on("session_shutdown", () => finishRun())

    pi.registerTool(createTranslateTool(options))
  }
}

function createTranslateTool(options: NormalizedOptions) {
  return defineTool({
    name: "translate",
    label: "Translate",
    description: "Translate text to the requested language. Return the tool result verbatim, without commentary.",
    parameters: Type.Object({
      to: Type.String({ minLength: 1, description: "Target language" }),
      text: Type.String({ minLength: 1, description: "Text to translate" }),
      from: Type.Optional(Type.String({ description: "Source language; omit to auto-detect" })),
      title: Type.Optional(Type.String({ description: "Page title, as reference context" })),
      summary: Type.Optional(Type.String({ description: "Page summary, as reference context" })),
      terms: Type.Optional(
        Type.Union([Type.Record(Type.String(), Type.String()), Type.Array(Type.String())], {
          description: "Preferred terms: { source: target } or a list to keep as written",
        }),
      ),
      styleGuide: Type.Optional(Type.String({ description: "Style guide for this call" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx?.model) throw new Error("No active model found for session")
      const terms: Terms = params.terms ?? options.terms
      const response = await ctx.modelRegistry.complete(
        ctx.model,
        {
          systemPrompt: renderSystemPrompt({
            to: params.to,
            title: params.title,
            summary: params.summary,
            terms,
            styleGuide: params.styleGuide ?? options.styleGuide,
          }),
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: renderUserPrompt({ to: params.to, from: params.from, text: params.text }) }],
              timestamp: Date.now(),
            },
          ],
        },
        { signal },
      )
      if (response.stopReason === "aborted") throw new Error("Translation cancelled")
      if (response.stopReason === "error") {
        throw toPublicError(new Error("model request failed"), { providerID: ctx.model.provider, modelID: ctx.model.id })
      }
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("")
      try {
        const translated = validateTranslation(params.text, text)
        return { content: [{ type: "text", text: translated }], details: undefined, usage: response.usage }
      } catch (error) {
        throw toPublicError(error, { providerID: ctx.model.provider, modelID: ctx.model.id })
      }
    },
  })
}

export default createTranslator()
