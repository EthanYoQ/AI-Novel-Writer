/**
 * 侧栏「正在看的那一行」的统一判定。
 *
 * 先生 2026-09-20 连测两轮，原话：
 *   「我实际测试，V2，只显示 草稿、正文、便利贴的 3级入口标题栏，2级章节，1级的
 *     草稿箱，这些是没反应。V3版本更是什么反应都没有。而且故事架构下面的那些标题
 *     内容、小说配置也是没反应的」
 *
 * 查证的结论：**不是样式被压，是侧栏一大半的行根本没有选中态代码**。
 * 当时全树只有三处挂了 `.active` —— 正文章节条目、草稿条目、便利贴条目；
 * 而下面这些一行都没有：
 *   · 小说配置 / 章节蓝图 / 伏笔（LeafItem）
 *   · 故事架构的组标题行、以及它下面每一个架构文件行
 *   · 草稿箱的组标题行、草稿箱里每一章的分组行
 *   · 便利贴的组标题行
 *
 * 于是把判定收到这一处：**谁在工作区开着，侧栏对应的那一行就点亮。**
 * 判定只看 editor-store 的当前页签，与业务无关 —— 侧栏不需要知道那一页是谁开的。
 */
import { useEditorStore, type EditorTab } from '../../../stores/editor-store'

/** 当前工作区正在看的那一页；没有打开任何页时返回 null。 */
export function useActiveEditorTab(): EditorTab | null {
  return useEditorStore(s => s.tabs.find(tab => tab.id === s.activeTabId) ?? null)
}

/**
 * 当前页的类型（`config` / `chapter-card` / `narrative-thread` / `world-building` /
 * `arch-file` / `chapter` / `sticky-note` …）。
 *
 * 只返回字符串：zustand 按值比较，不会因为每次多返回一个对象而把整棵树重渲染。
 */
export function useActiveTabType(): EditorTab['type'] | null {
  return useActiveEditorTab()?.type ?? null
}

/** 当前页的文件路径 —— 逐条认领用的（正文章节、草稿、架构文件都按它比对）。 */
export function useActiveTabFilePath(): string | undefined {
  return useActiveEditorTab()?.filePath
}

/**
 * 正文栏正在看的是「草稿」还是「定稿正文」。
 *
 * 两者在侧栏分属两个组（草稿箱 / 正文章节），而编辑器里是同一类页签，
 * 只能靠伪协议前缀分辨 —— `vela://draft/N` 与 `vela://manuscript/N`。
 */
export function useActiveManuscriptSurface(): 'draft' | 'manuscript' | null {
  const filePath = useActiveTabFilePath()
  if (!filePath) return null
  if (filePath.startsWith('vela://draft/')) return 'draft'
  if (filePath.startsWith('vela://manuscript/')) return 'manuscript'
  return null
}
