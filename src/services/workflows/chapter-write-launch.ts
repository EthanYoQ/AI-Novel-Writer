import { CANONICAL_PROJECT_DIRECTORY } from '../../shared/project-format'
import type { ModelProfile, ProjectSessionContext } from '../../shared/ipc-channels'
import type { Locale } from '../../i18n/types'
import { isProjectSessionCurrent } from '../../components/project-session-gate'
import { useLLMStore } from '../../stores/llm-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useWorkflowStore, workflowResourceConflictMessage } from '../../stores/workflow-store'
import { readAuthoritativeNextChapter } from '../authoritative-chapter-sequence'
import { readConsistencyPreflight, type ConsistencyPreflightResult } from '../consistency-preflight'
import { ipc } from '../ipc-client'
import { requireIpcSuccess } from '../ipc-result'
import { guardChapterWriting } from '../workflow-guards'
import type { ChapterWritePrefill } from '../../stores/layout-store'
import { createChapterWorkflow } from './chapter-workflow'
import type { ChapterBlueprint } from './directory-workflow'
import {
  createChapterInfoFromDialogInput,
  DEFAULT_CHAPTER_WORDS_TARGET,
  normalizeChapterWordsTarget,
} from './chapter-creation-parameters'

/** 章节创作参数持久化路径（相对于项目路径） */
export const CREATION_LOG_REL = `${CANONICAL_PROJECT_DIRECTORY}/chapter_creation_log.json`

/** 写作一章的表单值：写作弹层只改指导与检索关键词，其余取自蓝图。 */
export interface ChapterWriteForm {
  chapterNumber: number | ''
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string
  userGuidance: string
  knowledgeHint: string
  wordsTarget: number | ''
}

export function isGenerationModel(model: ModelProfile): boolean {
  return model.purposes.includes('generation')
}

export function availableGenerationModelId(
  models: ModelProfile[],
  modelId: string | null | undefined,
): string | null {
  return modelId && models.some(model => model.id === modelId && isGenerationModel(model))
    ? modelId
    : null
}

export function preferredGenerationModelId(models: ModelProfile[], defaultModelId: string | null): string | null {
  return availableGenerationModelId(models, defaultModelId)
    ?? models.find(isGenerationModel)?.id
    ?? null
}

export function chapterDefaultWordsTarget(wordsPerChapter: number | undefined): number {
  return normalizeChapterWordsTarget(wordsPerChapter, DEFAULT_CHAPTER_WORDS_TARGET)
}

/** 蓝图里交给写作的字段；出场人物以顿号连接，启动时再按顿号或逗号拆开。 */
export function blueprintWritePrefill(blueprint: ChapterBlueprint): ChapterWritePrefill {
  return {
    title: blueprint.title,
    role: blueprint.role,
    purpose: blueprint.purpose,
    keyEvents: blueprint.keyEvents,
    characters: blueprint.characters.join('、'),
    userGuidance: blueprint.userGuidance || '',
  }
}

/** 从章节蓝图「写作此章」带来的预填参数换成表单值；目标字数取设定里的每章字数，检索关键词留空。 */
export function chapterWriteFormFromPrefill(prefill: Record<string, unknown>, defaultWordsTarget: number): ChapterWriteForm {
  return {
    chapterNumber: Number(prefill.chapterNumber) || 1,
    title: String(prefill.title || ''),
    role: String(prefill.role ?? '发展'),
    purpose: String(prefill.purpose || ''),
    keyEvents: String(prefill.keyEvents || ''),
    characters: String(prefill.characters || ''),
    userGuidance: String(prefill.userGuidance || ''),
    knowledgeHint: '',
    wordsTarget: defaultWordsTarget,
  }
}

export function generationModelError(models: ModelProfile[], selectedModelId: string | null, text: (zh: string, en: string) => string): string | null {
  if (!models.some(isGenerationModel)) {
    return text(
      '没有已配置且可用于文本生成的模型。请在设置中添加或启用一项生成模型。',
      'No configured model can generate text. Add or enable a generation model in Settings.',
    )
  }
  return availableGenerationModelId(models, selectedModelId)
    ? null
    : text(
      '所选创作模型已不可用。请选择一项可用于文本生成的模型后再试。',
      'The selected writing model is no longer available. Select a compatible generation model and try again.',
    )
}

/** 保存当前参数到持久化文件 */
async function saveChapterWriteParams(projectSession: ProjectSessionContext, form: ChapterWriteForm, wordsTarget: number) {
  const projectPath = projectSession.projectPath
  const { chapterNumber, title, role, purpose, keyEvents, characters, userGuidance } = form
  const params = { chapterNumber, title, role, purpose, keyEvents, characters, userGuidance, wordsTarget }
  try {
    let log: { lastUsed?: object; history?: object[] } = {}
    const existing = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:read-json',
      `${projectPath}/${CREATION_LOG_REL}`,
      projectPath,
    )
    if (!isProjectSessionCurrent(projectSession)) return
    if (existing.success && existing.data) {
      log = existing.data as typeof log
    }

    log.lastUsed = params
    log.history = [
      { ...params, createdAt: new Date().toISOString() },
      ...((log.history || []) as object[]).slice(0, 49), // 最多保留 50 条历史
    ]

    requireIpcSuccess(
      await ipc.invokeWithProjectSession(
        projectSession,
        'fs:write-json',
        `${projectPath}/${CREATION_LOG_REL}`,
        log,
        projectPath,
      ),
      '保存章节创作记录',
    )
  } catch (e) {
    console.warn('[ChapterCreation] 参数持久化失败:', e)
  }
}

