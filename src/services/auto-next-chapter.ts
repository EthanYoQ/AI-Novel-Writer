export interface NextChapterBlueprint {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  keyEvents: string
  characters: string[]
  userGuidance: string
}

/**
 * 定稿后的自动操作只负责打开紧邻的、尚未开始的章节创作窗口。
 * 它不会直接调用模型，也不会覆盖已有草稿。
 */
export function getAutoNextChapterPrefill(
  enabled: boolean,
  completedChapter: number,
  blueprint: NextChapterBlueprint | null,
  hasExistingDraft: boolean,
): Record<string, unknown> | null {
  if (!enabled || hasExistingDraft || !blueprint || blueprint.chapterNumber !== completedChapter + 1) {
    return null
  }

  return {
    chapterNumber: blueprint.chapterNumber,
    title: blueprint.title,
    role: blueprint.role,
    purpose: blueprint.purpose,
    keyEvents: blueprint.keyEvents,
    characters: blueprint.characters.join('、'),
    userGuidance: blueprint.userGuidance || '',
  }
}
