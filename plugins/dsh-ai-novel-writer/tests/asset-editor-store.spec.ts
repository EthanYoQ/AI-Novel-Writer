import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  NovelWorkbenchController,
  type NovelApplyOutcome,
  type NovelWorkbenchPort,
} from '../src/client/workbench-store.ts'
import type { NovelAssetReadWireResult } from '../src/context-types.ts'
import type { NovelProjectId, Revision } from '../src/types.ts'

const WORKSPACE_ID = WorkspaceId('workspace-a')
const SESSION_ID = SessionId('session-a')
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId
const REVISION_A = 'a'.repeat(64) as Revision
const REVISION_B = 'b'.repeat(64) as Revision

const manifest = (title: string, revision: Revision = REVISION_A): NovelAssetReadWireResult => {
  const text = `${JSON.stringify({
    formatVersion: 1,
    kind: 'harness-novel-project',
    projectId: PROJECT_ID,
    title,
    language: 'zh-CN',
    genre: '悬疑',
    plannedChapters: 20,
    targetWordsPerChapter: 3000,
    creativeStrategy: 'auto',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  }, null, 2)}\n`
  return { target: { kind: 'project' }, revision, text, bytes: new TextEncoder().encode(text).byteLength }
}

const charactersText = `${JSON.stringify({ characters: [{
  id: 'lin',
  name: '林澈',
  role: '调查者',
  summary: '追查旧案',
  goal: '找到真相',
  relationships: [],
  notes: '',
}] }, null, 2)}\n`

