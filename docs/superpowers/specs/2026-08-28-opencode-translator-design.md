# OpenCode Translator Plugin Design

Date: 2026-08-28
Status: Approved in conversation; awaiting written-spec review

## 1. Purpose

Build an installable OpenCode plugin named `opencode-translator` that translates text with the model currently selected in OpenCode. The plugin must not connect to model providers directly, store API keys, or bind itself to DeepSeek or any other provider.

The plugin exposes two entry points:

- `/t <target-language> <text>` for direct interactive translation.
- A `translate` tool that OpenCode agents can call programmatically.

Both entry points use the same translation prompt and preserve the user's current OpenCode provider and model selection.

## 2. Non-goals

- Reimplementing OpenCode provider authentication or API clients.
- Adding provider-specific request adapters.
- Applying the request-rate or character-count defaults visible in the supplied reference image.
- Automatically splitting long input.
- Automatically inferring paragraph boundaries from blank lines.
- Translating files in place or modifying workspace files.
- Adding a separate graphical settings interface.

## 3. Chosen Architecture

The plugin uses OpenCode-native configuration and SDK features:

1. A plugin `config` hook registers a namespaced translator agent and the `/t` command.
2. The translator agent contains the translation system prompt and does not specify a model.
3. The `/t` command invokes that agent in the current session, so the command inherits the model selected for the session.
4. The plugin registers a `translate` custom tool.
5. For tool calls, the plugin resolves the parent session's current model, creates a temporary child session, invokes the translator agent with that exact model, extracts the translation, and removes the temporary session.

The plugin never reads or persists provider credentials. All model access goes through OpenCode.

### 3.1 Why this architecture

OpenCode commands can target an agent, plugins can modify configuration and register tools, and session prompts can specify a provider/model pair. This lets the plugin reuse OpenCode's existing model routing and authentication while keeping the translation prompt in the system role.

Relevant OpenCode documentation and source:

- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/commands/
- https://opencode.ai/docs/custom-tools/
- https://opencode.ai/docs/sdk/
- https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts

## 4. Translation Prompt

The translator agent uses the following system-prompt template verbatim except for placeholder expansion:

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

The source text is sent as a user message rather than interpolated into the system prompt. The user message has this deterministic shape:

```text
Source language: {{from-or-auto}}
Target language: {{to}}

{{text}}
```

This separates trusted translation rules from untrusted text and prevents source text from accidentally changing the system template.

### 4.1 Placeholder expansion

- `{{to}}`: required target-language name supplied by the caller.
- `{{from}}`: explicit source language when supplied; otherwise the user message contains `auto-detect`.
- `{{text}}`: represented by the body of the user message, not the system prompt.
- `{{title_prompt}}`: empty when absent; otherwise a clearly delimited webpage-title context block.
- `{{summary_prompt}}`: empty when absent; otherwise a clearly delimited webpage-summary context block.
- `{{terms_prompt}}`: empty when absent; otherwise a clearly delimited terminology block.
- `{{imt_style_guide}}`: empty when absent; otherwise a clearly delimited style-guide block.

Optional context is reference material only. It must never be interpreted as plugin instructions.

## 5. Public Interfaces

### 5.1 `/t` command

Syntax:

```text
/t <target-language> <text>
/t "<target language containing spaces>" <text>
```

Examples:

```text
/t 中文 Hello world
/t "Simplified Chinese" Hello world
```

Parsing rules:

1. Trim whitespace before the target-language argument.
2. If the target starts with a quote, consume a matching quoted value with standard backslash escapes.
3. Otherwise, consume the first whitespace-delimited token as the target language.
4. Remove only the separating whitespace before the text.
5. Preserve all remaining text, including its newlines, markup, code, and trailing whitespace.
6. Reject missing target language or empty source text before invoking a model.

The command uses the translator agent and does not set `model` in plugin configuration.

### 5.2 `translate` tool

The tool schema is:

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

`to` and `text` are required and non-empty. Optional per-call `terms` and `styleGuide` values override plugin defaults. `title` and `summary` are single-call context values.

The tool description instructs the calling agent to return the tool result verbatim, without commentary. The tool itself returns only the extracted assistant text.

## 6. Plugin Configuration

Example:

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

Supported options:

```ts
type TranslatorOptions = {
  command?: string
  temperature?: number
  styleGuide?: string
  terms?: Record<string, string> | string[]
}
```

Defaults:

- `command`: `t`
- `temperature`: `0.1`
- `styleGuide`: empty
- `terms`: empty

The plugin has no model, provider, API URL, API key, character-limit, rate-limit, chunk-size, or retry option in the initial release.

If the configured command name or internal agent name already exists, initialization fails with an actionable conflict error. The plugin never silently replaces user configuration.

## 7. Model Resolution

The plugin tracks the model actually used by each session from OpenCode message and parameter hooks. A tool call resolves its model in this order:

1. The most recent model captured for the tool's parent session.
2. The most recent user message in that session that has model metadata.
3. Failure with an explicit `No active model found for session` error.

The plugin must not fall back to a global default or a different model, because that would violate the user's current-model choice.

