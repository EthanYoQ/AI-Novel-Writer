/**
 * 导入小说 — Command 集合
 *
 * 两个独立 Command 组成逆向推演生成阶段：
 * 1. InferGlobalSettingsCommand — 向量采样 + AI 推演全局配置/架构/角色
 * 2. InferBlueprintsPerChapterCommand — 按章逐一推演精准蓝图 + 蓝图入向量库 + 拼装轻量全局摘要
 */

import { BaseWorkflowCommand, CommandExecuteParams, type WorkflowGenerationRuntimeDependencies } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ImportPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { unwrapKnowledgeValue } from '../../knowledge-service'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../../shared/project-session-context'
import {
  requireWorkflowProjectSession,
  workflowUiText,
  workflowWritingLanguage,
} from '../workflow-project-session'
import { promptLanguageText } from '../../prompt-language'
import { createStructuredBatchExecutor, type StructuredBatchContract } from '../structured-batch-executor'
import type { ChapterBlueprint } from '../directory-workflow'
import { retryDirectoryCharacterSync } from '../directory-character-sync-recovery'
import type {
  BlueprintRangeCommitReceipt,
  BlueprintRangeCommitRequest,
} from '../../../../electron/repositories/blueprint-repository'
import {
  blueprintSemanticGenerationContract,
  parseBlueprintSemanticResponseText,
  validateBlueprintSemanticItem,
} from '../../../shared/blueprint-semantic-contract'
import {
  importInferenceJsonContract,
  type ImportInferenceResult,
  decodeImportInferenceJson,
  parseImportInferenceJsonObject,
} from './import-inference-contract'
import { StructuredContractDiagnostic } from '../../../shared/structured-contract-diagnostic'
import type {
  ImportGlobalFactsReceipt,
  ImportGlobalFactsRequest,
} from '../../../shared/import-global-facts'
import {
  buildStructuredSyntaxRepairTask,
  isRepairableDirectJsonSyntaxFailure,
  MAX_STRUCTURED_REPAIR_CANDIDATE_UTF8_BYTES,
  MAX_STRUCTURED_REPAIR_CONTRACT_UTF8_BYTES,
  preservesStructuredJsonEvidence,
  structuredRepairUtf8Bytes,
} from '../structured-syntax-repair'

/** 拆分后的章节数据（从 context.data 中传递） */
export interface ImportedChapter {
  number: number
  title: string
  content: string
  wordCount: number
}

const SHA256_HEX = /^[a-f0-9]{64}$/u
const MAX_IMPORT_INFERENCE_CHARACTER_CARDS = 8
const IMPORT_ENDPOINT_DELTA_CARD_KEYS = [
  'abilities',
  'age',
  'appearance',
  'arc',
  'background',
  'currentState',
  'gender',
  'motivation',
  'name',
  'notes',
  'personality',
  'relationships',
  'role',
] as const
const IMPORT_ENDPOINT_DELTA_CURRENT_STATE_KEYS = [
  'keyItems',
  'location',
  'mentalState',
  'physicalState',
  'powerLevel',
  'recentEvents',
  'updatedAtChapter',
] as const
const IMPORT_ENDPOINT_DELTA_RELATIONSHIP_KEYS = ['relation', 'target'] as const
type UiText = (zhCNText: string, enUSText: string) => string

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepJsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => deepJsonEqual(value, right[index]))
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (!deepJsonEqual(leftKeys, rightKeys)) return false
    return leftKeys.every(key => deepJsonEqual(left[key], right[key]))
  }
  return false
}

function importInferenceCards(root: Record<string, unknown>, text: UiText): Array<Record<string, unknown>> {
  const cards = root.characterCards
  if (!Array.isArray(cards) || !cards.every(isRecord)) {
    throw new Error(text(
      '导入推演受限补卡校正缺少可比较的原始角色卡',
      'The bounded import correction is missing comparable original character cards.',
    ))
  }
  return cards
}

function assertExactImportEndpointDeltaKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  path: string,
  text: UiText,
): void {
  const actualKeys = Object.keys(value).sort()
  const sortedExpectedKeys = [...expectedKeys].sort()
  if (!deepJsonEqual(actualKeys, sortedExpectedKeys)) {
    throw new Error(text(
      `导入推演受限补卡校正 delta ${path} 包含缺失或额外字段`,
      `The bounded import correction delta at ${path} has missing or extra fields.`,
    ))
  }
}

