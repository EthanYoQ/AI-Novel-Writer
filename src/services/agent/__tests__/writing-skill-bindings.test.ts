import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSessionContext } from '../../../shared/ipc-channels'

const invokeWithProjectSession = vi.fn()
const invoke = vi.fn()

vi.mock('../../ipc-client', () => ({
  ipc: { invoke, invokeWithProjectSession },
}))

vi.mock('../../../stores/project-store', () => ({
  useProjectStore: { getState: () => ({ currentProject: null }) },
}))

const session: ProjectSessionContext = {
  projectId: 'project-1',
  projectPath: 'C:/novels/project-1',
  leaseId: 'lease-1',
}

describe('writing skill project bindings', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue([])
    invokeWithProjectSession.mockReset()
  })

  it('treats an absent binding file as no bindings', async () => {
    invokeWithProjectSession.mockResolvedValue(false)

    const { loadWritingSkillBindings } = await import('../writing-skill-bindings')
    await expect(loadWritingSkillBindings(session)).resolves.toEqual({ version: 1, bindings: {} })
    expect(invokeWithProjectSession).toHaveBeenCalledOnce()
    expect(invokeWithProjectSession).toHaveBeenCalledWith(
      session,
      'fs:check-exists',
      'C:/novels/project-1/.vela/writing-skills.json',
      session.projectPath,
    )
  })

  it('rejects a binding file that exists but is malformed', async () => {
    invokeWithProjectSession
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({ success: true, content: '{broken' })

    const { loadWritingSkillBindings } = await import('../writing-skill-bindings')
    await expect(loadWritingSkillBindings(session)).rejects.toThrow(/binding/i)
  })

  it('rejects a frozen snapshot whose selected skill is missing', async () => {
    invokeWithProjectSession
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        success: true,
        content: JSON.stringify({ version: 1, bindings: { drafting: 'user:missing-skill' } }),
      })

    const { freezeWritingSkillsSnapshot } = await import('../writing-skill-bindings')
    await expect(freezeWritingSkillsSnapshot(session, 'en-US')).rejects.toThrow(/missing-skill/)
  })

  it('rejects a frozen snapshot whose selected skill is incompatible', async () => {
    invoke.mockResolvedValue([{
      name: 'unsafe-skill',
      baseDir: 'managed://skills/unsafe-skill',
      filePath: 'managed://skills/unsafe-skill/SKILL.md',
      content: '---\nname: unsafe-skill\ndescription: Unsafe\nstage: drafting\n---\nRun scripts/install.js before writing.',
    }])
    invokeWithProjectSession
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        success: true,
        content: JSON.stringify({ version: 1, bindings: { drafting: 'user:unsafe-skill' } }),
      })

    const { freezeWritingSkillsSnapshot } = await import('../writing-skill-bindings')
    await expect(freezeWritingSkillsSnapshot(session, 'en-US')).rejects.toThrow(/incompatible/i)
  })

  it('stores at most one skill id for each stage', async () => {
    invokeWithProjectSession
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce({ success: true })

    const { saveWritingSkillBinding } = await import('../writing-skill-bindings')
    await saveWritingSkillBinding(session, 'drafting', 'user:scene-craft')

    expect(invokeWithProjectSession).toHaveBeenLastCalledWith(
      session,
      'fs:write-file',
      'C:/novels/project-1/.vela/writing-skills.json',
      expect.stringContaining('"drafting": "user:scene-craft"'),
      session.projectPath,
    )
  })

  it('freezes the selected compatible skill content for one workflow start', async () => {
    invokeWithProjectSession.mockResolvedValue({
      success: true,
      content: JSON.stringify({ version: 1, bindings: { refinement: 'builtin:natural-prose-refinement' } }),
    })

    const { skillRegistry } = await import('../skill-registry')
    const { freezeWritingSkill } = await import('../writing-skill-bindings')
    await skillRegistry.loadAll()
    const frozen = await freezeWritingSkill(session, 'refinement', 'en-US')

    expect(frozen).toMatchObject({
      skillId: 'builtin:natural-prose-refinement',
      stage: 'refinement',
      source: 'builtin',
      writingLanguage: 'en-US',
    })
    expect(frozen?.content).toContain('Revise the prose')
    expect(Object.isFrozen(frozen)).toBe(true)
  })

  it('unbinds without affecting other stages', async () => {
    invokeWithProjectSession
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce({
        success: true,
        content: JSON.stringify({ version: 1, bindings: { planning: 'builtin:long-form-continuity', drafting: 'user:scene-craft' } }),
      })
      .mockResolvedValueOnce({ success: true })

    const { saveWritingSkillBinding } = await import('../writing-skill-bindings')
    await saveWritingSkillBinding(session, 'drafting', null)

    const serialized = invokeWithProjectSession.mock.calls.at(-1)?.[3] as string
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      bindings: { planning: 'builtin:long-form-continuity' },
    })
  })
})
