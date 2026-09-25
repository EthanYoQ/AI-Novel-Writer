import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'

import '../../../../index.css'
import type { ProjectData } from '../../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../../shared/project-session-context'
import { useCharacterStore, type CharacterCard } from '../../../../stores/character-store'
import { useEditorStore } from '../../../../stores/editor-store'
import { useLocaleStore } from '../../../../stores/locale-store'
import { useProjectStore } from '../../../../stores/project-store'
import CharacterEditor from '../../../editor/CharacterEditor'
import { useCharacterAvatar } from '../../../editor/use-character-avatar'
import RelationshipGraph from '../../../editor/RelationshipGraph'
import { GRAPH_NODE_LIMIT } from '../../../editor/relationship-graph-layout'
import CharactersView from '../../../panels/sidebar/CharactersView'
import ShellV2 from '../ShellV2'

const path = 'C:\\novels\\f05-writer-graph'
const project = {
  id: 'f05-writer-graph', sessionLease: 'f05-lease', name: '图谱验证', path,
  novelConfig: {
    genre: '', subGenre: '', targetAudience: '', totalChapters: 10, wordsPerChapter: 2500,
    plotStructure: 'three_act', narrativePOV: 'third_limited', coreOutline: '', worldSetting: '',
    goldenFinger: '', protagonistProfile: '', globalGuidance: '',
  },
  characterStates: '', createdAt: '', updatedAt: '',
} as ProjectData
const originalCharacters = useCharacterStore.getState()
const originalEditor = useEditorStore.getState()
const originalProject = useProjectStore.getState()
const originalLocale = useLocaleStore.getState()

let host: HTMLDivElement
let root: Root
let textCalls: Array<{ text: string; x: number; y: number }>
let arcCalls: number[]
let translate: ReturnType<typeof vi.fn>
let scale: ReturnType<typeof vi.fn>
let openCharacter: (characterId: string) => void
let invoke: ReturnType<typeof vi.fn>
let originalApiDescriptor: PropertyDescriptor | undefined

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function card(index: number): CharacterCard {
  const name = `角色${String(index).padStart(3, '0')}`
  return {
    characterId: `stable-${index}`, name, role: 'supporting', gender: '', age: '', appearance: '',
    personality: '', background: '', abilities: '', motivation: '', arc: '', notes: '',
    relationships: index < 999
      ? JSON.stringify([{ target: `角色${String(index + 1).padStart(3, '0')}`, targetCharacterId: `stable-${index + 1}`, relation: '相连' }])
      : '',
  }
}

async function render(characters: CharacterCard[]) {
  useCharacterStore.setState({ characters, dataProjectKey: path, loadingProjectKey: null, lastError: null, identityBusy: false })
  await act(async () => root.render(
    <ShellV2 theme="paper" bottomOpen={false} titleBar={<span>图谱验证</span>} rail={<span>书脊</span>}
      sidebar={<CharactersView />} editor={<RelationshipGraph characters={characters} onOpenCharacter={openCharacter} />}
      aiPanel={<span>助手</span>} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />,
  ))
  assertWriter('render')
}

function assertWriter(actionId: string) {
  const shell = host.querySelector<HTMLElement>('[data-shell-presentation="writer"]')
  expect(shell, `${actionId}: Writer shell is absent`).not.toBeNull()
  expect(shell?.dataset.shellPresentation, `${actionId}: shell is not Writer`).toBe('writer')
  expect(shell?.dataset.shellVariant, `${actionId}: shell is not V3`).toBe('v3')
}

