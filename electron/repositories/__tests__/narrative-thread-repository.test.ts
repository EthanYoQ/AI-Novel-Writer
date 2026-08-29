import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { FinalizedDraftImportRepository } from '../finalized-draft-import-repository'
import { DraftRepository } from '../draft-repository'
import { NarrativeThreadRepository } from '../narrative-thread-repository'

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-thread-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('NarrativeThreadRepository', () => {
  it('keeps editable author plans as independent project facts', () => {
    expect(NarrativeThreadRepository.list()).toEqual([])

    const created = NarrativeThreadRepository.createPlan({
      title: '失踪的航海日志',
      type: '伏笔',
      targetStartChapter: 2,
      targetEndChapter: 8,
      authorIntent: '在第八章揭示日志由谁伪造。',
    })
    NarrativeThreadRepository.updatePlan(created.id, {
      title: '被篡改的航海日志',
      type: '长期承诺',
      targetStartChapter: 3,
      targetEndChapter: 9,
      authorIntent: '第九章揭示伪造者及动机。',
    })
    closeProjectDatabase()
    initProjectDatabase(projectRoot)

    expect(NarrativeThreadRepository.list()).toEqual([expect.objectContaining({
      id: created.id,
      title: '被篡改的航海日志',
      type: '长期承诺',
      targetStartChapter: 3,
      targetEndChapter: 9,
      authorIntent: '第九章揭示伪造者及动机。',
      status: 'planned',
      dormantChapters: 0,
      overdue: false,
      events: [],
    })])
  })

  it('derives ordered event state only from user confirmations bound to finalized drafts', () => {
    const plan = NarrativeThreadRepository.createPlan({
      title: '旧码头的钥匙',
      type: '伏笔',
      targetStartChapter: 1,
      targetEndChapter: 3,
      authorIntent: '第三章打开仓库。',
    })
    const contentId = Number(getProjectDb()!.prepare("INSERT INTO contents (body) VALUES ('草稿')").run().lastInsertRowid)
    const draftId = Number(getProjectDb()!.prepare(`
      INSERT INTO drafts (chapter_number, version, status, source, content_id, word_count)
      VALUES (1, 1, 'draft', 'write', ?, 2)
    `).run(contentId).lastInsertRowid)

    expect(() => NarrativeThreadRepository.confirmEvent({
      planId: plan.id,
      draftId,
      type: 'planted',
      evidence: '草稿中的钥匙。',
      reason: '尚未定稿。',
    })).toThrow('只能绑定已定稿章节')

    const finalized = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-finalized-source',
      chapters: [
        { chapterNumber: 1, title: '旧码头', content: '林岚捡到钥匙。', wordCount: '林岚捡到钥匙。'.length },
        { chapterNumber: 3, title: '仓库门', content: '钥匙打开仓库。', wordCount: '钥匙打开仓库。'.length },
      ],
    })
    NarrativeThreadRepository.confirmEvent({
      planId: plan.id,
      draftId: finalized.drafts[0]!.draftId,
      type: 'planted',
      evidence: '林岚捡到钥匙。',
      reason: '埋设钥匙来源。',
    })
    NarrativeThreadRepository.confirmEvent({
      planId: plan.id,
      draftId: finalized.drafts[1]!.draftId,
      type: 'resolved',
      evidence: '钥匙打开仓库。',
      reason: '兑现第一章伏笔。',
    })

    const [view] = NarrativeThreadRepository.list()
    expect(view).toEqual(expect.objectContaining({
      id: plan.id,
      title: '旧码头的钥匙',
      status: 'resolved',
      dormantChapters: 0,
      overdue: false,
    }))
    expect(view?.events.map(event => [event.chapterNumber, event.type, event.chapterTitle])).toEqual([
      [1, 'planted', '旧码头'],
      [3, 'resolved', '仓库门'],
    ])
    expect(NarrativeThreadRepository.getPlan(plan.id)?.authorIntent).toBe('第三章打开仓库。')

    DraftRepository.clearAll()
    expect(NarrativeThreadRepository.list()[0]).toEqual(expect.objectContaining({
      id: plan.id,
      title: '旧码头的钥匙',
      status: 'planned',
      events: [],
    }))
  })

  it('computes inactivity and overdue state at query time', () => {
    const plan = NarrativeThreadRepository.createPlan({
      title: '迟到的回信',
      type: '长期承诺',
      targetStartChapter: 2,
      targetEndChapter: 4,
      authorIntent: '第四章前收到回信。',
    })

    const content = '第七章定稿。'
    FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-current-chapter-query',
      chapters: [{ chapterNumber: 7, title: '第七章', content, wordCount: content.length }],
    })

    expect(NarrativeThreadRepository.list()[0]).toEqual(expect.objectContaining({
      id: plan.id,
      status: 'planned',
      dormantChapters: 5,
      overdue: true,
    }))
  })

  it('requires author rationale and evidence that exists in the finalized content', () => {
    expect(() => NarrativeThreadRepository.createPlan({
      title: '无理由计划', type: '伏笔', targetStartChapter: 1, targetEndChapter: 2, authorIntent: '',
    })).toThrow('叙事线索计划参数无效')

    const plan = NarrativeThreadRepository.createPlan({
      title: '墙上的刻痕', type: '伏笔', targetStartChapter: 1, targetEndChapter: 2,
      authorIntent: '第二章解释刻痕来源。',
    })
    const content = '林岚在门框上发现三道平行刻痕。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-evidence-boundary',
      chapters: [{ chapterNumber: 1, title: '三道刻痕', content, wordCount: content.length }],
    })
    const draftId = receipt.drafts[0]!.draftId

    expect(() => NarrativeThreadRepository.confirmEvent({
      planId: plan.id, draftId, type: 'planted', evidence: '正文里不存在的银色钥匙。', reason: '埋设。',
    })).toThrow('短证据必须来自绑定的定稿正文')
    expect(() => NarrativeThreadRepository.confirmEvent({
      planId: plan.id, draftId, type: 'planted', evidence: '三道平行刻痕', reason: '',
    })).toThrow('叙事线索事件参数无效')
  })

  it('returns only active threads relevant to the current chapter plan', () => {
    const inRange = NarrativeThreadRepository.createPlan({
      title: '门框上的刻痕', type: '伏笔', targetStartChapter: 2, targetEndChapter: 4,
      authorIntent: '第四章揭示刻痕来自旧组织。',
    })
    const characterRelevant = NarrativeThreadRepository.createPlan({
      title: '林岚隐瞒的旧伤', type: '人物承诺', targetStartChapter: 8, targetEndChapter: 12,
      authorIntent: '林岚面对故人时承认旧伤。',
    })
    const unrelated = NarrativeThreadRepository.createPlan({
      title: '北港的失踪货船', type: '世界线', targetStartChapter: 8, targetEndChapter: 12,
      authorIntent: '海关在第十二章公布调查结论。',
    })
    const resolved = NarrativeThreadRepository.createPlan({
      title: '已经打开的暗门', type: '伏笔', targetStartChapter: 1, targetEndChapter: 4,
      authorIntent: '第三章打开暗门。',
    })
    const abandoned = NarrativeThreadRepository.createPlan({
      title: '废弃的支线', type: '支线', targetStartChapter: 1, targetEndChapter: 4,
      authorIntent: '作者决定放弃。',
    })
    const content = '林岚推开暗门。废弃的支线不再继续。'
    const receipt = FinalizedDraftImportRepository.commit(projectRoot, {
      operationId: 'thread-relevant-active-source',
      chapters: [{ chapterNumber: 2, title: '暗门', content, wordCount: content.length }],
    })
    NarrativeThreadRepository.confirmEvent({
      planId: resolved.id, draftId: receipt.drafts[0]!.draftId, type: 'resolved',
      evidence: '林岚推开暗门', reason: '伏笔已兑现。',
    })
    NarrativeThreadRepository.confirmEvent({
      planId: abandoned.id, draftId: receipt.drafts[0]!.draftId, type: 'abandoned',
      evidence: '废弃的支线不再继续', reason: '作者明确放弃。',
    })

    expect(NarrativeThreadRepository.listRelevantActive({
      chapterNumber: 3,
      title: '刻痕再现',
      keyEvents: '林岚发现新的刻痕。',
      characters: ['林岚'],
    }).map(thread => thread.id)).toEqual([inRange.id, characterRelevant.id])
    expect(NarrativeThreadRepository.listRelevantActive({
      chapterNumber: 3,
      title: '刻痕再现',
      keyEvents: '林岚发现新的刻痕。',
      characters: ['林岚'],
    }).map(thread => thread.id)).not.toContain(unrelated.id)
  })
})
