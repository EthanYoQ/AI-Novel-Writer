import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import SkillSettings from '../SkillSettings'
import { leaveSettings } from '../unsaved-settings'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
const invoke = vi.fn()
const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()

const localInspection = {
  candidateId: 'candidate-1',
  sourceKind: 'folder',
  sourceName: 'scene-voice',
  contentSha256: 'a'.repeat(64),
  metadata: { name: 'scene-voice', description: 'Keep a steady narrative voice', language: 'bilingual' },
  compatible: true,
  reasons: [],
  suggestedStage: 'drafting',
  utf8Bytes: 2048,
  bundledFiles: ['references/voice.md'],
  unbundledReferences: [] as string[],
  skippedFiles: ['scripts/lint.py'],
}

function ipcResult(channel: string) {
  if (channel === 'skills:list-user') return []
  if (channel === 'fs:list-dir') return []
  if (channel === 'fs:check-exists') return false
  if (channel === 'fs:read-file') return { success: false, content: '', error: 'missing' }
  if (channel === 'fs:write-file') return { success: true }
  if (channel === 'config:set') return { success: true }
  if (channel === 'skills:pick-local') return { success: true, cancelled: false, inspection: localInspection }
  if (channel === 'skills:install-local') return { success: true, skill: { name: 'scene-voice' } }
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
  Object.defineProperty(window, 'aiNovelAPI', {
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
  await act(async () => {
    await vi.waitFor(() => expect(container?.querySelector('option[value^="builtin:"]')).not.toBeNull())
  })
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
  it('inspects a local skill folder picked in the main process and lists what it merges and skips', async () => {
    await act(async () => page.getByRole('button', { name: 'Choose folder' }).click())
    const card = page.getByRole('group', { name: 'Skill to install' })
    await expect.element(card.getByText('scene-voice', { exact: true })).toBeVisible()
    await expect.element(card.getByText(/references\/voice\.md/u)).toBeVisible()
    await expect.element(card.getByText(/scripts\/lint\.py/u)).toBeVisible()
    expect(invoke).toHaveBeenCalledWith('skills:pick-local', 'folder')
    await expect.element(page.getByRole('button', { name: 'Confirm install' })).toBeEnabled()
  })

  it('lists links the skill cites but cannot install while still allowing installation', async () => {
    invoke.mockImplementation(async (channel: string) => channel === 'skills:pick-local'
      ? { success: true, cancelled: false, inspection: { ...localInspection, unbundledReferences: ['FORMS.md', 'image.png'] } }
      : ipcResult(channel))
    await act(async () => page.getByRole('button', { name: 'Choose folder' }).click())
    const card = page.getByRole('group', { name: 'Skill to install' })
    await expect.element(card.getByText(/the model cannot see them: FORMS\.md, image\.png/u)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Confirm install' })).toBeEnabled()

    // text 是稳定函数，切换语言不触发重渲染；重新检查一次让卡片按中文重绘。
    useLocaleStore.setState({ locale: 'zh-CN' })
    await act(async () => page.getByRole('button', { name: 'Choose folder' }).click())
    await expect.element(page.getByRole('group', { name: '待安装的 Skill' })
      .getByText('SKILL.md 引用了这些文件，但它们不会随 Skill 安装，模型看不到：FORMS.md、image.png')).toBeVisible()
  })

  it('installs a local candidate by its id after the application confirmation', async () => {
    await act(async () => page.getByRole('button', { name: 'Choose file' }).click())
    await expect.element(page.getByRole('group', { name: 'Skill to install' })).toBeVisible()
    await act(async () => page.getByRole('button', { name: 'Confirm install' }).click())
    await act(async () => page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click())
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('skills:install-local', 'candidate-1'))
    expect(invoke).toHaveBeenCalledWith('skills:pick-local', 'file')
    expect(invoke).not.toHaveBeenCalledWith('skills:install-github', expect.anything())
    await vi.waitFor(() => expect(page.getByRole('group', { name: 'Skill to install' }).query()).toBeNull())
  })

  it('drops the candidate the main process discarded when installation fails', async () => {
    let answerInstall: (result: { success: false; error: string }) => void = () => {}
    const installRequested = new Promise<void>(requested => {
      invoke.mockImplementation(async (channel: string) => channel === 'skills:install-local'
        ? new Promise(answer => { answerInstall = answer; requested() })
        : ipcResult(channel))
    })
    await act(async () => page.getByRole('button', { name: 'Choose folder' }).click())
    await act(async () => page.getByRole('button', { name: 'Confirm install' }).click())
    await act(async () => page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click())
    await installRequested
    await act(async () => answerInstall({
      success: false,
      error: 'The skill files could not be written, so nothing was installed. Choose the skill again to retry.',
    }))

    expect(page.getByRole('alert').element()).toHaveTextContent(/Choose the skill again to retry/u)
    expect(page.getByRole('group', { name: 'Skill to install' }).query()).toBeNull()
    const leave = vi.fn()
    leaveSettings(leave)
    expect(leave).toHaveBeenCalledOnce()
  })

  it('keeps the page unchanged when the picker is cancelled and shows main-process errors', async () => {
    invoke.mockImplementation(async (channel: string) => channel === 'skills:pick-local'
      ? { success: true, cancelled: true }
      : ipcResult(channel))
    await act(async () => page.getByRole('button', { name: 'Choose folder' }).click())
    expect(page.getByRole('group', { name: 'Skill to install' }).query()).toBeNull()
    expect(page.getByRole('alert').query()).toBeNull()

    invoke.mockImplementation(async (channel: string) => channel === 'skills:pick-local'
      ? { success: false, error: 'The skill contains a symbolic link or junction and was rejected' }
      : ipcResult(channel))
    await act(async () => page.getByRole('button', { name: 'Choose folder' }).click())
    await expect.element(page.getByRole('alert')).toHaveTextContent(/symbolic link/u)
  })

  it('marks an installed skill whose reference files were damaged and keeps it out of stage bindings', async () => {
    invoke.mockImplementation(async (channel: string) => channel === 'skills:list-user'
      ? [{
          name: 'scene-voice',
          baseDir: 'managed://skills/scene-voice',
          filePath: 'managed://skills/scene-voice/SKILL.md',
          content: '---\nname: scene-voice\ndescription: Keep a steady narrative voice\n---\nFollow references/voice.md.',
          bundle: { status: 'damaged' },
        }]
      : ipcResult(channel))
    await act(async () => root?.unmount())
    root = createRoot(container!)
    await act(async () => root?.render(<SkillSettings />))

    const library = page.getByRole('region', { name: 'Skill library' })
    await expect.element(library.getByText('Damaged', { exact: true })).toBeVisible()
    await expect.element(library.getByText(/uninstall and import the skill again/u)).toBeVisible()
    expect(container?.querySelector('option[value="user:scene-voice"]')).toBeNull()
  })

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
      'C:/novels/skill-project/.ai-novel/writing-skills.json',
      expect.stringContaining('builtin:natural-prose-refinement'),
      'C:/novels/skill-project',
      expect.objectContaining({ projectId: 'skill-project', leaseId: 'skill-project-lease' }),
    ))
  })

  it('uses an English separator when one skill is enabled for multiple stages', async () => {
    await act(async () => {
      await page.getByLabelText('Planning skill').selectOptions('builtin:long-form-continuity')
    })
    await expect.element(page.getByLabelText('Chapter drafting skill')).toBeEnabled()
    await act(async () => {
      await page.getByLabelText('Chapter drafting skill').selectOptions('builtin:long-form-continuity')
    })

    const library = container?.querySelector('section[aria-labelledby="writing-skill-library-title"]')
    await vi.waitFor(() => expect(library?.textContent).toContain('Planning, Chapter drafting'))
    expect(library?.textContent).not.toContain('Planning、Chapter drafting')
  })

  it('localizes bundled skill metadata while preserving its Chinese copy', async () => {
    const library = container?.querySelector('section[aria-labelledby="writing-skill-library-title"]')
    const builtinOptions = () => [...(container?.querySelectorAll('select option') ?? [])]
      .filter(option => (option as HTMLOptionElement).value.startsWith('builtin:'))
      .map(option => option.textContent ?? '')

    expect(library?.textContent).not.toMatch(/[\u3400-\u9fff]/u)
    expect(builtinOptions().join(' ')).not.toMatch(/[\u3400-\u9fff]/u)

    await act(async () => useLocaleStore.getState().setLocale('zh-CN'))

    expect(library?.textContent).toContain('长篇连续性与场景推进')
    expect(builtinOptions()).toContain('自然语言润色')
  })
})
