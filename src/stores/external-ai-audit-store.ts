import { create } from 'zustand'

import {
  DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES,
  EXTERNAL_AI_AUDIT_FULL_SELECTION,
  createExternalAiAuditEntryId,
  isExternalAiAuditDelivery,
  normalizeExternalAiAuditEntries,
  normalizeExternalAiAuditName,
  normalizeExternalAiAuditMaterialSelection,
  normalizeExternalAiUrl,
  type ExternalAiAuditDelivery,
  type ExternalAiAuditEntry,
  type ExternalAiAuditMaterialSection,
  type ExternalAiAuditMaterialSelection,
} from '../shared/external-ai-audit'

/**
 * 「外部 AI 审计」的入口收藏夹。
 *
 * 存在浏览器本地存储里，而不是项目数据库：这是**作者的软件偏好**，
 * 不该跟着某本书走 —— 换一本小说打开，收藏的 DeepSeek / 豆包 还在原位。
 * 与 ui-version-store 同样的降级策略：读不到、读坏了，一律退回出厂默认，
 * 绝不让一块 UI 因为存档损坏而空掉或白屏。
 */
export const EXTERNAL_AI_AUDIT_STORAGE_KEY = 'ai-novel-writer-external-ai-audit'

/** 材料勾选与投递方式另存一处：与入口收藏夹分开，互不牵连。 */
export const EXTERNAL_AI_AUDIT_PREFERENCES_KEY = 'ai-novel-writer-external-ai-audit-preferences'

/** 新建入口的结果：失败时把原因交给界面去提示，store 不直接弹 toast。 */
export type AddExternalAiAuditEntryResult =
  | { success: true; entry: ExternalAiAuditEntry }
  | { success: false; reason: 'name' | 'url' | 'duplicate' }

export interface ExternalAiAuditState {
  entries: ExternalAiAuditEntry[]
  /** 哪些材料块参与本次审计（跨项目记住，与入口收藏夹同一份偏好）。 */
  materialSelection: ExternalAiAuditMaterialSelection
  /** 材料怎么交出去：一整段文本，还是逐块 .md 文件。 */
  delivery: ExternalAiAuditDelivery
  addEntry: (name: string, url: string) => AddExternalAiAuditEntryResult
  removeEntry: (id: string) => void
  /** 删除过内置入口之后，一键把缺失的内置项补回原位。 */
  restoreDefaults: () => void
  setMaterialSection: (section: ExternalAiAuditMaterialSection, enabled: boolean) => void
  setMaterialSelection: (selection: ExternalAiAuditMaterialSelection) => void
  setDelivery: (delivery: ExternalAiAuditDelivery) => void
}

export interface ExternalAiAuditPreferences {
  materialSelection: ExternalAiAuditMaterialSelection
  delivery: ExternalAiAuditDelivery
}

/** 读取本地保存的材料偏好。读不到、读坏了都退回「全带 + 文本投递」。 */
export function readStoredExternalAiAuditPreferences(
  storage?: Pick<Storage, 'getItem'>,
): ExternalAiAuditPreferences {
  const fallback: ExternalAiAuditPreferences = {
    materialSelection: { ...EXTERNAL_AI_AUDIT_FULL_SELECTION },
    delivery: 'inline',
  }
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
    if (!store) return fallback
    const raw = store.getItem(EXTERNAL_AI_AUDIT_PREFERENCES_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as { materialSelection?: unknown; delivery?: unknown }
    return {
      materialSelection: normalizeExternalAiAuditMaterialSelection(parsed?.materialSelection),
      delivery: isExternalAiAuditDelivery(parsed?.delivery) ? parsed.delivery : 'inline',
    }
  } catch {
    return fallback
  }
}

function persistExternalAiAuditPreferences(preferences: ExternalAiAuditPreferences): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(EXTERNAL_AI_AUDIT_PREFERENCES_KEY, JSON.stringify(preferences))
  } catch {
    // 无法持久化时仍允许本次会话内使用
  }
}

