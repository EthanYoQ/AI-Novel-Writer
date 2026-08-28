import type { Locale } from '../../i18n/types'
import type { PromptBudgetReport } from '../../services/generation/generation-harness'
import type { WorkflowFailureCode } from '../../stores/workflow-store'

export interface WorkflowFailurePresentation {
  heading: string
  reason: string
  persistence?: string
  guidance?: string
  action?: 'open-novel-config'
  actionLabel?: string
}

const NOVEL_CONFIG_SECTIONS = new Set([
  'global-guidance',
  'reference-works',
  'genre',
  'protagonist-profile',
  'project-chapter-count',
])

const INTERNAL_OVERHEAD_SECTIONS = new Set(['system-instructions', 'prompt-overhead'])

function primaryProtectedSection(report: PromptBudgetReport | undefined): string | undefined {
  return report?.sections
    .filter(section => !INTERNAL_OVERHEAD_SECTIONS.has(section.sectionName))
    .sort((left, right) => right.utf8Bytes - left.utf8Bytes)[0]?.sectionName
}

function promptBudgetAdjustment(
  report: PromptBudgetReport | undefined,
  locale: Locale,
): Pick<WorkflowFailurePresentation, 'guidance' | 'action' | 'actionLabel'> {
  const sectionName = primaryProtectedSection(report)
  if (sectionName && NOVEL_CONFIG_SECTIONS.has(sectionName)) {
    return locale === 'zh-CN'
      ? {
          guidance: '请在小说配置中缩短列出的项目配置字段后重试。',
          action: 'open-novel-config',
          actionLabel: '打开小说配置',
        }
      : {
          guidance: 'Shorten the listed project configuration fields in Novel configuration, then try again.',
          action: 'open-novel-config',
          actionLabel: 'Open novel configuration',
        }
  }

  if (sectionName === 'step-guidance') {
    return {
      guidance: locale === 'zh-CN'
        ? '请返回该生成步骤，缩短步骤指导后重试。'
        : 'Return to that generation step, shorten its step guidance, and try again.',
    }
  }
  if (sectionName === 'knowledge-base') {
    return {
      guidance: locale === 'zh-CN'
        ? '请减少本次使用的知识库内容或缩小检索范围后重试。'
        : 'Reduce the knowledge-base content used for this request or narrow the retrieval scope, then try again.',
    }
  }
  if (sectionName === 'validated-prefix' || sectionName === 'batch-slot-ids') {
    return {
      guidance: locale === 'zh-CN'
        ? '请减小本次结构化批次后重试；已验证内容不会被静默截断。'
        : 'Reduce this structured batch and try again; validated content will not be silently truncated.',
    }
  }
  if (sectionName === 'repair-candidate') {
    return {
      guidance: locale === 'zh-CN'
        ? '请缩短待修复的结构化内容，或将本次导入或生成拆成更小批次后重试。'
        : 'Shorten the structured content being repaired, or split this import or generation into smaller batches, then try again.',
    }
  }
  if (sectionName === 'repair-contract') {
    return {
      guidance: locale === 'zh-CN'
        ? '结构化修复合同不能在界面中安全编辑。请缩小本次任务范围；若问题持续，请记录结果码并反馈。'
        : 'The structured repair contract cannot be safely edited in the interface. Reduce this task scope; if the problem persists, report the result code.',
    }
  }
  if (
    sectionName === 'architecture'
    || sectionName === 'story-premise'
    || sectionName === 'identity-manifest'
    || sectionName === 'previous-blueprints'
    || sectionName === 'target-chapter'
  ) {
    return {
      guidance: locale === 'zh-CN'
        ? '请缩短相关故事架构内容，或缩小本次生成范围后重试。'
        : 'Shorten the related story-architecture content or reduce this generation scope, then try again.',
    }
  }
  return {
    guidance: locale === 'zh-CN'
      ? '请缩小本次生成范围后重试；若问题持续，请记录结果码并反馈。'
      : 'Reduce this generation scope and try again; if the problem persists, report the result code.',
  }
}

export function presentWorkflowFailure(
  failureCode: WorkflowFailureCode | undefined,
  error: string | undefined,
  locale: Locale,
  isUnpersistedChapterDraft: boolean,
  promptBudgetReport?: PromptBudgetReport,
): WorkflowFailurePresentation {
  if (failureCode === 'prompt_budget_exhausted') {
    const adjustment = promptBudgetAdjustment(promptBudgetReport, locale)
    return locale === 'zh-CN'
      ? {
          heading: '提示词预算不足',
          reason: error?.trim() || '受保护的结构化请求超过了安全字节上限。',
          persistence: '本次被预算预检阻止的请求未发送，未产生额外模型尝试或消费。',
          ...adjustment,
        }
      : {
          heading: 'Prompt budget is insufficient',
          reason: error?.trim() || 'The protected structured request exceeded its safe byte limit.',
          persistence: 'The request blocked by this budget preflight was not sent and caused no additional model attempt or consumption.',
          ...adjustment,
        }
  }

  if (failureCode === 'content_filter') {
    return locale === 'zh-CN'
      ? {
          heading: '正文生成被内容策略拦截',
          reason: '模型的内容安全策略拦截了这次输出。',
          persistence: '本次未保存草稿或正文章节。请调整章节要求，或选择符合预期内容政策的模型后重试。',
        }
      : {
          heading: 'Draft generation was blocked by the content policy',
          reason: 'The model safety policy filtered this output.',
          persistence: 'No draft or manuscript chapter was saved. Adjust the chapter request, or choose a model whose policy fits your intended permitted content, then try again.',
        }
  }

  return locale === 'zh-CN'
    ? {
        heading: '工作流未完成',
        reason: error?.trim() || '生成在完成前停止。',
        persistence: isUnpersistedChapterDraft
          ? '本次未保存草稿或正文章节。请调整章节要求后重试。'
          : undefined,
      }
    : {
        heading: 'Workflow did not finish',
        reason: error?.trim() || 'Generation stopped before it completed.',
        persistence: isUnpersistedChapterDraft
          ? 'This attempt did not save a draft or manuscript chapter. Adjust the chapter request and try again.'
          : undefined,
      }
}