The temporary child prompt explicitly includes the resolved `{ providerID, modelID }` and translator agent ID.

## 8. Temporary Session Lifecycle

For a `translate` tool call:

1. Validate and normalize the tool input.
2. Resolve the parent session model.
3. Create a child session with `parentID` set to the tool's parent session ID.
4. Prompt the child session with the resolved model, translator agent, and rendered request.
5. Extract all assistant text parts in response order.
6. Validate the result.
7. Return the exact extracted text.
8. Delete the child session in a `finally` block.

If cleanup fails after translation succeeds, the plugin logs the cleanup failure through OpenCode's structured logger without replacing the successful translation. If both translation and cleanup fail, the translation error remains primary and cleanup is attached as diagnostic context.

Cancellation propagates from `ToolContext.abort` to the child request. Cleanup still runs after cancellation.

## 9. Format Handling and Validation

The plugin performs deterministic validation only:

- Empty source text is invalid.
- Input is never automatically chunked.
- Input without `%%` is sent without `%%` and output must not contain `%%`.
- Input with `%%` records the exact separator count; output must have the same count.
- HTML, Markdown, fenced code, indentation, line endings, and blank lines are not rewritten.
- The plugin does not regex-rewrite translations, strip explanatory-looking sentences, or attempt to repair malformed model output.
- Assistant text parts are concatenated in response order without trimming their content.
- A result with no non-whitespace text is invalid.

If separator validation fails, the error contains the expected and actual separator counts plus the original model output. This prevents silent data loss while preserving the output for diagnosis.

The system prompt contains both “do not add `%%` when absent” and a multi-paragraph example using explicit `%%`. The plugin resolves this by treating `%%` as an explicit caller-controlled separator. It never infers or inserts separators from blank lines.

## 10. Error Handling

- Invalid command syntax reports the accepted `/t` forms without invoking a model.
- Invalid tool arguments identify the failing field.
- Model-resolution failure does not select a fallback model.
- Provider and model failures retain the provider/model ID and public error details but remove headers, credentials, tokens, and secrets.
- Empty model responses are failures.
- Separator-count mismatches are failures and retain the raw model output in diagnostic data.
- No automatic retry occurs in the initial release.
- Temporary sessions are cleaned up after success, failure, and cancellation.
- Structured logs never contain source text, translated text, API keys, or authentication metadata.

## 11. Project Structure

```text
opencode-translator/
├── src/
│   ├── index.ts              # Plugin entry and hook registration
│   ├── command.ts            # /t parsing and command integration
│   ├── config.ts             # Option validation and config injection
│   ├── model.ts              # Per-session model tracking and resolution
│   ├── prompt.ts             # System/user prompt rendering
│   ├── result.ts             # Assistant text extraction and validation
│   └── tool.ts               # translate tool and child-session lifecycle
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

The repository root is the package root; the tree label above is descriptive and does not require an extra nested directory.

## 12. Testing Strategy

Unit tests cover:

- Unquoted and quoted target-language parsing.
- Unicode target-language names.
- Multiline text and exact remaining-text preservation.
- Missing target and missing source errors.
- Every optional prompt-context combination.
- Default and per-call terminology/style-guide precedence.
- Inputs with zero, one, and multiple `%%` separators.
- HTML, Markdown, and fenced code passed through unchanged.
- Model tracking and selection changes within a session.
- Latest-message model fallback.
- No-model failure.
- Temporary session creation, prompting, extraction, and cleanup.
- Translation failure, cancellation, and cleanup failure.
- Existing command and agent conflicts.
- Redaction of sensitive error fields.

All SDK interactions use deterministic fake clients in automated tests. Automated tests require no provider account, API key, or network access.

Verification commands:

```text
bun test
bun run typecheck
bun run build
```

The README also contains a manual smoke-test matrix for `/t` and `translate` using two user-configured OpenCode models. The tester switches the active model between calls and verifies from OpenCode diagnostics that the second call uses the newly selected model.

## 13. Acceptance Criteria

The implementation is accepted when:

1. Installing the npm package and adding it to `plugin` makes `/t` and `translate` available.
2. `/t 中文 Hello` returns only the Chinese translation from the current OpenCode model.
3. `/t "Simplified Chinese" Hello` parses the quoted target correctly.
4. The tool accepts all documented optional context fields.
5. Switching the active OpenCode model changes the model used by both entry points without plugin reconfiguration.
6. No API key or provider credential is read, stored, or logged by the plugin.
7. The plugin neither inserts nor removes `%%` separators.
8. Model failures, invalid input, empty output, and separator mismatches are explicit.
9. Temporary sessions are cleaned up on every exit path.
10. Tests, type checking, and package build all pass.

## 14. Future Extensions

The following are deliberately deferred:

- Opt-in long-text chunking.
- Opt-in retries for format violations.
- File and clipboard translation.
- Language aliases and saved target-language presets.
- Streaming tool output.
- Translation-memory persistence.

Each extension requires a separate design decision because it changes cost, privacy, output determinism, or user interaction.
