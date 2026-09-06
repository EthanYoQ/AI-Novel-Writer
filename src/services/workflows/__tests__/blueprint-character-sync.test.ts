import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CharacterRosterEntry } from '../../../shared/character-roster'
import { blueprintCharacterSyncFactError } from '../../../shared/blueprint-character-sync-evidence'
import {
  syncBlueprintCharacterCandidates,
  type BlueprintCharacterCandidateSource,
} from '../blueprint-character-sync'

const projectPath = 'C:\\novels\\candidate-sync'
const projectSession = {
  projectId: 'candidate-sync',
  leaseId: 'lease-candidate-sync',
  projectPath,
}

function character(overrides: Partial<CharacterRosterEntry> = {}): CharacterRosterEntry {
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
    relationships: [{ target: '顾问', relation: '旧关系' }],
    arc: '手工填写的弧光',
    notes: '手工备注不得覆盖',
    ...overrides,
  }
}

function stubIpc(existing: CharacterRosterEntry[]) {
  const commits: Array<{ entries: CharacterRosterEntry[]; intent: string }> = []
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:character-roster-read') {
      return { status: existing.length > 0 ? 'ready' : 'empty', revision: 7, entries: existing }
    }
    if (channel === 'db:character-roster-commit') {
      const request = args[0] as { entries: CharacterRosterEntry[]; intent: string }
      commits.push(request)
      return {
        success: true,
        receipt: { revision: 8, snapshot: { status: 'ready', entries: request.entries } },
      }
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
  return { invoke, commits }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('blueprint character candidate sync', () => {
  it('registers an explicitly declared recurring blueprint character', async () => {
    const { commits } = stubIpc([character()])
    const blueprint: BlueprintCharacterCandidateSource = {
      chapterNumber: 1,
      characters: ['林岚', '周砚'],
      relationshipHints: [],
      newCharacterCandidates: [{
        name: '周砚',
        role: 'supporting',
      }],
    }

    await syncBlueprintCharacterCandidates(
      [blueprint],
      projectPath,
      projectSession,
      'blueprint-sync-declared-001',
    )

    expect(commits).toEqual([expect.objectContaining({
      intent: 'blueprint_sync',
      entries: [expect.objectContaining({
        name: '周砚',
        role: 'supporting',
      })],
    })])
  })

  it('does not turn an undeclared blueprint-only name into a character card', async () => {
    const { invoke, commits } = stubIpc([])

    await syncBlueprintCharacterCandidates([
      {
        chapterNumber: 1,
        characters: ['林岚', '周砚'],
        relationshipHints: [{ from: '林岚', to: '周砚', relation: '共同追查真相' }],
      },
    ], projectPath, projectSession, 'blueprint-sync-001')

    expect(commits).toEqual([])
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'db:character-roster-read',
    ])
    expect(invoke.mock.calls.some(([channel]) => String(channel).startsWith('kb:'))).toBe(false)
  })

  it('only enriches relationships between characters that already exist in the roster', async () => {
    const existing = character()
    const second = character({ name: '周砚', role: 'supporting', relationships: [] })
    const { commits } = stubIpc([existing, second])

    await syncBlueprintCharacterCandidates([
      {
        chapterNumber: 2,
        characters: ['林岚', '周砚'],
        relationshipHints: { 林岚: [{ target: '周砚', relation: '共同追查真相' }] },
      },
    ], projectPath, projectSession, 'blueprint-sync-002')

    expect(commits).toHaveLength(1)
    expect(commits[0].entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: '林岚',
        relationships: [
          { target: '顾问', relation: '旧关系' },
          { target: '周砚', relation: '共同追查真相' },
        ],
      }),
      expect.objectContaining({
        name: '周砚',
        relationships: [{ target: '林岚', relation: '共同追查真相' }],
      }),
    ]))
    expect(commits[0].entries).toHaveLength(2)
  })

  it('does not echo legacy free-text relationship evidence through a blueprint IPC request', async () => {
    const existing = character({ legacyRelationshipNotes: '林岚与周砚的手工关系说明', relationships: [] })
    const second = character({ name: '周砚', relationships: [] })
    const frozenBlueprints = [
      {
        chapterNumber: 2,
        characters: ['林岚', '周砚'],
        relationshipHints: [{ from: '林岚', to: '周砚', relation: '共同追查真相' }],
      },
    ]
    const { commits } = stubIpc([existing, second])

    await syncBlueprintCharacterCandidates(frozenBlueprints, projectPath, projectSession, 'blueprint-sync-003')

    expect(commits).toHaveLength(0)
    expect(blueprintCharacterSyncFactError(frozenBlueprints, [existing, second])).toBeUndefined()
  })
})
