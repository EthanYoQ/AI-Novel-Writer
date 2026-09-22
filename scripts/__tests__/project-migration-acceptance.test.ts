import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'project-migration-acceptance.mjs')
const fixtures: string[] = []

function git(root: string, ...args: string[]) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
}

function fixture(): { root: string; script: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-migration-acceptance-'))
  fixtures.push(root)
  const scripts = path.join(root, 'scripts')
  mkdirSync(scripts)
  const script = path.join(scripts, 'project-migration-acceptance.mjs')
  copyFileSync(source, script)
  writeFileSync(path.join(root, '.gitignore'), '.runtime/\n', 'utf8')
  expect(git(root, 'init').status).toBe(0)
  expect(git(root, 'add', 'scripts/project-migration-acceptance.mjs', '.gitignore').status).toBe(0)
  expect(git(root, '-c', 'user.name=Acceptance Test', '-c', 'user.email=acceptance@example.invalid',
    'commit', '-m', 'fixture').status).toBe(0)
  return { root, script }
}

function dryRun(root: string, script: string) {
  return spawnSync(process.execPath, [script, '--dry-run'], { cwd: root, encoding: 'utf8', windowsHide: true })
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('project migration acceptance source provenance', () => {
  it('accepts a clean source tree while ignoring generated runtime evidence', () => {
    const { root, script } = fixture()
    mkdirSync(path.join(root, '.runtime', 'cache'), { recursive: true })
    writeFileSync(path.join(root, '.runtime', 'cache', 'evidence.json'), '{}\n', 'utf8')

    const result = dryRun(root, script)

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ subjectSha: git(root, 'rev-parse', 'HEAD').stdout.trim() })
  })

  it('rejects tracked source changes before issuing a plan', () => {
    const { root, script } = fixture()
    appendFileSync(script, '\n// dirty\n', 'utf8')

    const result = dryRun(root, script)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('PROJECT_MIGRATION_ACCEPTANCE_SOURCE_DIRTY')
    expect(result.stdout).toBe('')
  })

  it('rejects untracked source files before issuing a plan', () => {
    const { root, script } = fixture()
    mkdirSync(path.join(root, 'electron'))
    writeFileSync(path.join(root, 'electron', 'untracked.ts'), 'export {}\n', 'utf8')

    const result = dryRun(root, script)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('PROJECT_MIGRATION_ACCEPTANCE_SOURCE_DIRTY')
    expect(result.stdout).toBe('')
  })
})
