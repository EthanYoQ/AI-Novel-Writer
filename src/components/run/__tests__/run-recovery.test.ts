import { describe, expect, it } from 'vitest'
import { buildRecoveryEntries, canResumeDraft, EMPTY_RECOVERY_SOURCES, isInFlight, outlineSourceChangedNote, type DraftEntry, type RecoverySources, type ReviewEntry } from '../run-recovery'

const handle = { projectId: '灯塔', epoch: '会话', rootActionId: '预算', runId: '正文' }
const artifact = (artifactId: string, compositionEligible: boolean) => ({
  ...handle, artifactId, attemptId: `${artifactId}-请求`, text: `片段${artifactId}`, textHash: 'a'.repeat(64),
  revision: 1, durableRevision: 1, status: 'completed', compositionEligible,
})
const view = (runId: string, extra: Record<string, unknown> = {}) => ({ handle: { ...handle, runId }, status: 'failed', artifacts: [], ...extra })

function draft(recovery: Record<string, unknown>, artifacts = [artifact('甲', true), artifact('乙', false)]): DraftEntry {
  const sources: RecoverySources = { ...EMPTY_RECOVERY_SOURCES, drafts: [{
    view: view('正文', { artifacts, ledger: { physicalRequests: 3 } }) as never,
    recovery: { handle, operation: 'chapter-draft', chapterNumber: 4, attemptedPurposes: ['chapter-draft'], draftSave: { kind: 'absent' }, ...recovery } as never,
  }] }
  return buildRecoveryEntries(sources, 'zh-CN')[0] as DraftEntry
}

function review(recovery: Record<string, unknown>, status = 'failed'): ReviewEntry {
  const sources: RecoverySources = { ...EMPTY_RECOVERY_SOURCES, reviews: [{
    view: view('审稿', { status }) as never,
    recovery: { handle, modelId: '模型', sourceStatus: 'current', canResume: true, attemptedPurposes: ['review-chapter'],
      context: { operation: 'review-chapter', source: { chapterNumber: 3 } }, ...recovery } as never,
  }] }
  return buildRecoveryEntries(sources, 'zh-CN')[0] as ReviewEntry
}

describe('单章写作中断', () => {
  it('没有已存续写方案时要先勾选可续接的片段', () => {
    const entry = draft({ composition: null })
    expect(entry).toMatchObject({ title: '第4章候选', usage: '已用 3 次请求', actionLabel: '确认继续已选正文', needsPick: true })
    expect(entry.artifacts.map(item => item.selectable)).toEqual([true, false])
    expect(canResumeDraft(entry, [])).toBe(false)
    expect(canResumeDraft(entry, ['甲'])).toBe(true)
  })

  it('没写出字的片段不列出', () => {
    const entry = draft({ composition: null }, [artifact('甲', true), { ...artifact('空', true), text: '  ' }])
    expect(entry.artifacts.map(item => item.id)).toEqual(['甲'])
  })

  it('草稿保存后正文又改过，只能复制，不能续写', () => {
    const entry = draft({ composition: null, draftSave: { kind: 'changed' } })
    expect(entry).toMatchObject({ title: '第4章生成记录', actionLabel: '已保存，正文已修改', changed: true })
    expect(entry.artifacts.every(item => !item.selectable)).toBe(true)
    expect(canResumeDraft(entry, ['甲'])).toBe(false)
  })

  it('只写完细纲时不用勾选，可重做一次细纲或沿原细纲继续', () => {
    const outline = { composition: null, attemptedPurposes: ['chapter-draft-short-outline'] }
    const retry = draft({ ...outline, draftShortOutline: { retry: { kind: 'available' } } }, [])
    expect(retry.actionLabel).toBe('重做一次细纲并继续写稿')
    expect(canResumeDraft(retry, [])).toBe(true)
    expect(draft({ ...outline, draftShortOutline: { completedOutput: '细纲' } }, []).actionLabel).toBe('沿原细纲继续写稿')
  })
})

