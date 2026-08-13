import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../index.css'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Rgb = readonly [number, number, number]

function parseRgb(value: string): Rgb {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error(`Expected rgb color, received ${value}`)
  return channels as unknown as Rgb
}

function relativeLuminance(color: Rgb): number {
  const [red, green, blue] = color.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(parseRgb(foreground))
  const backgroundLuminance = relativeLuminance(parseRgb(background))
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('category text semantics in Chromium', () => {
  it.each(['light', 'paper', 'galaxy', 'dark'])('resolves readable category labels in the %s theme', async (theme) => {
    container = document.createElement('div')
    container.className = theme
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(
      <div style={{ background: 'var(--color-active)' }}>
        <span style={{ color: 'var(--color-category-progress-text)' }}>已修稿</span>
        <span style={{ color: 'var(--color-category-review-text)' }}>已审稿</span>
      </div>,
    ))

    const surface = container.firstElementChild as HTMLElement
    const [progress, review] = surface.querySelectorAll('span')
    const background = getComputedStyle(surface).backgroundColor

    expect(contrastRatio(getComputedStyle(progress).color, background), `${theme} progress`).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(getComputedStyle(review).color, background), `${theme} review`).toBeGreaterThanOrEqual(4.5)
  })
})
