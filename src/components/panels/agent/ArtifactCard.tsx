/**
 * ArtifactCard — 产物卡片
 *
 * 当 Agent 创建/修改文件或触发工作流时，
 * 显示可点击的产物卡片，用户可直接跳转到对应资源。
 */
import { FileText, FolderOpen, Play, ExternalLink } from 'lucide-react'
import type { ToolArtifact } from '../../../services/agent/tool-registry'
import { useLocaleStore } from '../../../stores/locale-store'
import { openArtifactInEditor } from './artifact-open'

interface Props {
  artifact: ToolArtifact
}

/** 根据产物类型选择图标 */
function ArtifactIcon({ type }: { type: ToolArtifact['type'] }) {
  switch (type) {
    case 'file_created':
      return <FileText size={13} />
    case 'file_modified':
      return <FolderOpen size={13} />
    case 'workflow_started':
      return <Play size={13} />
    case 'tab_opened':
      return <ExternalLink size={13} />
    default:
      return <FileText size={13} />
  }
}

/** 产物类型标签 */
function typeLabel(
  type: ToolArtifact['type'],
  text: ReturnType<typeof useLocaleStore.getState>['text'],
): string {
  switch (type) {
    case 'file_created': return text('新建文件', 'New file')
    case 'file_modified': return text('已修改', 'Modified')
    case 'workflow_started': return text('工作流', 'Workflow')
    case 'tab_opened': return text('已打开', 'Opened')
    default: return ''
  }
}

export default function ArtifactCard({ artifact }: Props) {
  const { type, name } = artifact
  const text = useLocaleStore(s => s.text)

  const handleClick = () => { void openArtifactInEditor(artifact) }

  return (
    <div className="artifact-card" onClick={handleClick}>
      <div className="artifact-icon">
        <ArtifactIcon type={type} />
      </div>
      <span className="artifact-name">{name}</span>
      <span className="artifact-type">{typeLabel(type, text)}</span>
    </div>
  )
}
