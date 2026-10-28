import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { NovelConfig } from '../../shared/ipc-channels'
import type { ProjectCoreData } from '../../../electron/repositories/project-core-repository'
import type { ImportFillField, ImportFillSuggestion } from '../../shared/import-fill-empty'
import { ipc } from '../ipc-client'
import { useProjectStore } from '../../stores/project-store'

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

/** 项目库里与小说设定对应的字段。 */
export function configFieldsFromCore(core: ProjectCoreData): Partial<NovelConfig> {
  return {
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

/** 把选中的建议一次写进项目设定。采用的几项按库里的值显示并算已保存；设定页里其他还没保存的改动保持原样。 */
export async function adoptImportSuggestions(
  items: readonly ImportFillSuggestion[],
  session: ProjectSessionContext,
  projectPath: string,
): Promise<void> {
  const patch = Object.fromEntries(items.map(item => [item.field, item.inferred])) as Partial<Record<ImportFillField, string | number>>
  const result = await ipc.invokeWithProjectSession(session, 'db:project-core-update', patch as Partial<ProjectCoreData>, projectPath)
  if (!result.success) throw new Error(result.error || 'PROJECT_CORE_UPDATE_FAILED')
  const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', projectPath)
  if (core) {
    const keys = new Set<string>(items.map(item => item.field === 'narrativePov' ? 'narrativePOV' : item.field))
    const adopted = Object.fromEntries(Object.entries(configFieldsFromCore(core)).filter(([key]) => keys.has(key)))
    useProjectStore.getState().publishSavedNovelConfig(adopted, session, false)
  }
  // 设定已经写进库；文件树只影响架构文件的显示，刷新失败等下次打开时再读。
  await useProjectStore.getState().refreshFileTree(projectPath, undefined, session).catch(() => undefined)
}
