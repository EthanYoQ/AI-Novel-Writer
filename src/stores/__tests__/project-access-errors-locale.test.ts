import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Locale } from '../../i18n/types'
import { useLocaleStore } from '../locale-store'
import { useProjectStore } from '../project-store'

const { invoke, alertError } = vi.hoisted(() => ({ invoke: vi.fn(), alertError: vi.fn() }))

vi.mock('../../services/ipc-client', () => ({
  ipc: {
    invoke,
    invokeWithProjectSession: (_context: unknown, channel: string, ...args: unknown[]) => invoke(channel, ...args),
  },
}))

vi.mock('../../components/ui/AlertDialog', () => ({ alertError }))

vi.mock('../../services/project-service', () => ({
  onProjectOpening: vi.fn(),
  onProjectOpened: vi.fn(async () => undefined),
  onProjectClosed: vi.fn(),
}))

const originalLocale = useLocaleStore.getState().locale

/** 主进程打开或创建被拒时的回包：数据库仍在原处，报错是 String(err) 形式的错误码。 */
function refusal(error: string, requestToken: string) {
  return {
    success: false,
    project: null,
    projectId: '',
    requestToken,
    activeProjectPath: null,
    databaseRestored: true,
    dbReady: true,
    error,
  }
}

async function shownError(locale: Locale, run: () => Promise<unknown>): Promise<string> {
  useLocaleStore.setState({ locale })
  alertError.mockClear()
  await run()
  expect(alertError).toHaveBeenCalledOnce()
  return alertError.mock.calls[0]![0] as string
}

beforeEach(() => {
  invoke.mockReset()
  useProjectStore.setState({ currentProject: null, fileTree: [], loading: false })
})

afterEach(() => {
  useLocaleStore.setState({ locale: originalLocale })
})

describe('project open and create refusals from the main process (#474 B4)', () => {
  it('explains a missing project folder in the interface language', async () => {
    invoke.mockImplementation(async (channel: string, _target: unknown, requestToken: string) => (
      channel === 'project:open' ? refusal('Error: PROJECT_DIRECTORY_MISSING', requestToken) : undefined
    ))
    const open = () => useProjectStore.getState().openProject('C:\\novels\\moved')

    expect(await shownError('en-US', open)).toBe(
      'The project folder could not be found. It may have been moved, renamed, or deleted. Choose the project folder again.',
    )
    expect(await shownError('zh-CN', open)).toBe('找不到这个项目文件夹，它可能已被移动、改名或删除。请重新选择项目文件夹。')
  })

  it('explains that a new project would overwrite an existing folder', async () => {
    invoke.mockImplementation(async (channel: string, _config: unknown, requestToken: string) => (
      channel === 'project:create' ? refusal('Error: PROJECT_DIRECTORY_EXISTS', requestToken) : undefined
    ))
    const create = () => useProjectStore.getState().createProject({
      name: 'Rain', parentGrantId: 'grant-parent', genre: '', targetAudience: '',
    })

    expect(await shownError('en-US', create)).toBe(
      'A folder with this name already exists there, so it was not overwritten. Choose another project name or location.',
    )
    expect(await shownError('zh-CN', create)).toBe('所选位置已有同名文件夹，已拒绝覆盖。请换一个项目名称或保存位置。')
  })

  it('explains a project session that went stale while the request was in flight', async () => {
    invoke.mockImplementation(async (channel: string, _target: unknown, requestToken: string) => (
      channel === 'project:open'
        ? refusal('ProjectSessionStaleError: PROJECT_SESSION_DATABASE_MISMATCH', requestToken)
        : undefined
    ))
    const open = () => useProjectStore.getState().openProject('C:\\novels\\A')

    expect(await shownError('en-US', open)).toBe(
      'The project was switched or reopened, and this action belonged to the earlier session, so it was rejected. Repeat it in the project that is open now.',
    )
    expect(await shownError('zh-CN', open)).toBe('项目已切换或重新打开，这次操作属于之前打开的项目，已拒绝执行。请在当前打开的项目里重新操作。')
  })
})
