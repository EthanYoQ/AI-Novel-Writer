import type { WorkflowDefinition, WorkflowContext, StepCallbacks } from '../../stores/workflow-store'
import { useLLMStore } from '../../stores/llm-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { getPromptTemplate } from '../prompt-templates'
import { ipc } from '../ipc-client'
import type { NovelConfig } from '../../shared/ipc-channels'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import {
  projectSessionContextFromProject,
  sameProjectPathKey,
  sameProjectSessionContext,
} from '../../shared/project-session-context'
import type { CharacterData } from '../../../electron/repositories/character-repository'
import {
  extractCompleteCharacterCards,
  mergeExtractedCharacterCardsWithExisting,
} from './character-card-normalizer'
import { randomUUID } from '../../utils/id'

import { runPostProcessPipeline, type PostProcessStep } from './workflow-utils'
import { requireWorkflowProjectSession } from './workflow-project-session'
import type { ArchitectureProjectSnapshot } from './commands/architecture.command'

// ==========================================
// 1. 类型定义
// ==========================================

export interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  synopsis_result?: string
}

export interface ArchitectureWorkflowParams {
  /** 启动工作流时所属的项目路径；后续所有步骤均绑定此项目 */
  projectPath: string
  /** UI 在异步确认前冻结的完整项目会话。 */
  projectSession: ProjectSessionContext
  selectedSteps?: Array<'premise' | 'characters' | 'worldbuilding' | 'synopsis'>
  /** 每步的补充指导（如 { premise: "多强调金手指的限制" }） */
  stepGuidance?: Record<string, string>
}

export interface ConfigGenerationWorkflowParams {
  projectPath: string
  /** UI 在异步确认前冻结的完整项目会话。 */
  projectSession: ProjectSessionContext
  idea: string
  totalChapters: number
  wordsPerChapter: number
  onGenerated: (config: Partial<NovelConfig>) => void
}

// ==========================================
// 2. 工作流定义
// ==========================================

export function createArchitectureWorkflow(params: ArchitectureWorkflowParams): WorkflowDefinition {
  const text = useLocaleStore.getState().text
  const sel = params.selectedSteps ?? ['premise', 'characters', 'worldbuilding', 'synopsis']
  const expectedProjectPath = params.projectPath
  const project = useProjectStore.getState().currentProject
  const currentProjectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !currentProjectSession
    || !sameProjectPathKey(project.path, expectedProjectPath)
    || !sameProjectSessionContext(params.projectSession, currentProjectSession)
  ) {
    throw new Error(text('当前项目已切换，无法启动架构生成', 'The project changed, so architecture generation cannot start.'))
  }
  // 工厂在捕获配置快照的同一时刻绑定 lease，防止同路径重新打开后复用旧快照。
  const projectSession = Object.freeze({ ...params.projectSession })
  const projectSnapshot: ArchitectureProjectSnapshot = Object.freeze({
    expectedProjectPath,
    novelConfig: Object.freeze({ ...project.novelConfig }),
  })
  const stepDesc = (key: string, zhCNDesc: string, enUSDesc: string) => sel.includes(key as never)
    ? text(zhCNDesc, enUSDesc)
    : text('（跳过，保留已有内容）', '(Skipped; existing content is retained)')
  // 闭包捕获逐步指导，executor 中注入到 context.data
  const guidance = params.stepGuidance || {}

  const allSteps = [
    {
      name: text('故事前提', 'Story premise'),
      key: 'premise',
      description: stepDesc('premise', '提炼故事前提与核心卖点', 'Refine the story premise and its core appeal'),
      executor: async (step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GenerateCoreSeedCommand } = await import('./commands/architecture.command')
        return new GenerateCoreSeedCommand(projectSnapshot).execute({ step, context, callbacks })
      },
    },
    {
      name: text('角色图谱', 'Character dynamics'),
      key: 'characters',
      description: stepDesc('characters', '构建核心角色关系网与角色弧光', 'Build core character relationships and arcs'),
      executor: async (step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GenerateCharactersCommand } = await import('./commands/architecture.command')
        return new GenerateCharactersCommand(projectSnapshot).execute({ step, context, callbacks })
      },
    },
    {
      name: text('世界观', 'World building'),
      key: 'worldbuilding',
      description: stepDesc('worldbuilding', '构建自带冲突引擎的世界观矩阵', 'Build a world matrix with its own conflict engine'),
      executor: async (step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GenerateWorldBuildingCommand } = await import('./commands/architecture.command')
        return new GenerateWorldBuildingCommand(projectSnapshot).execute({ step, context, callbacks })
      },
    },
    {
      name: text('情节大纲', 'Plot outline'),
      key: 'synopsis',
      description: stepDesc('synopsis', '整合所有碎片，按选定结构模式生成情节大纲', 'Integrate all inputs into a plot outline using the selected structure'),
      executor: async (step: unknown, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GeneratePlotArchitectureCommand } = await import('./commands/architecture.command')
        return new GeneratePlotArchitectureCommand(sel, projectSnapshot).execute({ step, context, callbacks })
      },
    },
  ]

  const finalSteps = allSteps.filter(s => sel.includes(s.key as never))

  return {
    type: 'architecture_generation',
    title: text('生成故事架构', 'Generate story architecture'),
    projectPath: expectedProjectPath,
    projectSession,
    steps: finalSteps,
    onComplete: { mode: 'silent', message: text('故事架构已生成完成！前往侧边栏「故事架构」查看', 'Story architecture is ready. Open Story Architecture from the sidebar.') },
  }
}