beforeEach(async () => {
  await page.viewport(1280, 900)
  host = document.createElement('div')
  host.style.height = '860px'
  document.body.append(host)
  root = createRoot(host)
  textCalls = []
  arcCalls = []
  translate = vi.fn()
  scale = vi.fn()
  openCharacter = vi.fn()
  invoke = vi.fn(async (channel: string, ids: string[]) => ({
    success: channel === 'character-avatar:read-batch',
    avatars: channel === 'character-avatar:read-batch' && ids.includes('stable-0')
      ? [{ characterId: 'stable-0', assetRevision: 1, mime: 'image/png', base64: btoa('avatar') }]
      : [],
  }))
  originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'aiNovelAPI')
  window.aiNovelAPI = { invoke } as unknown as typeof window.aiNovelAPI
  setActiveProjectSessionContext({ projectId: project.id, leaseId: project.sessionLease!, projectPath: path })
  useProjectStore.setState({ ...originalProject, currentProject: project })
  useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
  useLocaleStore.setState({ ...originalLocale, locale: 'zh-CN', initialized: true })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'start', textBaseline: 'alphabetic',
    clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), translate, scale,
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(), clip: vi.fn(), drawImage: vi.fn(),
    arc(_x: number, _y: number, radius: number) { arcCalls.push(radius) },
    fillText(text: string, x: number, y: number) { textCalls.push({ text, x, y }) },
  }) as unknown as CanvasRenderingContext2D)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useCharacterStore.setState(originalCharacters)
  useEditorStore.setState(originalEditor, true)
  useProjectStore.setState(originalProject)
  useLocaleStore.setState(originalLocale)
  setActiveProjectSessionContext(null)
  if (originalApiDescriptor) Object.defineProperty(window, 'aiNovelAPI', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'aiNovelAPI')
  vi.restoreAllMocks()
})

it('U10.A07, U11.A01/A02/A07: Writer 人物卡头像和图谱交互补充证据', async () => {
  const characters = Array.from({ length: 6 }, (_, index) => card(index))
  await render(characters)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const avatar = host.querySelector<HTMLImageElement>('[data-character-id="stable-0"] img')
  expect(avatar?.alt).toBe('角色000头像') // U10.A07: 真实人物卡按稳定 ID 显示读取到的头像
  expect(avatar?.src).toMatch(/^blob:/)
  expect(invoke).toHaveBeenCalledWith('character-avatar:read-batch', expect.arrayContaining(['stable-0']), expect.anything())

  const canvas = host.querySelector('canvas')!
  const radii = [...new Set(arcCalls)]
  assertWriter('U11.A01')
  expect(radii).toEqual(expect.arrayContaining([16, 18, 20, 22, 24])) // U11.A01: 五档重要度绘制为不同节点半径
  expect(textCalls.map(call => call.text)).toContain('角色000')
  assertWriter('U11.A02')
  await act(async () => (host.querySelector('[aria-label="以角色005为中心"]') as HTMLButtonElement).click())
  expect(host.textContent).toContain('中心: 角色005') // U11.A02
  expect(canvas.dataset.renderedNodeCount).toBe('6')

  assertWriter('U11.A07')
  await act(async () => page.getByRole('button', { name: '折叠人物侧栏' }).click())
  expect(host.querySelector('[aria-label="图谱人物侧栏"]')).toBeNull() // U11.A07
  assertWriter('U11.A07-expand')
  await act(async () => page.getByRole('button', { name: '展开人物侧栏' }).click())
  assertWriter('U11.A08-callback')
  await act(async () => (host.querySelector('[data-graph-character-id="stable-5"]') as HTMLButtonElement).click())
  expect(openCharacter).toHaveBeenCalledWith('stable-5') // U11.A08 mock-caller 只证实稳定 ID 回调；下方 browser 用例覆盖真实路由/字段，Electron 级资格仍待验收。
})

