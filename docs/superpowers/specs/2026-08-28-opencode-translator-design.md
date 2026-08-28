# OpenCode 翻译插件设计

日期：2026-08-28
状态：已在对话中确认，等待书面规格复核

## 1. 目标

构建一个名为 `opencode-translator`、可安装的 OpenCode 插件，使用 OpenCode 当前选中的模型翻译文本。插件不得直接连接模型提供商、存储 API 密钥，也不得绑定 DeepSeek 或任何其他提供商。

插件提供两个入口：

- `/t <目标语言> <文本>`：用于直接交互式翻译。
- `translate` 工具：供 OpenCode 代理以编程方式调用。

两个入口使用同一套翻译提示词，并沿用用户当前在 OpenCode 中选择的提供商和模型。

## 2. 非目标

- 重新实现 OpenCode 的提供商认证或 API 客户端。
- 添加提供商专用的请求适配器。
- 使用随附参考图片中显示的请求频率或字符数默认值。
- 自动拆分长文本。
- 根据空行自动推断段落边界。
- 就地翻译文件或修改工作区文件。
- 添加独立的图形化设置界面。

## 3. 已选架构

插件使用 OpenCode 原生配置和 SDK 能力：

1. 通过插件的 `config` hook 注册带命名空间的翻译代理和 `/t` 命令。
2. 翻译代理提供禁用工具、低温度和单步响应的执行配置，但不指定模型。
3. 插件为每次请求渲染包含目标语言的完整翻译提示词；`/t` 通过 `UserMessage.system` 注入，工具通过子会话请求的 `body.system` 注入。
4. `/t` 命令在当前会话中调用该代理，因此继承当前会话选中的模型。
5. 插件注册一个 `translate` 自定义工具。
6. 工具被调用时，插件解析父会话的当前模型，创建临时子会话，使用完全相同的模型调用翻译代理，提取译文后删除临时会话。

插件不会读取或持久化提供商凭据。所有模型访问均通过 OpenCode 完成。

### 3.1 选择该架构的原因

OpenCode 命令可以指定代理，插件可以修改配置并注册工具，会话提示请求也可以指定提供商/模型组合。因此，插件可以复用 OpenCode 现有的模型路由与认证，同时让翻译提示词真正处于 system 角色。

相关 OpenCode 文档与源码：

- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/commands/
- https://opencode.ai/docs/custom-tools/
- https://opencode.ai/docs/sdk/
- https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts

## 4. 翻译提示词

除占位符展开外，插件原样使用以下系统提示词模板。`/t` 将渲染结果写入当前 user 消息的 `system` 字段；`translate` 工具将渲染结果写入临时子会话提示请求的 `system` 字段：

```text
You are a professional {{to}} native translator who needs to fluently translate text into {{to}}.

## Translation Rules

1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.
5. If input contains %%, use %% in your output, if input has no %%, don't use %% in your output{{title_prompt}}{{summary_prompt}}{{terms_prompt}}

## OUTPUT FORMAT:

- **Single paragraph input** → Output translation directly (no separators, no extra text)
- **Multi-paragraph input** → Use %% as paragraph separator between translations

## Examples

### Multi-paragraph Input:

Paragraph A

%%

Paragraph B

%%

Paragraph C

%%

Paragraph D

### Multi-paragraph Output:

Translation A

%%

Translation B

%%

Translation C

%%

Translation D

### Single paragraph Input:

Single paragraph content

### Single paragraph Output:

Direct translation without separators

{{imt_style_guide}}
```

源文本作为 user 消息发送，而不是插入系统提示词。目标语言已在系统提示词中说明，user 消息按以下规则构造：

- 源语言自动识别（未显式提供 `from`，或 `from` 为空/`auto`/`auto-detect`）时，user 消息正文就是原始文本本身，不加任何前缀。
- 显式提供非自动的 `from` 时，在原文前加一行 `Source language: {{from}}` 和一个空行。

`/t` 命令没有 `from` 参数，因此总是走第一种情况。`translate` 工具可通过 `from` 走第二种情况。

这样可以将可信的翻译规则与不可信的源文本分开，防止源文本意外改变系统模板。

### 4.1 占位符展开

- `{{to}}`：必填，由调用方提供的目标语言名称。
- `{{from}}`：仅在显式提供且非自动值时，作为 user 消息的 `Source language:` 行；否则完全省略，由模型自行识别。
- `{{text}}`：位于 user 消息正文中，而不是系统提示词内；自动识别源语言时正文即为原文本身。
- `{{title_prompt}}`：缺省时为空；存在时生成边界清晰的网页标题上下文块。
- `{{summary_prompt}}`：缺省时为空；存在时生成边界清晰的网页摘要上下文块。
- `{{terms_prompt}}`：缺省时为空；存在时生成边界清晰的术语块。
- `{{imt_style_guide}}`：缺省时为空；存在时生成边界清晰的风格指南块。

