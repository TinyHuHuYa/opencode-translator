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

const SYSTEM_PROMPT_TEMPLATE = `You are a professional {{to}} native translator who needs to fluently translate text into {{to}}.

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

{{imt_style_guide}}`

function optionalBlock(heading: string, value: string): string {
  return value ? `\n\n## ${heading}\n\n${value}` : ""
}

function renderTerms(terms: Terms | undefined): string {
  if (!terms || (Array.isArray(terms) ? terms.length === 0 : Object.keys(terms).length === 0)) return ""
  const lines = Array.isArray(terms)
    ? terms.map((term) => `- ${term}`)
    : Object.entries(terms).map(([source, target]) => `${source} => ${target}`)
  return optionalBlock("Preferred Terms", lines.join("\n"))
}

export function renderSystemPrompt(context: Omit<PromptContext, "text" | "from">): string {
  const replacements: Record<string, string> = {
    "{{to}}": context.to,
    "{{title_prompt}}": optionalBlock("Webpage Title Context", context.title ?? ""),
    "{{summary_prompt}}": optionalBlock("Webpage Summary Context", context.summary ?? ""),
    "{{terms_prompt}}": renderTerms(context.terms),
    "{{imt_style_guide}}": optionalBlock("Style Guide", context.styleGuide ?? ""),
  }
  return Object.entries(replacements).reduce((prompt, [placeholder, value]) => prompt.split(placeholder).join(value), SYSTEM_PROMPT_TEMPLATE)
}

export function renderUserPrompt(context: Pick<PromptContext, "to" | "text" | "from"> & { text: string }): string {
  return `Source language: ${context.from ?? "auto-detect"}\nTarget language: ${context.to}\n\n${context.text}`
}
