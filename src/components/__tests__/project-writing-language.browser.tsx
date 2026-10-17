import { ipc } from '../../services/ipc-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { CreateProjectConfig, ProjectData } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../stores/editor-store'
import NewWorkDialog from '../stage/library/NewWorkDialog'
import StageSetup from '../stage/setup/StageSetup'

const originalLayoutState = useLayoutStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalEditorState = useEditorStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

async function mount(node: React.ReactNode) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(node))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useLayoutStore.setState(originalLayoutState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useEditorStore.setState(originalEditorState, true)
  setActiveProjectSessionContext(null)
  vi.restoreAllMocks()
})

function project(id: string, writingLanguage: 'zh-CN' | 'en-US'): ProjectData {
  return {
    id,
    name: `Novel ${id}`,
    path: `C:\\novels\\${id}`,
    sessionLease: `lease-${id}`,
    novelConfig: {
      writingLanguage,
      genre: 'fantasy',
      subGenre: '',
      targetAudience: 'all',
      totalChapters: 100,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: `Outline ${id}`,
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function writingLanguageSelect(): HTMLSelectElement {
  const select = document.querySelector('.stage-setup-language select')
  if (!(select instanceof HTMLSelectElement)) throw new Error('Missing project writing language selector')
  return select
}

describe('project writing language', () => {
  it('initializes a new project from the UI language at creation time', async () => {
    vi.spyOn(ipc, 'invoke').mockResolvedValueOnce({ grantId: 'parent-grant', displayName: 'novels' } as never)
    const createProject = vi.fn(async () => true)
    useLocaleStore.setState({ locale: 'en-US' })
    useProjectStore.setState({ createProject: createProject as never })

    useLayoutStore.setState({ newProjectOpen: true })
    await mount(<NewWorkDialog />)
    await act(async () => {
      await page.getByPlaceholder('e.g. The Night Train').fill('English novel')
      await page.getByRole('button', { name: 'Choose', exact: true }).click()
      await page.getByRole('button', { name: 'Create book' }).click()
    })

    const expectedConfig: CreateProjectConfig = {
      name: 'English novel',
      parentGrantId: 'parent-grant',
      genre: '',
      targetAudience: '',
      writingLanguage: 'en-US',
    }
    await vi.waitFor(() => expect(createProject).toHaveBeenCalledWith(expectedConfig))
  })

  it.each([
    { uiLocale: 'zh-CN', writingLanguage: 'zh-CN', label: '写作语言' },
    { uiLocale: 'zh-CN', writingLanguage: 'en-US', label: '写作语言' },
    { uiLocale: 'en-US', writingLanguage: 'zh-CN', label: 'Writing language' },
    { uiLocale: 'en-US', writingLanguage: 'en-US', label: 'Writing language' },
  ] as const)(
    'renders $writingLanguage writing in a $uiLocale interface',
    async ({ uiLocale, writingLanguage, label }) => {
      const currentProject = project(`${uiLocale}-${writingLanguage}`, writingLanguage)
      useLocaleStore.setState({ locale: uiLocale })
      useProjectStore.setState({ currentProject })
      setActiveProjectSessionContext({
        projectId: currentProject.id,
        leaseId: currentProject.sessionLease!,
        projectPath: currentProject.path,
      })

      await mount(<StageSetup projectKey={currentProject.path} />)

      await expect.element(page.getByRole('combobox', { name: new RegExp(`^${label}`) })).toBeVisible()
      expect(writingLanguageSelect().value).toBe(writingLanguage)
    },
  )

  it.each(['zh-CN', 'en-US'] as const)(
    'preserves custom model-generated select values in a $uiLocale interface',
    async (uiLocale) => {
      const currentProject = project(`custom-config-${uiLocale}`, 'en-US')
      currentProject.novelConfig.genre = 'Contemporary Romance'
      currentProject.novelConfig.targetAudience = 'Adult readers interested in realistic relationships'
      useLocaleStore.setState({ locale: uiLocale })
      useProjectStore.setState({ currentProject })
      setActiveProjectSessionContext({
        projectId: currentProject.id,
        leaseId: currentProject.sessionLease!,
        projectPath: currentProject.path,
      })

      await mount(<StageSetup projectKey={currentProject.path} />)

      const options = Array.from(document.querySelectorAll('option'))
      const genre = options.find(option => option.value === currentProject.novelConfig.genre)
      const audience = options.find(option => option.value === currentProject.novelConfig.targetAudience)
      expect({ text: genre?.textContent, selected: genre?.selected }).toEqual({
        text: 'Contemporary Romance',
        selected: true,
      })
      expect({ text: audience?.textContent, selected: audience?.selected }).toEqual({
        text: 'Adult readers interested in realistic relationships',
        selected: true,
      })
    },
  )

  it.each([
    { uiLocale: 'zh-CN', labels: ['请选择', '请选择'] },
    { uiLocale: 'en-US', labels: ['Choose', 'Choose'] },
  ] as const)('shows empty configuration placeholders in a $uiLocale interface', async ({ uiLocale, labels }) => {
    const currentProject = project(`empty-config-${uiLocale}`, 'en-US')
    currentProject.novelConfig.genre = ''
    currentProject.novelConfig.targetAudience = ''
    useLocaleStore.setState({ locale: uiLocale })
    useProjectStore.setState({ currentProject })
    setActiveProjectSessionContext({
      projectId: currentProject.id,
      leaseId: currentProject.sessionLease!,
      projectPath: currentProject.path,
    })

    await mount(<StageSetup projectKey={currentProject.path} />)

    const emptyOptions = Array.from(document.querySelectorAll<HTMLOptionElement>('option[value=""]'))
    expect(emptyOptions.map(option => option.textContent)).toEqual(labels)
    expect(emptyOptions.every(option => option.selected)).toBe(true)
    expect(useProjectStore.getState().currentProject?.novelConfig).toMatchObject({
      genre: '',
      targetAudience: '',
    })
  })

  it('keeps the UI locale independent and follows the active project when projects switch', async () => {
    const projectA = project('A', 'en-US')
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({ currentProject: projectA })
    setActiveProjectSessionContext({
      projectId: projectA.id,
      leaseId: projectA.sessionLease!,
      projectPath: projectA.path,
    })

    await mount(<StageSetup projectKey={projectA.path} />)
    await expect.element(page.getByRole('combobox', { name: /^写作语言/ })).toBeVisible()
    expect(writingLanguageSelect().value).toBe('en-US')

    const projectB = project('B', 'zh-CN')
    await act(async () => {
      useLocaleStore.setState({ locale: 'en-US' })
      useProjectStore.setState({ currentProject: projectB })
      setActiveProjectSessionContext({
        projectId: projectB.id,
        leaseId: projectB.sessionLease!,
        projectPath: projectB.path,
      })
      root?.render(<StageSetup projectKey={projectB.path} />)
    })

    await expect.element(page.getByRole('combobox', { name: /^Writing language/ })).toBeVisible()
    expect(writingLanguageSelect().value).toBe('zh-CN')
  })

  it('changes only future writing language and preserves existing project content', async () => {
    const currentProject = project('preserve-content', 'zh-CN')
    const saveProject = vi.fn(async () => true)
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({ currentProject, saveProject: saveProject as never })
    useEditorStore.setState({ tabs: [{ id: 'config', name: '设定', type: 'config', projectKey: currentProject.path, dirty: false }], activeTabId: 'config' })
    setActiveProjectSessionContext({
      projectId: currentProject.id,
      leaseId: currentProject.sessionLease!,
      projectPath: currentProject.path,
    })

    await mount(<StageSetup projectKey={currentProject.path} />)
    const originalOutline = currentProject.novelConfig.coreOutline
    await act(async () => {
      const select = writingLanguageSelect()
      select.value = 'en-US'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(useProjectStore.getState().currentProject?.novelConfig).toMatchObject({
      writingLanguage: 'en-US',
      coreOutline: originalOutline,
    })
    await act(async () => page.getByRole('button', { name: /^保存/ }).click())
    await vi.waitFor(() => expect(saveProject).toHaveBeenCalledOnce())
    expect(useProjectStore.getState().currentProject?.novelConfig.coreOutline).toBe(originalOutline)
  })

  it('shows the project-scoped dormant-thread threshold with its range, default, and a bilingual reset', async () => {
    const currentProject = project('quality-setting', 'zh-CN')
    currentProject.novelConfig.narrativeThreadDormantChapterThreshold = 9
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({ currentProject })
    setActiveProjectSessionContext({
      projectId: currentProject.id,
      leaseId: currentProject.sessionLease!,
      projectPath: currentProject.path,
    })

    await mount(<StageSetup projectKey={currentProject.path} />)
    await act(async () => page.getByRole('button', { name: /^高级/ }).click())
    await expect.element(page.getByText('伏笔沉寂提醒（章）', { exact: true })).toBeVisible()
    await expect.element(page.getByText('一条伏笔连续这么多章没有推进，剧情页会提醒你。默认 3 章。', { exact: true })).toBeVisible()
    const threshold = document.querySelector('.stage-setup-adv-ctl input')
    if (!(threshold instanceof HTMLInputElement)) throw new Error('Missing narrative thread threshold input')
    expect({ value: threshold.value, min: threshold.min, max: threshold.max }).toEqual({ value: '9', min: '1', max: '50' })

    await act(async () => page.getByRole('button', { name: '恢复默认' }).click())
    expect(useProjectStore.getState().currentProject?.novelConfig.narrativeThreadDormantChapterThreshold).toBe(3)
    expect(threshold.value).toBe('3')

    await act(async () => {
      useLocaleStore.setState({ locale: 'en-US' })
      root?.render(<StageSetup projectKey={currentProject.path} />)
    })
    await expect.element(page.getByText('Dormant thread reminder (chapters)', { exact: true })).toBeVisible()
    await expect.element(page.getByText('The plot page flags a thread that has not moved for this many chapters. Default 3.', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Restore default' })).toBeDisabled()
  })

  it('propagates configuration save failure to the exit gate', async () => {
    const currentProject = project('config-exit-failure', 'zh-CN')
    const saveProject = vi.fn(async () => { throw new Error('磁盘已满') })
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({ currentProject, saveProject: saveProject as never })
    useEditorStore.setState({
      tabs: [{
        id: 'config-exit', name: '小说配置', type: 'config', projectKey: currentProject.path,
        dirty: true,
      }],
      activeTabId: 'config-exit',
      draftLedgers: {},
    })
    setActiveProjectSessionContext({
      projectId: currentProject.id,
      leaseId: currentProject.sessionLease!,
      projectPath: currentProject.path,
    })
    await mount(<StageSetup projectKey={currentProject.path} />)

    let failure: unknown
    await act(async () => {
      try { await saveDirtyEditorChangesForExit(currentProject.path) } catch (error) { failure = error }
    })
    expect(failure).toEqual(expect.objectContaining({ message: '磁盘已满' }))
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
    expect(container?.textContent).toContain('没能保存')
  })
})
