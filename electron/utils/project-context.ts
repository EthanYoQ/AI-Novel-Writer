import fs from 'node:fs'
import path from 'node:path'

function normalizedProjectPath(projectPath: string): string {
  return path.resolve(projectPath).toLocaleLowerCase('en-US')
}

export function assertExpectedProjectPath(
  currentProjectPath: string | null,
  expectedProjectPath?: string,
): void {
  if (!expectedProjectPath) return
  if (
    !currentProjectPath
    || normalizedProjectPath(currentProjectPath) !== normalizedProjectPath(expectedProjectPath)
  ) {
    throw new Error('项目上下文已切换，已拒绝跨项目读写')
  }
}

/** 对可能修改或读取项目数据的通道，调用方必须显式携带冻结的项目身份。 */
export function assertRequiredExpectedProjectPath(
  currentProjectPath: string | null,
  expectedProjectPath: string | undefined,
): asserts expectedProjectPath is string {
  if (!expectedProjectPath) {
    throw new Error('缺少项目上下文，已拒绝项目数据访问')
  }
  assertExpectedProjectPath(currentProjectPath, expectedProjectPath)
}

function assertContainedPath(root: string, target: string): void {
  const relative = path.relative(root, target)
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error('文件路径超出当前项目目录，已拒绝访问')
  }
}

function canonicalPath(filePath: string): string {
  return fs.realpathSync.native(filePath)
}

function canonicalWritableTarget(filePath: string): string {
  let existingAncestor = path.resolve(filePath)
  const missingSegments: string[] = []
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor)
    if (parent === existingAncestor) {
      throw new Error('无法解析文件目标的现有父目录')
    }
    missingSegments.unshift(path.basename(existingAncestor))
    existingAncestor = parent
  }
  return path.resolve(canonicalPath(existingAncestor), ...missingSegments)
}

/**
 * 使用 realpath 后的项目根与目标比较，拒绝 junction/symlink 指向项目外部。
 * existing 适用于读取/枚举；writable 适用于允许目标尚未存在的写入/建目录。
 */
export function assertProjectFilePath(
  filePath: string,
  expectedProjectPath: string,
  mode: 'existing' | 'writable' = 'existing',
): void {
  // 先做词法边界检查，避免对明显越界且不存在的路径暴露 ENOENT，
  // 再通过 realpath 检查项目目录内的 junction/symlink 是否实际指向外部。
  assertContainedPath(path.resolve(expectedProjectPath), path.resolve(filePath))
  const root = canonicalPath(expectedProjectPath)
  const target = mode === 'existing'
    ? canonicalPath(filePath)
    : canonicalWritableTarget(filePath)
  assertContainedPath(root, target)
}
