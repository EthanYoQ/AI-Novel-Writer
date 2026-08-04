import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import type { WorkflowContext } from '../../../stores/workflow-store'
import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'
import { getPromptTemplate } from '../../prompt-templates'
import { PostProcessPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { requireIpcSuccess } from '../../ipc-result'
import { commitFinalizationSnapshot } from '../../finalization-client'
import type { FinalizationSnapshot } from '../../finalization-snapshot'
import {
  projectSessionContextFromProject,
  sameProjectSessionContext,
} from '../../../shared/project-session-context'

import {
  runPostProcessPipeline,
  getChapterFinalizeScope,
  stripThinkingTags,
  type PostProcessStep,
} from '../workflow-utils'
import type { ChapterInfo } from '../chapter-workflow'
import { readWorkflowDraftMeta } from '../workflow-draft-meta'
import { requireWorkflowProjectSession } from '../workflow-project-session'

export interface FinalizeChapterParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  chapterInfo: ChapterInfo
  /** 批量任务中任一后处理失败即停止，不再继续后续章节 */
  stopOnPostProcessFailure?: boolean
  /** 标记定稿来源，避免批量任务触发单章的自动打开下一章对话框 */
  eventSource?: 'manual' | 'batch'
  /** 手动定稿由 DraftEditor 在确认时冻结；batch 则在 workflow session 内构造同等快照。 */
  snapshot?: FinalizationSnapshot
}

// ===== 工具函数：流式调用大模型并返回完整文本 =====

/**
 * 使用 PromptBuilder 调用 LLM（不依赖 BaseWorkflowCommand 实例）
 * 独立函数，可被 PostProcessStep 的 executor 直接调用
 */
async function callLLMForPostProcess(
  builder: { build: () => string; getSystemRole: () => string },
  callbacks: { appendText: (text: string) => void },
  options?: { responseFormat?: { type: string } },
  context?: WorkflowContext,
): Promise<string> {
  if (context?.cancelled) throw new Error('工作流已取消')
  const llmStore = useLLMStore.getState()
  if (!llmStore.defaultModelId) throw new Error('未配置默认 AI 模型')

  return new Promise<string>((resolve, reject) => {
    let fullContent = ''
    let streamRequestId = ''
    let cancelCheckTimer: ReturnType<typeof setInterval> | null = null
    const cleanup = () => {
      if (cancelCheckTimer) {
        clearInterval(cancelCheckTimer)
        cancelCheckTimer = null
      }
    }
    if (context) {
      cancelCheckTimer = setInterval(() => {
        if (context.cancelled && streamRequestId) {
          cleanup()
          llmStore.cancelGeneration(streamRequestId).catch(() => {})
          reject(new Error('工作流已取消'))
        }
      }, 200)
    }
    llmStore.generateStream(
      [
        { role: 'system', content: builder.getSystemRole() },
        { role: 'user', content: builder.build() },
      ],
      {
        onChunk: (chunk) => {
          if (context?.cancelled) return
          fullContent += chunk
          callbacks.appendText(chunk)
        },
        onDone: (text) => {
          cleanup()
          if (context?.cancelled) {
            reject(new Error('工作流已取消'))
            return
          }
          const raw = text || fullContent
          resolve(stripThinkingTags(raw))
        },
        onError: (err) => {
          cleanup()
          reject(new Error(err || '流式生成失败'))
        },
      },
      undefined,
      {
        ...options,
        purpose: 'post-process',
        projectSession: context?.projectSession,
      },
    ).then((requestId) => {
      streamRequestId = requestId
      if (context?.cancelled) {
        llmStore.cancelGeneration(requestId).catch(() => {})
        cleanup()
        reject(new Error('工作流已取消'))
      }
    }).catch((error) => {
      cleanup()
      reject(error)
    })
  })
}

/** 容错 JSON 解析（剥离 Markdown 代码块 + 自动截取有效 JSON 边界） */
function parseJSON<T>(text: string): T {
  let cleanText = text.replace(/```json?\n?/gi, '').replace(/```\n?/gi, '').trim()
  const firstBrace = cleanText.indexOf('{')
  const lastBrace = cleanText.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleanText = cleanText.substring(firstBrace, lastBrace + 1)
  }
  return JSON.parse(cleanText) as T
}

