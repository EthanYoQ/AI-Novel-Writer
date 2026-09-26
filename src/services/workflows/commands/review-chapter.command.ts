import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from './base-command'
import type { PreparedReviewRevisionContext, ReviewRevisionContext } from '../../../shared/review-revision-generation'
import { ReviewRevisionCommand, type ReviewRevisionCommandSource } from './review-revision-command'
import { parseReviewGenerationResult } from '../../../shared/review-generation-report'
import { buildChapterGoalReviewPrompt } from '../../../shared/chapter-goal-review'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ReviewPromptBuilder } from '../../prompts/prompt-builder'
import { promptLanguageText } from '../../prompt-language'
import {
  ChapterMaterialCapacityError,
  selectReviewRevisionMaterials,
  unknownReviewMaterialIdentity,
  type ChapterMaterialIdentity,
  type ReviewRevisionMaterial,
  type ReviewRevisionMaterialAdmission,
} from '../chapter-materials'
import { ipc } from '../../ipc-client'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'

export interface ReviewChapterParams extends ReviewRevisionCommandSource {
  reviewFocus?: string
  reviewCycleId?: string
  expectedMergedHash?: string
}

type ReviewHistoryItem = ReviewRevisionContext['history'][number]

/** 单条已定稿历史在审稿提示词里的块；措辞与接入准入层之前逐字相同。 */
function historyBlock(item: ReviewHistoryItem, language: ReviewRevisionContext['writingLanguage']): string {
  const text = (zh: string, en: string) => promptLanguageText(language, zh, en)
  return [
    text(`### 第${item.chapterNumber}章 ${item.chapterTitle}`, `### Chapter ${item.chapterNumber}: ${item.chapterTitle}`),
    item.content,
    ...(item.projection?.sourceStatus === 'current' ? (item.projection.facts ?? []).map(fact => text(
      `- [${fact.category}] ${fact.statement}（来源第${fact.sourceChapter}章；证据：${fact.evidence}）`,
      `- [${fact.category}] ${fact.statement} (source: Chapter ${fact.sourceChapter}; evidence: ${fact.evidence})`,
    )) : []),
  ].filter(Boolean).join('\n')
}

/**
 * 审稿路径的材料候选：历史原文逐字保留原有块头，身份只由主进程给出。
 * 前一章的定稿是审稿的连续性锚点，因此是必需材料：装不下就显式失败，不静默省略。
 *
 * 导出是为了让 `context-entry-parity.test.ts` 驱动本入口**真实的**装配缝，
 * 而不是在测试里另写一份近似实现。
 */
export function reviewHistoryMaterials(frozen: ReviewRevisionContext, current: ChapterMaterialIdentity): ReviewRevisionMaterial[] {
  return frozen.history.map(item => ({
    identity: item.identity ?? unknownReviewMaterialIdentity(current),
    category: 'finalized-history',
    required: item.chapterNumber === frozen.source.chapterNumber - 1,
    text: historyBlock(item, frozen.writingLanguage),
  }))
}

function formatHistory(frozen: ReviewRevisionContext, admitted: readonly ReviewRevisionMaterial[]): string {
  const text = (zh: string, en: string) => promptLanguageText(frozen.writingLanguage, zh, en)
  const header = text('【已确认定稿历史｜唯一已发生事实源】', '[Finalized history | the only source of events that have already happened]')
  if (!frozen.history.length) return `${header}\n${text('（当前章节之前没有已定稿历史）', '(there is no finalized history before the current chapter)')}`
  // 准入只决定成员；顺序仍是历史原有顺序，因此集合未变时提示词逐字节不变。
  return [header, ...admitted.map(material => material.text)].join('\n\n')
}

export class ReviewChapterCommand extends ReviewRevisionCommand {
  constructor(params: ReviewChapterParams, dependencies?: WorkflowGenerationRuntimeDependencies) {
    super('review-chapter', params, params.reviewFocus ? [{ id: 'review-focus', text: params.reviewFocus }] : [], {
      reviewCycleId: params.reviewCycleId, expectedMergedHash: params.expectedMergedHash,
    }, dependencies)
  }

