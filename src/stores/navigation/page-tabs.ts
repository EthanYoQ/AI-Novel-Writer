import { useEditorStore } from '../editor-store'
import { useLocaleStore } from '../locale-store'
import { openBuiltinEditor } from '../open-builtin-editor'
import { useProjectStore } from '../project-store'
import type { ResourcePage, WorkStage } from './navigation-intents'

type Text = (zh: string, en: string) => string

/** 阶段与资料页对应的标签。正文与知识库没有固定标签，由各自的页面处理。 */
const PAGE_TABS: Partial<Record<WorkStage | ResourcePage, (text: Text) => void>> = {
  architecture: text => openBuiltinEditor('world-building-editor', text('故事架构', 'Story architecture'), 'world-building'),
  blueprint: text => openBuiltinEditor('chapter-card-editor', text('章节蓝图', 'Chapter blueprint'), 'chapter-card'),
  plot: text => openBuiltinEditor('narrative-thread-editor', text('剧情树与叙事线索', 'Plot tree & narrative threads'), 'narrative-thread', 'plot-tree'),
  history: text => openBuiltinEditor('version-history', text('版本历史', 'Version history'), 'version-history'),
  setup: text => {
    const projectKey = useProjectStore.getState().currentProject?.path
    if (projectKey) useEditorStore.getState().openFile({ id: 'config', name: text('小说配置', 'Novel configuration'), type: 'config', projectKey })
  },
}

export function openPageTab(page: WorkStage | ResourcePage): void {
  PAGE_TABS[page]?.(useLocaleStore.getState().text)
}
