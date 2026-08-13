import path from 'node:path'
import type { AppFailure } from '../../src/shared/ipc-channels'

export const PROJECT_STORAGE_PATH_UNSUPPORTED = 'PROJECT_STORAGE_PATH_UNSUPPORTED' as const

const WINDOWS_NATIVE_PATH_LIMIT = 259
const LANCE_DATA_FILE_PLACEHOLDER = `${'0'.repeat(56)}.lance`
const PROJECT_CORE_STORAGE_RELATIVE_PATHS = [
  path.win32.join('.vela', 'vela.db-wal'),
] as const
const PROJECT_KNOWLEDGE_STORAGE_RELATIVE_PATHS = [
  path.win32.join('.vela', `embedding-spaces.json.${'0'.repeat(36)}.tmp`),
  path.win32.join(
    '.vela',
    'lancedb',
    'chunks__space_2147483647.lance',
    'data',
    LANCE_DATA_FILE_PLACEHOLDER,
  ),
] as const

export interface ProjectStoragePreflightOptions {
  platform?: NodeJS.Platform
  maxNativePathCharacters?: number
}

export class ProjectStoragePreflightError extends Error {
  readonly code = PROJECT_STORAGE_PATH_UNSUPPORTED

  constructor(
    readonly projectRootLength: number,
    readonly maxProjectRootLength: number,
    storage: 'project' | 'knowledge-base',
  ) {
    super(
      storage === 'project'
        ? `项目路径过深，无法安全打开项目数据库。请将整个项目文件夹移动到更靠近磁盘根目录的位置（例如 D:\\Novels），并将完整项目路径控制在 ${maxProjectRootLength} 个字符以内。`
        : `项目路径过深，知识库暂不可用，但项目内容仍可打开和导出。请将整个项目文件夹移动到更靠近磁盘根目录的位置（例如 D:\\Novels），并将完整项目路径控制在 ${maxProjectRootLength} 个字符以内。`,
    )
    this.name = 'ProjectStoragePreflightError'
  }
}

type ProjectStorageFailure = AppFailure & {
  errorCode: typeof PROJECT_STORAGE_PATH_UNSUPPORTED
  error: string
}

/** Accept the local class and Errors crossing a module/realm seam, never plain objects. */
export function isProjectStoragePreflightError(
  error: unknown,
): error is Error & { code: typeof PROJECT_STORAGE_PATH_UNSUPPORTED } {
  return error instanceof Error
    && 'code' in error
    && error.code === PROJECT_STORAGE_PATH_UNSUPPORTED
}

export function projectStoragePreflightFailure(
  error: unknown,
): ProjectStorageFailure | undefined {
  if (!isProjectStoragePreflightError(error)) return undefined
  return {
    success: false,
    errorCode: PROJECT_STORAGE_PATH_UNSUPPORTED,
    error: error.message,
  }
}

/**
 * Validate every fixed native-storage leaf before any project write occurs.
 * LanceDB currently has the longest derived path, but keeping the full list
 * here prevents SQLite or registry changes from silently weakening the gate.
 */
function assertDerivedStoragePathsSupported(
  projectRoot: string,
  relativePaths: readonly string[],
  storage: 'project' | 'knowledge-base',
  options: ProjectStoragePreflightOptions = {},
): void {
  if ((options.platform ?? process.platform) !== 'win32') return

  const maxNativePathCharacters = options.maxNativePathCharacters ?? WINDOWS_NATIVE_PATH_LIMIT
  const longestRelativePathLength = Math.max(...relativePaths.map(candidate => candidate.length))
  const maxProjectRootLength = maxNativePathCharacters - 1 - longestRelativePathLength
  const longestDerivedPathLength = projectRoot.length + 1 + longestRelativePathLength
  if (longestDerivedPathLength <= maxNativePathCharacters) return

  throw new ProjectStoragePreflightError(projectRoot.length, maxProjectRootLength, storage)
}

export function assertProjectStoragePathSupported(
  projectRoot: string,
  options: ProjectStoragePreflightOptions = {},
): void {
  assertDerivedStoragePathsSupported(projectRoot, PROJECT_CORE_STORAGE_RELATIVE_PATHS, 'project', options)
  assertDerivedStoragePathsSupported(projectRoot, PROJECT_KNOWLEDGE_STORAGE_RELATIVE_PATHS, 'knowledge-base', options)
}

export function assertProjectCoreStoragePathSupported(
  projectRoot: string,
  options: ProjectStoragePreflightOptions = {},
): void {
  assertDerivedStoragePathsSupported(projectRoot, PROJECT_CORE_STORAGE_RELATIVE_PATHS, 'project', options)
}

export function assertKnowledgeBaseStoragePathSupported(
  projectRoot: string,
  options: ProjectStoragePreflightOptions = {},
): void {
  assertDerivedStoragePathsSupported(projectRoot, PROJECT_KNOWLEDGE_STORAGE_RELATIVE_PATHS, 'knowledge-base', options)
}
