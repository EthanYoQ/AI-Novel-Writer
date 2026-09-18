import type { Locale } from '../../i18n/types'
import {
  PromptBudgetExceededError,
  type PromptBudgetReport,
} from './generation-harness'
import type {
  GenerationBudgetDiagnostic,
  TaskBudgetDecision,
  TaskBudgetReasonCode,
} from './task-budget-planner'

export const PROMPT_BUDGET_FAILURE_CODE = 'prompt_budget_exhausted' as const

export type PromptBudgetFailureCode = typeof PROMPT_BUDGET_FAILURE_CODE

const SECTION_LABELS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  'global-guidance': ['全局指导', 'Global guidance'],
  'step-guidance': ['步骤指导', 'Step guidance'],
  'reference-works': ['参考作品', 'Reference works'],
  'knowledge-base': ['知识库', 'Knowledge base'],
  'story-premise': ['故事前提', 'Story premise'],
  genre: ['作品类型', 'Genre'],
  'protagonist-profile': ['主角设定', 'Protagonist profile'],
  'identity-manifest': ['角色身份清单', 'Character identity manifest'],
  'validated-prefix': ['已验证角色详情', 'Validated character details'],
  'batch-slot-ids': ['本批角色标识', 'Batch character identifiers'],
  architecture: ['故事架构', 'Story architecture'],
  'previous-blueprints': ['已有章节蓝图', 'Previous chapter blueprints'],
  'target-chapter': ['目标章节', 'Target chapter'],
  'project-chapter-count': ['项目章节数', 'Project chapter count'],
  'repair-contract': ['结构化修复合同', 'Structured repair contract'],
  'repair-candidate': ['待修复候选', 'Repair candidate'],
  'system-instructions': ['系统指令', 'System instructions'],
  'continuation-request': ['续写请求', 'Continuation request'],
  'prompt-overhead': ['模板与结构开销', 'Template and structure overhead'],
})

function sectionLabel(
  section: PromptBudgetReport['sections'][number],
  locale: Locale,
): string {
  if (section.sectionName === 'writing-skill') {
    const generic = locale === 'zh-CN' ? '写作 Skill' : 'Writing Skill'
    if (!section.displayName) return generic
    return locale === 'zh-CN'
      ? `${generic}：${section.displayName}`
      : `${generic}: ${section.displayName}`
  }
  const labels = SECTION_LABELS[section.sectionName]
  if (!labels) return locale === 'zh-CN' ? '其他结构化上下文' : 'Other structured context'
  return locale === 'zh-CN' ? labels[0] : labels[1]
}

function formatInteger(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value)
}

export type GenerationFailureCategory =
  | 'capacity-preflight'
  | 'budget-exhausted'
  | 'provider-length'
  | 'network'
  | 'storage'
  | 'cancelled'
  | 'unknown'

const CAPACITY_FAILURES = new Set([
  'GENERATION_INPUT_CAPACITY_EXCEEDED',
  'GENERATION_MODEL_CAPABILITY_UNKNOWN',
  'GENERATION_LIABILITY_UNBOUNDED',
  'TASK_BUDGET_CAPACITY_CONFLICT',
  'PROMPT_BUDGET_EXHAUSTED',
])
const BUDGET_FAILURES = new Set([
  'ROOT_BUDGET_EXHAUSTED',
  'ATTEMPT_BUDGET_EXHAUSTED',
  'REQUESTED_TOKEN_BUDGET_EXHAUSTED',
  'DEADLINE_EXHAUSTED',
])
const NETWORK_FAILURES = new Set([
  'NETWORK_ERROR',
  'ECONNRESET',
  'ETIMEDOUT',
  'FETCH_FAILED',
])
const STORAGE_FAILURES = new Set([
  'GENERATION_STORAGE_FAILED',
  'PERSISTENCE_FAILED',
  'DB_WRITE_FAILED',
  'SQLITE_FULL',
  'ENOSPC',
  'EACCES',
])
const CANCELLED_FAILURES = new Set([
  'GENERATION_CANCELLED',
  'CANCELLED',
])

export function classifyGenerationFailure(
  failureCode: string | null | undefined,
  finishReason: string | null | undefined,
): GenerationFailureCategory {
  const code = failureCode?.trim().toUpperCase() ?? ''
  const finish = finishReason?.trim().toLowerCase() ?? ''
  if (finish === 'length' || finish === 'max_tokens' || finish === 'max_output_tokens') return 'provider-length'
  if (finish === 'cancelled' || CANCELLED_FAILURES.has(code)) return 'cancelled'
  // IPC may wrap a stable code in an invocation prefix, and the budget owner
  // appends a non-sensitive reason after a colon. Both remain preflight facts.
  // The main preflight emits `TASK_BUDGET_SCOPE_SPLIT_REQUIRED`; the batch
  // executor consumes that exact spelling, so accept both here.
  if (
    code.includes('TASK_BUDGET_CAPACITY_CONFLICT')
    || code.includes('TASK_BUDGET_SPLIT_REQUIRED')
    || code.includes('TASK_BUDGET_SCOPE_SPLIT_REQUIRED')
  ) return 'capacity-preflight'
  if (CAPACITY_FAILURES.has(code)) return 'capacity-preflight'
  if (BUDGET_FAILURES.has(code)) return 'budget-exhausted'
  if (NETWORK_FAILURES.has(code)) return 'network'
  if (STORAGE_FAILURES.has(code)) return 'storage'
  return 'unknown'
}