it('同会话头像保存与移除后，V3 侧栏批量头像立即重读对应稳定 ID', async () => {
  function AvatarActionProbe() {
    const avatar = useCharacterAvatar('stable-0', true)
    return <div data-avatar-staged={avatar.staged}>
      <button onClick={() => { void avatar.chooseAvatar() }}>选择测试头像</button>
      <button onClick={() => { void avatar.commitStaged() }}>提交测试头像</button>
      <button onClick={avatar.stageRemoval}>移除测试头像</button>
    </div>
  }
  let saved: { characterId: string; assetRevision: number; mime: 'image/png'; base64: string } | null = {
    characterId: 'stable-0', assetRevision: 1, mime: 'image/png', base64: btoa('gold'),
  }
  invoke.mockImplementation(async (channel: string, ids: string[]) => {
    if (channel === 'character-avatar:read-batch') return { success: true, avatars: saved && ids.includes('stable-0') ? [saved] : [] }
    if (channel === 'character-avatar:choose') return { success: true, cancelled: false,
      image: { characterId: 'stable-0', mime: 'image/png', base64: btoa('blue') } }
    if (channel === 'character-avatar:commit') {
      saved = { characterId: 'stable-0', assetRevision: 2, mime: 'image/png', base64: btoa('blue') }
      return { success: true, avatar: saved }
    }
    if (channel === 'character-avatar:remove') { saved = null; return { success: true } }
    return { success: false }
  })
  useCharacterStore.setState({ characters: [card(0)], dataProjectKey: path, loadingProjectKey: null, lastError: null })
  await act(async () => root.render(
    <ShellV2 theme="paper" bottomOpen={false} titleBar={<span>图谱验证</span>} rail={<span>书脊</span>}
      sidebar={<CharactersView />} editor={<AvatarActionProbe />}
      aiPanel={<span>助手</span>} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />,
  ))
  const sidebarImage = () => host.querySelector<HTMLImageElement>('[data-character-id="stable-0"] img')
  await vi.waitFor(async () => expect(await fetch(sidebarImage()!.src).then(response => response.text())).toBe('gold'))
  await act(async () => { await page.getByRole('button', { name: '选择测试头像' }).click() })
  await vi.waitFor(() => expect(host.querySelector('[data-avatar-staged]')?.getAttribute('data-avatar-staged')).toBe('true'))
  await act(async () => { await page.getByRole('button', { name: '提交测试头像' }).click() })
  await vi.waitFor(async () => expect(await fetch(sidebarImage()!.src).then(response => response.text())).toBe('blue'))
  await act(async () => { await page.getByRole('button', { name: '移除测试头像' }).click() })
  await act(async () => { await page.getByRole('button', { name: '提交测试头像' }).click() })
  await vi.waitFor(() => expect(sidebarImage()).toBeNull())
})

it('U11.A08: V3 Writer 图谱打开同名角色对应的稳定 ID 档案', async () => {
  const characters = [
    { ...card(0), characterId: 'writer-profile-0001', name: '同名角色', notes: '档案哨兵-甲' },
    { ...card(1), characterId: 'writer-profile-0002', name: '同名角色', notes: '档案哨兵-乙' },
  ]
  useCharacterStore.setState({
    characters,
    selectedId: 'writer-profile-0001',
    selectedName: '同名角色',
    dataProjectKey: path,
    dataProjectSession: { projectId: project.id, leaseId: project.sessionLease!, projectPath: path },
    loadingProjectKey: null,
    lastError: null,
    identityBusy: false,
    rosterRevision: 1,
  })

  await act(async () => root.render(
    <ShellV2 theme="paper" bottomOpen={false} titleBar={<span>图谱验证</span>} rail={<span>书脊</span>}
      sidebar={<CharactersView />} editor={<CharacterEditor projectKey={path} />}
      aiPanel={<span>助手</span>} bottom={<span>任务</span>} statusBar={<span>本地写作</span>} />,
  ))
  assertWriter('U11.A08-profile-before')
  const notesField = () => host.querySelector<HTMLTextAreaElement>('textarea[placeholder="输入备注..."]')
  expect(notesField()?.value).toBe('档案哨兵-甲')

  await act(async () => page.getByRole('button', { name: '关系图谱', exact: true }).click())
  expect(host.querySelector('canvas')).not.toBeNull()
  const targetCharacter = host.querySelector<HTMLButtonElement>('[data-graph-character-id="writer-profile-0002"]')!
  expect(targetCharacter.textContent).toContain('同名角色')
  await act(async () => targetCharacter.click())

  assertWriter('U11.A08-profile-after')
  expect(useCharacterStore.getState().selectedId).toBe('writer-profile-0002')
  expect(notesField()?.value).toBe('档案哨兵-乙')
  expect(notesField()?.value).not.toBe('档案哨兵-甲')
  expect(useCharacterStore.getState().characters.map(character => character.notes)).toEqual(['档案哨兵-甲', '档案哨兵-乙'])
})

