const RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const
const BUSY_CODES: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])

function waitSynchronously(milliseconds: number) {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.wait(signal, 0, 0, milliseconds)
}

export function isWindowsFileBusyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && BUSY_CODES.has(code)
}

/**
 * Windows Defender、索引服务可能短暂占住刚写过的文件：只对占用类错误按固定间隔重试几次。
 * 其他错误、其他平台、重试用完都把原错误抛出。
 */
export function retryWhileWindowsFileBusy<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt]
      if (process.platform !== 'win32' || delay === undefined || !isWindowsFileBusyError(error)) throw error
      waitSynchronously(delay)
    }
  }
}
