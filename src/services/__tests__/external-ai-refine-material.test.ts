import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  freezeWritingSkillsSnapshot: vi.fn(),
  buildChapterRefinePrompt: vi.fn(),
}))

vi.mock('../agent/writing-skill-bindings', () => ({
  freezeWritingSkillsSnapshot: (...args: unknown[]) => mocks.freezeWritingSkillsSnapshot(...args),
}))

vi.mock('../prompts/chapter-refine-prompt', () => ({
  buildChapterRefinePrompt: (...args: unknown[]) => mocks.buildChapterRefinePrompt(...args),
}))

import { buildExternalAiRefineMaterial, loadRefineWritingSkill } from '../external-ai-refine-material'

const PROJECT_SESSION = { projectId: '7', leaseId: 'lease-1', projectPath: 'C:/novels/wugang' }
const ASSEMBLED_PROMPT = '请对章节草稿进行【精修与细节填充】。'

function input(overrides: Record<string, unknown> = {}) {
  return {
    projectSession: PROJECT_SESSION,
    projectPath: PROJECT_SESSION.projectPath,
    chapterNumber: 3,
    chapterTitle: '雾港的灯',
    draftContent: '雾从港口漫上来。',
    novelConfig: { wordsPerChapter: 3200 },
    writingLanguage: 'zh-CN' as const,
    locale: 'zh-CN' as const,
    ...overrides,
  }
}

describe('loadRefineWritingSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('takes the skill bound to the refinement stage', async () => {
    mocks.freezeWritingSkillsSnapshot.mockResolvedValue({
      // 审稿阶段绑的是别的 skill —— 修稿必须取 refinement 那一份
      review: { name: '连贯性审稿', content: '检查伏笔。' },
      refinement: { name: '自然文笔精修', content: '只改表达。' },
    })

    await expect(loadRefineWritingSkill(PROJECT_SESSION, 'zh-CN'))
      .resolves.toEqual({ name: '自然文笔精修', content: '只改表达。' })
  })

  it('returns null when nothing is bound to refinement', async () => {
    mocks.freezeWritingSkillsSnapshot.mockResolvedValue({ review: { name: 'X', content: 'Y' } })

    await expect(loadRefineWritingSkill(PROJECT_SESSION, 'zh-CN')).resolves.toBeNull()
  })

  it('treats a broken binding as "no skill"', async () => {
    mocks.freezeWritingSkillsSnapshot.mockRejectedValue(new Error('binding file is invalid'))

    await expect(loadRefineWritingSkill(PROJECT_SESSION, 'zh-CN')).resolves.toBeNull()
  })
})

describe('buildExternalAiRefineMaterial', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.freezeWritingSkillsSnapshot.mockResolvedValue({
      refinement: { name: '自然文笔精修', content: '只改表达，不动事实。' },
    })
    mocks.buildChapterRefinePrompt.mockResolvedValue({
      prompt: ASSEMBLED_PROMPT,
      systemRole: '你是一位经验丰富的小说编辑。',
      writingSkillName: '自然文笔精修',
      sectionSizes: [{ label: '本章正文', characters: 9 }],
      materialBlocks: [{
        key: 'chapterContent',
        label: '本章正文',
        fileName: '02-本章正文',
        text: '雾从港口漫上来。',
        characters: 9,
      }],
    })
  })

  it('asks for a web-chat delivery and hands the refinement skill to the assembly', async () => {
    await buildExternalAiRefineMaterial(input())

    expect(mocks.buildChapterRefinePrompt).toHaveBeenCalledWith(expect.objectContaining({
      outputFormat: 'markdown',
      materialDelivery: 'inline',
      writingSkill: { name: '自然文笔精修', content: '只改表达，不动事实。' },
    }))
  })

  it('wraps the prompt with a revision header', async () => {
    const material = await buildExternalAiRefineMaterial(input())

    expect(material.delivery).toBe('inline')
    expect(material.text).toContain('【请修稿：雾港的灯】')
    expect(material.text).toContain('与软件内置修稿用的是同一份材料')
    expect(material.text.endsWith(ASSEMBLED_PROMPT)).toBe(true)
    expect(material.writingSkillName).toBe('自然文笔精修')
  })

  it('produces one .md per block when delivering as files', async () => {
    const material = await buildExternalAiRefineMaterial(input({ delivery: 'files' }))

    expect(material.text).toBe('')
    expect(material.files.map(file => file.name)).toEqual(['00-修稿要求.md', '02-本章正文.md'])
    expect(material.files[0]?.content).toContain('# 修稿要求')
    expect(mocks.buildChapterRefinePrompt).toHaveBeenCalledWith(expect.objectContaining({
      materialDelivery: 'file-reference',
    }))
  })
})