// ===== 后处理步骤构建器 =====

/**
 * 构建章节定稿后处理步骤列表
 *
 * 每个步骤都是独立的 PostProcessStep，由 runPostProcessPipeline
 * 统一调度执行、持久化状态、支持单步重试。
 * 导出供 createRepairFinalizeWorkflow 复用。
 *
 * @param project       当前项目信息
 * @param chapterNumber 章节号
 * @param chapterTitle  章节标题
 * @param draftContent  定稿正文内容
 */
export function buildFinalizePostProcessSteps(
  _project: { path: string },
  chapterNumber: number,
  chapterTitle: string,
  draftContent: string,
): PostProcessStep[] {
  const steps: PostProcessStep[] = []

  // ─── 步骤 1: 导入知识库 ───────────────────────────────────────────
  steps.push({
    key: 'kb_import',
    label: '导入知识库',
    critical: true,
    executor: async (callbacks, context) => {
      if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
      if (context.cancelled) throw new Error('工作流已取消')
      const projectSession = requireWorkflowProjectSession(context)
      const contentFileName = chapterTitle
        ? `第${chapterNumber}章 ${chapterTitle}.txt`
        : `chapter_${chapterNumber}.txt`
      const result = await ipc.invokeWithProjectSession(
        projectSession,
        'kb:import-text',
        draftContent,
        contentFileName,
        _project.path,
      ) as { success: boolean; error?: string; chunkCount?: number }
      requireIpcSuccess(result, '导入知识库')
      callbacks.log(`正文章节已导入知识库（${result.chunkCount} 块）`)
    },
  })

  // ─── 步骤 2: 本章剧情要点提取 ─────────────────────────────────────
  steps.push({
      key: 'chapter_notes',
      label: '章节剧情要点',
      critical: true,
      executor: async (callbacks, context) => {
        if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
        if (context.cancelled) throw new Error('工作流已取消')
        const projectSession = requireWorkflowProjectSession(context)
        const notesTemplate = getPromptTemplate('generate_chapter_notes', projectSession)
        if (!notesTemplate) throw new Error('未找到章节要点模板')
        const notesBuilder = new PostProcessPromptBuilder(notesTemplate)
          .withChapterContent(draftContent)
          .withChapterNumber(chapterNumber)
          .withChapterTitle(chapterTitle)

        const cleanNotes = await callLLMForPostProcess(notesBuilder, callbacks, undefined, context)
        if (context?.cancelled) throw new Error('工作流已取消')

        // 写入蓝图 JSON 的 notes 字段
        if (context?.cancelled) throw new Error('工作流已取消')
        const result = await ipc.invokeWithProjectSession(
          projectSession,
          'db:blueprint-update-notes',
          chapterNumber,
          cleanNotes,
          _project.path,
        )
        requireIpcSuccess(result, '写入章节剧情要点')
        callbacks.log('本章剧情要点提取完成（已写入蓝图）')
      },
    })

  // ─── 步骤 3: 角色状态更新 ────────────────────────────────────────
  steps.push({
      key: 'character_cards',
      label: '角色状态更新',
      critical: false,
      executor: async (callbacks, context) => {
        if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
        if (context.cancelled) throw new Error('工作流已取消')
        const projectSession = requireWorkflowProjectSession(context)
        const cardTemplate = getPromptTemplate('update_character_cards', projectSession)
        if (!cardTemplate) throw new Error('未找到角色状态模板')
        // 读取现有角色卡
        const allChars = (await ipc.invokeWithProjectSession(
          projectSession,
          'db:character-get-all',
          _project.path,
        )) as unknown as Array<Record<string, unknown>>
        if (context?.cancelled) throw new Error('工作流已取消')
        const simpleCards = allChars.map((c) => ({ name: c.name, role: c.role }))

        const cardBuilder = new PostProcessPromptBuilder(cardTemplate)
          .withChapterContent(draftContent.slice(0, 5000))
          .withChapterNumber(chapterNumber)
          .withExistingCardsJson(simpleCards)

        const cardsResult = await callLLMForPostProcess(
          cardBuilder,
          callbacks,
          { responseFormat: { type: 'json_object' } },
          context,
        )
        if (context?.cancelled) throw new Error('工作流已取消')
        type LLMUpdateState = {
          location?: string
          powerLevel?: string
          physicalState?: string
          mentalState?: string
          keyItems?: string
          recentEvents?: string
        }

        const cardUpdates = parseJSON<{
          updates?: Array<{ name: string; currentState: LLMUpdateState }>
          newCharacters?: Array<{ name: string; role: string; currentState: LLMUpdateState }>
        }>(cardsResult)

        if (cardUpdates.updates && Array.isArray(cardUpdates.updates)) {
          for (const upd of cardUpdates.updates) {
            if (context?.cancelled) throw new Error('工作流已取消')
            const dbChar = allChars.find((c) => c.name === upd.name)
            if (dbChar && upd.currentState) {
              const cs = upd.currentState
              const dbCharState = (dbChar.currentState as Record<string, unknown>) || {}
              const newState = {
                location: cs.location || (dbCharState.location as string) || '',
                powerLevel: cs.powerLevel || (dbCharState.powerLevel as string) || '',
                physicalState: cs.physicalState || (dbCharState.physicalState as string) || '',
                mentalState: cs.mentalState || (dbCharState.mentalState as string) || '',
                keyItems: cs.keyItems || (dbCharState.keyItems as string) || '',
                recentEvents: cs.recentEvents || '',
                updatedAtChapter: chapterNumber,
              }
              const result = await ipc.invokeWithProjectSession(
                projectSession,
                'db:character-update-state',
                upd.name,
                newState,
                _project.path,
              )
              requireIpcSuccess(result, `更新角色 ${upd.name}`)
              callbacks.log(`更新角色动态状态: ${dbChar.name}`)
            }
          }
        }

        if (cardUpdates.newCharacters && Array.isArray(cardUpdates.newCharacters)) {
          let newCharCount = 0
          for (const newChar of cardUpdates.newCharacters) {
            if (context?.cancelled) throw new Error('工作流已取消')
            if (allChars.some((c) => c.name === newChar.name)) continue
            const cs = newChar.currentState || {}
            const result = await ipc.invokeWithProjectSession(projectSession, 'db:character-upsert', {
              name: newChar.name,
              role: newChar.role || 'supporting',
              gender: '', age: '', appearance: '', personality: '', background: '',
              abilities: '', motivation: '', relationships: '', arc: '', notes: '',
              currentState: {
                location: cs.location || '',
                powerLevel: cs.powerLevel || '',
                physicalState: cs.physicalState || '',
                mentalState: cs.mentalState || '',
                keyItems: cs.keyItems || '',
                recentEvents: cs.recentEvents || '',
                updatedAtChapter: chapterNumber,
              }
            }, _project.path)
            requireIpcSuccess(result, `登记角色 ${newChar.name}`)
            newCharCount++
          }
          if (newCharCount > 0) {
            callbacks.log(`自动提取并登记 ${newCharCount} 名新出场角色`)
          }
        }
      },
    })

  // ─── 步骤 4: 文风自动学习（每5章触发一次）─────────────────────────
  if (chapterNumber % 5 === 0) {
    steps.push({
      key: 'style_analysis',
      label: '文风自动学习',
      critical: false,
      executor: async (callbacks, context) => {
        if (!context) throw new Error('定稿后处理缺少冻结工作流上下文')
        if (context.cancelled) throw new Error('工作流已取消')
        callbacks.log('触发文风自动学习（每5章一次）...')
        const { AnalyzeWritingStyleCommand } = await import('./analyze-style.command')
        await new AnalyzeWritingStyleCommand().execute({
          step: {} as unknown,
          context,
          callbacks,
        })
        callbacks.log('文风分析完成，已更新配置')
      },
    })
  }

  return steps
}

