import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  freezeWritingSkillsSnapshot: vi.fn(),
  buildChapterReviewPrompt: vi.fn(),
}))

vi.mock('../agent/writing-skill-bindings', () => ({
  freezeWritingSkillsSnapshot: (...args: unknown[]) => mocks.freezeWritingSkillsSnapshot(...args),
}))

/*
  这一层只负责两件事：取「审稿」阶段绑定的写作 Skill、以及给装配好的提示词包抬头。
  提示词本身怎么拼由 chapter-review-prompt 的测试守，这里替身化它，
  断言的重点是「组件把哪份 Skill 交给了装配」。
*/
vi.mock('../prompts/chapter-review-prompt', () => ({
  buildChapterReviewPrompt: (...args: unknown[]) => mocks.buildChapterReviewPrompt(...args),
}))

import { buildExternalAiAuditReviewMaterial, loadReviewWritingSkill } from '../external-ai-audit-review'
import { EXTERNAL_AI_AUDIT_FULL_SELECTION } from '../../shared/external-ai-audit'

const PROJECT_SESSION = { projectId: '7', leaseId: 'lease-1', projectPath: 'C:/novels/wugang' }
const ASSEMBLED_PROMPT = '【待审章节】雾从港口漫上来。'

function input(overrides: Record<string, unknown> = {}) {
  return {
    projectSession: PROJECT_SESSION,
    projectPath: PROJECT_SESSION.projectPath,
    chapterNumber: 3,
    chapterTitle: '雾港的灯',
    draftContent: '雾从港口漫上来。',
    novelConfig: { genre: '悬疑' },
    writingLanguage: 'zh-CN' as const,
    locale: 'zh-CN' as const,
    ...overrides,
  }
}

describe('loadReviewWritingSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the skill bound to the review stage', async () => {
    mocks.freezeWritingSkillsSnapshot.mockResolvedValue({
      review: { name: '连贯性审稿', content: '重点检查伏笔回收。' },
      drafting: { name: '别的阶段', content: '不该被取到。' },
    })

    await expect(loadReviewWritingSkill(PROJECT_SESSION, 'zh-CN'))
      .resolves.toEqual({ name: '连贯性审稿', content: '重点检查伏笔回收。' })
  })

  it('returns null when nothing is bound to the review stage', async () => {
    mocks.freezeWritingSkillsSnapshot.mockResolvedValue({ drafting: { name: 'X', content: 'Y' } })

    await expect(loadReviewWritingSkill(PROJECT_SESSION, 'zh-CN')).resolves.toBeNull()
  })

  it('treats a broken binding as "no skill" instead of failing the whole audit', async () => {
    mocks.freezeWritingSkillsSnapshot.mockRejectedValue(new Error('binding target is missing'))

    await expect(loadReviewWritingSkill(PROJECT_SESSION, 'zh-CN')).resolves.toBeNull()
  })
})

describe('buildExternalAiAuditReviewMaterial', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.freezeWritingSkillsSnapshot.mockResolvedValue({
      review: { name: '连贯性审稿', content: '重点检查伏笔回收与角色状态漂移。' },
    })
    mocks.buildChapterReviewPrompt.mockResolvedValue({
      prompt: ASSEMBLED_PROMPT,
      systemRole: '你是一位严谨的小说审稿编辑。',
      writingSkillName: '连贯性审稿',
      sectionSizes: [{ label: '本章正文', characters: 9 }],
      materialBlocks: [{
        key: 'chapterContent',
        label: '本章正文',
        fileName: '02-本章正文',
        text: '雾从港口漫上来。',
        characters: 9,
      }],
      frozenGoals: { chapterNumber: 3, coverage: 'not_configured', items: [] },
      goalBatches: [],
      inlineGoalReview: true,
    })
  })

  it('hands the bound review skill to the assembly', async () => {
    await buildExternalAiAuditReviewMaterial(input())

    expect(mocks.buildChapterReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
      writingSkill: { name: '连贯性审稿', content: '重点检查伏笔回收与角色状态漂移。' },
      // 网页对话场景：不要 JSON 合同
      outputFormat: 'markdown',
      chapterNumber: 3,
      draftContent: '雾从港口漫上来。',
      reviewFocus: undefined,
    }))
  })

  it('passes an empty skill through when nothing is bound', async () => {
    mocks.freezeWritingSkillsSnapshot.mockResolvedValue({})

    await buildExternalAiAuditReviewMaterial(input())

    expect(mocks.buildChapterReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
      writingSkill: null,
    }))
  })

  it('wraps the assembled prompt with a chapter header and reports the skill', async () => {
    const material = await buildExternalAiAuditReviewMaterial(input())

    expect(material.text).toContain('【请审稿：雾港的灯】')
    expect(material.text).toContain('与软件内置审稿用的是同一份材料')
    expect(material.text.endsWith(ASSEMBLED_PROMPT)).toBe(true)
    expect(material.writingSkillName).toBe('连贯性审稿')
    expect(material.characters).toBe(material.text.length)
    expect(material.sectionSizes).toEqual([{ label: '本章正文', characters: 9 }])
  })

  it('keeps the review-focus the author ticked', async () => {
    await buildExternalAiAuditReviewMaterial(input({ reviewFocus: '剧情连贯性、角色状态' }))

    expect(mocks.buildChapterReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
      reviewFocus: '剧情连贯性、角色状态',
    }))
  })

  it('hands the material selection through to the assembly', async () => {
    const sections = {
      ...EXTERNAL_AI_AUDIT_FULL_SELECTION,
      blueprints: false,
      projectConfig: false,
    }

    await buildExternalAiAuditReviewMaterial(input({ sections }))

    expect(mocks.buildChapterReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
      sections,
      materialDelivery: 'inline',
    }))
  })

  it('produces one .md per block when delivering as files', async () => {
    const material = await buildExternalAiAuditReviewMaterial(input({ delivery: 'files' }))

    expect(material.delivery).toBe('files')
    // 文本投递的那一段在文件模式下不再需要
    expect(material.text).toBe('')
    expect(material.files.map(file => file.name)).toEqual(['00-审稿要求.md', '02-本章正文.md'])
    // 每个文件都自带标题，对方打开一眼知道是什么
    expect(material.files[0]?.content).toContain('# 审稿要求')
    expect(material.files[1]?.content).toContain('# 本章正文')
    expect(material.files[1]?.content).toContain('雾从港口漫上来。')
    expect(material.characters).toBe(
      material.files.reduce((total, file) => total + file.content.length, 0),
    )
  })

  it('asks the assembly for file references when the material is delivered as files', async () => {
    await buildExternalAiAuditReviewMaterial(input({ delivery: 'files' }))

    // 内容各成一份文件，提示词里就不该再重复一遍
    expect(mocks.buildChapterReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
      materialDelivery: 'file-reference',
    }))
  })
})
