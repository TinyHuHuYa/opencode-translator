# OpenCode 翻译插件实施计划

> **供代理执行者：** REQUIRED SUB-SKILL：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务实施本计划。各步骤使用复选框（`- [ ]`）跟踪。

**目标：** 构建、验证并发布一个同时提供 `/t` 命令与 `translate` 工具、复用 OpenCode 当前模型的翻译插件。

**架构：** 插件通过 `config` hook 注册无工具权限的翻译代理和 `/t` 命令，通过命令信封把动态目标语言安全传递给 `chat.message` hook，并将完整模板注入 `UserMessage.system`。`translate` 工具通过 OpenCode SDK 创建临时子会话，显式复用父会话模型，以同一 system/user 提示完成翻译并在所有退出路径清理子会话。

**技术栈：** TypeScript 5.9.3、OpenCode Plugin/SDK 1.18.23、Bun 1.4.0、tsup 8.5.1、`bun:test`、npm 包格式 ESM。

**规格：** `docs/superpowers/specs/2026-08-28-opencode-translator-design.md`

## 全局约束

- 包名与插件 ID 均为 `opencode-translator`，初始版本为 `0.1.0`。
- 兼容并锁定当前开发基线 OpenCode `1.18.23` 与 `@opencode-ai/plugin` `1.18.23`。
- 不读取、存储或记录 API 密钥、认证头、源文本或译文。
- 不配置固定模型；`/t` 继承当前会话模型，`translate` 显式复用父会话模型。
- 不使用参考图片中的字符上限或请求频率，不自动分块，不自动重试。
- 输入未含 `%%` 时输出不得含 `%%`；输入含有 `%%` 时输出数量必须完全一致。
- 实际英文系统提示词必须与规格第 4 节逐字一致，仅展开已定义占位符。
- `src/index.ts` 只能默认导出一个 `{ id, server }` 插件模块，避免 OpenCode legacy loader 把非函数命名导出误当插件执行。
- 每个生产模块保持单一职责，测试不连接真实模型、网络或 GitHub。

---

### 任务 1：建立可构建、可测试的包与配置注入

**文件：**

- 创建：`package.json`
- 创建：`tsconfig.json`
- 创建：`.gitignore`
- 创建：`src/config.ts`
- 创建：`test/config.test.ts`

**接口：**

- 产出：`TranslatorOptions`、`NormalizedOptions`、`normalizeOptions(raw)`、`installPluginConfig(config, options)`、`INTERNAL_AGENT_ID`。
- 供后续使用：任务 2、5、6 使用规范化选项；任务 6 调用配置注入函数。

- [ ] **步骤 1：创建包清单和 TypeScript 配置**

`package.json` 使用以下完整内容：

```json
{
  "name": "opencode-translator",
  "version": "0.1.0",
  "description": "Translate text with the model currently selected in OpenCode.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "build": "tsup src/index.ts --format esm --dts --clean --external @opencode-ai/plugin",
    "check": "npm test && npm run typecheck && npm run build",
    "prepublishOnly": "npm run check"
  },
  "keywords": [
    "opencode",
    "translation",
    "translator",
    "plugin"
  ],
  "license": "MIT",
  "dependencies": {
    "@opencode-ai/plugin": "1.18.23"
  },
  "devDependencies": {
    "@types/bun": "1.4.0",
    "bun": "1.4.0",
    "tsup": "8.5.1",
    "typescript": "5.9.3"
  },
  "engines": {
    "node": ">=20"
  }
}
```

