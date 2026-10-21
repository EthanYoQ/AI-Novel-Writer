/* eslint-disable react-refresh/only-export-components */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, Suspense, useEffect, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page, userEvent } from 'vitest/browser'

import '../../../index.css'
import { APPEARANCE_STORAGE_KEY } from '../../../shared/appearance-profile'
import type { WindowCloseGuard } from '../../layout/use-window-close-guard'
import { alertError } from '../../ui/AlertDialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/Dialog'
import ExitGuardDialog from '../ExitGuardDialog'
import StageRoot from '../StageRoot'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLDivElement | undefined

function Broken(): never {
  throw new Error('外壳渲染失败')
}

const idleGuard = (overrides: Partial<WindowCloseGuard> = {}): WindowCloseGuard => ({
  exitRequest: null, exitBusy: false, exitError: null,
  cancelExit: vi.fn(async () => undefined), discardAndExit: vi.fn(async () => undefined), saveAndExit: vi.fn(async () => undefined),
  ...overrides,
})

async function mount(guard: WindowCloseGuard, children: ReactNode = <Broken />) {
  host = document.createElement('div')
  host.style.cssText = 'width: 1280px; height: 800px;'
  document.body.append(host)
  root = createRoot(host)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await act(async () => root!.render(<StageRoot theme="light" exitGuard={guard}>{children}</StageRoot>))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.restoreAllMocks()
  localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  document.getElementById('ai-novel-ink-overlay')?.remove()
})

describe('新外壳渲染出错', () => {
  it('显示出错界面，「重试」重新渲染外壳：这次不再出错就回到界面，不改外观偏好', async () => {
    let fail = true
    function Flaky() {
      if (fail) throw new Error('外壳渲染失败')
      return <p>恢复的外壳</p>
    }
    await mount(idleGuard(), <Flaky />)
    expect(host!.querySelector('h3')?.textContent).toBe('创作流程界面出错了')
    const button = [...host!.querySelectorAll('button')].find(candidate => candidate.textContent === '重试')!
    expect(button.classList.contains('pi-btn--primary')).toBe(true)
    fail = false
    await act(async () => button.click())
    expect(host!.textContent).toContain('恢复的外壳')
    expect(host!.querySelector('h3')).toBeNull()
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  })

  it('外壳出错后关窗，退出确认仍在纸墨作用域里，按钮能用', async () => {
    const saveAndExit = vi.fn(async () => undefined)
    await mount(idleGuard({ exitRequest: { requestId: 'close-1' }, saveAndExit }))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('退出前处理未保存的内容')
    expect(dialog.closest('.paper-ink')).not.toBeNull()
    expect(getComputedStyle(dialog).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    const save = [...dialog.querySelectorAll('button')].find(candidate => candidate.textContent === '保存并退出')!
    await act(async () => save.click())
    expect(saveAndExit).toHaveBeenCalledOnce()
  })

  it('退出确认点「取消」或按 Esc 关闭后，焦点回到弹出它之前的元素', async () => {
    function Harness() {
      const [exitRequest, setExitRequest] = useState<WindowCloseGuard['exitRequest']>(null)
      return (
        <StageRoot theme="light" exitGuard={idleGuard({ exitRequest, cancelExit: async () => setExitRequest(null) })}>
          <button type="button" onClick={() => setExitRequest({ requestId: 'close-3' })}>第 3 章</button>
        </StageRoot>
      )
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<Harness />))
    const chapter = page.getByRole('button', { name: '第 3 章' })
    const landed: boolean[] = []
    for (const close of ['取消', 'Escape']) {
      await userEvent.click(chapter)
      await expect.element(page.getByRole('dialog')).toBeVisible()
      if (close === 'Escape') await userEvent.keyboard('{Escape}')
      else await userEvent.click(page.getByRole('button', { name: close }))
      await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
      await new Promise(resolve => setTimeout(resolve, 20))
      landed.push(document.activeElement === chapter.element())
    }
    expect(landed).toEqual([true, true])
  })

  it('导出等旧对话框开着时关窗，退出确认与遮罩画在它上面', async () => {
    await mount(idleGuard({ exitRequest: { requestId: 'close-2' } }), (
      <Dialog open>
        <DialogContent><DialogHeader><DialogTitle>导出项目</DialogTitle></DialogHeader></DialogContent>
      </Dialog>
    ))
    const exit = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.textContent?.includes('退出前处理未保存的内容'))!
    const legacy = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.textContent?.includes('导出项目'))!
    // Radix 让下层的模态不接指针，elementFromPoint 会跳过它；放开之后取到的才是画在最上面的那一层
    for (const layer of document.querySelectorAll<HTMLElement>('[role="dialog"], .pi-scrim')) layer.style.pointerEvents = 'auto'
    const center = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    }
    expect(center(exit)?.closest('[role="dialog"]')).toBe(exit)
    expect(center(legacy)?.closest('[role="dialog"]')).toBe(exit)
  })
})

/**
 * 画在元素中心最上面的那一层对话框。Radix 让下层的模态不接指针，elementFromPoint 会跳过它；量的时候临时放开，量完还原。
 */
