import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { decodeCommandEnvelope, encodeCommandEnvelope, parseCommandArguments } from "./command"
import { installPluginConfig, normalizeOptions } from "./config"
import { ModelTracker } from "./model"
import { renderSystemPrompt, renderUserPrompt } from "./prompt"
import { validateTranslation } from "./result"
import { createSessionGateway, createTranslateTool } from "./tool"

const server: Plugin = async (input, rawOptions) => {
  const options = normalizeOptions(rawOptions ?? {})
  const models = new ModelTracker()
  const gateway = createSessionGateway(input.client, input.directory)
  const pendingSources = new Map<string, string>()

  return {
    config: async (config) => {
      installPluginConfig(config, options)
    },
    tool: {
      translate: createTranslateTool({ gateway, models, options }),
    },
    "command.execute.before": async (event, output) => {
      if (event.command !== options.command) return
      const request = parseCommandArguments(event.arguments)
      const textPart = output.parts.find((part) => part.type === "text")
      if (!textPart || textPart.type !== "text") throw new Error("Translation command has no text part")
      textPart.text = encodeCommandEnvelope(request)
      output.parts.splice(0, output.parts.length, textPart)
    },
    "chat.message": async (event, output) => {
      if (event.model) models.remember(event.sessionID, event.model)
      const textPart = output.parts.find((part) => part.type === "text")
      if (!textPart || textPart.type !== "text") return
      const request = decodeCommandEnvelope(textPart.text)
      if (!request) return
      output.message.system = renderSystemPrompt({
        to: request.to,
        terms: options.terms,
        styleGuide: options.styleGuide,
      })
      textPart.text = renderUserPrompt({ to: request.to, from: request.from, text: request.text })
      pendingSources.set(event.sessionID, request.text)
    },
    "chat.params": async (event) => {
      models.remember(event.sessionID, {
        providerID: event.model.providerID,
        modelID: event.model.id,
      })
    },
    "experimental.text.complete": async (event, output) => {
      const source = pendingSources.get(event.sessionID)
      if (source === undefined) return
      try {
        output.text = validateTranslation(source, output.text)
      } finally {
        pendingSources.delete(event.sessionID)
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.error" || event.type === "session.idle") {
        const sessionID = event.properties.sessionID
        if (sessionID) pendingSources.delete(sessionID)
      }
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        pendingSources.delete(sessionID)
        models.forget(sessionID)
      }
    },
  }
}

export default {
  id: "opencode-translator",
  server,
} satisfies PluginModule
