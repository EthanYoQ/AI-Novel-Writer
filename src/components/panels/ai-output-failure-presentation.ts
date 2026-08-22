import type { Locale } from '../../i18n/types'
import type { WorkflowFailureCode } from '../../stores/workflow-store'

export interface WorkflowFailurePresentation {
  heading: string
  reason: string
  persistence?: string
}

export function presentWorkflowFailure(
  failureCode: WorkflowFailureCode | undefined,
  error: string | undefined,
  locale: Locale,
  isUnpersistedChapterDraft: boolean,
): WorkflowFailurePresentation {
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
