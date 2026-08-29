import { createElement, type ComponentType, type CSSProperties, type ReactNode } from 'react'
import {
  Target, Users, Globe, Map, BookOpen, FolderTree, LayoutList,
  FilePen, PenTool, BrainCircuit, Sparkles, FolderOpen, Zap,
  FileText, MessageCircle, RefreshCw, GitCompare, GitBranch,
} from 'lucide-react'

type SidebarIcon = ComponentType<{ size?: number; className?: string; style?: CSSProperties }>

const ICON_MAP: Record<string, SidebarIcon> = {
  target: Target,
  users: Users,
  globe: Globe,
  map: Map,
  'book-open': BookOpen,
  'folder-tree': FolderTree,
  'layout-list': LayoutList,
  'file-pen': FilePen,
  'pen-tool': PenTool,
  'brain-circuit': BrainCircuit,
  sparkles: Sparkles,
  'folder-open': FolderOpen,
  zap: Zap,
  'file-text': FileText,
  'message-circle': MessageCircle,
  'refresh-cw': RefreshCw,
  'git-compare': GitCompare,
  'git-branch': GitBranch,
}

/** 根据 iconName 渲染 Lucide 图标；未找到时返回空占位。 */
export function renderIcon(iconName: string, size = 14, style?: CSSProperties): ReactNode {
  const Icon = ICON_MAP[iconName]
  if (!Icon) {
    return createElement('span', {
      style: { width: size, height: size, display: 'inline-block', flexShrink: 0, ...style },
    })
  }
  return createElement(Icon, { size, style: { flexShrink: 0, ...style } })
}
