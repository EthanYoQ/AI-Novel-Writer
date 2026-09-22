import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES, EXTERNAL_AI_AUDIT_DRAFT_ONLY_SELECTION, EXTERNAL_AI_AUDIT_FULL_SELECTION } from '../../shared/external-ai-audit'
import {
  EXTERNAL_AI_AUDIT_PREFERENCES_KEY,
  EXTERNAL_AI_AUDIT_STORAGE_KEY,
  createExternalAiAuditStore,
  mergeExternalAiAuditDefaults,
  readStoredExternalAiAuditEntries,
  readStoredExternalAiAuditPreferences,
} from '../external-ai-audit-store'

describe('external AI audit store', () => {
  let storage: Map<string, string>

  beforeEach(() => {
    storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts from the four built-in entries', () => {
    const store = createExternalAiAuditStore()
    expect(store.getState().entries).toEqual([...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES])
  })

  it('adds a custom entry and persists the whole list', () => {
    const store = createExternalAiAuditStore()
    const builtinCount = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.length
    const result = store.getState().addEntry('智谱清言', 'chatglm.cn')

    expect(result.success).toBe(true)
    const entries = store.getState().entries
    expect(entries).toHaveLength(builtinCount + 1)
    // 自建入口追加在内置的两页之后，不会顶掉默认布局
    expect(entries[builtinCount]).toMatchObject({ name: '智谱清言', url: 'https://chatglm.cn/', builtin: false })

    const persisted = JSON.parse(storage.get(EXTERNAL_AI_AUDIT_STORAGE_KEY) ?? '[]')
    expect(persisted).toHaveLength(builtinCount + 1)
  })

  it('refuses an entry without a name', () => {
    const store = createExternalAiAuditStore()
    expect(store.getState().addEntry('   ', 'https://chatglm.cn/')).toEqual({ success: false, reason: 'name' })
    expect(store.getState().entries).toHaveLength(DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.length)
  })

  it('refuses a link that is not a browsable http(s) address', () => {
    const store = createExternalAiAuditStore()
    expect(store.getState().addEntry('坏东西', 'javascript:alert(1)')).toEqual({ success: false, reason: 'url' })
    expect(store.getState().entries).toHaveLength(DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.length)
  })

  it('refuses an address that is already saved', () => {
    const store = createExternalAiAuditStore()
    expect(store.getState().addEntry('又一个 DeepSeek', 'https://chat.deepseek.com/'))
      .toEqual({ success: false, reason: 'duplicate' })
  })

  it('removes an entry and persists the removal', () => {
    const store = createExternalAiAuditStore()
    const target = store.getState().entries[0]!

    store.getState().removeEntry(target.id)

    expect(store.getState().entries.map(entry => entry.id)).not.toContain(target.id)
    const persisted = JSON.parse(storage.get(EXTERNAL_AI_AUDIT_STORAGE_KEY) ?? '[]')
    expect(persisted.map((entry: { id: string }) => entry.id)).not.toContain(target.id)
  })

  it('restores only the missing built-ins and keeps custom entries behind them', () => {
    const store = createExternalAiAuditStore()
    const deepseek = store.getState().entries[0]!
    const added = store.getState().addEntry('智谱清言', 'https://chatglm.cn/')
    expect(added.success).toBe(true)
    store.getState().removeEntry(deepseek.id)

    store.getState().restoreDefaults()

    const entries = store.getState().entries
    const ids = entries.map(entry => entry.id)
    // 内置项按出厂顺序全部回到原位，作者新建的那条留在最后
    expect(ids).toEqual([
      ...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.map(entry => entry.id),
      added.success ? added.entry.id : '',
    ])
    expect(entries[0]?.name).toBe('DeepSeek')
  })

  it('reads back a persisted list through the stored JSON', () => {
    storage.set(EXTERNAL_AI_AUDIT_STORAGE_KEY, JSON.stringify([
      { id: 'custom-1', name: '智谱清言', url: 'https://chatglm.cn/', builtin: false },
    ]))

    expect(readStoredExternalAiAuditEntries().map(entry => entry.name)).toEqual(['智谱清言'])
  })

  it('falls back to the defaults when the stored JSON is corrupted', () => {
    storage.set(EXTERNAL_AI_AUDIT_STORAGE_KEY, '{ this is not json')

    expect(readStoredExternalAiAuditEntries()).toEqual([...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES])
  })

  it('falls back to the defaults when storage itself throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage disabled') },
      setItem: () => { throw new Error('storage disabled') },
    })

    expect(readStoredExternalAiAuditEntries()).toEqual([...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES])
  })
})

