import type { WorkflowContext, WorkflowDefinition, WorkflowStep, StepCallbacks } from '../../stores/workflow-store'
import { ipc } from '../ipc-client'
import { guardChapterWriting } from '../workflow-guards'
import type { ChapterInfo } from './chapter-workflow'
import type { ChapterBlueprint } from './directory-workflow'
import { GenerateDraftCommand } from './commands/generate-draft.command'
import { FinalizeChapterCommand } from './commands/finalize-chapter.command'
import type { Locale } from '../../i18n/types'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectPathKey } from '../../shared/project-session-context'
import type { FinalizationSnapshot } from '../finalization-snapshot'
import { requireWorkflowProjectSession } from './workflow-project-session'

/** 单次批量创作的安全上限，避免无边界调用模型。 */
export const MIN_BATCH_CHAPTERS = 1
export const MAX_BATCH_CHAPTERS = 10

export type BatchChapterCompletionMode = 'draft_review' | 'auto_finalize'

export interface BatchChapterWorkflowParams {
  projectPath: string
  /** 点击开始时冻结的完整项目 lease，禁止工厂借用当前项目。 */
  projectSession: ProjectSessionContext
  /** 从哪一章开始，通常是当前第一章未定稿的蓝图 */
  startChapterNumber: number
  /** 本次连续创作章节数（强制限制为 1–10） */
  chapterCount: number
  /** 任务面板中的章节名称跟随应用界面语言 */
  locale?: Locale
  /** 由批量创作入口选择并冻结；缺失时由草稿命令使用默认生成模型。 */
  generationModelId?: string
  /** 点击开始时冻结；草稿待审与自动定稿在同一批次内不得混用。 */
  completionMode: BatchChapterCompletionMode
}

export interface BatchChapterWorkflowDefinition extends WorkflowDefinition {
  /** 随定义冻结的批量完成模式，供启动收据与 UI 验证。 */
  completionMode: BatchChapterCompletionMode
}

/** 将 UI 或外部输入收敛到安全的 1–10 章范围。 */
export function normalizeBatchChapterCount(value: number | string | null | undefined): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed)) return MIN_BATCH_CHAPTERS
  return Math.min(MAX_BATCH_CHAPTERS, Math.max(MIN_BATCH_CHAPTERS, parsed))
}

function normalizeGenerationModelId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeCompletionMode(value: unknown): BatchChapterCompletionMode {
  return value === 'auto_finalize' ? 'auto_finalize' : 'draft_review'
}

function localeText(locale: Locale, zhCNText: string, enUSText: string): string {
  return locale === 'en-US' ? enUSText : zhCNText
}

