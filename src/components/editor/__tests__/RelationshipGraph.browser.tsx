import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import { useLocaleStore } from '../../../stores/locale-store'
import RelationshipGraph from '../RelationshipGraph'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface FillTextCall {
  text: string
  fillStyle: string
  x: number
  y: number
}

let root: Root
let container: HTMLDivElement
let fillTextCalls: FillTextCall[]
let strokeStyleCalls: string[]
let saveCalls: ReturnType<typeof vi.fn>
let restoreCalls: ReturnType<typeof vi.fn>
let translateCalls: ReturnType<typeof vi.fn>
let scaleCalls: ReturnType<typeof vi.fn>
const originalLocaleState = useLocaleStore.getState()

async function waitForAnimationFrames(count: number) {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  fillTextCalls = []
  strokeStyleCalls = []
  saveCalls = vi.fn()
  restoreCalls = vi.fn()
  translateCalls = vi.fn()
  scaleCalls = vi.fn()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const context = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      clearRect: vi.fn(),
      save: saveCalls,
      restore: restoreCalls,
      translate: translateCalls,
      scale: scaleCalls,
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke() {
        strokeStyleCalls.push(String(this.strokeStyle))
      },
      arc: vi.fn(),
      fill: vi.fn(),
      fillText(text: string, x: number, y: number) {
        fillTextCalls.push({ text, fillStyle: String(this.fillStyle), x, y })
      },
    }
    return context as unknown as CanvasRenderingContext2D
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.classList.remove('paper', 'galaxy', 'dark')
  useLocaleStore.setState(originalLocaleState)
  vi.restoreAllMocks()
})

