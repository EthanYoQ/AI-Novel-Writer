import type { ChapterBlueprint } from '../../services/workflows/directory-workflow'

export const CHAPTER_CARD_TAB_ID = 'chapter-card-editor'

export interface ChapterCardProjectDraft {
  projectKey: string
  blueprints: ChapterBlueprint[]
  dirtyChapterNumbers: number[]
}

export interface ChapterCardDraftLedger {
  version: 1
  projects: ChapterCardProjectDraft[]
}

export interface BlueprintSnapshot {
  chapterNumber: number
  value: string
}

export interface ChapterCardTabWriter {
  tabs: Array<{ type: string; projectKey?: string }>
  draftLedgers: Record<string, string>
  setDraftLedger(key: string, content: string): void
  setProjectEditorDirty(type: 'chapter-card', projectKey: string, dirty: boolean): void
}

export interface DraftState {
  blueprints: ChapterBlueprint[]
  dirtyChapterNumbers: Set<number>
}

export type EditableChapterBlueprintField = Exclude<keyof ChapterBlueprint, 'chapterNumber'>

export interface RefreshChapterCardDraftOptions {
  projectKey: string
  loadRemote(): Promise<ChapterBlueprint[]>
  readLedger(): ChapterCardDraftLedger
  isProjectCurrent(): boolean
  commit(state: DraftState, restoredDraft: boolean): void
}

export function createEmptyChapterCardDraftLedger(): ChapterCardDraftLedger {
  return { version: 1, projects: [] }
}

/**
 * 章节号是跨草稿、正文、摘要和向量数据的稳定键，本轮普通编辑不可修改。
 * 即使调用方绕过类型约束传入 chapterNumber，运行时也恢复原章节号。
 */
export function updateEditableChapterBlueprintField<K extends EditableChapterBlueprintField>(
  blueprint: ChapterBlueprint,
  key: K,
  value: ChapterBlueprint[K],
): ChapterBlueprint {
  return {
    ...blueprint,
    [key]: value,
    chapterNumber: blueprint.chapterNumber,
  }
}

function isProjectDraft(value: unknown): value is ChapterCardProjectDraft {
  if (!value || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  return typeof input.projectKey === 'string'
    && Array.isArray(input.blueprints)
    && Array.isArray(input.dirtyChapterNumbers)
    && input.dirtyChapterNumbers.every(chapterNumber => Number.isInteger(chapterNumber))
}

export function parseChapterCardDraftLedger(content: string | undefined): ChapterCardDraftLedger {
  if (!content) return createEmptyChapterCardDraftLedger()
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (parsed.version !== 1 || !Array.isArray(parsed.projects) || !parsed.projects.every(isProjectDraft)) {
      return createEmptyChapterCardDraftLedger()
    }
    return {
      version: 1,
      projects: parsed.projects.map(project => ({
        projectKey: project.projectKey,
        blueprints: project.blueprints,
        dirtyChapterNumbers: [...new Set(project.dirtyChapterNumbers)],
      })),
    }
  } catch {
    return createEmptyChapterCardDraftLedger()
  }
}

export function getChapterCardProjectDraft(
  ledger: ChapterCardDraftLedger,
  projectKey: string,
): ChapterCardProjectDraft | undefined {
  return ledger.projects.find(project => project.projectKey === projectKey)
}

/**
 * 以 dirtyChapterNumbers 作为本地修改集合合并最新数据库蓝图。
 * 脏章节采用本地值；未修改章节及远端新增章节采用 remote；
 * 尚未进入 remote 的本地新增脏章节继续保留。
 */
export function mergeChapterCardDraftWithRemote(
  draft: ChapterCardProjectDraft,
  remoteBlueprints: readonly ChapterBlueprint[],
): DraftState {
  const dirtyChapterNumbers = new Set(draft.dirtyChapterNumbers)
  const localByChapter = new Map(
    draft.blueprints.map(blueprint => [blueprint.chapterNumber, blueprint]),
  )
  const merged: ChapterBlueprint[] = []
  const included = new Set<number>()

  for (const remoteBlueprint of remoteBlueprints) {
    if (dirtyChapterNumbers.has(remoteBlueprint.chapterNumber)) {
      const localBlueprint = localByChapter.get(remoteBlueprint.chapterNumber)
      if (localBlueprint) {
        merged.push(localBlueprint)
        included.add(localBlueprint.chapterNumber)
      }
      continue
    }
    merged.push(remoteBlueprint)
    included.add(remoteBlueprint.chapterNumber)
  }

  for (const localBlueprint of draft.blueprints) {
    if (
      dirtyChapterNumbers.has(localBlueprint.chapterNumber)
      && !included.has(localBlueprint.chapterNumber)
    ) {
      merged.push(localBlueprint)
      included.add(localBlueprint.chapterNumber)
    }
  }

  return {
    blueprints: merged,
    dirtyChapterNumbers,
  }
}

/**
 * 等待远端期间允许用户继续编辑；远端返回后才读取最新账本，并在同一同步执行段内
 * 完成项目校验、三方选择和提交，避免旧 projectDraft 覆盖刚发生的本地编辑。
 */
