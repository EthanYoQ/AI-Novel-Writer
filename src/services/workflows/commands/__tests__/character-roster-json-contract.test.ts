import { describe, expect, it, vi } from 'vitest'

import {
  CHARACTER_ROSTER_JSON_CONTRACT,
  parseCharacterRosterJsonResponse,
  type CharacterRosterJsonRepairPort,
} from '../character-roster-json-contract'

function createPort(overrides: Partial<CharacterRosterJsonRepairPort> = {}): CharacterRosterJsonRepairPort {
  return {
    parseJson: JSON.parse,
    assertNotCancelled: vi.fn(),
    log: vi.fn(),
    repair: vi.fn(),
    ...overrides,
  }
}

describe('character roster JSON contract public seam', () => {
  it('uses the single versioned schema contract and accepts a direct object without requesting repair', async () => {
    const port = createPort()

    const candidate = await parseCharacterRosterJsonResponse(
      '{"schemaVersion":1,"entries":[]}',
      port,
      { repairSystemPrompt: 'normal repair system', repairPurpose: 'normal-json-repair' },
    )

    expect(CHARACTER_ROSTER_JSON_CONTRACT).toContain('"schemaVersion": 1')
    expect(candidate).toEqual({ schemaVersion: 1, entries: [] })
    expect(port.repair).not.toHaveBeenCalled()
  })

  it('performs exactly one syntax repair through the caller-selected purpose and system prompt', async () => {
    const repaired = '{"schemaVersion":1,"entries":[{"name":"沈砺"}]}'
    const port = createPort({ repair: vi.fn().mockResolvedValue(repaired) })

    const candidate = await parseCharacterRosterJsonResponse(
      '{"schemaVersion":1,"entries":[',
      port,
      { repairSystemPrompt: 'legacy repair system', repairPurpose: 'legacy-character-roster-json-repair' },
    )

    expect(candidate).toEqual({ schemaVersion: 1, entries: [{ name: '沈砺' }] })
    expect(port.assertNotCancelled).toHaveBeenCalledOnce()
    expect(port.log).toHaveBeenCalledWith('角色名单 JSON 格式异常，正在执行一次格式修复...')
    expect(port.repair).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      systemPrompt: 'legacy repair system',
      purpose: 'legacy-character-roster-json-repair',
      prompt: expect.stringContaining('<invalid-json>'),
    }))
  })

  it('fails closed after the single repair attempt still cannot produce a roster object', async () => {
    const port = createPort({ repair: vi.fn().mockResolvedValue('{') })

    await expect(parseCharacterRosterJsonResponse(
      '{"schemaVersion":1,"entries":[',
      port,
      { repairSystemPrompt: 'normal repair system', repairPurpose: 'normal-json-repair' },
    )).rejects.toThrow('AI 返回的角色名单 JSON 格式仍无效，未保存任何角色数据')
    expect(port.repair).toHaveBeenCalledOnce()
  })
})
