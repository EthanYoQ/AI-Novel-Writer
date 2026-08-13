import fsPromises from 'node:fs/promises'

/**
 * Windows can retain native database directory entries briefly after close.
 * Node applies a finite linear retry only to transient recursive-rm failures.
 */
export async function removeDirectoryWithWindowsRetry(directoryPath: string): Promise<void> {
  await fsPromises.rm(directoryPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
}