describe('还在写的生成', () => {
  it('这次打开里有运行正在写这一章时不算可恢复；运行已经结束（会话内失败）或上次打开时没写完的都算', () => {
    const running = (epoch: string) => buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, drafts: [{
      view: { ...view('正文', { status: 'running', artifacts: [artifact('甲', true)] }), handle: { ...handle, epoch } } as never,
      recovery: { handle, operation: 'chapter-draft', chapterNumber: 4, attemptedPurposes: ['chapter-draft'], draftSave: { kind: 'absent' } } as never,
    }] }, 'zh-CN')[0]
    const writing = (chapter: number) => ({ type: 'chapter_creation' as const, resourceKeys: [`chapter:${chapter}`] })
    expect(isInFlight(running('本次'), '本次', [writing(4)])).toBe(true)
    expect(isInFlight(running('本次'), '本次', [writing(5)])).toBe(false)
    expect(isInFlight(running('本次'), '本次', [])).toBe(false)
    expect(isInFlight(running('上次'), '本次', [writing(4)])).toBe(false)
    expect(isInFlight(draft({}), '会话', [])).toBe(false)
  })

  it('单章写作在这次打开里失败后，接着跑包含这一章的批量（含暂停）时，单章恢复卡照样列出', () => {
    const entry = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, drafts: [{
      view: view('正文', { status: 'running', artifacts: [artifact('甲', true)], unsavedTails: [{ attemptId: '尾段', artifactId: '甲', durableRevision: 1, text: '未落盘的尾段', failureCode: 'X' }] }) as never,
      recovery: { handle, operation: 'chapter-draft', chapterNumber: 4, attemptedPurposes: ['chapter-draft'], draftSave: { kind: 'absent' } } as never,
    }] }, 'zh-CN')[0]
    const batch = { type: 'batch_generate' as const, resourceKeys: ['chapter:3', 'chapter:4', 'chapter:5'] }
    expect(isInFlight(entry, '会话', [batch])).toBe(false)
    expect(isInFlight(entry, '会话', [{ type: 'chapter_creation', resourceKeys: ['chapter:4'] }])).toBe(true)
  })

  it('审稿在这次打开里失败、持久状态仍是 running 时也算可恢复', () => {
    const entry = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, reviews: [{
      view: view('审稿', { status: 'running' }) as never,
      recovery: { handle, modelId: '模型', sourceStatus: 'current', canResume: true, attemptedPurposes: ['review-chapter'],
        context: { operation: 'review-chapter', source: { chapterNumber: 3 } } } as never,
    }] }, 'zh-CN')[0]
    expect(isInFlight(entry, '会话', [])).toBe(false)
    expect(isInFlight(entry, '会话', [{ type: 'chapter_creation', resourceKeys: ['chapter:3'] }])).toBe(true)
  })

  it('批量正文由进行中（含暂停）的同范围批量运行推进时不算可恢复，运行结束后算', () => {
    const [entry] = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, batches: [{ batchId: '批次', completedChapters: [1],
      nextChapterNumber: 4, sourceCurrent: true, range: { startChapter: 3, endChapter: 5 } } as never] }, 'zh-CN')
    const live = (type: 'batch_generate' | 'chapter_creation', chapters: number[]) => ({ type, resourceKeys: chapters.map(chapter => `chapter:${chapter}`) })
    expect(isInFlight(entry, '本次', [live('batch_generate', [3, 4, 5])])).toBe(true)
    expect(isInFlight(entry, '本次', [live('batch_generate', [4, 5, 6])])).toBe(false)
    expect(isInFlight(entry, '本次', [live('chapter_creation', [3, 4, 5])])).toBe(false)
    expect(isInFlight(entry, '本次', [])).toBe(false)
  })
})

describe('审稿与修稿中断', () => {
  it('已保存的结果总能打开，即使来源变了', () => {
    expect(review({ saved: { id: 1 }, sourceStatus: 'conflict' })).toMatchObject({ actionLabel: '打开已保存结果', canAct: true, notes: [] })
  })

  it('来源变化且未保存时只能复制', () => {
    const entry = review({ sourceStatus: 'conflict' })
    expect(entry.canAct).toBe(false)
    expect(entry.notes).toEqual(['来源已变化；候选仍可复制，不能直接保存。'])
  })

  it('没有完整审稿报告时提示重新审稿会再调用模型', () => {
    const entry = review({})
    expect(entry).toMatchObject({ actionLabel: '重新审稿', canAct: true, title: '第3章审稿候选' })
    expect(entry.notes).toEqual(['尚无完整审稿报告。重新审稿会重新调用模型；原稿保留。'])
  })

  it('已取消的审稿不能恢复', () => {
    expect(review({}, 'cancelled').canAct).toBe(false)
  })
})

