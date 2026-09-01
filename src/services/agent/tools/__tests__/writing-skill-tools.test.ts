import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectSessionContext } from '../../../../shared/ipc-channels'
import { toolRegistry } from '../../tool-registry'

const invoke = vi.fn()
const saveWritingSkillBinding = vi.fn()

vi.mock('../../../ipc-client', () => ({ ipc: { invoke } }))
vi.mock('../../writing-skill-bindings', () => ({ saveWritingSkillBinding }))
vi.mock('../../../../stores/project-store', () => ({
  useProjectStore: { getState: () => ({
    currentProject: {
      id: 'project-1',
      path: 'C:/novels/project-1',
      sessionLease: 'lease-1',
    },
  }) },
}))

const projectSession: ProjectSessionContext = {
  projectId: 'project-1',
  projectPath: 'C:/novels/project-1',
  leaseId: 'lease-1',
}

describe('writing skill agent tools', () => {
  beforeEach(() => {
    invoke.mockReset()
    saveWritingSkillBinding.mockReset()
  })

  it('keeps GitHub inspection read-only and returns a candidate summary', async () => {
    invoke.mockResolvedValue({
      success: true,
      inspection: {
        sourceUrl: 'https://github.com/acme/skill',
        resolvedUrl: 'https://raw.githubusercontent.com/acme/skill/main/SKILL.md',
        metadata: { name: 'scene-craft', description: 'Scene craft', language: 'en-US' },
        compatible: true,
        reasons: [],
        suggestedStage: 'drafting',
        utf8Bytes: 120,
      },
    })
    const { inspectWritingSkillTool } = await import('../inspect-writing-skill.tool')
    expect(inspectWritingSkillTool.requiresConfirmation).toBe(false)
    await expect(inspectWritingSkillTool.execute({
      source_url: 'https://github.com/acme/skill',
    })).resolves.toMatchObject({ success: true, content: expect.stringContaining('scene-craft') })
    expect(invoke).toHaveBeenCalledWith('skills:inspect-github', 'https://github.com/acme/skill')
  })

  it('makes installation an explicit confirmation write and only accepts a source URL', async () => {
    invoke
      .mockResolvedValueOnce({ success: true, skill: { name: 'scene-craft', source: 'user' } })
      .mockResolvedValueOnce([])
    const { installWritingSkillTool } = await import('../install-writing-skill.tool')
    expect(installWritingSkillTool.requiresConfirmation).toBe(true)
    expect(installWritingSkillTool.inputSchema.properties).toEqual({
      source_url: expect.objectContaining({ type: 'string' }),
    })
    await expect(installWritingSkillTool.execute({
      source_url: 'https://github.com/acme/skill',
      content: 'forged prompt',
    })).resolves.toMatchObject({ success: true })
    expect(invoke).toHaveBeenNthCalledWith(1, 'skills:install-github', 'https://github.com/acme/skill')
  })

  it('binds a compatible installed skill to one confirmed project stage', async () => {
    const { skillRegistry } = await import('../../skill-registry')
    await skillRegistry.loadAll()
    const { bindWritingSkillTool } = await import('../bind-writing-skill.tool')
    expect(bindWritingSkillTool.requiresConfirmation).toBe(true)
    await expect(bindWritingSkillTool.execute({
      skill_id: 'builtin:natural-prose-refinement',
      stage: 'refinement',
    }, { projectSession, selectedModelId: null })).resolves.toMatchObject({ success: true })
    expect(saveWritingSkillBinding).toHaveBeenCalledWith(
      projectSession,
      'refinement',
      'builtin:natural-prose-refinement',
    )
  })

  it('keeps inspection-first and prompt-only safety semantics in the English catalog', async () => {
    const { inspectWritingSkillTool } = await import('../inspect-writing-skill.tool')
    const { installWritingSkillTool } = await import('../install-writing-skill.tool')
    const { bindWritingSkillTool } = await import('../bind-writing-skill.tool')
    toolRegistry.clear()
    toolRegistry.registerAll([inspectWritingSkillTool, installWritingSkillTool, bindWritingSkillTool])

    const prompt = toolRegistry.generateToolPrompt('en-US')
    expect(prompt).toContain('Inspect a public GitHub repository')
    expect(prompt).toContain('must be inspected before installation')
    expect(prompt).toContain('prompt-only')
    expect(prompt).toContain('never executes code')
    expect(prompt).toContain('A public GitHub repo, tree, blob, or raw SKILL.md HTTPS URL')
    expect(prompt).not.toMatch(/[\u3400-\u9fff]/)
  })
})
