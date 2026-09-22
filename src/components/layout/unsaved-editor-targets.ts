/**
 * 未保存内容的「人话」映射：编辑器类型 → 名称 / 跳转落点。
 *
 * 退出确认原先只会说一句「另一个项目仍有未保存内容」——用户既不知道是哪部作品，
 * 也不知道是哪个编辑器，只能自己一部一部去找。这里把技术类型翻译成界面上真实存在的
 * 页面名，并给出「点一下就能跳过去」的落点 id，退出确认因此可以直接把人送到现场。
 *
 * 非组件模块（不含 JSX），放在 layout 下与 exit-guard 同处一层。
 */
import type { EditorTab } from '../../stores/editor-store'
import type { UnsavedEditorItem } from '../../stores/editor-unsaved'
import { sameProjectPathKey } from '../../shared/project-session-context'

interface BilingualLabel {
  zh: string
  en: string
}

export interface UnsavedEditorTarget {
  /**
   * 打开该编辑器所用的稳定 Tab id。
   *
   * 必须与产品各入口一致（人物档案 'character-editor' / 章节蓝图
   * CHAPTER_CARD_TAB_ID / 小说配置 'config'），否则同一页面会被开出两个标签，
   * 而后台草稿账本是以这些 id 为键的 —— 换 id 会像丢草稿一样吓人。
   */
  tabId: string
  label: BilingualLabel
}

/** 能凭类型重新打开的内置编辑器（其余类型靠已存在的 Tab 激活）。 */
export const UNSAVED_EDITOR_TARGETS: Partial<Record<EditorTab['type'], UnsavedEditorTarget>> = {
  character: {
    tabId: 'character-editor',
    label: { zh: '人物档案', en: 'Character profiles' },
  },
  config: {
    tabId: 'config',
    label: { zh: '小说配置', en: 'Novel configuration' },
  },
  'chapter-card': {
    tabId: 'chapter-card-editor',
    label: { zh: '章节蓝图', en: 'Chapter blueprint' },
  },
  'world-building': {
    tabId: 'world-building-editor',
    label: { zh: '故事架构', en: 'Story architecture' },
  },
  knowledge: {
    tabId: 'knowledge-editor',
    label: { zh: '知识库', en: 'Knowledge base' },
  },
  'world-setting': {
    tabId: 'world-setting-editor',
    label: { zh: '设定集', en: 'World building' },
  },
}

/** 编辑器类型 → 用户在界面上看到的名字（用于「哪个地方没保存」）。 */
const UNSAVED_EDITOR_TYPE_LABELS: Record<EditorTab['type'], BilingualLabel> = {
  chapter: { zh: '章节正文', en: 'Chapter draft' },
  outline: { zh: '大纲', en: 'Outline' },
  character: { zh: '人物档案', en: 'Character profiles' },
  config: { zh: '小说配置', en: 'Novel configuration' },
  diff: { zh: '对比视图', en: 'Diff view' },
  'chapter-card': { zh: '章节蓝图', en: 'Chapter blueprint' },
  'world-building': { zh: '故事架构', en: 'Story architecture' },
  'arch-file': { zh: '架构文件', en: 'Architecture file' },
  'version-history': { zh: '版本历史', en: 'Version history' },
  'review-report': { zh: '审稿报告', en: 'Review report' },
  'narrative-thread': { zh: '剧情树与伏笔', en: 'Plot tree & foreshadowing' },
  knowledge: { zh: '知识库', en: 'Knowledge base' },
  'relationship-graph': { zh: '人物关系图谱', en: 'Relationship map' },
  'world-setting': { zh: '设定集', en: 'World building' },
  'sticky-note': { zh: '便利贴', en: 'Sticky note' },
}

export type LocaleText = (zhCN: string, enUS: string) => string

export interface UnsavedGroupEntry {
  item: UnsavedEditorItem
  /** 这条内容属于哪个编辑器 */
  editorLabel: string
  /** 这条内容自己的名字（章节名 / 文件名）；与编辑器名重合时省略 */
  entryLabel?: string
}

export interface UnsavedGroup {
  /** 归属的作品路径；损坏账本没有 */
  projectKey?: string
  projectName: string
  projectPath?: string
  /** 是否是当前正在编辑的那部作品 */
  isCurrentProject: boolean
  entries: UnsavedGroupEntry[]
}

/** 编辑器类型 → 界面用名（未知类型原样回显，不吞信息）。 */
export function unsavedEditorLabel(type: EditorTab['type'], text: LocaleText): string {
  const label = UNSAVED_EDITOR_TYPE_LABELS[type]
  return label ? text(label.zh, label.en) : type
}

/**
 * 作品路径 → 作品名。
 *
 * 优先用「最近项目」里的正式书名；找不到（例如项目刚被移出列表）时退回目录名，
 * 绝不给用户看一串裸路径当标题。
 */
export function projectDisplayName(
  projectKey: string,
  recentProjects: ReadonlyArray<{ name: string; path: string }>,
): string {
  const hit = recentProjects.find(project => sameProjectPathKey(project.path, projectKey))
  if (hit?.name) return hit.name
  const tail = projectKey.split(/[\\/]+/).filter(Boolean).pop()
  return tail || projectKey
}

/** 把扁平的未保存清单按作品分组，供退出确认直接渲染。 */
export function groupUnsavedEditorItems(
  items: readonly UnsavedEditorItem[],
  options: {
    recentProjects: ReadonlyArray<{ name: string; path: string }>
    currentProjectPath?: string | null
    text: LocaleText
  },
): UnsavedGroup[] {
  const { recentProjects, currentProjectPath, text } = options
  const groups: UnsavedGroup[] = []
  const byProject = new Map<string, UnsavedGroup>()

  for (const item of items) {
    const groupKey = item.projectKey ?? ''
    let group = byProject.get(groupKey)
    if (!group) {
      group = {
        ...(item.projectKey ? { projectKey: item.projectKey, projectPath: item.projectKey } : {}),
        projectName: item.projectKey
          ? projectDisplayName(item.projectKey, recentProjects)
          : text('无法归属的草稿', 'Unattributable draft'),
        isCurrentProject: Boolean(
          item.projectKey
          && currentProjectPath
          && sameProjectPathKey(item.projectKey, currentProjectPath),
        ),
        entries: [],
      }
      byProject.set(groupKey, group)
      groups.push(group)
    }
    const editorLabel = item.type
      ? unsavedEditorLabel(item.type, text)
      : text('无法识别的草稿', 'Unreadable draft')
    group.entries.push({
      item,
      editorLabel,
      ...(item.name && item.name !== editorLabel ? { entryLabel: item.name } : {}),
    })
  }

  return groups
}
