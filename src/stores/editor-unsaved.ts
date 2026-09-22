import type { EditorTab } from './editor-store'

const LEDGER_TYPE_BY_KEY: Record<string, EditorTab['type']> = {
  'character-editor-drafts': 'character',
  config: 'config',
  'chapter-card-editor': 'chapter-card',
}
const BACKGROUND_LEDGER_TYPES = new Set(Object.values(LEDGER_TYPE_BY_KEY))

/**
 * 一条未保存内容。
 *
 * 退出确认要「说清楚是哪部作品、哪个地方没保存」，光有数量不够 ——
 * 所以计数与清单由同一个函数产出，两处永远不会漂移。
 */
export interface UnsavedEditorItem {
  /** 去重键：`tab:<id>` / `<type>:<projectKey>` / `ledger:<key>` */
  key: string
  /** 所属编辑器类型；损坏账本没有 */
  type?: EditorTab['type']
  /** 可见 Tab 的 id（能直接激活）；后台草稿账本没有 */
  tabId?: string
  /** 可见 Tab 的名字（章节名 / 文件名） */
  name?: string
  /** 内容归属的作品路径 */
  projectKey?: string
  /** 损坏账本的键 —— 这类内容无法归属到任何作品 */
  unreadableLedgerKey?: string
}

/**
 * 列出真正独立的未保存编辑项。可见 Tab 与其后台账本采用同一个键去重，
 * 因此更新门禁既不会漏掉暂时不可见的跨项目草稿，也不会重复计数。
 */
export function listUnsavedEditorItems(
  tabs: readonly EditorTab[],
  draftLedgers: Readonly<Record<string, string>>,
): UnsavedEditorItem[] {
  const items = new Map<string, UnsavedEditorItem>()
  for (const tab of tabs) {
    if (!tab.dirty) continue
    const backgroundLedgerScoped = Boolean(tab.projectKey && BACKGROUND_LEDGER_TYPES.has(tab.type))
    const key = backgroundLedgerScoped ? `${tab.type}:${tab.projectKey}` : `tab:${tab.id}`
    if (items.has(key)) continue
    items.set(key, {
      key,
      type: tab.type,
      tabId: tab.id,
      ...(tab.name ? { name: tab.name } : {}),
      ...(tab.projectKey ? { projectKey: tab.projectKey } : {}),
    })
  }

  for (const [ledgerKey, content] of Object.entries(draftLedgers)) {
    const type = LEDGER_TYPE_BY_KEY[ledgerKey]
    if (!type || !content) continue
    try {
      const parsed = JSON.parse(content) as { projects?: Array<{ projectKey?: unknown }> }
      if (!Array.isArray(parsed.projects)) continue
      for (const project of parsed.projects) {
        if (typeof project.projectKey !== 'string') continue
        const key = `${type}:${project.projectKey}`
        if (items.has(key)) continue
        items.set(key, { key, type, projectKey: project.projectKey })
      }
    } catch {
      // 损坏账本不能被当作可安全更新；保留一个阻断项。
      const key = `ledger:${ledgerKey}`
      if (items.has(key)) continue
      items.set(key, { key, unreadableLedgerKey: ledgerKey })
    }
  }

  return [...items.values()]
}

/** 统计真正独立的未保存编辑项数量。 */
export function countUnsavedEditorItems(
  tabs: readonly EditorTab[],
  draftLedgers: Readonly<Record<string, string>>,
): number {
  return listUnsavedEditorItems(tabs, draftLedgers).length
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
