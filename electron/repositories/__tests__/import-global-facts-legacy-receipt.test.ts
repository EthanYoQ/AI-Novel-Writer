import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { ProjectCoreRepository } from '../project-core-repository'
import { CharacterRosterRepository, refreshCharacterIdentityProjection } from '../character-roster-repository'
import { ImportGlobalFactsRepository } from '../import-global-facts-repository'
import type { ImportGlobalFactsCore, ImportGlobalFactsReceipt } from '../../../src/shared/import-global-facts'

/**
 * 旧项目先用按姓名写入的角色事实记录了一条导入回执，之后项目才升级出身份
 * schema（M02 只重建 characters，不动 character_roster_meta）。此时公开
 * factHash 会从姓名版本变成 ID 版本，历史回执只能与保留的姓名版本哈希比较，
 * 否则一次合法的幂等 ACK 重试会被误报成「导入角色事实已被后续修改」。
 */
let root = ''

function coreSnapshot(): ImportGlobalFactsCore {
  const core = ProjectCoreRepository.get()!
  return {
    genre: core.genre, subGenre: core.subGenre, targetAudience: core.targetAudience,
    totalChapters: core.totalChapters, wordsPerChapter: core.wordsPerChapter,
    plotStructure: core.plotStructure as ImportGlobalFactsCore['plotStructure'],
    narrativePov: core.narrativePov as ImportGlobalFactsCore['narrativePov'],
    goldenFinger: core.goldenFinger, globalGuidance: core.globalGuidance, coreOutline: core.coreOutline,
    worldSetting: core.worldSetting, protagonistProfile: core.protagonistProfile,
    premise: core.premise, worldbuilding: core.worldbuilding, synopsis: core.synopsis,
  }
}

/** 历史回执的 payroll 哈希是姓名版本，正是旧 legacy commit 写入的那个值。 */
function seedLegacyReceipt(operationId: string, rosterFactHash: string): void {
  ImportGlobalFactsRepository.getCommittedOperation('seed-probe-missing')
  const snapshot = CharacterRosterRepository.read()
  const receipt: ImportGlobalFactsReceipt = {
    operationId,
    payloadHash: 'b'.repeat(64),
    idempotent: false,
    core: coreSnapshot(),
    roster: {
      operationId: `${operationId}:roster`,
      payloadHash: 'c'.repeat(64),
      revision: snapshot.revision,
      idempotent: false,
      snapshot: { ...snapshot, factHash: rosterFactHash },
    },
  }
  getProjectDb()!.prepare('INSERT INTO import_global_fact_operations(operation_id,payload_hash,receipt_json) VALUES(?,?,?)')
    .run(operationId, receipt.payloadHash, JSON.stringify(receipt))
}

beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/novel-quality-modernization/s09c-legacy-receipt')
  fs.mkdirSync(cache, { recursive: true })
  root = fs.mkdtempSync(path.join(cache, 'case-'))
  initProjectDatabase(root)
  ProjectCoreRepository.init('历史回执项目')
  getProjectDb()!.exec("INSERT INTO characters(character_id,name,role) VALUES('同名甲','沈砺','supporting'),('同名乙','沈砺','supporting')")
  getProjectDb()!.transaction(() => refreshCharacterIdentityProjection(getProjectDb()!))()
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('legacy import receipt survives gaining the identity schema', () => {
  it('keeps the public hash distinct from the persisted name-only hash', () => {
    const snapshot = CharacterRosterRepository.read()
    // 身份 schema 项目里两者必须真的不同，否则本文件的区分就没有意义。
    expect(snapshot.factHash).not.toBe(snapshot.nameOnlyFactHash)
    expect(snapshot.nameOnlyFactHash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('validates an idempotent ACK retry against the persisted name-only hash', () => {
    const nameOnly = CharacterRosterRepository.read().nameOnlyFactHash
    seedLegacyReceipt('legacy-import-1', nameOnly)
    expect(ImportGlobalFactsRepository.getCommittedOperation('legacy-import-1')).toMatchObject({ operationId: 'legacy-import-1' })
  })

  it('still refuses a receipt whose recorded facts really changed', () => {
    seedLegacyReceipt('legacy-import-2', 'd'.repeat(64))
    expect(() => ImportGlobalFactsRepository.getCommittedOperation('legacy-import-2'))
      .toThrow('导入角色事实已被后续修改')
  })
})
