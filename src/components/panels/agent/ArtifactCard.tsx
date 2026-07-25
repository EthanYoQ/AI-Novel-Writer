/**
 * ArtifactCard — 产物卡片
 *
 * 当 Agent 创建/修改文件或触发工作流时，
 * 显示可点击的产物卡片，用户可直接跳转到对应资源。
 */
import { FileText, FolderOpen, Play, ExternalLink } from 'lucide-react'
import type { ToolArtifact } from '../../../services/agent/tool-registry'
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

/** 产物类型中文标签 */
function typeLabel(type: ToolArtifact['type']): string {
  switch (type) {
    case 'file_created': return '新建文件'
    case 'file_modified': return '已修改'
    case 'workflow_started': return '工作流'
    case 'tab_opened': return '已打开'
    default: return ''
  }
}

export default function ArtifactCard({ artifact }: Props) {
  const { type, name } = artifact

  const handleClick = () => { void openArtifactInEditor(artifact) }

  return (
    <div className="artifact-card" onClick={handleClick}>
      <div className="artifact-icon">
        <ArtifactIcon type={type} />
      </div>
      <span className="artifact-name">{name}</span>
      <span className="artifact-type">{typeLabel(type)}</span>
    </div>
  )
}
