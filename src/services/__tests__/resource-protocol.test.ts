import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseResourceUri, formatResourceUri, canonicalResourceUri, resourceWriteAllowed } from '../../shared/project-paths'
import { readResourceContent, writeCoreContent } from '../resource-protocol'
import { ipc } from '../ipc-client'
import { useEditorStore } from '../../stores/editor-store'

vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: vi.fn() } }))
const session = { projectId: '合成项目', leaseId: '本次租约', projectPath: 'C:/合成小说' }
beforeEach(() => { vi.mocked(ipc.invokeWithProjectSession).mockReset(); useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} }) })
describe('规范资源与集中旧URI读取', () => {
  it.each(['core/premise', 'core/worldbuilding', 'core/characters', 'core/synopsis', 'draft/1', 'manuscript/2', 'revision/3', 'review/4', 'draft/ch1/v2/review0', 'recovery/candidate-1'])('旧%s只经parser迁成规范引用', suffix => {
    const old = `vela://${suffix}`
    expect(parseResourceUri(old)?.legacy).toBe(true)
    expect(canonicalResourceUri(old)).toBe(`ai-novel://${suffix}`)
    expect(resourceWriteAllowed(old)).toBe(false)
  })
  it.each(['draft/1junk', 'draft/0', 'draft/-1', 'draft/1/../../core/premise', 'draft/9007199254740992', 'core/constructor', 'core/__proto__', 'draft/1?x=2', 'draft/%31', 'draft/1#x', 'draft/ch1/v0', 'recovery/../secret'])('拒绝越权或不完整地址%s', suffix => {
    expect(parseResourceUri(`ai-novel://${suffix}`)).toBeNull()
    expect(resourceWriteAllowed(`ai-novel://${suffix}`)).toBe(false)
  })
  it('formatter禁止非法ID；五资源类型权限不混成文件写', () => {
    expect(() => formatResourceUri({ kind: 'draft', id: NaN })).toThrow()
    expect(resourceWriteAllowed('ai-novel://draft/1')).toBe(true)
    expect(resourceWriteAllowed('ai-novel://core/premise')).toBe(true)
    for (const suffix of ['manuscript/1', 'revision/1', 'review/1', 'core/characters']) expect(resourceWriteAllowed(`ai-novel://${suffix}`)).toBe(false)
    expect(parseResourceUri('C:/小说/正文.md')).toBeNull()
  })
  it.each([['draft', 'db:draft-get-full'], ['manuscript', 'db:draft-get-full'], ['revision', 'db:revision-get-full'], ['review', 'db:review-get-full']] as const)('旧%s只走指定DB领域读取', async (kind, channel) => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce({ content: '中文原文' } as never)
    await expect(readResourceContent(`vela://${kind}/1`, session)).resolves.toBe('中文原文')
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledExactlyOnceWith(session, channel, 1, session.projectPath)
  })
  it('非法与legacy写在IPC前拒绝，规范core只改允许字段', async () => {
    for (const uri of ['vela://core/premise', 'ai-novel://core/characters', 'ai-novel://core/constructor']) expect(await writeCoreContent(uri, '草稿', session)).toBe(false)
    expect(ipc.invokeWithProjectSession).not.toHaveBeenCalled()
    await expect(readResourceContent('ai-novel://draft/1garbage', session)).rejects.toThrow('INVALID_RESOURCE_URI')
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce({ success: true } as never)
    expect(await writeCoreContent('ai-novel://core/premise', '作者文字', session)).toBe(true)
    expect(ipc.invokeWithProjectSession).toHaveBeenCalledWith(session, 'db:project-core-update', { premise: '作者文字' }, session.projectPath)
  })
  it('旧tab复开只改地址，dirty正文/基准/代次不丢；项目不串', () => {
    useEditorStore.setState({ tabs: [{ id: '旧tab', name: '旧章', type: 'chapter', projectKey: session.projectPath, filePath: 'vela://draft/1', content: '尚未保存的中文', savedContent: '旧正文', dirty: true, contentRevision: 9 }], activeTabId: '旧tab' })
    useEditorStore.getState().openFile({ id: '新tab', name: '新章', type: 'chapter', projectKey: session.projectPath, filePath: 'ai-novel://draft/1', content: '磁盘正文' })
    expect(useEditorStore.getState().tabs).toHaveLength(1)
    expect(useEditorStore.getState().tabs[0]).toMatchObject({ filePath: 'ai-novel://draft/1', content: '尚未保存的中文', savedContent: '旧正文', dirty: true, contentRevision: 9 })
    useEditorStore.getState().openFile({ id: '别项目', name: '别章', type: 'chapter', projectKey: 'C:/另一小说', filePath: 'vela://draft/1', content: '别项目正文' })
    expect(useEditorStore.getState().tabs).toHaveLength(2)
    expect(useEditorStore.getState().tabs[1]?.filePath).toBe('ai-novel://draft/1')
  })
})
