import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { ProjectCoreRepository } from '../project-core-repository'
import { CharacterRosterRepository } from '../character-roster-repository'
import { ImportGlobalFactsRepository } from '../import-global-facts-repository'
import type { ImportGlobalFactsRequest } from '../../../src/shared/import-global-facts'

let root = ''

function request(overrides: Partial<ImportGlobalFactsRequest> = {}): ImportGlobalFactsRequest {
  const card = (name: string, role: 'protagonist' | 'supporting') => ({
    name, role, gender: '未知', age: '18', appearance: '明确', personality: '明确',
    background: '明确', abilities: '明确', motivation: '明确', relationships: [],
    arc: '明确', notes: '待确认',
  })
  return {
    operationId: 'import-global-run-1',
    expectedRosterRevision: 0,
    core: {
      genre: '现实', subGenre: '讽刺', targetAudience: '通用', totalChapters: 9,
      wordsPerChapter: 2500, plotStructure: 'three_act', narrativePov: 'third_limited',
      goldenFinger: '无', globalGuidance: '克制', premise: '个人与社会冲突',
      coreOutline: '阿Q由自尊走向幻灭', worldSetting: '辛亥前后的江南乡村',
      protagonistProfile: '阿Q，贫困而善于精神胜利',
      worldbuilding: '未庄', synopsis: '阿Q的命运',
    },
    characterEntries: [card('阿Q', 'protagonist'), card('吴妈', 'supporting')],
    ...overrides,
  }
}

beforeEach(() => {
  const cache = path.resolve('.runtime/.cache/novel-quality-modernization/s09b-import-global')
  fs.mkdirSync(cache, { recursive: true })
  root = fs.mkdtempSync(path.join(cache, 'case-'))
  initProjectDatabase(root)
  ProjectCoreRepository.init('导入项目')
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ImportGlobalFactsRepository transaction seam', () => {
  it('commits core and source-preserving character proposals in one transaction', () => {
    const receipt = ImportGlobalFactsRepository.commit(request())

    expect(receipt).toMatchObject({
      operationId: 'import-global-run-1',
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      idempotent: false,
      core: {
        genre: '现实', premise: '个人与社会冲突', synopsis: '阿Q的命运',
        coreOutline: '阿Q由自尊走向幻灭', worldSetting: '辛亥前后的江南乡村',
        protagonistProfile: '阿Q，贫困而善于精神胜利',
      },
      characterProposal: { proposalBatchId: expect.stringMatching(/^cpb:[a-f0-9]{64}$/), sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      proposalSource: request(),
    })
    expect(ProjectCoreRepository.get()).toMatchObject({
      genre: '现实', premise: '个人与社会冲突',
      coreOutline: '阿Q由自尊走向幻灭', worldSetting: '辛亥前后的江南乡村',
      protagonistProfile: '阿Q，贫困而善于精神胜利',
      charactersArch: '',
    })
    expect(CharacterRosterRepository.read()).toMatchObject({ revision: 0, status: 'empty' })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
    expect(getProjectDb()!.prepare("SELECT COUNT(*) FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'").pluck().get()).toBe(1)
  })

  it('rolls back core and the operation ledger when durable proposal staging fails', () => {
    getProjectDb()!.exec(`
      CREATE TRIGGER reject_imported_roster
      BEFORE INSERT ON character_identity_proposals
      BEGIN SELECT RAISE(ABORT, 'injected roster failure'); END;
    `)

    expect(() => ImportGlobalFactsRepository.commit(request())).toThrow('injected roster failure')

    expect(ProjectCoreRepository.get()).toMatchObject({ genre: '', premise: '' })
    expect(CharacterRosterRepository.read()).toMatchObject({ revision: 0, status: 'empty' })
    expect(getProjectDb()!.prepare('SELECT COUNT(*) AS count FROM import_global_fact_operations').get())
      .toEqual({ count: 0 })
  })

  it('replays the same operation without duplicating or rewriting facts', () => {
    const first = ImportGlobalFactsRepository.commit(request())
    const replay = ImportGlobalFactsRepository.commit(request())

    expect(replay).toEqual({ ...first, idempotent: true })
    expect(CharacterRosterRepository.read().revision).toBe(0)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM character_identity_proposals').pluck().get()).toBe(1)
  })

  it('keeps same-name imports from different source operations as distinct unresolved proposals', () => {
    const firstInput = request()
    const secondInput = request({ operationId: 'import-other-source' })
    secondInput.characterEntries[0].background = '另一份原稿中的同名者'
    const first = ImportGlobalFactsRepository.commit(firstInput)
    const second = ImportGlobalFactsRepository.commit(secondInput)
    expect(first.characterProposal?.proposalBatchId).not.toBe(second.characterProposal?.proposalBatchId)
    const envelopes = getProjectDb()!.prepare("SELECT raw_value FROM character_identity_proposals WHERE source_key LIKE 'character-proposal-v1:%'")
      .all().map(row => JSON.parse((row as { raw_value: string }).raw_value))
    expect(envelopes).toHaveLength(2)
    const identities = envelopes.map(envelope => envelope.batch.items[0])
    expect(identities.map(item => item.fields.name)).toEqual(['阿Q', '阿Q'])
    expect(new Set(identities.map(item => item.sourceId)).size).toBe(2)
    expect(identities.every(item => item.resolution.status === 'unresolved')).toBe(true)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM character_relationships').pluck().get()).toBe(0)
  })

  it('retains inferred static and dynamic source material without assigning author provenance', () => {
    const input = request()
    input.characterEntries[0].currentState = {
      location: '原稿推断的位置', powerLevel: '', physicalState: '', mentalState: '', keyItems: '', recentEvents: '', updatedAtChapter: 2,
    }
    const receipt = ImportGlobalFactsRepository.commit(input)
    const envelope = JSON.parse((getProjectDb()!.prepare('SELECT raw_value FROM character_identity_proposals WHERE proposal_id=?')
      .get(receipt.characterProposal!.proposalBatchId) as { raw_value: string }).raw_value)
    expect(envelope.proof.provenance).toBeNull()
    expect(envelope.batch.items[0].rawValue).toEqual(input.characterEntries[0])
    expect(envelope.batch.items[0].fields).not.toHaveProperty('currentState')
    expect(envelope.batch.items[0].fields).not.toHaveProperty('provenance')
    expect(envelope.batch.items[0].rawValue.currentState.location).toBe('原稿推断的位置')
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM character_identity_approvals').pluck().get()).toBe(0)
    expect(getProjectDb()!.prepare('SELECT COUNT(*) FROM characters').pluck().get()).toBe(0)
  })
})
