import { describe, expect, it } from 'vitest'
import { readNovelContext } from '../src/context-window.ts'
import { openNovelProject } from '../src/novel-project.ts'
import { makeTestWorkspace, TEST_INITIALIZATION_IDENTITY } from './test-workspace.ts'

const signal = new AbortController().signal

async function createReadyProject(root: string): Promise<void> {
  const project = openNovelProject(root)
  await project.apply({
    ...TEST_INITIALIZATION_IDENTITY,
    kind: 'initialize', title: '潮汐来信', language: 'zh-CN', genre: '悬疑',
    plannedChapters: 3, targetWordsPerChapter: 2_000, creativeStrategy: 'consistency-first',
  }, signal)
  await project.apply({
    kind: 'replace', target: { kind: 'characters' }, baseRevision: 'absent', baseText: '',
    replacement: JSON.stringify({ characters: [{
      id: 'lin-xia', name: '林夏', role: '灯塔管理员', summary: '守护退潮后的信匣。',
      goal: '找到失踪的弟弟', relationships: [], notes: '',
    }] }), summary: '建立人物表',
  }, signal)
  await project.apply({
    kind: 'replace', target: { kind: 'story-blueprint' }, baseRevision: 'absent', baseText: '',
    replacement: JSON.stringify({
      premise: '退潮后出现来自明日的信。', themes: ['选择'], world: '海岛灯塔',
      mainPlot: '林夏追查信件来源。', endingGoal: '决定是否改变弟弟的命运。',
    }), summary: '建立故事蓝图',
  }, signal)
  await project.apply({
    kind: 'replace', target: { kind: 'chapter-blueprint', chapter: 1 }, baseRevision: 'absent', baseText: '',
    replacement: JSON.stringify({
      chapter: 1, title: '退潮', purpose: '发现第一封未来信', beats: ['灯灭', '取信'],
      characterIds: ['lin-xia'], continuityNotes: ['午夜退潮'], status: 'drafted',
    }), summary: '建立章节蓝图',
  }, signal)
  await project.apply({
    kind: 'replace', target: { kind: 'chapter-draft', chapter: 1 }, baseRevision: 'absent', baseText: '',
    replacement: '# 退潮\n\n林夏在熄灭的灯塔下拾起未来的信。\n', summary: '写入章节正文',
  }, signal)
}

describe('read-only novel context projection', () => {
  it('returns an explicit not-initialized state without creating project files', async () => {
    const root = await makeTestWorkspace('context-empty-')

    await expect(readNovelContext(root, 1, signal)).resolves.toEqual({ status: 'not-initialized' })
  })

  it('projects project identity, strategy, chapter progress, plans, characters, and prose preview', async () => {
    const root = await makeTestWorkspace('context-ready-')
    await createReadyProject(root)

    const result = await readNovelContext(root, 1, signal)

    expect(result).toMatchObject({
      status: 'ready',
      project: {
        projectId: TEST_INITIALIZATION_IDENTITY.projectId,
        title: '潮汐来信',
        language: 'zh-CN',
        genre: '悬疑',
        plannedChapters: 3,
        targetWordsPerChapter: 2_000,
        creativeStrategy: 'consistency-first',
      },
      progress: {
        selectedChapter: 1,
        plannedChapters: 3,
        status: 'drafted',
        draftPresent: true,
      },
      characters: [{ id: 'lin-xia', name: '林夏', role: '灯塔管理员', summary: '守护退潮后的信匣。' }],
      storyBlueprint: { premise: '退潮后出现来自明日的信。' },
      chapterBlueprint: { chapter: 1, title: '退潮', status: 'drafted' },
      draft: { preview: '# 退潮\n\n林夏在熄灭的灯塔下拾起未来的信。\n', truncated: false },
      omittedSources: [],
    })
    expect(result).not.toHaveProperty('path')
  })

  it('rejects chapter selection beyond the project plan', async () => {
    const root = await makeTestWorkspace('context-chapter-range-')
    await createReadyProject(root)

    await expect(readNovelContext(root, 4, signal)).rejects.toMatchObject({ code: 'INVALID_CONTENT' })
  })
})
