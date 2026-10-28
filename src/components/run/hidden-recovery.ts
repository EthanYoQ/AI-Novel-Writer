/**
 * 运行侧页里作者点了「不再显示」的候选：只是这台电脑上的显示偏好，按作品记隐藏时那一刻的内容标记（运行 id 加当时列出的片段与尾段），
 * 不碰作品库里的生成记录、收据与来源证明。存储不可用时什么也不隐藏。
 */
const key = (projectId: string) => `pagekin:run-recovery-hidden:${projectId}`

export function readHiddenRecovery(projectId: string): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(projectId)) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

export function hideRecovery(projectId: string, hideKey: string): void {
  const next = new Set(readHiddenRecovery(projectId)).add(hideKey)
  try { localStorage.setItem(key(projectId), JSON.stringify([...next])) } catch { /* 存不下时只在这次打开里隐藏。 */ }
}
