import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invokeWithProjectSession: vi.fn(),
  invoke: vi.fn(),
  resolvePromptTemplate: vi.fn(),
  loadDirectoryBlueprints: vi.fn(),
}))

vi.mock('../../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: (...args: unknown[]) => mocks.invokeWithProjectSession(...args),
    invoke: (...args: unknown[]) => mocks.invoke(...args),
  },
}))

/*
  只替掉「模板解析入口」，其余保留真实实现：
  getBuiltinPromptTemplate / composePromptSystemRole / pruneEmptyOptionalPromptSections
  都是真实逻辑 —— 这样断言到的审查原则、检查维度、输出格式段就是**软件真正会发出去**的那些，
  而不是测试自己编的一份。
*/
vi.mock('../../prompt-templates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../prompt-templates')>()
  return {
    ...actual,
    resolvePromptTemplate: (...args: unknown[]) => mocks.resolvePromptTemplate(...args),
  }
})

vi.mock('../../workflows/directory-workflow', () => ({
  loadDirectoryBlueprints: (...args: unknown[]) => mocks.loadDirectoryBlueprints(...args),
}))

import { buildChapterReviewPrompt } from '../chapter-review-prompt'
import { getBuiltinPromptTemplate } from '../../prompt-templates'
import { EXTERNAL_AI_AUDIT_FULL_SELECTION } from '../../../shared/external-ai-audit'

const PROJECT_SESSION = { projectId: '7', leaseId: 'lease-1', projectPath: 'C:/novels/wugang' }
const DRAFT = '雾从港口漫上来，灯塔的光在水面上碎成一片。'

function buildInput(overrides: Record<string, unknown> = {}) {
  return {
    projectSession: PROJECT_SESSION,
    projectPath: PROJECT_SESSION.projectPath,
    chapterNumber: 3,
    draftContent: DRAFT,
    reviewFocus: '剧情连贯性、角色状态',
    novelConfig: { genre: '悬疑', globalGuidance: '保持冷硬的叙事节奏。' },
    writingLanguage: 'zh-CN' as const,
    ...overrides,
  }
}

