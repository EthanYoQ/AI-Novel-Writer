import type { Locale } from '../../i18n/types'
import {
  PromptBudgetExceededError,
  type PromptBudgetReport,
} from './generation-harness'

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

function sectionLabel(sectionName: string, locale: Locale): string {
  const labels = SECTION_LABELS[sectionName]
  if (!labels) return locale === 'zh-CN' ? '其他结构化上下文' : 'Other structured context'
  return locale === 'zh-CN' ? labels[0] : labels[1]
}

function formatInteger(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value)
}

/** Formats only the safe byte report; prompt fragments never cross this boundary. */
export function formatPromptBudgetFailure(report: PromptBudgetReport, locale: Locale): string {
  const contributors = [...report.sections]
    .sort((left, right) => right.utf8Bytes - left.utf8Bytes)
    .slice(0, 3)
    .map(section => `${sectionLabel(section.sectionName, locale)} ${formatInteger(section.utf8Bytes, locale)}`)
    .join(locale === 'zh-CN' ? '、' : ', ')

  if (locale === 'zh-CN') {
    return [
      `提示词共 ${formatInteger(report.totalUtf8Bytes, locale)} UTF-8 字节，超过上限 ${formatInteger(report.limitUtf8Bytes, locale)} 字节；输出保留空间为 ${formatInteger(report.reservedOutputTokens, locale)} tokens。`,
      `主要占用：${contributors}。`,
      `模型：${report.modelId}；结果码：${report.errorCode}。请在小说配置中缩短上述字段后重试。`,
    ].join('')
  }

  return [
    `The prompt uses ${formatInteger(report.totalUtf8Bytes, locale)} UTF-8 bytes, exceeding the ${formatInteger(report.limitUtf8Bytes, locale)}-byte limit; ${formatInteger(report.reservedOutputTokens, locale)} tokens are reserved for output. `,
    `Top contributors: ${contributors}. `,
    `Model: ${report.modelId}; result code: ${report.errorCode}. Shorten those fields in Novel configuration, then try again.`,
  ].join('')
}

export function promptBudgetFailureFromError(
  error: unknown,
  locale: Locale,
): { failureCode: PromptBudgetFailureCode; message: string } | undefined {
  if (!(error instanceof PromptBudgetExceededError)) return undefined
  return {
    failureCode: PROMPT_BUDGET_FAILURE_CODE,
    message: formatPromptBudgetFailure(error.report, locale),
  }
}
