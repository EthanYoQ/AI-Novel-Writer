import type { StepCallbacks } from '../../stores/workflow-store'

export const IMPORT_DERIVED_FILE_TREE_REFRESH_TIMEOUT_MS = 5_000

export async function refreshImportDerivedFileTreeBestEffort(
  refreshFileTree: () => Promise<void>,
  callbacks: Pick<StepCallbacks, 'log'>,
  text: (zhCNText: string, enUSText: string) => string,
  timeoutMs = IMPORT_DERIVED_FILE_TREE_REFRESH_TIMEOUT_MS,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      refreshFileTree(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('import derived file-tree refresh timeout')), timeoutMs)
      }),
    ])
  } catch {
    callbacks.log(text(
      '导入派生文件树刷新未在短时间内完成，已跳过；核心导入结果不受影响。',
      'The derived import file tree did not refresh promptly and was skipped; the core import result is unaffected.',
    ))
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}
