import type { CommandExecuteParams, WorkflowGenerationRuntimeDependencies } from './base-command'
import type { PreparedReviewRevisionContext, ReviewRevisionContext } from '../../../shared/review-revision-generation'
import { ReviewRevisionCommand, type ReviewRevisionCommandSource } from './review-revision-command'
import { parseReviewGenerationResult } from '../../../shared/review-generation-report'
import { buildChapterGoalReviewPrompt } from '../../../shared/chapter-goal-review'
import { resolvePromptTemplate } from '../../prompt-templates'
import { ReviewPromptBuilder } from '../../prompts/prompt-builder'
import { promptLanguageText } from '../../prompt-language'
import { ipc } from '../../ipc-client'
import { requireWorkflowProjectSession, workflowUiText } from '../workflow-project-session'

export interface ReviewChapterParams extends ReviewRevisionCommandSource { reviewFocus?: string }

function formatHistory(frozen: ReviewRevisionContext): string {
  const text = (zh: string, en: string) => promptLanguageText(frozen.writingLanguage, zh, en)
  const header = text('【已确认定稿历史｜唯一已发生事实源】', '[Finalized history | the only source of events that have already happened]')
  if (!frozen.history.length) return `${header}\n${text('（当前章节之前没有已定稿历史）', '(there is no finalized history before the current chapter)')}`
  return [header, ...frozen.history.map(item => [
    text(`### 第${item.chapterNumber}章 ${item.chapterTitle}`, `### Chapter ${item.chapterNumber}: ${item.chapterTitle}`),
    item.content,
    ...(item.projection?.sourceStatus === 'current' ? (item.projection.facts ?? []).map(fact => text(
      `- [${fact.category}] ${fact.statement}（来源第${fact.sourceChapter}章；证据：${fact.evidence}）`,
      `- [${fact.category}] ${fact.statement} (source: Chapter ${fact.sourceChapter}; evidence: ${fact.evidence})`,
    )) : []),
  ].filter(Boolean).join('\n'))].join('\n\n')
}

export class ReviewChapterCommand extends ReviewRevisionCommand {
  constructor(params: ReviewChapterParams, dependencies?: WorkflowGenerationRuntimeDependencies) {
    super('review-chapter', params, params.reviewFocus ? [{ id: 'review-focus', text: params.reviewFocus }] : [], {}, dependencies)
  }

  protected async generateAndCommit(prepared: PreparedReviewRevisionContext, params: CommandExecuteParams) {
    if (this.recovery?.latestArtifact && this.recovery.latestArtifactFinishReason === 'stop') {
      let valid = false
      try { parseReviewGenerationResult(this.stripThinkingTags(this.recovery.latestArtifact.text)); valid = true } catch { /* Repair invalid JSON below. */ }
      if (valid) return this.commitReview(prepared, params)
    }
    const frozen = prepared.context
    const language = frozen.writingLanguage
    const text = (zh: string, en: string) => workflowUiText(params.context, zh, en)
    params.callbacks.log(text('准备启动一致性审查引擎...', 'Preparing the continuity review...'))
    const projectSession = requireWorkflowProjectSession(params.context)
    const template = await resolvePromptTemplate('consistency_check', projectSession, language)
    if (!template) throw new Error(text('未找到审稿模板', 'The review prompt template was not found.'))
    const builder = new ReviewPromptBuilder(template, language)
      .withChapterContent(frozen.source.content)
      .withCharacterStates(frozen.characterStates)
      .withGlobalSummary(formatHistory(frozen))
      .withWorldBuilding(frozen.worldbuilding)
      .withReviewFocus(frozen.authorInputs.find(input => input.id === 'review-focus')?.text || '')
    const guidance = frozen.config.globalGuidance?.trim() || promptLanguageText(language, '（无作者全局创作指导）', '(no author global creative guidance)')
    const reviewPrompt = [
      builder.build(),
      promptLanguageText(language, `【作者全局创作指导｜约束而非已发生事实】\n${guidance}`, `[Author global creative guidance | constraint, not established history]\n${guidance}`),
      promptLanguageText(language, `【作者确认项目配置｜约束而非已发生事实】\n${JSON.stringify(frozen.config, null, 2)}`,
        `[Author-confirmed project configuration | constraint, not established history]\n${JSON.stringify(frozen.config, null, 2)}`),
      promptLanguageText(language, '【当前及未来蓝图/计划｜非既定历史】', '[Current and future blueprints/plans | not established history]'),
      JSON.stringify(frozen.blueprints, null, 2),
      buildChapterGoalReviewPrompt(frozen.frozenGoals, language),
    ].join('\n\n')
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
    parseReviewGenerationResult(this.stripThinkingTags(artifact.text))
    return ipc.invokeWithProjectSession(requireWorkflowProjectSession(params.context), 'review-revision:commit-review', {
      contextId: prepared.contextId, handle,
      artifact: { artifactId: artifact.artifactId, revision: artifact.revision, textHash: artifact.textHash },
    })
  }
}
