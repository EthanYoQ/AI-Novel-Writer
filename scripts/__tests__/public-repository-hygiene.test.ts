import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const prohibitedPaths = [
  'AGENTS.md',
  'CONTEXT.md',
  'design-qa.md',
  'rule.md',
  'rule.lite.md',
  'docs/superpowers',
  'public/screenshot',
  'public/logos',
  'tsconfig.node.tsbuildinfo',
]

describe('public repository hygiene', () => {
  it('does not contain internal process material or generated output', () => {
    for (const target of prohibitedPaths) {
      expect(existsSync(target), target).toBe(false)
    }
  })

  it('ignores prohibited local material before it can be staged', () => {
    const rootGitignore = readFileSync('.gitignore', 'utf8')

    for (const entry of [
      '/AGENTS.md',
      '/CONTEXT.md',
      '/docs/superpowers/',
      '/output/',
      '/public/screenshot/',
      '/public/logos/',
      '*.tsbuildinfo',
    ]) {
      expect(rootGitignore).toContain(entry)
    }
  })
})
