import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CharacterData } from '../../../../electron/repositories/character-repository'
import { syncBlueprintCharacterCandidates } from '../blueprint-character-sync'

const projectPath = 'C:\\novels\\candidate-sync'
const projectSession = {
  projectId: 'candidate-sync',
  leaseId: 'lease-candidate-sync',
  projectPath,
}

function character(overrides: Partial<CharacterData> = {}): CharacterData {
  return {
    name: '林岚',
    role: 'protagonist',
    gender: '女',
    age: '27',
    appearance: '灰色职业套装',
    personality: '谨慎',
    background: '手工填写的背景',
    abilities: '调查',
    motivation: '查清真相',
    relationships: JSON.stringify([{ target: '顾问', relation: '旧关系' }]),
    arc: '手工填写的弧光',
    notes: '手工备注不得覆盖',
    ...overrides,
  }
}

function stubIpc(existing: CharacterData[]) {
  const upserts: CharacterData[] = []
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:character-get-all') return existing
    if (channel === 'db:character-upsert') {
      upserts.push(args[0] as CharacterData)
      return { success: true }
    }
    throw new Error(`unexpected IPC: ${channel}`)
  })
  vi.stubGlobal('window', {
    velaAPI: {
      invoke,
      on: vi.fn(),
      once: vi.fn(),
      send: vi.fn(),
      setZoomLevel: vi.fn(),
      setZoomFactor: vi.fn(),
      getZoomLevel: vi.fn(),
    },
  })
  return { invoke, upserts }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('blueprint character candidate sync', () => {
  it('creates missing candidates after blueprint persistence without requiring an embedding model', async () => {
    const { invoke, upserts } = stubIpc([])

    await syncBlueprintCharacterCandidates([
      {
        chapterNumber: 1,
        characters: ['林岚', '周砚'],
        relationshipHints: [{ from: '林岚', to: '周砚', relation: '共同追查真相' }],
      },
    ], projectPath, projectSession)

    expect(upserts).toHaveLength(2)
    expect(upserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: '林岚',
        role: 'supporting',
        notes: '自动候选来源：章节蓝图（第1章）',
        relationships: JSON.stringify([{ target: '周砚', relation: '共同追查真相' }]),
      }),
      expect.objectContaining({
        name: '周砚',
        role: 'supporting',
        notes: '自动候选来源：章节蓝图（第1章）',
        relationships: JSON.stringify([{ target: '林岚', relation: '共同追查真相' }]),
      }),
    ]))
    expect(invoke.mock.calls.some(([channel]) => String(channel).startsWith('kb:'))).toBe(false)
  })

  it('never overwrites existing manual fields and only merges structured relationship edges bidirectionally', async () => {
    const existing = character()
    const { upserts } = stubIpc([existing])

    await syncBlueprintCharacterCandidates([
      {
        chapterNumber: 2,
        characters: ['林岚', '周砚'],
        relationshipHints: {
          林岚: [{ target: '周砚', relation: '共同追查真相' }],
        },
      },
    ], projectPath, projectSession)

    const preserved = upserts.find(card => card.name === '林岚')
    const candidate = upserts.find(card => card.name === '周砚')
    expect(preserved).toMatchObject({
      role: existing.role,
      gender: existing.gender,
      age: existing.age,
      appearance: existing.appearance,
      personality: existing.personality,
      background: existing.background,
      abilities: existing.abilities,
      motivation: existing.motivation,
      arc: existing.arc,
      notes: existing.notes,
    })
    expect(JSON.parse(preserved!.relationships)).toEqual([
      { target: '顾问', relation: '旧关系' },
      { target: '周砚', relation: '共同追查真相' },
    ])
    expect(JSON.parse(candidate!.relationships)).toEqual([
      { target: '林岚', relation: '共同追查真相' },
    ])
  })

  it('keeps an opaque manual relationship field unchanged rather than replacing it with automatic data', async () => {
    const existing = character({ relationships: '林岚与周砚的手工关系说明' })
    const { upserts } = stubIpc([existing])

    await syncBlueprintCharacterCandidates([
      {
        chapterNumber: 2,
        characters: ['林岚', '周砚'],
        relationshipHints: [{ from: '林岚', to: '周砚', relation: '共同追查真相' }],
      },
    ], projectPath, projectSession)

    expect(upserts.find(card => card.name === '林岚')).toBeUndefined()
    expect(JSON.parse(upserts.find(card => card.name === '周砚')!.relationships)).toEqual([
      { target: '林岚', relation: '共同追查真相' },
    ])
  })
})