describe('列表', () => {
  it('按恢复稿、选区建议、审修、批量、单章、旧恢复候选排列，英文界面用英文', () => {
    const sources: RecoverySources = {
      planning: [{ handle: { ...handle, runId: '大纲' }, plotOutlineRecovery: {} } as never],
      editors: [{ view: view('选区', { ledger: { physicalRequests: 1 } }), modelId: '模型', sourceStatus: 'conflict',
        context: { selectedText: '选中', documentText: '全文' } } as never],
      reviews: [],
      batches: [{ batchId: '批次', completedChapters: [1, 2], nextChapterNumber: 3, sourceCurrent: false } as never],
      drafts: [],
      candidates: [{ candidateId: '候选', chapterNumber: 2, chapterTitle: '北堤', visibleText: '旧文', sourceCurrent: false, replacesCandidateId: null } as never],
    }
    const entries = buildRecoveryEntries(sources, 'en-US')
    expect(entries.map(entry => entry.kind)).toEqual(['planning', 'editor', 'batch', 'candidate'])
    expect(entries.map(entry => entry.title)).toEqual([
      'Outline recovery draft', 'Editor selection suggestion', 'Batch drafts: 2 saved; next chapter 3', 'Original candidate · Chapter 2 北堤',
    ])
    expect(entries[1]).toMatchObject({ canContinue: false, conflictNote: 'Sources changed; the original suggestion can still be copied.' })
    expect(entries[2]).toMatchObject({ canContinue: false })
    expect(entries[3]).toMatchObject({ canContinue: false, staleNote: expect.stringContaining('source chapter changed') })
  })
})

