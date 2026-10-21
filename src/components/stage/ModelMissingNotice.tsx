import { useLocaleStore } from '../../stores/locale-store'
import { navigate } from '../../stores/navigation/navigation-intents'
import { Button } from '../ui/Button'
import { Notice } from '../ui/Notice'

/** 未配置模型时的首次使用引导：书房与设定页同一句说明，并给出去设置添加的入口。 */
export default function ModelMissingNotice() {
  const text = useLocaleStore(s => s.text)
  return (
    <Notice
      tone="info"
      title={text('还没有连接 AI 模型', 'No AI model connected yet')}
      actions={(
        <Button variant="secondary" size="sm" onClick={() => navigate({ kind: 'settings', section: 'llm' })}>
          {text('添加模型', 'Add a model')}
        </Button>
      )}
    >
      {text('不用模型也能新建作品、手写设定；写作、审稿、修稿和 AI 填充要用到它。', 'You can start a book and write its setup without one. Writing, reviews, revisions and AI fill need it.')}
    </Notice>
  )
}
