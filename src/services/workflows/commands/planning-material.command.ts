import { characterProposalMaterialChunks as materialChunks, parseMaterialExtraction as parseExtraction, type MaterialExtraction, type MaterialChunk } from '../../../shared/character-proposal-parser'
import type { CharacterProposalBatch } from '../../../shared/character-proposal'
import { defaultCharacterProposalRelationships, defaultCharacterProposalSelections, formatCharacterProposalPreview } from '../character-proposal-preview'
import type { MainGenerationRunHandle } from '../../generation/generation-runtime'
import { composePromptSystemRole, resolvePromptTemplate, renderPrompt } from '../../prompt-templates'
import type { PlanningMaterial } from '../../knowledge-service'
import { ipc } from '../../ipc-client'
import { characterRosterEntriesFromCards } from '../../character-roster-client'
import {
  type CharacterRosterEntry,
} from '../../../shared/character-roster'
import { CHARACTER_ROLES } from '../../../shared/character-role'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { promptLanguageText } from '../../prompt-language'
import {
  normalizeCharacterCardsForPersistence,
} from '../character-card-normalizer'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import { requireWorkflowProjectSession, workflowUiText, workflowWritingLanguage } from '../workflow-project-session'
import {
  BaseWorkflowCommand,
  injectWritingSkillIntoSession,
  type CommandExecuteParams,
  type WorkflowGenerationRuntimeDependencies,
} from './base-command'

const MATERIAL_EXTRACTION_BATCH_SIZE = 2
const PLANNING_MATERIAL_CHARACTER_CANDIDATES = 'planningMaterialCharacterCandidates'

/** Each extraction record keeps its source-local identity; equal names are not evidence of sameness. */
export function planningMaterialCharacterRecords(results: readonly MaterialExtraction[]) {
  return results.flatMap(result => result.characterCards.map((card, index) => ({
    sourceId: result.sourceId,
    selectionKey: `${result.sourceId}:character:${index + 1}`,
    rawCard: structuredClone(card),
  })))
}

