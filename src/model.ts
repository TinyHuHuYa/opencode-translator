import type { ModelRef } from "./result"

export type HistoryEntry = {
  info?: {
    role?: string
    model?: { providerID?: string; modelID?: string }
  }
}

function copyModel(model: ModelRef): ModelRef {
  return { providerID: model.providerID, modelID: model.modelID }
}

function isCompleteModel(model: { providerID?: string; modelID?: string } | undefined): model is ModelRef {
  return typeof model?.providerID === "string" && model.providerID.length > 0 &&
    typeof model.modelID === "string" && model.modelID.length > 0
}

export class ModelTracker {
  private readonly models = new Map<string, ModelRef>()

  remember(sessionID: string, model: ModelRef): void {
    this.models.set(sessionID, copyModel(model))
  }

  forget(sessionID: string): void {
    this.models.delete(sessionID)
  }

  async resolve(
    sessionID: string,
    loadHistory: () => Promise<readonly HistoryEntry[]>,
  ): Promise<ModelRef> {
    const remembered = this.models.get(sessionID)
    if (remembered) return copyModel(remembered)

    const history = await loadHistory()
    for (let index = history.length - 1; index >= 0; index--) {
      const entry = history[index]
      if (entry?.info?.role !== "user" || !isCompleteModel(entry.info.model)) continue
      const model = copyModel(entry.info.model)
      this.models.set(sessionID, model)
      return copyModel(model)
    }

    throw new Error("No active model found for session")
  }
}
