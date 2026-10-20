import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { page, userEvent } from 'vitest/browser'
import { createRoot, type Root } from 'react-dom/client'
import type { StoreApi } from 'zustand'

import '../../../../index.css'
import '../../../../styles/paper-ink/index.css'
import '../../stage.css'
import type { PendingFinalizedCharacterStateCandidate } from '../../../../shared/finalized-continuity'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { EMPTY_CARD, useCharacterStore, type CharacterCard } from '../../../../stores/character-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useStageStore } from '../../../../stores/navigation/stage-store'
import { useProjectStore } from '../../../../stores/project-store'
import { useWorkflowStore } from '../../../../stores/workflow-store'
import StageCharacters from '../StageCharacters'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = { projectId: '雨夜列车', projectPath: 'C:/novels/rain-train', leaseId: '本次打开' }
const card = (characterId: string, name: string, role: CharacterCard['role'] = 'supporting'): CharacterCard =>
  ({ ...EMPTY_CARD, characterId, name, role })
const linzhou = card('c-linzhou', '林舟', 'protagonist')
const shenyan = card('c-shenyan', '沈砚')
const stateCandidate = (key: string, field: PendingFinalizedCharacterStateCandidate['field'], value: string): PendingFinalizedCharacterStateCandidate => ({
  candidateKey: key, characterId: linzhou.characterId!, characterName: '林舟', displayName: '林舟', selectionKey: `state:${key}`,
  field, value, reason: 'author-protected', expectedFieldRevision: 3, expectedFieldValueHash: 'b'.repeat(64),
  source: { draftId: 7, finalizationId: 'final-7', chapterNumber: 7, contentHash: 'c'.repeat(64) },
})

function snapshot<T>(store: StoreApi<T>): () => void {
  const state = store.getState()
  return () => store.setState(state, true)
}
const restores = [useProjectStore, useWorkflowStore, useStageStore, useLocaleStore, useEditorStore, useCharacterStore, useLLMStore]
  .map(store => snapshot(store as StoreApi<unknown>))

let root: Root | undefined
let host: HTMLDivElement | undefined
let invoke: ReturnType<typeof vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>>
let pendingStates: PendingFinalizedCharacterStateCandidate[]
let pendingDecisions: number
let store: {
  saveAll: ReturnType<typeof vi.fn>
  deleteCharacter: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
}

const button = (name: string | RegExp) => [...document.querySelectorAll('button')]
  .find(candidate => typeof name === 'string'
    ? candidate.textContent === name || candidate.getAttribute('aria-label') === name
    : name.test(candidate.textContent ?? ''))
const click = async (name: string | RegExp) => {
  const target = button(name)
  expect(target, String(name)).toBeTruthy()
  await act(async () => target!.click())
}
const banner = () => host!.querySelector('[aria-label="待处理的角色建议"]')
/** 纸墨对话框标题下的说明，也是对话框的无障碍描述。 */
const dialogDescription = () => {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  return dialog ? document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent ?? null : null
}
/** 外发确认这一步作者读到的全文：发什么、发给哪个模型与端点、确认前不写名单。 */
const fixtureConsent = [
  '本次粘贴及选中文件的全部文本将发送到以下模型端点，用于提取角色卡。提取后需预览并确认，才会写入角色名单；不会直接覆盖角色名单。',
  '',
  '模型：夹具模型 (fixture-1)',
  '端点：https://fixture.example/v1',
  '',
  '是否发送并提取？',
].join('\n')

async function render() {
  await act(async () => root!.render(<StageCharacters projectKey={session.projectPath} />))
}

