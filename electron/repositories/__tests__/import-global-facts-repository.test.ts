import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-import-global-'))
  initProjectDatabase(root)
  ProjectCoreRepository.init('导入项目')
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ImportGlobalFactsRepository transaction seam', () => {
  it('commits config, non-character architecture and roster as one read-back receipt', () => {
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
      roster: { snapshot: { status: 'ready', entries: expect.arrayContaining([
        expect.objectContaining({ name: '阿Q', role: 'protagonist' }),
      ]) } },
    })
    expect(ProjectCoreRepository.get()).toMatchObject({
      genre: '现实', premise: '个人与社会冲突',
      coreOutline: '阿Q由自尊走向幻灭', worldSetting: '辛亥前后的江南乡村',
      protagonistProfile: '阿Q，贫困而善于精神胜利',
      charactersArch: expect.stringContaining('阿Q'),
    })
    expect(CharacterRosterRepository.read()).toMatchObject({ revision: 1, status: 'ready' })
  })

  it('rolls back core, roster and operation ledger when the roster candidate is invalid', () => {
    getProjectDb()!.exec(`
      CREATE TRIGGER reject_imported_roster
      BEFORE INSERT ON characters
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
    expect(CharacterRosterRepository.read().revision).toBe(1)
  })
})