const REASON_LABELS: Readonly<Record<TaskBudgetReasonCode, readonly [string, string]>> = Object.freeze({
  'task-demand': ['任务完整范围', 'Complete task scope'],
  'input-upper-bound': ['输入估计上界', 'Input estimate upper bound'],
  'safety-margin': ['上下文安全余量', 'Context safety margin'],
  'model-context-cap': ['模型上下文剩余空间', 'Remaining model context'],
  'model-output-cap': ['模型输出上限', 'Model output limit'],
  'user-context-cap': ['用户上下文设置', 'User context setting'],
  'user-output-cap': ['用户输出设置', 'User output setting'],
  'root-output-cap': ['单次请求安全上限', 'Per-request safety limit'],
  'root-remaining-cap': ['父任务剩余额度', 'Parent task remainder'],
  'protocol-reasoning-reserve': ['独立推理预留', 'Separate reasoning reserve'],
  'protocol-total-bound': ['协议总开销上限', 'Protocol total-liability limit'],
  'model-capability-unknown': ['模型能力未经验证', 'Unverified model capability'],
  'liability-bound-unknown': ['协议总开销无法约束', 'Unbounded protocol liability'],
  'required-input-capacity-conflict': ['必需输入与输出空间冲突', 'Required input conflicts with output capacity'],
  'single-item-capacity-conflict': ['单个结构项无法容纳', 'One structured item does not fit'],
  'draft-segmentation-disabled': ['此正文任务不能安全分段', 'This draft task cannot be segmented safely'],
  'scope-split': ['已缩小本次范围', 'This request uses a smaller scope'],
})

function reasonLabel(code: TaskBudgetReasonCode, locale: Locale): string {
  const labels = REASON_LABELS[code]
  return locale === 'zh-CN' ? labels[0] : labels[1]
}

function failureCategoryLabel(category: GenerationFailureCategory, locale: Locale): string {
  const labels: Readonly<Record<GenerationFailureCategory, readonly [string, string]>> = {
    'capacity-preflight': ['容量预检', 'Capacity preflight'],
    'budget-exhausted': ['父任务预算', 'Parent task budget'],
    'provider-length': ['服务商长度终止', 'Provider length stop'],
    network: ['网络', 'Network'],
    storage: ['保存', 'Storage'],
    cancelled: ['已取消', 'Cancelled'],
    unknown: ['其他', 'Other'],
  }
  return locale === 'zh-CN' ? labels[category][0] : labels[category][1]
}

export function formatTaskBudgetDecisionFailure(
  decision: TaskBudgetDecision,
  locale: Locale,
): string {
  const decisive = decision.reasons.filter(reason => reason.selected).map(reason => reasonLabel(reason.code, locale))
  if (locale === 'zh-CN') {
    return `任务需要 ${formatInteger(decision.requestedOutputTokens, locale)} 个输出 tokens；本次未发送。裁决依据：${decisive.join('、')}。`
  }
  return `The task needs ${formatInteger(decision.requestedOutputTokens, locale)} output tokens; no request was sent. Decision factors: ${decisive.join(', ')}.`
}

