import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { MainGenerationRunHandle } from '../generation/generation-runtime'
import type { WorkflowDefinition } from '../../stores/workflow-store'
import { workflowResourceKey } from '../../stores/workflow-store'
import { ipc } from '../ipc-client'
import { createMainGenerationTransport } from '../generation/main-generation-transport'
import { composeDraftVisibleContinuation, DRAFT_VISIBLE_TEXT_VERSION } from '../../shared/draft-visible-text'
import { hashAuthorText } from '../../shared/source-ref'
import { GenerateDraftCommand } from './commands/generate-draft.command'
import type { ChapterInfo } from './chapter-workflow'
import { createBatchChapterWorkflow } from './batch-chapter-workflow'

/** The author selects a durable identity; this never discovers a candidate by recency. */
export async function createDraftRecoveryWorkflow(
  projectSession: ProjectSessionContext,
  selectedHandle: MainGenerationRunHandle,
  selectedArtifactIds?: readonly string[],
): Promise<WorkflowDefinition> {
  const session = Object.freeze({ ...projectSession })
  const transport = createMainGenerationTransport(() => session)
  let handle = Object.freeze({ ...selectedHandle })
  let recovery = await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle })
  if (recovery.operation !== 'chapter-draft' || recovery.batchId) throw new Error('GENERATION_DRAFT_RECOVERY_SCOPE_INVALID')
  if (selectedArtifactIds && !recovery.savedDraft) {
    if (!selectedArtifactIds.length || new Set(selectedArtifactIds).size !== selectedArtifactIds.length)
      throw new Error('GENERATION_COMPOSITION_SELECTION_REQUIRED')
    const resumed = await transport.resume(session, handle)
    handle = Object.freeze({ ...resumed.handle })
    const candidates = [...resumed.artifacts, ...(resumed.candidates ?? [])]
    const selected = selectedArtifactIds.map(id => {
      const candidate = candidates.find(item => item.artifactId === id)
      if (!candidate || candidate.compositionEligible !== true) throw new Error('GENERATION_COMPOSITION_SELECTION_INVALID')
      return candidate
    })
    const text = selected.reduce((text, candidate) => composeDraftVisibleContinuation(text, candidate.text), '')
    await ipc.invokeWithProjectSession(session, 'generation:compose-visible', handle, [...selectedArtifactIds],
      await hashAuthorText(text), DRAFT_VISIBLE_TEXT_VERSION)
    recovery = await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle })
  }
  if (!recovery.savedDraft && (!recovery.composition || recovery.composition.algorithm !== DRAFT_VISIBLE_TEXT_VERSION))
    throw new Error('GENERATION_DRAFT_RECOVERY_EVIDENCE_REQUIRED')
  const infoText = recovery.authorInputs.find(input => input.id === 'draft:chapter-info')?.text
  const targetText = recovery.authorInputs.find(input => input.id === 'draft:target-units')?.text
  if (!infoText || !targetText) throw new Error('GENERATION_DRAFT_RECOVERY_AUTHOR_INPUT_REQUIRED')
  const info = JSON.parse(infoText) as Partial<ChapterInfo>
  const target = Number(targetText)
  if (info.chapterNumber !== recovery.chapterNumber || !Number.isSafeInteger(info.chapterNumber)
    || Number(info.chapterNumber) < 1 || typeof info.title !== 'string' || !Array.isArray(info.characters)
    || !info.characters.every(item => typeof item === 'string') || !Number.isSafeInteger(target) || target < 1)
    throw new Error('GENERATION_DRAFT_RECOVERY_AUTHOR_INPUT_INVALID')
  if (!recovery.savedDraft && recovery.selectedDraftIds.length && !recovery.selectedDrafts)
    throw new Error('GENERATION_DRAFT_RECOVERY_SOURCE_CHANGED')
  const selectedCandidateDrafts = recovery.savedDraft ? [] : recovery.selectedDrafts ?? []
  const command = new GenerateDraftCommand({ ...info, projectPath: session.projectPath, wordsTarget: target } as ChapterInfo,
    { resumeHandle: handle, selectedCandidateDrafts })
  return {
    type: 'chapter_creation', title: `继续第${info.chapterNumber}章正文`, projectPath: session.projectPath,
    projectSession: session, generationModelId: recovery.modelId, chapterWordsTarget: target,
    resourceKeys: [workflowResourceKey('chapter', info.chapterNumber)],
    steps: [{ name: '继续已选正文', description: '沿原候选和原预算继续，保存前重新检查来源。',
      executor: (step, context, callbacks) => command.execute({ step, context, callbacks }) }],
  }
}

export async function createBatchRecoveryWorkflow(session: ProjectSessionContext, batchId: string): Promise<WorkflowDefinition> {
  const captured = Object.freeze({ ...session })
  const progress = await ipc.invokeWithProjectSession(captured, 'generation:read-batch', { batchId })
  if (progress.nextChapterNumber === null) throw new Error('GENERATION_BATCH_ALREADY_COMPLETED')
  return createBatchChapterWorkflow({ projectPath: captured.projectPath, projectSession: captured,
    resumeBatchId: progress.batchId, generationModelId: progress.modelId, completionMode: progress.mode,
    chapterWordsTarget: progress.targetUnits, startChapterNumber: progress.range.startChapter,
    chapterCount: progress.range.endChapter - progress.range.startChapter + 1 })
}