function toChapterInfo(blueprint: ChapterBlueprint, projectPath: string): ChapterInfo {
  return {
    projectPath,
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

function throwIfCancelled(context: WorkflowContext, uiLocale: Locale) {
  if (context.cancelled) {
    throw new Error(localeText(uiLocale, '批量创作已取消', 'Batch writing was cancelled.'))
  }
}

/**
 * Bind the draft tab opened by GenerateDraftCommand to the same immutable
 * snapshot consumed by automatic finalization. Existing reconciliation then
 * marks an unchanged tab read-only and preserves any concurrent author edit as
 * a conflict instead of silently closing or overwriting it.
 */
async function captureBatchFinalizationSnapshot(
  draftPath: string,
  draftContent: string,
  chapterNumber: number,
  chapterTitle: string,
  projectPath: string,
  projectSession: ProjectSessionContext,
): Promise<FinalizationSnapshot | undefined> {
  const draftIdMatch = draftPath.match(/^vela:\/\/draft\/(\d+)$/)
  if (!draftIdMatch) return undefined
  const draftId = Number.parseInt(draftIdMatch[1], 10)

  try {
    const { useEditorStore } = await import('../../stores/editor-store')
    const tab = useEditorStore.getState().tabs.find(candidate => (
      candidate.filePath === draftPath
      && candidate.type === 'chapter'
      && sameProjectPathKey(candidate.projectKey, projectPath)
    ))
    if (!tab) return undefined

    const contentRevision = tab.contentRevision ?? 0
    useEditorStore.setState(state => ({
      tabs: state.tabs.map(candidate => candidate.id === tab.id
        ? {
          ...candidate,
          draftId,
          chapterNumber,
          draftStatus: 'draft',
          projectSessionLease: projectSession.leaseId,
          contentRevision,
        }
        : candidate),
    }))

    return Object.freeze({
      tabId: tab.id,
      projectPath,
      projectSession: Object.freeze({ ...projectSession }),
      draftId,
      chapterNumber,
      chapterTitle,
      content: draftContent,
      contentRevision,
    })
  } catch {
    // Editor binding is a renderer projection. Finalization can still use its
    // database-backed fallback when the tab was not opened or already closed.
    return undefined
  }
}

async function runOneBatchChapter(
  projectPath: string,
  batchStartChapterNumber: number,
  chapterNumber: number,
  completionMode: BatchChapterCompletionMode,
  uiLocale: Locale,
  step: WorkflowStep,
  context: WorkflowContext,
  callbacks: StepCallbacks,
): Promise<string> {
  const projectSession = requireWorkflowProjectSession(context)
  // 草稿待审模式不会把本批次前一章变成定稿事实；首章仍遵守外部连续性门禁，
  // 后续章只重复校验蓝图/角色等全局前置条件。
  const guardedChapterNumber = completionMode === 'draft_review' && chapterNumber > batchStartChapterNumber
    ? undefined
    : chapterNumber
  const guard = await guardChapterWriting(guardedChapterNumber, projectPath, projectSession)
  if (!guard.ok) {
    throw new Error(uiLocale === 'en-US'
      ? `Chapter ${chapterNumber} does not meet the writing prerequisites.`
      : guard.message || `第${chapterNumber}章不满足创作前置条件`)
  }

  const [blueprint, existingDraft] = await Promise.all([
    ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', chapterNumber, projectPath),
    ipc.invokeWithProjectSession(projectSession, 'db:draft-get-latest', chapterNumber, projectPath),
  ])
  if (!blueprint) {
    throw new Error(localeText(
      uiLocale,
      `未找到第${chapterNumber}章蓝图，批量创作已停止`,
      `No blueprint was found for Chapter ${chapterNumber}. Batch writing stopped.`,
    ))
  }
  if (existingDraft) {
    throw new Error(localeText(
      uiLocale,
      `第${chapterNumber}章已有草稿，批量创作不会覆盖既有内容`,
      `Chapter ${chapterNumber} already has a draft. Batch writing will not overwrite it.`,
    ))
  }

  const chapterInfo = toChapterInfo(blueprint as ChapterBlueprint, projectPath)
  callbacks.log(completionMode === 'draft_review'
    ? localeText(
      uiLocale,
      `开始第${chapterNumber}章：生成草稿待审。`,
      `Starting Chapter ${chapterNumber}: generate a review draft.`,
    )
    : localeText(
      uiLocale,
      `开始第${chapterNumber}章：生成草稿、自动定稿并完成后处理。`,
      `Starting Chapter ${chapterNumber}: generate, auto-finalize, and post-process.`,
    ))
  callbacks.setProgress(5)

  const draftContent = await new GenerateDraftCommand(chapterInfo).execute({ step, context, callbacks })
  throwIfCancelled(context, uiLocale)

  if (completionMode === 'draft_review') {
    callbacks.setProgress(100)
    return localeText(
      uiLocale,
      `第${chapterNumber}章草稿已生成并保存，等待审稿。`,
      `Chapter ${chapterNumber} draft was generated and saved for review.`,
    )
  }

  callbacks.setProgress(55)

  const draftPath = String(context.data.draftPath || '')
  if (!draftPath) {
    throw new Error(localeText(
      uiLocale,
      `第${chapterNumber}章草稿已生成，但未取得草稿路径`,
      `Chapter ${chapterNumber} was generated, but its draft path is unavailable.`,
    ))
  }

  const snapshot = await captureBatchFinalizationSnapshot(
    draftPath,
    draftContent,
    chapterNumber,
    chapterInfo.title,
    projectPath,
    projectSession,
  )
  throwIfCancelled(context, uiLocale)

  await new FinalizeChapterCommand({
    draftPath,
    draftContent,
    chapterNumber,
    chapterInfo,
    stopOnPostProcessFailure: true,
    eventSource: 'batch',
    ...(snapshot ? { snapshot } : {}),
  }).execute({ step, context, callbacks })

  callbacks.setProgress(100)
  return localeText(
    uiLocale,
    `第${chapterNumber}章已定稿，后处理全部通过。`,
    `Chapter ${chapterNumber} was finalized and all post-processing passed.`,
  )
}

/**
 * 受控批量创作：每个步骤完整处理一章。
 *
 * 工作流层只会在章节边界推进；因此暂停/取消不会将一个正在进行的模型请求或后处理
 * 截断到不一致状态。后处理任一步骤最终失败会抛出错误，阻止后续章节启动。
 */
export function createBatchChapterWorkflow(params: BatchChapterWorkflowParams): BatchChapterWorkflowDefinition {
  if (!sameProjectPathKey(params.projectSession.projectPath, params.projectPath)) {
    throw new Error('批量创作项目会话与目标路径不匹配')
  }
  const projectPath = params.projectPath
  const startChapterNumber = Math.max(1, Math.trunc(Number(params.startChapterNumber) || 1))
  const chapterCount = normalizeBatchChapterCount(params.chapterCount)
  const uiLocale: Locale = params.locale === 'en-US' ? 'en-US' : 'zh-CN'
  const generationModelId = normalizeGenerationModelId(params.generationModelId)
  const completionMode = normalizeCompletionMode(params.completionMode)
  const endChapterNumber = startChapterNumber + chapterCount - 1

  return {
    type: 'batch_generate',
    projectPath,
    projectSession: Object.freeze({ ...params.projectSession }),
    ...(generationModelId ? { generationModelId } : {}),
    completionMode,
    title: completionMode === 'draft_review'
      ? localeText(
        uiLocale,
        `批量草稿待审 — 第${startChapterNumber}–${endChapterNumber}章`,
        `Batch review drafts — Chapters ${startChapterNumber}–${endChapterNumber}`,
      )
      : localeText(
        uiLocale,
        `批量自动定稿 — 第${startChapterNumber}–${endChapterNumber}章`,
        `Batch auto-finalize — Chapters ${startChapterNumber}–${endChapterNumber}`,
      ),
    steps: Array.from({ length: chapterCount }, (_, index) => {
      const chapterNumber = startChapterNumber + index
      return {
        name: completionMode === 'draft_review'
          ? localeText(
            uiLocale,
            `第${chapterNumber}章：生成草稿待审`,
            `Chapter ${chapterNumber}: generate review draft`,
          )
          : localeText(
            uiLocale,
            `第${chapterNumber}章：自动定稿与后处理`,
            `Chapter ${chapterNumber}: auto-finalize and post-process`,
          ),
        description: completionMode === 'draft_review'
          ? localeText(
            uiLocale,
            '按蓝图生成可编辑草稿并保留待审；不定稿或运行后处理。',
            'Generate an editable draft from the blueprint and keep it for review without finalizing or post-processing.',
          )
          : localeText(
            uiLocale,
            '按蓝图生成草稿并自动定稿；任一后处理失败立即停止。',
            'Generate from the blueprint, finalize automatically, and stop immediately if post-processing fails.',
          ),
        executor: (step, context, callbacks) => runOneBatchChapter(
          projectPath,
          startChapterNumber,
          chapterNumber,
          completionMode,
          uiLocale,
          step,
          context,
          callbacks,
        ),
      }
    }),
    onComplete: { mode: 'silent' },
  }
}