/** 读取本地保存的入口列表。任何异常都退回出厂默认。 */
export function readStoredExternalAiAuditEntries(
  storage?: Pick<Storage, 'getItem'>,
): ExternalAiAuditEntry[] {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage)
    if (!store) return [...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES]
    const raw = store.getItem(EXTERNAL_AI_AUDIT_STORAGE_KEY)
    if (!raw) return [...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES]
    return normalizeExternalAiAuditEntries(JSON.parse(raw))
  } catch {
    // 存档损坏（手改过、旧版本遗留）时按默认值处理，不阻断界面
    return [...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES]
  }
}

function persistExternalAiAuditEntries(entries: ExternalAiAuditEntry[]): void {
  try {
    // 先判存在再写：直接 localStorage?.setItem 在未声明它的环境（node 测试）里
    // 会抛 ReferenceError，只能靠 catch 兜住，语义上没有这里直白。
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(EXTERNAL_AI_AUDIT_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // 无法持久化时仍允许本次会话内使用
  }
}

/**
 * 把缺失的内置入口补回默认顺序。
 *
 * 作者已经改过名字 / 地址的内置项保持原样（命中就用他那一份），
 * 只有「被他删掉的那些」才复活 —— 否则「恢复默认」会顺手抹掉他自定义过的内容。
 * 补回后内置项一律按出厂顺序排列，自定义项跟在后面，
 * 这样第一页永远是那四个默认入口。
 */
export function mergeExternalAiAuditDefaults(
  entries: readonly ExternalAiAuditEntry[],
): ExternalAiAuditEntry[] {
  const builtinById = new Map(
    entries.filter(entry => entry.builtin).map(entry => [entry.id, entry]),
  )
  const missing = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES
    .filter(entry => !builtinById.has(entry.id))
  if (missing.length === 0) return [...entries]

  const restoredBuiltins = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES
    .map(entry => builtinById.get(entry.id) ?? entry)
  const customs = entries.filter(entry => !entry.builtin)
  return [...restoredBuiltins, ...customs]
}

export function createExternalAiAuditStore(
  initial: ExternalAiAuditEntry[] = readStoredExternalAiAuditEntries(),
  initialPreferences: ExternalAiAuditPreferences = readStoredExternalAiAuditPreferences(),
) {
  return create<ExternalAiAuditState>()((set, get) => ({
    entries: initial,
    materialSelection: initialPreferences.materialSelection,
    delivery: initialPreferences.delivery,

    addEntry: (name, url) => {
      const cleanName = normalizeExternalAiAuditName(name)
      if (!cleanName) return { success: false, reason: 'name' }

      const cleanUrl = normalizeExternalAiUrl(url)
      if (!cleanUrl) return { success: false, reason: 'url' }

      const entries = get().entries
      if (entries.some(entry => entry.url === cleanUrl)) {
        return { success: false, reason: 'duplicate' }
      }

      const entry: ExternalAiAuditEntry = {
        id: createExternalAiAuditEntryId(),
        name: cleanName,
        url: cleanUrl,
        builtin: false,
      }
      const next = [...entries, entry]
      persistExternalAiAuditEntries(next)
      set({ entries: next })
      return { success: true, entry }
    },

    removeEntry: (id) => {
      const next = get().entries.filter(entry => entry.id !== id)
      if (next.length === get().entries.length) return
      persistExternalAiAuditEntries(next)
      set({ entries: next })
    },

    restoreDefaults: () => {
      const next = mergeExternalAiAuditDefaults(get().entries)
      persistExternalAiAuditEntries(next)
      set({ entries: next })
    },

    setMaterialSection: (section, enabled) => {
      // 必带项（审稿要求）不接受关闭：去掉它就不是审稿了
      const next = normalizeExternalAiAuditMaterialSelection({
        ...get().materialSelection,
        [section]: enabled,
      })
      persistExternalAiAuditPreferences({ materialSelection: next, delivery: get().delivery })
      set({ materialSelection: next })
    },

    setMaterialSelection: (selection) => {
      const next = normalizeExternalAiAuditMaterialSelection(selection)
      persistExternalAiAuditPreferences({ materialSelection: next, delivery: get().delivery })
      set({ materialSelection: next })
    },

    setDelivery: (delivery) => {
      persistExternalAiAuditPreferences({ materialSelection: get().materialSelection, delivery })
      set({ delivery })
    },
  }))
}

export const useExternalAiAuditStore = createExternalAiAuditStore()