beforeEach(async () => {
  // 宿主 1200 宽；视口比它窄时焦点移到屏外按钮会滚动页面，滚动事件晚一帧到达时会关掉刚打开的菜单。
  await page.viewport(1280, 960)
  pendingStates = []
  pendingDecisions = 0
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'character-proposal:list-pending-finalized') return Array.from({ length: pendingDecisions }, (_, index) =>
      ({ proposalBatchId: `cpb-${index}`, revision: 1, finalizationId: `final-${index}` }))
    if (channel === 'finalized-character:list-state-candidates') return pendingStates.map(candidate => ({
      draftId: 7, candidateKey: candidate.candidateKey, finalizationId: 'final-7',
      characterId: candidate.characterId, characterName: candidate.characterName, field: candidate.field }))
    if (channel === 'finalized-character:read-state-candidate') {
      const { candidateKey } = args[0] as { candidateKey: string }
      return pendingStates.find(candidate => candidate.candidateKey === candidateKey)
    }
    if (channel === 'finalized-character:decide-state-candidate') {
      const { candidateKey } = args[0] as { candidateKey: string }
      pendingStates = pendingStates.filter(candidate => candidate.candidateKey !== candidateKey)
      return { candidateKey, operationId: 'decision', payloadHash: 'd'.repeat(64), decision: 'accept', idempotent: false }
    }
    if (channel === 'character-avatar:read-batch') return { success: true, avatars: [] }
    if (channel === 'db:project-core-get') return null
    throw new Error(`未配置调用：${channel}`)
  })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: () => () => {} } })
  useProjectStore.setState({ currentProject: { id: session.projectId, path: session.projectPath, sessionLease: session.leaseId, name: '雨夜列车', novelConfig: {} } as unknown as ProjectData })
  setActiveProjectSessionContext(session)
  useWorkflowStore.setState({ activeRuns: [], history: [], waitingRuns: {}, globalLogs: [] })
  useLocaleStore.setState({ locale: 'zh-CN' })
  store = {
    saveAll: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => true),
    load: vi.fn(async () => undefined),
  }
  useCharacterStore.setState({
    characters: [linzhou, shenyan], dataProjectKey: session.projectPath, dataProjectSession: session, loadingProjectKey: null, lastError: null,
    identityBusy: false, saving: false, selectedId: linzhou.characterId, rosterRevision: 1, ...store,
  } as never)
  host = document.createElement('div')
  host.className = 'paper-ink stage-shell'
  host.style.cssText = 'width: 1200px; height: 900px; display: flex'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  setActiveProjectSessionContext(null)
  for (const restore of restores) restore()
  vi.restoreAllMocks()
})

