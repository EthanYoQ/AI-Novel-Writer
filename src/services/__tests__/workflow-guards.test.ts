import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectSessionContext } from '../../shared/ipc-channels'
import { useLocaleStore } from '../../stores/locale-store'
import {
  guardArchitectureGeneration,
  guardChapterWriting,
  guardCharacterRegeneration,
  guardDirectoryGeneration,
  guardRepairPostProcess,
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

  it('lists missing sections in the language active after the character check returns', async () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    let finish!: (value: unknown) => void
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation(((_session: ProjectSessionContext, channel: string) => {
      if (channel === 'db:project-core-get') return Promise.resolve({ premise: 'p'.repeat(60), charactersArch: '', worldbuilding: '', synopsis: 's'.repeat(60) })
      if (channel === 'db:character-get-all') return new Promise(resolve => { finish = resolve })
      throw new Error(`Unexpected channel: ${channel}`)
    }) as never)

    const pending = guardDirectoryGeneration(projectPath, projectSession)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    useLocaleStore.setState({ locale: 'en-US' })
    finish([{ id: 1 }])
    const result = await pending

    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('Worldbuilding') })
    expect(result.message).not.toMatch(/\p{Script=Han}/u)
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

  it('reads the interface language when the blueprint check returns, not when it started', async () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    currentProject = project
    let finish!: (value: unknown) => void
    vi.mocked(ipc.invokeWithProjectSession).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
    const pending = guardCharacterRegeneration(projectSession)
    useLocaleStore.setState({ locale: 'en-US' })
    finish([{ chapterNumber: 1 }])

    await expect(pending).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Character cards cannot be regenerated while chapter blueprints exist'),
    })
  })
})

describe('repair post-processing guard', () => {
  type Step = { stepKey: string; ok: boolean }
  /** 最新定稿是第 3 章；第 2 章当前定稿的最新后处理跑批是 steps，null 表示从没跑过。 */
  function chapterTwoRun(steps: Step[] | null) {
    vi.mocked(ipc.invokeWithProjectSession).mockImplementation((async (_session: unknown, channel: unknown) => {
      switch (channel) {
        case 'db:draft-get-max-finalized-chapter': return 3
        case 'db:post-process-get-latest-run':
          return steps && { id: 'run-2', triggerSourceType: 'chapter_finalize', triggerSourceId: 'finalization:f2', sourceLabel: '', allCriticalPassed: true, createdAt: '', updatedAt: '' }
        case 'db:post-process-get-steps':
          return steps!.map(step => ({ ...step, label: step.stepKey, critical: false, errorMsg: step.ok ? '' : 'FINALIZATION_GENERATION_INCOMPLETE', lastAttemptAt: '', attemptCount: 1 }))
        default: throw new Error(`unexpected IPC: ${String(channel)}`)
      }
    }) as never)
  }
  afterEach(() => vi.mocked(ipc.invokeWithProjectSession).mockReset())

  it('lets an earlier chapter repair a step that did not finish, for example after the chapter was reopened and replaced', async () => {
    chapterTwoRun([{ stepKey: 'kb_import', ok: true }, { stepKey: 'chapter_notes', ok: true }, { stepKey: 'character_cards', ok: false }])

    await expect(guardRepairPostProcess(2, projectPath, projectSession)).resolves.toEqual({ ok: true })
  })

  it('lets an earlier chapter whose current final was never post-processed run it', async () => {
    chapterTwoRun(null)

    await expect(guardRepairPostProcess(2, projectPath, projectSession)).resolves.toEqual({ ok: true })
  })

  it('refuses an earlier chapter whose post-processing all succeeded, in the interface language', async () => {
    chapterTwoRun([{ stepKey: 'kb_import', ok: true }, { stepKey: 'chapter_notes', ok: true }, { stepKey: 'character_cards', ok: true }])

    await expect(guardRepairPostProcess(2, projectPath, projectSession)).resolves.toEqual({
      ok: false, message: '第 2 章的定稿后处理已经全部完成，没有需要修复的步骤。',
    })
    useLocaleStore.setState({ locale: 'en-US' })
    const english = await guardRepairPostProcess(2, projectPath, projectSession)
    expect(english).toMatchObject({ ok: false, message: expect.stringContaining('Chapter 2') })
    expect(english.message).not.toMatch(/[\u4e00-\u9fff]/u)
  })

  it('still lets the latest finalized chapter repair', async () => {
    chapterTwoRun([{ stepKey: 'kb_import', ok: true }])

    await expect(guardRepairPostProcess(3, projectPath, projectSession)).resolves.toEqual({ ok: true })
  })
})