function targetController(
  readAsset: NovelWorkbenchPort['readAsset'],
  prompt: NovelWorkbenchPort['prompt'] = vi.fn(),
) {
  const controller = new NovelWorkbenchController({
    read: vi.fn().mockResolvedValue({
      status: 'ready',
      project: {
        projectId: PROJECT_ID, title: '潮汐来信', language: 'zh-CN', genre: '悬疑',
        plannedChapters: 20, targetWordsPerChapter: 3000, creativeStrategy: 'auto',
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
      progress: { selectedChapter: 1, plannedChapters: 20, status: 'unplanned', draftPresent: false, draftBytes: 0 },
      characters: [], storyBlueprint: null, chapterBlueprint: null, draft: null, omittedSources: [],
    }),
    readAsset,
    prompt,
  }, vi.fn(), undefined, () => '2026-08-16T01:02:03.000Z')
  controller.setTarget({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    agentPreset: 'ai-novel-writer',
    approval: 'ask',
  })
  return controller
}

function submittedProjectAttribution(controller: NovelWorkbenchController): NonNullable<NovelApplyOutcome['attribution']> {
  const state = controller.getSnapshot()
  if (state.status !== 'ready'
    || state.screen.kind !== 'project'
    || state.screen.replacement === undefined) throw new Error('missing submitted project replacement')
  return {
    kind: 'replace',
    targetKind: 'project',
    baseRevision: state.screen.baseRevision,
    replacement: state.screen.replacement,
  }
}

describe('novel workbench project and character editing', () => {
  it('drills into project settings, preserves immutable fields, and submits exact replacement text', async () => {
    const readAsset = vi.fn().mockResolvedValue(manifest('潮汐来信'))
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = targetController(readAsset, prompt)
    await controller.whenIdle()

    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '潮汐之后', creativeStrategy: 'consistency-first' })
    controller.updateAssetSummary('调整项目定位')
    controller.previewAssetChange()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'project',
        phase: 'preview',
        dirty: true,
        baseRevision: REVISION_A,
        replacement: expect.stringContaining('"title": "潮汐之后"'),
      },
    })
    const previewState = controller.getSnapshot()
    const screen = previewState.status === 'ready' ? previewState.screen : undefined
    if (screen?.kind !== 'project' || screen.replacement === undefined) throw new Error('missing project preview')
    expect(JSON.parse(screen.replacement)).toMatchObject({
      projectId: PROJECT_ID,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T01:02:03.000Z',
      title: '潮汐之后',
      creativeStrategy: 'consistency-first',
    })
    await controller.submitAssetChange()
    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt.mock.calls[0]?.[1]).toContain(JSON.stringify({
      kind: 'replace',
      targetKind: 'project',
      baseRevision: REVISION_A,
      baseText: manifest('潮汐来信').text,
      replacement: screen.replacement,
      summary: '调整项目定位',
    }, null, 2))
    controller.backToAssets()
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', screen: { kind: 'root' } })
  })

  it('searches, creates, edits, and deletes records while proposing the complete characters asset', async () => {
    const readAsset = vi.fn().mockResolvedValue({
      target: { kind: 'characters' }, revision: REVISION_A, text: charactersText,
      bytes: new TextEncoder().encode(charactersText).byteLength,
    })
    const controller = targetController(readAsset)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'characters' })

    controller.setCharacterSearch('林')
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'characters', visibleCharacterIds: ['lin'], selectedId: 'lin' },
    })
    controller.updateCharacter({ goal: '揭开潮汐站秘密', relationshipsText: 'new-id | 同盟 | 共同调查' })
    controller.createCharacter('new-id')
    controller.updateCharacter({
      name: '周遥', role: '记者', summary: '外地记者', goal: '追踪失踪案', notes: '谨慎',
    })
    controller.selectCharacter('lin')
    controller.deleteCharacter()
    controller.updateAssetSummary('调整人物设定')
    controller.previewAssetChange()

    const state = controller.getSnapshot()
    if (state.status !== 'ready' || state.screen.kind !== 'characters' || state.screen.replacement === undefined) {
      throw new Error('missing characters preview')
    }
    expect(JSON.parse(state.screen.replacement)).toEqual({ characters: [{
      id: 'new-id', name: '周遥', role: '记者', summary: '外地记者', goal: '追踪失踪案',
      relationships: [], notes: '谨慎',
    }] })
    expect(state.screen).toMatchObject({ phase: 'preview', dirty: true, selectedId: 'new-id' })
  })

  it('preserves a dirty unsent form and blocks submission when refresh discovers a stale revision', async () => {
    const readAsset = vi.fn()
      .mockResolvedValueOnce(manifest('潮汐来信', REVISION_A))
      .mockResolvedValueOnce(manifest('磁暴来信', REVISION_B))
    const prompt = vi.fn()
    const controller = targetController(readAsset, prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '本地未发送标题' })

    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'project', phase: 'stale', dirty: true, baseRevision: REVISION_A,
        latestRevision: REVISION_B, draft: { title: '本地未发送标题' },
      },
    })
    await controller.submitAssetChange()
    expect(prompt).not.toHaveBeenCalled()
    controller.reloadStaleAsset()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: { kind: 'project', phase: 'clean', dirty: false, baseRevision: REVISION_B, draft: { title: '磁暴来信' } },
    })
  })

  it('keeps the unsent editor after Session admission rejection and supports explicit discard', async () => {
    const readAsset = vi.fn().mockResolvedValue(manifest('潮汐来信'))
    const prompt = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'agent-busy', message: '当前会话正在运行' },
      })
      .mockResolvedValueOnce({ ok: true, value: { accepted: true } })
    const controller = targetController(readAsset, prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '尚未送出的标题' })
    controller.updateAssetSummary('调整标题')
    controller.previewAssetChange()

    await controller.submitAssetChange()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: { kind: 'project', phase: 'error', dirty: true, draft: { title: '尚未送出的标题' } },
    })
    controller.previewAssetChange()
    await controller.submitAssetChange()
    controller.novelApplySettled({
      isError: true,
      code: 'APPROVAL_REJECTED',
      attribution: submittedProjectAttribution(controller),
    })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'project', phase: 'error', dirty: true,
        message: 'Harness 原生审批已拒绝；磁盘未改变，当前修改仍保留。',
      },
    })
    controller.discardAssetChanges()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: { kind: 'project', phase: 'clean', dirty: false, draft: { title: '潮汐来信' } },
    })
  })

  it('retains unsent fields through connection loss and rejects a mismatched Host asset', async () => {
    const readAsset = vi.fn()
      .mockResolvedValueOnce(manifest('潮汐来信'))
      .mockResolvedValueOnce({
        target: { kind: 'characters' }, revision: REVISION_A, text: charactersText,
        bytes: new TextEncoder().encode(charactersText).byteLength,
      })
    const controller = targetController(readAsset)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '断线保留标题' })

    controller.disconnected()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      readFeedback: { kind: 'disconnected' },
      screen: { kind: 'project', phase: 'error', dirty: true, draft: { title: '断线保留标题' } },
    })
    await controller.openAsset({ kind: 'project' })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'asset-error', message: 'Host returned a different novel asset' },
    })
  })

  it('does not mistake an unrelated concurrent write for the approved submitted replacement', async () => {
    const readAsset = vi.fn()
      .mockResolvedValueOnce(manifest('潮汐来信', REVISION_A))
      .mockResolvedValueOnce(manifest('其他会话标题', REVISION_B))
    const controller = targetController(
      readAsset,
      vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    )
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '本地提交标题' })
    controller.updateAssetSummary('调整标题')
    controller.previewAssetChange()
    await controller.submitAssetChange()

    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'project', phase: 'stale', dirty: true, latestRevision: REVISION_B,
        draft: { title: '本地提交标题' },
        message: '资产已被其他修改更新，内容与已提交提案不一致。提案仍保留，请核对后重新载入。',
      },
    })
  })

  it('keeps an indeterminate prompt locked through disconnect until its admission result settles', async () => {
    let finish: ((result: Awaited<ReturnType<NovelWorkbenchPort['prompt']>>) => void) | undefined
    const prompt: NovelWorkbenchPort['prompt'] = vi.fn(() => new Promise<
      Awaited<ReturnType<NovelWorkbenchPort['prompt']>>
    >(resolve => { finish = resolve }))
    const controller = targetController(vi.fn().mockResolvedValue(manifest('潮汐来信')), prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '只提交一次' })
    controller.updateAssetSummary('调整标题')
    controller.previewAssetChange()
    const submitting = controller.submitAssetChange()
    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })

    controller.disconnected()
    controller.updateProjectSettings({ title: '不得解锁' })
    controller.previewAssetChange()
    await controller.submitAssetChange()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'project', phase: 'submitting', draft: { title: '只提交一次' },
        message: 'Harness 连接已断开；提案是否已进入会话尚未确定，结果返回前不能重试。',
      },
    })
    expect(prompt).toHaveBeenCalledOnce()

    finish?.({ ok: true, value: { accepted: true } })
    await submitting
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'project', phase: 'submitted' },
    })
  })

  it('does not let a refresh race overwrite an in-flight proposal outcome', async () => {
    let finish: ((result: Awaited<ReturnType<NovelWorkbenchPort['prompt']>>) => void) | undefined
    const prompt: NovelWorkbenchPort['prompt'] = vi.fn(() => new Promise<
      Awaited<ReturnType<NovelWorkbenchPort['prompt']>>
    >(resolve => { finish = resolve }))
    const readAsset = vi.fn()
      .mockResolvedValueOnce(manifest('潮汐来信', REVISION_A))
      .mockResolvedValueOnce(manifest('外部修改', REVISION_B))
    const controller = targetController(readAsset, prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '待审批标题' })
    controller.updateAssetSummary('调整标题')
    controller.previewAssetChange()
    const submitting = controller.submitAssetChange()
    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })

    await controller.refresh()
    expect(readAsset).toHaveBeenCalledOnce()
    finish?.({ ok: true, value: { accepted: true } })
    await submitting

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'project', phase: 'submitted', draft: { title: '待审批标题' } },
    })
  })

  it('ignores an unrelated apply error while the current proposal remains queued', async () => {
    const controller = targetController(
      vi.fn().mockResolvedValue(manifest('潮汐来信')),
      vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    )
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '当前提案' })
    controller.updateAssetSummary('调整标题')
    controller.previewAssetChange()
    await controller.submitAssetChange()

    controller.novelApplySettled({
      isError: true,
      code: 'APPROVAL_REJECTED',
      attribution: {
        kind: 'replace',
        targetKind: 'project',
        baseRevision: REVISION_A,
        replacement: `${manifest('潮汐来信').text}unrelated`,
      },
    })

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: { kind: 'project', phase: 'submitted', draft: { title: '当前提案' } },
    })
  })

  it('locks an explicitly stale proposal even when the authoritative reread fails', async () => {
    const readAsset = vi.fn()
      .mockResolvedValueOnce(manifest('潮汐来信'))
      .mockRejectedValueOnce(new Error('temporary read failure'))
    const controller = targetController(
      readAsset,
      vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    )
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '过期提案' })
    controller.updateAssetSummary('调整标题')
    controller.previewAssetChange()
    await controller.submitAssetChange()

    controller.novelApplySettled({
      isError: true,
      code: 'STALE_REVISION',
      attribution: submittedProjectAttribution(controller),
    })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'project', phase: 'stale', dirty: true },
    })

    controller.reloadStaleAsset()
    await controller.whenIdle()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'project',
        phase: 'stale',
        dirty: true,
        draft: { title: '过期提案' },
        message: '提交使用的 revision 已过期；重新读取失败：temporary read failure',
      },
    })
  })

  it('reloads an explicitly stale proposal with one authoritative read and one click', async () => {
    const readAsset = vi.fn()
      .mockResolvedValueOnce(manifest('潮汐来信', REVISION_A))
      .mockResolvedValueOnce(manifest('外部最新标题', REVISION_B))
    const controller = targetController(
      readAsset,
      vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    )
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '过期提案' })
    controller.updateAssetSummary('调整标题')
    controller.previewAssetChange()
    await controller.submitAssetChange()
    controller.novelApplySettled({
      isError: true,
      code: 'STALE_REVISION',
      attribution: submittedProjectAttribution(controller),
    })

    controller.reloadStaleAsset()
    await controller.whenIdle()

    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'project',
        phase: 'clean',
        dirty: false,
        baseRevision: REVISION_B,
        draft: { title: '外部最新标题' },
      },
      readFeedback: { kind: 'success', message: '重新载入完成：已载入最新资产 revision。' },
    })
  })
})
