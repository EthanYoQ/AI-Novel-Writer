import type { Locale } from '../i18n/types'
import { safeReceiptPurpose } from './generation/generation-harness'
import type { LLMCallRecord } from './stats-service'

type PromptBudgetSection = { sectionName?: unknown; utf8Bytes?: unknown }

export interface SafeDiagnosticWorkflow {
  status?: unknown
  failureCode?: unknown
  stepName?: unknown
  stepStatus?: unknown
  stepFailureCode?: unknown
  finishReason?: unknown
  promptBudgetReport?: {
    totalUtf8Bytes?: unknown
    limitUtf8Bytes?: unknown
    reservedOutputTokens?: unknown
    sections?: readonly PromptBudgetSection[]
  }
  [key: string]: unknown
}

export interface SafeCallDiagnosticInput {
  locale: Locale
  appVersion?: unknown
  platform?: unknown
  call: LLMCallRecord
  workflow?: SafeDiagnosticWorkflow
}

const CODE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const WORKFLOW_STATUS = new Set(['pending', 'running', 'waiting', 'paused', 'cancelling', 'completed', 'failed', 'cancelled'])
const FAILURE_CODE = new Set(['length', 'content_filter', 'cancelled', 'error', 'unknown', 'prompt_budget_exhausted'])
const FINISH_REASON = new Set(['stop', 'length', 'content_filter', 'cancelled', 'error', 'unknown'])
const PLATFORM = new Set(['windows', 'macos', 'linux'])
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._():+/-]{0,79}$/
const SAFE_STEP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._:：()（）/—–-]{0,79}$/u
const SENSITIVE_TEXT = /(?:authorization|bearer|api[ _-]?key|secret|\btoken\b|\bsk-)/i
const PATH_SHAPED_TEXT = /(?:^[A-Za-z]:\/|^[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:^|\/)\.{1,2}(?:\/|$)|\/\/)/

function safeCode(value: unknown, allowed?: Set<string>): string | undefined {
  if (typeof value !== 'string' || !CODE.test(value)) return undefined
  return !allowed || allowed.has(value) ? value : undefined
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

export function safeModelName(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || !MODEL_NAME.test(value)
    || SENSITIVE_TEXT.test(value)
    || PATH_SHAPED_TEXT.test(value)
  ) return undefined
  return value
}

function safePurpose(value: unknown): string | undefined {
  if (typeof value !== 'string' || SENSITIVE_TEXT.test(value)) return undefined
  const purpose = safeReceiptPurpose(value)
  return purpose === 'unknown' ? undefined : purpose
}

function safeStepName(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || !SAFE_STEP_NAME.test(value)
    || SENSITIVE_TEXT.test(value)
    || PATH_SHAPED_TEXT.test(value)
  ) return undefined
  return value
}

