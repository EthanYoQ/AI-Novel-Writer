import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readInstalledSkillFile } from '../writing-skill-package'

let parent = ''

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-skill-file-'))
  fs.mkdirSync(path.join(parent, 'skill'))
  fs.writeFileSync(path.join(parent, 'skill', 'voice.md'), 'inside')
  fs.writeFileSync(path.join(parent, 'outside.md'), 'outside')
})

afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true })
})

describe('readInstalledSkillFile', () => {
  it('reads a plain file inside the skill directory', () => {
    expect(readInstalledSkillFile(path.join(parent, 'skill'), 'voice.md')?.toString('utf8')).toBe('inside')
  })

  it.each(['../outside.md', './voice.md'])('refuses the dot segment in %s', relativePath => {
    expect(() => readInstalledSkillFile(path.join(parent, 'skill'), relativePath)).toThrow('WRITING_SKILL_FILE_UNSAFE')
  })
})
