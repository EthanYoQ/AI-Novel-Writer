/**
 * 导入小说工作流定义
 *
 * 逆向推演全流程：
 * 步骤1: 导入参照文本 + 构建知识库（不写入用户草稿或正文）
 * 步骤2: 向量采样 + AI 推演全局配置/架构/角色
 * 步骤3: AI 从导入正文提取文风
 * 步骤4: AI 按章推演精准蓝图 + 蓝图入向量库 + 拼装轻量全局摘要
 * 步骤5: 完成后处理（刷新 UI 状态）
 */

import type { WorkflowDefinition } from '../../stores/workflow-store'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../../shared/project-session-context'
import type { ImportedChapter } from './commands/import-novel.command'
import { refreshImportDerivedFileTreeBestEffort } from './import-derived-refresh'
import { requireWorkflowProjectSession } from './workflow-project-session'

export interface ImportWorkflowParams {
  projectPath: string
  /** UI 在异步导入完成前冻结的完整项目会话。 */
  projectSession: ProjectSessionContext
  /** 拆分后的章节数据 */
  chapters: ImportedChapter[]
}

/**
 * 创建导入小说工作流
 */
export function createImportWorkflow(params: ImportWorkflowParams): WorkflowDefinition {
  const text = useLocaleStore.getState().text
  const chapterCountEn = `${params.chapters.length} ${params.chapters.length === 1 ? 'chapter' : 'chapters'}`
  const project = useProjectStore.getState().currentProject
  const currentProjectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !currentProjectSession
    || !sameProjectPathKey(project.path, params.projectPath)
    || !sameProjectSessionContext(params.projectSession, currentProjectSession)
  ) {
    throw new Error(text(
      '当前项目已切换，无法启动导入工作流',
      'The project changed, so the import workflow cannot start.',
    ))
  }
  // 导入正文 payload 与后处理均属于这个 lease；同路径重新打开也必须失效。
  const projectSession = Object.freeze({ ...params.projectSession })
  return {
    type: 'novel_import',
    title: text(
      `小说拆解与仿写（${params.chapters.length} 章）`,
      `Novel analysis and style study (${chapterCountEn})`,
    ),
    projectPath: params.projectPath,
    projectSession,
    steps: [
      // ===== 步骤 1: 导入参照文本 + 构建知识库 =====
      {
        name: text(
          '导入参照文本与构建知识库',
          'Import reference text and build the knowledge base',
        ),
        description: text(
          `将 ${params.chapters.length} 章参照文本灌入向量知识库，不写入草稿或正文`,
          `Import ${chapterCountEn} of reference text into the knowledge base without creating drafts or manuscript text`,
        ),
        executor: async (step, context, callbacks) => {
          const { ImportInitializeCommand } = await import('./commands/import-novel.command')
          const cmd = new ImportInitializeCommand(params.chapters)
          return cmd.execute({ step, context, callbacks })
        },
      },

      // ===== 步骤 2: 向量采样 + AI 推演全局设定 =====
      {
        name: text('AI 推演全局配置与架构', 'AI infers global configuration and architecture'),
        description: text(
          '通过向量检索关键片段，AI 推演小说配置、故事架构、角色卡',
          'Use vector retrieval to infer the novel configuration, story architecture, and character cards.',
        ),
        executor: async (step, context, callbacks) => {
          const { InferGlobalSettingsCommand } = await import('./commands/import-novel.command')
          const cmd = new InferGlobalSettingsCommand()
          return cmd.execute({ step, context, callbacks })
        },
      },

      // ===== 步骤 3: 从导入正文拆解文风与仿写约束 =====
      {
        name: text('AI 拆解文风与仿写指南', 'AI analyzes writing style and imitation guidance'),
        description: text(
          '从导入 TXT/Markdown 正文中提取风格档案和仿写约束，写入小说配置供后续写稿调用',
          'Extract a style profile and imitation guidance for later drafting.',
        ),
        executor: async (step, context, callbacks) => {
          const { AnalyzeWritingStyleCommand } = await import('./commands/analyze-style.command')
          const cmd = new AnalyzeWritingStyleCommand({ chapters: params.chapters })
          const style = await cmd.execute({ step, context, callbacks })
          if (!style?.trim()) {
            throw new Error(text(
              '未提取到可用文风，无法继续建立仿写约束',
              'No usable writing style was extracted, so imitation guidance cannot be created.',
            ))
          }
          return text(
            '已提取并保存风格档案与仿写指南',
            'The style profile and imitation guidance were saved.',
          )
        },
      },

      // ===== 步骤 4: AI 按章推演蓝图 + 蓝图入向量库 + 拼装摘要 =====
      {
        name: text('AI 逐章推演蓝图', 'AI infers chapter blueprints'),
        description: text(
          `逐章推演蓝图 + 蓝图要点入向量库 + 拼装全局摘要（共 ${params.chapters.length} 章）`,
          `Infer each chapter blueprint, index its notes, and build a global summary (${chapterCountEn}).`,
        ),
        executor: async (step, context, callbacks) => {
          const { InferBlueprintsPerChapterCommand } = await import('./commands/import-novel.command')
          const cmd = new InferBlueprintsPerChapterCommand()
          return cmd.execute({ step, context, callbacks })
        },
      },

      // ===== 步骤 5: 完成后处理 =====
      {
        name: text('完成后处理', 'Finish setup'),
        description: text('刷新项目状态，加载角色卡与蓝图数据', 'Refresh project state and load character cards and blueprints.'),
        executor: async (_step, context, callbacks) => {
          const workflowProjectSession = requireWorkflowProjectSession(context)
          callbacks.log(text('正在刷新项目数据...', 'Refreshing project data...'))
          callbacks.setProgress(30)

          // 派生 UI 文件树刷新不能阻塞后处理中的角色与草稿刷新。
          await refreshImportDerivedFileTreeBestEffort(
            () => useProjectStore.getState().refreshFileTree(
              workflowProjectSession.projectPath,
              undefined,
              workflowProjectSession,
            ),
            callbacks,
          )

          // 加载角色卡
          try {
            const { useCharacterStore } = await import('../../stores/character-store')
            await useCharacterStore.getState().loadCharacters(
              workflowProjectSession.projectPath,
              workflowProjectSession,
            )
          } catch { /* 忽略 */ }

          // 加载草稿索引
          try {
            const { useDraftStore } = await import('../../stores/draft-store')
            await useDraftStore.getState().loadAllDrafts(
              workflowProjectSession.projectPath,
              workflowProjectSession,
            )
          } catch { /* 忽略 */ }

          callbacks.log(text(
            '小说拆解与仿写准备完成，结构化数据已就位。',
            'Novel analysis and style study are ready; structured data is in place.',
          ))
          callbacks.setProgress(100)
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: text(
        '小说拆解与仿写准备完成，全部结构化数据已生成，可以开始续写。',
        'Novel analysis and style study is ready. You can start writing.',
      ),
    },
  }
}

/**
 * 预估导入的 Token 消耗
 * @param totalWords 总字数
 * @param chapterCount 章节数
 * @returns 预估信息
 */
export function estimateImportCost(_totalWords: number, chapterCount: number): {
  estimatedTokens: number
  estimatedMinutes: number
  breakdown: string
} {
  // 粗略预估（偏保守）：
  // 1. 全局推演：首章+末章(约6000字) × 2(输入+输出) ≈ 12000 tokens
  // 2. 按章蓝图：每章正文(平址3000字) + 蓝图输出(约500字) ≈ 3500 tokens/章
  // 3. 全局摘要：从蓝图拼装，零 LLM 调用
  // 4. 知识库向量化不计入 LLM Token

  const globalInferTokens = 15000
  const blueprintTokensPerChapter = 4000
  const totalBlueprintTokens = blueprintTokensPerChapter * chapterCount

  const estimatedTokens = globalInferTokens + totalBlueprintTokens

  // 预估时间（假设每次 LLM 调用约 8-15 秒，并发 3）
  const llmCallCount = 1 + Math.ceil(chapterCount / 3) // 全局推演 + 蓝图批次
  const estimatedMinutes = Math.ceil(llmCallCount * 12 / 60) // 按每次 12 秒计算

  const breakdown = [
    `· 全局推演：~${(globalInferTokens / 1000).toFixed(0)}K tokens`,
    `· 蓝图推演：~${(totalBlueprintTokens / 1000).toFixed(0)}K tokens（${chapterCount} 章 × ${(blueprintTokensPerChapter / 1000).toFixed(1)}K）`,
    `· 全局摘要：零消耗（从蓝图拼装）`,
    `· 总计：~${(estimatedTokens / 1000).toFixed(0)}K tokens`,
  ].join('\n')

  return { estimatedTokens, estimatedMinutes, breakdown }
}