export interface ChapterWriteLaunch {
  session: ProjectSessionContext
  form: ChapterWriteForm
  /** 作者选的本次模型；为空时取默认生成模型。 */
  generationModelId: string | null
  /** 设定里的每章字数，表单字数无效时回退到它。 */
  wordsPerChapter: number | undefined
  /** 一致性预检提醒「仅本次忽略」后重新开始。 */
  ignoreFindingsOnce: boolean
  locale: Locale
}

export type ChapterWriteOutcome =
  /** 项目已切换，什么也不做。 */
  | { kind: 'stale' }
  /** 读不出权威定稿序列，不能确定下一章。 */
  | { kind: 'authority-error'; message: string }
  /** 模型、章号、前置条件或资源冲突不满足，写明原因。 */
  | { kind: 'blocked'; message: string }
  /** 一致性预检发现线索，等作者处理；exemptions 一并返回供撤销。 */
  | { kind: 'preflight'; preflight: ConsistencyPreflightResult }
  | { kind: 'started' }

/**
 * 启动单章写作工作流。写作弹层走这里：
 * 权威章号、写作前置条件、一致性预检、参数持久化、ChapterInfo 组装与资源冲突检查都只在这一处。
 */
export async function launchChapterWrite({
  session, form, generationModelId, wordsPerChapter, ignoreFindingsOnce, locale,
}: ChapterWriteLaunch): Promise<ChapterWriteOutcome> {
  const text = useLocaleStore.getState().text
  const addLog = useWorkflowStore.getState().addLog
  const projectPath = session.projectPath
  const modelError = generationModelError(useLLMStore.getState().models, generationModelId, text)
  if (modelError) {
    addLog('error', modelError)
    return { kind: 'blocked', message: modelError }
  }
  const unavailableModel = text(
    '所选创作模型已不可用。请选择一项可用于文本生成的模型后再试。',
    'The selected writing model is no longer available. Select a compatible generation model and try again.',
  )

  const targetChapter = Number(form.chapterNumber) || 1
  let authoritativeNextChapter: number
  try {
    authoritativeNextChapter = await readAuthoritativeNextChapter(session, locale)
  } catch (error) {
    if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
    return { kind: 'authority-error', message: error instanceof Error ? error.message : String(error) }
  }
  if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
  if (targetChapter !== authoritativeNextChapter) {
    return { kind: 'blocked', message: text(
      `当前权威定稿之后只能创作第 ${authoritativeNextChapter} 章。请从该章蓝图进入，或修复定稿章节后重试。`,
      `Only Chapter ${authoritativeNextChapter} can be written after the current finalized authority. Open that blueprint, or repair finalized chapters before retrying.`,
    ) }
  }

  // 前置校验：章节蓝图是否已生成，以及（若篇章>1）前一章是否已定稿
  const guard = await guardChapterWriting(targetChapter, projectPath, session)
  if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
  if (!availableGenerationModelId(useLLMStore.getState().models, generationModelId)) {
    return { kind: 'blocked', message: unavailableModel }
  }
  if (!guard.ok) {
    return { kind: 'blocked', message: guard.message || text('前置条件未满足', 'Prerequisites are not met.') }
  }

  if (!ignoreFindingsOnce) {
    try {
      const preflight = await readConsistencyPreflight(session, [{
        chapterNumber: targetChapter,
        title: form.title,
        role: form.role,
        purpose: form.purpose,
        keyEvents: form.keyEvents,
        characters: form.characters.split(/[、,，]/u).map(value => value.trim()).filter(Boolean),
        suspenseHook: '',
        userGuidance: form.userGuidance,
        notes: '',
      }])
      if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
      if (preflight.findings.length > 0) return { kind: 'preflight', preflight }
    } catch {
      if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
      addLog('info', text(
        '一致性证据暂时不可用；本次创作仍会继续。',
        'Continuity evidence is temporarily unavailable; writing will continue.',
      ))
    }
  }

  const wordsTarget = normalizeChapterWordsTarget(form.wordsTarget, wordsPerChapter)
  await saveChapterWriteParams(session, form, wordsTarget)
  if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
  const frozenGenerationModelId = availableGenerationModelId(useLLMStore.getState().models, generationModelId)
  if (!frozenGenerationModelId) return { kind: 'blocked', message: unavailableModel }

  const workflow = createChapterWorkflow(createChapterInfoFromDialogInput({
    projectPath,
    chapterNumber: form.chapterNumber,
    title: form.title,
    role: form.role,
    purpose: form.purpose,
    keyEvents: form.keyEvents,
    characters: form.characters,
    userGuidance: form.userGuidance,
    knowledgeQueryHint: form.knowledgeHint,
    wordsTarget,
    defaultWordsTarget: wordsPerChapter ?? DEFAULT_CHAPTER_WORDS_TARGET,
  }), session, { generationModelId: frozenGenerationModelId })

  if (!isProjectSessionCurrent(session)) return { kind: 'stale' }
  const resourceConflict = useWorkflowStore.getState().getResourceConflict(workflow)
  if (resourceConflict) {
    return { kind: 'blocked', message: workflowResourceConflictMessage(locale, resourceConflict.title) }
  }
  void useWorkflowStore.getState().startWorkflow(workflow, false)
  return { kind: 'started' }
}