// ===== 定稿命令 =====

export class FinalizeChapterCommand extends BaseWorkflowCommand<void> {
  constructor(private params: FinalizeChapterParams) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) {
      throw new Error('项目已切换，已停止对原项目的定稿操作')
    }

    callbacks.log('\n===== 开始定稿与后处理分析 =====')

    const snapshot = this.params.snapshot ?? await this.createBatchSnapshot(context, project.path)
    if (snapshot.projectPath !== project.path) {
      throw new Error('定稿快照属于已切换的项目会话')
    }
    const refinedDraftText = snapshot.content
    if (!refinedDraftText) throw new Error('没有定稿内容')

    // SQLite 正文、状态和 publication outbox 由主进程在一个事务内提交。这里绝不
    // 再读取旧数据库正文，也不以 renderer 路径写实体稿。
    this.assertNotCancelled(context)
    const commit = await commitFinalizationSnapshot(snapshot)
    if (!commit.committed || !commit.finalizationId || !commit.contentHash || commit.draftId === undefined) {
      throw new Error(commit.error || '定稿事务未提交')
    }

    // 事实已提交就立即通知 reconciliation；即使实体稿或后处理随后失败，也绝不
    // 将数据库定稿回滚为 draft，更不能让旧完成结果覆盖后续编辑。
    const { globalEventBus } = await import('../../../shared/event-bus')
    globalEventBus.emit('FINALIZE_COMPLETE', {
      tabId: snapshot.tabId,
      chapterNumber: snapshot.chapterNumber,
      chapterTitle: snapshot.chapterTitle,
      projectPath: snapshot.projectPath,
      projectSession: snapshot.projectSession,
      draftId: commit.draftId,
      finalizationId: commit.finalizationId,
      contentHash: commit.contentHash,
      contentRevision: commit.contentRevision ?? snapshot.contentRevision,
      snapshotContent: snapshot.content,
      publicationStatus: commit.publicationStatus ?? 'pending',
      source: this.params.eventSource ?? 'manual',
    })
    if (!commit.success) {
      callbacks.log(commit.error || '定稿已提交、实体稿待发布')
      throw new Error(commit.error || '定稿已提交、实体稿待发布')
    }
    callbacks.log(`定稿内容已提交到 SQLite 并发布实体稿（第${snapshot.chapterNumber}章）`)

    // 3. 通过 PostProcessPipeline 执行后处理（状态持久化 + 支持重试）
    callbacks.log('正在启动后台大模型推演系统更新全书状态...')

    const scope = getChapterFinalizeScope(snapshot.chapterNumber)
    const sourceLabel = `第${snapshot.chapterNumber}章定稿`
    const steps = buildFinalizePostProcessSteps(
      project,
      snapshot.chapterNumber,
      snapshot.chapterTitle,
      refinedDraftText,
    )

    const postProcessStatus = await runPostProcessPipeline(project.path, scope, sourceLabel, steps, callbacks, {
      stopOnFailure: this.params.stopOnPostProcessFailure,
      cancellation: context,
      projectSession,
    })
    this.assertNotCancelled(context)

    if (this.params.stopOnPostProcessFailure) {
      const failedLabels = Object.values(postProcessStatus.steps)
        .filter((step) => !step.ok)
        .map((step) => step.label)
      if (failedLabels.length > 0) {
        throw new Error(`后处理失败，批量创作已停止：${failedLabels.join('、')}`)
      }
    }

    callbacks.log('\n第' + snapshot.chapterNumber + '章创作全流程彻底完成')
    this.assertNotCancelled(context)
    await useProjectStore.getState().refreshFileTree(project.path, undefined, projectSession)
  }

  private async createBatchSnapshot(
    context: WorkflowContext,
    projectPath: string,
  ): Promise<FinalizationSnapshot> {
    const projectSession = requireWorkflowProjectSession(context)
    const dbDraft = await readWorkflowDraftMeta(this.params.draftPath, projectPath, projectSession)
    this.assertNotCancelled(context)
    if (!dbDraft) throw new Error('内部状态流转异常：无法定位待定稿草稿')
    return Object.freeze({
      tabId: `batch:${context.runId}:${dbDraft.id}`,
      projectPath,
      projectSession: Object.freeze({ ...projectSession }),
      draftId: dbDraft.id,
      chapterNumber: this.params.chapterNumber,
      chapterTitle: this.params.chapterInfo.title,
      content: this.params.draftContent,
      contentRevision: 0,
    })
  }
}