/** Formats only safe accounting fields. Prompt text, endpoint details and keys are absent by type. */
export function formatGenerationBudgetDiagnostic(
  diagnostic: GenerationBudgetDiagnostic,
  locale: Locale,
): string {
  const category = classifyGenerationFailure(diagnostic.failureCode, diagnostic.finishReason)
  const categoryText = category === 'unknown'
    ? diagnostic.actualState === 'settled'
      ? (locale === 'zh-CN' ? '预算结算' : 'Budget settled')
      : diagnostic.actualState === 'reserved'
        ? (locale === 'zh-CN' ? '预算预留' : 'Budget reserved')
        : diagnostic.actualState === 'not-dispatched'
          ? (locale === 'zh-CN' ? '未发送' : 'Not dispatched')
          : (locale === 'zh-CN' ? '用量待确认' : 'Usage pending confirmation')
    : failureCategoryLabel(category, locale)
  const requested = formatInteger(diagnostic.requestedOutputTokens, locale)
  const reserved = formatInteger(diagnostic.reservedTokens, locale)
  const selectedReasons = diagnostic.reasons
    .filter(reason => reason.selected)
    .map(reason => reasonLabel(reason.code, locale))
  const reasonSuffix = selectedReasons.length === 0
    ? ''
    : locale === 'zh-CN'
      ? `裁决依据：${selectedReasons.join('、')}。`
      : `Decision factors: ${selectedReasons.join(', ')}.`
  if (diagnostic.actualState === 'not-dispatched') {
    return locale === 'zh-CN'
      ? `${categoryText}；需求输出 ${requested} tokens，原总预留 ${reserved} tokens；请求未发送，预留已释放。${reasonSuffix}`
      : `${categoryText}; requested output ${requested} tokens, original total reservation ${reserved} tokens; no request was sent and the reservation was released. ${reasonSuffix}`.trim()
  }
  if (diagnostic.actualState === 'unknown') {
    return locale === 'zh-CN'
      ? `${categoryText}；需求输出 ${requested} tokens，总预留 ${reserved} tokens；实际用量未知，父任务仍按预留额度保守记账。${reasonSuffix}`
      : `${categoryText}; requested output ${requested} tokens, total reserved ${reserved} tokens; actual usage is unknown, so the parent task conservatively keeps the reservation. ${reasonSuffix}`.trim()
  }
  if (diagnostic.actualState === 'reserved') {
    return locale === 'zh-CN'
      ? `${categoryText}；需求输出 ${requested} tokens，总预留 ${reserved} tokens；请求尚未结算。${reasonSuffix}`
      : `${categoryText}; requested output ${requested} tokens, total reserved ${reserved} tokens; the request has not settled yet. ${reasonSuffix}`.trim()
  }
  const actual = diagnostic.actual
  const total = actual?.total === null || actual?.total === undefined
    ? (locale === 'zh-CN' ? '未知' : 'unknown')
    : `${formatInteger(actual.total, locale)} tokens`
  const parts = actual
    ? [
        [locale === 'zh-CN' ? '输入' : 'input', actual.input],
        [locale === 'zh-CN' ? '输出' : 'completion', actual.completion],
        [locale === 'zh-CN' ? '推理' : 'reasoning', actual.reasoning],
      ].map(([label, value]) => `${label} ${value === null ? (locale === 'zh-CN' ? '未知' : 'unknown') : formatInteger(Number(value), locale)}`)
        .join(locale === 'zh-CN' ? '、' : ', ')
    : (locale === 'zh-CN' ? '分项未知' : 'breakdown unknown')
  return locale === 'zh-CN'
    ? `${categoryText}；需求输出 ${requested} tokens，总预留 ${reserved} tokens；实际总量 ${total}（${parts}）。${reasonSuffix}`
    : `${categoryText}; requested output ${requested} tokens, total reserved ${reserved} tokens; actual total ${total} (${parts}). ${reasonSuffix}`.trim()
}

/** Formats only the safe byte report; prompt fragments never cross this boundary. */
export function formatPromptBudgetFailure(report: PromptBudgetReport, locale: Locale): string {
  const contributors = [...report.sections]
    .sort((left, right) => right.utf8Bytes - left.utf8Bytes)
    .slice(0, 3)
    .map(section => `${sectionLabel(section, locale)} ${formatInteger(section.utf8Bytes, locale)}`)
    .join(locale === 'zh-CN' ? '、' : ', ')

  if (locale === 'zh-CN') {
    const contextWindow = report.contextWindowTokens == null
      ? '未知'
      : `${formatInteger(report.contextWindowTokens, locale)} tokens`
    const estimatedInput = report.estimatedInputTokens === undefined
      ? '未知'
      : `${formatInteger(report.estimatedInputTokens, locale)} tokens`
    return [
      `提示词共 ${formatInteger(report.totalUtf8Bytes, locale)} UTF-8 字节，超过上限 ${formatInteger(report.limitUtf8Bytes, locale)} 字节；输出保留空间为 ${formatInteger(report.reservedOutputTokens, locale)} tokens。`,
      `模型上下文：${contextWindow}；估算输入：${estimatedInput}。`,
      `主要占用：${contributors}。`,
      `模型：${report.modelId}；结果码：${report.errorCode}。`,
    ].join('')
  }

  const contextWindow = report.contextWindowTokens == null
    ? 'unknown'
    : `${formatInteger(report.contextWindowTokens, locale)} tokens`
  const estimatedInput = report.estimatedInputTokens === undefined
    ? 'unknown'
    : `${formatInteger(report.estimatedInputTokens, locale)} tokens`
  return [
    `The prompt uses ${formatInteger(report.totalUtf8Bytes, locale)} UTF-8 bytes, exceeding the ${formatInteger(report.limitUtf8Bytes, locale)}-byte limit; ${formatInteger(report.reservedOutputTokens, locale)} tokens are reserved for output. `,
    `Model context: ${contextWindow}; estimated input: ${estimatedInput}. `,
    `Top contributors: ${contributors}. `,
    `Model: ${report.modelId}; result code: ${report.errorCode}.`,
  ].join('')
}

export function promptBudgetFailureFromError(
  error: unknown,
  locale: Locale,
): { failureCode: PromptBudgetFailureCode; message: string; report: PromptBudgetReport } | undefined {
  if (!(error instanceof PromptBudgetExceededError)) return undefined
  return {
    failureCode: PROMPT_BUDGET_FAILURE_CODE,
    message: formatPromptBudgetFailure(error.report, locale),
    report: error.report,
  }
}
