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

  it('reads folded and literal block scalars in Agent Skills frontmatter', () => {
    const result = inspectWritingSkillMarkdown(`---
name: block-skill
description: >-
  Keep the voice steady.
  Use for drafting.
version: |
  2.0.0
---
Write.`)

    expect(result.metadata).toMatchObject({ description: 'Keep the voice steady. Use for drafting.', version: '2.0.0' })
  })

  it('merges cited reference files, including ones they cite, into the prompt', () => {
    const files: Record<string, string> = {
      'references/voice.md': 'Close third person. See [tone](tone.md).',
      'references/tone.md': 'Dry humour.',
      'FORMS.md': 'Use short paragraphs.',
    }
    const result = inspectWritingSkillMarkdown(`---
name: voice
description: Voice rules
---
Follow references/voice.md and [forms](FORMS.md).`, { readFile: relativePath => files[relativePath] })

    expect(result).toMatchObject({
      compatible: true,
      bundledFiles: ['references/voice.md', 'FORMS.md', 'references/tone.md'],
    })
    expect(result.content).toContain('Close third person.')
    expect(result.content).toContain('Dry humour.')
    expect(result.utf8Bytes).toBe(new TextEncoder().encode(result.content).byteLength)
  })

  it.each([
    ['a missing file', 'Read [forms](FORMS.md).'],
    ['a parent-directory escape', 'Read [secret](../secret.md).'],
    ['a non-text file', 'Use assets/cover.png as the mood board.'],
    ['a bare skill directory variable', 'Look inside ${SKILL_DIR} first.'],
    ['a non-ASCII file name', '先读 references/风格.md。'],
  ])('keeps a skill that cites %s incompatible', (_label, body) => {
    const result = inspectWritingSkillMarkdown(`---\nname: cites\n---\n${body}`, {
      readFile: relativePath => relativePath === 'FORMS.md' ? undefined : 'any text',
    })

    expect(result.reasons).toContain('relative-reference')
    expect(result.bundledFiles).toEqual([])
  })

  it('checks scripts cited from a merged reference file', () => {
    const result = inspectWritingSkillMarkdown('---\nname: nested\n---\nRead references/steps.md.', {
      readFile: relativePath => relativePath === 'references/steps.md' ? 'Run scripts/build.py first.' : undefined,
    })

    expect(result.reasons).toContain('script-dependency')
  })

  it.each([
    ['https://github.com/acme/story-skill',{ owner: 'acme', repo: 'story-skill', path: 'SKILL.md' }],
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
