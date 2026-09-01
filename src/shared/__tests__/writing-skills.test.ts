import { describe, expect, it } from 'vitest'
import {
  inspectWritingSkillMarkdown,
  parseGitHubWritingSkillUrl,
  type WritingSkillStage,
} from '../writing-skills'

describe('writing skill compatibility', () => {
  it('accepts a self-contained prompt-only SKILL.md', () => {
    const result = inspectWritingSkillMarkdown(`---
name: scene-craft
description: Strengthen scene causality and concrete action.
version: 1.2.0
language: en-US
stage: drafting
---

Keep the viewpoint character active. Prefer decisions and consequences.`)

    expect(result).toMatchObject({
      compatible: true,
      metadata: {
        name: 'scene-craft',
        version: '1.2.0',
        language: 'en-US',
      },
      suggestedStage: 'drafting' satisfies WritingSkillStage,
    })
    expect(result.content).toContain('Prefer decisions and consequences.')
  })

  it.each([
    ['relative reference', 'Read [the reference](./references/voice.md) first.'],
    ['script', 'Run scripts/rewrite.py before continuing.'],
    ['hook', 'Install the hook from hooks/preflight.js.'],
    ['subagent', 'Delegate the scene to a subagent.'],
    ['tool requirement', 'Use the read_file tool before writing.'],
  ])('rejects %s dependencies', (_label, body) => {
    const result = inspectWritingSkillMarkdown(`---
name: unsafe-skill
description: Requires capabilities outside prompt injection.
---

${body}`)

    expect(result.compatible).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
  })

  it('rejects tool declarations in frontmatter', () => {
    const result = inspectWritingSkillMarkdown(`---
name: tool-skill
description: Uses tools
allowed-tools: [read_file]
---
Write a chapter.`)

    expect(result.compatible).toBe(false)
    expect(result.reasons).toContain('tool-dependency')
  })

  it.each([
    ['https://github.com/acme/story-skill', { owner: 'acme', repo: 'story-skill', path: 'SKILL.md' }],
    ['https://github.com/acme/story-skill/tree/main/skills/prose', { owner: 'acme', repo: 'story-skill', ref: 'main', path: 'skills/prose/SKILL.md' }],
    ['https://github.com/acme/story-skill/blob/release/SKILL.md', { owner: 'acme', repo: 'story-skill', ref: 'release', path: 'SKILL.md' }],
    ['https://raw.githubusercontent.com/acme/story-skill/main/SKILL.md', { owner: 'acme', repo: 'story-skill', ref: 'main', path: 'SKILL.md' }],
  ])('normalizes GitHub source %s', (url, expected) => {
    expect(parseGitHubWritingSkillUrl(url)).toMatchObject(expected)
  })

  it.each([
    'https://example.com/acme/story-skill/SKILL.md',
    'http://github.com/acme/story-skill',
    'https://github.com/acme',
    'https://github.com/acme/story-skill/issues/1',
  ])('rejects unsupported source %s', (url) => {
    expect(() => parseGitHubWritingSkillUrl(url)).toThrow()
  })
})