describe('规划恢复稿', () => {
  it('分批生成的两份大纲恢复稿按各自的章节范围区分标题', () => {
    const outline = (runId: string, from: number, to: number) => ({ handle: { ...handle, runId }, plotOutlineRecovery: {}, plotOutline: { range: { from, to } } }) as never
    const entries = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [outline('第一批', 1, 10), outline('第二批', 11, 16)] }, 'zh-CN')
    expect(entries.map(entry => entry.title)).toEqual(['大纲恢复稿 · 第 1–10 章', '大纲恢复稿 · 第 11–16 章'])
    expect(buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [outline('第一批', 1, 10)] }, 'en-US')[0].title).toBe('Outline recovery draft · ch. 1–10')
  })

  it.each([
    ['1、5、2、3、4', [1, 5, 2, 3, 4], '这次生成开跑时，大纲的章节没有按章号顺序排列，不能接着生成，恢复稿也不能保存。可以复制已生成的章节，把大纲排好后重新生成。',
      'When this run started, the outline chapters were not in chapter order, so it cannot continue and the recovery draft cannot be saved. Copy the generated chapters, put the outline in order, then generate again.'],
    ['1、2、3、2', [1, 2, 3, 2], '这次生成开跑时，大纲里第 2 章出现了不止一次，不能接着生成，恢复稿也不能保存。可以复制已生成的章节，改好大纲后重新生成。',
      'When this run started, chapter 2 appeared more than once in the outline, so it cannot continue and the recovery draft cannot be saved. Copy the generated chapters, fix the outline, then generate again.'],
  ])('升级前以 %s 的大纲开跑的恢复稿：入口说明不能继续的原因，中英文各一句', (_case, order, zh, en) => {
    const synopsis = `# 情节大纲\n\n${order.map(n => `## 第${n}章：第${n}夜\n这一夜的事。`).join('\n\n')}`
    const recovery = { handle, plotOutline: { range: { from: 3, to: 5 }, sourceExpected: { synopsis } },
      plotOutlineRecovery: { writeState: { kind: 'blocked', reason: 'source-invalid' } } } as never
    expect(buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'zh-CN')[0]).toMatchObject({ kind: 'planning', note: zh })
    expect(buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'en-US')[0]).toMatchObject({ kind: 'planning', note: en })
  })

  it.each([
    ['大纲按序但缺第 2 章', { range: { from: 3, to: 5 }, sourceExpected: { synopsis: '# 情节大纲\n\n## 第1章：第1夜\n这一夜的事。\n\n## 第3章：第3夜\n这一夜的事。' } }],
    ['没有冻结的大纲', undefined],
  ])('来源无效但不是乱序或重复（%s）：入口说明不能继续、不能保存，不提本地保存或继续缺少的章节', (_case, plotOutline) => {
    const recovery = { handle, plotOutline, plotOutlineRecovery: { writeState: { kind: 'blocked', reason: 'source-invalid' } } } as never
    expect(buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'zh-CN')[0])
      .toMatchObject({ kind: 'planning', note: '这次生成开跑时，大纲的章节编号与所选范围对不上或缺少章节，不能接着生成，恢复稿也不能保存。可以复制已生成的章节，改好大纲后重新生成。' })
    expect(buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'en-US')[0])
      .toMatchObject({ kind: 'planning', note: 'When this run started, the outline chapter numbers did not line up with the selected range or a chapter was missing, so it cannot continue and the recovery draft cannot be saved. Copy the generated chapters, fix the outline, then generate again.' })
  })

  it('来源已变的大纲恢复稿：说明只能查看或复制、从本批起始章重新生成，不再说可编辑并本地保存', () => {
    const recovery = { handle, plotOutline: { range: { from: 6, to: 10 }, cursor: { kind: 'request', chapterNumber: 7, attempt: 'normal' } },
      plotOutlineRecovery: { writeState: { kind: 'blocked', reason: 'source-changed' } } } as never
    const zh = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'zh-CN')[0]
    const en = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'en-US')[0]
    expect(zh).toMatchObject({ kind: 'planning', actionLabel: '查看恢复稿' })
    expect(zh.kind === 'planning' && zh.note).toContain('只能查看或复制')
    expect(zh.kind === 'planning' && zh.note).toContain('从第 6 章重新生成')
    expect(zh.kind === 'planning' && zh.note).not.toContain('可编辑并本地保存')
    expect(en).toMatchObject({ kind: 'planning', actionLabel: 'View recovery draft' })
    expect(en.kind === 'planning' && en.note).toContain('from chapter 6')
    expect(en.kind === 'planning' && en.note).not.toMatch(/save it locally/i)
  })

  it('已写进正式大纲的一批在来源变了之后：只说明只能查看或复制，不叫作者从这批起始章重新生成', () => {
    const recovery = { handle, plotOutline: { range: { from: 1, to: 5 }, cursor: { kind: 'complete' } },
      plotOutlineRecovery: { writeState: { kind: 'blocked', reason: 'source-changed' }, inFormalOutline: true } } as never
    const entry = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'zh-CN')[0]
    expect(entry.kind === 'planning' && entry.note).toContain('只能查看或复制')
    expect(entry.kind === 'planning' && entry.note).not.toContain('重新生成')
  })

  it('最后一章生成完、正式保存被来源检查拒绝的一批：不说已经生成完毕，叫作者从本批起始章重新生成', () => {
    const recovery = { handle, plotOutline: { range: { from: 6, to: 6 }, cursor: { kind: 'complete' } },
      plotOutlineRecovery: { writeState: { kind: 'blocked', reason: 'source-changed' }, inFormalOutline: false } } as never
    const zh = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'zh-CN')[0]
    const en = buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'en-US')[0]
    expect(zh.kind === 'planning' && zh.note).not.toContain('已经生成完毕')
    expect(zh.kind === 'planning' && zh.note).toContain('从第 6 章重新生成')
    expect(en.kind === 'planning' && en.note).toContain('from chapter 6')
    expect(outlineSourceChangedNote(recovery, 'zh-CN')).toContain('从第 6 章重新生成')
  })

  it('只有一章的大纲恢复稿标题写「第 6 章」，不写成「第 6–6 章」', () => {
    const recovery = { handle, plotOutlineRecovery: {}, plotOutline: { range: { from: 6, to: 6 } } } as never
    expect(buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'zh-CN')[0].title).toBe('大纲恢复稿 · 第 6 章')
    expect(buildRecoveryEntries({ ...EMPTY_RECOVERY_SOURCES, planning: [recovery] }, 'en-US')[0].title).toBe('Outline recovery draft · ch. 6')
  })
})
