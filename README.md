# OpenCode Translator

一个 OpenCode 插件，用当前会话中选定的模型翻译文本。它提供 `/t` 命令和 `translate` 工具；两者都通过 OpenCode 的模型路由工作。

本插件不读取、保存或记录提供商凭据，也不需要插件专用 API Key。请先按 OpenCode 自身的方式配置并登录你要使用的模型提供商。

## 安装

### 方式一：下载预构建文件（推荐）

1. 从 [Releases](https://github.com/TinyHuHuYa/opencode-translator/releases) 下载 `opencode-translator.js`。
2. 放进 OpenCode 的插件自动发现目录，**文件名保持不变**：
   - 全局（所有项目）：`~/.config/opencode/plugin/opencode-translator.js`
   - 单项目：`<项目>/.opencode/plugin/opencode-translator.js`
3. 重启 OpenCode。

更新时下载新版覆盖同一文件、重启即可。`plugin` 与 `plugins` 两个目录名都可用。不要同时放全局和单项目两份，否则第二份的 `config` hook 会因命令名冲突报错（且其它 hook 仍会运行，导致行为异常）。

此方式**无法传入配置选项**，命令名、温度、术语表、风格指南均取 `src/config.ts` 顶部 `DEFAULT_*` 常量的值。需要自定义见「方式二」。

### 方式二：从源码构建

```sh
git clone https://github.com/TinyHuHuYa/opencode-translator.git
cd opencode-translator
npm install            # prepare 脚本会自动构建 dist/
# 需要自定义时，编辑 src/config.ts 顶部的 DEFAULT_* 常量
npm run deploy:local   # 构建并复制到 ~/.config/opencode/plugin/
```

`deploy:local` 把 `dist/opencode-translator.js` 复制到 `~/.config/opencode/plugin/opencode-translator.js`（可用 `OPENCODE_PLUGIN_DIR` 或 `XDG_CONFIG_HOME` 覆盖目标）。**每次改动源码后都要重新 `npm run deploy:local` 并重启 OpenCode。**

### 方式三：npm 包（发布后可用）

包发布到 npm 后，可在 OpenCode 配置里直接引用，并通过数组元组形式传选项：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-translator", { "command": "t", "temperature": 0, "styleGuide": "", "terms": {} }]
  ]
}
```

`file://` 路径写进 `plugin` 数组不会加载插件；只有 npm 包名与自动发现目录两种方式可用。

安装后重启 OpenCode 或重新打开会话，插件会注册命令和工具。若配置的命令名已存在，或 `opencode-translator` 代理名已存在，OpenCode 会显示冲突错误；插件不会覆盖原有配置。

## 发布新版本（维护者）

```sh
npm version patch          # 更新版本号并打 tag
git push --follow-tags
```

推送 `v*` tag 会触发 `.github/workflows/release.yml`：CI 跑 `npm run check`，然后创建 GitHub Release 并附上 `dist/opencode-translator.js`。

## 使用 `/t`

语法：

```text
/t <目标语言> <文本>
/t "<含空格的目标语言>" <文本>
```

示例：

```text
/t 中文 Hello world
/t "Simplified Chinese" Hello world
```

目标语言前后的参数分隔空白会被处理；翻译文本的其余内容（包括换行、Markdown、HTML、代码和末尾空白）会原样传给模型。缺少目标语言或文本时，命令会报出可接受的语法，且不会调用模型。

`/t` 在当前会话中运行，不固定模型。因此它使用你此刻在 OpenCode 会话里选择的提供商和模型。

## 使用 `translate` 工具

让 OpenCode 代理调用 `translate`。工具只返回译文；调用它的代理应逐字使用工具结果，不添加说明。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `to` | 是 | 非空的目标语言名称。 |
| `text` | 是 | 非空的待翻译文本。 |
| `from` | 否 | 源语言。省略（或填 `auto`/`auto-detect`）时不写入提示，由模型自动识别；填具体语言时会作为 `Source language:` 行加在原文前。 |
| `title` | 否 | 仅本次调用使用的网页标题上下文。 |
| `summary` | 否 | 仅本次调用使用的网页摘要上下文。 |
| `terms` | 否 | 术语表：字符串数组，或 `{ "源术语": "目标术语" }` 对象。本次值覆盖插件默认值。 |
| `styleGuide` | 否 | 本次调用使用的风格指南；会覆盖插件默认值。 |

