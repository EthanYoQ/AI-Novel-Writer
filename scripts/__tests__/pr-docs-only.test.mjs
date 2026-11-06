import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isDocsOnly } from '../pr-docs-only.mjs'

const script = path.resolve(import.meta.dirname, '..', 'pr-docs-only.mjs')

describe('isDocsOnly', () => {
  it.each([
    [['.claude/skills/verify/SKILL.md', '.claude/skills/verify/references/driver.md'], true],
    [['LICENSE'], true],
    [['docs/adr/0001.md', 'docs/brand/logo.svg'], true],
    [['docs/README.md'], true],
    [['README.md'], false],
    [['README_en.md'], false],
    [['docs/x.json'], false],
    [['docs/plans/run.mjs'], false],
    [['.github/workflows/x.yml'], false],
    [['.release/notes.md'], false],
    [['CONTRIBUTING.md', 'src/main.ts'], false],
    [[], false],
  ])('%j -> %s', (files, expected) => {
    expect(isDocsOnly(files)).toBe(expected)
  })
})

describe('pr-docs-only CLI', () => {
  it('reads changed paths from stdin and prints the verdict', () => {
    const run = (input) => execFileSync(process.execPath, [script], { input, encoding: 'utf8' }).trim()
    expect(run('LICENSE\n.claude/a.md\n')).toBe('true')
    expect(run('LICENSE\nsrc/a.ts\n')).toBe('false')
    expect(run('')).toBe('false')
  })
})
