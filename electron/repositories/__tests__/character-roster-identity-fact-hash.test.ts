import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'

import { prepareCanonicalStorageFixture } from '../../../test/helpers/canonical-project-fixture'
import {
  CharacterRosterRepository,
  refreshCharacterIdentityProjection,
} from '../character-roster-repository'
import { commitAuthorCharacterRoster } from '../../services/character-roster-author'
import type { CharacterRosterCommitRequest } from '../../../src/shared/character-roster'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(dispose => dispose()))
const scope = { projectId: '同名事实哈希项目', epoch: '原会话' }

/** 两个同名角色加一个观察者，用来证明公开 factHash 以稳定 ID 而不是显示名取事实。 */
function fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s09c-author-tests')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'fact-hash-'))
  prepareCanonicalStorageFixture(root)
  const file = path.join(root, '.ai-novel', 'project.db')
  let db = new Database(file)
  db.pragma('foreign_keys=ON')
  db.exec("INSERT INTO project_core(id,project_name,writing_language) VALUES('main','同名事实哈希','zh-CN')")
  db.prepare('INSERT INTO characters(character_id,name,role) VALUES(?,?,?)').run('同名甲', '沈砺', 'supporting')
  db.prepare('INSERT INTO characters(character_id,name,role) VALUES(?,?,?)').run('同名乙', '沈砺', 'supporting')
  db.prepare('INSERT INTO characters(character_id,name,role) VALUES(?,?,?)').run('观察者', '旁观者', 'supporting')
  db.transaction(() => refreshCharacterIdentityProjection(db))()
  cleanups.push(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return {
    get db() { return db },
    reopen() { db.close(); db = new Database(file); db.pragma('foreign_keys=ON') },
    rosterMeta: () => db.prepare('SELECT * FROM character_roster_meta WHERE id=\'main\'').all(),
    request(operationId: string): CharacterRosterCommitRequest {
      const read = CharacterRosterRepository.read(db)
      return {
        operationId,
        schemaVersion: 1,
        intent: 'manual_edit',
        expectedRevision: read.revision,
        expectedIdentityRevision: read.identityRevision,
        entries: structuredClone(read.entries),
      }
    },
  }
}

/** 观察者指向某个同名目标，显示名在两次提交中完全相同。 */
function retarget(request: CharacterRosterCommitRequest, targetCharacterId: string): CharacterRosterCommitRequest {
  request.entries.find(entry => entry.characterId === '观察者')!.relationships = [
    { target: '沈砺', targetCharacterId, relation: '监视' },
  ]
  return request
}

it('同名关系目标重指向会改变公开 factHash', () => {
  const f = fixture()
  const first = commitAuthorCharacterRoster(f.db, retarget(f.request('指向甲'), '同名甲'), scope, () => {})
  const second = commitAuthorCharacterRoster(f.db, retarget(f.request('指向乙'), '同名乙'), scope, () => {})

  // 两次提交的可见事实在显示名层面完全相同，只有稳定目标 ID 不同。
  const observer = (receipt: typeof first) => receipt.snapshot.entries.find(entry => entry.characterId === '观察者')!
  expect(observer(first).relationships).toMatchObject([{ target: '沈砺', targetCharacterId: '同名甲', relation: '监视' }])
  expect(observer(second).relationships).toMatchObject([{ target: '沈砺', targetCharacterId: '同名乙', relation: '监视' }])
  expect(second.snapshot.revision).toBe(first.snapshot.revision + 1)
  expect(second.snapshot.factHash).not.toBe(first.snapshot.factHash)
})

it('角色改名会改变公开 factHash，但不动同名关系目标 ID', () => {
  const f = fixture()
  const first = commitAuthorCharacterRoster(f.db, retarget(f.request('基线'), '同名甲'), scope, () => {})
  const renamed = retarget(f.request('改名'), '同名甲')
  renamed.entries.find(entry => entry.characterId === '同名甲')!.name = '沈砺之'
  const second = commitAuthorCharacterRoster(f.db, renamed, scope, () => {})

  expect(second.snapshot.entries.find(entry => entry.characterId === '观察者')!.relationships[0]?.targetCharacterId)
    .toBe('同名甲')
  expect(second.snapshot.factHash).not.toBe(first.snapshot.factHash)
})

it('重开项目后公开 factHash 稳定，且读取路径零写入', () => {
  const f = fixture()
  const saved = commitAuthorCharacterRoster(f.db, retarget(f.request('持久'), '同名乙'), scope, () => {})
  const metaBefore = f.rosterMeta()

  f.reopen()
  const changes = f.db.prepare('SELECT total_changes()').pluck().get()
  const reopened = CharacterRosterRepository.read(f.db)
  expect(reopened.status).toBe('ready')
  expect(reopened.factHash).toBe(saved.snapshot.factHash)
  expect(f.rosterMeta()).toEqual(metaBefore)
  expect(f.db.prepare('SELECT total_changes()').pluck().get()).toBe(changes)
})

it('同一操作 ACK 重试返回相同 factHash，且不重复推进事实', () => {
  const f = fixture()
  const request = retarget(f.request('重试'), '同名甲')
  const first = commitAuthorCharacterRoster(f.db, request, scope, () => {})
  const retried = commitAuthorCharacterRoster(f.db, structuredClone(request), scope, () => {})

  expect(retried.idempotent).toBe(true)
  expect(retried.snapshot.factHash).toBe(first.snapshot.factHash)
  expect(retried.snapshot.revision).toBe(first.snapshot.revision)
})