function unresolvedImportRelationshipTargets(root: Record<string, unknown>, text: UiText): string[] {
  const cards = importInferenceCards(root, text)
  const names = new Set(cards.map(card => card.name).filter((name): name is string => typeof name === 'string'))
  const unresolved = new Set<string>()
  for (const card of cards) {
    const cardName = typeof card.name === 'string' ? card.name : undefined
    const relationships = card.relationships
    if (!Array.isArray(relationships)) continue
    for (const relationship of relationships) {
      if (!isRecord(relationship) || typeof relationship.target !== 'string') continue
      if (relationship.target !== cardName && !names.has(relationship.target)) unresolved.add(relationship.target)
    }
  }
  if (unresolved.size === 0) {
    throw new Error(text(
      '导入推演受限补卡校正缺少未闭合的关系端点',
      'The bounded import correction has no unresolved relationship endpoint.',
    ))
  }
  return [...unresolved]
}

function parseImportEndpointCorrectionDelta(
  content: string,
  unresolvedTargets: readonly string[],
  text: UiText,
): Array<Record<string, unknown>> {
  const deltaRoot = parseImportInferenceJsonObject(content)
  assertExactImportEndpointDeltaKeys(deltaRoot, ['characterCards'], '$', text)
  const deltaCards = importInferenceCards(deltaRoot, text)
  if (deltaCards.length !== unresolvedTargets.length) {
    throw new Error(text(
      '导入推演受限补卡校正只能新增缺失关系端点角色',
      'The bounded import correction may add only characters required by missing relationship endpoints.',
    ))
  }
  for (const [index, deltaCard] of deltaCards.entries()) {
    const path = `characterCards[${index}]`
    assertExactImportEndpointDeltaKeys(deltaCard, IMPORT_ENDPOINT_DELTA_CARD_KEYS, path, text)
    if (isRecord(deltaCard.currentState)) {
      assertExactImportEndpointDeltaKeys(
        deltaCard.currentState,
        IMPORT_ENDPOINT_DELTA_CURRENT_STATE_KEYS,
        `${path}.currentState`,
        text,
      )
    }
    const relationships = deltaCard.relationships
    if (Array.isArray(relationships)) {
      relationships.forEach((relationship, relationshipIndex) => {
        if (isRecord(relationship)) {
          assertExactImportEndpointDeltaKeys(
            relationship,
            IMPORT_ENDPOINT_DELTA_RELATIONSHIP_KEYS,
            `${path}.relationships[${relationshipIndex}]`,
            text,
          )
        }
      })
    }
  }
  const expectedAddedNames = new Set(unresolvedTargets)
  const addedNames = deltaCards.map(card => card.name)
  if (addedNames.some(name => typeof name !== 'string' || !expectedAddedNames.has(name))) {
    throw new Error(text(
      '导入推演受限补卡校正新增角色必须精确匹配原始未闭合关系端点',
      'Characters added by the bounded import correction must exactly match the original unresolved endpoints.',
    ))
  }
  if (new Set(addedNames).size !== addedNames.length) {
    throw new Error(text(
      '导入推演受限补卡校正 delta 包含重复缺失关系端点角色',
      'The bounded import correction delta contains duplicate missing-endpoint characters.',
    ))
  }
  if (addedNames.length !== expectedAddedNames.size) {
    throw new Error(text(
      '导入推演受限补卡校正 delta 缺失关系端点角色',
      'The bounded import correction delta omits a missing-endpoint character.',
    ))
  }
  return deltaCards
}

function requireImportGlobalFactsReceipt(
  candidate: ImportGlobalFactsReceipt | undefined,
  operationId: string,
  expectedCharacterCount: number,
  text: UiText,
): ImportGlobalFactsReceipt {
  if (
    !candidate
    || candidate.operationId !== operationId
    || !SHA256_HEX.test(candidate.payloadHash)
    || typeof candidate.idempotent !== 'boolean'
    || !candidate.core
    || !candidate.roster?.snapshot
    || candidate.roster.snapshot.status !== 'ready'
    || candidate.roster.snapshot.entries.length !== expectedCharacterCount
  ) throw new Error(text(
    '导入全局事实提交收据无效或覆盖不完整',
    'The imported global-facts commit receipt is invalid or incomplete.',
  ))
  return candidate
}

export class ImportBlueprintPostCommitSyncError extends Error {
  readonly retryOperationId: string

  constructor(readonly commitReceipt: BlueprintRangeCommitReceipt, text: UiText) {
    super(
      text(
        `导入蓝图已提交（第 ${commitReceipt.startChapter}–${commitReceipt.endChapter} 章），`
          + '但角色候选同步失败；可使用同步操作回执安全重试，无需重新生成蓝图。',
        `Imported blueprints for Chapters ${commitReceipt.startChapter}–${commitReceipt.endChapter} were committed, `
          + 'but character-candidate synchronization failed. Retry with the synchronization receipt without regenerating the blueprints.',
      ),
    )
    this.name = 'ImportBlueprintPostCommitSyncError'
    this.retryOperationId = commitReceipt.characterSyncOperation.operationId
  }
}

// =================================================================
// 1. 向量采样 + AI 推演全局配置/架构/角色
// =================================================================