export function formatSafeCallDiagnostic(input: SafeCallDiagnosticInput): string {
  const zh = input.locale === 'zh-CN'
  const unknown = zh ? '未知' : 'unknown'
  const value = (candidate: unknown) => candidate ?? unknown
  const workflow = input.workflow
  const budget = workflow?.promptBudgetReport
  const sections = Array.isArray(budget?.sections)
    ? budget.sections.flatMap((section) => {
        const name = safeCode(section.sectionName)
        const bytes = safeNumber(section.utf8Bytes)
        return name && bytes !== undefined ? [{ name, bytes }] : []
      })
    : []

  const labels = zh ? {
    title: 'AI 小说作家安全诊断', environment: '环境', call: '模型调用', workflow: '工作流', budget: '提示词预算',
    version: '应用版本', platform: '平台', actualModel: '实际模型', model: '模型 ID', purpose: '用途', requested: '请求时间', duration: '耗时（毫秒）',
    prompt: '输入 Tokens', completion: '输出 Tokens', total: '总 Tokens', result: '调用结果', success: '成功', failure: '失败',
    status: '工作流状态', failureCode: '工作流失败码', step: '步骤', stepStatus: '步骤状态', stepFailure: '步骤失败码', finish: '结束原因',
    actual: '实际字节', limit: '限制字节', reserved: '预留输出 Tokens', section: '区段', bytes: '字节',
  } : {
    title: 'AI Novel Writer safe diagnostics', environment: 'Environment', call: 'Model call', workflow: 'Workflow', budget: 'Prompt budget',
    version: 'App version', platform: 'Platform', actualModel: 'Actual model', model: 'Model ID', purpose: 'Purpose', requested: 'Request time', duration: 'Duration (ms)',
    prompt: 'Prompt tokens', completion: 'Completion tokens', total: 'Total tokens', result: 'Call result', success: 'success', failure: 'failure',
    status: 'Workflow status', failureCode: 'Workflow failure code', step: 'Step', stepStatus: 'Step status', stepFailure: 'Step failure code', finish: 'Finish reason',
    actual: 'Actual bytes', limit: 'Limit bytes', reserved: 'Reserved output tokens', section: 'Section', bytes: 'Bytes',
  }

  const lines = [
    `# ${labels.title}`,
    '', `## ${labels.environment}`,
    `- ${labels.version}: ${value(typeof input.appVersion === 'string' && SEMVER.test(input.appVersion) ? input.appVersion : undefined)}`,
    `- ${labels.platform}: ${value(safeCode(input.platform, PLATFORM))}`,
    '', `## ${labels.call}`,
    `- ${labels.actualModel}: ${value(safeModelName(input.call.modelName))}`,
    `- ${labels.model}: ${value(typeof input.call.modelId === 'string' && UUID.test(input.call.modelId) ? input.call.modelId : undefined)}`,
    `- ${labels.purpose}: ${value(safePurpose(input.call.purpose))}`,
    `- ${labels.requested}: ${value(safeTimestamp(input.call.createdAt))}`,
    `- ${labels.duration}: ${value(safeNumber(input.call.durationMs))}`,
    `- ${labels.prompt}: ${value(safeNumber(input.call.promptTokens))}`,
    `- ${labels.completion}: ${value(safeNumber(input.call.completionTokens))}`,
    `- ${labels.total}: ${value(safeNumber(input.call.totalTokens))}`,
    `- ${labels.result}: ${input.call.success ? labels.success : labels.failure}`,
    '', `## ${labels.workflow}`,
    `- ${labels.status}: ${value(safeCode(workflow?.status, WORKFLOW_STATUS))}`,
    `- ${labels.failureCode}: ${value(safeCode(workflow?.failureCode, FAILURE_CODE))}`,
    `- ${labels.step}: ${value(safeStepName(workflow?.stepName))}`,
    `- ${labels.stepStatus}: ${value(safeCode(workflow?.stepStatus, WORKFLOW_STATUS))}`,
    `- ${labels.stepFailure}: ${value(safeCode(workflow?.stepFailureCode, FAILURE_CODE))}`,
    `- ${labels.finish}: ${value(safeCode(workflow?.finishReason, FINISH_REASON))}`,
    '', `## ${labels.budget}`,
    `- ${labels.actual}: ${value(safeNumber(budget?.totalUtf8Bytes))}`,
    `- ${labels.limit}: ${value(safeNumber(budget?.limitUtf8Bytes))}`,
    `- ${labels.reserved}: ${value(safeNumber(budget?.reservedOutputTokens))}`,
    '', `| ${labels.section} | ${labels.bytes} |`, '| --- | ---: |',
    ...(sections.length > 0 ? sections.map(section => `| ${section.name} | ${section.bytes} |`) : [`| ${unknown} | ${unknown} |`]),
  ]
  return lines.join('\n')
}

export function coarseRuntimePlatform(platform: string | undefined): 'windows' | 'macos' | 'linux' | undefined {
  const normalized = platform?.toLowerCase() ?? ''
  if (normalized.includes('win')) return 'windows'
  if (normalized.includes('mac')) return 'macos'
  if (normalized.includes('linux')) return 'linux'
  return undefined
}