describe('buildChapterReviewPrompt', () => {
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
          currentState: {
            location: '雾港码头',
            provenance: { location: { kind: 'author', chapterNumber: 2 } },
          },
        }])
      }
      if (channel === 'db:project-core-get') {
        return Promise.resolve({ worldbuilding: '世界由浮岛构成，靠核心维持重力。' })
      }
      return Promise.resolve(undefined)
    })

    mocks.invoke.mockImplementation((channel: string) => {
      if (channel === 'world-setting:list-chapter-refs') return Promise.resolve([{ settingId: 11 }])
      if (channel === 'world-setting:list') {
        return Promise.resolve([{
          id: 11,
          name: '浮岛重力',
          content: '浮岛靠核心维持重力，核心熄灭则坠落。',
          status: 'confirmed',
        }])
      }
      return Promise.resolve([])
    })

    /*
      用**真实的内置审稿模板**（作者没自定义时 resolvePromptTemplate 拿到的就是它），
      这样断言到的审查原则、检查维度、JSON 输出合同都是软件真正会发出去的那份文本。
    */
    mocks.resolvePromptTemplate.mockImplementation(
      (key: string) => Promise.resolve(getBuiltinPromptTemplate(key as never, 'zh-CN')),
    )
    mocks.loadDirectoryBlueprints.mockResolvedValue([{
      chapterNumber: 3,
      title: '雾港的灯',
      role: '推进',
      purpose: '揭露灯塔的秘密',
      // keyEvents 在真实数据里是**字符串**（换行或分号分隔），不是数组 ——
      // freezeChapterGoals 直接对它 split，给数组会当场抛错。
      keyEvents: '主角发现灯塔熄灭\n灯塔看守人失踪',
      characters: ['林砚'],
      suspenseHook: '灯塔为何熄灭',
      userGuidance: '',
    }])
  })

  it('carries every material the built-in review sends to its model', async () => {
    const { prompt } = await buildChapterReviewPrompt(buildInput())

    expect(mocks.loadDirectoryBlueprints).toHaveBeenCalled()
    expect(mocks.invokeWithProjectSession).toHaveBeenCalledWith(
      PROJECT_SESSION, 'db:continuity-list-before', 3, PROJECT_SESSION.projectPath,
    )

    // 本章正文
    expect(prompt).toContain(DRAFT)
    // 已定稿连续性事实：模型唯一的「已经发生过什么」来源
    expect(prompt).toContain('已确认定稿历史')
    expect(prompt).toContain('主角登船')
    // 角色状态
    expect(prompt).toContain('林砚')
    expect(prompt).toContain('雾港码头')
    // 世界观总纲
    expect(prompt).toContain('世界由浮岛构成，靠核心维持重力。')
    // 本章引用的世界观条目
    expect(prompt).toContain('浮岛重力')
    // 作者全局创作指导与项目配置
    expect(prompt).toContain('保持冷硬的叙事节奏。')
    expect(prompt).toContain('悬疑')
    // 当前及未来蓝图
    expect(prompt).toContain('主角发现灯塔熄灭')
    // 本章目标清单（冻结后逐项核对）也要进提示词
    expect(prompt).toContain('本章目标逐项核对')
    // 与内置模板一致的审查原则与检查维度（来自真实内置模板，不是测试自编）
    expect(prompt).toContain('举证审查')
    expect(prompt).toContain('剧情连贯性')
  })

  it('reports the size of each material block', async () => {
    const result = await buildChapterReviewPrompt(buildInput())

    const labels = result.sectionSizes.map(section => section.label)
    expect(labels).toEqual(expect.arrayContaining([
      '本章正文', '已定稿剧情事实', '角色状态', '世界观总纲', '本章引用设定', '蓝图与计划', '本章目标清单',
    ]))
    expect(result.sectionSizes.find(section => section.label === '本章正文')?.characters).toBe(DRAFT.length)
    // 逐块存档：每块都带着自己的内容与文件名，外部审计据此写 .md
    const chapterBlock = result.materialBlocks.find(block => block.key === 'chapterContent')
    expect(chapterBlock?.text).toBe(DRAFT)
    expect(chapterBlock?.fileName).toContain('本章正文')
  })

  it('drops the blocks the author unticked', async () => {
    const result = await buildChapterReviewPrompt(buildInput({
      sections: {
        ...EXTERNAL_AI_AUDIT_FULL_SELECTION,
        worldBuilding: false,
        projectConfig: false,
        blueprints: false,
      },
    }))

    // 取消的块不该出现在提示词里，也不该出现在逐块存档里
    expect(result.prompt).not.toContain('世界由浮岛构成，靠核心维持重力。')
    expect(result.prompt).not.toContain('"genre"')
    expect(result.prompt).not.toContain('【当前及未来蓝图/计划')
    expect(result.materialBlocks.map(block => block.key)).not.toContain('worldBuilding')
    expect(result.materialBlocks.map(block => block.key)).not.toContain('blueprints')
    // 没被取消的照旧在场
    expect(result.prompt).toContain('主角登船')
    expect(result.prompt).toContain(DRAFT)
  })

  it('leaves a file reference instead of the content when delivering as files', async () => {
    const result = await buildChapterReviewPrompt(buildInput({ materialDelivery: 'file-reference' }))

    expect(result.prompt).toContain('见随附文件')
    // 内容本身不进提示词（它们各自成文件），但仍留在逐块存档里
    expect(result.prompt).not.toContain(DRAFT)
    expect(result.materialBlocks.find(block => block.key === 'chapterContent')?.text).toBe(DRAFT)
  })

  it('injects the writing skill at the very top when one is given', async () => {
    const { prompt, writingSkillName, sectionSizes } = await buildChapterReviewPrompt(buildInput({
      writingSkill: { name: '连贯性审稿', content: '重点检查伏笔回收与角色状态漂移。' },
    }))

    expect(writingSkillName).toBe('连贯性审稿')
    expect(prompt.startsWith('【补充写作 Skill：连贯性审稿】')).toBe(true)
    expect(prompt).toContain('重点检查伏笔回收与角色状态漂移。')
    // Skill 段也要进材料清单，作者才知道这次带了它
    expect(sectionSizes.some(section => section.label === '写作 Skill')).toBe(true)
  })

  it('leaves the writing skill out when none is bound', async () => {
    const { prompt, writingSkillName, sectionSizes } = await buildChapterReviewPrompt(buildInput())

    expect(writingSkillName).toBeNull()
    expect(prompt).not.toContain('【补充写作 Skill')
    expect(sectionSizes.some(section => section.label === '写作 Skill')).toBe(false)
  })

  it('adds a Markdown output override for web chat but not for the built-in JSON contract', async () => {
    const forWebChat = await buildChapterReviewPrompt(buildInput({ outputFormat: 'markdown' }))
    const forApi = await buildChapterReviewPrompt(buildInput({ outputFormat: 'json' }))

    expect(forWebChat.prompt).toContain('本次输出格式｜请覆盖上文关于 JSON 的要求')
    expect(forWebChat.prompt).toContain('不要输出 JSON')
    expect(forApi.prompt).not.toContain('请覆盖上文关于 JSON 的要求')
  })

  it('degrades gracefully when a material cannot be read', async () => {
    /*
      只让「有容错的两块」失败：角色状态与蓝图。
      世界观（project-core）在内置审稿里**本来就是硬依赖**，读不到就整体失败 ——
      那是既有行为，这次重构一字未改，所以不在这里断言它。
    */
    mocks.invokeWithProjectSession.mockImplementation((_session, channel: string) => {
      if (channel === 'db:character-get-all') return Promise.reject(new Error('character store unavailable'))
      if (channel === 'db:continuity-list-before') return Promise.resolve([])
      if (channel === 'db:project-core-get') return Promise.resolve({ worldbuilding: '世界由浮岛构成。' })
      return Promise.resolve(undefined)
    })
    mocks.loadDirectoryBlueprints.mockRejectedValue(new Error('blueprint store unavailable'))

    // 某一块读不到不该让整次审稿装配失败 —— 与内置审稿的容错口径一致
    const { prompt } = await buildChapterReviewPrompt(buildInput())

    expect(prompt).toContain(DRAFT)
    expect(prompt).toContain('（读取失败）')
    expect(prompt).toContain('（蓝图读取暂时不可用）')
  })

  it('refuses to assemble without a draft', async () => {
    await expect(buildChapterReviewPrompt(buildInput({ draftContent: '' })))
      .rejects.toThrow(/无草稿内容/)
  })

  it('surfaces a missing review template instead of sending a half prompt', async () => {
    mocks.resolvePromptTemplate.mockResolvedValue(null)

    await expect(buildChapterReviewPrompt(buildInput())).rejects.toThrow(/未找到审稿模板/)
  })
})