export class ExtractPlanningMaterialCharactersCommand extends BaseWorkflowCommand<string> {
  constructor(
    private readonly materials: readonly PlanningMaterial[],
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<string> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params), {
      operation: 'planning-material-character-extraction', promptKeys: ['planning_material_character_extraction'], skillStages: ['planning'], output: 'structured-data',
      onRunOpened: async handle => { params.context.data.planningMaterialGenerationHandle = Object.freeze({ ...handle }) },
      authorInputs: this.materials.map((material, index) => ({ id: `planning-material:${index}`, text: JSON.stringify({ fileName: material.fileName, text: material.text }) })),
    })
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text('当前项目已切换，角色提取已停止', 'The project changed, so character extraction stopped.'))

    const chunks = materialChunks(this.materials)
    if (chunks.length === 0) {
      context.data[PLANNING_MATERIAL_CHARACTER_CANDIDATES] = []
      return text('未发现明确角色，角色名单尚未更改。', 'No explicit characters were found; the roster is unchanged.')
    }
    callbacks.log(text('正在从创作资料中提取角色卡...', 'Extracting character cards from the planning material...'))

    const template = await resolvePromptTemplate('planning_material_character_extraction', projectSession, writingLanguage)
    if (!template) throw new Error('PLANNING_MATERIAL_TEMPLATE_MISSING')

    const contract: StructuredBatchContract<MaterialChunk, MaterialExtraction> = {
      buildTask: ({ items }) => {
        const sources = items.map(item => promptLanguageText(
          writingLanguage,
          `【资料 ${item.sourceId}｜${item.fileName}】\n${item.text}`,
          `[Material ${item.sourceId} | ${item.fileName}]\n${item.text}`,
        )).join('\n\n')
        const requestedIds = items.map(item => item.sourceId)
        return {
          purpose: 'planning-material-character-extraction',
          output: 'structured-data',
          messages: [
            { role: 'system', content: composePromptSystemRole(template, writingLanguage) },
            { role: 'user', content: renderPrompt(template, { requested_ids: JSON.stringify(requestedIds), sources }, writingLanguage) },
          ],
        }
      },
      inputKey: item => item.sourceId,
      outputKey: result => result.sourceId,
      decode: parseExtraction,
      validateItem: (result) => {
        for (const card of result.characterCards) {
          if (typeof card.name !== 'string' || !card.name.trim()) return '角色卡必须包含姓名'
          if (typeof card.role !== 'string' || !CHARACTER_ROLES.some(role => role === card.role)) {
            return '角色卡必须包含合法角色定位'
          }
        }
        return undefined
      },
    }
    const generation = this.requireGenerationExecution()
    const extraction = await createStructuredBatchExecutor({
      contract,
      session: injectWritingSkillIntoSession(generation.session, context, 'planning'),
      writingLanguage,
      onAttempt: receipt => this.reportGenerationPromptBudget(callbacks, receipt),
    }).execute({
      items: chunks,
      limits: { maxBatchItems: MATERIAL_EXTRACTION_BATCH_SIZE },
      signal: generation.signal,
    })
    if (!extraction.ok) {
      const reason = extraction.failure.reason ?? 'unknown'
      throw new Error(text(
        `角色卡提取失败（code=${extraction.failure.code}；reason=${reason}）。`,
        `Character-card extraction failed (code=${extraction.failure.code}; reason=${reason}).`,
      ))
    }

    const records = planningMaterialCharacterRecords(extraction.items)
    const cards = normalizeCharacterCardsForPersistence(records.map(record => record.rawCard))
    context.data.planningMaterialCharacterRecords = records
    const entries = characterRosterEntriesFromCards(cards)
    this.assertNotCancelled(context)
    const handle = context.data.planningMaterialGenerationHandle as MainGenerationRunHandle | undefined
    const artifacts = (extraction.receipt.acceptedArtifacts ?? []).map(({ artifact }) => ({ artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash }))
    if (!handle || artifacts.length === 0) throw new Error('CHARACTER_PROPOSAL_GENERATION_ARTIFACT_REQUIRED')
    const batch = await ipc.invokeWithProjectSession(projectSession, 'character-proposal:stage', {
      source: { kind: 'generation', inputKind: 'planning-material', handle, artifacts },
    })
    context.data.planningMaterialProposalBatch = batch
    context.data[PLANNING_MATERIAL_CHARACTER_CANDIDATES] = entries
    if (cards.length === 0) {
      callbacks.log(text('未发现明确角色，角色名单尚未更改', 'No explicit characters were found; the character roster is unchanged.'))
      callbacks.setProgress(100)
      return formatCharacterProposalPreview(batch, text)
    }

    callbacks.setProgress(100)
    callbacks.log(text(
      `已生成 ${cards.length} 张待确认角色卡，角色名单尚未更改`,
      `Generated ${cards.length} character-card candidates; the character roster is unchanged.`,
    ))
    return formatCharacterProposalPreview(batch, text)
  }
}

export class CommitPlanningMaterialCharactersCommand extends BaseWorkflowCommand<void> {
  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text('当前项目已切换，角色导入已停止', 'The project changed, so character import stopped.'))

    this.assertNotCancelled(context)
    const entries = context.data[PLANNING_MATERIAL_CHARACTER_CANDIDATES] as CharacterRosterEntry[] | undefined
    if (!entries) throw new Error(text(
      '缺少已预览的角色卡候选，未写入角色名单',
      'No reviewed character-card candidates are available; the character roster was not changed.',
    ))
    if (entries.length === 0) {
      callbacks.setProgress(100)
      callbacks.log(text('没有待导入的角色卡', 'There are no character cards to import.'))
      return
    }

    const shown = context.data.planningMaterialProposalBatch as CharacterProposalBatch | undefined
    if (!shown) throw new Error('CHARACTER_PROPOSAL_PREVIEW_REQUIRED')
    if (shown.status === 'cancelled') throw new Error('CHARACTER_PROPOSAL_CANCELLED')
    if (shown.status === 'approved') return
    const result = await ipc.invokeWithProjectSession(projectSession, 'character-proposal:approve', {
      proposalBatchId: shown.proposalBatchId, expectedRevision: shown.revision,
      operationId: `planning-material-${context.runId}`,
      selections: defaultCharacterProposalSelections(shown),
      relationships: defaultCharacterProposalRelationships(shown),
    })
    context.data.planningMaterialProposalBatch = result.batch
    callbacks.setProgress(100)
    callbacks.log(text(
      `角色采用决策已保存；身份未明确的提议继续保留`,
      `Character decisions were saved; unresolved proposals remain available.`,
    ))
    this.notifyRefresh(['characterCards'], projectSession.projectPath, projectSession)
  }
}
