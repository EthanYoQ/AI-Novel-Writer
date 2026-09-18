/**
 * 标签图标（v2 标签栏）。
 *
 * 与 EditorArea 里 v1 的 TabIcon 是同一套语义，只是补齐了知识库这一类；
 * v1 的内联实现保持原样不动，两套图标映射各自独立，互不牵连。
 */
import {
  ArrowLeftRight,
  BookOpen,
  ClipboardCheck,
  Compass,
  FileText,
  Globe,
  History,
  Library,
  ListTree,
  Network,
  Settings,
  Shield,
  Users,
} from 'lucide-react'
import type { EditorTab } from '../../../stores/editor-store'

export function EditorTabIcon({ type, size = 12 }: { type: EditorTab['type']; size?: number }) {
  const props = { size, strokeWidth: 1.7, 'aria-hidden': true } as const
  switch (type) {
    case 'config':
      return <Settings {...props} />
    case 'character':
      return <Users {...props} />
    case 'relationship-graph':
      return <Network {...props} />
    case 'diff':
      return <ArrowLeftRight {...props} />
    case 'chapter-card':
      return <ListTree {...props} />
    case 'world-building':
      return <Globe {...props} />
    // 世界观设定（书脊「世界」按钮）与故事架构是两页，图标分开，免得两个标签长得一样。
    case 'world-setting':
      return <Compass {...props} />
    case 'version-history':
      return <History {...props} />
    case 'review-report':
      return <ClipboardCheck {...props} />
    case 'knowledge':
      return <Library {...props} />
    case 'arch-file':
      return <Shield {...props} />
    case 'outline':
      return <ListTree {...props} />
    default:
      return type === 'chapter' ? <BookOpen {...props} /> : <FileText {...props} />
  }
}
