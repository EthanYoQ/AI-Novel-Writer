import type { Locale } from '../../i18n/types'
import type { WorkflowFailureCode } from '../../stores/workflow-store'

export interface WorkflowFailurePresentation {
  heading: string
  reason: string
  persistence?: string
  action?: 'open-novel-config'
  actionLabel?: string
}

export function presentWorkflowFailure(
  failureCode: WorkflowFailureCode | undefined,
  error: string | undefined,
  locale: Locale,
  isUnpersistedChapterDraft: boolean,
): WorkflowFailurePresentation {
  if (failureCode === 'prompt_budget_exhausted') {
    return locale === 'zh-CN'
      ? {
          heading: '提示词预算不足',
          reason: error?.trim() || '受保护的结构化请求超过了安全字节上限。',
          persistence: '模型调用未发起，也未消费本次生成尝试。请缩短列出的主要占用字段后重试。',
          action: 'open-novel-config',
          actionLabel: '打开小说配置',
        }
      : {
          heading: 'Prompt budget is insufficient',
          reason: error?.trim() || 'The protected structured request exceeded its safe byte limit.',
          persistence: 'No model call was made and no generation attempt was consumed. Shorten the listed top-contributing fields, then try again.',
          action: 'open-novel-config',
          actionLabel: 'Open novel configuration',
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
