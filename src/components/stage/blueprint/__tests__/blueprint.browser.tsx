import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../../shared/ipc-channels'
import { globalEventBus } from '../../../../shared/event-bus'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { disposeProjectService, initProjectService } from '../../../../services/project-service'
import type { ChapterBlueprint } from '../../../../services/workflows/directory-workflow'
import { editorSaveHandler, useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import StageBlueprint from '../StageBlueprint'

const PROJECT_PATH = 'C:\\novels\\stage-blueprint'
const SESSION = { projectId: 'stage-blueprint', leaseId: 'stage-blueprint-lease', projectPath: PROJECT_PATH }
const originalEditor = useEditorStore.getState()
const originalProject = useProjectStore.getState()
const originalStage = useStageStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined
let stored: ChapterBlueprint[]
let nextChapter: number
let projectCore: { premise: string } | null
let invoke: ReturnType<typeof vi.fn>

function blueprint(chapterNumber: number, title: string): ChapterBlueprint {
  return {
    chapterNumber, title, role: '发展', purpose: '推进灯塔线索', keyEvents: '钟声提前一刻', characters: ['林岚', '守塔人'],
    suspenseHook: '', userGuidance: chapterNumber === 2 ? '节奏放慢。' : '', notes: '', notesUpdatedAt: '',
  }
}

function project(): ProjectData {
  return {
    id: 'stage-blueprint', sessionLease: 'stage-blueprint-lease', name: '灯塔', path: PROJECT_PATH,
    novelConfig: {
      genre: '悬疑', subGenre: '', targetAudience: '成人', totalChapters: 12, wordsPerChapter: 3000, plotStructure: 'three_act',
      narrativePOV: 'third_limited', coreOutline: '灯塔', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
    },
    characterStates: '', createdAt: '', updatedAt: '',
  }
}

function installIpc() {
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'db:blueprint-get-all') return stored
    if (channel === 'db:draft-authority-sequence') return {
      status: 'continuous', lastChapterNumber: nextChapter - 1, nextChapterNumber: nextChapter, duplicateChapterNumbers: [], authorityFingerprint: 'a'.repeat(64),
    }
    if (channel === 'generation:find-blueprint-recovery') return null
    if (channel === 'db:consistency-exemption-list') return []
    if (channel === 'db:blueprint-clear-all') {
      stored = []
      return { success: true }
    }
    if (channel === 'db:blueprint-delete') {
      stored = stored.filter(item => item.chapterNumber !== args[0])
      return { success: true }
    }
    if (channel === 'db:blueprint-upsert' || channel === 'db:blueprint-upsert-many') return { success: true }
    if (channel === 'fs:list-dir') return []
    if (channel === 'config:get') return { blueprintTargetUnits: 800 }
    if (channel === 'config:set') return { success: true }
    if (channel === 'generation:list-directory-progress') return { progress: [], diagnostics: [] }
    if (channel === 'db:blueprint-character-sync-list-pending') return []
    if (channel === 'db:project-core-get') return projectCore
    if (channel === 'db:character-get-all') return [{ id: 1 }]
    throw new Error(`unexpected IPC ${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', {
    configurable: true,
    value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn(), setZoomLevel: vi.fn(), setZoomFactor: vi.fn(), getZoomLevel: vi.fn(() => 0) },
  })
}

const calls = (channel: string) => invoke.mock.calls.filter(call => call[0] === channel)

async function renderPage(initialChapterNumber?: number) {
  await act(async () => root?.render(<div className="paper-ink"><StageBlueprint projectKey={PROJECT_PATH} initialChapterNumber={initialChapterNumber} /></div>))
  await expect.element(page.getByRole('complementary', { name: '章节规划' })).toBeVisible()
}

/** 后台生成提交一段蓝图、定稿、删除或清空之后，蓝图页都会收到这条刷新。 */
async function refreshBlueprints() {
  const before = calls('db:blueprint-get-all').length
  await act(async () => globalEventBus.emit('REFRESH_RESOURCE', { resources: ['blueprints'], projectPath: PROJECT_PATH,
    projectSession: SESSION }))
  await vi.waitFor(() => expect(calls('db:blueprint-get-all').length).toBeGreaterThan(before))
  await vi.waitFor(() => expect(calls('db:draft-authority-sequence').length).toBe(calls('db:blueprint-get-all').length))
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  // 视口变化的 resize 事件可能晚于渲染才到，浮层收到 resize 会关闭：先等它派发完。
  await vi.waitFor(() => expect([window.innerWidth, window.innerHeight]).toEqual([1280, 900]))
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  stored = [blueprint(1, '旧港'), blueprint(2, '北堤'), blueprint(3, '灯室')]
  nextChapter = 2
  projectCore = null
  useLocaleStore.setState({ locale: 'zh-CN' })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useProjectStore.setState({ currentProject: project() })
  useStageStore.setState({ writeRequest: null, work: null })
  setActiveProjectSessionContext(SESSION)
  installIpc()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  Reflect.deleteProperty(window, 'aiNovelAPI')
  setActiveProjectSessionContext(null)
  useEditorStore.setState(originalEditor)
  useProjectStore.setState(originalProject)
  useStageStore.setState(originalStage)
})

describe('蓝图阶段', () => {
  it('打开蓝图页只向主进程要一次章节蓝图恢复稿，不逐个读取生成运行（#536）', async () => {
    await renderPage()
    await vi.waitFor(() => expect(calls('generation:find-blueprint-recovery')).toHaveLength(1))
    expect([...calls('generation:list'), ...calls('generation:read-context')]).toEqual([])
  })
  it('主按钮是写下一章的拆分按钮，点箭头只出现小弹层', async () => {
    await renderPage()
    await expect.element(page.getByRole('button', { name: '写第 2 章' })).toBeVisible()
    expect(page.getByRole('button', { name: '写第 2 章' }).element().className).toContain('pi-btn--primary')
    expect(page.getByRole('button', { name: 'AI 生成蓝图' }).element().className).toContain('pi-btn--secondary')
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
  })

  it('英文界面里只有一章蓝图时写 1 chapter，不写 1 chapters', async () => {
    stored = [blueprint(1, '旧港')]
    await renderPage()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    expect(document.querySelector('.stage-bp-plan-top')?.textContent).toBe('1 chapter')
  })

  it('清空全部蓝图在危险分组里，确认前不清空，确认后列表为空并出现空状态', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    const dangerGroup = page.getByRole('group', { name: '危险' })
    await act(async () => dangerGroup.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
    const confirm = page.getByRole('dialog', { name: '清空全部蓝图？' })
    await expect.element(confirm).toHaveTextContent('将删除全部 3 章蓝图')
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)

    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    expect(calls('db:blueprint-clear-all')).toHaveLength(0)
    await expect.element(page.getByRole('button', { name: /^1\D/ })).toBeVisible()

    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
    await act(async () => page.getByRole('dialog', { name: '清空全部蓝图？' }).getByRole('button', { name: '清空全部' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-clear-all')).toHaveLength(1))
    await expect.element(page.getByRole('heading', { name: '还没有章节蓝图' })).toBeVisible()
    expect(page.getByRole('complementary', { name: '章节规划' }).query()).toBeNull()
  })

  it('删除此章在单章的危险分组里，确认后只删这一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    const confirm = page.getByRole('dialog', { name: '删除第 3 章蓝图？' })
    await expect.element(confirm).toBeVisible()
    expect(calls('db:blueprint-delete')).toHaveLength(0)
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([3]))
    await expect.element(page.getByRole('button', { name: /^3\D/ })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /^2\D/ })).toBeVisible()
  })

  it('改字段后由外壳的保存（⌘S 同一入口）存全部，页面里不另显示未保存', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^2\D/ }).click())
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('北堤夜雨'))
    await act(async () => page.getByLabelText(/作者微操指导/).fill('节奏放慢，只写声音。'))
    expect(container?.textContent).not.toContain('未保存')

    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    expect(save).not.toBeNull()
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[]).find(item => item.chapterNumber === 2)).toMatchObject({ title: '北堤夜雨', userGuidance: '节奏放慢，只写声音。' })
  })

  it('保存此章只写当前一章', async () => {
    await renderPage()
    await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-upsert').map(call => call[1])).toMatchObject([{ chapterNumber: 1, title: '旧港潮汐' }]))
  })

  it('保存此章、删除此章、清空蓝图之后项目树不重读目录：蓝图只在数据库里', async () => {
    initProjectService()
    try {
      await renderPage()
      await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-upsert')).toHaveLength(1))
      await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
      await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
      await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
      await act(async () => page.getByRole('dialog', { name: '删除第 3 章蓝图？' }).getByRole('button', { name: '删除此章' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-delete')).toHaveLength(1))
      await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
      await act(async () => page.getByRole('menuitem', { name: '清空全部蓝图…' }).click())
      await act(async () => page.getByRole('dialog', { name: '清空全部蓝图？' }).getByRole('button', { name: '清空全部' }).click())
      await vi.waitFor(() => expect(calls('db:blueprint-clear-all')).toHaveLength(1))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
      expect(calls('fs:list-dir')).toEqual([])
    } finally {
      disposeProjectService()
    }
  })

  it('保存此章与保存全部成功后通知流程脊、Ctrl P 重读蓝图；保存失败不通知', async () => {
    const refreshes: string[][] = []
    const off = globalEventBus.on('REFRESH_RESOURCE', ({ resources }) => { refreshes.push([...resources]) })
    try {
      await renderPage()
      await act(async () => page.getByRole('textbox', { name: '章节标题' }).fill('旧港潮汐'))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await vi.waitFor(() => expect(refreshes).toEqual([['blueprints']]))

      const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
      await act(async () => { await save!() })
      expect(refreshes).toEqual([['blueprints'], ['blueprints']])

      const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
      invoke.mockImplementation(async (channel: string, ...args: unknown[]) => channel === 'db:blueprint-upsert'
        ? { success: false, error: '磁盘已满' } : base(channel, ...args))
      await act(async () => page.getByRole('button', { name: '保存此章' }).click())
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
      expect(refreshes).toHaveLength(2)
    } finally {
      off()
    }
  })

  it('保存此章与开始生成进行中时按钮带 aria-busy，结束后撤掉', async () => {
    await renderPage()
    const base = invoke.getMockImplementation() as (channel: string, ...args: unknown[]) => Promise<unknown>
    const gates = new Map<string, () => void>()
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'db:blueprint-upsert' || channel === 'config:set') await new Promise<void>(resolve => gates.set(channel, resolve))
      return base(channel, ...args)
    })
    await act(async () => page.getByRole('button', { name: '保存此章' }).click())
    const saving = page.getByRole('button', { name: '保存中…' })
    await expect.element(saving).toHaveAttribute('aria-busy', 'true')
    await act(async () => gates.get('db:blueprint-upsert')!())
    await expect.element(page.getByRole('button', { name: '保存此章' })).not.toHaveAttribute('aria-busy')

    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await act(async () => dialog.getByLabelText('蓝图结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    await vi.waitFor(() => expect(gates.has('config:set')).toBe(true))
    await expect.element(dialog.getByRole('button', { name: '启动中…' })).toHaveAttribute('aria-busy', 'true')
    await act(async () => gates.get('config:set')!())
    await expect.element(dialog.getByRole('button', { name: '开始生成' })).not.toHaveAttribute('aria-busy')
  })

  it('英文界面里作品只有一章时生成范围写 All 1 chapter', async () => {
    useProjectStore.setState({ currentProject: { ...project(), novelConfig: { ...project().novelConfig, totalChapters: 1 } } })
    stored = [blueprint(1, '旧港')]
    await renderPage()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    await act(async () => page.getByRole('button', { name: 'Generate blueprints' }).click())
    const full = await vi.waitFor(() => [...document.querySelectorAll('[role="dialog"] .stage-bp-option')].find(option => option.textContent?.startsWith('All'))!)
    expect(full.textContent).toBe('All 1 chapter')
  })

  it('出场人物可以逐个添加与移除', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '移除 守塔人' }).click())
    await act(async () => page.getByLabelText('出场人物').fill('沈砺'))
    await act(async () => page.getByLabelText('出场人物').element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[])[0].characters).toEqual(['林岚', '沈砺'])
  })

  it('出场人物重名：一次输入两遍只加一个；已有重名时移除一个只少一个', async () => {
    stored = [{ ...blueprint(1, '旧港'), characters: ['林岚', '守塔人', '守塔人'] }, blueprint(2, '北堤')]
    await renderPage()
    await act(async () => page.getByRole('button', { name: '移除 守塔人' }).first().click())
    await act(async () => page.getByLabelText('出场人物').fill('沈砺、沈砺'))
    await act(async () => page.getByLabelText('出场人物').element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    const save = editorSaveHandler({ id: 'chapter-card-editor', type: 'chapter-card', projectKey: PROJECT_PATH })
    await act(async () => { await save!() })
    const [[, saved]] = calls('db:blueprint-upsert-many')
    expect((saved as ChapterBlueprint[])[0].characters).toEqual(['林岚', '守塔人', '沈砺'])
  })

  it('输入法组字时按回车是选词，不把拼音当人物加进来', async () => {
    await renderPage()
    const input = page.getByLabelText('出场人物')
    await act(async () => input.fill('shen'))
    await act(async () => input.element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    expect((input.element() as HTMLInputElement).value).toBe('shen')
    expect([...container!.querySelectorAll('button[aria-label^="移除 "]')].map(button => button.getAttribute('aria-label'))).toEqual(['移除 林岚', '移除 守塔人'])
  })

  it('生成蓝图选覆盖时先危险确认，取消后不启动，生成对话框回来且不当作错误', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await expect.element(dialog).toBeVisible()
    await act(async () => dialog.getByRole('button', { name: '覆盖' }).click())
    await expect.element(dialog.getByText('已有蓝图会被覆盖，开始前再确认一次')).toBeVisible()
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    const confirm = page.getByRole('dialog', { name: '覆盖已有蓝图？' })
    await expect.element(confirm).toHaveTextContent('已有的 3 章蓝图会被新蓝图替换')
    expect(calls('db:project-core-get')).toHaveLength(0)
    await act(async () => confirm.getByRole('button', { name: '取消' }).click())
    await expect.element(dialog.getByRole('button', { name: '开始生成' })).toBeVisible()
    expect(dialog.getByRole('alert').query()).toBeNull()
    expect(calls('db:project-core-get')).toHaveLength(0)
  })

  it('指定范围只补没有蓝图的章，不出现覆盖选项与覆盖提示', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByRole('button', { name: '覆盖' }).click())
    await expect.element(dialog.getByText('已有蓝图会被覆盖，开始前再确认一次')).toBeVisible()
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await expect.element(dialog.getByText('已有蓝图会被覆盖，开始前再确认一次')).not.toBeInTheDocument()
    expect(dialog.getByRole('button', { name: '覆盖' }).query()).toBeNull()
  })

  it('指定范围后取消架构警告：对话框回来，作者填的起止章还在，不当作错误', async () => {
    projectCore = { premise: '灯塔'.repeat(40) }
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await act(async () => dialog.getByLabelText('蓝图结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    const warning = page.getByRole('dialog', { name: '架构还不完整' })
    await expect.element(warning).toBeVisible()
    await act(async () => warning.getByRole('button', { name: '取消' }).click())
    await expect.element(dialog.getByLabelText('蓝图起始章')).toHaveValue(5)
    await expect.element(dialog.getByLabelText('蓝图结束章')).toHaveValue(7)
    expect(dialog.getByRole('alert').query()).toBeNull()
  })

  it('指定范围后启动失败：对话框回来写明原因，作者填的起止章还在', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: 'AI 生成蓝图' }).click())
    const dialog = page.getByRole('dialog', { name: 'AI 生成蓝图' })
    await act(async () => dialog.getByLabelText('蓝图起始章').fill('5'))
    await act(async () => dialog.getByLabelText('蓝图结束章').fill('7'))
    await act(async () => dialog.getByRole('button', { name: '开始生成' }).click())
    await expect.element(dialog.getByRole('alert')).toHaveTextContent('「故事前提」尚未生成')
    await expect.element(dialog.getByLabelText('蓝图起始章')).toHaveValue(5)
    await expect.element(dialog.getByLabelText('蓝图结束章')).toHaveValue(7)
  })

  it('批量创作对话框从权威下一章开始，按章数显示主按钮', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '批量创作' }).click())
    const dialog = page.getByRole('dialog', { name: '批量创作' })
    await expect.element(dialog.getByText('第 2 章', { exact: true })).toBeVisible()
    await act(async () => dialog.getByLabelText(/写几章/).fill('4'))
    await expect.element(dialog.getByRole('button', { name: '开始写 4 章' })).toBeVisible()
    await act(async () => dialog.getByRole('radio', { name: /自动定稿/ }).click())
    await expect.element(dialog.getByRole('button', { name: '继续确认自动定稿' })).toBeVisible()
  })

  it('「写几章」清空后重新输入：删掉 1 再输 3 得 3，不是 13；空着离开回到 1', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '批量创作' }).click())
    const count = page.getByRole('dialog', { name: '批量创作' }).getByLabelText(/写几章/)
    const input = count.element() as HTMLInputElement
    await act(async () => input.focus())
    await userEvent.keyboard('{End}{Backspace}')
    await userEvent.keyboard('3')
    expect(input.value).toBe('3')
    await userEvent.keyboard('{Backspace}')
    await act(async () => input.blur())
    expect(input.value).toBe('1')
  })

  it('更多蓝图操作里新建章节：新章接在权威下一章已有蓝图之后并被选中', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '更多蓝图操作' }).click())
    await act(async () => page.getByRole('menuitem', { name: '新建章节' }).click())
    await expect.element(page.getByRole('button', { name: /^4\D/ })).toHaveAttribute('aria-current', 'true')
    await expect.element(page.getByRole('region', { name: '第 4 章蓝图' })).toBeVisible()
  })

  it('写作请求落到这一页：可写的那一章自动弹出写作弹层，写不了的章丢掉请求', async () => {
    useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 2 } })
    await renderPage()
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' })).toBeVisible()
    expect(useStageStore.getState().writeRequest).toBeNull()

    await act(async () => root?.render(null))
    useStageStore.setState({ writeRequest: { session: SESSION, chapterNumber: 3 } })
    await renderPage()
    await vi.waitFor(() => expect(useStageStore.getState().writeRequest).toBeNull())
    expect(page.getByRole('dialog', { name: '本次写作选项' }).query()).toBeNull()
  })

  it('蓝图重新加载时页面与打开的弹层都留着，作者刚写的指导不丢', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    const popover = page.getByRole('dialog', { name: '本次写作选项' })
    await act(async () => popover.getByLabelText(/作者微操指导/).fill('作者刚写的指导'))
    await refreshBlueprints()
    await expect.element(popover.getByLabelText(/作者微操指导/)).toHaveValue('作者刚写的指导')
  })

  it('删除确认期间蓝图重新加载：确认框仍是作者选的那一章，删的也是它，选中不跳回', async () => {
    await renderPage(2)
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    await expect.element(page.getByRole('dialog', { name: '删除第 3 章蓝图？' })).toBeVisible()
    await refreshBlueprints()
    // 确认框是模态的，页面其余部分对辅助技术隐藏，直接读选中的那一行。
    expect(container?.querySelector('.stage-bp-plan-item[aria-current] .stage-bp-plan-no')?.textContent).toBe('3')
    const confirm = page.getByRole('dialog', { name: /^删除第 \d+ 章蓝图？$/ })
    await expect.element(confirm).toHaveAccessibleName('删除第 3 章蓝图？')
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await vi.waitFor(() => expect(calls('db:blueprint-delete').map(call => call[1])).toEqual([3]))
  })

  it('删除确认期间这一章已被别处删掉：确认后不会改删别的章', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: /^3\D/ }).click())
    await act(async () => page.getByRole('button', { name: '第 3 章更多操作' }).click())
    await act(async () => page.getByRole('group', { name: '危险' }).getByRole('menuitem', { name: '删除此章…' }).click())
    stored = stored.filter(item => item.chapterNumber !== 3)
    await refreshBlueprints()
    const confirm = page.getByRole('dialog', { name: '删除第 3 章蓝图？' })
    await act(async () => confirm.getByRole('button', { name: '删除此章' }).click())
    await expect.element(confirm).not.toBeInTheDocument()
    expect(calls('db:blueprint-delete')).toEqual([])
  })

  it('下一章变了，写作弹层按新的一章重建，上一章没用掉的指导不带过去', async () => {
    await renderPage()
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await act(async () => page.getByRole('dialog', { name: '本次写作选项' }).getByLabelText(/作者微操指导/).fill('只给第 2 章的指导'))
    nextChapter = 3
    await refreshBlueprints()
    await expect.element(page.getByRole('button', { name: '写第 3 章' })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '本次写作选项' }).click())
    await expect.element(page.getByRole('dialog', { name: '本次写作选项' }).getByLabelText(/作者微操指导/)).toHaveValue('')
  })
})
