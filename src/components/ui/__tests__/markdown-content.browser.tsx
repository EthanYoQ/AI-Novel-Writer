import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import MarkdownContent from '../MarkdownContent'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const initialLocale = useLocaleStore.getState()
let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  useLocaleStore.setState(initialLocale, true)
})

/** 模型输出里的 <think> 段折成一块，折叠头按界面语言显示。 */
describe('模型输出里的思考过程', () => {
  it.each([
    ['zh-CN', true, '正在思考…'],
    ['zh-CN', false, '思考过程'],
    ['en-US', true, 'Thinking…'],
    ['en-US', false, 'Thinking process'],
  ] as const)('%s 界面、生成中 %s：折叠头写「%s」', async (locale, streaming, heading) => {
    useLocaleStore.setState({ locale })
    // 生成中时思考还没闭合；生成完是闭合的思考加正文。
    const content = streaming ? '<think>先列出人物关系' : '<think>先列出人物关系</think>正文'
    await act(async () => root.render(<MarkdownContent content={content} streaming={streaming} />))
    expect(host.querySelector('button')?.textContent).toBe(heading)
  })
})
