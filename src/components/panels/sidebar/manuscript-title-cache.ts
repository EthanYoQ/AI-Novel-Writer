/** 章节标题内存缓存：path → 显示名（进程内常驻，避免大量重复 IPC 读取）。 */
export const chapterTitleCache = new Map<string, string>()

/** Keep virtual manuscript paths isolated between project sessions. */
export function chapterTitleCacheKey(projectPath: string, filePath: string): string {
  return `${projectPath}\u0000${filePath}`
}

/** 清除特定文件的章节标题缓存。 */
export function clearChapterTitleCache(filePath?: string): void {
  if (filePath) {
    for (const key of chapterTitleCache.keys()) {
      if (key === filePath || key.endsWith(`\u0000${filePath}`)) {
        chapterTitleCache.delete(key)
      }
    }
    return
  }
  chapterTitleCache.clear()
}
