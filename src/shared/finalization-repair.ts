/** 修复时降为 superseded 的旧定稿，以及它留下、应用没有自动删除的投影。 */
export interface SupersededFinalizationLeftover {
  draftId: number
  version: number
  /** 旧定稿导入知识库的文档；没有收据或没有导入时为空串。 */
  knowledgeDocumentId: string
  /** 旧定稿发布到正文目录的实体稿文件名；没有收据时为空串。 */
  targetFileName: string
}

export interface RepairedDuplicateChapter {
  chapterNumber: number
  keptDraftId: number
  keptVersion: number
  superseded: SupersededFinalizationLeftover[]
}

/** 打开项目时修复遗留同章重复定稿的收据；没有可修的章时 chapters 为空。 */
export interface DuplicateFinalizationRepair {
  chapters: RepairedDuplicateChapter[]
}
