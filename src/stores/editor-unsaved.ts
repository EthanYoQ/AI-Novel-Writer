import type { EditorTab } from './editor-store'

const LEDGER_TYPE_BY_KEY: Record<string, EditorTab['type']> = {
  'character-editor-drafts': 'character',
  config: 'config',
  'chapter-card-editor': 'chapter-card',
}
const BACKGROUND_LEDGER_TYPES = new Set(Object.values(LEDGER_TYPE_BY_KEY))

/**
 * 统计真正独立的未保存编辑项。可见 Tab 与其后台账本采用同一个键去重，
 * 因此更新门禁既不会漏掉暂时不可见的跨项目草稿，也不会重复计数。
 */
export function countUnsavedEditorItems(
  tabs: readonly EditorTab[],
  draftLedgers: Readonly<Record<string, string>>,
): number {
  const dirtyItems = new Set<string>()
  for (const tab of tabs) {
    if (!tab.dirty) continue
    dirtyItems.add(
      tab.projectKey && BACKGROUND_LEDGER_TYPES.has(tab.type)
        ? `${tab.type}:${tab.projectKey}`
        : `tab:${tab.id}`,
    )
  }

  for (const [ledgerKey, content] of Object.entries(draftLedgers)) {
    const type = LEDGER_TYPE_BY_KEY[ledgerKey]
    if (!type || !content) continue
    try {
      const parsed = JSON.parse(content) as { projects?: Array<{ projectKey?: unknown }> }
      if (!Array.isArray(parsed.projects)) continue
      for (const project of parsed.projects) {
        if (typeof project.projectKey === 'string') {
          dirtyItems.add(`${type}:${project.projectKey}`)
        }
      }
    } catch {
      // 损坏账本不能被当作可安全更新；保留一个阻断项。
      dirtyItems.add(`ledger:${ledgerKey}`)
    }
  }
  return dirtyItems.size
}

/** 只统计关闭指定项目时会被清理的可见 Tab 与后台草稿。 */
export function countUnsavedEditorItemsForProject(
  tabs: readonly EditorTab[],
  draftLedgers: Readonly<Record<string, string>>,
  projectKey: string,
): number {
  const dirtyItems = new Set<string>()
  for (const tab of tabs) {
    if (!tab.dirty || tab.projectKey !== projectKey) continue
    dirtyItems.add(
      BACKGROUND_LEDGER_TYPES.has(tab.type)
        ? `${tab.type}:${projectKey}`
        : `tab:${tab.id}`,
    )
  }

  for (const [ledgerKey, content] of Object.entries(draftLedgers)) {
    const type = LEDGER_TYPE_BY_KEY[ledgerKey]
    if (!type || !content) continue
    try {
      const parsed = JSON.parse(content) as { projects?: Array<{ projectKey?: unknown }> }
      if (
        Array.isArray(parsed.projects)
        && parsed.projects.some(project => project.projectKey === projectKey)
      ) {
        dirtyItems.add(`${type}:${projectKey}`)
      }
    } catch {
      // clearProjectTabs preserves malformed ledgers, so closing this project
      // cannot claim that an unattributable ledger will be discarded.
    }
  }
  return dirtyItems.size
}