export function createConfigGenerationWorkflow(params: ConfigGenerationWorkflowParams): WorkflowDefinition {
  const text = useLocaleStore.getState().text
  const project = useProjectStore.getState().currentProject
  const currentProjectSession = projectSessionContextFromProject(project)
  if (
    !project
    || !currentProjectSession
    || !sameProjectPathKey(project.path, params.projectPath)
    || !sameProjectSessionContext(params.projectSession, currentProjectSession)
  ) {
    throw new Error(text('当前项目已切换，无法启动配置生成', 'The project changed, so configuration generation cannot start.'))
  }
  const projectSession = Object.freeze({ ...params.projectSession })
  return {
    type: 'config_generation',
    title: text('AI 生成小说配置', 'Generate novel configuration with AI'),
    projectPath: params.projectPath,
    projectSession,
    steps: [
      {
        name: text('智能分析并填充配置', 'Analyze and fill the configuration'),
        description: text(
          `根据创作脑洞生成小说配置（全书规划约 ${params.totalChapters} 章）`,
          `Generate a novel configuration from the idea (about ${params.totalChapters} chapters total)`,
        ),
        executor: async (step, context, callbacks) => {
          const { GenerateConfigCommand } = await import('./commands/architecture.command')
          const cmd = new GenerateConfigCommand(
            params.idea,
            params.totalChapters,
            params.wordsPerChapter,
            params.onGenerated,
          )
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'silent', message: text('小说配置已自动生成完毕，请查阅确认。', 'Novel configuration is ready. Please review it.') },
  }
}

// ==========================================
// 3. 工具与指导文本
// ==========================================

export function getPlotStructureGuide(structure: string, totalChapters: number): string {
  const ch20 = Math.round(totalChapters * 0.2)
  const ch25 = Math.round(totalChapters * 0.25)
  const ch50 = Math.round(totalChapters * 0.5)
  const ch75 = Math.round(totalChapters * 0.75)

  switch (structure) {
    case 'heros_journey':
      return `【英雄之旅·十二阶段】（严格按以下阶段组织大纲）\n建议章节分配：全书共 ${totalChapters} 章...` // 为了简洁截断，后台已由架构掌控
    case 'save_the_cat':
      return `【节拍表·十五拍】（严格按以下节拍组织大纲）\n建议章节分配：全书共 ${totalChapters} 章...`
    case 'kishotenketsu':
      return `【起承转合·四段式】（严格按以下四段组织大纲）
建议章节分配：全书共 ${totalChapters} 章
起（约第1章~第${ch25}章，占总篇幅约25%）：介绍世界、角色和日常，建立读者认同
承（约第${ch25 + 1}章~第${ch50}章，占总篇幅约25%）：延续与深化，展现角色关系和冲突苗头
转（约第${ch50 + 1}章~第${ch75}章，占总篇幅约25%）：核心转折，出人意料的变化打破既有格局
合（约第${ch75 + 1}章~第${totalChapters}章，占总篇幅约25%）：收束所有线索，揭示主题，给出结局`
    case 'multi_thread':
      return `【多线叙事】（按多条故事线并行推进的方式组织大纲）
建议章节分配：全书共 ${totalChapters} 章
需要明确以下要素：
1. 主线数量：设定2-4条独立又交织的故事线，每条有独立主角或视角
2. 交汇节点：每条线在第${ch25}章、第${ch50}章、第${ch75}章左右安排交汇碰撞
3. 节奏编排：各线交替出现的节奏，避免某条线长期消失
4. 最终合流：在第${ch75}章前后所有线索开始汇聚，走向统一高潮`
    case 'freeform':
      return `【自由结构】（不限定特定叙事框架，根据故事内容自然编排）
全书共 ${totalChapters} 章。
请根据故事类型和内容特点自行设计最合适的叙事节奏。
核心原则：
1. 保证每10-20章有一个小高潮或悬念释放点
2. 全书应有清晰的开篇建置（前10-15%）和收尾段落（后10-15%）
3. 中段避免节奏单一，适时安排转折点
4. 允许插叙、倒叙、片段式叙事等灵活手法`
    case 'three_act':
    default:
      return `【三幕结构】（严格按以下结构组织大纲）
建议章节分配：全书共 ${totalChapters} 章
第一幕：建置（约第1章~第${ch20}章，占总篇幅约20%）
第二幕：对抗与发展（约第${ch20 + 1}章~第${ch75}章，占总篇幅约55%）
第三幕：高潮与结局（约第${ch75 + 1}章~第${totalChapters}章，占总篇幅约25%）`
  }
}

export function getNarrativePOVLabel(pov: string): string {
  const labels: Record<string, string> = {
    first_person: '第一人称',
    third_limited: '第三人称有限视角',
    third_omniscient: '第三人称全知视角',
    multi_pov: '多视角轮换',
  }
  return labels[pov] || pov
}

// ==========================================
// 4. 角色卡后处理逻辑
// ==========================================

export const ARCH_CHARACTER_SCOPE = 'arch_characters'

export function createCharacterExtractSteps(projectPath: string, characterDynamicsContent: string, genre: string): PostProcessStep[] {
  const text = useLocaleStore.getState().text
  return [
    {
      key: 'extract_character_cards',
      label: text('提取初始角色卡', 'Extract initial character cards'),
      critical: true,
      executor: async (cb, context) => {
        if (context?.cancelled) throw new Error(text('工作流已取消', 'Workflow cancelled'))
        if (!context) throw new Error(text('工作流缺少冻结项目会话', 'The workflow is missing its frozen project session.'))
        const projectSession = requireWorkflowProjectSession(context)
        const { ArchitecturePromptBuilder } = await import('../prompts/prompt-builder')
        const template = getPromptTemplate('extract_initial_characters', projectSession)
        if (!template) throw new Error(text('未找到 extract_initial_characters', 'Could not find extract_initial_characters'))
        const extractPrompt = new ArchitecturePromptBuilder(template).withCharacterDynamics(characterDynamicsContent).withGenre(genre).build()
        const systemRole = template.systemRole || '你是一位专业的小说数据结构化专家。'

        const llmStore = useLLMStore.getState()
        cb.appendText(text('正在调用 AI 提取角色卡片...\n', 'Calling AI to extract character cards...\n'))

        let fullContent = ''
        await new Promise<void>((resolve, reject) => {
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
                reject(new Error(text('工作流已取消', 'Workflow cancelled')))
              }
            }, 200)
          }
          llmStore.generateStream(
            [
              { role: 'system', content: systemRole },
              { role: 'user', content: extractPrompt }
            ],
            {
              onChunk: (chunk) => {
                if (context?.cancelled) return
                fullContent += chunk
                cb.appendText(chunk)
              },
              onDone: () => {
                cleanup()
                if (context?.cancelled) {
                  reject(new Error(text('工作流已取消', 'Workflow cancelled')))
                  return
                }
                resolve()
              },
              onError: (err) => {
                cleanup()
                reject(new Error(err))
              }
            },
            undefined,
            {
              responseFormat: { type: 'json_object' },
              thinking: false,
              maxTokens: 4096,
              temperature: 0.2,
              purpose: 'character-extraction',
              projectSession: context?.projectSession,
            }
          ).then((requestId) => {
            streamRequestId = requestId
            if (context?.cancelled) {
              llmStore.cancelGeneration(requestId).catch(() => {})
              cleanup()
              reject(new Error(text('工作流已取消', 'Workflow cancelled')))
            }
          }).catch((error) => {
            cleanup()
            reject(error)
          })
        })
        if (context?.cancelled) throw new Error(text('工作流已取消', 'Workflow cancelled'))

        const generatedCharacterCards = extractCompleteCharacterCards(fullContent, characterDynamicsContent)
        if (!sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )) {
          throw new Error(text(
            '项目上下文已切换，角色卡提取已停止以避免写入错误项目',
            'The project context changed, so character-card extraction stopped before saving.',
          ))
        }
        const existingCharacterCards = await ipc.invokeWithProjectSession(
          projectSession,
          'db:character-get-all',
          projectPath,
        )
        if (!sameProjectSessionContext(
          projectSession,
          projectSessionContextFromProject(useProjectStore.getState().currentProject),
        )) {
          throw new Error(text(
            '项目上下文已切换，角色卡提取已停止以避免写入错误项目',
            'The project context changed, so character-card extraction stopped before saving.',
          ))
        }
        const characterDataList = mergeExtractedCharacterCardsWithExisting(
          generatedCharacterCards,
          existingCharacterCards,
        )

        // 批量写入数据库
        if (context?.cancelled) throw new Error(text('工作流已取消', 'Workflow cancelled'))
        if (!context) throw new Error(text('角色卡后处理缺少冻结工作流上下文', 'Character-card post-processing is missing its frozen workflow context.'))
        const saveResult = await ipc.invokeWithProjectSession(
          projectSession,
          'db:character-save-all',
          characterDataList as unknown as CharacterData[],
          undefined,
          projectPath,
        )
        if (!saveResult.success) {
          throw new Error(saveResult.error || text('角色卡写入数据库失败', 'Could not save character cards to the database.'))
        }
        cb.log(text(`角色卡提取完毕（共 ${characterDataList.length} 个角色）`, `Character-card extraction complete (${characterDataList.length} characters).`))
      },
    },
  ]
}

