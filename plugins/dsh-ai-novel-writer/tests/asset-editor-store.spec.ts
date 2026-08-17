import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  NovelWorkbenchController,
  type NovelApplyOutcome,
  type NovelWorkbenchPort,
} from '../src/client/workbench-store.ts'
import type { NovelWorkbenchEditableTarget } from '../src/client/asset-editor.ts'
import type { NovelAssetReadWireResult } from '../src/context-types.ts'
import type { NovelProjectId, Revision } from '../src/types.ts'

const WORKSPACE_ID = WorkspaceId('workspace-a')
const SESSION_ID = SessionId('session-a')
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId
const REVISION_A = 'a'.repeat(64) as Revision
const REVISION_B = 'b'.repeat(64) as Revision

interface ApprovedGenerationCase {
  readonly label: string
  readonly target: NovelWorkbenchEditableTarget
  readonly initial: NovelAssetReadWireResult
  readonly final: NovelAssetReadWireResult
  readonly visible: Record<string, unknown>
}

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
  approval: 'ask' | 'never' | 'unknown' = 'ask',
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
    approval,
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

describe('novel workbench asset editing', () => {
  it.each([
    [{ kind: 'project' } as const, manifest('潮汐来信'), '项目设置', 'formatVersion'],
    [{ kind: 'characters' } as const, {
      target: { kind: 'characters' } as const, revision: REVISION_A, text: charactersText,
      bytes: new TextEncoder().encode(charactersText).byteLength,
    }, '人物设定', 'characters'],
    [{ kind: 'story-blueprint' } as const, {
      target: { kind: 'story-blueprint' } as const, revision: 'absent' as const, text: '', bytes: 0,
    }, '故事蓝图', 'premise'],
    [{ kind: 'chapter-blueprint', chapter: 2 } as const, {
      target: { kind: 'chapter-blueprint', chapter: 2 } as const, revision: 'absent' as const, text: '', bytes: 0,
    }, '第 2 章蓝图', 'beats'],
    [{ kind: 'chapter-draft', chapter: 2 } as const, {
      target: { kind: 'chapter-draft', chapter: 2 } as const, revision: 'absent' as const, text: '', bytes: 0,
    }, '第 2 章正文', 'Markdown'],
  ])('asks the selected model to generate only the current revisioned %s asset', async (
    target,
    asset,
    label,
    schemaEvidence,
  ) => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = targetController(vi.fn().mockResolvedValue(asset), prompt)
    await controller.whenIdle()
    await controller.openAsset(target)

    await controller.generateAsset()

    expect(prompt).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenCalledWith(SESSION_ID, expect.stringContaining(`生成并提议更新“${label}”`))
    const submittedPrompt = String(prompt.mock.calls[0]?.[1])
    expect(submittedPrompt).toContain('恰好调用一次 novel_read')
    expect(submittedPrompt).toContain('恰好调用一次 novel_apply_change')
    expect(submittedPrompt).toContain('Harness 原生审批')
    expect(submittedPrompt).toContain('没有额外补充要求')
    expect(submittedPrompt).toContain(`"targetKind": "${target.kind}"`)
    expect(submittedPrompt).toContain(`编辑器读取时的 revision：${asset.revision}`)
    expect(submittedPrompt).toContain(`"baseRevision": ${JSON.stringify(asset.revision)}`)
    expect(submittedPrompt).not.toContain('"baseText"')
    expect(submittedPrompt).toContain('SHA-256 revision 是唯一的并发检查值')
    expect(submittedPrompt).toContain(schemaEvidence)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        ...target,
        dirty: false,
        generation: {
          brief: '',
          phase: 'submitted',
          message: '生成请求已发送；等待模型提案与 Harness 原生审批。',
        },
      },
    })

  })

  it('uses a dirty local draft as generation guidance without requiring a separate manual proposal', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = targetController(vi.fn().mockResolvedValue(manifest('潮汐来信')), prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '仍需保留的本地标题' })
    controller.updateAssetGenerationBrief('改成玄幻小说')

    await controller.generateAsset()

    expect(prompt).toHaveBeenCalledOnce()
    expect(String(prompt.mock.calls[0]?.[1])).toContain('仍需保留的本地标题')
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'project', dirty: true, draft: { title: '仍需保留的本地标题' },
        generation: {
          brief: '改成玄幻小说',
          phase: 'submitted',
        },
      },
    })

  })

  it('requires a visible project-settings change and treats CommitReceipt as completed approval', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = targetController(vi.fn().mockResolvedValue(manifest('潮汐来信')), prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })

    await controller.generateAsset()

    const submittedPrompt = String(prompt.mock.calls[0]?.[1])
    expect(submittedPrompt).toContain('至少修改一个用户可见的项目设置字段')
    expect(submittedPrompt).toContain('只修改 updatedAt 是无效生成')
    expect(submittedPrompt).toContain('收到 CommitReceipt 说明原生审批已经完成')
    expect(submittedPrompt).toContain('不得再说“等待审批”')
  })

  it('projects dirty character guidance with domain fields instead of editor-only names', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const asset: NovelAssetReadWireResult = {
      target: { kind: 'characters' }, revision: REVISION_A, text: charactersText,
      bytes: new TextEncoder().encode(charactersText).byteLength,
    }
    const controller = targetController(vi.fn().mockResolvedValue(asset), prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'characters' })
    controller.updateCharacter({ relationshipsText: 'zhou | ally | 共同追查旧案' })

    await controller.generateAsset()

    const submittedPrompt = String(prompt.mock.calls[0]?.[1])
    expect(submittedPrompt).toContain('"relationships": "zhou | ally | 共同追查旧案"')
    expect(submittedPrompt).not.toContain('relationshipsText')
  })

  it('generates an asset from current context when the optional brief is empty', async () => {
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = targetController(vi.fn().mockResolvedValue(manifest('潮汐来信')), prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })

    await controller.generateAsset()

    expect(prompt).toHaveBeenCalledOnce()
    expect(String(prompt.mock.calls[0]?.[1])).toContain('没有额外补充要求')
  })

  it.each([
    ['never' as const, '当前会话已关闭原生审批，请将权限切换为“工作区写入”后再提交。'],
    ['unknown' as const, '无法确认当前会话的审批策略，请切换到“工作区写入”后再提交。'],
  ])('does not ask the model to generate when native approval is %s', async (approval, message) => {
    const prompt = vi.fn()
    const controller = targetController(vi.fn().mockResolvedValue(manifest('潮汐来信')), prompt, approval)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateAssetGenerationBrief('改成玄幻小说')

    await controller.generateAsset()

    expect(prompt).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: { kind: 'project', generation: { phase: 'error', message } },
    })
  })

  it('locks the editor and refuses duplicate generation while Session admission is unresolved', async () => {
    let finish: ((result: Awaited<ReturnType<NovelWorkbenchPort['prompt']>>) => void) | undefined
    const prompt: NovelWorkbenchPort['prompt'] = vi.fn(() => new Promise<
      Awaited<ReturnType<NovelWorkbenchPort['prompt']>>
    >(resolve => { finish = resolve }))
    const controller = targetController(vi.fn().mockResolvedValue(manifest('潮汐来信')), prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateAssetGenerationBrief('生成玄幻项目设定')

    const first = controller.generateAsset()
    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })
    controller.updateProjectSettings({ title: '不得写入的并发草稿' })
    await controller.generateAsset()

    expect(prompt).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: { kind: 'project', draft: { title: '潮汐来信' }, generation: { phase: 'submitting' } },
    })
    finish?.({ ok: true, value: { accepted: true } })
    await first
  })

  it('reconciles when the durable generation turn ends before prompt admission returns', async () => {
    let finish: ((result: Awaited<ReturnType<NovelWorkbenchPort['prompt']>>) => void) | undefined
    const prompt: NovelWorkbenchPort['prompt'] = vi.fn(() => new Promise<
      Awaited<ReturnType<NovelWorkbenchPort['prompt']>>
    >(resolve => { finish = resolve }))
    const readAsset = vi.fn().mockResolvedValue(manifest('潮汐来信'))
    const controller = targetController(readAsset, prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateAssetGenerationBrief('生成玄幻项目设定')

    const generating = controller.generateAsset()
    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })
    controller.generationTurnSettled()
    finish?.({ ok: true, value: { accepted: true } })
    await generating

    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'project', generation: { phase: 'error', message: expect.stringContaining('未产生可归因的修改') } },
    })
  })

  it('requires authoritative reread after a completed turn has no attributable apply', async () => {
    const readAsset = vi.fn().mockResolvedValue(manifest('潮汐来信'))
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = targetController(readAsset, prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateAssetGenerationBrief('改成玄幻项目')
    await controller.generateAsset()

    controller.novelApplySettled({ isError: true, code: 'INVALID_ARGUMENTS', attribution: undefined })
    controller.generationTurnSettled()
    await controller.generateAsset()
    expect(prompt).toHaveBeenCalledOnce()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'project', generation: { phase: 'reconciling' } },
    })

    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: { kind: 'project', generation: { phase: 'error', message: expect.stringContaining('未产生可归因的修改') } },
    })
  })

  it('recognizes an approved model generation by its CommitReceipt revision after Host canonicalization', async () => {
    const generated = {
      premise: '林凡追查父亲失踪。',
      themes: ['选择'],
      world: '青石山连接修行界。',
      mainPlot: '木牌引向问道碑。',
      endingGoal: '林凡理解力量的代价。',
    }
    const canonical = `${JSON.stringify(generated, null, 2)}\n`
    const readAsset = vi.fn()
      .mockResolvedValueOnce({ target: { kind: 'story-blueprint' }, revision: 'absent', text: '', bytes: 0 })
      .mockResolvedValueOnce({
        target: { kind: 'story-blueprint' }, revision: REVISION_B, text: canonical,
        bytes: new TextEncoder().encode(canonical).byteLength,
      })
    const controller = targetController(
      readAsset,
      vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    )
    await controller.whenIdle()
    await controller.openAsset({ kind: 'story-blueprint' })
    controller.updateAssetGenerationBrief('生成故事蓝图')
    await controller.generateAsset()

    controller.novelApplySettled({
      isError: false,
      code: undefined,
      newRevision: REVISION_B,
      attribution: {
        kind: 'replace', targetKind: 'story-blueprint', baseRevision: 'absent',
        replacement: JSON.stringify(generated),
      },
    })
    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'story-blueprint', phase: 'clean', baseRevision: REVISION_B,
        draft: { premise: generated.premise },
        generation: {
          phase: 'applied',
          message: `模型生成已批准并载入 revision ${REVISION_B.slice(0, 12)}；上方字段是磁盘中的最终内容。`,
        },
      },
      readFeedback: {
        kind: 'success',
        message: `模型生成已批准并载入 revision ${REVISION_B.slice(0, 12)}；上方字段是磁盘中的最终内容。`,
      },
    })

    controller.updateStoryBlueprint({ premise: '用户随后继续修改。' })

    const edited = controller.getSnapshot()
    if (edited.status !== 'ready' || edited.screen.kind !== 'story-blueprint') {
      throw new Error('story editor was not retained after the local edit')
    }
    expect(edited.screen).toMatchObject({
      dirty: true,
      draft: { premise: '用户随后继续修改。' },
    })
    expect(edited.screen.generation).toEqual({ brief: '生成故事蓝图', phase: 'editing' })
  })

  it('does not reuse an applied revision to certify a later generation that produced no tool call', async () => {
    const generated = {
      premise: '林凡追查父亲失踪。', themes: ['选择'], world: '青石山。',
      mainPlot: '木牌引向问道碑。', endingGoal: '理解力量的代价。',
    }
    const canonical = `${JSON.stringify(generated, null, 2)}\n`
    const readAsset = vi.fn()
      .mockResolvedValueOnce({ target: { kind: 'story-blueprint' }, revision: 'absent', text: '', bytes: 0 })
      .mockResolvedValue({
        target: { kind: 'story-blueprint' }, revision: REVISION_B, text: canonical,
        bytes: new TextEncoder().encode(canonical).byteLength,
      })
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = targetController(readAsset, prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'story-blueprint' })

    await controller.generateAsset()
    controller.novelApplySettled({
      isError: false,
      code: undefined,
      newRevision: REVISION_B,
      attribution: {
        kind: 'replace', targetKind: 'story-blueprint', baseRevision: 'absent',
        replacement: canonical,
      },
    })
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'story-blueprint', generation: { phase: 'applied' } },
    })

    await controller.generateAsset()
    controller.generationTurnSettled()
    await controller.refresh()

    expect(prompt).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'story-blueprint',
        generation: { phase: 'error', message: expect.stringContaining('未产生可归因的修改') },
      },
    })
  })

  it.each((() => {
    const finalCharacters = `${JSON.stringify({ characters: [{
      id: 'lin', name: '林晚', role: '主角', summary: '追查旧案', goal: '找到真相', relationships: [], notes: '',
    }] }, null, 2)}\n`
    const finalStory = `${JSON.stringify({
      premise: '青铜铃指向雾海。', themes: ['选择'], world: '海港城。',
      mainPlot: '追查潮汐站。', endingGoal: '公开真相。',
    }, null, 2)}\n`
    const finalBlueprint = `${JSON.stringify({
      chapter: 2, title: '雾海铃声', purpose: '建立线索', beats: ['听见铃声'],
      characterIds: ['lin'], continuityNotes: ['青铜铃首次出现'], status: 'planned',
    }, null, 2)}\n`
    const finalDraft = '# 第二章 雾海铃声\n\n青铜铃在雾中响起。\n'
    const wire = (
      target: NovelWorkbenchEditableTarget,
      revision: Revision,
      text: string,
    ): NovelAssetReadWireResult => ({
      target, revision, text, bytes: new TextEncoder().encode(text).byteLength,
    })
    return [
      {
        label: '项目设置', target: { kind: 'project' },
        initial: manifest('潮汐来信'), final: manifest('雾海问道', REVISION_B),
        visible: { kind: 'project', draft: { title: '雾海问道' } },
      },
      {
        label: '人物设定', target: { kind: 'characters' },
        initial: wire({ kind: 'characters' }, REVISION_A, charactersText),
        final: wire({ kind: 'characters' }, REVISION_B, finalCharacters),
        visible: { kind: 'characters', characters: [{ name: '林晚' }] },
      },
      {
        label: '故事蓝图', target: { kind: 'story-blueprint' },
        initial: wire({ kind: 'story-blueprint' }, 'absent', ''),
        final: wire({ kind: 'story-blueprint' }, REVISION_B, finalStory),
        visible: { kind: 'story-blueprint', draft: { premise: '青铜铃指向雾海。' } },
      },
      {
        label: '章节蓝图', target: { kind: 'chapter-blueprint', chapter: 2 },
        initial: wire({ kind: 'chapter-blueprint', chapter: 2 }, 'absent', ''),
        final: wire({ kind: 'chapter-blueprint', chapter: 2 }, REVISION_B, finalBlueprint),
        visible: { kind: 'chapter-blueprint', chapter: 2, draft: { title: '雾海铃声' } },
      },
      {
        label: '章节正文', target: { kind: 'chapter-draft', chapter: 2 },
        initial: wire({ kind: 'chapter-draft', chapter: 2 }, 'absent', ''),
        final: wire({ kind: 'chapter-draft', chapter: 2 }, REVISION_B, finalDraft),
        visible: { kind: 'chapter-draft', chapter: 2, text: finalDraft },
      },
    ] satisfies readonly ApprovedGenerationCase[]
  })())('loads the approved $label generation into its visible editor fields', async ({ target, initial, final, visible }) => {
    const readAsset = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(final)
    const controller = targetController(
      readAsset,
      vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    )
    await controller.whenIdle()
    await controller.openAsset(target)
    await controller.generateAsset()
    controller.novelApplySettled({
      isError: false,
      code: undefined,
      newRevision: final.revision,
      attribution: {
        kind: 'replace',
        targetKind: target.kind,
        ...('chapter' in target ? { chapter: target.chapter } : {}),
        baseRevision: initial.revision,
        replacement: final.text,
      },
    })

    await controller.refresh()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        ...visible,
        baseRevision: final.revision,
        generation: { phase: 'applied', message: expect.stringContaining('上方字段是磁盘中的最终内容') },
      },
    })
  })

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
      replacement: screen.replacement,
      summary: '调整项目定位',
    }, null, 2))
    controller.backToAssets()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'project', phase: 'submitted', draft: { title: '潮汐之后' } },
    })
  })

  it('requires explicit discard before leaving an editor with unsaved text', async () => {
    const controller = targetController(vi.fn().mockResolvedValue(manifest('潮汐来信')))
    await controller.whenIdle()
    await controller.openAsset({ kind: 'project' })
    controller.updateProjectSettings({ title: '仍需保留' })

    controller.backToAssets()

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'project', phase: 'editing', dirty: true, draft: { title: '仍需保留' } },
    })
    controller.discardAssetChanges()
    controller.backToAssets()
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', screen: { kind: 'root' } })
  })

  it('searches, creates, edits, and deletes records while proposing the complete characters asset', async () => {
    const generatedId = '123e4567-e89b-42d3-a456-426614174222'
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(generatedId)
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
    controller.updateCharacter({ goal: '揭开潮汐站秘密', relationshipsText: `${generatedId} | 同盟 | 共同调查` })
    controller.createCharacter()
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
      id: generatedId, name: '周遥', role: '记者', summary: '外地记者', goal: '追踪失踪案',
      relationships: [], notes: '谨慎',
    }] })
    expect(state.screen).toMatchObject({ phase: 'preview', dirty: true, selectedId: generatedId })
  })

  it('round-trips an absent story blueprint through one canonical replacement proposal', async () => {
    const readAsset = vi.fn().mockResolvedValue({
      target: { kind: 'story-blueprint' }, revision: 'absent', text: '', bytes: 0,
    })
    const controller = targetController(readAsset)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'story-blueprint' })

    controller.updateStoryBlueprint({
      premise: '退潮后，失踪者的信件逐封出现。',
      themesText: '记忆\n责任',
      world: '近未来海港城',
      mainPlot: '记者与调查员追查潮汐站旧案。',
      endingGoal: '两人公开真相并阻止下一次事故。',
    })
    controller.updateAssetSummary('建立故事蓝图')
    controller.previewAssetChange()

    const state = controller.getSnapshot()
    if (state.status !== 'ready' || state.screen.kind !== 'story-blueprint') {
      throw new Error('missing story blueprint editor')
    }
    expect(state.screen).toMatchObject({ phase: 'preview', dirty: true, baseRevision: 'absent' })
    expect(state.screen.replacement).toBe(`${JSON.stringify({
      premise: '退潮后，失踪者的信件逐封出现。',
      themes: ['记忆', '责任'],
      world: '近未来海港城',
      mainPlot: '记者与调查员追查潮汐站旧案。',
      endingGoal: '两人公开真相并阻止下一次事故。',
    }, null, 2)}\n`)
  })

  it('binds an absent chapter blueprint to the selected chapter and canonical fields', async () => {
    const readAsset = vi.fn().mockResolvedValue({
      target: { kind: 'chapter-blueprint', chapter: 2 }, revision: 'absent', text: '', bytes: 0,
    })
    const controller = targetController(readAsset)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'chapter-blueprint', chapter: 2 })

    controller.updateChapterBlueprint({
      title: '潮汐站',
      purpose: '让两位调查者第一次交换证据。',
      beatsText: '抵达废弃站\n发现录音\n意见冲突',
      characterIdsText: 'lin\nzhou',
      continuityNotesText: '林澈仍隐瞒旧案关系',
      status: 'planned',
    })
    controller.updateAssetSummary('建立第二章蓝图')
    controller.previewAssetChange()

    const state = controller.getSnapshot()
    if (state.status !== 'ready' || state.screen.kind !== 'chapter-blueprint') {
      throw new Error('missing chapter blueprint editor')
    }
    expect(state.screen.replacement).toBe(`${JSON.stringify({
      chapter: 2,
      title: '潮汐站',
      purpose: '让两位调查者第一次交换证据。',
      beats: ['抵达废弃站', '发现录音', '意见冲突'],
      characterIds: ['lin', 'zhou'],
      continuityNotes: ['林澈仍隐瞒旧案关系'],
      status: 'planned',
    }, null, 2)}\n`)
  })

  it('edits an absent Markdown draft with normalized newlines and chapter attribution', async () => {
    const readAsset = vi.fn().mockResolvedValue({
      target: { kind: 'chapter-draft', chapter: 2 }, revision: 'absent', text: '', bytes: 0,
    })
    const prompt = vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } })
    const controller = targetController(readAsset, prompt)
    await controller.whenIdle()
    await controller.openAsset({ kind: 'chapter-draft', chapter: 2 })

    controller.updateChapterDraft('# 第二章\r\n\r\n潮水退去。')
    controller.updateAssetSummary('起草第二章正文')
    controller.previewAssetChange()
    await controller.submitAssetChange()

    const state = controller.getSnapshot()
    expect(state).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'chapter-draft', chapter: 2, phase: 'submitted', dirty: true,
        replacement: '# 第二章\n\n潮水退去。',
      },
    })
    expect(prompt.mock.calls[0]?.[1]).toContain(JSON.stringify({
      kind: 'replace',
      targetKind: 'chapter-draft',
      chapter: 2,
      baseRevision: 'absent',
      replacement: '# 第二章\n\n潮水退去。',
      summary: '起草第二章正文',
    }, null, 2))
  })

  it('rejects a same-kind response for a different chapter without loading it', async () => {
    const text = '# 第二章\n\n错误章节。\n'
    const readAsset = vi.fn().mockResolvedValue({
      target: { kind: 'chapter-draft', chapter: 2 }, revision: REVISION_A, text,
      bytes: new TextEncoder().encode(text).byteLength,
    })
    const controller = targetController(readAsset)
    await controller.whenIdle()

    await controller.openAsset({ kind: 'chapter-draft', chapter: 1 })

    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready',
      screen: {
        kind: 'asset-error',
        target: { kind: 'chapter-draft', chapter: 1 },
        message: 'Host returned a different novel asset',
      },
    })
  })

  it('attributes chapter-draft rejection to the exact chapter and retains the draft for discard', async () => {
    const text = '# 第二章\n\n旧稿。'
    const readAsset = vi.fn().mockResolvedValue({
      target: { kind: 'chapter-draft', chapter: 2 }, revision: REVISION_A, text,
      bytes: new TextEncoder().encode(text).byteLength,
    })
    const controller = targetController(
      readAsset,
      vi.fn().mockResolvedValue({ ok: true, value: { accepted: true } }),
    )
    await controller.whenIdle()
    await controller.openAsset({ kind: 'chapter-draft', chapter: 2 })
    controller.updateChapterDraft('# 第二章\n\n新稿。')
    controller.updateAssetSummary('改写第二章')
    controller.previewAssetChange()
    await controller.submitAssetChange()
    const submitted = controller.getSnapshot()
    if (submitted.status !== 'ready'
      || submitted.screen.kind !== 'chapter-draft'
      || submitted.screen.replacement === undefined) throw new Error('missing submitted chapter draft')

    controller.novelApplySettled({
      isError: true,
      code: 'APPROVAL_REJECTED',
      attribution: {
        kind: 'replace', targetKind: 'chapter-draft', chapter: 1,
        baseRevision: REVISION_A, replacement: submitted.screen.replacement,
      },
    })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'chapter-draft', chapter: 2, phase: 'submitted' },
    })

    controller.novelApplySettled({
      isError: true,
      code: 'APPROVAL_REJECTED',
      attribution: {
        kind: 'replace', targetKind: 'chapter-draft', chapter: 2,
        baseRevision: REVISION_A, replacement: submitted.screen.replacement,
      },
    })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'chapter-draft', chapter: 2, phase: 'error', text: '# 第二章\n\n新稿。' },
    })
    controller.discardAssetChanges()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'ready', screen: { kind: 'chapter-draft', chapter: 2, phase: 'clean', text },
    })
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
