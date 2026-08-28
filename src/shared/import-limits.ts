export const MAX_IMPORT_CHAPTERS = 5_000
export const MAX_IMPORT_SOURCE_FILES = 5_000
export const MAX_IMPORT_TOTAL_BYTES = 128 * 1024 * 1024

export interface ImportResourceLimits {
  maxChapters: number
  maxSourceFiles: number
  maxTotalBytes: number
}

export const DEFAULT_IMPORT_RESOURCE_LIMITS: Readonly<ImportResourceLimits> = Object.freeze({
  maxChapters: MAX_IMPORT_CHAPTERS,
  maxSourceFiles: MAX_IMPORT_SOURCE_FILES,
  maxTotalBytes: MAX_IMPORT_TOTAL_BYTES,
})
