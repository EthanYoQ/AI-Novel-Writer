import { describe, expect, it } from 'vitest'

import type { CharacterRosterSnapshot } from '../../../shared/character-roster'
import {
  canExplicitlyRepairCharacterRoster,
  getCharacterRosterRepairPresentation,
} from '../character-roster-repair-state'

const text = (zhCNText: string, enUSText: string) => (void enUSText, zhCNText)
const english = (_zhCNText: string, enUSText: string) => enUSText

function snapshot(overrides: Partial<CharacterRosterSnapshot> = {}): CharacterRosterSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    migrationState: 'empty',
    status: 'empty',
    entries: [],
    renderedMarkdown: '',
    projectionHash: '',
    factHash: '',
    ...overrides,
  }
}

describe('character roster repair UI state', () => {
  it('distinguishes empty, ready, legacy repair and protected-card adoption in Chinese and English', () => {
    expect(getCharacterRosterRepairPresentation(snapshot(), text)).toMatchObject({
      kind: 'empty', label: '尚未生成角色名单',
    })
    expect(getCharacterRosterRepairPresentation(snapshot({ status: 'ready', migrationState: 'ready', entries: [{ name: '林舟' } as never] }), english))
      .toMatchObject({ kind: 'ready', label: 'Character roster ready' })
    const repair = getCharacterRosterRepairPresentation(snapshot({
      status: 'legacy_repair_required',
      migrationState: 'legacy_markdown_pending',
      legacyMarkdown: '旧角色图谱原文',
    }), english)
    expect(repair).toMatchObject({ kind: 'repair_required', actionLabel: 'Repair character roster' })
    expect(canExplicitlyRepairCharacterRoster(repair)).toBe(true)

    const adoption = getCharacterRosterRepairPresentation(snapshot({
      status: 'inconsistent',
      migrationState: 'legacy_cards_preserved',
      entries: [{ name: '旧角色' } as never],
    }), text)
    expect(adoption).toMatchObject({ kind: 'adoption_required', actionLabel: '重建只读图谱' })
    expect(canExplicitlyRepairCharacterRoster(adoption)).toBe(true)
  })

  it('explains a failed repair without implying that any data was overwritten', () => {
    const presentation = getCharacterRosterRepairPresentation(
      snapshot({ status: 'legacy_repair_required', migrationState: 'legacy_markdown_pending' }),
      english,
      'The model returned invalid JSON',
    )
    expect(presentation).toMatchObject({
      kind: 'failed_with_data_preserved',
      label: 'Repair did not complete; data was preserved',
      actionLabel: 'Retry safe repair',
    })
  })
})