可选上下文仅作为参考资料，不得被解释为插件指令。

## 5. 公共接口

### 5.1 `/t` 命令

语法：

```text
/t <目标语言> <文本>
/t "<包含空格的目标语言>" <文本>
```

示例：

```text
/t 中文 Hello world
/t "Simplified Chinese" Hello world
```

解析规则：

1. 移除目标语言参数之前的空白。
2. 如果目标语言以引号开头，则使用标准反斜杠转义规则读取到配对引号。
3. 否则，将第一个由空白分隔的 token 作为目标语言。
4. 仅移除目标语言与文本之间的分隔空白。
5. 保留其余全部文本，包括换行、标记、代码和末尾空白。
6. 在调用模型之前拒绝缺少目标语言或源文本为空的请求。

该命令使用翻译代理，并且不在插件配置中设置 `model`。插件在 `chat.message` hook 中识别由 `/t` 产生的内部命令信封，将其替换为正式 user 提示，并把逐次渲染的翻译提示词设置到 `output.message.system`；内部信封不会进入最终会话历史。

### 5.2 `translate` 工具

工具 schema 如下：

```ts
type TranslateInput = {
  to: string
  text: string
  from?: string
  title?: string
  summary?: string
  terms?: Record<string, string> | string[]
  styleGuide?: string
}
```

`to` 和 `text` 必填且不能为空。单次调用提供的 `terms` 和 `styleGuide` 会覆盖插件默认值。`title` 和 `summary` 是仅用于该次调用的上下文值。

工具描述会指示调用代理逐字返回工具结果，不添加说明。工具本身只返回提取出的 assistant 文本。

## 6. 插件配置

示例：

```jsonc
{
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

支持的选项：

```ts
type TranslatorOptions = {
  command?: string
  temperature?: number
  styleGuide?: string
  terms?: Record<string, string> | string[]
}
```

默认值：

- `command`：`t`
- `temperature`：`0.1`
- `styleGuide`：空
- `terms`：空

初始版本不提供模型、提供商、API URL、API 密钥、字符限制、频率限制、分块大小或重试选项。

如果配置的命令名或内部代理名已经存在，初始化会失败并给出可操作的冲突错误。插件绝不会静默替换用户配置。

## 7. 模型解析

插件通过 OpenCode 的消息与参数 hook 跟踪每个会话实际使用的模型。工具调用按以下顺序解析模型：

1. 为工具父会话捕获到的最新模型。
2. 该会话中最近一条含有模型元数据的 user 消息。
3. 如果仍不存在，则以明确的 `No active model found for session` 错误结束。

插件不得回退到全局默认模型或其他模型，否则会违背用户对当前模型的选择。

临时子会话的提示请求会显式包含解析出的 `{ providerID, modelID }` 和翻译代理 ID。

## 8. 临时会话生命周期

`translate` 工具调用流程如下：

1. 校验并规范化工具输入。
2. 解析父会话模型。
3. 创建子会话，并将 `parentID` 设为工具父会话 ID。
4. 使用解析出的模型、翻译代理和渲染后的请求提示子会话。
5. 按响应顺序提取所有 assistant 文本 part。
6. 校验结果。
7. 返回提取出的原始文本。
8. 在 `finally` 块中删除子会话。

如果翻译成功后清理失败，插件通过 OpenCode 的结构化日志记录清理失败，但不替换成功的译文。如果翻译与清理都失败，翻译错误保持为主要错误，清理错误附加为诊断上下文。

取消操作通过 `ToolContext.abort` 传递给子请求。取消后仍会执行清理。

## 9. 格式处理与校验

插件只执行确定性校验：

- 空源文本无效。
- 绝不自动拆分输入。
- 输入不含 `%%` 时，发送内容也不含 `%%`。此时输出里出现的任何 `%%` 都只可能是模型自行添加的分隔符：插件会移除这些 `%%`（先折叠 `\n\n%%\n\n` 段落分隔，再删除剩余的松散 `%%` 及其带来的空白），保证返回的译文不含 `%%`。清理后为空则视为失败。
- 输入含有 `%%` 时，记录准确的分隔符数量；输出必须具有完全相同的数量，不做任何修复。
- 不改写 HTML、Markdown、围栏代码、缩进、换行符或空行。除上一条针对"源文本无 `%%`"时的杂散分隔符清理外，插件不会用正则表达式改写译文、删除看似解释性的句子，也不会尝试修复模型的其他错误输出。
- 按响应顺序连接 assistant 文本 part，不裁剪其中内容。
- 不包含任何非空白文本的结果无效。

当源文本本身含有 `%%` 而输出数量不匹配时，无法判断哪个段落边界正确，因此视为失败；错误中包含预期数量、实际数量以及模型原始输出，避免静默丢失数据。仅"源文本无 `%%`"这一种情况做自动清理，因为此时每个 `%%` 都确定是多余的。

系统提示词中同时存在“输入没有 `%%` 时不要添加 `%%`”以及使用显式 `%%` 的多段示例。插件将 `%%` 视为由调用方明确控制的分隔符，从而消除歧义；它绝不会根据空行推断或插入分隔符。

## 10. 错误处理

- 无效命令语法会报告可接受的 `/t` 格式，且不调用模型。
- 无效工具参数会指出出错字段。
- 模型解析失败时不选择后备模型。
- 提供商和模型错误会保留提供商/模型 ID 及公开错误详情，但移除请求头、凭据、token 和密钥。
- 模型返回空内容时视为失败；清理杂散 `%%` 后为空同样视为失败。
- 源文本含有 `%%` 且输出数量不匹配时视为失败，并在诊断数据中保留原始模型输出；源文本无 `%%` 时改为静默移除多余的 `%%`。
- 初始版本不自动重试。
- 成功、失败和取消后都会清理临时会话。
- 结构化日志绝不包含源文本、译文、API 密钥或认证元数据。

## 11. 项目结构

```text
opencode-translator/
├── src/
│   ├── index.ts              # 插件入口与 hook 注册
│   ├── command.ts            # /t 解析与命令集成
│   ├── config.ts             # 选项校验与配置注入
│   ├── model.ts              # 按会话跟踪和解析模型
│   ├── prompt.ts             # system/user 提示词渲染
│   ├── result.ts             # assistant 文本提取与校验
│   └── tool.ts               # translate 工具与子会话生命周期
├── test/
│   ├── command.test.ts
│   ├── config.test.ts
│   ├── model.test.ts
│   ├── prompt.test.ts
│   ├── result.test.ts
│   └── tool.test.ts
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

