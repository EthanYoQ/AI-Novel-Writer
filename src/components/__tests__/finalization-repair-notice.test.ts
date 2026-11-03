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

const twoReplaced = {
  chapters: [{
    chapterNumber: 4,
    keptDraftId: 12,
    keptVersion: 3,
    superseded: [
      { draftId: 10, version: 1, knowledgeDocumentId: '', targetFileName: '第4章 灯室.txt' },
      { draftId: 11, version: 2, knowledgeDocumentId: '', targetFileName: '第4章 灯室-c3d4.txt' },
    ],
  }],
}

const zh = (text: string) => text
const en = (_zh: string, text: string) => text

describe('遗留重复定稿的修复提示', () => {
  it('中文：说明保留的版本、按钮名与实际一致，旧定稿的知识库内容只说明不能单独删除', () => {
    const message = finalizationRepairMessage(repair, zh)

    expect(message).toContain('「回退到此版本…」')
    expect(message).toContain('第 3 章：保留 v3 作为定稿，v2 改为「已被替换的定稿」。')
    expect(message).toContain('这一章旧定稿的内容还留在知识库里，目前不能单独删除。')
    expect(message).toContain('第3章 沉船-a1b2.txt')
    expect(message).not.toContain('kb-5')
  })

  it('英文：按钮名与实际一致，一个旧版本用单数，不列知识库文档编号', () => {
    const message = finalizationRepairMessage(repair, en)

    expect(message).toContain('“Revert to this version…”')
    expect(message).not.toContain('Restore this version')
    expect(message).toContain('Chapter 3: kept v3 as the final version; v2 became a replaced final.')
    expect(message).not.toContain('kb-5')
    expect(message).toContain('Manuscript file left by the replaced final: ')
    expect(message).toContain('Text from this chapter\'s replaced final is still in the knowledge base')
    expect(message.replace('第3章 沉船-a1b2.txt', '')).not.toMatch(/\p{Script=Han}/u)
  })

  it('英文：多个旧版本用复数；没有知识库内容时不提知识库', () => {
    const message = finalizationRepairMessage(twoReplaced, en)

    expect(message).toContain('Chapter 4: kept v3 as the final version; v1, v2 became replaced finals.')
    expect(message).not.toMatch(/knowledge base/iu)
    expect(message).toContain('第4章 灯室.txt; 第4章 灯室-c3d4.txt')
    expect(message).toContain('Manuscript files left by the replaced finals: ')
  })

  it('没有列出实体稿时，结尾不让作者去正文目录删文件', () => {
    const noFiles = { chapters: [{ ...repair.chapters[0]!, superseded: [{ ...repair.chapters[0]!.superseded[0]!, targetFileName: '' }] }] }

    expect(finalizationRepairMessage(noFiles, zh)).not.toContain('实体稿')
    expect(finalizationRepairMessage(noFiles, zh)).toContain('旧定稿的正文仍在版本历史里。')
    expect(finalizationRepairMessage(noFiles, en)).not.toMatch(/manuscript/iu)
  })
})
