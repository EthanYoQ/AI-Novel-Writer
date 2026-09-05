import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()

vi.mock('../../ipc-client', () => ({ ipc: { invoke } }))
vi.mock('../../../stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: null }) },
}))

describe('writing skill registry identity and tool exposure', () => {
  beforeEach(() => invoke.mockReset())

  it('uses the shared frontmatter parser so quoted names produce bindable ids without quotes', async () => {
    invoke.mockResolvedValue([{
      name: 'quoted-skill',
      baseDir: 'managed://skills/quoted-skill',
      filePath: 'managed://skills/quoted-skill/SKILL.md',
      content: '---\nname: "quoted-skill"\ndescription: "Quoted metadata"\nstage: "drafting"\n---\nUse concrete action.',
    }])

    const { skillRegistry } = await import('../skill-registry')
    await skillRegistry.loadAll()

    expect(skillRegistry.getById('user:quoted-skill')).toMatchObject({
      metadata: { name: 'quoted-skill', description: 'Quoted metadata' },
    })
    expect(skillRegistry.getById('user:"quoted-skill"')).toBeUndefined()
  })

  it('serializes atomic reloads without exposing a cleared or partial registry', async () => {
    const deferred = <T,>() => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>(next => { resolve = next })
      return { promise, resolve }
    }
    const firstUserRead = deferred<unknown[]>()
    const secondUserRead = deferred<unknown[]>()
    const { parseSkillMd, skillRegistry } = await import('../skill-registry')
    const previous = parseSkillMd(
      '---\nname: previous-user-skill\ndescription: Previous\nstage: drafting\n---\nKeep prior content.',
      'previous-user-skill',
      'user',
      'managed://skills/previous-user-skill',
      'managed://skills/previous-user-skill/SKILL.md',
    )!
    skillRegistry.clear()
    skillRegistry.register(previous)
    invoke
      .mockReturnValueOnce(firstUserRead.promise)
      .mockReturnValueOnce(secondUserRead.promise)

    const firstLoad = skillRegistry.loadAll()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    const secondLoad = skillRegistry.loadAll()

    expect(invoke).toHaveBeenCalledOnce()
    expect(skillRegistry.getById('user:previous-user-skill')).toBe(previous)

    firstUserRead.resolve([])
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    secondUserRead.resolve([])
    await Promise.all([firstLoad, secondLoad])
    expect(skillRegistry.getById('builtin:long-form-continuity')).toBeDefined()
  })

  it('keeps same-named skills by stable id and does not expose external skills as legacy tools', async () => {
    invoke.mockResolvedValue([
      {
        name: 'writing-coach',
        baseDir: 'managed://skills/writing-coach',
        filePath: 'managed://skills/writing-coach/SKILL.md',
        content: '---\nname: writing-coach\ndescription: User writing coach\nstage: refinement\n---\nUse concrete prose.',
      },
      {
        name: 'scene-craft',
        baseDir: 'managed://skills/scene-craft',
        filePath: 'managed://skills/scene-craft/SKILL.md',
        content: '---\nname: scene-craft\ndescription: Scene craft\nstage: drafting\n---\nUse concrete action.',
      },
    ])

    const { skillRegistry } = await import('../skill-registry')
    const { toolRegistry } = await import('../tool-registry')
    await skillRegistry.loadAll()

    expect(skillRegistry.getById('builtin:writing-coach')?.source).toBe('builtin')
    expect(skillRegistry.getById('user:writing-coach')?.source).toBe('user')
    expect(skillRegistry.get('writing-coach')?.source).toBe('builtin')
    expect(toolRegistry.get('skill__scene-craft')).toBeUndefined()
  })

  it('keeps every real built-in Skill in the English tool catalog and execution without Chinese copy', async () => {
    invoke.mockResolvedValue([])
    const { skillRegistry } = await import('../skill-registry')
    const { toolRegistry } = await import('../tool-registry')
    await skillRegistry.loadAll()

    const builtins = skillRegistry.listBySource('builtin')
    const prompt = toolRegistry.generateToolPrompt('en-US', tool => tool.source === 'skill')

    expect(builtins.length).toBeGreaterThan(2)
    expect(prompt).toContain('Reviews a chapter for plot logic')
    for (const skill of builtins) {
      const tool = toolRegistry.get(`skill__${skill.metadata.name}`)
      expect(prompt).toContain(`skill__${skill.metadata.name}`)
      expect(tool, skill.metadata.name).toBeDefined()
      const result = await tool!.execute({ args: 'Chapter 1' }, {
        projectSession: null,
        selectedModelId: 'model-a',
        uiLocale: 'zh-CN',
        writingLanguage: 'en-US',
      })
      expect(`${result.content}\n${result.error ?? ''}`, skill.metadata.name)
        .not.toMatch(/[\u3400-\u9fff]/u)
    }
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/u)
  })

})