工具会解析父会话当前使用的模型，创建临时子会话，并用同一个模型完成翻译。临时会话会在成功、失败或取消后清理。如果无法从当前会话或其历史中找到模型，工具会以 `No active model found for session` 失败，而不会悄悄改用全局默认模型。

## 配置

插件配置支持以下选项：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `command` | `"t"` | `/t` 的命令名；必须以字母开头，后续仅可含字母、数字、`_` 或 `-`。 |
| `temperature` | `0` | 翻译代理的温度，范围为 0 到 2。 |
| `styleGuide` | 见 `DEFAULT_STYLE_GUIDE` | 面向简体中文技术读者的默认风格指南。工具调用可覆盖它。 |
| `terms` | 见 `DEFAULT_TERMS` | 默认术语表（技术常见词）。字符串数组或字符串到字符串的对象。工具调用可覆盖它。 |

本地构建产物方式安装时无法传选项，请直接编辑 `src/config.ts` 顶部的 `DEFAULT_COMMAND`、`DEFAULT_TEMPERATURE`、`DEFAULT_STYLE_GUIDE`、`DEFAULT_TERMS` 后重新 `npm run build`。

初始版本没有模型、提供商、API URL、API Key、字符上限、频率限制、分块大小或重试配置。模型选择仍由 OpenCode 会话控制。

## 段落与 `%%`

`%%` 是调用方显式控制的段落分隔符：插件不会根据空行推断或插入它。

- 输入不含 `%%` 时，译文里模型自行添加的 `%%` 会被移除（先折叠 `\n\n%%\n\n`，再删掉剩余松散的 `%%` 及其空白）。清理后为空视为失败。
- 输入含有 `%%` 时，译文必须包含相同数量的 `%%`，插件不做修复。
- 输入含有 `%%` 且数量不匹配会报错，并保留模型原始输出用于诊断。

插件不自动分块，也不自动重试。除上面对"输入无 `%%`"时的杂散分隔符清理外，它不会改写 HTML、Markdown、围栏代码、缩进、换行或空行；模型输出为空同样视为失败。

## 错误与隐私

无效命令或工具参数会指出出错的字段。模型或提供商错误会保留非敏感的提供商/模型标识，并以安全的通用错误消息替代外部错误详情；请求头、凭据、token、密钥及响应正文不会暴露。格式类内部错误可提供安全的分隔符预期/实际计数信息。结构化日志不会包含源文本、译文或认证元数据。

如果临时会话删除失败，成功的译文不会被删除错误替换；清理失败会以不含敏感内容的诊断日志记录。翻译失败时仍以翻译错误为主。

## 手工冒烟测试：模型切换

以下矩阵使用两个已经在 OpenCode 中配置且可用的模型。不要把 API Key 写进插件配置或测试记录。

| 步骤 | 当前会话模型 | 操作 | 预期 |
| --- | --- | --- | --- |
| 1 | 模型 A | 在同一会话运行 `/t 中文 Hello world` | 得到中文译文；通过 OpenCode 的会话/诊断信息确认请求使用模型 A。 |
| 2 | 切换为模型 B | 不重启插件，在同一会话再运行 `/t 中文 Hello world` | 得到中文译文；会话/诊断信息显示此请求使用模型 B。 |
| 3 | 模型 B | 要求代理调用 `translate`，例如传入 `to: "中文"`、`text: "Hello world"` | 工具仅返回译文；OpenCode 的会话/诊断信息显示调用使用模型 B，且临时子会话随后被清理。 |

### TUI 加载检查

在 OpenCode 1.18.23 中，启动后打开命令面板，确认可见 `/t`；再让代理列出或调用可用工具，确认存在 `translate`。若没有出现，查看 OpenCode 的插件加载诊断，确认配置路径、包安装位置和冲突错误。不要通过复制 API Key 来排查加载问题。

## 开发验证

```sh
npm run check
npm pack --dry-run
```

构建入口只提供默认导出的 OpenCode 插件模块（`{ id, server }`）。

## 许可证

[MIT](LICENSE)
