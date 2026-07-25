import type { EditorTab } from './editor-store'

export interface ProjectEditorDraft<T> {
  projectKey: string
  baseValue: T
  draftValue: T
  metadata?: unknown
}

export interface ProjectEditorDraftLedger<T> {
  version: 1
  projects: Array<ProjectEditorDraft<T>>
}

export interface DraftTabDescriptor {
  id: string
  name: string
  type: Extract<EditorTab['type'], 'character' | 'config'>
}

export interface DraftTabWriter {
  tabs: EditorTab[]
  draftLedgers: Record<string, string>
  setDraftLedger(key: string, content: string): void
  setProjectEditorDirty(
    type: Extract<EditorTab['type'], 'character' | 'config' | 'chapter-card'>,
    projectKey: string,
    dirty: boolean,
  ): void
}

export const CHARACTER_DRAFT_TAB: DraftTabDescriptor = {
  id: 'character-editor-drafts',
  name: '角色卡',
  type: 'character',
}

export const CONFIG_DRAFT_TAB: DraftTabDescriptor = {
  id: 'config',
  name: '小说配置',
  type: 'config',
}

export function createEmptyProjectEditorDraftLedger<T>(): ProjectEditorDraftLedger<T> {
  return { version: 1, projects: [] }
}

function valuesMatch(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function parseProjectEditorDraftLedger<T>(
  content: string | undefined,
): ProjectEditorDraftLedger<T> {
  if (!content) return createEmptyProjectEditorDraftLedger()
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (parsed.version !== 1 || !Array.isArray(parsed.projects)) {
      return createEmptyProjectEditorDraftLedger()
    }
    const projects = parsed.projects.filter((project): project is ProjectEditorDraft<T> => (
      Boolean(project)
      && typeof project === 'object'
      && typeof (project as Record<string, unknown>).projectKey === 'string'
      && Object.hasOwn(project as object, 'baseValue')
      && Object.hasOwn(project as object, 'draftValue')
    ))
    return { version: 1, projects }
  } catch {
    return createEmptyProjectEditorDraftLedger()
  }
}

export function getProjectEditorDraft<T>(
  ledger: ProjectEditorDraftLedger<T>,
  projectKey: string,
): ProjectEditorDraft<T> | undefined {
  return ledger.projects.find(project => project.projectKey === projectKey)
}

function ownKeys(value: object): string[] {
  return Object.keys(value)
}

/**
 * 以 base 为共同祖先执行字段级三方合并。
 * 本地实际改过的字段保留 draft；其余字段采用最新 remote。
 */
export function mergeObjectDraftWithRemote<T extends object>(
  baseValue: T,
  draftValue: T,
  remoteValue: T,
): T {
  const merged = { ...remoteValue } as T
  const mergedRecord = merged as Record<string, unknown>
  const keys = new Set([...ownKeys(baseValue), ...ownKeys(draftValue)])
  for (const key of keys) {
    const baseRecord = baseValue as Record<string, unknown>
    const draftRecord = draftValue as Record<string, unknown>
    if (!valuesMatch(baseRecord[key], draftRecord[key])) {
      mergedRecord[key] = draftRecord[key]
    }
  }
  return merged
}

/**
 * 角色名是现有角色卡的稳定记录键。对每条记录执行三方合并：
 * 本地改/增/删优先，未改记录以及远端新增记录采用最新 remote。
 */
export function mergeNamedRecordDraftWithRemote<T extends { name: string }>(
  baseValue: readonly T[],
  draftValue: readonly T[],
  remoteValue: readonly T[],
): T[] {
  const baseByName = new Map(baseValue.map(record => [record.name, record]))
  const draftByName = new Map(draftValue.map(record => [record.name, record]))
  const locallyDeleted = new Set(
    baseValue
      .filter(record => !draftByName.has(record.name))
      .map(record => record.name),
  )
  const locallyChanged = new Set(
    draftValue
      .filter(record => {
        const baseRecord = baseByName.get(record.name)
        return !baseRecord || !valuesMatch(baseRecord, record)
      })
      .map(record => record.name),
  )

  const merged: T[] = []
  const included = new Set<string>()
  for (const remoteRecord of remoteValue) {
    if (locallyDeleted.has(remoteRecord.name)) continue
    const record = locallyChanged.has(remoteRecord.name)
      ? draftByName.get(remoteRecord.name)
      : remoteRecord
    if (record) {
      merged.push(record)
      included.add(record.name)
    }
  }
  for (const draftRecord of draftValue) {
    if (locallyChanged.has(draftRecord.name) && !included.has(draftRecord.name)) {
      merged.push(draftRecord)
      included.add(draftRecord.name)
    }
  }
  return merged
}

