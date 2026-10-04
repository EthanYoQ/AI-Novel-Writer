import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EMPTY_CARD, useCharacterStore, type CharacterCard } from '../character-store'
import { useProjectStore } from '../project-store'
import { useEditorStore } from '../editor-store'
import { characterRosterEntryFromCard } from '../../services/character-roster-client'
import { mergeCharacterDraftWithRemote } from '../character-rename-ledger'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../services/ipc-client', () => ({ ipc: { invokeWithProjectSession: invoke } }))
const path = 'C:/合成身份项目'
const card = (characterId: string, name: string, notes = ''): CharacterCard => ({ ...EMPTY_CARD, characterId, name, notes })
const snapshot = (cards: CharacterCard[], revision = 1) => ({ revision, identityRevision: revision, entries: cards.map(characterRosterEntryFromCard) })
beforeEach(() => { invoke.mockReset(); useEditorStore.setState({ draftLedgers: {} }); useProjectStore.setState({ currentProject: { id: '项目', path, sessionLease: 'epoch', novelConfig: {} } as never }); useCharacterStore.getState().reset() })
afterEach(() => { useProjectStore.setState({ currentProject: null }); useCharacterStore.getState().reset() })
it('同名两人按ID选择编辑，名字交换关系仍跟随原身份', async () => {
 const cards = [card('甲id', '同名', '作者甲'), { ...card('乙id', '同名', '作者乙'), relationships: JSON.stringify([{ target: '同名', targetCharacterId: '甲id', relation: '盟友' }]) }]
 invoke.mockResolvedValue(snapshot(cards)); await useCharacterStore.getState().load(path)
 useCharacterStore.getState().setSelectedId('乙id'); useCharacterStore.getState().updateField('乙id', 'notes', '只改乙')
 expect(useCharacterStore.getState().characters.map(c => c.notes)).toEqual(['作者甲', '只改乙'])
 expect(useCharacterStore.getState().renameCharacter('甲id', '乙名')).toBe(true)
 expect(useCharacterStore.getState().renameCharacter('乙id', '甲名')).toBe(true)
 expect(useCharacterStore.getState().selectedId).toBe('乙id')
 expect(JSON.parse(useCharacterStore.getState().characters[1].relationships)[0].targetCharacterId).toBe('甲id')
 useCharacterStore.getState().setSelectedName('不存在'); expect(useCharacterStore.getState().selectedId).toBeNull()
})
it('同名显示兼容选择拒绝猜首项，name不能作为写目标', async () => {
 invoke.mockResolvedValue(snapshot([card('甲id', '同名'), card('乙id', '同名')])); await useCharacterStore.getState().load(path)
 useCharacterStore.getState().setSelectedName('同名'); expect(useCharacterStore.getState().selectedId).toBeNull()
 useCharacterStore.getState().updateField('同名', 'notes', '错误')
 expect(useCharacterStore.getState().characters.every(c => c.notes === '')).toBe(true)
 expect(useCharacterStore.getState().renameCharacter('同名', '错误')).toBe(false)
})
it('按ID三方合并保留本地改名及远端字段，不按交换后的显示名串人', () => {
 const base = [card('甲', '甲名', '旧甲'), card('乙', '乙名', '旧乙')]
 const draft = [{ ...base[0], name: '乙名' }, { ...base[1], name: '甲名' }]
 const remote = [{ ...base[0], notes: '新甲' }, { ...base[1], notes: '新乙' }]
 expect(mergeCharacterDraftWithRemote(base, draft, remote, []).map(c => [c.characterId, c.name, c.notes])).toEqual([['甲', '乙名', '新甲'], ['乙', '甲名', '新乙']])
})
it('新卡保存期间继续编辑，created映射保新dirty与选中ID，后续保存无draftID', async () => {
 invoke.mockResolvedValue(snapshot([])); await useCharacterStore.getState().load(path); useCharacterStore.getState().addCharacter()
 const draftId = useCharacterStore.getState().selectedId!; expect(draftId).toMatch(/^draft:/)
 let resolve!: (value: unknown) => void
 invoke.mockImplementationOnce(async (_session, channel, request) => { expect(channel).toBe('db:character-roster-commit'); expect(request.entries[0].characterId).toBe(draftId); return new Promise(accept => { resolve = accept }) })
 const pending = useCharacterStore.getState().saveAll(path)
 await vi.waitFor(() => expect(resolve).toBeDefined())
 useCharacterStore.getState().updateField(draftId, 'notes', '保存期间作者修改')
 resolve({ success: true, receipt: { revision: 2, created: [{ selectionKey: draftId, characterId: '正式ID' }], snapshot: snapshot([{ ...useCharacterStore.getState().characters[0], characterId: '正式ID', notes: '' }], 2) } })
 await pending
 expect(useCharacterStore.getState().selectedId).toBe('正式ID')
 expect(useCharacterStore.getState().characters[0]).toMatchObject({ characterId: '正式ID', notes: '保存期间作者修改' })
 invoke.mockImplementationOnce(async (_session, _channel, request) => { expect(request.entries[0]).toMatchObject({ characterId: '正式ID', notes: '保存期间作者修改' }); return { success: true, receipt: { revision: 3, snapshot: snapshot(useCharacterStore.getState().characters, 3) } } })
 await useCharacterStore.getState().saveAll(path)
})

it('ACK丢失同payload双revision重试operation不变，后续作者编辑必须新operation', async () => {
 invoke.mockResolvedValue(snapshot([card('甲id', '甲名')]))
 await useCharacterStore.getState().load(path)
 useCharacterStore.getState().updateField('甲id', 'notes', '第一稿')
 invoke.mockRejectedValueOnce(new Error('合成ACK丢失'))
 await expect(useCharacterStore.getState().saveAll(path)).rejects.toThrow('合成ACK丢失')
 const first = invoke.mock.calls.at(-1)![2]
 invoke.mockImplementationOnce(async (_session, _channel, request) => {
  expect(request).toEqual(first)
  return { success: true, receipt: { revision: 2, snapshot: snapshot([card('甲id', '甲名', '第一稿')], 2) } }
 })
 await useCharacterStore.getState().saveAll(path)
 useCharacterStore.getState().updateField('甲id', 'notes', '后来作者第二稿')
 invoke.mockImplementationOnce(async (_session, _channel, request) => {
  expect(request.operationId).not.toBe(first.operationId)
  expect(request).toMatchObject({ expectedRevision: 2, expectedIdentityRevision: 2 })
  expect(request.entries[0].notes).toBe('后来作者第二稿')
  return { success: true, receipt: { revision: 3, snapshot: snapshot([card('甲id', '甲名', '后来作者第二稿')], 3) } }
 })
 await useCharacterStore.getState().saveAll(path)
})
