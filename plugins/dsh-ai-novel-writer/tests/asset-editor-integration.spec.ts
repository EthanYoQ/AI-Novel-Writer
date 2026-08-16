/** Revisioned workbench proposal integration against the real NovelProject module. */

import { rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { NovelWorkbenchController, type NovelPromptResult } from '../src/client/workbench-store.ts'
import { readNovelAsset, readNovelContext } from '../src/context-window.ts'
import { openNovelProject } from '../src/novel-project.ts'
import type { NovelApplyRequest, NovelProjectId, Revision } from '../src/types.ts'
import { makeTestWorkspace } from './test-workspace.ts'

const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000' as NovelProjectId

function proposalFromPrompt(text: string): NovelApplyRequest {
  const start = text.indexOf('{\n')
  const end = text.indexOf('\n\n这只是提案。', start)
  if (start < 0 || end < 0) throw new Error('proposal prompt did not contain its shallow JSON object')
  const value = JSON.parse(text.slice(start, end)) as Record<string, unknown>
  if (value.kind !== 'replace'
    || !['project', 'characters', 'story-blueprint', 'chapter-blueprint', 'chapter-draft'].includes(String(value.targetKind))
    || typeof value.baseRevision !== 'string'
    || typeof value.baseText !== 'string'
    || typeof value.replacement !== 'string'
    || typeof value.summary !== 'string') throw new Error('proposal prompt contained invalid tool arguments')
  const targetKind = value.targetKind as 'project' | 'characters' | 'story-blueprint' | 'chapter-blueprint' | 'chapter-draft'
  const target = targetKind === 'chapter-blueprint' || targetKind === 'chapter-draft'
    ? { kind: targetKind, chapter: Number(value.chapter) }
    : { kind: targetKind }
  return {
    kind: 'replace',
    target,
    baseRevision: value.baseRevision as Revision,
    baseText: value.baseText,
    replacement: value.replacement,
    summary: value.summary,
  }
}

describe('revisioned workbench proposal integration', () => {
  it('keeps disk unchanged before approval and rereads the committed revision after one apply', async () => {
    const root = await makeTestWorkspace('asset-editor-integration-')
    try {
      const project = openNovelProject(root)
      await project.apply({
        kind: 'initialize',
        projectId: PROJECT_ID,
        title: '潮汐来信',
        language: 'zh-CN',
        genre: '悬疑',
        plannedChapters: 20,
        targetWordsPerChapter: 3000,
        creativeStrategy: 'auto',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      }, new AbortController().signal)
      let proposed: NovelApplyRequest | undefined
      const controller = new NovelWorkbenchController({
        read: (_workspaceId, chapter, signal) => readNovelContext(root, chapter, signal),
        readAsset: (_workspaceId, target, signal) => readNovelAsset(root, target, signal),
        prompt: vi.fn(async (_sessionId, text): Promise<NovelPromptResult> => {
          proposed = proposalFromPrompt(text)
          return { ok: true, value: { accepted: true } }
        }),
      }, vi.fn(), undefined, () => '2026-08-16T01:02:03.000Z')
      controller.setTarget({
        workspaceId: WorkspaceId('workspace-a'),
        sessionId: SessionId('session-a'),
        agentPreset: 'ai-novel-writer',
        approval: 'ask',
      })
      await controller.whenIdle()
      await controller.openAsset({ kind: 'project' })
      const before = await readNovelAsset(root, { kind: 'project' }, new AbortController().signal)
      controller.updateProjectSettings({ title: '潮汐之后' })
      controller.updateAssetSummary('调整项目标题')
      controller.previewAssetChange()

      await controller.submitAssetChange()

      expect(await readNovelAsset(root, { kind: 'project' }, new AbortController().signal)).toEqual(before)
      expect(controller.getSnapshot()).toMatchObject({
        status: 'ready', screen: { kind: 'project', phase: 'submitted', dirty: true },
      })
      if (proposed === undefined) throw new Error('Session did not receive a proposal')
      const receipt = await project.apply(proposed, new AbortController().signal)
      expect(receipt.oldRevision).toBe(before.revision)

      await controller.refresh()

      expect(controller.getSnapshot()).toMatchObject({
        status: 'ready',
        project: { title: '潮汐之后', updatedAt: '2026-08-16T01:02:03.000Z' },
        screen: {
          kind: 'project', phase: 'clean', dirty: false,
          baseRevision: receipt.newRevision, draft: { title: '潮汐之后' },
        },
      })
      await controller.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('commits and rereads story, selected-chapter blueprint, and Markdown through the same approval seam', async () => {
    const root = await makeTestWorkspace('complete-editor-integration-')
    try {
      const project = openNovelProject(root)
      await project.apply({
        kind: 'initialize', projectId: PROJECT_ID, title: '潮汐来信', language: 'zh-CN', genre: '悬疑',
        plannedChapters: 3, targetWordsPerChapter: 3000, creativeStrategy: 'auto',
        createdAt: '2026-08-16T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
      }, new AbortController().signal)
      let proposed: NovelApplyRequest | undefined
      const controller = new NovelWorkbenchController({
        read: (_workspaceId, chapter, signal) => readNovelContext(root, chapter, signal),
        readAsset: (_workspaceId, target, signal) => readNovelAsset(root, target, signal),
        prompt: vi.fn(async (_sessionId, text): Promise<NovelPromptResult> => {
          proposed = proposalFromPrompt(text)
          return { ok: true, value: { accepted: true } }
        }),
      }, vi.fn())
      controller.setTarget({
        workspaceId: WorkspaceId('workspace-a'), sessionId: SessionId('session-a'),
        agentPreset: 'ai-novel-writer', approval: 'ask',
      })
      await controller.whenIdle()

      await controller.openAsset({ kind: 'story-blueprint' })
      controller.updateStoryBlueprint({
        premise: '退潮后出现失踪者的信件。', themesText: '记忆\n责任', world: '近未来海港城',
        mainPlot: '调查潮汐站旧案。', endingGoal: '公开真相。',
      })
      controller.updateAssetSummary('建立故事蓝图')
      controller.previewAssetChange()
      await controller.submitAssetChange()
      if (proposed === undefined) throw new Error('story proposal was not queued')
      const storyReceipt = await project.apply(proposed, new AbortController().signal)
      await controller.refresh()
      expect(controller.getSnapshot()).toMatchObject({
        status: 'ready', screen: { kind: 'story-blueprint', phase: 'clean', baseRevision: storyReceipt.newRevision },
      })

      controller.backToAssets()
      await controller.openAsset({ kind: 'chapter-blueprint', chapter: 2 })
      controller.updateChapterBlueprint({
        title: '潮汐站', purpose: '交换证据', beatsText: '抵达\n发现录音',
        characterIdsText: 'lin\nzhou', continuityNotesText: '旧案仍未公开', status: 'planned',
      })
      controller.updateAssetSummary('建立第二章蓝图')
      controller.previewAssetChange()
      await controller.submitAssetChange()
      if (proposed === undefined) throw new Error('chapter blueprint proposal was not queued')
      const blueprintReceipt = await project.apply(proposed, new AbortController().signal)
      await controller.refresh()
      expect(controller.getSnapshot()).toMatchObject({
        status: 'ready',
        progress: { selectedChapter: 2, status: 'planned' },
        screen: { kind: 'chapter-blueprint', chapter: 2, phase: 'clean', baseRevision: blueprintReceipt.newRevision },
      })

      controller.backToAssets()
      await controller.openAsset({ kind: 'chapter-draft', chapter: 2 })
      controller.updateChapterDraft('# 第二章\n\n潮水退去。')
      controller.updateAssetSummary('起草第二章')
      controller.previewAssetChange()
      await controller.submitAssetChange()
      if (proposed === undefined) throw new Error('chapter draft proposal was not queued')
      const draftReceipt = await project.apply(proposed, new AbortController().signal)
      await controller.refresh()
      expect(controller.getSnapshot()).toMatchObject({
        status: 'ready',
        progress: { selectedChapter: 2, draftPresent: true },
        screen: {
          kind: 'chapter-draft', chapter: 2, phase: 'clean', baseRevision: draftReceipt.newRevision,
          text: '# 第二章\n\n潮水退去。',
        },
      })
      await controller.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
