import { workflowResourceKey, type WorkflowDefinition } from '../../stores/workflow-store'
import type { DraftMeta } from '../draft-index'
import { requireIpcSuccess } from '../ipc-result'
import { ipc } from '../ipc-client'

import type { DraftStatus } from '../../shared/draft-status'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { sameProjectPathKey } from '../../shared/project-session-context'
import { normalizeChapterWordsTarget } from './chapter-creation-parameters'

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================
export type { DraftStatus, DraftMeta }

export interface ChapterInfo {
  projectPath: string
  chapterNumber: number
  title: string
  role: string
  purpose: string
  characters: string[]
  keyEvents: string
  suspenseHook?: string
  userGuidance?: string
  /** 本次单章创作的用户目标字数；未提供时沿用项目默认值。 */
  wordsTarget?: number
  /** 用户自定义知识库检索关键词（追加到向量搜索 query） */
  knowledgeQueryHint?: string
}

export interface ChapterWorkflowOptions {
  /** A frozen Agent-originated model choice for this draft run only. */
  generationModelId?: string
}

export interface RefineOnlyParams {
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  userRefinePrompt?: string
}

export interface RefineFromReviewParams {
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  /** Persisted JSON from the human-confirmation review row. */
  confirmedReviewContent?: string
  /** ID of the confirmation review row, recorded on the resulting revision. */
  reviewSourceId?: number
  /** @deprecated Raw AI review text must not become a model instruction. */
  reviewReport?: string
  reviewFileName?: string
  /** Renderer-owned selection, frozen onto this workflow rather than LLM input. */
  generationModelId?: string
  /** @deprecated Author guidance is part of the confirmation snapshot. */
  userRefinePrompt?: string
}

export interface ReviewOnlyParams {
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  /** 审稿维度侧重点（可选） */
  reviewFocus?: string
}

export interface FinalizeOnlyParams {
  projectPath: string
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  snapshot?: import('../finalization-snapshot').FinalizationSnapshot
}

// ==========================================
// 2. 草稿文件工具函数 (供前端 UI 侧调用)
// ==========================================

export function getDraftDir(_projectPath: string, chapterNumber: number): string {
  return `vela://draft/ch${chapterNumber}`
}

export function getDraftPath(_projectPath: string, chapterNumber: number, version: number): string {
  return `vela://draft/ch${chapterNumber}/v${version}`
}

const CHAPTER_CONTEXT_READ_RESOURCE_KEYS = Object.freeze([
  workflowResourceKey('novel-config'),
  workflowResourceKey('architecture'),
  workflowResourceKey('blueprints'),
])

const FINALIZE_SHARED_WRITE_RESOURCE_KEYS = Object.freeze([
  workflowResourceKey('character-roster'),
  workflowResourceKey('continuity'),
  workflowResourceKey('chapter-summary'),
])

function finalizeWriteResourceKeys(chapterNumber: number): readonly string[] {
  return Object.freeze([
    workflowResourceKey('chapter', chapterNumber),
    ...FINALIZE_SHARED_WRITE_RESOURCE_KEYS,
  ])
}

function workflowProjectSession(
  projectPath: string,
  sourceProjectSession: ProjectSessionContext,
): ProjectSessionContext {
  if (!sameProjectPathKey(sourceProjectSession.projectPath, projectPath)) {
    throw new Error('工作流项目会话与目标路径不匹配')
  }
  return Object.freeze({ ...sourceProjectSession })
}

