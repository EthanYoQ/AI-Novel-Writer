import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import { CharacterRosterRepository, refreshCharacterIdentityProjection } from '../character-roster-repository'
import { commitAuthorCharacterRoster } from '../../services/character-roster-author'
import type { CharacterRosterCommitRequest } from '../../../src/shared/character-roster'

/**
 * 属性测试：S09C P1 的公开事实哈希必须在「同名角色」和「关系重指向」这类
 * 组合空间里真的可区分。这些正是手工 fixture 最容易漏掉的角落。
 *
 * 每个 run 都要一个干净的物理库，但每次重跑迁移太慢，所以先建一份模板库，
 * 之后每个用例只复制文件 —— 仍然是真实 SQLite，不是内存替身。
 */
const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const base = path.resolve('.runtime/.cache/novel-quality-modernization/s09c-author-tests')
const cleanups: (() => void)[] = []
const scope = { projectId: '属性测试项目', epoch: '原会话' }
const OBSERVER = '旁观者'
let templateDb = ''

beforeAll(() => {
  fs.mkdirSync(base, { recursive: true })
  const templateRoot = fs.mkdtempSync(path.join(base, 'template-'))
  prepareCanonicalStorageFixture(templateRoot)
  templateDb = path.join(templateRoot, '.ai-novel', 'project.db')
  const db = new Database(templateDb)
  db.pragma('foreign_keys=ON')
  // 先让角色名单 schema 落好，复制出来的库就能直接用。
  CharacterRosterRepository.read(db)
  db.close()
  cleanups.push(() => fs.rmSync(templateRoot, { recursive: true, force: true }))
})
afterEach(() => cleanups.splice(1).forEach(dispose => dispose()))
afterAll(() => cleanups.splice(0).forEach(dispose => dispose()))

/** 非空、无空白、且不等于观察者名的显示名。 */
const displayName = fc.string({ minLength: 1, maxLength: 6 })
  .map(value => value.replace(/\s/gu, ''))
  .filter(value => value.length > 0 && value !== OBSERVER)

function fixture(name: string, secondName = name) {
  const root = fs.mkdtempSync(path.join(base, 'run-'))
  const file = path.join(root, 'project.db')
  fs.copyFileSync(templateDb, file)
  let db = new Database(file)
  db.pragma('foreign_keys=ON')
  db.exec("DELETE FROM project_core WHERE id='main'")
  db.exec("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','属性哈希','zh-CN')")
  db.prepare('INSERT INTO characters(character_id,name,role) VALUES(?,?,?)').run('目标甲', name, 'supporting')
  db.prepare('INSERT INTO characters(character_id,name,role) VALUES(?,?,?)').run('目标乙', secondName, 'supporting')
  db.prepare('INSERT INTO characters(character_id,name,role) VALUES(?,?,?)').run('观察者', OBSERVER, 'supporting')
  db.transaction(() => refreshCharacterIdentityProjection(db))()
  const dispose = () => { if (db.open) db.close(); fs.rmSync(root, { recursive: true, force: true }) }
  cleanups.push(dispose)
  const request = (operationId: string): CharacterRosterCommitRequest => {
    const read = CharacterRosterRepository.read(db)
    return { operationId, schemaVersion: 1, intent: 'manual_edit', expectedRevision: read.revision,
      expectedIdentityRevision: read.identityRevision, entries: structuredClone(read.entries) }
  }
  const retarget = (operationId: string, targetCharacterId: string) => {
    const draft = request(operationId)
    draft.entries.find(entry => entry.characterId === '观察者')!.relationships = [
      { target: name, targetCharacterId, relation: '监视' },
    ]
    return commitAuthorCharacterRoster(db, draft, scope, () => {})
  }
  return { get db() { return db }, request, retarget,
    reopen() { db.close(); db = new Database(file); db.pragma('foreign_keys=ON') } }
}

describe('S09C factHash properties', () => {
  it('distinguishes two same-name characters as relationship targets', () => {
    fc.assert(fc.property(displayName, name => {
      const f = fixture(name)
      const toA = f.retarget('指向甲', '目标甲')
      const toB = f.retarget('指向乙', '目标乙')
      // 两次提交的显示名完全一致，只有稳定目标 ID 不同。
      expect(toA.snapshot.entries.find(entry => entry.characterId === '观察者')!.relationships[0])
        .toMatchObject({ target: name, targetCharacterId: '目标甲' })
      expect(toB.snapshot.entries.find(entry => entry.characterId === '观察者')!.relationships[0])
        .toMatchObject({ target: name, targetCharacterId: '目标乙' })
      expect(toB.snapshot.factHash).not.toBe(toA.snapshot.factHash)
    }), { numRuns: 25 })
  })

  it('is stable across reopen and reports the persisted name-only hash', () => {
    fc.assert(fc.property(displayName, name => {
      const f = fixture(name)
      const saved = f.retarget('持久', '目标乙')
      const persisted = f.db.prepare("SELECT fact_hash FROM character_roster_meta WHERE id='main'").pluck().get() as string
      f.reopen()
      const reread = CharacterRosterRepository.read(f.db)
      expect(reread.factHash).toBe(saved.snapshot.factHash)
      expect(reread.nameOnlyFactHash).toBe(persisted)
      expect(reread.nameOnlyFactHash).toMatch(/^[a-f0-9]{64}$/u)
      // 身份项目里两个契约必须真的不同，否则 P1 的区分没有意义。
      expect(reread.factHash).not.toBe(reread.nameOnlyFactHash)
    }), { numRuns: 25 })
  })

  it('changes the hash when a displayed fact changes', () => {
    fc.assert(fc.property(displayName, displayName, (name, renamed) => {
      fc.pre(name !== renamed)
      const f = fixture(name)
      const before = f.retarget('基线', '目标甲')
      const draft = f.request('改名')
      draft.entries.find(entry => entry.characterId === '目标乙')!.name = renamed
      const after = commitAuthorCharacterRoster(f.db, draft, scope, () => {})
      expect(after.snapshot.factHash).not.toBe(before.snapshot.factHash)
    }), { numRuns: 25 })
  })

  it('is a pure function of the current facts, not of edit history', () => {
    fc.assert(fc.property(displayName, name => {
      const f = fixture(name)
      const baseline = f.retarget('基线', '目标甲')
      f.retarget('先指向乙', '目标乙')
      const restored = f.retarget('再回到甲', '目标甲')
      // 中途改过一次又改回来：事实相同就必须得到相同的哈希，不能被隐性历史污染。
      expect(restored.snapshot.factHash).toBe(baseline.snapshot.factHash)
    }), { numRuns: 25 })
  })
})
