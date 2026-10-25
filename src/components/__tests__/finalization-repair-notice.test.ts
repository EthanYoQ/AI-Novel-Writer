import { describe, expect, it } from 'vitest'

import { finalizationRepairMessage } from '../finalization-repair-notice'

const repair = {
  chapters: [{
    chapterNumber: 3,
    keptDraftId: 9,
    keptVersion: 3,
    superseded: [{ draftId: 5, version: 2, knowledgeDocumentId: 'kb-5', targetFileName: '第3章 沉船-a1b2.txt' }],
  }],
}

describe('遗留重复定稿的修复提示', () => {
  it('中文：说明保留的版本并列出旧定稿留下的知识库文档与实体稿', () => {
    const message = finalizationRepairMessage(repair, zh => zh)

    expect(message).toContain('第 3 章：保留 v3 作为定稿，v2 改为「已被替换的定稿」。')
    expect(message).toContain('知识库文档 kb-5；实体稿 第3章 沉船-a1b2.txt')
  })

  it('英文：同样的内容，不夹中文说明', () => {
    const message = finalizationRepairMessage(repair, (_zh, en) => en)

    expect(message).toContain('Chapter 3: kept v3 as the final version; v2 became replaced finals.')
    expect(message).toContain('knowledge document kb-5; manuscript file 第3章 沉船-a1b2.txt')
    expect(message.replace('第3章 沉船-a1b2.txt', '')).not.toMatch(/\p{Script=Han}/u)
  })
})
