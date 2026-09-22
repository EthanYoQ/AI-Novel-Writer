import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invokeWithProjectSession: vi.fn(),
  invoke: vi.fn(),
  resolvePromptTemplate: vi.fn(),
}))

vi.mock('../../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: (...args: unknown[]) => mocks.invokeWithProjectSession(...args),
    invoke: (...args: unknown[]) => mocks.invoke(...args),
  },
}))

// 只替掉模板解析入口，其余走真实实现 —— 断言到的六条精修要求与输出合同
// 就是软件真正会发出去的那份文本。
vi.mock('../../prompt-templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../prompt-templates')>()
  return {
    ...actual,
    resolvePromptTemplate: (...args: unknown[]) => mocks.resolvePromptTemplate(...args),
  }
})

import { buildChapterRefinePrompt } from '../chapter-refine-prompt'
import { getBuiltinPromptTemplate } from '../../prompt-templates'
import { EXTERNAL_AI_FULL_SELECTION } from '../../../shared/external-ai-audit'

const PROJECT_SESSION = { projectId: '7', leaseId: 'lease-1', projectPath: 'C:/novels/wugang' }
const DRAFT = '雾从港口漫上来，灯塔的光在水面上碎成一片。'

function input(overrides: Record<string, unknown> = {}) {
  return {
    projectSession: PROJECT_SESSION,
    projectPath: PROJECT_SESSION.projectPath,
    chapterNumber: 3,
    chapterTitle: '雾港的灯',
    draftContent: DRAFT,
    userRefinePrompt: '把结尾的悬念再压低一点。',
    novelConfig: { wordsPerChapter: 3200, writingStyle: '冷硬、克制', globalGuidance: '保持紧张感。' },
    writingLanguage: 'zh-CN' as const,
    ...overrides,
  }
}

describe('buildChapterRefinePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invokeWithProjectSession.mockImplementation((_session, channel: string) => {
      if (channel === 'db:continuity-list-before') {
        return Promise.resolve([{
          chapterNumber: 1,
          chapterTitle: '出发',
          chapterNotes: '雾港启程。',
          facts: [{ category: '情节', statement: '主角登船', sourceChapter: 1, evidence: '他踏上甲板。' }],
        }])
      }
      if (channel === 'db:character-get-all') {
        return Promise.resolve([{
          name: '林砚',
          role: '主角',
          currentState: { location: '雾港码头', provenance: { location: { kind: 'author', chapterNumber: 2 } } },
        }])
      }
      return Promise.resolve(undefined)
    })
    mocks.invoke.mockResolvedValue([])
    mocks.resolvePromptTemplate.mockImplementation(
      (key: string) => Promise.resolve(getBuiltinPromptTemplate(key as never, 'zh-CN')),
    )
  })

  it('carries the material the built-in revision uses, plus the context it lacks', async () => {
    const { prompt } = await buildChapterReviewRefinePrompt()

    // 与内置直接修稿同源的那几样
    expect(prompt).toContain(DRAFT)
    expect(prompt).toContain('"chapterNumber": 3')
    expect(prompt).toContain('保持紧张感。')
    expect(prompt).toContain('冷硬、克制')
    expect(prompt).toContain('3200')
    expect(prompt).toContain('把结尾的悬念再压低一点。')
    // 模板自带的六条精修要求与输出合同（真实内置模板）
    expect(prompt).toContain('画面感')
    expect(prompt).toContain('禁止使用任何 Markdown 语法符号')
    // 内置直接修稿在这两处其实是空的 —— 外部路线把它们补上
    expect(prompt).toContain('主角登船')
    expect(prompt).toContain('林砚')
  })

  it('asks for the revised chapter inside a code block when delivering in a web chat', async () => {
    const { prompt } = await buildChapterRefinePrompt(input({ outputFormat: 'markdown' }))

    expect(prompt).toContain('放进一个 Markdown 代码块')
    expect(prompt).toContain('代码块之外不要写任何说明')
  })

  it('keeps the built-in contract when the format is left plain', async () => {
    const { prompt } = await buildChapterRefinePrompt(input())

    expect(prompt).not.toContain('放进一个 Markdown 代码块')
  })

  it('injects the refinement skill at the very top', async () => {
    const { prompt, writingSkillName } = await buildChapterRefinePrompt(input({
      writingSkill: { name: '自然文笔精修', content: '只改表达，不动情节与事实。' },
    }))

    expect(writingSkillName).toBe('自然文笔精修')
    expect(prompt.startsWith('【补充写作 Skill：自然文笔精修】')).toBe(true)
  })

  it('drops the blocks the author unticked', async () => {
    const { prompt, materialBlocks } = await buildChapterRefinePrompt(input({
      sections: { ...EXTERNAL_AI_FULL_SELECTION, finalizedHistory: false, characterStates: false },
    }))

    expect(prompt).not.toContain('主角登船')
    expect(prompt).not.toContain('林砚')
    expect(materialBlocks.map(block => block.key)).not.toContain('finalizedHistory')
    // 没被取消的照旧在场
    expect(prompt).toContain(DRAFT)
  })

  it('leaves a file reference when delivering as files', async () => {
    const { prompt, materialBlocks } = await buildChapterRefinePrompt(input({ materialDelivery: 'file-reference' }))

    expect(prompt).toContain('见随附文件')
    expect(prompt).not.toContain(DRAFT)
    expect(materialBlocks.find(block => block.key === 'chapterContent')?.text).toBe(DRAFT)
  })

  it('refuses to assemble without a draft', async () => {
    await expect(buildChapterRefinePrompt(input({ draftContent: '' }))).rejects.toThrow(/无草稿内容/)
  })

  it('surfaces a missing revision template', async () => {
    mocks.resolvePromptTemplate.mockResolvedValue(null)

    await expect(buildChapterRefinePrompt(input())).rejects.toThrow(/未找到修稿模板/)
  })
})

/** 小包装：让每条断言都读起来像在说业务，而不是一堆参数。 */
async function buildChapterReviewRefinePrompt() {
  return buildChapterRefinePrompt(input({ outputFormat: 'markdown' }))
}
