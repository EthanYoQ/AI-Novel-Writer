import { redactVisibleCompletionText } from '../bounded-completion'
import { reviewTimeContinuity } from '../../../shared/chapter-time-continuity'
import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from './base-command'
import type { PreparedReviewRevisionContext, ReviewRevisionRecovery } from '../../../shared/review-revision-generation'
import { ReviewRevisionCommand, type ReviewRevisionCommandSource } from './review-revision-command'
import { parseReviewGenerationResult } from '../../../shared/review-generation-report'
import { buildChapterGoalReviewPrompt } from '../../../shared/chapter-goal-review'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ReviewPromptBuilder } from '../../prompts/prompt-builder'
import { promptLanguageText } from '../../prompt-language'
import {
  ChapterMaterialCapacityError,
  type ReviewRevisionMaterialAdmission,
} from '../chapter-materials'
import { ipc } from '../../ipc-client'
import { selectFrozenReviewRevisionMaterials } from './review-revision-materials'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'

export interface ReviewChapterParams extends ReviewRevisionCommandSource {
  reviewFocus?: string
  reviewCycleId?: string
  expectedMergedHash?: string
}

export { reviewHistoryMaterials } from './review-revision-materials'

/** Uses the same contract for recovery UI and the zero-request save path. */
export function canCommitRecoveredReview(recovery: ReviewRevisionRecovery | undefined): boolean {
  if (!recovery?.latestArtifact || recovery.latestArtifactFinishReason !== 'stop') return false
  if (recovery.context.recheck) return true
  try { parseReviewGenerationResult(redactVisibleCompletionText(recovery.latestArtifact.text)); return true } catch { return false }
}

export class ReviewChapterCommand extends ReviewRevisionCommand {
  constructor(params: ReviewChapterParams, dependencies?: WorkflowGenerationRuntimeDependencies) {
    super('review-chapter', params, params.reviewFocus ? [{ id: 'review-focus', text: params.reviewFocus }] : [], {
      reviewCycleId: params.reviewCycleId, expectedMergedHash: params.expectedMergedHash,
    }, dependencies)
  }