it('U11.A03/A04/A05/A06: Writer 图谱拖动、平移、缩放、适应和复位', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLCanvasElement.prototype, 'offsetHeight', 'get').mockReturnValue(300)
  vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
  await render([card(0), card(1)])
  const canvas = host.querySelector('canvas')!
  const before = textCalls.find(call => call.text === '角色000')!
  const pointer = (type: string, x: number, y: number) => canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, clientX: x, clientY: y,
  }))
  assertWriter('U11.A03')
  await act(async () => { pointer('pointerdown', before.x / 2, (before.y - 40) / 2); pointer('pointermove', before.x / 2 + 30, (before.y - 40) / 2 + 10); pointer('pointerup', before.x / 2 + 30, (before.y - 40) / 2 + 10) })
  expect(textCalls.filter(call => call.text === '角色000').at(-1)?.x).not.toBe(before.x) // U11.A03
  const offsetBeforePan = translate.mock.calls.at(-3)!
  assertWriter('U11.A04')
  await act(async () => { pointer('pointerdown', 390, 290); pointer('pointermove', 370, 270); pointer('pointerup', 370, 270) })
  expect(translate.mock.calls.at(-3)).toEqual([
    offsetBeforePan[0] - 40, offsetBeforePan[1] - 40,
  ]) // U11.A04: canvas/clientWidth = 2, 空白拖动各 -20px 应改变绘制偏移各 -40px
  const beforeZoom = host.textContent
  assertWriter('U11.A05')
  await act(async () => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 })))
  expect(beforeZoom).toContain('100%')
  expect(host.textContent).toContain('110%') // U11.A05
  assertWriter('U11.A06-fit')
  const fitCallsBefore = scale.mock.calls.length
  await act(async () => page.getByRole('button', { name: '适合视图' }).click())
  expect(scale.mock.calls.length).toBeGreaterThan(fitCallsBefore) // U11.A06: 适合视图确实触发新的缩放
  assertWriter('U11.A06-reset')
  await act(async () => page.getByRole('button', { name: '重置图谱布局' }).click())
  expect(textCalls.filter(call => call.text === '角色000').at(-1)).toMatchObject(before) // U11.A06
  expect(new Set(invoke.mock.calls.map(([channel]) => channel))).toEqual(new Set([
    'character-avatar:read-batch', 'character-proposal:list-pending-finalized', 'finalized-character:list-state-candidates',
  ]))
})

it('U11.A13: Writer 的 1000 人图谱全部页面和搜索可达，绘制与头像批量有界', async () => {
  const characters = Array.from({ length: 1000 }, (_, index) => card(index))
  await render(characters)
  const canvas = host.querySelector('canvas')!
  expect(Number(canvas.dataset.renderedNodeCount)).toBe(GRAPH_NODE_LIMIT)
  const seen = new Set<string>()
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    for (const button of host.querySelectorAll<HTMLButtonElement>('[data-graph-character-id]')) seen.add(button.dataset.graphCharacterId!)
    if (pageIndex < 19) await act(async () => (host.querySelector('[aria-label="下一页人物"]') as HTMLButtonElement).click())
  }
  expect(seen.size).toBe(1000) // 20 页逐页可达，而非只测末尾一人
  await act(async () => page.getByRole('textbox', { name: '搜索图谱人物' }).fill('角色999'))
  expect(host.querySelector('[data-graph-character-id="stable-999"]')).not.toBeNull()
  await act(async () => (host.querySelector('[data-graph-character-id="stable-999"]') as HTMLButtonElement).click())
  expect(openCharacter).toHaveBeenCalledWith('stable-999')
  const reads = invoke.mock.calls.filter(([channel]) => channel === 'character-avatar:read-batch')
  expect(reads.length).toBeGreaterThan(0)
  expect(reads.every(([, ids]) => Array.isArray(ids) && ids.length <= GRAPH_NODE_LIMIT)).toBe(true)
  expect(new Set(invoke.mock.calls.map(([channel]) => channel))).toEqual(new Set([
    'character-avatar:read-batch', 'character-proposal:list-pending-finalized', 'finalized-character:list-state-candidates',
  ]))
})
