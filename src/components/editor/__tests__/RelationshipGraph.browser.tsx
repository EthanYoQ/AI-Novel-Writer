import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'
import RelationshipGraph from '../RelationshipGraph'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface FillTextCall {
  text: string
  fillStyle: string
}

let root: Root
let container: HTMLDivElement
let fillTextCalls: FillTextCall[]
let strokeStyleCalls: string[]

async function waitForAnimationFrames(count: number) {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

beforeEach(() => {
  fillTextCalls = []
  strokeStyleCalls = []
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
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke() {
        strokeStyleCalls.push(String(this.strokeStyle))
      },
      arc: vi.fn(),
      fill: vi.fn(),
      fillText(text: string) {
        fillTextCalls.push({ text, fillStyle: String(this.fillStyle) })
      },
    }
    return context as unknown as CanvasRenderingContext2D
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.documentElement.classList.remove('paper', 'galaxy', 'dark')
  vi.restoreAllMocks()
})

describe('RelationshipGraph readable theme text', () => {
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