export function setProjectEditorDraft<T>(
  ledger: ProjectEditorDraftLedger<T>,
  projectKey: string,
  baseValue: T,
  draftValue: T,
): ProjectEditorDraftLedger<T> {
  const otherProjects = ledger.projects.filter(project => project.projectKey !== projectKey)
  if (valuesMatch(baseValue, draftValue)) return { version: 1, projects: otherProjects }
  const metadata = getProjectEditorDraft(ledger, projectKey)?.metadata
  return {
    version: 1,
    projects: [...otherProjects, {
      projectKey,
      baseValue,
      draftValue,
      ...(metadata === undefined ? {} : { metadata }),
    }],
  }
}

export function setProjectEditorDraftMetadata<T>(
  ledger: ProjectEditorDraftLedger<T>,
  projectKey: string,
  metadata: unknown,
): ProjectEditorDraftLedger<T> {
  return {
    ...ledger,
    projects: ledger.projects.map(project => (
      project.projectKey === projectKey ? { ...project, metadata } : project
    )),
  }
}

export function recordProjectEditorEdit<T>(
  ledger: ProjectEditorDraftLedger<T>,
  projectKey: string,
  beforeValue: T,
  draftValue: T,
): ProjectEditorDraftLedger<T> {
  const existing = getProjectEditorDraft(ledger, projectKey)
  return setProjectEditorDraft(
    ledger,
    projectKey,
    existing?.baseValue ?? beforeValue,
    draftValue,
  )
}

export function settleProjectEditorSave<T>(
  ledger: ProjectEditorDraftLedger<T>,
  projectKey: string,
  savedValue: T,
  currentValue: T,
): ProjectEditorDraftLedger<T> {
  return setProjectEditorDraft(ledger, projectKey, savedValue, currentValue)
}

export function discardProjectEditorDraft<T>(
  ledger: ProjectEditorDraftLedger<T>,
  projectKey: string,
): ProjectEditorDraftLedger<T> {
  return {
    version: 1,
    projects: ledger.projects.filter(project => project.projectKey !== projectKey),
  }
}

export function rebaseProjectEditorDraft<T>(
  ledger: ProjectEditorDraftLedger<T>,
  projectKey: string,
  remoteValue: T,
  merge: (baseValue: T, draftValue: T, remoteValue: T) => T,
): { ledger: ProjectEditorDraftLedger<T>; value: T } {
  const existing = getProjectEditorDraft(ledger, projectKey)
  if (!existing) return { ledger, value: remoteValue }

  const value = merge(existing.baseValue, existing.draftValue, remoteValue)
  return {
    ledger: setProjectEditorDraft(ledger, projectKey, remoteValue, value),
    value,
  }
}

export function persistProjectEditorDraftLedger<T>(
  writer: DraftTabWriter,
  tab: DraftTabDescriptor,
  ledger: ProjectEditorDraftLedger<T>,
): void {
  const content = JSON.stringify(ledger)
  writer.setDraftLedger(tab.id, content)
  const dirtyProjects = new Set(ledger.projects.map(project => project.projectKey))
  for (const visibleTab of writer.tabs) {
    if (
      visibleTab.type === tab.type
      && visibleTab.projectKey
    ) {
      writer.setProjectEditorDirty(
        tab.type,
        visibleTab.projectKey,
        dirtyProjects.has(visibleTab.projectKey),
      )
    }
  }
}