仓库根目录就是包根目录；上方树形结构中的标签仅用于说明，不要求再创建一层嵌套目录。

## 12. 测试策略

单元测试覆盖：

- 不带引号和带引号的目标语言解析。
- Unicode 目标语言名称。
- 多行文本及剩余文本的精确保留。
- 缺少目标语言和源文本时的错误。
- 可选提示词上下文的所有组合。
- 默认术语/风格指南与单次调用值之间的优先级。
- 包含零个、一个或多个 `%%` 分隔符的输入。
- HTML、Markdown 和围栏代码原样通过。
- 会话内的模型跟踪与模型切换。
- 从最新消息获取模型的后备路径。
- 找不到模型时的失败路径。
- 临时会话创建、提示、提取与清理。
- 翻译失败、取消与清理失败。
- 已有命令和代理冲突。
- 敏感错误字段脱敏。

所有 SDK 交互在自动化测试中使用确定性的伪客户端。自动化测试不需要提供商账户、API 密钥或网络连接。

验证命令：

```text
bun test
bun run typecheck
bun run build
```

README 还会包含 `/t` 和 `translate` 的手工冒烟测试矩阵，使用两个由用户配置的 OpenCode 模型。测试者在两次调用之间切换当前模型，并通过 OpenCode 诊断信息验证第二次调用使用了新选择的模型。

## 13. 验收标准

满足以下条件时，实施通过验收：

1. 安装 npm 包并将其加入 `plugin` 后，`/t` 和 `translate` 均可使用。
2. `/t 中文 Hello` 只返回当前 OpenCode 模型生成的中文译文。
3. `/t "Simplified Chinese" Hello` 能正确解析带引号的目标语言。
4. 工具接受所有已记录的可选上下文字段。
5. 切换当前 OpenCode 模型后，两个入口使用的模型都会改变，无需重新配置插件。
6. 插件不读取、不存储、也不记录任何 API 密钥或提供商凭据。
7. 源文本无 `%%` 时，译文里模型自行添加的 `%%` 会被移除；源文本含 `%%` 时，插件不增删分隔符，数量不符即报错。
8. 模型失败、输入无效、输出为空，以及源文本含 `%%` 时的数量不匹配，都会明确报错。
9. 每条退出路径都会清理临时会话。
10. 测试、类型检查和包构建全部通过。

## 14. 后续扩展

以下功能明确推迟：

- 可选启用的长文本分块。
- 可选启用的格式违规重试。
- 文件与剪贴板翻译。
- 语言别名与保存的目标语言预设。
- 流式工具输出。
- 翻译记忆持久化。

每项扩展都需要单独进行设计决策，因为它们会改变成本、隐私、输出确定性或用户交互。