describe('RelationshipGraph readable theme text', () => {
  it('renders the empty state in English when the interface is English', async () => {
    useLocaleStore.setState({ locale: 'en-US' })

    await act(async () => root.render(<RelationshipGraph characters={[]} />))

    expect(container.textContent).toContain('No character data')
    expect(container.textContent).not.toContain('暂无角色数据')
  })

  it.each([
    ['light', 'rgb(43, 42, 38)'],
    ['paper', 'rgb(43, 42, 38)'],
    ['galaxy', 'rgb(224, 236, 244)'],
    ['dark', 'rgb(212, 212, 212)'],
  ])('renders character names with the %s theme text semantic', async (theme, expectedTextColor) => {
    container.className = theme

    await act(async () => root.render(
      <RelationshipGraph characters={[{
        name: '林墨',
        // 修复前该角色姓名固定使用 #54666E，在 galaxy 和 dark 面板上
        // 测得的对比度都低于 3:1。
        role: 'antagonist',
        relationships: '',
      }]} />,
    ))

    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(getComputedStyle(canvas!).color).toBe(expectedTextColor)
    expect(fillTextCalls.find((call) => call.text === '林墨')?.fillStyle).toBe(expectedTextColor)
    expect(saveCalls).toHaveBeenCalled()
    expect(translateCalls).toHaveBeenCalledWith(0, 0)
    expect(scaleCalls).toHaveBeenCalledWith(1, 1)
    expect(restoreCalls).toHaveBeenCalledTimes(saveCalls.mock.calls.length)
  })

  it.each([
    ['light', '#6E6A5F'],
    ['paper', '#6E6A5F'],
    ['galaxy', '#8BA4BE'],
    ['dark', '#A0A0A0'],
  ])('renders relationship labels with the readable %s secondary-text semantic', async (theme, expectedTextColor) => {
    container.className = theme

    await act(async () => root.render(
      <RelationshipGraph characters={[
        {
          name: '林墨',
          role: 'protagonist',
          relationships: JSON.stringify([{ target: '周砧', relation: '共同追查' }]),
        },
        { name: '周砧', role: 'supporting', relationships: '' },
      ]} />,
    ))

    expect(fillTextCalls.find((call) => call.text === '共同追查')?.fillStyle)
      .toBe(expectedTextColor)
  })

  it('renders one compact overview edge for reciprocal details about the same pair', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    const firstRelation = '长期合作并共同调查校园系统背后的数据操控真相'
    const sharedRelation = '在危机中逐渐建立信任'
    const reverseRelation = '尊重她坚持追查真相的勇气'
    const characters = [
      {
        name: '林墨',
        role: 'protagonist',
        relationships: JSON.stringify([
          { target: '周砧', relation: firstRelation },
          { target: '周砧', relation: sharedRelation },
          { target: '周砧', relation: sharedRelation },
        ]),
      },
      {
        name: '周砧',
        role: 'supporting',
        relationships: JSON.stringify([
          { target: '林墨', relation: reverseRelation },
          { target: '林墨', relation: sharedRelation },
        ]),
      },
    ]

    await act(async () => root.render(<RelationshipGraph characters={characters} />))

    expect(fillTextCalls
      .filter(call => call.text !== '林墨' && call.text !== '周砧')
      .map(call => call.text))
      .toEqual(['长期合作并共… +3'])
    const canvas = container.querySelector('canvas')!
    expect(canvas.getAttribute('aria-label')).toBe(
      `角色关系图谱。完整关系：林墨 对 周砧：${firstRelation}；林墨 对 周砧：${sharedRelation}；周砧 对 林墨：${reverseRelation}；周砧 对 林墨：${sharedRelation}`,
    )

    useLocaleStore.setState({ locale: 'en-US' })
    await act(async () => root.render(<RelationshipGraph characters={characters} />))
    expect(canvas.getAttribute('aria-label')).toBe(
      `Character relationship graph. Full relationships: 林墨 to 周砧: ${firstRelation}; 林墨 to 周砧: ${sharedRelation}; 周砧 to 林墨: ${reverseRelation}; 周砧 to 林墨: ${sharedRelation}`,
    )
  })

  it('renders compact Unicode-safe node and relationship labels', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    const longName = '甲🙂乙丙丁戊己庚辛'
    const longRelation = '共同追查校园系统背后真相'

    await act(async () => root.render(
      <RelationshipGraph characters={[
        {
          name: longName,
          role: 'protagonist',
          relationships: JSON.stringify([{ target: '周砧', relation: longRelation }]),
        },
        { name: '周砧', role: 'supporting', relationships: '' },
      ]} />,
    ))

    expect(fillTextCalls.map(call => call.text)).toEqual(expect.arrayContaining([
      '甲🙂乙丙丁戊己庚…',
      '周砧',
      '共同追查校园…',
    ]))
    expect(fillTextCalls.map(call => call.text)).not.toContain(longName)
    expect(fillTextCalls.map(call => call.text)).not.toContain(longRelation)
  })

  it('keeps seven connected character nodes readable in the shipped canvas size', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'offsetWidth', 'get').mockReturnValue(795)
    vi.spyOn(HTMLCanvasElement.prototype, 'offsetHeight', 'get').mockReturnValue(576)
    vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(795)
    vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(576)
    const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚']
    const characters = names.map((name, index) => {
      const targets = index === 0 ? names.slice(1) : [names[(index + 1) % names.length]]
      return {
        name,
        role: index === 0 ? 'protagonist' : 'supporting',
        relationships: JSON.stringify(targets.map(target => ({ target, relation: '推动选择' }))),
      }
    })

    await act(async () => root.render(<RelationshipGraph characters={characters} />))
    await waitForAnimationFrames(125)

    const positions = names.map(name => fillTextCalls.filter(call => call.text === name).at(-1)!)
    const pairDistances = positions.flatMap((position, index) => (
      positions.slice(index + 1).map(other => Math.hypot(other.x - position.x, other.y - position.y))
    ))
    expect(Math.min(...pairDistances)).toBeGreaterThanOrEqual(240)
  })

  it('moves one character node without moving the other node', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.spyOn(HTMLCanvasElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
    vi.spyOn(HTMLCanvasElement.prototype, 'offsetHeight', 'get').mockReturnValue(300)
    vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(400)
    vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(300)
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 400, 300))

    await act(async () => root.render(
      <RelationshipGraph characters={[
        { name: '林墨', role: 'protagonist', relationships: '' },
        { name: '周砧', role: 'supporting', relationships: '' },
      ]} />,
    ))

    const canvas = container.querySelector('canvas')!
    const beforeDragged = fillTextCalls.find(call => call.text === '林墨')!
    const beforeOther = fillTextCalls.find(call => call.text === '周砧')!
    fillTextCalls = []

    const clientX = beforeDragged.x / 2
    const clientY = (beforeDragged.y - 36) / 2
    await act(async () => {
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 1,
        clientX,
        clientY,
      }))
      canvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 1,
        clientX: clientX + 40,
        clientY: clientY + 20,
      }))
    })

    const afterDragged = fillTextCalls.find(call => call.text === '林墨')!
    const afterOther = fillTextCalls.find(call => call.text === '周砧')!
    expect(afterDragged.x).toBeCloseTo(beforeDragged.x + 80)
    expect(afterDragged.y).toBeCloseTo(beforeDragged.y + 40)
    expect(afterOther).toMatchObject({ x: beforeOther.x, y: beforeOther.y })
  })

  it.each([
    ['light', '#34435C'],
    ['paper', '#4B3E2C'],
    ['galaxy', '#E2EDF7'],
    ['dark', '#E2E2E2'],
  ])('maps %s image-skin relationship labels to its high-contrast secondary text semantic', async (theme, expectedTextColor) => {
    container.className = `app-skin-root ${theme}`
    container.dataset.theme = theme
    container.dataset.skinReadability = 'high-contrast'

    await act(async () => root.render(
      <RelationshipGraph characters={[
        {
          name: '林墨',
          role: 'protagonist',
          relationships: JSON.stringify([{ target: '周砧', relation: '共同追查' }]),
        },
        { name: '周砧', role: 'supporting', relationships: '' },
      ]} />,
    ))

    expect(fillTextCalls.find((call) => call.text === '共同追查')?.fillStyle)
      .toBe(expectedTextColor)
  })

  it('redraws the mounted canvas when the document theme changes', async () => {
    document.documentElement.classList.add('paper')

    await act(async () => root.render(
      <RelationshipGraph characters={[{
        name: '林墨',
        role: 'antagonist',
        relationships: '',
      }]} />,
    ))

    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(fillTextCalls.filter((call) => call.text === '林墨').at(-1)?.fillStyle)
      .toBe('rgb(43, 42, 38)')

    fillTextCalls = []
    document.documentElement.classList.remove('paper')
    document.documentElement.classList.add('dark')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(container.querySelector('canvas')).toBe(canvas)
    expect(fillTextCalls.filter((call) => call.text === '林墨').at(-1)?.fillStyle)
      .toBe('rgb(212, 212, 212)')
  })

  it('redraws the mounted canvas when the resident image skin changes', async () => {
    container.className = 'app-skin-root paper'
    container.dataset.theme = 'paper'
    container.dataset.skin = 'classic'
    container.dataset.skinReadability = 'theme-default'

    await act(async () => root.render(
      <RelationshipGraph characters={[
        {
          name: '林墨',
          role: 'protagonist',
          relationships: JSON.stringify([{ target: '周砧', relation: '共同追查' }]),
        },
        { name: '周砧', role: 'supporting', relationships: '' },
      ]} />,
    ))

    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(fillTextCalls.find((call) => call.text === '林墨')?.fillStyle)
      .toBe('rgb(43, 42, 38)')
    expect(fillTextCalls.find((call) => call.text === '共同追查')?.fillStyle)
      .toBe('#6E6A5F')

    await waitForAnimationFrames(125)
    fillTextCalls = []
    container.dataset.skin = 'anime'
    container.dataset.skinReadability = 'high-contrast'
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(container.querySelector('canvas')).toBe(canvas)
    expect(fillTextCalls.find((call) => call.text === '林墨')?.fillStyle)
      .toBe('rgb(34, 29, 23)')
    expect(fillTextCalls.find((call) => call.text === '共同追查')?.fillStyle)
      .toBe('#4B3E2C')

    fillTextCalls = []
    container.dataset.skin = 'custom'
    container.style.setProperty('--skin-text-primary', '#123456')
    container.style.setProperty('--skin-text-secondary', '#654321')
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    expect(container.querySelector('canvas')).toBe(canvas)
    expect(fillTextCalls.find((call) => call.text === '林墨')?.fillStyle)
      .toBe('rgb(18, 52, 86)')
    expect(fillTextCalls.find((call) => call.text === '共同追查')?.fillStyle)
      .toBe('#654321')
  })

  it('reads role decoration colors from runtime CSS semantics', async () => {
    container.style.setProperty('--color-role-protagonist', '#112233')
    container.style.setProperty('--color-role-antagonist', '#223344')
    container.style.setProperty('--color-role-supporting', '#334455')
    container.style.setProperty('--color-role-minor', '#445566')

    await act(async () => root.render(
      <RelationshipGraph characters={[
        { name: '主角', role: 'protagonist', relationships: '' },
        { name: '反派', role: 'antagonist', relationships: '' },
        { name: '配角', role: 'supporting', relationships: '' },
        { name: '路人', role: 'minor', relationships: '' },
      ]} />,
    ))

    expect(new Set(strokeStyleCalls)).toEqual(new Set([
      '#112233',
      '#223344',
      '#334455',
      '#445566',
    ]))
  })
})
