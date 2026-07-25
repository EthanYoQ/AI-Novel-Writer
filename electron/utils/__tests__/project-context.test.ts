import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { assertExpectedProjectPath, assertProjectFilePath } from '../project-context'

const temporaryDirectories: string[] = []

function createFixture() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-project-context-'))
  temporaryDirectories.push(temporaryRoot)
  const projectRoot = path.join(temporaryRoot, 'project')
  const outsideRoot = path.join(temporaryRoot, 'outside')
  fs.mkdirSync(projectRoot)
  fs.mkdirSync(outsideRoot)
  return { projectRoot, outsideRoot }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('project-scoped database access', () => {
  it('allows the requested project and rejects a different or closed project', () => {
    expect(() => assertExpectedProjectPath(
      'C:\\novels\\Project-A',
      'c:\\NOVELS\\project-a',
    )).not.toThrow()

    expect(() => assertExpectedProjectPath(
      'C:\\novels\\Project-B',
      'C:\\novels\\Project-A',
    )).toThrow(/跨项目读写/)
    expect(() => assertExpectedProjectPath(
      null,
      'C:\\novels\\Project-A',
    )).toThrow(/跨项目读写/)
  })

  it('keeps existing unscoped repository calls backward compatible', () => {
    expect(() => assertExpectedProjectPath('C:\\novels\\Project-B')).not.toThrow()
  })

  it('rejects traversal, sibling, and unrelated absolute file paths', () => {
    const { projectRoot, outsideRoot } = createFixture()
    const insideFile = path.join(projectRoot, 'chapter.md')
    fs.writeFileSync(insideFile, 'inside')

    expect(() => assertProjectFilePath(
      insideFile,
      projectRoot,
    )).not.toThrow()
    expect(() => assertProjectFilePath(
      path.join(projectRoot, '..', 'outside', 'secret.md'),
      projectRoot,
      'writable',
    )).toThrow(/超出当前项目/)
    expect(() => assertProjectFilePath(
      path.join(outsideRoot, 'secret.md'),
      projectRoot,
      'writable',
    )).toThrow(/超出当前项目/)
  })

  it('rejects existing and not-yet-created targets behind a junction', () => {
    const { projectRoot, outsideRoot } = createFixture()
    const junctionPath = path.join(projectRoot, 'linked-outside')
    fs.writeFileSync(path.join(outsideRoot, 'secret.md'), 'outside')
    fs.symlinkSync(outsideRoot, junctionPath, 'junction')

    expect(() => assertProjectFilePath(
      path.join(junctionPath, 'secret.md'),
      projectRoot,
    )).toThrow(/超出当前项目/)
    expect(() => assertProjectFilePath(
      path.join(junctionPath, 'new.md'),
      projectRoot,
      'writable',
    )).toThrow(/超出当前项目/)
  })
})
