import { BookOpen, FolderOpen, Activity } from 'lucide-react'
import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { APP_BRAND } from '../../../shared/brand'
import { modelDisplayName } from '../../../shared/model-display'
import { useLocaleStore } from '../../../stores/locale-store'
import AITaskCapsule from '../AITaskCapsule'

/**
 * 「墨纸书斋」状态栏（v2）。
 *
 * 与 demo 的分段结构一致：品牌 | 项目 | …… | AI 任务胶囊 | 当前模型。
 * demo 里还有「全书字数」一段，但产品当前没有可靠的实时字数来源，
 * 这里宁可留空也不摆假数字 —— 等有真实数据源再补。
 */
export default function StatusBarV2() {
  const currentProject = useProjectStore((s) => s.currentProject)
  const models = useLLMStore((s) => s.models)
  const defaultModelId = useLLMStore((s) => s.defaultModelId)
  const openSettings = useLayoutStore((s) => s.openSettings)
  const text = useLocaleStore((s) => s.text)

  const defaultModel = models.find(
    (m) => m.id === defaultModelId && m.purposes?.some((p) => p !== 'embedding'),
  )
  // 别名可能为空（新建模型时不强制起名），回退到 modelName / provider，
  // 否则这一段会渲染成空白，看起来像「当前模型不见了」。
  const modelLabel = modelDisplayName(defaultModel)

  return (
    <footer className="statusbar no-select">
      <span className="st-seg" title={text(APP_BRAND.zhName, APP_BRAND.enName)}>
        <BookOpen size={10} strokeWidth={1.8} />
        <span className="bright">{text(APP_BRAND.shortName, APP_BRAND.enName)}</span>
        {/* 先生：底栏要带上版本号，否则后续版本容易错乱（经典界面的状态栏早就有，v2 漏了）。
            V3 为待推送分支标识；`-0.1` 是先生定的本次打包版本区分（2026-09-22）。 */}
        <span className="dim">v{__APP_VERSION__} V3-0.1</span>
      </span>

      {currentProject && (
        <>
          <span className="st-sep">|</span>
          <span className="st-seg" title={currentProject.path}>
            <FolderOpen size={10} strokeWidth={1.8} />
            <span className="dim">{currentProject.name}</span>
          </span>
        </>
      )}

      <span className="st-grow" />

      <span className="st-seg">
        <AITaskCapsule />
      </span>

      <span
        className="st-seg click"
        title={modelLabel
          ? text(`当前模型：${modelLabel}`, `Current model: ${modelLabel}`)
          : text('点击配置模型', 'Click to configure a model')}
        onClick={() => openSettings('llm')}
      >
        <Activity size={10} strokeWidth={1.8} />
        <span className="dim">
          {modelLabel || text('未配置模型', 'No model configured')}
        </span>
      </span>
    </footer>
  )
}
