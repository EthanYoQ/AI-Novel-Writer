import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { MainGenerationRunHandle } from '../generation/generation-runtime'
import { workflowResourceKey, type WorkflowDefinition } from '../../stores/workflow-store'
import { formatResourceUri } from '../../shared/project-paths'
import { ipc } from '../ipc-client'
import { ReviewChapterCommand } from './commands/review-chapter.command'
import { RefineDraftCommand } from './commands/refine-draft.command'
import { RefineFromReviewCommand } from './commands/refine-from-review.command'

/** Recover the selected durable action; a saved effect is opened without requesting another model result. */
export async function createReviewRevisionRecoveryWorkflow(projectSession: ProjectSessionContext,
  selectedHandle: MainGenerationRunHandle): Promise<WorkflowDefinition> {
  const session = Object.freeze({ ...projectSession }), handle = Object.freeze({ ...selectedHandle })
  const recovery = await ipc.invokeWithProjectSession(session, 'review-revision:read-recovery', { handle })
  const frozen = recovery.context, source = frozen.source
  if (!['review-chapter', 'refine-draft', 'refine-from-review'].includes(frozen.operation)
    || handle.projectId !== session.projectId || recovery.handle.runId !== handle.runId)
    throw new Error('GENERATION_REVIEW_RECOVERY_SCOPE_INVALID')
  if (!recovery.saved && recovery.sourceStatus !== 'current') throw new Error('GENERATION_REVIEW_SOURCE_CHANGED')
  const params = { draftPath: formatResourceUri({ kind: 'draft', id: source.id }), draftContent: source.content,
    chapterNumber: source.chapterNumber, recoveryHandle: handle }
  const blueprint = frozen.blueprints.find(item => item.chapterNumber === source.chapterNumber)
  const command = frozen.operation === 'review-chapter' ? new ReviewChapterCommand(params)
    : frozen.operation === 'refine-from-review' ? new RefineFromReviewCommand(params)
      : new RefineDraftCommand({ ...params, chapterInfo: { projectPath: session.projectPath, chapterNumber: source.chapterNumber,
        title: blueprint?.title ?? '', role: blueprint?.role ?? '', purpose: blueprint?.purpose ?? '',
        characters: blueprint?.characters ?? [], keyEvents: blueprint?.keyEvents ?? '' } })
  const name = frozen.uiLocale === 'en-US' ? `Recover chapter ${source.chapterNumber} review or revision` : `恢复第${source.chapterNumber}章审稿或修稿`
  return { type: 'chapter_creation', title: name, projectPath: session.projectPath, projectSession: session,
    generationModelId: recovery.modelId, uiLocale: frozen.uiLocale,
    resourceKeys: [workflowResourceKey('chapter', source.chapterNumber)],
    steps: [{ name, description: frozen.uiLocale === 'en-US' ? 'Continue the original action and preserve its budget.' : '沿用原任务与预算，保存前重新核对来源。',
      executor: (step, context, callbacks) => command.execute({ step, context, callbacks }) }] }
}
