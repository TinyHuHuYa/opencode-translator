import { tool, type PluginInput } from "@opencode-ai/plugin"
import { INTERNAL_AGENT_ID, type NormalizedOptions, type Terms } from "./config"
import { type HistoryEntry, ModelTracker } from "./model"
import { renderSystemPrompt, renderUserPrompt } from "./prompt"
import { extractAssistantText, toPublicError, TranslationFormatError, validateTranslation } from "./result"

export type SessionGateway = {
  createChild(parentID: string): Promise<string>
  promptChild(input: {
    sessionID: string
    agent: string
    model: { providerID: string; modelID: string }
    system: string
    text: string
    signal: AbortSignal
  }): Promise<readonly unknown[]>
  deleteSession(sessionID: string): Promise<void>
  loadHistory(sessionID: string): Promise<readonly unknown[]>
  logCleanupFailure(sessionID: string, message: string): Promise<void>
}

type SdkResponse<T> = { data?: T; error?: unknown }

function requireData<T>(response: SdkResponse<T>): T {
  if (response.data === undefined) throw new Error("OpenCode session request failed")
  return response.data
}

export function createSessionGateway(
  client: PluginInput["client"],
  directory: string,
): SessionGateway {
  return {
    async createChild(parentID) {
      const session = requireData(await client.session.create({
        body: { parentID, title: "Translation" },
        query: { directory },
      }))
      if (typeof session.id !== "string" || !session.id) {
        throw new Error("OpenCode session request failed")
      }
      return session.id
    },

    async promptChild(input) {
      const message = requireData(await client.session.prompt({
        path: { id: input.sessionID },
        query: { directory },
        signal: input.signal,
        body: {
          agent: INTERNAL_AGENT_ID,
          model: input.model,
          system: input.system,
          parts: [{ type: "text", text: input.text }],
        },
      }))
      if (!Array.isArray(message.parts)) throw new Error("OpenCode session request failed")
      return message.parts
    },

    async deleteSession(sessionID) {
      requireData(await client.session.delete({
        path: { id: sessionID },
        query: { directory },
      }))
    },

    async loadHistory(sessionID) {
      return requireData(await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      }))
    },

    async logCleanupFailure(sessionID, message) {
      requireData(await client.app.log({
        query: { directory },
        body: {
          service: INTERNAL_AGENT_ID,
          level: "warn",
          message,
          extra: { sessionID },
        },
      }))
    },
  }
}

export type TranslateToolDependencies = {
  gateway: SessionGateway
  models: ModelTracker
  options: NormalizedOptions
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`Invalid ${field}: expected a non-empty string`)
}

function publicToolError(error: unknown, model?: { providerID: string; modelID: string }): Error {
  if (error instanceof Error && (
    error.message === "No active model found for session" ||
    error.message.startsWith("Invalid to:") ||
    error.message.startsWith("Invalid text:")
  )) return error
  const publicError = toPublicError(error, model)
  if (error instanceof TranslationFormatError) {
    return new Error(publicError.message, { cause: error })
  }
  return publicError
}

async function logCleanupFailure(
  gateway: SessionGateway,
  sessionID: string,
  cleanupError: unknown,
): Promise<void> {
  const message = cleanupDiagnostic(cleanupError)
  try {
    await gateway.logCleanupFailure(sessionID, message)
  } catch (loggingError) {
    // A failed diagnostic sink cannot replace a translation result or primary error.
    void loggingError
  }
}

function cleanupDiagnostic(error: unknown): string {
  const prefix = "Failed to delete translation child session: "
  if (typeof error !== "object" || error === null) return `${prefix}cleanup failed`

  try {
    const value = error as { status?: unknown }
    if (typeof value.status === "number" && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) {
      return `${prefix}status=${value.status}`
    }
    return `${prefix}cleanup failed`
  } catch (summaryError) {
    void summaryError
    return `${prefix}cleanup failed`
  }
}

export function createTranslateTool(dependencies: TranslateToolDependencies): ReturnType<typeof tool> {
  return tool({
    description: "Translate text to the requested language. Return the tool result verbatim, without commentary.",
    args: {
      to: tool.schema.string().min(1, "to must not be empty"),
      text: tool.schema.string().min(1, "text must not be empty"),
      from: tool.schema.string().optional(),
      title: tool.schema.string().optional(),
      summary: tool.schema.string().optional(),
      terms: tool.schema.union([
        tool.schema.record(tool.schema.string(), tool.schema.string()),
        tool.schema.array(tool.schema.string()),
      ]).optional(),
      styleGuide: tool.schema.string().optional(),
    },
    async execute(args, context) {
      let childSessionID: string | undefined
      let model: { providerID: string; modelID: string } | undefined

      try {
        requireNonEmpty(args.to, "to")
        requireNonEmpty(args.text, "text")
        model = await dependencies.models.resolve(context.sessionID, async () => {
          return (await dependencies.gateway.loadHistory(context.sessionID)) as readonly HistoryEntry[]
        })
        childSessionID = await dependencies.gateway.createChild(context.sessionID)
        const terms: Terms = args.terms ?? dependencies.options.terms
        const styleGuide = args.styleGuide ?? dependencies.options.styleGuide
        const parts = await dependencies.gateway.promptChild({
          sessionID: childSessionID,
          agent: INTERNAL_AGENT_ID,
          model,
          system: renderSystemPrompt({
            to: args.to,
            title: args.title,
            summary: args.summary,
            terms,
            styleGuide,
          }),
          text: renderUserPrompt({ to: args.to, text: args.text, from: args.from }),
          signal: context.abort,
        })
        return validateTranslation(args.text, extractAssistantText(parts))
      } catch (error) {
        throw publicToolError(error, model)
      } finally {
        if (childSessionID) {
          try {
            await dependencies.gateway.deleteSession(childSessionID)
          } catch (cleanupError) {
            await logCleanupFailure(dependencies.gateway, childSessionID, cleanupError)
          }
        }
      }
    },
  })
}