export async function parseDraftMeta(
  filePath: string,
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<DraftMeta | null> {
  if (!sameProjectPathKey(projectSession.projectPath, expectedProjectPath)) {
    throw new Error('读取草稿元数据时项目会话与目标路径不匹配')
  }

  // 优先处理 vela://draft/{id} 纯数字 ID 格式（DB 化后的标准路径）
  const idMatch = filePath.match(/^vela:\/\/(?:draft|manuscript)\/(\d+)$/)
  if (idMatch) {
    const draftId = parseInt(idMatch[1])
    const dbMeta = await ipc.invokeWithProjectSession(
      projectSession,
      'db:draft-get-meta',
      draftId,
      expectedProjectPath,
    )
    if (!dbMeta) return null
    return {
      ...dbMeta,
      status: dbMeta.status as DraftStatus,
      source: dbMeta.source as 'write' | 'rewrite',
      fileName: `draft_v${dbMeta.version}.md`,
      filePath: `vela://draft/${dbMeta.id}`,
    } as unknown as DraftMeta
  }

  // 兼容旧格式 draft_v(\d+).md 和 vela://draft/ch{N}/v{V}
  const versionMatch = filePath.match(/v(\d+)(?:\.md)?$/)
  if (!versionMatch) return null
  const version = parseInt(versionMatch[1])

  // 提取章节号
  const chMatch = filePath.match(/ch(\d+)/)
  if (!chMatch) return null
  const chapterNumber = parseInt(chMatch[1])

  const drafts = await ipc.invokeWithProjectSession(
    projectSession,
    'db:draft-list',
    chapterNumber,
    expectedProjectPath,
  )
  const d = drafts.find((draft) => draft.version === version)
  return d ? (d as unknown as DraftMeta) : null
}

export async function updateDraftStatus(
  filePath: string,
  newStatus: DraftStatus,
  expectedProjectPath: string,
  projectSession: ProjectSessionContext,
): Promise<void> {
  const meta = await parseDraftMeta(filePath, expectedProjectPath, projectSession)
  if (meta) {
    requireIpcSuccess(
      await ipc.invokeWithProjectSession(
        projectSession,
        'db:draft-update-status',
        meta.id,
        newStatus,
        undefined,
        expectedProjectPath,
      ),
      '更新草稿状态',
    )
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// 将原有的 1500 多行核心面条代码剥离为微内核执行器。
// ==========================================

export function createChapterWorkflow(
  chapterInfo: ChapterInfo,
  sourceProjectSession: ProjectSessionContext,
  options: ChapterWorkflowOptions = {},
): WorkflowDefinition {
  const generationModelId = options.generationModelId?.trim() || undefined
  const chapterWordsTarget = normalizeChapterWordsTarget(chapterInfo.wordsTarget)
  const frozenChapterInfo = Object.freeze({ ...chapterInfo, wordsTarget: chapterWordsTarget })
  return {
    type: 'chapter_creation',
    projectPath: chapterInfo.projectPath,
    projectSession: workflowProjectSession(chapterInfo.projectPath, sourceProjectSession),
    ...(generationModelId ? { generationModelId } : {}),
    chapterWordsTarget,
    resourceKeys: [workflowResourceKey('chapter', chapterInfo.chapterNumber)],
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: `写稿 — 第 ${chapterInfo.chapterNumber} 章 · ${chapterInfo.title}`,
    steps: [
      {
        name: '写稿',
        description: '基于架构 + 蓝图 + 上下文调用 Command 生成草稿',
        executor: async (step, context, callbacks) => {
          const { GenerateDraftCommand } = await import('./commands/generate-draft.command')
          const cmd = new GenerateDraftCommand(frozenChapterInfo)
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', message: `第${chapterInfo.chapterNumber}章草稿已生成` },
  }
}

export function createRefineOnlyWorkflow(
  params: RefineOnlyParams,
  sourceProjectSession: ProjectSessionContext,
): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: workflowProjectSession(params.projectPath, sourceProjectSession),
    resourceKeys: [workflowResourceKey('chapter', params.chapterNumber)],
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: `修稿 — 第${params.chapterNumber}章 ${params.chapterTitle}`,
    steps: [
      {
        name: '修稿',
        description: '将草稿提升到大神级质量，保存修稿并打开合并视图',
        executor: async (step, context, callbacks) => {
          const { RefineDraftCommand } = await import('./commands/refine-draft.command')
          const cmd = new RefineDraftCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
            chapterInfo: { projectPath: params.projectPath, chapterNumber: params.chapterNumber, title: params.chapterTitle, role: '', purpose: '', characters: [], keyEvents: '' },
            userRefinePrompt: params.userRefinePrompt,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', openResult: async () => { } },
  }
}

export function createRefineFromReviewWorkflow(
  params: RefineFromReviewParams,
  sourceProjectSession: ProjectSessionContext,
): WorkflowDefinition {
  const generationModelId = params.generationModelId?.trim() || undefined
  return {
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: workflowProjectSession(params.projectPath, sourceProjectSession),
    ...(generationModelId ? { generationModelId } : {}),
    resourceKeys: [workflowResourceKey('chapter', params.chapterNumber)],
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: `审稿修复 — 第${params.chapterNumber}章 ${params.chapterTitle}`,
    steps: [
      {
        name: '审稿驱动修稿',
        description: '根据审稿报告精准修复问题调用 Command',
        executor: async (step, context, callbacks) => {
          const { RefineFromReviewCommand } = await import('./commands/refine-from-review.command')
          const cmd = new RefineFromReviewCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            confirmedReviewContent: params.confirmedReviewContent,
            reviewSourceId: params.reviewSourceId,
            chapterNumber: params.chapterNumber,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', openResult: async () => { } },
  }
}

export function createReviewOnlyWorkflow(
  params: ReviewOnlyParams,
  sourceProjectSession: ProjectSessionContext,
): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: workflowProjectSession(params.projectPath, sourceProjectSession),
    resourceKeys: [workflowResourceKey('chapter', params.chapterNumber)],
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: `审稿 — 第${params.chapterNumber}章 ${params.chapterTitle}`,
    steps: [
      {
        name: '审稿',
        description: '一致性检查（角色/剧情/世界观），生成审稿报告',
        executor: async (step, context, callbacks) => {
          const { ReviewChapterCommand } = await import('./commands/review-chapter.command')
          const cmd = new ReviewChapterCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
            reviewFocus: params.reviewFocus,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', message: `第${params.chapterNumber}章审稿完成` },
  }
}

export function createFinalizeWorkflow(
  params: FinalizeOnlyParams,
  sourceProjectSession: ProjectSessionContext,
): WorkflowDefinition {
  const chapterInfo: ChapterInfo = { projectPath: params.projectPath, chapterNumber: params.chapterNumber, title: params.chapterTitle, role: '', purpose: '', characters: [], keyEvents: '' }
  return {
    type: 'chapter_creation',
    projectPath: params.projectPath,
    projectSession: workflowProjectSession(params.projectPath, sourceProjectSession),
    resourceKeys: finalizeWriteResourceKeys(params.chapterNumber),
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: `定稿 — 第${params.chapterNumber}章 ${params.chapterTitle}`,
    steps: [
      {
        name: '定稿',
        description: '写入 manuscript/，开启后处理 Command 更新三路大纲',
        executor: async (step, context, callbacks) => {
          const { FinalizeChapterCommand } = await import('./commands/finalize-chapter.command')
          const cmd = new FinalizeChapterCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
            chapterInfo,
            snapshot: params.snapshot,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    // 定稿界面结算只由携带 immutable snapshot 的 FINALIZE_COMPLETE 完成；不要在
    // workflow onComplete 中重新读 DB 并打开/覆盖旧 tab。
    onComplete: { mode: 'silent', message: `第${params.chapterNumber}章已定稿。` },
  }
}

/**
 * 修复定稿后处理工作流 — 当定稿后的三路推演失败时可重跑
 * 从 manuscript/ 读取已定稿内容，重新执行 FinalizeChapterCommand 的后处理部分
 */
export function createRepairFinalizeWorkflow(
  chapterNumber: number,
  projectPath: string,
  sourceProjectSession: ProjectSessionContext,
): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    projectPath,
    projectSession: workflowProjectSession(projectPath, sourceProjectSession),
    resourceKeys: finalizeWriteResourceKeys(chapterNumber),
    readResourceKeys: CHAPTER_CONTEXT_READ_RESOURCE_KEYS,
    title: `修复后处理 — 第${chapterNumber}章`,
    steps: [
      {
        name: '重建后处理',
        description: '从定稿正文重新生成章节要点、连续性事实和角色状态',
        executor: async (_step, context, callbacks) => {
          const { useProjectStore } = await import('../../stores/project-store')
          const { ipc } = await import('../ipc-client')
          const { projectSessionContextFromProject, sameProjectSessionContext } = await import('../../shared/project-session-context')
          const { requireWorkflowProjectSession } = await import('./workflow-project-session')
          const projectSession = requireWorkflowProjectSession(context)
          const project = useProjectStore.getState().currentProject
          if (!project || !sameProjectSessionContext(projectSession, projectSessionContextFromProject(project))) {
            throw new Error('当前项目已切换，修复已停止')
          }

          // 使用数据库定稿源
          const draftMeta = await ipc.invokeWithProjectSession(
            projectSession,
            'db:draft-get-finalized',
            chapterNumber,
            projectPath,
          )
          if (!draftMeta) throw new Error(`第 ${chapterNumber} 章的定稿记录未获取到`)
          const full = await ipc.invokeWithProjectSession(projectSession, 'db:draft-get-full', draftMeta.id, projectPath)
          if (!full) throw new Error(`正文提取失败: ID=${draftMeta.id}`)

          // 从数据库蓝图读取正式标题
          let chapterTitle = `第${chapterNumber}章`
          let chapterEntities: string[] = []
          try {
            const bp = await ipc.invokeWithProjectSession(projectSession, 'db:blueprint-get', chapterNumber, projectPath)
            if (bp?.title) chapterTitle = bp.title
            if (Array.isArray(bp?.characters)) chapterEntities = bp.characters
          } catch { /* 蓝图读取失败时使用默认标题 */ }

          // 修复运行也冻结一次模型租约，全部 LLM 后处理共享一个预算。
          const { RunFinalizePostProcessCommand } = await import('./commands/finalize-chapter.command')
          await new RunFinalizePostProcessCommand({
            project,
            chapterNumber,
            chapterTitle,
            draftContent: full.content,
            draftId: draftMeta.id,
            sourceLabel: `第${chapterNumber}章定稿`,
            onlyFailed: false,
            chapterEntities,
          }).execute({ step: {}, context, callbacks })

          // 后处理修复不会产生新定稿快照，只请求项目资源刷新。
          const { globalEventBus } = await import('../../shared/event-bus')
          globalEventBus.emit('REFRESH_RESOURCE', {
            resources: ['fileTree', 'characterCards', 'drafts'],
            projectPath,
            projectSession,
          })
        },
      },
    ],
      onComplete: { mode: 'open', message: `第${chapterNumber}章后处理修复完成` },
  }
}