function topLayerAt(element: Element) {
  const layers = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], .pi-scrim')]
  const saved = layers.map(layer => layer.style.pointerEvents)
  for (const layer of layers) layer.style.pointerEvents = 'auto'
  const rect = element.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  layers.forEach((layer, index) => { layer.style.pointerEvents = saved[index] })
  return hit?.closest('[role="dialog"], [role="alertdialog"]') ?? null
}

const exitDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(dialog => dialog.textContent?.includes('退出前处理未保存的内容')) ?? null

/**
 * 下层对话框露在上层对话框外面的一点（上沿、下沿或两侧）上画在最上面的元素：上层的遮罩该把它压住，不出重影。
 * 量法同 topLayerAt，临时放开指针。
 */
function hitOutside(lower: Element, upper: Element) {
  const l = lower.getBoundingClientRect(), u = upper.getBoundingClientRect()
  const point = [[l.left + l.width / 2, l.top + 1], [l.left + l.width / 2, l.bottom - 1], [l.left + 1, l.top + l.height / 2], [l.right - 1, l.top + l.height / 2]]
    .find(([x, y]) => x < u.left || x > u.right || y < u.top || y > u.bottom)
  expect(point, '下层对话框有露在上层外面的部分').toBeTruthy()
  const layers = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], .pi-scrim')]
  const saved = layers.map(layer => layer.style.pointerEvents)
  for (const layer of layers) layer.style.pointerEvents = 'auto'
  const hit = document.elementFromPoint(point![0], point![1])
  layers.forEach((layer, index) => { layer.style.pointerEvents = saved[index] })
  return hit
}

describe('退出确认与错误提示谁后弹出谁在上面', () => {
  it('退出确认开着时弹出错误提示：提示画在退出确认上面、点得到「确定」，确定后退出确认还在', async () => {
    const cancelExit = vi.fn(async () => undefined)
    await mount(idleGuard({ exitRequest: { requestId: 'close-4' }, cancelExit }), <p>正文</p>)
    expect(exitDialog()).not.toBeNull()
    const alerted = alertError('清除失败：磁盘忙')
    const prompt = page.getByRole('alertdialog', { name: '发生错误' })
    await expect.element(prompt).toBeVisible()
    expect(topLayerAt(prompt.element())).toBe(prompt.element())
    expect(hitOutside(exitDialog()!, prompt.element())?.classList.contains('pi-scrim--prompt')).toBe(true)
    await prompt.getByRole('button', { name: '确定' }).click()
    await alerted
    expect(exitDialog()).not.toBeNull()
    expect(cancelExit).not.toHaveBeenCalled()
  })

  it('错误提示开着时关窗：退出确认画在提示上面，焦点在退出确认里', async () => {
    let request!: (next: WindowCloseGuard['exitRequest']) => void
    function Harness() {
      const [exitRequest, setExitRequest] = useState<WindowCloseGuard['exitRequest']>(null)
      useEffect(() => { request = setExitRequest }, [])
      return <StageRoot theme="light" exitGuard={idleGuard({ exitRequest, cancelExit: async () => setExitRequest(null) })}><p>正文</p></StageRoot>
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<Harness />))
    // 退出确认没弹出时宿主里没有它的节点：Radix 1.1 的 Portal 随 open 挂载，弹出时才排到已有提示之后
    expect(document.querySelector('#ai-novel-ink-overlay .stage-exit-scrim, #ai-novel-ink-overlay .stage-exit-dialog')).toBeNull()
    // 提示写得长，比退出确认高，上下沿露在退出确认外面
    const alerted = alertError(['导出失败：磁盘忙', ...Array.from({ length: 14 }, (_, index) => `第 ${index + 1} 份文件没有写入。`)].join('\n'))
    const prompt = page.getByRole('alertdialog', { name: '发生错误' })
    await expect.element(prompt).toBeVisible()
    // 退出确认弹出后提示所在的层被标 aria-hidden，按角色找不到了；先记下节点
    const promptElement = prompt.element()
    await act(async () => request({ requestId: 'close-5' }))
    await vi.waitFor(() => expect(exitDialog()).not.toBeNull())
    const exit = exitDialog()!
    expect(topLayerAt(exit)).toBe(exit)
    expect(exit.contains(document.activeElement)).toBe(true)
    expect(hitOutside(promptElement, exit)?.classList.contains('stage-exit-scrim')).toBe(true)
    await act(async () => request(null))
    await prompt.getByRole('button', { name: '确定' }).click()
    await alerted
  })
})

describe('渲染期不建纸墨宿主', () => {
  it.each([
    ['退出确认', () => <ExitGuardDialog guard={idleGuard({ exitRequest: { requestId: 'close-6' } })} />],
    ['迁移后的旧对话框', () => <Dialog open><DialogContent><DialogHeader><DialogTitle>导出项目</DialogTitle></DialogHeader></DialogContent></Dialog>],
  ])('%s所在的树挂起、没有提交时，body 下没有多出宿主', async (_case, dialog) => {
    function Pending(): never {
      throw new Promise(() => undefined)
    }
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(<Suspense fallback={<p>读取中</p>}>{dialog()}<Pending /></Suspense>))
    expect(host.textContent).toBe('读取中')
    expect(document.getElementById('ai-novel-ink-overlay')).toBeNull()
  })
})
