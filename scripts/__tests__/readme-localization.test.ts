import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('README language variants', () => {
  it('keeps Chinese README as the repository default with a localized product screenshot', () => {
    const readme = readFileSync('README.md', 'utf8')
    expect(readme).toContain('v130-hero-zh.webp')
    expect(readme).toContain('v130-zh-chapter.webp')
    expect(readme).not.toMatch(/v130-(?:hero-en|en-)/)
    expect(readme).toMatch(/\[English\]\(README_en\.md\)\s*\|\s*\*\*中文\*\*/)
  })

  it('uses English interface screenshots for the English README', () => {
    const readme = readFileSync('README_en.md', 'utf8')
    expect(readme).toContain('v130-hero-en.webp')
    expect(readme).toContain('v130-en-chapter.webp')
    expect(readme).not.toMatch(/v130-(?:hero-zh|zh-)/)
    expect(readme).toMatch(/\*\*English\*\*\s*\|\s*\[中文\]\(README\.md\)/)
  })
})