  protected async generateAndCommit(prepared: PreparedReviewRevisionContext, params: CommandExecuteParams) {
    if (this.recovery?.latestArtifact && this.recovery.latestArtifactFinishReason === 'stop') {
      let valid = Boolean(prepared.context.recheck)
      if (!valid) try { parseReviewGenerationResult(this.stripThinkingTags(this.recovery.latestArtifact.text)); valid = true } catch { /* Repair invalid JSON below. */ }
      if (valid) return this.commitReview(prepared, params)
    }
    const frozen = prepared.context
    const language = frozen.writingLanguage
    const text = (zh: string, en: string) => workflowUiText(params.context, zh, en)
    params.callbacks.log(text('准备启动一致性审查引擎...', 'Preparing the continuity review...'))
    const projectSession = requireWorkflowProjectSession(params.context)
    const template = await resolvePromptTemplate('consistency_check', projectSession, language)
    if (!template) throw new Error(text('未找到审稿模板', 'The review prompt template was not found.'))
    // 与写稿路径同一套准入：材料成员由合同判定，绝不按「最近/相关」自行拼凑。
    const reviewBlueprint = frozen.blueprints.find(blueprint => blueprint.chapterNumber === frozen.source.chapterNumber)
    const reviewMaterials = frozen.recheck
      ? []
      : reviewHistoryMaterials(frozen, { projectId: projectSession.projectId, epoch: projectSession.leaseId })
    let admission: ReviewRevisionMaterialAdmission
    try {
      admission = selectReviewRevisionMaterials({
        current: { projectId: projectSession.projectId, epoch: projectSession.leaseId },
        writingLanguage: language,
        materials: reviewMaterials,
        relevanceTerms: frozen.recheck
          ? []
          : [reviewBlueprint?.title ?? '', reviewBlueprint?.keyEvents ?? '', ...(reviewBlueprint?.characters ?? [])],
      })
    } catch (error) {
      // 必需材料（前一章定稿）装不下：显式失败，绝不静默省略必需事实。
      if (!(error instanceof ChapterMaterialCapacityError)) throw error
      const blocked = error.decision.decision === 'capacity-conflict'
        ? `${error.decision.blockingSourceId}:${error.decision.blockingReason}`
        : error.decision.remainingRequired.join('、')
      params.callbacks.log(text(`  必需材料超出上下文容量（${error.decision.decision}）：${blocked}`,
        `  Required material exceeds the context capacity (${error.decision.decision}): ${blocked}`))
      throw new Error(text(
        '本章审稿的必需材料（前一章定稿）超出上下文容量，已停止审稿。请精简该章定稿材料后重试。',
        'The required material for this review (the previous chapter\'s finalized manuscript) exceeds the context capacity, so the review stopped. Trim that chapter and try again.',
      ))
    }
    const builder = new ReviewPromptBuilder(template, language)
      .withChapterContent(frozen.source.content)
      .withCharacterStates(frozen.characterStates)
      .withGlobalSummary(formatHistory(frozen, admission.admitted))
      .withWorldBuilding(frozen.worldbuilding)
      .withReviewFocus(frozen.authorInputs.find(input => input.id === 'review-focus')?.text || '')
    const guidance = frozen.config.globalGuidance?.trim() || promptLanguageText(language, '（无作者全局创作指导）', '(no author global creative guidance)')
    const ordinaryReviewPrompt = [
      builder.build(),
      promptLanguageText(language, `【作者全局创作指导｜约束而非已发生事实】\n${guidance}`, `[Author global creative guidance | constraint, not established history]\n${guidance}`),
      promptLanguageText(language, `【作者确认项目配置｜约束而非已发生事实】\n${JSON.stringify(frozen.config, null, 2)}`,
        `[Author-confirmed project configuration | constraint, not established history]\n${JSON.stringify(frozen.config, null, 2)}`),
      promptLanguageText(language, '【当前及未来蓝图/计划｜非既定历史】', '[Current and future blueprints/plans | not established history]'),
      JSON.stringify(frozen.blueprints, null, 2),
      promptLanguageText(language,
        '【证据锚点硬约束】每个 error/warning 的 items[].quote 必须是待审正文中逐字连续、且全文仅出现一次的单一摘录；不得拼接多个位置、改写原文或包含省略号。优先选择足以证明问题的最短完整句。goalReviews[].evidence 中的每个 quote 也必须分别满足上述约束；需要多处证据时拆成多个 evidence 项，绝不可在一个 quote 中拼接。',
        '[Strict evidence-anchor constraint] Each items[].quote for an error/warning must be one verbatim, contiguous excerpt that occurs exactly once in the draft under review. Do not combine multiple locations, rewrite the text, or include ellipses. Prefer the shortest complete sentence that proves the issue. Every quote in goalReviews[].evidence must independently satisfy the same constraint; when multiple excerpts are needed, use separate evidence entries and never combine them in one quote.'),
      buildChapterGoalReviewPrompt(frozen.frozenGoals, language),
    ].join('\n\n')
    const reviewPrompt = frozen.recheck ? [
      promptLanguageText(language,
        '【一次性定向复核】只复核下列 finding，不得新增、删除、合并或改写 findingId/targetId。',
        '[One-time targeted recheck] Recheck only the findings below. Do not add, remove, merge, or rewrite findingId/targetId.'),
      promptLanguageText(language, '【人工合并后的正文】', '[Author-merged draft]'),
      frozen.source.content,
      promptLanguageText(language, '【需复核的原始证据锚点】', '[Original evidence anchors to recheck]'),
      JSON.stringify(frozen.recheck.findings, null, 2),
      promptLanguageText(language,
        '判断 resolved 时必须同时核对每项 problem 与 expected（如有）；正文只是改变、移除原句或换一种错误说法，不代表问题已解决。若 finding 要求当章动作或结果，新增动作或结果本身必须满足目标语义；计划、决定、承诺、保证、签字认责或简单否定翻转都不能证明结果已经实现。对于代价或损失，证据必须写出已经失去、消耗或承受的具体后果，并且后文不得保留相反状态。仅当合并后正文中的唯一新证据确实满足原始问题语义与预期时，才可令 resolved=true。',
        'When deciding resolved, check each finding\'s problem and expected semantics (when present). Merely changing or removing the old sentence, or restating the same error, does not resolve the finding. If a finding requires a current-chapter action or result, the added action or result must itself satisfy the target meaning; a plan, decision, promise, commitment, signature accepting responsibility, or simple negation flip is not evidence that the result was achieved. For a cost or loss, evidence must show the concrete consequence already lost, spent, or endured, and later prose must not preserve a contradictory state. Set resolved=true only when unique new evidence in the merged draft actually satisfies the original problem and expectation.'),
      promptLanguageText(language,
        '【硬性 JSON 合同】只输出 {"summary":"...","items":[...]}。items 必须对上述每个 finding 恰好一项，字段仅为 findingId、targetId、resolved、evidenceQuote、reason。evidenceQuote 必须逐字来自合并后正文且只能出现一次；无法确认时仍返回该 finding，并令 resolved=false，说明证据不足。不得输出 Markdown、解释或思考过程。',
        '[Strict JSON contract] Output only {"summary":"...","items":[...]}. Include exactly one item for every finding above, with only findingId, targetId, resolved, evidenceQuote, and reason. evidenceQuote must be verbatim from the merged draft and occur exactly once. If uncertain, still return the finding with resolved=false and explain the lack of evidence. No Markdown, explanation, or reasoning.'),
    ].join('\n\n') : ordinaryReviewPrompt
    await this.bindMaterialDecision(params, admission.decision, reviewPrompt)
    params.callbacks.log(text('调用 AI 审查员对本章进行多维度扫描...', 'Running the AI continuity review...'))
    const attempts = this.recovery?.attemptedPurposes ?? []
    let raw: string | undefined
    let parseFailure: unknown
    let needsRebuild = attempts.includes('review-chapter-rebuild')
    if (this.recovery?.latestArtifact && this.recovery.latestArtifactFinishReason === 'stop') {
      raw = this.stripThinkingTags(this.recovery.latestArtifact.text)
      try { parseReviewGenerationResult(raw) } catch (error) { parseFailure = error; raw = undefined; needsRebuild = true }
    }
    const generate = async (purpose: 'review-chapter' | 'review-chapter-rebuild', prompt: string) => {
      const used = attempts.filter(item => item === purpose).length
      if (used >= 2) throw new Error('GENERATION_REVIEW_REPLACEMENT_LIMIT')
      return this.callLLMWithBoundedCompletion(prompt, builder.getSystemRole(), params.callbacks,
        { mode: 'replace-structured-output', maxContinuations: 1 - used },
        { responseFormat: { type: 'json_object' }, purpose, reasoningStage: 'review', writingSkillStage: 'review' }, params.context)
    }
    if (frozen.recheck) {
      if (this.recovery?.latestArtifact && this.recovery.latestArtifactFinishReason === 'stop') return this.commitReview(prepared, params)
      await generate('review-chapter', reviewPrompt)
      return this.commitReview(prepared, params)
    }
    if (raw === undefined && !needsRebuild) {
      raw = await generate('review-chapter', reviewPrompt)
      try { parseReviewGenerationResult(raw) } catch (error) { parseFailure = error; raw = undefined; needsRebuild = true }
    }
    if (raw === undefined && needsRebuild) {
      const detail = parseFailure instanceof SyntaxError
        ? text('输出不是完整 JSON（可能被模型输出上限截断）', 'the output is not complete JSON (it may be truncated by the model output limit)')
        : text('输出不符合审稿报告合同（字段缺失、越界或多余）', 'the output does not match the review-report contract (missing, oversized, or extra fields)')
      params.callbacks.log(text(`审稿结果未通过校验（${detail}），正在请求一次完整替代输出...`,
        `The review result failed validation (${detail}); requesting one complete replacement...`))
      const instruction = promptLanguageText(language,
        '上一轮审稿输出未通过合同校验，已被丢弃，不得引用或续接。请重新完成原始审稿任务。',
        'The previous review output failed contract validation and was discarded. Do not quote or continue it; complete the original review task again.')
      const contract = promptLanguageText(language,
        '【硬性要求】只重新输出一个完整审稿 JSON，根字段为 summary、items、goalReviews：summary 不超过 120 字符；items 为 1–10 条，每条含 category、severity(error|warning|pass)、description(≤200 字符)；quote 仅 pass 可省略，error/warning 必须提供且不超过 160 字符。goalReviews 按上方最初冻结清单逐项返回 id、status、description、evidence，不受 items 条数限制；只用原始待审正文核对。不得输出这些约定以外的字段、Markdown、解释或思考过程。',
        '[Hard requirement] Output one complete review JSON with root fields summary, items and goalReviews: summary within 120 characters; items 1–10 entries with category, severity(error|warning|pass), description(≤200 characters); quote is optional only for pass and required (≤160 characters) for error/warning. goalReviews must cover the original frozen checklist above with id, status, description and evidence, without the general items count limit; use only the original draft for evidence. No fields outside these contracts, Markdown, explanation, or reasoning.')
      raw = await generate('review-chapter-rebuild', [instruction,
        promptLanguageText(language, '【原始审稿任务】', '[Original review task]'), reviewPrompt, contract].join('\n\n'))
      try { parseReviewGenerationResult(raw) } catch (error) {
        const detail = error instanceof SyntaxError
          ? text('替代输出仍不是完整 JSON', 'the replacement output is still not complete JSON')
          : text('替代输出仍不符合审稿报告合同', 'the replacement output still does not match the review-report contract')
        throw new Error(text(`AI 返回的审稿结果两次均无效（${detail}），因此未保存报告。`, `The AI review response was invalid twice (${detail}), so no report was saved.`))
      }
    }
    return this.commitReview(prepared, params)
  }

  private async commitReview(prepared: PreparedReviewRevisionContext, params: CommandExecuteParams) {
    this.assertNotCancelled(params.context)
    const recovery = await this.readRecovery(params)
    const artifact = recovery.latestArtifact
    const handle = params.context.mainGenerationRunHandle
    if (!artifact || !handle || recovery.latestArtifactFinishReason !== 'stop') throw new Error('GENERATION_REVIEW_ARTIFACT_REQUIRED')
    if (!prepared.context.recheck) parseReviewGenerationResult(this.stripThinkingTags(artifact.text))
    return ipc.invokeWithProjectSession(requireWorkflowProjectSession(params.context), 'review-revision:commit-review', {
      contextId: prepared.contextId, handle,
      artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash },
    })
  }
}
