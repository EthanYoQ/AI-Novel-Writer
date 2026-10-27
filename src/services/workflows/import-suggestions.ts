import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { NovelConfig } from '../../shared/ipc-channels'
import type { ProjectCoreData } from '../../../electron/repositories/project-core-repository'
import type { ImportFillField, ImportFillSuggestion } from '../../shared/import-fill-empty'
import { ipc } from '../ipc-client'
import { useProjectStore } from '../../stores/project-store'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'

/** 补空导入在 global、style 两个阶段的收据里记下建议。 */
const SUGGESTION_STAGES = ['global', 'style'] as const

function normalized(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value
}

function suggestionsOf(effectReceipt: unknown): ImportFillSuggestion[] {
  const receipt = effectReceipt as { mode?: string; suggestions?: ImportFillSuggestion[] } | undefined
  return receipt?.mode === 'fill-empty' && Array.isArray(receipt.suggestions) ? receipt.suggestions : []
}

/** 还没采用的建议：当前设定已经等于反推值的（采用过，或作者自己改成了一样的）不再列出。 */
export async function loadPendingImportSuggestions(
  runId: string,
  session: ProjectSessionContext,
  projectPath: string,
): Promise<ImportFillSuggestion[]> {
  const receipts = await Promise.all(SUGGESTION_STAGES.map(stage => ipc.invokeWithProjectSession(
    session, 'db:import-run-effect-receipt-get', runId, stage, 'done', projectPath,
  )))
  const suggestions = receipts.flatMap(receipt => receipt?.state === 'committed' ? suggestionsOf(receipt.effectReceipt) : [])
  if (suggestions.length === 0) return []
  const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', projectPath)
  if (!core) return []
  return suggestions
    .map(item => ({ ...item, current: normalized(core[item.field]) as string | number }))
    .filter(item => item.current !== item.inferred)
}

export function novelConfigFromCore(config: NovelConfig, core: ProjectCoreData): NovelConfig {
  return {
    ...config,
    genre: core.genre,
    subGenre: core.subGenre,
    targetAudience: core.targetAudience,
    totalChapters: core.totalChapters,
    wordsPerChapter: core.wordsPerChapter,
    plotStructure: core.plotStructure as NovelConfig['plotStructure'],
    narrativePOV: core.narrativePov as NovelConfig['narrativePOV'],
    writingStyle: core.writingStyle,
    globalGuidance: core.globalGuidance,
    goldenFinger: core.goldenFinger,
    coreOutline: core.coreOutline,
    worldSetting: core.worldSetting,
    protagonistProfile: core.protagonistProfile,
  }
}

/** 把选中的建议一次写进项目设定。只有采用的那几项算已保存；设定页里其他还没保存的改动保持原样。 */
export async function adoptImportSuggestions(
  items: readonly ImportFillSuggestion[],
  session: ProjectSessionContext,
  projectPath: string,
): Promise<void> {
  const patch = Object.fromEntries(items.map(item => [item.field, item.inferred])) as Partial<Record<ImportFillField, string | number>>
  const write = async (): Promise<Partial<NovelConfig>> => {
    const result = await ipc.invokeWithProjectSession(session, 'db:project-core-update', patch as Partial<ProjectCoreData>, projectPath)
    if (!result.success) throw new Error(result.error || 'PROJECT_CORE_UPDATE_FAILED')
    const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', projectPath)
    if (!core) return {}
    const adopted = novelConfigFromCore({} as NovelConfig, core)
    const keys = new Set<string>(items.map(item => item.field === 'narrativePov' ? 'narrativePOV' : item.field))
    return Object.fromEntries(Object.entries(adopted).filter(([key]) => keys.has(key))) as Partial<NovelConfig>
  }
  const store = useProjectStore.getState()
  const current = store.currentProject
  if (!current || !sameProjectSessionContext(session, projectSessionContextFromProject(current))) {
    await write()
    return
  }
  try {
    await store.commitGeneratedNovelConfig({}, current.novelConfig, session, undefined, write)
  } catch (failure) {
    // 采用已写进库；作者在这期间又改了设定，那份改动留作未保存的草稿。
    if (!(failure instanceof Error && failure.message === 'GENERATION_SAVED_WITH_NEWER_AUTHOR_DRAFT')) throw failure
  }
  // 设定已经写进库；文件树只影响架构文件的显示，刷新失败等下次打开时再读。
  await useProjectStore.getState().refreshFileTree(projectPath, undefined, session).catch(() => undefined)
}
