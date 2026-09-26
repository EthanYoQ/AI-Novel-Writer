import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readCharactersTool } from '../read-characters.tool'
import { createAgentExecutionContext } from '../project-context'
import { useProjectStore } from '../../../../stores/project-store'
const project = { id: '项目', path: 'C:/合成Agent身份', sessionLease: '会话', novelConfig: {} }
const cards = [{ characterId: '甲', name: '同名', role: 'protagonist', notes: '甲事实' }, { characterId: '乙', name: '同名', role: 'supporting', notes: '乙事实' }]
beforeEach(() => useProjectStore.setState({ currentProject: project as never }))
afterEach(() => { vi.unstubAllGlobals(); useProjectStore.setState({ currentProject: null }) })
function setup() { const invoke = vi.fn(async (channel: string) => {
 if (channel === 'db:character-get-all') return cards
 if (channel === 'db:character-roster-read') return { identityRevision: 4, aliases: [
  { characterId: '甲', name: '共享别名', validFrom: 1, validThrough: null }, { characterId: '乙', name: '共享别名', validFrom: 2, validThrough: null },
  { characterId: '甲', name: '过期别名', validFrom: 1, validThrough: 3 }] }
 throw new Error(channel)
 }); vi.stubGlobal('window', { aiNovelAPI: { invoke } }); return invoke }
it.each(['同名', '共享别名'])('%s只返回待确认候选，不能firstmatch声称身份', async name => { setup(); const result = await readCharactersTool.execute({ character_name: name }, createAgentExecutionContext()); const value = JSON.parse(result.content); expect(value.status).toBe('candidates-only'); expect(value.candidates.map((c: {candidateId: string}) => c.candidateId)).toEqual(['甲', '乙']); expect(result.content).not.toContain('甲事实') })
it('明确稳定ID返回确切乙，不受同名影响', async () => { setup(); const result = await readCharactersTool.execute({ character_id: '乙' }, createAgentExecutionContext()); expect(result.success).toBe(true); expect(result.content).toContain('乙事实'); expect(result.content).not.toContain('甲事实') })
it('过期别名及模糊子串不解析为身份', async () => { setup(); for (const name of ['过期别名', '同']) { const result = await readCharactersTool.execute({ character_name: name }, createAgentExecutionContext()); expect(result.success).toBe(false) } })
