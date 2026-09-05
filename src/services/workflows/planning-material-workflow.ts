import { globalEventBus } from '../../shared/event-bus'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
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
        description: text('只生成资料中的明确事实，确认前不写入角色名单', 'Generate only explicit facts without changing the roster before confirmation'),
        executor: async (step, context, callbacks) => {
          const { ExtractPlanningMaterialCharactersCommand } = await import('./commands/planning-material.command')
          return new ExtractPlanningMaterialCharactersCommand(materials).execute({ step, context, callbacks })
        },
      },
      {
        name: text('确认并导入角色卡', 'Confirm and import character cards'),
        description: text('把已确认候选原子合并到角色名单，并保留作者手工字段', 'Atomically merge confirmed candidates while preserving author-edited fields'),
        executor: async (step, context, callbacks) => {
          const { CommitPlanningMaterialCharactersCommand } = await import('./commands/planning-material.command')
          await new CommitPlanningMaterialCharactersCommand().execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: {
      mode: 'silent',
      message: text('创作资料角色卡已导入', 'Character cards from the planning material were imported'),
    },
  }
}