describe('角色名单', () => {
  it.each([
    { cast: [linzhou], count: '1 character · page 1 / 1' },
    { cast: [linzhou, shenyan], count: '2 characters · page 1 / 1' },
  ])('英文名单底栏按人数用单复数，悬停能看到完整的人数与页码：$count', async ({ cast, count }) => {
    useLocaleStore.setState({ locale: 'en-US' })
    useCharacterStore.setState({ characters: cast })
    await render()
    const foot = host!.querySelector<HTMLElement>('.cast-roster-foot span')!
    expect([foot.textContent, foot.title]).toEqual([count, count])
  })

  it('英文名单页两个按钮不重叠，底栏人数与页码不折行', async () => {
    useLocaleStore.setState({ locale: 'en-US' })
    useCharacterStore.setState({ characters: [linzhou] })
    await render()
    const [add, paste] = [...host!.querySelectorAll<HTMLElement>('.cast-roster-actions .pi-btn')]
    const a = add.getBoundingClientRect()
    const b = paste.getBoundingClientRect()
    const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    const clipped = [add, paste].filter(button => button.scrollWidth > button.clientWidth + 1).map(button => button.textContent)
    const foot = host!.querySelector<HTMLElement>('.cast-roster-foot span')!
    const lines = Math.round(foot.getBoundingClientRect().height / parseFloat(getComputedStyle(foot).lineHeight))
    const footClipped = foot.scrollWidth > foot.clientWidth + 1
    expect({ overlap, clipped, lines, footClipped }).toEqual({ overlap: false, clipped: [], lines: 1, footClipped: false })
  })

  // 740 与 994 是 1024、1280 宽窗口里角色名单页实测的宽度，600 是 1280 宽窗口开着运行侧页时的宽度（#465）。
  const fitCases = (['en-US', 'zh-CN'] as const).flatMap(locale => [600, 740, 994].map(width => ({ locale, width })))
  it.each(fitCases)('$locale 界面、名单页 $width 宽：按钮不超出名单栏，定位下拉框放得下每个选项，档案首行的输入框都留得出写字的地方', async ({ locale, width }) => {
    useLocaleStore.setState({ locale })
    useCharacterStore.setState({ characters: [linzhou] })
    host!.style.width = `${width}px`
    await render()
    const roster = host!.querySelector('.cast-roster')!.getBoundingClientRect()
    const overflowing = [...host!.querySelectorAll<HTMLElement>('.cast-roster-actions .pi-btn')]
      .filter(button => button.getBoundingClientRect().right > roster.right)
      .map(button => button.textContent)
    // 原生下拉框的箭头画在内容区里：同样样式、只含这一个选项、按内容取宽的副本有多宽，选中它时就要多宽才放得下。
    const select = host!.querySelector<HTMLSelectElement>('.cast-select')!
    const clippedRoles = [...select.options].filter(option => {
      const probe = select.cloneNode(false) as HTMLSelectElement
      probe.append(option.cloneNode(true))
      probe.style.cssText = 'position: absolute; visibility: hidden; width: auto; min-width: 0'
      select.parentElement!.append(probe)
      const needed = probe.getBoundingClientRect().width
      probe.remove()
      return needed > select.getBoundingClientRect().width
    }).map(option => option.textContent)
    // 至少放得下三个汉字。
    const crampedInputs = [...host!.querySelectorAll<HTMLInputElement>('.cast-row-fields input')].filter(input => {
      const style = getComputedStyle(input)
      return input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) < 3 * parseFloat(style.fontSize)
    }).map(input => input.closest('.cast-field')?.querySelector('label')?.textContent)
    expect({ overflowing, clippedRoles, crampedInputs }).toEqual({ overflowing: [], clippedRoles: [], crampedInputs: [] })
  })

  it('名单列出全部角色，改动后保存角色走名单的保存', async () => {
    await render()
    const rows = [...host!.querySelectorAll('.cast-row')].map(row => row.querySelector('.cast-row-name')?.textContent)
    expect(rows).toEqual(['林舟', '沈砚'])
    expect(host!.querySelector('.cast-profile-name')?.textContent).toBe('林舟')

    const motivation = [...host!.querySelectorAll('.cast-field')].find(field => field.textContent?.startsWith('动机'))!.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(motivation, '弄清母亲为什么登上那班车')
      motivation.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(useCharacterStore.getState().characters[0].motivation).toBe('弄清母亲为什么登上那班车')

    expect(host!.querySelectorAll('.pi-btn--primary')).toHaveLength(1)
    await click('保存角色')
    expect(store.saveAll).toHaveBeenCalledWith(session.projectPath)
  })

  it('删除角色先出危险确认，取消不删；确认后删除选中的那位', async () => {
    await render()
    await click('角色的更多操作')
    await click('删除角色「林舟」…')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('删除角色「林舟」？')
    await click('取消')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(store.deleteCharacter).not.toHaveBeenCalled()

    await click('角色的更多操作')
    await click('删除角色「林舟」…')
    await click('删除角色')
    await vi.waitFor(() => expect(store.deleteCharacter).toHaveBeenCalledWith(linzhou.characterId, session.projectPath))
  })

  it('角色决策与状态建议合成一条提示条，接受一条后它从提示条消失并重读名单', async () => {
    pendingDecisions = 1
    pendingStates = [stateCandidate('s-location', 'location', '北塔'), stateCandidate('s-items', 'keyItems', '第三封信')]
    await render()
    await vi.waitFor(() => expect(banner()?.textContent).toContain('3 项待处理的角色建议'))
    expect(host!.querySelectorAll('.cast-suggestions')).toHaveLength(1)
    expect(host!.querySelectorAll('.cast-suggestion[data-kind="decision"]')).toHaveLength(1)
    expect(host!.querySelectorAll('.cast-suggestion[data-kind="state"]')).toHaveLength(2)

    const review = [...host!.querySelectorAll('.cast-suggestion[data-kind="state"]')]
      .find(row => row.textContent?.includes('位置'))!.querySelector('button')!
    await act(async () => review.click())
    await vi.waitFor(() => expect(banner()?.textContent).toContain('建议：北塔'))
    await click('接受状态建议')

    await vi.waitFor(() => expect(banner()?.textContent).toContain('2 项待处理的角色建议'))
    expect(store.load).toHaveBeenCalled()
    expect(invoke.mock.calls.find(([channel]) => channel === 'finalized-character:decide-state-candidate')?.[1])
      .toMatchObject({ candidateKey: 's-location', decision: 'accept' })
    expect(banner()?.textContent).not.toContain('位置')
    expect(banner()?.textContent).toContain('关键物品')
  })

  /** Electron 把主进程的异常包成这样交给页面。 */
  const ipcError = (channel: string) => new Error(`Error invoking remote method '${channel}': Error: 项目会话已失效`)

  it('两份待处理列表都读取失败：标题写读取失败，说明可以重新读取，不露原始报错', async () => {
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'character-proposal:list-pending-finalized' || channel === 'finalized-character:list-state-candidates'
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.querySelector('.pi-notice-title')?.textContent).toBe('角色建议读取失败'))
    expect(banner()!.querySelector('.pi-notice-text')?.textContent).toBe('定稿与导入留下的角色建议这次没读出来，可以重新读取。')
    expect([...banner()!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['重新读取'])
    expect(banner()!.textContent).not.toContain('Error invoking remote method')
    expect(banner()!.textContent).not.toContain('项目会话已失效')
  })

  it('已有待处理的建议、另一份列表读取失败：提示条照常列出，失败的部分用一句话说明并给「重新读取」，不露原始报错', async () => {
    pendingDecisions = 1
    const base = invoke.getMockImplementation()!
    let failing = true
    invoke.mockImplementation(async (channel, ...args) => failing && channel === 'finalized-character:list-state-candidates'
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.querySelector('[role="alert"]')?.textContent).toBe('有一部分角色建议这次没读出来或没处理完，可以重新读取。重新读取'))
    expect(banner()!.querySelector('.pi-notice-title')?.textContent).toBe('1 项待处理的角色建议')
    expect(banner()!.textContent).not.toContain('Error invoking remote method')
    failing = false
    await act(async () => banner()!.querySelector<HTMLButtonElement>('[role="alert"] button')!.click())
    await vi.waitFor(() => expect(banner()!.querySelector('[role="alert"]')).toBeNull())
    expect(banner()!.querySelector('.pi-notice-title')?.textContent).toBe('1 项待处理的角色建议')
  })

  it('部分建议读取失败时提示条用提醒色；收起列表后失败说明与「重新读取」仍然看得到', async () => {
    pendingDecisions = 1
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'finalized-character:list-state-candidates'
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.querySelector('[role="alert"]')).toBeTruthy())
    expect(banner()!.querySelector('.pi-notice')?.getAttribute('data-tone')).toBe('warn')
    await click('收起')
    expect(banner()!.querySelector('.cast-suggestion-list')).toBeNull()
    const alert = banner()!.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toBe('有一部分角色建议这次没读出来或没处理完，可以重新读取。重新读取')
    expect(alert!.getBoundingClientRect().height).toBeGreaterThan(0)
  })

  it('接受状态建议已提交、随后刷新状态建议列表失败：只说这次没读出来、可以重新读取，不说名单没改', async () => {
    pendingDecisions = 1
    pendingStates = [stateCandidate('s-location', 'location', '北塔')]
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'finalized-character:list-state-candidates'
      && invoke.mock.calls.some(([called]) => called === 'finalized-character:decide-state-candidate')
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.textContent).toContain('2 项待处理的角色建议'))
    await click('检查定稿状态建议')
    await vi.waitFor(() => expect(banner()?.textContent).toContain('建议：北塔'))
    await click('接受状态建议')
    await vi.waitFor(() => expect(banner()?.querySelector('[role="alert"]')?.textContent).toBe('有一部分角色建议这次没读出来或没处理完，可以重新读取。重新读取'))
    expect(store.load).toHaveBeenCalled()
  })

  it('接受最后一条状态建议后名单重读、角色决策列表随之读取失败：标题写读取失败，说明只说可以重新读取', async () => {
    pendingStates = [stateCandidate('s-location', 'location', '北塔')]
    store.load.mockImplementation(async () => { useCharacterStore.setState({ rosterRevision: 2 }) })
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => channel === 'character-proposal:list-pending-finalized'
      && invoke.mock.calls.some(([called]) => called === 'finalized-character:decide-state-candidate')
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.textContent).toContain('1 项待处理的角色建议'))
    await click('检查定稿状态建议')
    await vi.waitFor(() => expect(banner()?.textContent).toContain('建议：北塔'))
    await click('接受状态建议')
    await vi.waitFor(() => expect(banner()?.querySelector('.pi-notice-title')?.textContent).toBe('角色建议读取失败'))
    expect(banner()!.querySelector('.pi-notice-text')?.textContent).toBe('定稿与导入留下的角色建议这次没读出来，可以重新读取。')
  })

  it('读取失败后点「重新读取」重读两份列表，读到就换成待处理的建议', async () => {
    pendingDecisions = 1
    const base = invoke.getMockImplementation()!
    let failing = true
    invoke.mockImplementation(async (channel, ...args) => failing && (channel === 'character-proposal:list-pending-finalized' || channel === 'finalized-character:list-state-candidates')
      ? Promise.reject(ipcError(channel)) : base(channel, ...args))
    await render()
    await vi.waitFor(() => expect(banner()?.querySelector('.pi-notice-title')?.textContent).toBe('角色建议读取失败'))
    failing = false
    const retry = [...banner()!.querySelectorAll('button')].find(button => button.textContent === '重新读取')
    expect(retry, '重新读取按钮').toBeTruthy()
    await act(async () => retry!.click())
    await vi.waitFor(() => expect(banner()!.querySelector('.pi-notice-title')?.textContent).toBe('1 项待处理的角色建议'))
    expect(banner()!.querySelectorAll('[role="alert"]')).toHaveLength(0)
  })

  it('没有待处理的建议时不显示提示条', async () => {
    await render()
    await vi.waitFor(() => expect(invoke.mock.calls.some(([channel]) => channel === 'finalized-character:list-state-candidates')).toBe(true))
    expect(banner()).toBeNull()
  })

  it('导入角色卡用纸墨对话框，外发确认是同一对话框的第二步，不弹旧确认框', async () => {
    useLLMStore.setState({ models: [{ id: 'm1', name: '夹具模型', modelName: 'fixture-1', baseUrl: 'https://fixture.example/v1' }], defaultModelId: 'm1' } as never)
    const legacyConfirm = vi.spyOn(window, 'confirm')
    await render()
    await click('粘贴 / 导入角色卡')
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog().classList.contains('pi-dialog')).toBe(true)
    expect(dialog().closest('.paper-ink')).toBeTruthy()
    const source = dialog().querySelector<HTMLTextAreaElement>('textarea')!
    expect(source.classList.contains('pi-input')).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(source, '林舟：末班车上的乘客。')
      source.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click('AI 提取并预览')
    expect(dialogDescription()).toBe(fixtureConsent)
    expect(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).toHaveLength(1)
    await click('返回')
    expect(dialog().querySelector('textarea')?.value).toBe('林舟：末班车上的乘客。')
    expect(legacyConfirm).not.toHaveBeenCalled()
  })

  it('粘贴角色卡的全文框按 9 行高显示，不被单行输入框的高度压成一行', async () => {
    await render()
    await click('粘贴 / 导入角色卡')
    const source = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
    const line = parseFloat(getComputedStyle(source).lineHeight)
    expect(source.rows).toBe(9)
    expect(source.getBoundingClientRect().height).toBeGreaterThanOrEqual(line * 9)
  })

  it('头像按钮只在基础设定视图里；当前状态与关系图谱视图没有点了没反应的头像按钮', async () => {
    await render()
    expect(button('选择头像')).toBeTruthy()
    for (const view of ['当前状态', '关系图谱']) {
      await click(view)
      expect(button('选择头像'), view).toBeUndefined()
    }
    await click('基础设定')
    expect(button('选择头像')).toBeTruthy()
  })

  // 角色名单页宽：1024 宽窗口约 738px，1280 宽约 994px（窗口宽减去流程脊与边距）。
  const profileHeadCases = (['zh-CN', 'en-US'] as const).flatMap(locale => ([[1024, 738], [1280, 994]] as const)
    .flatMap(([windowWidth, pageWidth]) => [
      { locale, windowWidth, pageWidth, name: '林舟', expected: { clipped: false, wrapped: false } },
      { locale, windowWidth, pageWidth, name: '林舟远赴北境寻找失踪灯塔的守灯人', expected: { wrapped: true } },
    ]))
  it.each(profileHeadCases)('档案头按内容换行：$windowWidth 宽、$locale、名字「$name」', async ({ locale, pageWidth, name, expected }) => {
    useLocaleStore.setState({ locale })
    useCharacterStore.setState({ characters: [{ ...linzhou, name }, shenyan] } as never)
    host!.style.width = `${pageWidth}px`
    await render()
    const title = host!.querySelector<HTMLElement>('.cast-profile-name')!
    const save = button(locale === 'en-US' ? 'Save character' : '保存角色')!
    const [titleBox, saveBox] = [title.getBoundingClientRect(), save.getBoundingClientRect()]
    const avatarBox = host!.querySelector<HTMLElement>('.cast-profile-avatar')!.getBoundingClientRect()
    const overlap = titleBox.left < saveBox.right && saveBox.left < titleBox.right && titleBox.top < saveBox.bottom && saveBox.top < titleBox.bottom
    const observed = { clipped: title.scrollWidth > title.clientWidth + 1, wrapped: saveBox.top >= titleBox.bottom }
    // 名字总和头像在同一行，不会自己掉到头像下面。
    const besideAvatar = titleBox.top < avatarBox.bottom && titleBox.left >= avatarBox.right
    expect({ text: title.textContent, overlap, besideAvatar, ...('clipped' in expected ? observed : { wrapped: observed.wrapped }) })
      .toEqual({ text: name, overlap: false, besideAvatar: true, ...expected })
  })

  it.each(['zh-CN', 'en-US'] as const)('没有选中角色时的档案头没有头像，标题不按头像扣宽度（%s）', async locale => {
    useLocaleStore.setState({ locale })
    useCharacterStore.setState({ characters: [], selectedId: null } as never)
    host!.style.width = '600px'
    await render()
    const title = host!.querySelector<HTMLElement>('.cast-profile-name')!
    expect({ avatar: host!.querySelector('.cast-profile-avatar'), text: title.textContent, clipped: title.scrollWidth > title.clientWidth + 1 })
      .toEqual({ avatar: null, text: locale === 'en-US' ? 'Character profile' : '角色档案', clipped: false })
  })

  it('1024 宽窗口里的关系图谱：工具条与人物侧栏的控件都在图谱框里、点得到；宽时显示中心人物', async () => {
    // 1024 宽窗口去掉流程脊与边距，角色名单页约 738px：名单 272，档案两侧各留 40，图谱框只剩约 385。
    host!.style.width = '738px'
    await render()
    await click('关系图谱')
    const graph = host!.querySelector<HTMLElement>('.cast-graph')!
    const controls = ['缩小关系图谱', '放大关系图谱', '适合视图', '重置图谱布局', '折叠人物侧栏', '搜索图谱人物', '下一页人物']
    // 只看名单页自己的层：被裁掉的控件在那个点上不会出现，被页内元素盖住时最上面的是别人。别的用例留下的全局通知不算。
    const unreachable = () => controls.filter(label => {
      const control = graph.querySelector<HTMLElement>(`[aria-label="${label}"]`)
      if (!control) return true
      const rect = control.getBoundingClientRect()
      const hit = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).find(element => host!.contains(element))
      return !hit || !control.contains(hit)
    })
    await vi.waitFor(() => expect(unreachable()).toEqual([]))

    host!.style.width = '1200px'
    await vi.waitFor(() => {
      const centerLabel = [...graph.querySelectorAll<HTMLElement>('span')].find(span => span.textContent === '中心: 林舟')
      expect(centerLabel, '中心人物').toBeTruthy()
      expect(getComputedStyle(centerLabel!).display).not.toBe('none')
    })
    expect(unreachable()).toEqual([])
  })

  it('外发确认不能被第一步按钮上的双击或连按回车跳过，只有在第二步单独确认才发送', async () => {
    useLLMStore.setState({ models: [{ id: 'm1', name: '夹具模型', modelName: 'fixture-1', baseUrl: 'https://fixture.example/v1' }], defaultModelId: 'm1' } as never)
    const startWorkflow = vi.fn(async () => 'r1')
    useWorkflowStore.setState({ startWorkflow: startWorkflow as never })
    await render()
    await click('粘贴 / 导入角色卡')
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
    const source = dialog().querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(source, '林舟：末班车上的乘客。')
      source.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const consentShown = () => dialogDescription() === fixtureConsent

    await userEvent.dblClick(button('AI 提取并预览')!)
    await vi.waitFor(() => expect(consentShown()).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(startWorkflow).not.toHaveBeenCalled()

    await click('返回')
    button('AI 提取并预览')!.focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(consentShown()).toBe(true))
    expect(document.activeElement?.textContent).toBe('返回')
    await userEvent.keyboard('{Enter}')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(startWorkflow).not.toHaveBeenCalled()
    expect(consentShown()).toBe(false)

    await click('AI 提取并预览')
    await click('发送并提取')
    await vi.waitFor(() => expect(startWorkflow).toHaveBeenCalledTimes(1))
  })
})