export class InferGlobalSettingsCommand extends BaseWorkflowCommand<void> {
  constructor(
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly commitGlobalFacts?: (request: ImportGlobalFactsRequest) => Promise<ImportGlobalFactsReceipt>,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<void> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async decodeImportInferenceWithEndpointRecovery(
    rawResult: string,
    callbacks: CommandExecuteParams['callbacks'],
    context: CommandExecuteParams['context'],
  ): Promise<ImportInferenceResult> {
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    try {
      return decodeImportInferenceJson(rawResult)
    } catch (error) {
      if (!(error instanceof StructuredContractDiagnostic)
        || error.code !== 'relationship_endpoint_not_in_characters') {
        throw error
      }
    }

    const originalRoot = parseImportInferenceJsonObject(rawResult)
    const unresolvedTargets = unresolvedImportRelationshipTargets(originalRoot, text)
    const originalCardCount = importInferenceCards(originalRoot, text).length
    if (originalCardCount + unresolvedTargets.length > MAX_IMPORT_INFERENCE_CHARACTER_CARDS) {
      throw new Error(text(
        '导入推演受限补卡校正会超过 8 张角色卡上限，已拒绝额外模型请求',
        'The bounded import correction would exceed the eight-card limit, so the extra model request was rejected.',
      ))
    }
    callbacks.log(text(
      `导入推演关系端点缺少 ${unresolvedTargets.length} 张角色卡，正在执行一次受限补卡校正`,
      `${unresolvedTargets.length} relationship ${unresolvedTargets.length === 1 ? 'endpoint is' : 'endpoints are'} missing a character card; running one bounded correction`,
    ))
    const correction = await this.callLLMResult(
      promptLanguageText(
        writingLanguage,
        [
          '【导入推演受限补卡校正】',
          '上一轮完整 JSON 已可解析，但 characterCards.relationships.target 引用了 characterCards 中不存在的角色名。',
          '只输出一个完整 JSON 对象，不要 Markdown、解释或思考过程。',
          '只允许输出严格 delta，顶层必须且只能包含 characterCards。',
          `characterCards 必须新增且只新增这些缺失角色 name：${JSON.stringify(unresolvedTargets)}`,
          '不得回传 novelConfig、architectureFiles 或任何原有角色卡；不得删除、重排、改名或改写任何原角色。',
          '不得新增任意其他角色；delta 角色卡、currentState 与 relationships 内部不得包含合同外字段。',
          '应用端会把 delta 追加到上一轮本地原始 characterCards，再执行完整导入推演 JSON 合同校验和关系闭合校验。',
          '【delta JSON 合同】',
          '{"characterCards":[{"name":"缺失关系端点精确 name","role":"protagonist | antagonist | supporting | minor","gender":"非空文本","age":"非空文本或有限数字","appearance":"非空文本","personality":"非空文本","background":"非空文本","abilities":"非空文本","motivation":"非空文本","relationships":[{"target":"最终 characterCards 中另一角色的精确 name","relation":"非空关系文本"}],"arc":"非空文本","notes":"非空文本","currentState":{"location":"非空文本","powerLevel":"非空文本","physicalState":"非空文本","mentalState":"非空文本","keyItems":"非空文本","recentEvents":"非空文本","updatedAtChapter":0}}]}',
          '【上一轮完整 JSON（只用于识别已存在角色，不得回传旧内容）】',
          JSON.stringify(originalRoot),
        ].join('\n'),
        [
          '[Bounded import-inference endpoint-card correction]',
          'The previous complete JSON is parseable, but characterCards.relationships.target references names absent from characterCards.',
          'Output one complete JSON object only, with no Markdown, explanation, or reasoning.',
          'Return a strict delta whose only top-level field is characterCards.',
          `Add exactly these missing character names and no others: ${JSON.stringify(unresolvedTargets)}`,
          'Do not return novelConfig, architectureFiles, or any existing card. Do not remove, reorder, rename, or rewrite existing characters.',
          'Every delta card, currentState, and relationship must contain only contract fields.',
          '[Delta JSON contract]',
          '{"characterCards":[{"name":"exact missing endpoint name","role":"protagonist | antagonist | supporting | minor","gender":"non-empty text","age":"non-empty text or finite number","appearance":"non-empty text","personality":"non-empty text","background":"non-empty text","abilities":"non-empty text","motivation":"non-empty text","relationships":[{"target":"exact name of another final character","relation":"non-empty relationship text"}],"arc":"non-empty text","notes":"non-empty text","currentState":{"location":"non-empty text","powerLevel":"non-empty text","physicalState":"non-empty text","mentalState":"non-empty text","keyItems":"non-empty text","recentEvents":"non-empty text","updatedAtChapter":0}}]}',
          '[Previous complete JSON — identify existing characters only; do not echo it]',
          JSON.stringify(originalRoot),
        ].join('\n'),
      ),
      promptLanguageText(
        writingLanguage,
        '你是导入推演 JSON 受限补卡 delta 生成器。只输出缺失关系端点对应的新增角色卡。',
        'You generate a bounded JSON delta containing only cards for missing relationship endpoints.',
      ),
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'import-inference:endpoint-card-recovery',
        reasoningStage: 'planning',
      },
      context,
    )
    if (correction.finishReason !== 'stop') throw this.createIncompleteCompletionError(correction.finishReason)
    const correctedRoot = {
      ...originalRoot,
      characterCards: [
        ...importInferenceCards(originalRoot, text),
        ...parseImportEndpointCorrectionDelta(correction.content, unresolvedTargets, text),
      ],
    }
    return decodeImportInferenceJson(JSON.stringify(correctedRoot))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error(text('当前项目已切换，导入推演已停止', 'The project changed, so import inference stopped.'))
    const projectSnapshot = Object.freeze({ ...project, novelConfig: Object.freeze({ ...project.novelConfig }) })

    const chapters = context.data.chapters as ImportedChapter[]
    if (!chapters || chapters.length === 0) throw new Error(text('无章节数据', 'No chapter data is available.'))

    callbacks.log(text(
      '通过向量知识库检索关键片段...',
      'Retrieving key passages from the vector knowledge base...',
    ))
    callbacks.setProgress(5)

    // ===== 向量检索采样 =====
    const searchTopics = [
      { key: 'worldview', query: promptLanguageText(writingLanguage, '世界观 力量体系 修炼等级 境界', 'world rules power system ranks institutions'), label: text('世界观与力量体系', 'world and power system') },
      { key: 'protagonist', query: promptLanguageText(writingLanguage, '主角 金手指 核心能力 天赋 系统', 'protagonist central advantage core ability talent system'), label: text('主角设定与金手指', 'protagonist and central advantage') },
      { key: 'conflict', query: promptLanguageText(writingLanguage, '敌人 反派 阴谋 危机 矛盾 对手', 'enemy antagonist conspiracy crisis conflict opponent'), label: text('核心矛盾与敌对势力', 'central conflict and opposing forces') },
      { key: 'style', query: promptLanguageText(writingLanguage, '视角 叙述 描写 风格 节奏', 'point of view narration description style pacing'), label: text('写作风格与叙事视角', 'writing style and narrative viewpoint') },
    ]

    const sampledContent: Record<string, string> = {}
    for (const topic of searchTopics) {
      this.assertNotCancelled(context)
      try {
        const results = unwrapKnowledgeValue(await ipc.invokeWithProjectSession(
          projectSession,
          'kb:search',
          topic.query,
          5,
          context.projectPath,
        ))
        this.assertNotCancelled(context)
        if (results.length > 0) {
          sampledContent[topic.key] = results
            .map((r: { text: string; score: number; fileName: string }, i: number) =>
              promptLanguageText(
                writingLanguage,
                `[${i + 1}] (${r.fileName}, 相关度 ${(r.score * 100).toFixed(0)}%)\n${r.text}`,
                `[${i + 1}] (${r.fileName}, relevance ${(r.score * 100).toFixed(0)}%)\n${r.text}`,
              )
            ).join('\n\n')
        } else {
          sampledContent[topic.key] = promptLanguageText(writingLanguage, '（未检索到相关内容）', '(no relevant content found)')
        }
        callbacks.log(text(
          `  已检索「${topic.label}」— ${results.length} 条结果`,
          `  Retrieved ${results.length} ${results.length === 1 ? 'result' : 'results'} for "${topic.label}"`,
        ))
      } catch {
        sampledContent[topic.key] = promptLanguageText(writingLanguage, '（向量检索不可用）', '(vector search unavailable)')
        callbacks.log(text(
          `  「${topic.label}」检索失败，将使用降级策略`,
          `  Retrieval failed for "${topic.label}"; using the fallback strategy`,
        ))
      }
    }
    callbacks.setProgress(20)

    // ===== 构建 Prompt =====
    // 优先使用向量增强版 Prompt
    const template = await resolvePromptTemplate('infer_novel_config_with_vectors', projectSession, writingLanguage)
      || await resolvePromptTemplate('infer_novel_config', projectSession, writingLanguage)
    if (!template) throw new Error(text('未找到推演 Prompt 模板', 'The import-inference prompt template was not found.'))

    const firstChapter = chapters[0]?.content?.slice(0, 3000)
      || promptLanguageText(writingLanguage, '（第一章内容不可用）', '(opening chapter unavailable)')
    const latestChapter = chapters[chapters.length - 1]?.content?.slice(0, 3000)
      || promptLanguageText(writingLanguage, '（最新章节不可用）', '(latest chapter unavailable)')
    const inferenceContract = importInferenceJsonContract(writingLanguage)

    const prompt = new ImportPromptBuilder(template, writingLanguage)
      .withSampledWorldview(sampledContent.worldview || '')
      .withSampledProtagonist(sampledContent.protagonist || '')
      .withSampledConflict(sampledContent.conflict || '')
      .withSampledStyle(sampledContent.style || '')
      .withFirstChapter(firstChapter)
      .withLatestChapter(latestChapter)
      .withTotalChapters(chapters.length)
      // 兼容旧版 Prompt 的 sample_content 变量
      .withSampleContent(promptLanguageText(
        writingLanguage,
        `【第1章片段】\n${firstChapter}\n\n【最新章节片段】\n${latestChapter}`,
        `[Opening chapter sample]\n${firstChapter}\n\n[Latest chapter sample]\n${latestChapter}`,
      ))
      .build()
      + `\n\n${inferenceContract}`

    callbacks.log(text(
      '正在调用 AI 推演全局小说配置...',
      'Running AI inference for the global novel configuration...',
    ))
    callbacks.setProgress(25)

    const initial = await this.callLLMResult(
      prompt,
      template.systemRole || promptLanguageText(writingLanguage, '你是一位顶级网文主编和资深阅读分析师。', 'You are a senior fiction editor and reading analyst.'),
      callbacks,
      {
        responseFormat: { type: 'json_object' },
        purpose: 'import-inference',
        reasoningStage: 'planning',
      },
      context,
    )
    if (initial.finishReason !== 'stop') throw this.createIncompleteCompletionError(initial.finishReason)
    let rawResult = initial.content
    if (isRepairableDirectJsonSyntaxFailure(rawResult)) {
      if (
        structuredRepairUtf8Bytes(inferenceContract) > MAX_STRUCTURED_REPAIR_CONTRACT_UTF8_BYTES
        || structuredRepairUtf8Bytes(rawResult) > MAX_STRUCTURED_REPAIR_CANDIDATE_UTF8_BYTES
      ) throw new Error(text(
        '导入推演 JSON 语法修复证据超过安全字节上限',
        'The import-inference JSON repair evidence exceeds the safe byte limit.',
      ))
      callbacks.log(text(
        '导入推演 JSON 存在词法错误，正在执行唯一一次完整替代语法修复...',
        'The import-inference JSON has a syntax error; running the single full-replacement syntax repair...',
      ))
      const repairTask = buildStructuredSyntaxRepairTask({
        purpose: 'import-inference',
        output: 'structured-data',
        messages: [],
      }, inferenceContract, rawResult, writingLanguage)
      const repair = await this.callLLMResult(
        repairTask.messages[1].content,
        repairTask.messages[0].content,
        callbacks,
        {
          responseFormat: { type: 'json_object' },
          purpose: repairTask.purpose,
          reasoningStage: 'planning',
        },
        context,
      )
      if (repair.finishReason !== 'stop') throw this.createIncompleteCompletionError(repair.finishReason)
      if (!preservesStructuredJsonEvidence(rawResult, repair.content)) {
        throw new Error(text(
          '导入推演 JSON 语法修复改变了候选事实，已拒绝写入',
          'The import-inference JSON syntax repair changed candidate facts, so the write was rejected.',
        ))
      }
      rawResult = repair.content
    }
    this.assertNotCancelled(context)

    callbacks.setProgress(70)
    callbacks.log(text(
      '正在解析 AI 返回结果并写入项目...',
      'Parsing the AI response and committing it to the project...',
    ))

    // ===== 解析 JSON 结果 =====
    const inferResult = await this.decodeImportInferenceWithEndpointRecovery(rawResult, callbacks, context)

    const roster = await ipc.invokeWithProjectSession(
      projectSession,
      'db:character-roster-read',
      context.projectPath,
    )
    if (roster.status !== 'ready' && roster.status !== 'empty') {
      throw new Error(text(
        '角色名单当前不可安全导入；请先完成旧项目修复或处理数据不一致状态',
        'The character roster cannot be imported safely. Repair the legacy project or resolve its inconsistent state first.',
      ))
    }

    const novelConfig = {
      ...projectSnapshot.novelConfig,
      ...inferResult.novelConfig,
      totalChapters: typeof context.data.importRunTotalChapters === 'number'
        ? context.data.importRunTotalChapters
        : chapters.length,
      wordsPerChapter: Math.max(1, Math.round(
        (typeof context.data.importRunTotalWords === 'number'
          ? context.data.importRunTotalWords
          : chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0))
        / (typeof context.data.importRunTotalChapters === 'number'
          ? context.data.importRunTotalChapters
          : chapters.length),
      )),
    }
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text(
      '当前项目已切换，导入配置结果未应用',
      'The project changed, so the imported configuration was not applied.',
    ))
    this.assertNotCancelled(context)

    const operationId = `novel-import-global-${context.runId}`
    const commitRequest: ImportGlobalFactsRequest = {
        operationId,
        expectedRosterRevision: roster.revision,
        core: {
          genre: novelConfig.genre,
          subGenre: novelConfig.subGenre,
          targetAudience: novelConfig.targetAudience,
          totalChapters: novelConfig.totalChapters,
          wordsPerChapter: novelConfig.wordsPerChapter,
          plotStructure: novelConfig.plotStructure,
          narrativePov: novelConfig.narrativePOV,
          goldenFinger: novelConfig.goldenFinger,
          globalGuidance: novelConfig.globalGuidance,
          coreOutline: novelConfig.coreOutline,
          worldSetting: novelConfig.worldSetting,
          protagonistProfile: novelConfig.protagonistProfile,
          premise: inferResult.architectureFiles.premise,
          worldbuilding: inferResult.architectureFiles.worldbuilding,
          synopsis: inferResult.architectureFiles.synopsis,
        },
        characterEntries: inferResult.characterCards,
      }
    let rawCommitReceipt: ImportGlobalFactsReceipt | undefined
    if (this.commitGlobalFacts) {
      rawCommitReceipt = await this.commitGlobalFacts(commitRequest)
    } else {
      const commitResult = await ipc.invokeWithProjectSession(
        projectSession,
        'db:import-global-facts-commit',
        commitRequest,
        context.projectPath,
      )
      if (!commitResult.success) throw new Error(commitResult.error || text(
        '导入全局事实原子提交失败',
        'The imported global facts could not be committed atomically.',
      ))
      rawCommitReceipt = commitResult.receipt
    }
    const commitReceipt = requireImportGlobalFactsReceipt(
      rawCommitReceipt,
      operationId,
      inferResult.characterCards.length,
      text,
    )
    context.data.importGlobalFactsReceipt = commitReceipt

    this.assertNotCancelled(context)
    if (!sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(useProjectStore.getState().currentProject),
    )) throw new Error(text(
      '当前项目已切换，导入配置结果未应用',
      'The project changed, so the imported configuration was not applied.',
    ))
    const authoritativeNovelConfig = {
      ...projectSnapshot.novelConfig,
      genre: commitReceipt.core.genre,
      subGenre: commitReceipt.core.subGenre,
      targetAudience: commitReceipt.core.targetAudience,
      totalChapters: commitReceipt.core.totalChapters,
      wordsPerChapter: commitReceipt.core.wordsPerChapter,
      plotStructure: commitReceipt.core.plotStructure,
      narrativePOV: commitReceipt.core.narrativePov,
      goldenFinger: commitReceipt.core.goldenFinger,
      globalGuidance: commitReceipt.core.globalGuidance,
      coreOutline: commitReceipt.core.coreOutline,
      worldSetting: commitReceipt.core.worldSetting,
      protagonistProfile: commitReceipt.core.protagonistProfile,
    }
    useProjectStore.setState({ currentProject: { ...projectSnapshot, novelConfig: authoritativeNovelConfig } })
    const unknown = promptLanguageText(writingLanguage, '未知', 'Unknown')
    const none = promptLanguageText(writingLanguage, '（无）', '(none)')
    context.data.novelConfigSummary = promptLanguageText(
      writingLanguage,
      `类型: ${authoritativeNovelConfig.genre || unknown} | 子类型: ${authoritativeNovelConfig.subGenre || unknown} | 受众: ${authoritativeNovelConfig.targetAudience || unknown}\n`
        + `大纲: ${authoritativeNovelConfig.coreOutline || none}\n`
        + `世界观: ${authoritativeNovelConfig.worldSetting || none}\n`
        + `金手指: ${authoritativeNovelConfig.goldenFinger || none}\n`
        + `主角: ${authoritativeNovelConfig.protagonistProfile || none}`,
      `Genre: ${authoritativeNovelConfig.genre || unknown} | Subgenre: ${authoritativeNovelConfig.subGenre || unknown} | Audience: ${authoritativeNovelConfig.targetAudience || unknown}\n`
        + `Outline: ${authoritativeNovelConfig.coreOutline || none}\n`
        + `World: ${authoritativeNovelConfig.worldSetting || none}\n`
        + `Central advantage: ${authoritativeNovelConfig.goldenFinger || none}\n`
        + `Protagonist: ${authoritativeNovelConfig.protagonistProfile || none}`,
    )
    const committedCharacterCount = commitReceipt.roster.snapshot.entries.length
    callbacks.log(text(
      `小说配置、非角色架构与 ${committedCharacterCount} 张角色卡已原子提交`,
      `The novel configuration, non-character architecture, and ${committedCharacterCount} character ${committedCharacterCount === 1 ? 'card was' : 'cards were'} committed atomically`,
    ))

    callbacks.setProgress(90)
    this.notifyRefresh(['fileTree', 'characterCards'], context.projectPath, requireWorkflowProjectSession(context))
  }
}