export async function refreshChapterCardDraftFromRemote({
  projectKey,
  loadRemote,
  readLedger,
  isProjectCurrent,
  commit,
}: RefreshChapterCardDraftOptions): Promise<DraftState | undefined> {
  const remoteBlueprints = await loadRemote()
  if (!isProjectCurrent()) return undefined

  const projectDraft = getChapterCardProjectDraft(readLedger(), projectKey)
  const restored = projectDraft
    ? mergeChapterCardDraftWithRemote(projectDraft, remoteBlueprints)
    : { blueprints: remoteBlueprints, dirtyChapterNumbers: new Set<number>() }
  commit(restored, Boolean(projectDraft))
  return restored
}

export function updateChapterCardProjectDraft(
  ledger: ChapterCardDraftLedger,
  projectKey: string,
  blueprints: ChapterBlueprint[],
  dirtyChapterNumbers: ReadonlySet<number>,
): ChapterCardDraftLedger {
  const otherProjects = ledger.projects.filter(project => project.projectKey !== projectKey)
  if (dirtyChapterNumbers.size === 0) {
    return { version: 1, projects: otherProjects }
  }
  return {
    version: 1,
    projects: [
      ...otherProjects,
      {
        projectKey,
        blueprints,
        dirtyChapterNumbers: [...dirtyChapterNumbers].sort((left, right) => left - right),
      },
    ],
  }
}

export function discardChapterCardProjectDraft(
  ledger: ChapterCardDraftLedger,
  projectKey: string,
): ChapterCardDraftLedger {
  return {
    version: 1,
    projects: ledger.projects.filter(project => project.projectKey !== projectKey),
  }
}

export function persistChapterCardDraftLedger(
  writer: ChapterCardTabWriter,
  ledger: ChapterCardDraftLedger,
): void {
  const content = JSON.stringify(ledger)
  writer.setDraftLedger(CHAPTER_CARD_TAB_ID, content)
  const dirtyProjects = new Set(ledger.projects.map(project => project.projectKey))
  for (const tab of writer.tabs) {
    if (tab.type === 'chapter-card' && tab.projectKey) {
      writer.setProjectEditorDirty(
        'chapter-card',
        tab.projectKey,
        dirtyProjects.has(tab.projectKey),
      )
    }
  }
}

function serializedBlueprint(blueprint: ChapterBlueprint): string {
  return JSON.stringify(blueprint)
}

export function captureBlueprintSnapshots(
  blueprints: readonly ChapterBlueprint[],
  chapterNumbers?: ReadonlySet<number>,
): BlueprintSnapshot[] {
  return blueprints
    .filter(blueprint => !chapterNumbers || chapterNumbers.has(blueprint.chapterNumber))
    .map(blueprint => ({
      chapterNumber: blueprint.chapterNumber,
      value: serializedBlueprint(blueprint),
    }))
}

export function reconcileSavedBlueprintSnapshots(
  currentBlueprints: readonly ChapterBlueprint[],
  dirtyChapterNumbers: ReadonlySet<number>,
  savedSnapshots: readonly BlueprintSnapshot[],
): Set<number> {
  const currentByChapter = new Map(
    currentBlueprints.map(blueprint => [blueprint.chapterNumber, serializedBlueprint(blueprint)]),
  )
  const nextDirty = new Set(dirtyChapterNumbers)
  for (const snapshot of savedSnapshots) {
    if (currentByChapter.get(snapshot.chapterNumber) === snapshot.value) {
      nextDirty.delete(snapshot.chapterNumber)
    }
  }
  return nextDirty
}

export function reconcileDeletedBlueprintSnapshots(
  currentBlueprints: readonly ChapterBlueprint[],
  dirtyChapterNumbers: ReadonlySet<number>,
  deletedSnapshots: readonly BlueprintSnapshot[],
): DraftState {
  const snapshots = new Map(deletedSnapshots.map(snapshot => [snapshot.chapterNumber, snapshot.value]))
  const nextDirty = new Set(dirtyChapterNumbers)
  const blueprints = currentBlueprints.filter(blueprint => {
    const deletedValue = snapshots.get(blueprint.chapterNumber)
    if (deletedValue === undefined) return true
    if (serializedBlueprint(blueprint) === deletedValue) {
      nextDirty.delete(blueprint.chapterNumber)
      return false
    }
    nextDirty.add(blueprint.chapterNumber)
    return true
  })
  return { blueprints, dirtyChapterNumbers: nextDirty }
}

export function reconcileClearedBlueprintSnapshots(
  currentBlueprints: readonly ChapterBlueprint[],
  clearedSnapshots: readonly BlueprintSnapshot[],
): DraftState {
  const snapshots = new Map(clearedSnapshots.map(snapshot => [snapshot.chapterNumber, snapshot.value]))
  const blueprints = currentBlueprints.filter(blueprint => (
    snapshots.get(blueprint.chapterNumber) !== serializedBlueprint(blueprint)
  ))
  return {
    blueprints,
    dirtyChapterNumbers: new Set(blueprints.map(blueprint => blueprint.chapterNumber)),
  }
}