  protected async generateAndCommit(prepared: PreparedReviewRevisionContext, params: CommandExecuteParams) {
    if (canCommitRecoveredReview(this.recovery)) return this.commitReview(prepared, params)
    const frozen = prepared.context
    const language = frozen.writingLanguage
    const text = (zh: string, en: string) => workflowUiText(params.context, zh, en)
    params.callbacks.log(text('准备启动一致性审查引擎...', 'Preparing the continuity review...'))
    const projectSession = requireWorkflowProjectSession(params.context)
    const template = await resolvePromptTemplate('consistency_check', projectSession, language)
    if (!template) throw new Error(text('未找到审稿模板', 'The review prompt template was not found.'))
    // 与写稿路径同一套准入：材料成员由合同判定，绝不按「最近/相关」自行拼凑。
    let admission: ReviewRevisionMaterialAdmission
    try {
      admission = await selectFrozenReviewRevisionMaterials(frozen, { projectId: projectSession.projectId, epoch: projectSession.leaseId })
    } catch (error) {
      // 必需材料装不下：显式失败，绝不静默省略必需事实。
      if (!(error instanceof ChapterMaterialCapacityError)) throw error
      const blocked = error.decision.decision === 'capacity-conflict'
        ? `${error.decision.blockingSourceId}:${error.decision.blockingReason}`
        : error.decision.remainingRequired.join('、')
      params.callbacks.log(text(`  必需材料超出上下文容量（${error.decision.decision}）：${blocked}`,
        `  Required material exceeds the context capacity (${error.decision.decision}): ${blocked}`))
      throw new Error(text(
        '本章审稿的必需材料超出上下文容量，已停止审稿。请精简相关作者材料或前驱后重试。',
        'The required material for this review exceeds the context capacity, so the review stopped. Trim the required author material or predecessor and try again.',
      ))
    }
    const builder = new ReviewPromptBuilder(template, language)
      .withChapterContent(frozen.source.content)
      .withCharacterStates(frozen.characterStates)
      .withGlobalSummary(admission.admitted.filter(material => material.category === 'finalized-history').map(material => material.text).join('\n\n'))
      .withWorldBuilding(frozen.worldbuilding)
      .withReviewFocus(frozen.authorInputs.find(input => input.id === 'review-focus')?.text || '')
    const ordinaryReviewPrompt = [
      builder.build(),
      ...admission.admitted.filter(material => material.category !== 'finalized-history').map(material => material.text),
      promptLanguageText(language,
        '【作者设定优先】【作者确认项目配置】与【世界观设定】是权威事实；作者角色状态按标注时点理解；历史派生摘要不能覆盖作者事实。报告矛盾前，须说明作者设定或其必然前提与正文对同一对象、时点及条件的陈述为何不能同时成立，并纳入正文已有的兼容描述。正文未再次说明、未触碰或未明确位置，不证明权威状态已改变；存在合理兼容解释时，不得将推断当作事实矛盾要求修稿。新进展可以发生在同一时段或地点；作者未明确要求更换时点或场景时，不得强加，也不能因未更换就断言没有推进。若正文确实与作者事实或由其必然推出的前提矛盾，必须报告为 error 或 warning；即使蓝图、章节计划或冻结目标写法相反，也不得因此放过。',
        '[Author settings take priority] The author-confirmed project configuration and the worldbuilding settings are authoritative facts; author character states apply at their annotated time; historical derived summaries cannot override author facts. Before reporting a contradiction, explain why the author setting or its necessary premise and the draft cannot both be true for the same subject, time and conditions, considering compatible descriptions already present in the draft. Mere omission, lack of contact or an unstated location does not establish that an authoritative state has changed. Where a reasonable compatible interpretation exists, do not demand revision based on an inferred factual contradiction. New progress can occur within the same time period or location; do not require a time or scene change that the author has not specified, or infer no progress merely because neither changed. If the draft truly contradicts an author fact or a premise that necessarily follows from it, report it as an error or warning, even when a blueprint, chapter plan or frozen goal says otherwise.'),
      promptLanguageText(language,
        '【证据锚点硬约束】每个 error/warning 的 items[].quote 必须是待审正文中逐字连续、且全文仅出现一次的单一摘录；不得拼接多个位置、改写原文或包含省略号。优先选择足以证明问题的最短完整句。goalReviews[].evidence 中的每个 quote 也必须分别满足上述约束；需要多处证据时拆成多个 evidence 项，绝不可在一个 quote 中拼接。',
        '[Strict evidence-anchor constraint] Each items[].quote for an error/warning must be one verbatim, contiguous excerpt that occurs exactly once in the draft under review. Do not combine multiple locations, rewrite the text, or include ellipses. Prefer the shortest complete sentence that proves the issue. Every quote in goalReviews[].evidence must independently satisfy the same constraint; when multiple excerpts are needed, use separate evidence entries and never combine them in one quote.'),
      promptLanguageText(language,
        '【时间一致性检查】只核对正文实际表达的时间精度。宽泛回指只表达先后关系时，核对事件顺序即可；顺序一致则不补推更精确的历史日期或时段。明确日期、时段和相对时间须对照作者时点与前驱同一事件，不能假设另有同类事件来放行。正文自身明确写出的跨日或时间间隔优先于同日默认；作者和正文都未交代时，按前章结尾同日紧接核对，仍须报告与作者明确时点的冲突。需要具体时点时，使用事件自身或前面最近的明确时点，不借用更早段落时点；无法确定时保留不确定性。AI 建议中的具体时点不构成来源依据。同一事件的多处日期或状态须结合正文已交代的变化核对。真实冲突报 error 或 warning：quote 定位当前正文的冲突句；description 简述来源章节、同一事件及其必要时间引文和冲突依据。修法不得新增来源不支持的具体时点或原因。',
        '[Temporal consistency checks] Check only the time precision actually expressed in the draft. When a broad reference expresses only before/after order, check that order; if consistent, do not infer a more precise historical date or time period. Check explicit dates, time periods and relative times against author timing and the same predecessor event; do not excuse conflicts by inventing another similar event. An explicit day change or time gap in the manuscript takes priority over the same-day default. When neither author nor manuscript states one, check a same-day continuation from the previous ending, still reporting conflicts with explicit author timing. When a specific time is needed, use the event itself or the nearest preceding explicit time; do not borrow a time from before that anchor. Preserve uncertainty when it cannot be determined. A specific time proposed by AI is not source evidence. Check multiple dates or states for the same event against changes established in the prose. Report genuine conflicts as error or warning: quote the conflicting current-draft sentence; briefly give the source chapter, same event, necessary time excerpts and conflict evidence in description. Remedies must not add a specific time or cause unsupported by the sources.'),
      promptLanguageText(language,
        '【pass 依据】pass 简述实际核对的对象、来源与对照结果即可，不必逐项展开无问题内容的历史时点；不得照抄格式示例或用无依据套话替代核对。',
        '[Pass evidence] Briefly state the actual subject, source checked and comparison result for a pass; do not expand the historical timing of each problem-free detail. Never copy the format example or substitute unsupported stock conclusions for checking.'),
      buildChapterGoalReviewPrompt(frozen.frozenGoals, language),
    ].join('\n\n')
    const reviewPrompt = frozen.recheck ? [
      promptLanguageText(language,
        '【一次性定向复核】只复核下列 finding，不得新增、删除、合并或改写 findingId/targetId。',
        '[One-time targeted recheck] Recheck only the findings below. Do not add, remove, merge, or rewrite findingId/targetId.'),
      promptLanguageText(language, '【人工合并后的正文】', '[Author-merged draft]'),
      frozen.source.content,
      ...admission.admitted.map(material => material.text),
      reviewTimeContinuity(language),
      promptLanguageText(language, '改法引入来源不支持的具体时点时，不能判为 resolved。',
        'A remedy introducing a specific time unsupported by the sources must not be marked resolved.'),
      promptLanguageText(language, '【需复核的原始证据锚点】', '[Original evidence anchors to recheck]'),
      JSON.stringify(frozen.recheck.findings, null, 2),
      promptLanguageText(language,
        '判断 resolved 时必须同时核对每项 problem 与 expected（如有）；正文只是改变、移除原句或换一种错误说法，不代表问题已解决。若 finding 要求当章动作或结果，新增动作或结果本身必须满足目标语义；计划、决定、承诺、保证、签字认责或简单否定翻转都不能证明结果已经实现。对于代价或损失，证据必须写出已经失去、消耗或承受的具体后果，并且后文不得保留相反状态。仅当合并后正文中的唯一新证据确实满足原始问题语义与预期时，才可令 resolved=true。',
        'When deciding resolved, check each finding\'s problem and expected semantics (when present). Merely changing or removing the old sentence, or restating the same error, does not resolve the finding. If a finding requires a current-chapter action or result, the added action or result must itself satisfy the target meaning; a plan, decision, promise, commitment, signature accepting responsibility, or simple negation flip is not evidence that the result was achieved. For a cost or loss, evidence must show the concrete consequence already lost, spent, or endured, and later prose must not preserve a contradictory state. Set resolved=true only when unique new evidence in the merged draft actually satisfies the original problem and expectation.'),
      promptLanguageText(language,
        '核对改法是否与上述作者事实、前驱及本章目标冲突；冲突或依据不足时不能标已解决。只裁决原 finding，全章末审仍负责发现新问题。',
        'Check whether the remedy conflicts with author facts, the predecessor or chapter goals above. A conflict or insufficient support cannot be marked resolved. Adjudicate only the original findings; the final whole-chapter review still checks new issues.'),
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
        '【硬性要求】只重新输出一个完整审稿 JSON，根字段为 summary、items、goalReviews：summary 不超过 120 字符；items 为 1–10 条，每条按 category、quote、description、severity(error|warning|pass) 顺序输出，先举证说明判断依据，最后确定 severity；description 不超过 200 字符，quote 仅 pass 可省略，error/warning 必须提供且不超过 160 字符。description 必须说明当前正文的具体客观缺陷才可标为 error/warning；若结论为合理、符合要求或未发现问题，该项应为 pass 或省略。全文未发现具体问题时，保留一条 pass；确有客观问题仍须按严重程度报告 error/warning。goalReviews 按上方最初冻结清单逐项返回 id、status、description、evidence，不受 items 条数限制；只用原始待审正文核对。不得输出这些约定以外的字段、Markdown、解释或思考过程。',
        '[Hard requirement] Output one complete review JSON with root fields summary, items and goalReviews: summary within 120 characters; items 1–10 entries in category, quote, description, severity order (error|warning|pass), with evidence and explanation before severity; description within 200 characters; quote is optional only for pass and required (≤160 characters) for error/warning. Use error/warning only when description identifies a specific objective defect in the current draft. If the conclusion is reasonable, meets requirements, or no issue found, use pass or omit the item. If the whole draft has no specific issue, keep one pass item. Still report genuine objective problems as error/warning according to their severity. goalReviews must cover the original frozen checklist above with id, status, description and evidence, without the general items count limit; use only the original draft for evidence. No fields outside these contracts, Markdown, explanation, or reasoning.')
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
