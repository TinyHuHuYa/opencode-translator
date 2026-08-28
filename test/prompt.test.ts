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
  expect(prompt).toContain("## Webpage Summary Context\n\nPage summary")
  expect(prompt).toContain("OpenCode => OpenCode")
  expect(prompt).toContain("Use polite Japanese.")
})

test("keeps source text exact in the user message body", () => {
  expect(renderUserPrompt({ to: "中文", text: "  <b>Hello</b>\n" })).toBe(
    "Source language: auto-detect\nTarget language: 中文\n\n  <b>Hello</b>\n",
  )
})

test("uses an explicit source language when provided", () => {
  expect(renderUserPrompt({ from: "English", to: "中文", text: "Hello" })).toBe(
    "Source language: English\nTarget language: 中文\n\nHello",
  )
})
