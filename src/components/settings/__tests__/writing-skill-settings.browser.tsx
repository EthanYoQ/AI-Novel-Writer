import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import SkillSettings from '../SkillSettings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
const invoke = vi.fn()
const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()

function ipcResult(channel: string) {
  if (channel === 'skills:list-user') return []
  if (channel === 'fs:list-dir') return []
  if (channel === 'fs:check-exists') return false
  if (channel === 'fs:read-file') return { success: false, content: '', error: 'missing' }
  if (channel === 'fs:write-file') return { success: true }
  if (channel === 'skills:inspect-github') return {
    success: true,
    inspection: {
      sourceUrl: 'https://github.com/acme/scene-craft',
      resolvedUrl: 'https://raw.githubusercontent.com/acme/scene-craft/main/SKILL.md',
      metadata: { name: 'scene-craft', description: 'Concrete scene craft', language: 'en-US' },
      compatible: true,
      reasons: [],
      suggestedStage: 'drafting',
      utf8Bytes: 128,
    },
  }
  throw new Error(`Unexpected IPC channel ${channel}`)
}

beforeEach(async () => {
  invoke.mockImplementation(async (channel: string) => ipcResult(channel))
  Object.defineProperty(window, 'velaAPI', {
    configurable: true,
    value: { invoke, on: () => () => {}, once: () => {}, send: () => {} },
  })
  useLocaleStore.setState({ locale: 'en-US' })
  useProjectStore.setState({
    currentProject: {
      id: 'skill-project',
      name: 'Skill project',
      path: 'C:/novels/skill-project',
      sessionLease: 'skill-project-lease',
      novelConfig: {},
    } as never,
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<SkillSettings />))
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('skills:list-user'))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState(originalLocaleState)
  vi.restoreAllMocks()
})

describe('writing skill settings', () => {
  it('inspects a GitHub candidate before offering installation', async () => {
    await act(async () => {
      await page.getByLabelText('GitHub skill URL').fill('https://github.com/acme/scene-craft')
      await page.getByRole('button', { name: 'Inspect' }).click()
    })
    await expect.element(page.getByText('scene-craft', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Confirm install' })).toBeEnabled()
    expect(invoke).toHaveBeenCalledWith('skills:inspect-github', 'https://github.com/acme/scene-craft')
  })

  it('uses the application confirmation dialog before installation', async () => {
    await act(async () => {
      await page.getByLabelText('GitHub skill URL').fill('https://github.com/acme/scene-craft')
      await page.getByRole('button', { name: 'Inspect' }).click()
      await page.getByRole('button', { name: 'Confirm install' }).click()
    })
    await expect.element(page.getByRole('dialog')).toBeVisible()
    expect(invoke).not.toHaveBeenCalledWith('skills:install-github', expect.anything())
    await act(async () => page.getByRole('button', { name: 'Cancel' }).click())
    await vi.waitFor(() => expect(page.getByRole('dialog').query()).toBeNull())
  })

  it('shows four project stages and persists one selected skill id', async () => {
    await expect.element(page.getByLabelText('Planning skill')).toBeVisible()
    await expect.element(page.getByLabelText('Chapter drafting skill')).toBeVisible()
    await expect.element(page.getByLabelText('AI review skill')).toBeVisible()
    await expect.element(page.getByLabelText('Revision and pre-final polish skill')).toBeVisible()

    await act(async () => {
      await page.getByLabelText('Revision and pre-final polish skill')
        .selectOptions('builtin:natural-prose-refinement')
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
      'fs:write-file',
      'C:/novels/skill-project/.vela/writing-skills.json',
      expect.stringContaining('builtin:natural-prose-refinement'),
      'C:/novels/skill-project',
      expect.objectContaining({ projectId: 'skill-project', leaseId: 'skill-project-lease' }),
    ))
  })
})
