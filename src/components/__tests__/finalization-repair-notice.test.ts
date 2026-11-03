import { describe, expect, it } from 'vitest'

import { finalizationRepairMessage } from '../finalization-repair-notice'

const repair = {
  chapters: [{
    chapterNumber: 3,
    keptDraftId: 9,
    keptVersion: 3,
    superseded: [{ draftId: 5, version: 2, knowledgeDocumentId: 'kb-5', targetFileName: '第3章 沉船-a1b2.txt' }],
    cleanupRegistered: false,
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
    cleanupRegistered: false,
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

  it('清理步骤已登记：告诉作者到这一章的「定稿后处理」里点「重试」清理，不再说删不了或去目录里自己删', () => {
    const registered = { chapters: [{ ...repair.chapters[0]!, cleanupRegistered: true }] }

    const zhMessage = finalizationRepairMessage(registered, zh)
    expect(zhMessage).toContain('可以在这一章的「定稿后处理」里点「重试」清理')
    expect(zhMessage).toContain('第3章 沉船-a1b2.txt')
    expect(zhMessage).not.toContain('目前不能单独删除')
    expect(zhMessage).not.toContain('自行删除')

    const enMessage = finalizationRepairMessage(registered, en)
    expect(enMessage).toContain('After finalization')
    expect(enMessage).not.toMatch(/can't be removed|delete them from the manuscript folder/u)
    expect(enMessage.replace('第3章 沉船-a1b2.txt', '')).not.toMatch(/\p{Script=Han}/u)
  })

  it('清理步骤已登记但旧定稿只留下实体稿：只说清理实体稿，不提知识库', () => {
    const filesOnly = { chapters: [{ ...twoReplaced.chapters[0]!, cleanupRegistered: true }] }

    const zhMessage = finalizationRepairMessage(filesOnly, zh)
    expect(zhMessage).toContain('可以在这一章的「定稿后处理」里点「重试」清理')
    expect(zhMessage).not.toContain('知识库')

    const enMessage = finalizationRepairMessage(filesOnly, en)
    expect(enMessage).toContain('After finalization')
    expect(enMessage).not.toMatch(/knowledge base/iu)
  })

  it('清理步骤已登记但旧定稿只留在知识库里：只说清理知识库，不提实体稿', () => {
    const knowledgeOnly = { chapters: [{ ...repair.chapters[0]!, cleanupRegistered: true,
      superseded: [{ ...repair.chapters[0]!.superseded[0]!, targetFileName: '' }] }] }

    const zhMessage = finalizationRepairMessage(knowledgeOnly, zh)
    expect(zhMessage).toContain('可以在这一章的「定稿后处理」里点「重试」清理')
    expect(zhMessage).toContain('知识库')
    expect(zhMessage).not.toContain('实体稿')

    const enMessage = finalizationRepairMessage(knowledgeOnly, en)
    expect(enMessage).toContain('knowledge base')
    expect(enMessage).not.toMatch(/manuscript/iu)
  })
})
