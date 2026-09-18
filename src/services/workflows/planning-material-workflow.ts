import { globalEventBus } from '../../shared/event-bus'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { CharacterRosterEntry } from '../../shared/character-roster'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { localize } from '../../i18n/core'
import type { Locale } from '../../i18n/types'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { workflowResourceKey, type WorkflowDefinition } from '../../stores/workflow-store'
import { importPlanningMaterial, type PlanningMaterial } from '../knowledge-service'

export interface PlanningMaterialWorkflowParams {
  projectSession: ProjectSessionContext
  materials: readonly PlanningMaterial[]
}

export interface PlanningMaterialCharacterWorkflowParams extends PlanningMaterialWorkflowParams {
  generationModelId: string
  /**
   * 提取完成后的**唯一交付口**（方案 A）。
   *
   * 工作流只负责提取；候选的去留由作者在 CharacterCardCandidateDialog 里决定。
   * 这个回调必须由调用方提供并弹出预览确认面板 —— 旧实现把「确认」写成工作流的
   * 第二步，结果作者既看不到候选内容、也没有勾选机会，工作流还照样报成功。
   *
   * 传空数组是合法结果：资料里确实没有明确角色。调用方必须据此给出中性提示，
   * 而不是把「0 条」当成「导入成功」。
   */
  onCandidatesReady: (candidates: readonly CharacterRosterEntry[]) => void
}

export function createPlanningMaterialWorkflow(
  params: PlanningMaterialWorkflowParams,
  uiLocale: Locale = useLocaleStore.getState().locale,
): WorkflowDefinition {
  const text = (zhCNText: string, enUSText: string) => localize(uiLocale, zhCNText, enUSText)
  if (!sameProjectSessionContext(
    params.projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) throw new Error(text(
    '当前项目已切换，无法导入创作资料',
    'The project changed, so the planning material cannot be imported.',
  ))
  const projectSession = Object.freeze({ ...params.projectSession })
  const materials = params.materials.map(material => Object.freeze({ ...material }))

  return {
    type: 'post_process',
    title: text('导入创作资料', 'Import planning material'),
    projectPath: projectSession.projectPath,
    projectSession,
    uiLocale,
    steps: [
      {
        name: text('写入项目知识库', 'Add to project knowledge'),
        description: text('保留作者原始资料，供后续写作检索', 'Preserve the source material for later writing retrieval'),
        executor: async (_step, context, callbacks) => {
          for (const [index, material] of materials.entries()) {
            const result = await importPlanningMaterial(projectSession, material)
            if (!result.success) throw new Error(result.error || text(
              `无法导入 ${material.fileName}`,
              `Could not import ${material.fileName}`,
            ))
            callbacks.log(text(
              `已导入 ${material.fileName}`,
              `Imported ${material.fileName}`,
            ))
            callbacks.setProgress(Math.round(((index + 1) / materials.length) * 100))
          }
          globalEventBus.emit('REFRESH_RESOURCE', {
            resources: ['all'],
            projectPath: context.projectPath,
            projectSession,
          })
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: text('创作资料已导入本地知识库', 'Planning material was imported into the local knowledge base'),
    },
  }
}

export function createPlanningMaterialCharacterExtractionWorkflow(
  params: PlanningMaterialCharacterWorkflowParams,
  uiLocale: Locale = useLocaleStore.getState().locale,
): WorkflowDefinition {
  const text = (zhCNText: string, enUSText: string) => localize(uiLocale, zhCNText, enUSText)
  if (!sameProjectSessionContext(
    params.projectSession,
    projectSessionContextFromProject(useProjectStore.getState().currentProject),
  )) throw new Error(text(
    '当前项目已切换，无法提取角色卡',
    'The project changed, so character cards cannot be extracted.',
  ))
  const generationModelId = params.generationModelId.trim()
  if (!generationModelId) throw new Error(text(
    '缺少已确认的生成模型',
    'No confirmed generation model is available.',
  ))
  const projectSession = Object.freeze({ ...params.projectSession })
  const materials = params.materials.map(material => Object.freeze({ ...material }))
  const onCandidatesReady = params.onCandidatesReady

  /** 候选只在本次执行里流转；完成回调靠这个闭包取到它们。 */
  let extracted: CharacterRosterEntry[] = []

  return {
    type: 'post_process',
    title: text('从创作资料提取角色卡', 'Extract character cards from planning material'),
    projectPath: projectSession.projectPath,
    projectSession,
    generationModelId,
    uiLocale,
    resourceKeys: [workflowResourceKey('character-roster')],
    steps: [
      {
        name: text('生成待确认角色卡', 'Generate character-card candidates'),
        description: text(
          '只生成资料中的明确事实，确认前不写入角色名单',
          'Generate only explicit facts without changing the roster before confirmation',
        ),
        executor: async (step, context, callbacks) => {
          const { ExtractPlanningMaterialCharactersCommand, readExtractedCharacterCandidates } = await import(
            './commands/planning-material.command'
          )
          const preview = await new ExtractPlanningMaterialCharactersCommand(materials)
            .execute({ step, context, callbacks })
          // 只读回候选，绝不在这里写库 —— 写入是作者的确认动作，不是工作流的。
          extracted = readExtractedCharacterCandidates(context)
          return preview
        },
      },
    ],
    onComplete: {
      /**
       * 必须是 'open'：workflow-store 只在 mode === 'open' 时调用 openResult。
       * 写成 'silent' 会让候选连一个预览入口都没有 —— 那正是旧实现的病灶：
       * 工作流跑完、界面报成功，而作者从未被问过一句。
       */
      mode: 'open',
      message: text('角色卡候选已生成，等你确认', 'Character-card candidates are ready for review'),
      openResult: () => { onCandidatesReady(Object.freeze([...extracted])) },
    },
  }
}
