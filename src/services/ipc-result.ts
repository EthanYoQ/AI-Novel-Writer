export interface IpcMutationResult {
  success: boolean
  error?: string
}

/**
 * IPC mutations report business failures as values rather than rejected
 * promises. Convert them to exceptions so workflows cannot continue after a
 * persistence operation failed.
 */
export function requireIpcSuccess<T extends IpcMutationResult>(
  result: T,
  action: string,
  fallbackMessage?: string,
): T {
  if (!result.success) {
    throw new Error(result.error || fallbackMessage || `${action}失败`)
  }
  return result
}
