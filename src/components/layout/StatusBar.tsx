import { Wifi, BookOpen, FolderOpen } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { useLayoutStore } from '../../stores/layout-store'
import { APP_BRAND } from '../../shared/brand'
import { modelDisplayName } from '../../shared/model-display'
import { useLocaleStore } from '../../stores/locale-store'
import AITaskCapsule from './AITaskCapsule'

/** 底部状态栏 — JetBrains 风格：22px、深灰底、多分段、hover 可点击感 */
export default function StatusBar() {
  const currentProject = useProjectStore((s) => s.currentProject)
  const models = useLLMStore(s => s.models)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const openSettings = useLayoutStore(s => s.openSettings)
  const defaultModel = models.find(
    (m) => m.id === defaultModelId && m.purposes?.some((p) => p !== 'embedding')
  )
  // 别名可能为空（新建模型时不强制起名），回退到 modelName / provider，
  // 否则这一段会渲染成空白，看起来像「当前模型不见了」。
  const modelLabel = modelDisplayName(defaultModel)
  const text = useLocaleStore(s => s.text)

  return (
    <div
      className="writer-statusbar no-select flex items-center justify-between"
      style={{
        height: 'var(--height-statusbar)',
        fontSize: "0.75rem",
        flexShrink: 0,
      }}
    >
      {/* 左侧 */}
      <div className="flex items-center h-full">
        <StatusBarSegment title={text(APP_BRAND.zhName, APP_BRAND.enName)}>
          <BookOpen size={11} />
          <span className="font-medium brand-gradient">{text(APP_BRAND.shortName, APP_BRAND.enName)}</span>
          {/* V3=待推送分支标识，`-0.1`=先生定的本次打包版本区分（2026-09-22），与 v2/v3 外壳状态栏保持一致 */}
          <span className="opacity-80 brand-gradient">v{__APP_VERSION__} V3-0.1</span>
        </StatusBarSegment>

        {currentProject && (
          <>
            <StatusBarDivider />
            <StatusBarSegment title={currentProject.path}>
              <FolderOpen size={11} style={{ opacity: 0.7 }} />
              <span className="opacity-80 max-w-[180px] truncate">{currentProject.name}</span>
            </StatusBarSegment>
          </>
        )}

      </div>

      {/* 右侧：AI 胶囊 + 模型名 */}
      <div className="flex items-center h-full">
        {/* AI 任务胶囊指示器（右下角） */}
        <AITaskCapsule />

        {modelLabel ? (
          <StatusBarSegment
            title={text(`当前模型：${modelLabel}`, `Current model: ${modelLabel}`)}
            onClick={openSettings}
          >
            <Wifi size={11} />
            <span className="opacity-80 max-w-[120px] truncate">{modelLabel}</span>
          </StatusBarSegment>
        ) : (
          <StatusBarSegment
            title={text('点击配置模型', 'Click to configure a model')}
            onClick={openSettings}
          >
            <span className="opacity-50">{text('未配置模型', 'No model configured')}</span>
          </StatusBarSegment>
        )}
      </div>
    </div>
  )
}


/** 状态栏分段（可点击） */
function StatusBarSegment({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode
  title?: string
  onClick?: () => void
}) {
  return (
    <div
      className="writer-statusbar-segment flex items-center gap-1 px-2 h-full cursor-default transition-colors"
      title={title}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      {children}
    </div>
  )
}

/** 状态栏分隔符 */
function StatusBarDivider() {
  return (
    <span style={{ opacity: 0.25, fontSize: "0.75rem", userSelect: 'none' }}>|</span>
  )
}