`tsconfig.json` 使用：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["bun"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`.gitignore` 使用：

```gitignore
node_modules/
dist/
coverage/
*.tgz
```

- [ ] **步骤 2：安装锁定依赖**

运行：

```powershell
npm install
```

预期：生成 `package-lock.json` 和 `node_modules/`，命令退出码为 0。

- [ ] **步骤 3：编写配置失败测试**

在 `test/config.test.ts` 中先覆盖以下行为：

```ts
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
```

- [ ] **步骤 4：运行测试确认失败**

运行：

```powershell
npm test -- test/config.test.ts
```

预期：FAIL，原因是 `src/config.ts` 尚不存在。

- [ ] **步骤 5：实现选项校验与配置注入**

`src/config.ts` 定义以下公共形状并完成最小实现：

```ts
import type { Config } from "@opencode-ai/plugin"

export const INTERNAL_AGENT_ID = "opencode-translator"

export type Terms = Record<string, string> | string[]

export type TranslatorOptions = {
  command?: string
  temperature?: number
  styleGuide?: string
  terms?: Terms
}

export type NormalizedOptions = {
  command: string
  temperature: number
  styleGuide: string
  terms: Terms
}

export function normalizeOptions(raw: Record<string, unknown> = {}): NormalizedOptions
export function installPluginConfig(config: Config, options: NormalizedOptions): void
```

校验规则：命令名匹配 `/^[A-Za-z][A-Za-z0-9_-]*$/`；温度是 `0` 到 `2` 的有限数；`styleGuide` 是字符串；`terms` 只能是字符串数组或字符串到字符串的普通对象。注入的代理使用 `mode: "subagent"`、`maxSteps: 1`、`tools: { "*": false }`、`permission.edit/bash/webfetch: "deny"`，并设置一条固定的最小代理提示，要求严格遵循逐请求 system 指令。

- [ ] **步骤 6：运行配置测试和类型检查**

运行：

```powershell
npm test -- test/config.test.ts
npm run typecheck
```

预期：配置测试全部 PASS，类型检查退出码为 0。

- [ ] **步骤 7：提交任务 1**

```powershell
git add package.json package-lock.json tsconfig.json .gitignore src/config.ts test/config.test.ts
git commit -m "chore: scaffold opencode translator package"
```

---

### 任务 2：实现提示词渲染与 `/t` 命令信封

**文件：**

- 创建：`src/prompt.ts`
- 创建：`src/command.ts`
- 创建：`test/prompt.test.ts`
- 创建：`test/command.test.ts`

**接口：**

- 产出：`renderSystemPrompt(context)`、`renderUserPrompt(context)`。
- 产出：`parseCommandArguments(input)`、`encodeCommandEnvelope(request)`、`decodeCommandEnvelope(text)`。
- 供后续使用：任务 5 使用提示词渲染；任务 6 使用命令解析与信封消费。

- [ ] **步骤 1：编写提示词渲染失败测试**

`test/prompt.test.ts` 至少包含：

```ts
import { expect, test } from "bun:test"
import { renderSystemPrompt, renderUserPrompt } from "../src/prompt"

test("renders target and omits unavailable optional blocks", () => {
  const prompt = renderSystemPrompt({ to: "中文" })
  expect(prompt).toContain("professional 中文 native translator")
  expect(prompt).not.toContain("{{title_prompt}}")
  expect(prompt).not.toContain("{{summary_prompt}}")
  expect(prompt).not.toContain("{{terms_prompt}}")
  expect(prompt).not.toContain("{{imt_style_guide}}")
})

test("renders delimited title summary terms and style guide", () => {
  const prompt = renderSystemPrompt({
    to: "Japanese",
    title: "Page title",
    summary: "Page summary",
    terms: { OpenCode: "OpenCode" },
    styleGuide: "Use polite Japanese.",
  })
  expect(prompt).toContain("## Webpage Title Context\n\nPage title")
  expect(prompt).toContain("OpenCode => OpenCode")
  expect(prompt).toContain("Use polite Japanese.")
})

test("keeps source text exact in the user message body", () => {
  expect(renderUserPrompt({ to: "中文", text: "  <b>Hello</b>\n" })).toBe(
    "Source language: auto-detect\nTarget language: 中文\n\n  <b>Hello</b>\n",
  )
})
```

- [ ] **步骤 2：编写命令解析失败测试**

`test/command.test.ts` 至少覆盖：

```ts
import { expect, test } from "bun:test"
import { decodeCommandEnvelope, encodeCommandEnvelope, parseCommandArguments } from "../src/command"

test("parses an unquoted target", () => {
  expect(parseCommandArguments("中文 Hello world")).toEqual({ to: "中文", text: "Hello world" })
})

test("parses a quoted target and preserves multiline text", () => {
  expect(parseCommandArguments('"Simplified Chinese" First\n\nSecond')).toEqual({
    to: "Simplified Chinese",
    text: "First\n\nSecond",
  })
})

test("round-trips unicode command content through the internal envelope", () => {
  const request = { to: "日本語", text: "你好 %% 世界" }
  expect(decodeCommandEnvelope(encodeCommandEnvelope(request))).toEqual(request)
})

test("rejects missing source text", () => {
  expect(() => parseCommandArguments("中文   ")).toThrow("/t")
})
```

- [ ] **步骤 3：运行测试确认失败**

```powershell
npm test -- test/prompt.test.ts test/command.test.ts
```

预期：FAIL，原因是两个生产模块尚不存在。

- [ ] **步骤 4：实现提示词渲染**

`src/prompt.ts` 定义：

```ts
import type { Terms } from "./config"

export type PromptContext = {
  to: string
  text?: string
  from?: string
  title?: string
  summary?: string
  terms?: Terms
  styleGuide?: string
}

export function renderSystemPrompt(context: Omit<PromptContext, "text" | "from">): string
export function renderUserPrompt(context: Pick<PromptContext, "to" | "text" | "from"> & { text: string }): string
```

把规格第 4 节的英文模板作为单个常量完整复制。使用精确字符串替换展开 `{{to}}`、`{{title_prompt}}`、`{{summary_prompt}}`、`{{terms_prompt}}` 和 `{{imt_style_guide}}`；不得通过拼写相似的新模板重写规则正文。

- [ ] **步骤 5：实现命令解析与防碰撞信封**

`src/command.ts` 定义：

```ts
export type CommandRequest = { to: string; text: string }
export const COMMAND_ENVELOPE_PREFIX = "__OPENCODE_TRANSLATOR_V1__:"

export function parseCommandArguments(input: string): CommandRequest
export function encodeCommandEnvelope(request: CommandRequest): string
export function decodeCommandEnvelope(text: string): CommandRequest | undefined
```

信封载荷使用 `Buffer.from(JSON.stringify(request), "utf8").toString("base64url")`，解码后再次校验对象只含非空字符串 `to` 与 `text`。普通用户文本即使包含前缀但载荷无效，也返回 `undefined` 而不是抛错。

- [ ] **步骤 6：运行任务 2 测试**

```powershell
npm test -- test/prompt.test.ts test/command.test.ts
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 7：提交任务 2**

```powershell
git add src/prompt.ts src/command.ts test/prompt.test.ts test/command.test.ts
git commit -m "feat: render translation prompts and parse t command"
```

---

### 任务 3：实现译文提取、格式校验与安全错误

**文件：**

- 创建：`src/result.ts`
- 创建：`test/result.test.ts`

**接口：**

- 产出：`extractAssistantText(parts)`、`validateTranslation(source, output)`、`toPublicError(error, model?)`。
- 产出：`TranslationFormatError`，保留 `expectedSeparators`、`actualSeparators` 和 `output` 属性。
- 供后续使用：任务 5 校验工具输出；任务 6 校验 `/t` 输出。

- [ ] **步骤 1：编写失败测试**

```ts
import { expect, test } from "bun:test"
import { extractAssistantText, toPublicError, validateTranslation } from "../src/result"

test("concatenates text parts without trimming", () => {
  expect(extractAssistantText([
    { type: "text", text: " first" },
    { type: "reasoning", text: "hidden" },
    { type: "text", text: "\nsecond " },
  ])).toBe(" first\nsecond ")
})

test("rejects separators added by the model", () => {
  expect(() => validateTranslation("hello", "你好 %%")).toThrow("separator")
})

test("accepts the same separator count", () => {
  expect(validateTranslation("A %% B", "甲 %% 乙")).toBe("甲 %% 乙")
})

test("redacts headers tokens and response bodies", () => {
  const error = toPublicError({
    message: "request failed",
    data: { responseHeaders: { authorization: "secret" }, responseBody: "token=secret" },
  }, { providerID: "deepseek", modelID: "deepseek-chat" })
  expect(error.message).toContain("deepseek/deepseek-chat")
  expect(error.message).not.toContain("secret")
})
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm test -- test/result.test.ts
```

预期：FAIL，原因是 `src/result.ts` 尚不存在。

- [ ] **步骤 3：实现结果处理**

`src/result.ts` 定义以下签名：

```ts
export type ModelRef = { providerID: string; modelID: string }

export class TranslationFormatError extends Error {
  readonly expectedSeparators: number
  readonly actualSeparators: number
  readonly output: string
}

export function extractAssistantText(parts: readonly unknown[]): string
export function validateTranslation(source: string, output: string): string
export function toPublicError(error: unknown, model?: ModelRef): Error
```

`validateTranslation` 使用非重叠的字面量 `%%` 计数；输出全为空白时抛出 `Translation output is empty`。`toPublicError` 只保留安全的 `Error.message`、提供商 ID 与模型 ID，不序列化未知对象或 `data`。

- [ ] **步骤 4：运行结果测试和全量单测**

```powershell
npm test -- test/result.test.ts
npm test
```

预期：全部 PASS。

- [ ] **步骤 5：提交任务 3**

```powershell
git add src/result.ts test/result.test.ts
git commit -m "feat: validate translation output"
```

---

### 任务 4：实现按会话跟踪和解析当前模型

**文件：**

- 创建：`src/model.ts`
- 创建：`test/model.test.ts`

**接口：**

- 产出：`ModelTracker.remember(sessionID, model)`、`forget(sessionID)`、`resolve(sessionID, loadHistory)`。
- 消费：任务 3 的 `ModelRef`。
- 供后续使用：任务 5 在工具调用时解析模型；任务 6 从 `chat.message` 与 `chat.params` 更新模型。

- [ ] **步骤 1：编写失败测试**

```ts
import { expect, test } from "bun:test"
import { ModelTracker } from "../src/model"

test("returns the latest remembered model", async () => {
  const tracker = new ModelTracker()
  tracker.remember("session", { providerID: "a", modelID: "one" })
  tracker.remember("session", { providerID: "b", modelID: "two" })
  expect(await tracker.resolve("session", async () => [])).toEqual({ providerID: "b", modelID: "two" })
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

test("fails instead of choosing a global default", async () => {
  const tracker = new ModelTracker()
  await expect(tracker.resolve("missing", async () => [])).rejects.toThrow("No active model found")
})
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm test -- test/model.test.ts
```

预期：FAIL，原因是 `src/model.ts` 尚不存在。

- [ ] **步骤 3：实现模型跟踪器**

```ts
import type { ModelRef } from "./result"

export type HistoryEntry = {
  info?: {
    role?: string
    model?: { providerID?: string; modelID?: string }
  }
}

export class ModelTracker {
  remember(sessionID: string, model: ModelRef): void
  forget(sessionID: string): void
  resolve(sessionID: string, loadHistory: () => Promise<readonly HistoryEntry[]>): Promise<ModelRef>
}
```

读取历史时从数组末尾向前扫描，只接受 `role === "user"` 且两个 ID 都是非空字符串的消息；成功后把后备结果写回缓存。

- [ ] **步骤 4：运行模型测试**

```powershell
npm test -- test/model.test.ts
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 5：提交任务 4**

```powershell
git add src/model.ts test/model.test.ts
git commit -m "feat: track the active opencode model"
```

---

### 任务 5：实现 `translate` 工具与临时子会话

**文件：**

- 创建：`src/tool.ts`
- 创建：`test/tool.test.ts`

**接口：**

- 消费：`NormalizedOptions`、`ModelTracker`、提示词渲染、结果提取和校验。
- 产出：`createSessionGateway(client, directory)`、`createTranslateTool(dependencies)`。
- 供后续使用：任务 6 把工具注册到插件 hooks。

- [ ] **步骤 1：定义可伪造的 SDK 网关并编写生命周期失败测试**

`test/tool.test.ts` 使用以下网关形状：

```ts
type FakeGateway = {
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
  loadHistory(sessionID: string): Promise<readonly any[]>
  logCleanupFailure(sessionID: string, message: string): Promise<void>
}
```

至少测试：成功返回译文并删除子会话、模型失败仍删除、取消仍删除、清理失败不覆盖成功译文、`%%` 不匹配返回格式错误、单次 terms/styleGuide 覆盖默认值。

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm test -- test/tool.test.ts
```

预期：FAIL，原因是 `src/tool.ts` 尚不存在。

- [ ] **步骤 3：实现 SDK 网关**

`src/tool.ts` 定义：

```ts
import type { PluginInput } from "@opencode-ai/plugin"

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

export function createSessionGateway(
  client: PluginInput["client"],
  directory: string,
): SessionGateway
```

网关调用 `client.session.create({ body: { parentID, title: "Translation" }, query: { directory } })`、`client.session.prompt(...)`、`client.session.delete(...)`、`client.session.messages(...)` 和 `client.app.log(...)`。写一个内部 `requireData<T>`，同时兼容 SDK 的 `{ data, error }` 响应并在 `data` 缺失时抛出安全错误。`prompt` 请求必须传 `signal`、`body.agent: INTERNAL_AGENT_ID`、解析出的 `body.model`、渲染后的 `body.system` 和单个 text part。

- [ ] **步骤 4：实现工具工厂**

```ts
export type TranslateToolDependencies = {
  gateway: SessionGateway
  models: ModelTracker
  options: NormalizedOptions
}

export function createTranslateTool(dependencies: TranslateToolDependencies): ReturnType<typeof tool>
```

工具 schema 精确包含 `to`、`text`、可选 `from/title/summary/styleGuide` 以及 `Record<string,string> | string[]` 类型的可选 `terms`。执行流程严格按规格第 8 节；清理错误只通过 `logCleanupFailure` 记录，不记录源文本或译文。

- [ ] **步骤 5：运行工具测试**

```powershell
npm test -- test/tool.test.ts
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 6：提交任务 5**

```powershell
git add src/tool.ts test/tool.test.ts
git commit -m "feat: add translate tool with child sessions"
```

---

### 任务 6：组装插件 hooks 与 `/t` 端到端行为

**文件：**

- 创建：`src/index.ts`
- 创建：`test/plugin.test.ts`

**接口：**

- 消费：前五个任务的所有公共接口。
- 产出：默认导出的 `{ id: "opencode-translator", server }`，这是包唯一入口导出。

- [ ] **步骤 1：编写插件集成失败测试**

`test/plugin.test.ts` 用伪 client 初始化默认插件模块的 `server`，验证：

```ts
import { expect, test } from "bun:test"
import pluginModule from "../src/index"
import { decodeCommandEnvelope } from "../src/command"

test("exports one v1 plugin module", () => {
  expect(pluginModule.id).toBe("opencode-translator")
  expect(typeof pluginModule.server).toBe("function")
})

test("turns /t arguments into a system-scoped translation message", async () => {
  const hooks = await pluginModule.server(fakePluginInput, {})
  const commandOutput = { parts: [] as any[] }
  await hooks["command.execute.before"]?.(
    { command: "t", sessionID: "s", arguments: "中文 Hello" },
    commandOutput,
  )
  expect(decodeCommandEnvelope(commandOutput.parts[0].text)).toEqual({ to: "中文", text: "Hello" })

  const messageOutput = {
    message: fakeUserMessage,
    parts: commandOutput.parts,
  }
  await hooks["chat.message"]?.(
    { sessionID: "s", model: { providerID: "p", modelID: "m" } },
    messageOutput,
  )
  expect(messageOutput.message.system).toContain("professional 中文 native translator")
  expect(messageOutput.parts[0].text).toContain("Target language: 中文")
  expect(messageOutput.parts[0].text).not.toContain("__OPENCODE_TRANSLATOR_V1__")
})
```

再测试：其他命令不变、普通消息不变、`chat.params` 把 `model.id` 记录成 `modelID`、`experimental.text.complete` 对 `/t` 的 `%%` 违规抛错、`session.error/session.idle/session.deleted` 清理待验证状态。

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm test -- test/plugin.test.ts
```

预期：FAIL，原因是 `src/index.ts` 尚不存在。

- [ ] **步骤 3：实现默认插件模块**

`src/index.ts` 的顶层只保留默认导出：

```ts
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
    config: async (config) => installPluginConfig(config, options),
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
      textPart.text = renderUserPrompt({ to: request.to, text: request.text })
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
        validateTranslation(source, output.text)
      } finally {
        pendingSources.delete(event.sessionID)
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.error" || event.type === "session.idle") {
        if (event.properties.sessionID) pendingSources.delete(event.properties.sessionID)
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
```

hooks 行为：

- `config`：调用 `installPluginConfig`。
- `tool.translate`：注册 `createTranslateTool` 的结果。
- `command.execute.before`：仅处理规范化命令名，解析参数并把单个 text part 改成内部信封。
- `chat.message`：记录 `input.model`；识别信封后设置 `output.message.system`、把 part 文本替换为正式 user 提示，并记录该会话源文本的分隔符预期。
- `chat.params`：用 `{ providerID: input.model.providerID, modelID: input.model.id }` 更新模型跟踪器。
- `experimental.text.complete`：只校验有待处理 `/t` 预期的会话；调用 `validateTranslation` 后删除预期。
- `event`：在 `session.error`、`session.idle` 和 `session.deleted` 时清理残留预期；删除会话时同时 `models.forget(sessionID)`。

- [ ] **步骤 4：运行集成测试、全量测试与类型检查**

```powershell
npm test -- test/plugin.test.ts
npm test
npm run typecheck
```

预期：全部 PASS。

- [ ] **步骤 5：构建并检查入口导出**

```powershell
npm run build
node -e "import('./dist/index.js').then((m)=>{if(Object.keys(m).join(',')!=='default')process.exit(1);if(m.default.id!=='opencode-translator'||typeof m.default.server!=='function')process.exit(1)})"
```

预期：构建退出码为 0，入口检查退出码为 0，`dist/index.js` 与 `dist/index.d.ts` 存在。

- [ ] **步骤 6：提交任务 6**

```powershell
git add src/index.ts test/plugin.test.ts
git commit -m "feat: integrate translator plugin hooks"
```

---

### 任务 7：补齐文档、许可证与可发布包验证

**文件：**

- 创建：`README.md`
- 创建：`LICENSE`
- 修改：`package.json`
- 测试：完整测试、构建和 npm 打包检查

**接口：**

- 产出：用户可复制的 OpenCode 安装配置、双入口用法、配置说明、故障排除与手工模型切换测试矩阵。

- [ ] **步骤 1：编写中文 README**

README 必须包含：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-translator",
      {
        "command": "t",
        "temperature": 0.1,
        "styleGuide": "",
        "terms": {}
      }
    ]
  ]
}
```

并包含以下可执行示例：

```text
/t 中文 Hello world
/t "Simplified Chinese" Hello world
```

工具参数表必须列出 `to/text/from/title/summary/terms/styleGuide`，明确说明不需要插件专用 API Key、不自动分块、不自动重试、`%%` 由调用方显式控制。手工测试矩阵至少覆盖同一会话从模型 A 切换到模型 B 后再次执行 `/t`，以及让模型 B 调用 `translate`。

- [ ] **步骤 2：添加 MIT 许可证**

`LICENSE` 使用标准 MIT 文本，版权行写为：

```text
Copyright (c) 2026 Rui Guo
```

- [ ] **步骤 3：运行完整验证**

```powershell
npm test
npm run typecheck
npm run build
npm pack --dry-run
git diff --check
```

预期：测试 0 失败；类型检查和构建退出码为 0；打包清单只包含 `dist`、`README.md`、`LICENSE`、`package.json`；diff 检查无错误。

- [ ] **步骤 4：本地 OpenCode 加载冒烟测试**

创建临时目录，并使用项目的构建入口作为 file 插件启动一次 OpenCode 非交互命令。配置中不得写入或复制任何 API Key。验证日志中不存在插件加载错误，且命令列表包含 `t`、工具列表包含 `translate`。如果非交互 CLI 无法展示两者，使用 README 中的 TUI 手工步骤验证并记录 OpenCode `1.18.23` 的结果。

- [ ] **步骤 5：提交任务 7**

```powershell
git add README.md LICENSE package.json package-lock.json
git commit -m "docs: add installation and usage guide"
```

---

### 任务 8：最终审查并同步到公开 GitHub 仓库

**文件：**

- 检查：全部已跟踪文件
- 修改：仅当 GitHub 创建结果提供实际仓库 URL 时，在 `package.json` 添加真实的 `repository`、`homepage` 和 `bugs` 字段

**接口：**

- 产出：公开 GitHub 仓库 `opencode-translator`，默认分支 `main`，包含完整提交历史。

- [ ] **步骤 1：执行提交前最终验证**

```powershell
npm test
npm run typecheck
npm run build
npm pack --dry-run
git diff --check
git status --short
```

预期：前三项退出码为 0；打包清单正确；diff 检查无错误；工作区为空。

- [ ] **步骤 2：审查提交历史与敏感信息**

```powershell
git log --oneline --decorate -12
git grep -n -I -E "(api[_-]?key|authorization:|bearer [A-Za-z0-9._-]+|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)" -- . ":(exclude)package-lock.json"
```

预期：历史包含规格、计划和每个实施任务提交；敏感信息扫描不返回真实凭据。文档中作为说明出现的 `API Key` 字样允许存在，但不得出现任何密钥值。

- [ ] **步骤 3：创建公开 GitHub 仓库**

在已登录的 GitHub 网页会话中创建名为 `opencode-translator` 的公开空仓库，不自动添加 README、许可证或 `.gitignore`，因为本地仓库已经包含这些文件。记录 GitHub 返回的实际 HTTPS clone URL。

- [ ] **步骤 4：写入真实仓库元数据并提交**

把 GitHub 返回的真实 URL逐字写入 `package.json` 的 `repository.url`、`homepage` 和 `bugs.url`，重新运行：

```powershell
npm run check
npm pack --dry-run
git add package.json
git commit -m "chore: add github repository metadata"
```

预期：验证通过并生成一个只修改包元数据的提交。

- [ ] **步骤 5：添加远程并推送**

使用步骤 3 返回的实际 HTTPS clone URL 添加 `origin`，随后执行：

```powershell
git push -u origin main
```

如果 Git Credential Manager 弹出浏览器认证，用户在 GitHub 页面完成授权后继续。预期：推送成功，`main` 跟踪 `origin/main`。

- [ ] **步骤 6：远程验收**

在 GitHub 仓库页面确认公开可访问、README 正常渲染、默认分支为 `main`，并在本地执行：

```powershell
git remote -v
git status --short --branch
git ls-remote --heads origin main
```

预期：fetch/push URL 均指向刚创建的公开仓库；工作区干净；远程 `main` 的对象 ID 与本地 `HEAD` 一致。
