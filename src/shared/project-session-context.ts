import type { ProjectData, ProjectSessionContext } from './ipc-channels'

let activeProjectSessionContext: ProjectSessionContext | null = null

/**
 * Renderer 侧的 Windows 路径身份键。
 *
 * 这里刻意不访问文件系统：它只消除 UI 状态中大小写、分隔符、`.`/`..` 与尾部分隔符
 * 带来的等价路径漂移。真正的符号链接/短路径/磁盘大小写规范化仍由主进程
 * ProjectAccess 的 canonical root 校验负责。
 */
export function projectPathKey(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null

  let value = projectPath.trim().replace(/\//g, '\\')
  if (!value) return null

  // Windows extended-length paths are semantically the same project path for
  // renderer-state comparison.  Preserve regular UNC paths after removing the
  // device prefix, while leaving the main process to perform authoritative IO
  // canonicalisation.
  if (value.startsWith('\\\\?\\')) {
    value = value.slice(4)
    if (value.toLocaleLowerCase('en-US').startsWith('unc\\')) {
      value = `\\\\${value.slice(4)}`
    }
  }

  const isUnc = value.startsWith('\\\\')
  const drive = !isUnc ? /^([A-Za-z]:)(\\|$)/.exec(value) : null
  const isAbsoluteDrive = !!drive && value.slice(2).startsWith('\\')
  const prefix = isUnc
    ? '\\\\'
    : drive
      ? isAbsoluteDrive ? `${drive[1]}\\` : drive[1]
      : ''
  const rawSegments = (isUnc
    ? value.slice(2)
    : drive
      ? value.slice(2).replace(/^\\+/, '')
      : value
  ).split('\\')
  const segments: string[] = []
  // A UNC share root is `\\server\\share`; do not let a lexical `..` escape it.
  const protectedSegments = isUnc ? 2 : 0

  for (const segment of rawSegments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > protectedSegments && segments.at(-1) !== '..') {
        segments.pop()
      } else if (!prefix) {
        segments.push(segment)
      }
      continue
    }
    segments.push(segment)
  }

  const body = segments.join('\\')
  if (!body) return prefix.toLocaleLowerCase('en-US') || null
  if (!prefix) return body.toLocaleLowerCase('en-US')
  return `${prefix}${body}`.toLocaleLowerCase('en-US')
}

export function sameProjectPathKey(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftKey = projectPathKey(left)
  const rightKey = projectPathKey(right)
  return !!leftKey && leftKey === rightKey
}

export function projectSessionContextFromProject(
  project: Pick<ProjectData, 'id' | 'path' | 'sessionLease'> | null | undefined,
): ProjectSessionContext | null {
  if (!project?.id || !project.path || !project.sessionLease) return null
  return Object.freeze({
    projectId: project.id,
    leaseId: project.sessionLease,
    projectPath: project.path,
  })
}

/** Renderer 唯一的当前会话登记处；写入时复制并冻结，避免异步任务借用后续会话。 */
export function setActiveProjectSessionContext(context: ProjectSessionContext | null): void {
  activeProjectSessionContext = context
    ? Object.freeze({ ...context })
    : null
}

export function getActiveProjectSessionContext(): ProjectSessionContext | null {
  return activeProjectSessionContext
}

export function sameProjectSessionContext(
  left: ProjectSessionContext | null | undefined,
  right: ProjectSessionContext | null | undefined,
): boolean {
  return !!left
    && !!right
    && left.projectId === right.projectId
    && left.leaseId === right.leaseId
    && sameProjectPathKey(left.projectPath, right.projectPath)
}