// =================================================================
// 2. 按章逐一推演精准蓝图（限流并发）
// =================================================================

export class InferBlueprintsPerChapterCommand extends BaseWorkflowCommand<void> {
  private static readonly MAX_CHAPTERS_PER_OPERATION = 50
  private static readonly MAX_ITEMS_PER_BATCH = 5

  constructor(
    generationDependencies?: WorkflowGenerationRuntimeDependencies,
    private readonly commitBlueprintRange?: (
      request: BlueprintRangeCommitRequest,
    ) => Promise<BlueprintRangeCommitReceipt>,
  ) {
    super(generationDependencies)
  }

  async execute(params: CommandExecuteParams): Promise<void> {
    return this.executeWithGenerationRuntime('structured', params, () => this.executeWithinGeneration(params))
  }

  private async executeWithinGeneration({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const projectSession = requireWorkflowProjectSession(context)
    const writingLanguage = workflowWritingLanguage(context)
    const text = (zhCNText: string, enUSText: string) => workflowUiText(context, zhCNText, enUSText)
    const project = useProjectStore.getState().currentProject
    if (!project || !sameProjectSessionContext(
      projectSession,
      projectSessionContextFromProject(project),
    )) throw new Error(text('当前项目已切换，蓝图推演已停止', 'The project changed, so blueprint inference stopped.'))

    const chapters = context.data.chapters as ImportedChapter[]
    const configSummary = (context.data.novelConfigSummary as string)
      || promptLanguageText(writingLanguage, '（配置概要不可用）', '(configuration summary unavailable)')
    if (!chapters || chapters.length === 0) throw new Error(text('无章节数据', 'No chapter data is available.'))

    const template = await resolvePromptTemplate('infer_single_chapter_blueprint', projectSession, writingLanguage)
    if (!template) throw new Error(text(
      '未找到单章蓝图推演 Prompt 模板',
      'The single-chapter blueprint inference prompt template was not found.',
    ))

    if (chapters.length > InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION) {
      throw new Error(text(
        `本次导入需推演 ${chapters.length} 章蓝图，超过单次 ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} 章的安全成本上限；`
          + `请按连续章节分段，每段不超过 ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} 章。`,
        `This import requires ${chapters.length} chapter blueprints, exceeding the safe limit of ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} per operation. `
          + `Import contiguous ranges of at most ${InferBlueprintsPerChapterCommand.MAX_CHAPTERS_PER_OPERATION} chapters.`,
      ))
    }
    const orderedChapters = [...chapters].sort((left, right) => left.number - right.number)
    const startChapter = orderedChapters[0]?.number
    const endChapter = orderedChapters.at(-1)?.number
    if (
      startChapter === undefined
      || endChapter === undefined
      || orderedChapters.some((chapter, index) => chapter.number !== startChapter + index)
    ) {
      throw new Error(text(
        '导入蓝图只能按连续章节范围生成；请先补齐缺失章节或拆分为连续范围。',
        'Imported blueprints can be inferred only for a contiguous chapter range. Fill missing chapters or split the import into contiguous ranges.',
      ))
    }

    const estimatedCalls = Math.ceil(chapters.length / InferBlueprintsPerChapterCommand.MAX_ITEMS_PER_BATCH)
    callbacks.log(text(
      `开始分批推演蓝图（共 ${chapters.length} 章，预计至多 ${estimatedCalls} 次调用）...`,
      `Inferring blueprints in batches (${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'}; at most ${estimatedCalls} model ${estimatedCalls === 1 ? 'call' : 'calls'})...`,
    ))
    callbacks.setProgress(5)

    let activeChapterNumbers: number[] = []
    const contract: StructuredBatchContract<ImportedChapter, ChapterBlueprint> = {
      buildTask: ({ items, validatedPrefix }) => {
        activeChapterNumbers = items.map(item => item.number)
        const source = items.map(chapter => promptLanguageText(
          writingLanguage,
          `【第${chapter.number}章 ${chapter.title || '无标题'}】\n${chapter.content.slice(0, 6000)}`,
          `[Chapter ${chapter.number}: ${chapter.title || 'Untitled'}]\n${chapter.content.slice(0, 6000)}`,
        )).join('\n\n')
        const prior = validatedPrefix.slice(-10)
          .map(item => promptLanguageText(
            writingLanguage,
            `第${item.chapterNumber}章 ${item.title}：${item.keyEvents}`,
            `Chapter ${item.chapterNumber}: ${item.title} — ${item.keyEvents}`,
          ))
          .join('\n') || promptLanguageText(writingLanguage, '（无）', '(none)')
        const prompt = new ImportPromptBuilder(template, writingLanguage)
          .withChapterContent(source)
          .withChapterNumber(items[0]?.number ?? 1)
          .withChapterTitle(items.map(item => item.title).filter(Boolean).join(', '))
          .withNovelConfigSummary(promptLanguageText(
            writingLanguage,
            `${configSummary}\n\n【已验证前缀】\n${prior}`,
            `${configSummary}\n\n[Previously validated prefix]\n${prior}`,
          ))
          .build()
          + promptLanguageText(
            writingLanguage,
            '\n\n【最终不可变输出合同】\n本合同取代上述模板中的任何旧 JSON 示例或字段名，不得沿用缺少字段的旧示例。\n',
            '\n\n[Final immutable output contract]\nThis contract replaces every older JSON example or field name in the template.\n',
          )
          + `${blueprintSemanticGenerationContract(writingLanguage)}\n`
          + promptLanguageText(
            writingLanguage,
            `本批必须且只能完整返回以下 chapterNumber：${activeChapterNumbers.join('、')}。`,
            `Return complete items for exactly these chapterNumber values: ${activeChapterNumbers.join(', ')}.`,
          )
        callbacks.log(text(
          `  正在推演第 ${activeChapterNumbers[0]}–${activeChapterNumbers.at(-1)} 章...`,
          `  Inferring Chapters ${activeChapterNumbers[0]}–${activeChapterNumbers.at(-1)}...`,
        ))
        callbacks.setProgress(5 + Math.round((validatedPrefix.length / orderedChapters.length) * 80))
        return {
          purpose: 'import-chapter-blueprints',
          output: 'structured-data',
          messages: [
            { role: 'system', content: template.systemRole || promptLanguageText(writingLanguage, '你是一位专业的网文结构分析师。', 'You are a professional fiction-structure analyst.') },
            { role: 'user', content: prompt },
          ],
        }
      },
      inputKey: chapter => chapter.number,
      outputKey: blueprint => blueprint.chapterNumber,
      decode: content => parseBlueprintSemanticResponseText(content, activeChapterNumbers)
        .map(blueprint => ({
          ...blueprint,
          userGuidance: '',
          notes: '',
          notesUpdatedAt: '',
        })),
      validateItem: validateBlueprintSemanticItem,
    }

    const execution = this.requireGenerationExecution()
    const batch = await createStructuredBatchExecutor({
      contract,
      session: execution.session,
      writingLanguage,
    }).execute({
      items: orderedChapters,
      limits: { maxBatchItems: InferBlueprintsPerChapterCommand.MAX_ITEMS_PER_BATCH },
      signal: execution.signal,
    })
    if (!batch.ok) throw new Error(text(
      `蓝图推演失败：${batch.failure.message}`,
      `Blueprint inference failed (${batch.failure.reason}).`,
    ))

    this.assertNotCancelled(context)
    const commitRequest: BlueprintRangeCommitRequest = {
        mode: 'replace-range',
        operationId: `import-blueprints-${context.runId}-${startChapter}-${endChapter}`,
        startChapter,
        endChapter,
        blueprints: [...batch.items],
      }
    let commitReceipt: BlueprintRangeCommitReceipt
    if (this.commitBlueprintRange) {
      commitReceipt = await this.commitBlueprintRange(commitRequest)
    } else {
      const commit = await ipc.invokeWithProjectSession(
        projectSession,
        'db:blueprint-commit-range',
        commitRequest,
        context.projectPath,
      )
      if (!commit.success || !commit.receipt) {
        throw new Error(commit.error || text(
          '导入蓝图未能作为完整范围一次提交并回读。',
          'The imported blueprints could not be committed and read back as one complete range.',
        ))
      }
      commitReceipt = commit.receipt
    }
    if (commitReceipt.snapshot.length !== orderedChapters.length) {
      throw new Error(text(
        '导入蓝图提交回执覆盖不完整。',
        'The imported blueprint commit receipt is incomplete.',
      ))
    }
    context.data.blueprintCommitReceipt = commitReceipt
    try {
      const syncReceipt = await retryDirectoryCharacterSync(
        commitReceipt.characterSyncOperation.operationId,
        context.projectPath,
        projectSession,
      )
      context.data.blueprintCharacterSyncReceipt = syncReceipt
    } catch {
      throw new ImportBlueprintPostCommitSyncError(commitReceipt, text)
    }

    const committedChapterCount = commitReceipt.snapshot.length
    callbacks.log(text(
      `蓝图推演完成：${committedChapterCount} 章已一次提交`,
      `Blueprint inference complete: ${committedChapterCount} ${committedChapterCount === 1 ? 'chapter was' : 'chapters were'} committed in one operation`,
    ))
    callbacks.setProgress(100)
    this.notifyRefresh(['fileTree', 'blueprints'], context.projectPath, projectSession)
  }
}
