import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function isIgnored(target: string): boolean {
  const result = spawnSync(
    'git',
    ['check-ignore', '--no-index', '-q', '--', target],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    },
  )

  if (result.error) throw result.error
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed for ${target}: ${String(result.stderr).trim()}`)
  }
  return result.status === 0
}

describe('worktree hygiene ignore contract', () => {
  it('ignores only confirmed regenerable local review and package-manager state', () => {
    const regenerableLocalState = [
      '.review-temp/notes.json',
      '.pnpm-store/v3/files/state.json',
      '.workbuddy/session.json',
      '.release-gate16-exit-code.txt',
      '.release-gate-any-run.txt',
    ]

    for (const target of regenerableLocalState) {
      expect(isIgnored(target), target).toBe(true)
    }
  })

  it('keeps the CodeGraph index local without requiring it to be checked in', () => {
    const rootGitignore = readFileSync('.gitignore', 'utf8')

    expect(rootGitignore).toMatch(/^\.codegraph\/$/m)
    expect(isIgnored('.codegraph/codegraph.db')).toBe(true)
  })

  it('does not hide source, evidence, or cloud qualification definitions', () => {
    const protectedPaths = [
      'src/components/panels/EditorArea.tsx',
      'docs/adr/0001-project-root-and-session-lease.md',
      'README.md',
      'docs/assets/readme/hero-zh-v2.png',
      '.github/workflows/windows-cloud-build-test.yml',
      'scripts/generate-cloud-build-manifest.mjs',
    ]

    for (const target of protectedPaths) {
      expect(isIgnored(target), target).toBe(false)
    }
  })
})