describe('external AI audit material preferences', () => {
  let storage: Map<string, string>

  beforeEach(() => {
    storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts with every material included and text delivery', () => {
    const store = createExternalAiAuditStore()

    expect(store.getState().materialSelection).toEqual({ ...EXTERNAL_AI_AUDIT_FULL_SELECTION })
    expect(store.getState().delivery).toBe('inline')
  })

  it('remembers a material choice across sessions', () => {
    const store = createExternalAiAuditStore()
    store.getState().setMaterialSection('blueprints', false)

    const reloaded = createExternalAiAuditStore()
    expect(reloaded.getState().materialSelection.blueprints).toBe(false)
    expect(reloaded.getState().materialSelection.chapterContent).toBe(true)
  })

  it('never lets the review instructions be switched off', () => {
    const store = createExternalAiAuditStore()
    store.getState().setMaterialSection('reviewInstructions', false)

    // 去掉它就不是审稿了，只是一堆材料
    expect(store.getState().materialSelection.reviewInstructions).toBe(true)
  })

  it('applies a preset wholesale', () => {
    const store = createExternalAiAuditStore()
    store.getState().setMaterialSelection(EXTERNAL_AI_AUDIT_DRAFT_ONLY_SELECTION)

    const selection = store.getState().materialSelection
    expect(selection.chapterContent).toBe(true)
    expect(selection.characterStates).toBe(false)
    expect(selection.reviewInstructions).toBe(true)
  })

  it('remembers the delivery mode', () => {
    const store = createExternalAiAuditStore()
    store.getState().setDelivery('files')

    expect(createExternalAiAuditStore().getState().delivery).toBe('files')
  })

  it('falls back to the defaults when the stored preferences are corrupted', () => {
    storage.set(EXTERNAL_AI_AUDIT_PREFERENCES_KEY, '{ not json')

    expect(readStoredExternalAiAuditPreferences()).toEqual({
      materialSelection: { ...EXTERNAL_AI_AUDIT_FULL_SELECTION },
      delivery: 'inline',
    })
  })

  it('ignores an unknown delivery mode', () => {
    storage.set(EXTERNAL_AI_AUDIT_PREFERENCES_KEY, JSON.stringify({
      materialSelection: { chapterContent: false },
      delivery: 'carrier-pigeon',
    }))

    const preferences = readStoredExternalAiAuditPreferences()
    expect(preferences.delivery).toBe('inline')
    expect(preferences.materialSelection.chapterContent).toBe(false)
    // 缺项按出厂默认补齐
    expect(preferences.materialSelection.reviewInstructions).toBe(true)
  })
})

describe('mergeExternalAiAuditDefaults', () => {
  it('returns the same list when nothing is missing', () => {
    const entries = [...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES]
    expect(mergeExternalAiAuditDefaults(entries)).toEqual(entries)
  })

  it('restores a deleted built-in back into factory order', () => {
    const withoutKimi = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.filter(entry => entry.id !== 'builtin-kimi')

    const merged = mergeExternalAiAuditDefaults(withoutKimi)

    expect(merged.map(entry => entry.id))
      .toEqual(DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.map(entry => entry.id))
  })

  it('does not overwrite a built-in address the author customised', () => {
    const customised = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES
      .filter(entry => entry.id !== 'builtin-qwen')
      .map(entry => entry.id === 'builtin-kimi'
        ? { ...entry, url: 'https://kimi.moonshot.cn/' }
        : entry)

    const merged = mergeExternalAiAuditDefaults(customised)

    expect(merged.find(entry => entry.id === 'builtin-kimi')?.url).toBe('https://kimi.moonshot.cn/')
    expect(merged.find(entry => entry.id === 'builtin-qwen')?.url).toBe('https://www.tongyi.com/qianwen/')
  })
})