export function runArchCharacterExtract(
  projectPath: string,
  characterDynamicsContent: string,
  genre: string,
  sourceProjectSession: ProjectSessionContext,
): string {
  const text = useLocaleStore.getState().text
  const runId = randomUUID()
  const steps = createCharacterExtractSteps(projectPath, characterDynamicsContent, genre)
  import('../../stores/workflow-store').then(async ({ useWorkflowStore }) => {
    await useWorkflowStore.getState().startWorkflow({
      runId,
      type: 'post_process',
      title: text('后处理：角色卡提取', 'Post-processing: character-card extraction'),
      projectPath,
      projectSession: sourceProjectSession,
      steps: [
        {
          name: text('提取角色卡片', 'Extract character cards'),
          description: text('从角色图谱中提取并生成角色卡片数据', 'Extract and create character-card data from character dynamics'),
          executor: async (_step, context, callbacks) => {
            const { globalEventBus } = await import('../../shared/event-bus')
            const archStatus = await runPostProcessPipeline(
              projectPath,
              ARCH_CHARACTER_SCOPE,
              text('架构-角色图谱', 'Architecture — character dynamics'),
              steps,
              callbacks,
              { cancellation: context, projectSession: requireWorkflowProjectSession(context) },
            )
            if (context.cancelled) throw new Error(text('工作流已取消', 'Workflow cancelled'))
            if (archStatus.allCriticalPassed) {
              // 角色卡提取成功 → 通过 EventBus 通知 ProjectService 刷新
              globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {
                projectPath,
                projectSession: requireWorkflowProjectSession(context),
                runId: context.runId,
              })
            } else {
              globalEventBus.emit('CHARACTER_EXTRACT_FAILED', {
                projectPath,
                projectSession: requireWorkflowProjectSession(context),
                runId: context.runId,
                error: archStatus.steps.extract_character_cards?.error,
              })
              globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {
                projectPath,
                projectSession: requireWorkflowProjectSession(context),
                runId: context.runId,
              })
            }
          },
        },
      ],
    })
  })
  return runId
}

