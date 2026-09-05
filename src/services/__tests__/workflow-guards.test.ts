import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useLocaleStore } from '../../stores/locale-store'
import {
  guardArchitectureGeneration,
  guardChapterWriting,
  guardCharacterRegeneration,
  guardDirectoryGeneration,
} from '../workflow-guards'
import { ipc } from '../ipc-client'

vi.mock('../ipc-client', () => ({
  ipc: {
    invokeWithProjectSession: vi.fn(),
  },
}))

const projectPath = 'C:/novels/guard-directory'
const projectSession: ProjectSessionContext = {
  projectId: 'guard-directory',
  leaseId: 'lease-guard-directory',
  projectPath,
}
const project = {
  id: projectSession.projectId,
  sessionLease: projectSession.leaseId,
  path: projectPath,
  name: 'Guard Directory',
  novelConfig: {},
}
let currentProject: typeof project | null = project

vi.mock('../../stores/project-store', () => ({
  useProjectStore: {
    getState: vi.fn(() => ({ currentProject })),
  },
}))

afterEach(() => {
  currentProject = project
  project.novelConfig = {}
  useLocaleStore.setState({ locale: 'zh-CN' })
})

describe('architecture workflow guard locale', () => {
  it('returns a missing-project guard in English', () => {
    currentProject = null
    useLocaleStore.setState({ locale: 'en-US' })

    const result = guardArchitectureGeneration(projectPath, projectSession)

    expect(result).toMatchObject({ ok: false, message: 'Open or create a project first.' })
  })

  it('returns a missing-config guard in English', () => {
    useLocaleStore.setState({ locale: 'en-US' })

    const result = guardArchitectureGeneration(projectPath, projectSession)

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('Fill in the core outline or protagonist profile'),
    })
    expect(result.message).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})

describe('directory workflow guard', () => {
  beforeEach(() => {
    vi.mocked(ipc.invokeWithProjectSession).mockReset()
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (
      _session: ProjectSessionContext,
      channel: string,
    ) => {
      if (channel === 'db:project-core-get') {
        return {
          premise: 'p'.repeat(60),
          charactersArch: '',
          worldbuilding: 'w'.repeat(60),
          synopsis: 's'.repeat(60),
        }
      }
      if (channel === 'db:character-get-all') return []
      throw new Error(`Unexpected channel: ${channel}`)
    }) as never)
  })

  it('hard-blocks an empty character roster before optional architecture warnings', async () => {
    await expect(guardDirectoryGeneration(projectPath, projectSession)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('角色卡不存在'),
    })
    expect(vi.mocked(ipc.invokeWithProjectSession).mock.calls.map(([, channel]) => channel))
      .toEqual(['db:project-core-get', 'db:character-get-all'])
  })

  it.each([
    {
      label: 'story premise',
      core: null,
      expected: 'The story premise has not been generated',
    },
    {
      label: 'character roster',
      core: {
        premise: 'p'.repeat(60),
        charactersArch: '',
        worldbuilding: 'w'.repeat(60),
        synopsis: 's'.repeat(60),
      },
      expected: 'No character cards exist',
    },
  ])('returns a missing-$label guard in English', async ({ core, expected }) => {
    useLocaleStore.setState({ locale: 'en-US' })
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (
      _session: ProjectSessionContext,
      channel: string,
    ) => {
      if (channel === 'db:project-core-get') return core
      if (channel === 'db:character-get-all') return []
      throw new Error(`Unexpected channel: ${channel}`)
    }) as never)

    const result = await guardDirectoryGeneration(projectPath, projectSession)

    expect(result).toMatchObject({ ok: false, message: expect.stringContaining(expected) })
    expect(result.message).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})

describe('chapter workflow guard locale', () => {
  it('returns the missing-blueprint guard in the frozen English locale', async () => {
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([])
    useLocaleStore.setState({ locale: 'en-US' })

    await expect(guardChapterWriting(1, projectPath, projectSession)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('No chapter blueprints have been generated'),
    })
  })
})

describe('character regeneration guard locale', () => {
  it('returns both character-regeneration failures in English', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    currentProject = null
    await expect(guardCharacterRegeneration()).resolves.toMatchObject({
      ok: false,
      message: 'Open or create a project first.',
    })

    currentProject = project
    vi.mocked(ipc.invokeWithProjectSession).mockResolvedValueOnce([{ chapterNumber: 1 }])
    const blocked = await guardCharacterRegeneration(projectSession)

    expect(blocked).toMatchObject({
      ok: false,
      message: expect.stringContaining('Character cards cannot be regenerated while chapter blueprints exist'),
    })
    expect(blocked.message).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})
