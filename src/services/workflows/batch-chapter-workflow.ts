import type { WorkflowContext, WorkflowDefinition, WorkflowStep, StepCallbacks } from '../../stores/workflow-store'
import { ipc } from '../ipc-client'
import { guardChapterWriting } from '../workflow-guards'
import type { ChapterInfo } from './chapter-workflow'
import type { ChapterBlueprint } from './directory-workflow'
import { GenerateDraftCommand } from './commands/generate-draft.command'
import { FinalizeChapterCommand } from './commands/finalize-chapter.command'
import type { Locale } from '../../i18n/types'

/** 单次批量创作的安全上限，避免无边界调用模型。 */
export const MIN_BATCH_CHAPTERS = 1
export const MAX_BATCH_CHAPTERS = 10

export interface BatchChapterWorkflowParams {
  /** 从哪一章开始，通常是当前第一章未定稿的蓝图 */
  startChapterNumber: number
  /** 本次连续创作章节数（强制限制为 1–10） */
  chapterCount: number
  /** 任务面板中的章节名称跟随应用界面语言 */
  locale?: Locale
}

/** 将 UI 或外部输入收敛到安全的 1–10 章范围。 */
export function normalizeBatchChapterCount(value: number | string | null | undefined): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed)) return MIN_BATCH_CHAPTERS
  return Math.min(MAX_BATCH_CHAPTERS, Math.max(MIN_BATCH_CHAPTERS, parsed))
}

function toChapterInfo(blueprint: ChapterBlueprint): ChapterInfo {
  return {
    chapterNumber: blueprint.chapterNumber,
    title: blueprint.title || `第${blueprint.chapterNumber}章`,
    role: blueprint.role || '发展',
    purpose: blueprint.purpose || '',
    characters: Array.isArray(blueprint.characters) ? blueprint.characters : [],
    keyEvents: blueprint.keyEvents || '',
    suspenseHook: blueprint.suspenseHook || '',
    userGuidance: blueprint.userGuidance || '',
  }
}

function throwIfCancelled(context: WorkflowContext) {
  if (context.cancelled) throw new Error('批量创作已取消')
}

async function runOneBatchChapter(
  chapterNumber: number,
  step: WorkflowStep,
  context: WorkflowContext,
  callbacks: StepCallbacks,
): Promise<string> {
  const guard = await guardChapterWriting(chapterNumber)
  if (!guard.ok) throw new Error(guard.message || `第${chapterNumber}章不满足创作前置条件`)

  const [blueprint, existingDraft] = await Promise.all([
    ipc.invoke('db:blueprint-get', chapterNumber),
    ipc.invoke('db:draft-get-latest', chapterNumber),
  ])
  if (!blueprint) throw new Error(`未找到第${chapterNumber}章蓝图，批量创作已停止`)
  if (existingDraft) throw new Error(`第${chapterNumber}章已有草稿，批量创作不会覆盖既有内容`)

  const chapterInfo = toChapterInfo(blueprint as ChapterBlueprint)
  callbacks.log(`开始第${chapterNumber}章：生成草稿 → 自动定稿 → 后处理`)
  callbacks.setProgress(5)

  const draftContent = await new GenerateDraftCommand(chapterInfo).execute({ step, context, callbacks })
  throwIfCancelled(context)
  callbacks.setProgress(55)

  const draftPath = String(context.data.draftPath || '')
  if (!draftPath) throw new Error(`第${chapterNumber}章草稿已生成，但未取得草稿路径`)

  await new FinalizeChapterCommand({
    draftPath,
    draftContent,
    chapterNumber,
    chapterInfo,
    stopOnPostProcessFailure: true,
    eventSource: 'batch',
  }).execute({ step, context, callbacks })

  callbacks.setProgress(100)
  return `第${chapterNumber}章已定稿，后处理全部通过`
}

/**
 * 受控批量创作：每个步骤完整处理一章。
 *
 * 工作流层只会在章节边界推进；因此暂停/取消不会将一个正在进行的模型请求或后处理
 * 截断到不一致状态。后处理任一步骤最终失败会抛出错误，阻止后续章节启动。
 */
export function createBatchChapterWorkflow(params: BatchChapterWorkflowParams): WorkflowDefinition {
  const startChapterNumber = Math.max(1, Math.trunc(Number(params.startChapterNumber) || 1))
  const chapterCount = normalizeBatchChapterCount(params.chapterCount)
  const isEnglish = params.locale === 'en-US'

  return {
    type: 'batch_generate',
    title: isEnglish
      ? `Batch writing — Chapters ${startChapterNumber}–${startChapterNumber + chapterCount - 1}`
      : `批量创作 — 第${startChapterNumber}–${startChapterNumber + chapterCount - 1}章`,
    steps: Array.from({ length: chapterCount }, (_, index) => {
      const chapterNumber = startChapterNumber + index
      return {
        name: isEnglish ? `Chapter ${chapterNumber}: writing and post-processing` : `第${chapterNumber}章：创作与后处理`,
        description: isEnglish
          ? 'Generate from the blueprint, finalize automatically, and stop immediately if post-processing fails.'
          : '按蓝图生成草稿，自动定稿；任一后处理失败立即停止。',
        executor: (step, context, callbacks) => runOneBatchChapter(chapterNumber, step, context, callbacks),
      }
    }),
    onComplete: { mode: 'silent' },
  }
}