export async function repairArchCharacterCards(projectPath: string): Promise<void> {
  const text = useLocaleStore.getState().text
  const project = useProjectStore.getState().currentProject
  const projectSession = projectSessionContextFromProject(project)
  if (!project || !projectSession || !sameProjectPathKey(project.path, projectPath)) {
    throw new Error(text('当前项目已切换，请在原项目中重试', 'The project changed. Return to the original project and try again.'))
  }
  const projectSnapshot = Object.freeze({ ...project.novelConfig })
  const core = await ipc.invokeWithProjectSession(projectSession, 'db:project-core-get', projectPath)
  if (!core?.charactersArch || core.charactersArch.length < 50) throw new Error(text('无法提取角色卡', 'Could not extract character cards.'))
  if (!sameProjectSessionContext(
    projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) throw new Error(text('当前项目已切换，请在原项目中重试', 'The project changed. Return to the original project and try again.'))

  const steps = createCharacterExtractSteps(projectPath, core.charactersArch, projectSnapshot.genre)
  const { useWorkflowStore } = await import('../../stores/workflow-store')
  const runId = randomUUID()
  await useWorkflowStore.getState().startWorkflow({
    runId,
    type: 'post_process',
    title: text('修复：角色卡提取', 'Repair: character-card extraction'),
    projectPath,
    projectSession,
    steps: [
      {
        name: text('重试角色卡提取', 'Retry character-card extraction'),
        description: text('重试失败的角色卡提取步骤', 'Retry failed character-card extraction steps'),
        executor: async (_step, context, callbacks) => {
          const { globalEventBus } = await import('../../shared/event-bus')
          const archStatus = await runPostProcessPipeline(
            projectPath,
            ARCH_CHARACTER_SCOPE,
              text('架构-角色图谱', 'Architecture — character dynamics'),
            steps,
              callbacks,
              {
                onlyFailed: true,
                cancellation: context,
                projectSession: requireWorkflowProjectSession(context),
              },
          )
          if (context.cancelled) throw new Error(text('工作流已取消', 'Workflow cancelled'))
          if (archStatus.allCriticalPassed) {
            globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {
              projectPath,
              projectSession: requireWorkflowProjectSession(context),
              runId: context.runId,
            })
          } else {
            globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {
              projectPath,
              projectSession: requireWorkflowProjectSession(context),
              runId: context.runId,
            })
          }
        },
      },
    ],
  })
}
