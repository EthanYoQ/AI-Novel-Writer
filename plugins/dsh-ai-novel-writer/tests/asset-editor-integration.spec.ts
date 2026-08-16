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
    || (value.targetKind !== 'project' && value.targetKind !== 'characters')
    || typeof value.baseRevision !== 'string'
    || typeof value.baseText !== 'string'
    || typeof value.replacement !== 'string'
    || typeof value.summary !== 'string') throw new Error('proposal prompt contained invalid tool arguments')
  return {
    kind: 'replace',
    target: { kind: value.targetKind },
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
})
