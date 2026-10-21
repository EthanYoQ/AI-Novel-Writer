import { afterEach, expect, it, vi } from 'vitest'
import { commands } from 'vitest/browser'
import { act, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { lazyPage } from '../lazy-page'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined
let written: string[] = []

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  for (const file of written) await commands.removeFile(file)
  root = undefined
  host = undefined
  written = []
})

async function writeRuntime(name: string, source: string) {
  const file = `.runtime/${name}`
  if (!written.includes(file)) written.push(file)
  await commands.writeFile(file, source)
}

async function render(Page: ComponentType<{ title: string }>) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<Page title="设置" />))
}

const retryButton = () => [...host!.querySelectorAll('button')].find(button => button.textContent === '重试')!

it('页面代码载入失败时写明没有载入并给出重试；重试成功后显示页面', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const load = vi.fn<() => Promise<{ default: ComponentType<{ title: string }> }>>()
    .mockRejectedValueOnce(new Error('chunk 404'))
    .mockResolvedValueOnce({ default: ({ title }: { title: string }) => <h1>{title}</h1> })
  const { Page } = lazyPage(load, 'StageSetup')

  await render(Page)
  await expect.poll(() => host!.querySelector('h3')?.textContent).toBe('页面没有载入')
  expect(warn).toHaveBeenCalledWith('[lazyPage] 页面代码载入失败', expect.any(Error))

  await act(async () => retryButton().click())
  await expect.poll(() => host!.querySelector('h1')?.textContent).toBe('设置')
  expect(load).toHaveBeenCalledTimes(2)
  warn.mockRestore()
})

it('真实的动态导入失败后，文件恢复了点重试就能载入（浏览器记住了失败的地址，不能原样再导入）', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const name = `lazy-retry-${crypto.randomUUID()}`
  const { Page } = lazyPage<{ title: string }>(() => import(/* @vite-ignore */ `/.runtime/${name}.js`), name)

  await render(Page)
  await expect.poll(() => host!.querySelector('h3')?.textContent, { timeout: 10_000 }).toBe('页面没有载入')

  await writeRuntime(`${name}.js`, 'export default function Page({ title }) { return `已载入${title}` }\n')
  await act(async () => retryButton().click())
  await expect.poll(() => host!.textContent, { timeout: 10_000 }).toBe('已载入设置')
  warn.mockRestore()
})

it('失败消息里的地址是依赖代码块而不是页面入口时，不拿它当页面：仍是失败态，「重试」还在', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const dependency = `vendor-${crypto.randomUUID()}.js`
  await writeRuntime(dependency, 'export default 42\n')
  const failure = new Error(`Failed to fetch dynamically imported module: ${location.origin}/.runtime/${dependency}`)
  const load = vi.fn<() => Promise<{ default: ComponentType<{ title: string }> }>>().mockRejectedValue(failure)
  const { Page } = lazyPage(load, 'StageSetup')

  await render(Page)
  await expect.poll(() => host!.querySelector('h3')?.textContent).toBe('页面没有载入')
  await act(async () => retryButton().click())
  await expect.poll(() => load.mock.calls.length).toBe(2)
  expect(host!.querySelector('h3')?.textContent).toBe('页面没有载入')
  expect(retryButton()).toBeTruthy()
  warn.mockRestore()
})

it('重新导入的页面入口没有默认导出的组件时按失败处理；文件修好后再点重试能载入（地址已带查询串也照常拼接）', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const entry = `lazy-entry-${crypto.randomUUID()}`
  const { Page } = lazyPage<{ title: string }>(() => import(/* @vite-ignore */ `/.runtime/${entry}.js?t=1`), entry)

  await render(Page)
  await expect.poll(() => host!.querySelector('h3')?.textContent, { timeout: 10_000 }).toBe('页面没有载入')

  await writeRuntime(`${entry}.js`, 'export const notAPage = 1\n')
  await act(async () => retryButton().click())
  await expect.poll(() => host!.querySelector('h3')?.textContent, { timeout: 10_000 }).toBe('页面没有载入')
  expect(retryButton()).toBeTruthy()

  await writeRuntime(`${entry}.js`, 'export default function Page({ title }) { return `已载入${title}` }\n')
  await act(async () => retryButton().click())
  await expect.poll(() => host!.textContent, { timeout: 10_000 }).toBe('已载入设置')
  warn.mockRestore()
})
