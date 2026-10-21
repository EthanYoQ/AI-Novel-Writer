import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { page, userEvent } from 'vitest/browser'

import '../../../index.css'
import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useThemeStore } from '../../../stores/theme-store'
import { actionToast } from '../ActionToast'
import { alertError } from '../AlertDialog'
import { confirm } from '../Confirm'
import { Button } from '../Button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../Dialog'
import { toast } from '../Toast'
import ClearProjectDataDialog from '../../dialogs/ClearProjectDataDialog'
import StagePalette from '../../stage/StagePalette'
import { DangerConfirm } from '../DangerConfirm'
import { InkDialog } from '../../stage/InkDialog'
import { Menu } from '../Menu'
import { withReducedMotion } from './reduced-motion'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHOTS = '../../../../.runtime/rdv-shots'
const DARK = { layer: 'rgb(29, 29, 34)', ink: 'rgb(230, 228, 223)', danger: 'rgb(240, 138, 126)', accent: 'rgb(169, 190, 240)' }
const LIGHT = { ink: 'rgb(23, 23, 26)', accent: 'rgb(44, 74, 140)' }

const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
/**
 * 命令式弹窗关掉后先淡出 140ms，内容卸载后才 resolve。分几段等：一个 act 里的状态更新要等 act 结束才提交，
 * 一口气等 350ms 时淡出结束后的卸载会拖到断言之后。
 */
async function promptClosed() {
  for (let step = 0; step < 7; step++) await wait(50)
}
const host = () => document.getElementById('ai-novel-ink-overlay')
const focused = () => document.activeElement as HTMLElement
/** 截 element 所在区域的图；返回按视口坐标取像素与数像素的函数（截图可能按测试页缩放）。 */
async function stackPixels(element: HTMLElement) {
  const box = element.getBoundingClientRect()
  const base64 = await page.screenshot({ element, save: false })
  const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0)
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
  const scale = bitmap.width / box.width
  const at = (x: number, y: number) => {
    const index = (Math.floor((y - box.top) * scale) * bitmap.width + Math.floor((x - box.left) * scale)) * 4
    return [data[index], data[index + 1], data[index + 2]]
  }
  const count = (left: number, top: number, right: number, bottom: number, match: (rgb: number[]) => boolean) => {
    let found = 0
    for (let y = top; y < bottom; y += 1 / scale) for (let x = left; x < right; x += 1 / scale) if (match(at(x, y))) found++
    return found
  }
  return { at, count }
}

const liveToasts = () => [...document.querySelectorAll<HTMLElement>('.pi-toast:not([data-exiting])')]
const toastTitles = () => liveToasts().map(item => item.querySelector('.pi-toast-title')!.textContent)
const buttonNamed = (scope: ParentNode, name: string) => [...scope.querySelectorAll('button')].find(b => b.textContent === name)!
/** 遮罩在对话框底下，点它的左上角才算点在对话框外。 */
const clickScrim = () => userEvent.click(document.querySelector<HTMLElement>('.pi-scrim')!, { position: { x: 8, y: 8 } })

/** 动作失败会再推一条出错通知，所以一轮一轮关到栈空。 */
async function clearToasts() {
  for (let round = 0; round < 8 && liveToasts().length > 0; round++) {
    for (const close of document.querySelectorAll<HTMLButtonElement>('.pi-toast:not([data-exiting]) button[aria-label="关闭通知"]')) await act(async () => close.click())
    await wait(200)
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined
const onOpenChange = vi.fn()

beforeEach(async () => {
  await page.viewport(1100, 760)
  useThemeStore.setState({ resolvedTheme: 'light' })
})

afterEach(async () => {
  await clearToasts()
  // 正在退场的卡片 140ms 后才从栈里拿掉，等它走完再拆宿主
  await wait(200)
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  host()?.remove()
  useThemeStore.setState({ resolvedTheme: 'light' })
})

describe('命令式弹窗', () => {
  it('alertError 渲染进带 .paper-ink 的宿主，深色下取到深色令牌，保留换行，焦点在确定上', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' })
    let resolved = false
    await act(async () => { void alertError('不是有效的项目目录\n\n请重新选择。', { title: '打开项目失败' }).then(() => { resolved = true }) })
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(dialog.closest('.paper-ink')).toBe(host())
    expect(host()!.dataset.theme).toBe('dark')
    expect(getComputedStyle(dialog).backgroundColor).toBe(DARK.layer)
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-title')!).color).toBe(DARK.ink)
    expect(dialog.querySelector('.pi-dialog-title')!.textContent).toBe('打开项目失败')
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-message')!).whiteSpace).toBe('pre-line')
    expect(focused().textContent).toBe('确定')
    await page.screenshot({ path: `${SHOTS}/rdv-alert-dark.png` })

    await userEvent.keyboard('{Enter}')
    await promptClosed()
    expect(resolved).toBe(true)
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('主题切换时宿主跟着换 data-theme', async () => {
    await act(async () => { void alertError('写入失败') })
    expect(host()!.dataset.theme).toBe('light')
    await act(async () => useThemeStore.setState({ resolvedTheme: 'dark' }))
    expect(host()!.dataset.theme).toBe('dark')
    await userEvent.keyboard('{Escape}')
  })

  it('危险确认：焦点落在取消，确认键为实心朱印，回车取消得到 false', async () => {
    let answer: boolean | undefined
    await act(async () => { void confirm('将删除第 3 章的定稿正文。删除后无法恢复。', { title: '删除定稿正文？', confirmText: '删除', danger: true }).then(value => { answer = value }) })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.className).toContain('pi-dialog--marked')
    expect(focused().textContent).toBe('取消')
    expect(buttonNamed(dialog, '删除').className).toContain('pi-btn--danger-solid')
    expect(dialog.querySelector('.pi-dialog-consequence')!.textContent).toContain('删除后无法恢复')
    await page.screenshot({ path: `${SHOTS}/rdv-confirm-danger-light.png` })
    await userEvent.keyboard('{Enter}')
    await promptClosed()
    expect(answer).toBe(false)
  })

  it('淡出期间再点另一个按钮不改写结果：先点取消、趁对话框还没消失又点到删除，得到的仍是 false', async () => {
    let answer: boolean | undefined
    await act(async () => { void confirm('将删除第 3 章的定稿正文。删除后无法恢复。', { title: '删除定稿正文？', confirmText: '删除', danger: true }).then(value => { answer = value }) })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => buttonNamed(dialog, '取消').click())
    expect(dialog.isConnected).toBe(true)
    await act(async () => buttonNamed(dialog, '删除').click())
    await promptClosed()
    expect(answer).toBe(false)
  })

  it('普通确认：焦点在确认上，标题为墨色，点确认得到 true', async () => {
    let answer: boolean | undefined
    await act(async () => { void confirm('有未保存内容，保存后再切换吗？').then(value => { answer = value }) })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(focused().textContent).toBe('确认')
    expect(focused().className).toContain('pi-btn--primary')
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-title')!).color).toBe(LIGHT.ink)
    expect(dialog.querySelector('.pi-dialog-mark')).toBeNull()
    await userEvent.click(focused())
    await promptClosed()
    expect(answer).toBe(true)
  })

  it('Esc 与点遮罩都当取消：confirm 得到 false，alertError 照样 resolve', async () => {
    const answers: boolean[] = []
    let alerts = 0
    for (const dismiss of [() => userEvent.keyboard('{Escape}'), clickScrim]) {
      await act(async () => { void confirm('切换项目？').then(value => { answers.push(value) }) })
      await dismiss()
      await promptClosed()
      await act(async () => { void alertError('写入失败').then(() => { alerts += 1 }) })
      await dismiss()
      await promptClosed()
    }
    expect(answers).toEqual([false, false])
    expect(alerts).toBe(2)
    expect(document.querySelector('.pi-dialog')).toBeNull()
  })

  it('关掉命令式弹窗时先淡出，淡完才拿到结果；减少动态效果时立即', async () => {
    let answer: boolean | undefined
    await act(async () => { void confirm('切换项目？').then(value => { answer = value }) })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await userEvent.keyboard('{Escape}')
    await wait(40)
    expect(dialog.dataset.state).toBe('closed')
    expect(dialog.isConnected).toBe(true)
    expect(answer).toBeUndefined()
    await promptClosed()
    expect(dialog.isConnected).toBe(false)
    expect(answer).toBe(false)

    await withReducedMotion(async () => {
      answer = undefined
      await act(async () => { void confirm('切换项目？').then(value => { answer = value }) })
      await userEvent.keyboard('{Escape}')
      await wait(40)
      expect(answer).toBe(false)
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
  })

  it('两个 confirm 同时开着：Esc 只关上面那个，各自拿到自己的结果', async () => {
    let first: boolean | undefined
    let second: boolean | undefined
    await act(async () => { void confirm('先保存再切换？').then(value => { first = value }) })
    await act(async () => { void confirm('覆盖已有定稿？').then(value => { second = value }) })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2)
    await userEvent.keyboard('{Escape}')
    await promptClosed()
    expect(second).toBe(false)
    expect(first).toBeUndefined()
    const remaining = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(remaining.querySelector('.pi-dialog-message')!.textContent).toBe('先保存再切换？')
    await userEvent.click(buttonNamed(remaining, '确认'))
    await promptClosed()
    expect(first).toBe(true)
  })

  it('对话框开着时点通知的关闭按钮，通知关闭而对话框不关', async () => {
    await act(async () => { void confirm('切换项目？') })
    await act(async () => toast.info('已复制安全诊断'))
    expect(liveToasts()).toHaveLength(1)
    await userEvent.click(page.getByRole('button', { name: '关闭通知' }))
    await wait(200)
    expect(liveToasts()).toHaveLength(0)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await userEvent.keyboard('{Escape}')
  })

  it('命令式弹窗开着时到达的通知仍在读屏读得到的 live region 里，每条只经这一个通道播报', async () => {
    await act(async () => toast.info('已复制本章正文'))
    await act(async () => { void confirm('切换项目？') })
    await act(async () => {
      toast.error('保存失败')
      actionToast.show({ type: 'error', message: '第 3 章审稿失败', actions: [{ label: '查看' }] })
    })
    const mount = document.getElementById('ai-novel-ink-toasts')!
    expect(mount.getAttribute('aria-live')).toBe('polite')
    expect(mount.closest('[aria-hidden="true"]')).toBeNull()
    expect(liveToasts().map(item => item.closest('[aria-live]'))).toEqual([mount, mount, mount])
    expect(mount.querySelectorAll('[role="alert"], [role="status"], [role="log"], [aria-live]')).toHaveLength(0)
    await userEvent.keyboard('{Escape}')
  })

  it('模态开着时卡片之间的空隙仍算在栈上，栈外照旧点到遮罩', async () => {
    await act(async () => { void confirm('切换项目？') })
    await act(async () => {
      toast.info('已复制第 1 章')
      toast.info('已复制第 2 章')
    })
    await wait(300)
    expect(getComputedStyle(document.body).pointerEvents).toBe('none')
    const stack = document.querySelector<HTMLElement>('.pi-toast-stack')!
    expect(getComputedStyle(stack).pointerEvents).toBe('auto')
    const [upper, lower] = liveToasts().map(item => item.getBoundingClientRect())
    const gap = document.elementFromPoint(upper.left + upper.width / 2, (upper.bottom + lower.top) / 2)!
    expect(gap.closest('.pi-toast-stack')).toBe(stack)
    const box = stack.getBoundingClientRect()
    expect(document.elementFromPoint(box.left - 6, box.top + 20)!.classList.contains('pi-scrim')).toBe(true)
    expect(document.elementFromPoint(box.left + 60, box.top - 6)!.classList.contains('pi-scrim')).toBe(true)
    await userEvent.keyboard('{Escape}')
  })
})

describe('提示栈', () => {
  it('toast 与 actionToast 进同一个栈，最多 4 条、新的在下、互不重叠，栈满时先挤普通通知', async () => {
    await act(async () => {
      toast.success('第 1 章已定稿')
      actionToast.show({ type: 'success', message: '「第 2 章」已完成', actions: [{ label: '打开查看' }, { label: '忽略', variant: 'ghost' }] })
      toast.warning('字数超出限制')
      toast.error('保存失败\n\n磁盘已满')
      actionToast.show({ type: 'error', message: '第 3 章审稿失败\n\n模型连接超时，已保留草稿。', actions: [{ label: '查看' }] })
      toast.info('已复制本章正文')
    })
    await wait(200)
    expect(document.querySelectorAll('.pi-toast-stack')).toHaveLength(1)
    const items = liveToasts()
    expect(items).toHaveLength(4)
    expect(toastTitles()).toEqual(['「第 2 章」已完成', '保存失败', '第 3 章审稿失败', '已复制本章正文'])
    expect(items[1].querySelector('.pi-toast-text')!.textContent).toBe('磁盘已满')
    const rects = items.map(item => item.getBoundingClientRect())
    for (let i = 1; i < rects.length; i++) expect(rects[i].top).toBeGreaterThanOrEqual(rects[i - 1].bottom)
    expect(document.getElementById('ai-novel-toast-root')).toBeNull()
    expect(document.getElementById('ai-novel-action-toast-root')).toBeNull()
    await page.screenshot({ path: `${SHOTS}/rdv-toast-stack-light.png` })
  })

  it('常驻、出错与带动作的通知不被挤掉，到达时就露面；4 条上限只约束普通通知', async () => {
    await act(async () => {
      actionToast.show({ message: '发现新版本 v1.3', duration: 0 })
      toast.error('保存失败')
      actionToast.show({ type: 'success', message: '「第 2 章」已完成', actions: [{ label: '打开查看' }] })
      toast.warning('字数超出限制')
      toast.success('已保存')
    })
    await wait(200)
    expect(toastTitles()).toEqual(['发现新版本 v1.3', '保存失败', '「第 2 章」已完成', '已保存'])

    await act(async () => toast.error('导出失败'))
    await wait(200)
    expect(toastTitles()).toEqual(['发现新版本 v1.3', '保存失败', '「第 2 章」已完成', '导出失败'])

    await act(async () => {
      actionToast.show({ type: 'error', message: '第 3 章审稿失败', actions: [{ label: '查看' }] })
      toast.info('已复制本章正文')
    })
    await wait(200)
    expect(toastTitles()).toEqual(['发现新版本 v1.3', '保存失败', '「第 2 章」已完成', '导出失败', '第 3 章审稿失败', '已复制本章正文'])
  })

  it('4 条常驻占满时，后到的出错通知与普通通知立即露面，出错的照常计时消失', async () => {
    await userEvent.hover(document.body, { position: { x: 4, y: 4 } })
    await act(async () => {
      for (let i = 1; i <= 4; i++) actionToast.show({ message: `常驻 ${i}`, duration: 0 })
    })
    await act(async () => {
      toast.error('关键错误\n\n后到的出错通知', 800)
      toast.success('已保存')
    })
    await wait(200)
    expect(toastTitles()).toEqual(['常驻 1', '常驻 2', '常驻 3', '常驻 4', '关键错误', '已保存'])
    await wait(900)
    expect(toastTitles()).toEqual(['常驻 1', '常驻 2', '常驻 3', '常驻 4', '已保存'])
  })

  it('常驻与出错之后连来 6 条普通通知：每条到达时都露面，被挤掉的就此拿掉，不留在暗处排队', async () => {
    await act(async () => {
      actionToast.show({ message: '发现新版本 v1.3', duration: 0 })
      actionToast.show({ type: 'error', message: '保存失败\n\n磁盘已满', actions: [{ label: '重试' }] })
    })
    for (let i = 1; i <= 6; i++) {
      await act(async () => toast.success(`已复制第 ${i} 章`))
      expect(toastTitles().at(-1)).toBe(`已复制第 ${i} 章`)
    }
    await wait(200)
    expect(toastTitles()).toEqual(['发现新版本 v1.3', '保存失败', '已复制第 5 章', '已复制第 6 章'])
    expect(document.querySelectorAll('.pi-toast')).toHaveLength(4)

    await userEvent.click(liveToasts()[3].querySelector('button')!)
    await userEvent.click(liveToasts()[2].querySelector('button')!)
    await wait(200)
    expect(toastTitles()).toEqual(['发现新版本 v1.3', '保存失败'])
  })

  it('鼠标停在栈上时已过期的通知最先让位，哪怕它是提醒', async () => {
    await act(async () => {
      toast.warning('字数超出限制', 300)
      toast.info('已复制第 1 章')
      toast.info('已复制第 2 章')
      toast.info('已复制第 3 章')
    })
    await userEvent.hover(liveToasts()[3])
    await wait(400)
    await act(async () => toast.info('已复制第 4 章'))
    await wait(200)
    expect(toastTitles()).toEqual(['已复制第 1 章', '已复制第 2 章', '已复制第 3 章', '已复制第 4 章'])
    await userEvent.unhover(liveToasts()[3])
  })

  it('相同文案的通知合并成一条并重新计时', async () => {
    await userEvent.hover(document.body, { position: { x: 4, y: 4 } })
    await act(async () => toast.success('已复制安全诊断', 1000))
    await wait(600)
    await act(async () => toast.success('已复制安全诊断', 1000))
    expect(liveToasts()).toHaveLength(1)
    await wait(600)
    expect(toastTitles()).toEqual(['已复制安全诊断'])
    await wait(700)
    expect(liveToasts()).toHaveLength(0)
  })

  it('关掉一条后其上的通知滑下来，而不是瞬移', async () => {
    await act(async () => {
      toast.info('已复制第 1 章')
      toast.info('已复制第 2 章')
    })
    await wait(300)
    const [upper, lower] = liveToasts()
    await act(async () => lower.querySelector('button')!.click())
    await vi.waitFor(() => expect(lower.isConnected).toBe(false), { interval: 5 })
    const moving = upper.getAnimations().filter(animation => animation instanceof CSSTransition && animation.transitionProperty === 'transform')
    expect(moving).toHaveLength(1)
  })

  it('卡片之间的空隙也算在栈上，指针经过不会恢复计时', async () => {
    await act(async () => {
      toast.info('已复制第 1 章')
      toast.info('已复制第 2 章')
    })
    await wait(300)
    const [upper, lower] = liveToasts().map(item => item.getBoundingClientRect())
    const gap = document.elementFromPoint(upper.left + upper.width / 2, (upper.bottom + lower.top) / 2)!
    expect(gap.closest('.pi-toast-stack')).not.toBeNull()
  })

  it('actionToast 的 error 语气是危险色八角符号', async () => {
    useThemeStore.setState({ resolvedTheme: 'dark' })
    await act(async () => { actionToast.show({ type: 'error', message: '第 3 章审稿失败', actions: [{ label: '查看' }] }) })
    const [item] = liveToasts()
    expect(item.dataset.tone).toBe('danger')
    const mark = item.querySelector('.pi-toast-mark')!
    expect(mark.querySelector('svg')!.getAttribute('class')).toContain('octagon-alert')
    expect(getComputedStyle(mark).color).toBe(DARK.danger)
    expect(getComputedStyle(item).backgroundColor).toBe(DARK.layer)
  })

  it('鼠标停在栈上时计时暂停，移开后照常消失；actionToast.show 返回的函数能关掉它', async () => {
    await act(async () => toast.success('已保存', 1000))
    await userEvent.hover(liveToasts()[0])
    await wait(1400)
    expect(liveToasts()).toHaveLength(1)
    await userEvent.unhover(liveToasts()[0])
    await wait(1300)
    expect(liveToasts()).toHaveLength(0)

    let dismiss = () => {}
    await act(async () => { dismiss = actionToast.show({ message: '发现新版本 v1.3', duration: 0 }) })
    expect(liveToasts()).toHaveLength(1)
    await act(async () => dismiss())
    expect(liveToasts()).toHaveLength(0)
  })

  it('动作回调失败时通知照样关闭，失败原因报成一条出错通知', async () => {
    await act(async () => {
      actionToast.show({ message: '发现新版本 v1.3', duration: 0, actions: [{ label: '查看更新', onClick: () => Promise.reject(new Error('更新服务不可用')) }] })
    })
    await userEvent.click(page.getByRole('button', { name: '查看更新' }))
    await wait(200)
    expect(toastTitles()).toEqual(['操作失败'])
    const [item] = liveToasts()
    expect(item.querySelector('.pi-toast-text')!.textContent).toBe('更新服务不可用')
    expect(item.dataset.tone).toBe('danger')
  })

  it('24 条出错通知时栈收在顶栏以下、视口以内可滚动，最新一条露在底部，滚到顶能关掉最早的', async () => {
    await userEvent.hover(document.body, { position: { x: 4, y: 4 } })
    await act(async () => {
      for (let i = 1; i <= 24; i++) toast.error(`出错 ${i}`, 0)
    })
    await wait(200)
    expect(liveToasts()).toHaveLength(24)
    const stack = document.querySelector<HTMLElement>('.pi-toast-stack')!
    const box = stack.getBoundingClientRect()
    expect(box.top).toBeGreaterThanOrEqual(48)
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
    expect(stack.scrollHeight).toBeGreaterThan(stack.clientHeight)
    const newest = liveToasts().at(-1)!.getBoundingClientRect()
    expect(newest.top).toBeGreaterThanOrEqual(box.top)
    expect(newest.bottom).toBeLessThanOrEqual(box.bottom + 0.5)

    await act(async () => { stack.scrollTop = 0 })
    const oldest = liveToasts()[0]
    expect(oldest.getBoundingClientRect().top).toBeGreaterThanOrEqual(box.top - 0.5)
    await userEvent.click(oldest.querySelector<HTMLButtonElement>('button[aria-label="关闭通知"]')!)
    await wait(200)
    expect(toastTitles()).not.toContain('出错 1')
    expect(toastTitles()).toHaveLength(23)
  })

  it('溢出时栈的滚动条用全局的 6px 细条，不换成系统的 thin 样式', async () => {
    await userEvent.hover(document.body, { position: { x: 4, y: 4 } })
    await act(async () => {
      for (let i = 1; i <= 24; i++) toast.error(`出错 ${i}`, 0)
    })
    await wait(200)
    const stack = document.querySelector<HTMLElement>('.pi-toast-stack')!
    expect(stack.hasAttribute('data-overflow')).toBe(true)
    expect([getComputedStyle(stack).scrollbarWidth, getComputedStyle(stack, '::-webkit-scrollbar').width]).toEqual(['auto', '6px'])
  })

  it.each(['light', 'dark'] as const)('%s 主题溢出的栈滚到底时，最上面露出半截的卡片仍不透明，页面不从卡片里透出；上沿有提示还有更多的淡出带，滚到顶时消失', async (theme) => {
    await act(async () => useThemeStore.setState({ resolvedTheme: theme }))
    // 卡片背后铺一层纯红：卡片哪里变透明，截图里那里就带红
    const backdrop = document.createElement('div')
    backdrop.style.cssText = 'position: fixed; inset: 0; background: rgb(255, 0, 0);'
    document.body.prepend(backdrop)
    try {
      await userEvent.hover(document.body, { position: { x: 4, y: 4 } })
      await act(async () => {
        for (let i = 1; i <= 24; i++) toast.error(`出错 ${i}`, 0)
      })
      await wait(400)
      const stack = document.querySelector<HTMLElement>('.pi-toast-stack')!
      expect(stack.hasAttribute('data-overflow')).toBe(true)
      const stackBox = stack.getBoundingClientRect()
      const topCard = liveToasts().find(card => card.getBoundingClientRect().bottom > stackBox.top + 24)!
      const card = topCard.getBoundingClientRect()
      expect(card.top).toBeLessThan(stackBox.top + 16)
      const sample = await stackPixels(stack)
      const red = ([r, g, b]: number[]) => r - g > 40 && r - b > 40
      // 卡片里没有字的一段（标题只有「出错 N」，右边留到关闭按钮之前），上下避开圆角边的抗锯齿；文字的彩色抗锯齿边会被当成红
      const reddish = sample.count(card.left + 160, Math.max(card.top, stackBox.top) + 2, card.right - 48, card.bottom - 2, red)
      // 栈的上沿（卡片列中间）被淡出带盖着，不是背后的页面
      const bandTop = sample.at((card.left + card.right) / 2, stackBox.top + 3)
      expect([reddish, red(bandTop), getComputedStyle(stack, '::before').opacity], JSON.stringify({ bandTop, card: [card.top, card.bottom], stack: [stackBox.top, stackBox.bottom] }))
        .toEqual([0, false, '1'])

      await act(async () => { stack.scrollTop = 0 })
      await wait(50)
      expect(liveToasts()[0].getBoundingClientRect().top - stack.getBoundingClientRect().top).toBeGreaterThanOrEqual(16)
      const atTop = await stackPixels(stack)
      const firstCard = liveToasts()[0].getBoundingClientRect()
      expect(atTop.count(firstCard.left + 160, firstCard.top + 2, firstCard.right - 48, firstCard.top + 12, red)).toBe(0)
      // 滚到顶时上面没有卡片，淡出带消失：栈的上沿与最早一条的圆角外都露出背后的页面，卡片顶上没有盖着东西
      expect([getComputedStyle(stack, '::before').opacity, red(atTop.at((firstCard.left + firstCard.right) / 2, stackBox.top + 3)), red(atTop.at(firstCard.left + 1, firstCard.top + 1))])
        .toEqual(['0', true, true])
    } finally {
      backdrop.remove()
    }
  })

  it('减少动态效果下溢出的栈滚到底时上沿有淡出带，滚到顶时淡出带照样消失，最早一条的圆角外露出页面（#412）', async () => {
    const backdrop = document.createElement('div')
    backdrop.style.cssText = 'position: fixed; inset: 0; background: rgb(255, 0, 0);'
    document.body.prepend(backdrop)
    try {
      await withReducedMotion(async () => {
        await userEvent.hover(document.body, { position: { x: 4, y: 4 } })
        await act(async () => {
          for (let i = 1; i <= 24; i++) toast.error(`出错 ${i}`, 0)
        })
        await wait(400)
        const stack = document.querySelector<HTMLElement>('.pi-toast-stack')!
        expect(stack.hasAttribute('data-overflow')).toBe(true)
        expect(getComputedStyle(stack, '::before').opacity).toBe('1')

        await act(async () => { stack.scrollTop = 0 })
        await wait(50)
        const atTop = await stackPixels(stack)
        const firstCard = liveToasts()[0].getBoundingClientRect()
        const red = ([r, g, b]: number[]) => r - g > 40 && r - b > 40
        expect([getComputedStyle(stack, '::before').opacity, red(atTop.at(firstCard.left + 1, firstCard.top + 1))]).toEqual(['0', true])
      })
    } finally {
      backdrop.remove()
    }
  })

  it('模态开着时溢出的栈仍能用滚轮滚动：滚动锁不拦栈上的滚轮', async () => {
    await act(async () => { void confirm('切换项目？') })
    await userEvent.hover(document.body, { position: { x: 4, y: 4 } })
    await act(async () => {
      for (let i = 1; i <= 24; i++) toast.error(`出错 ${i}`, 0)
    })
    await wait(200)
    const stack = document.querySelector<HTMLElement>('.pi-toast-stack')!
    expect(stack.hasAttribute('data-overflow')).toBe(true)
    const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    liveToasts()[20].dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(false)
    await userEvent.keyboard('{Escape}')
  })

  it('缩窗后栈重新判断溢出：改成可滚动、最新一条露在底部，卡片不因滚动条左移', async () => {
    await userEvent.hover(document.body, { position: { x: 4, y: 4 } })
    await act(async () => {
      for (let i = 1; i <= 8; i++) toast.error(`出错 ${i}`, 0)
    })
    await wait(200)
    const stack = document.querySelector<HTMLElement>('.pi-toast-stack')!
    expect(stack.hasAttribute('data-overflow')).toBe(false)
    const rightBefore = liveToasts().at(-1)!.getBoundingClientRect().right

    await page.viewport(1100, 420)
    await vi.waitFor(() => expect(window.innerHeight).toBe(420))
    await wait(100)
    expect(stack.hasAttribute('data-overflow')).toBe(true)
    expect(stack.scrollHeight).toBeGreaterThan(stack.clientHeight)
    const box = stack.getBoundingClientRect()
    const newest = liveToasts().at(-1)!.getBoundingClientRect()
    expect(newest.bottom).toBeLessThanOrEqual(box.bottom + 0.5)
    expect(newest.top).toBeGreaterThanOrEqual(box.top)
    expect(Math.abs(newest.right - rightBefore)).toBeLessThanOrEqual(0.5)
    await page.screenshot({ path: '../../../../.runtime/rdx3-shots/toast-stack-resized.png' })
  })

  it('栈没满时不裁卡片的投影', async () => {
    await act(async () => toast.error('导出失败', 0))
    expect(getComputedStyle(document.querySelector('.pi-toast-stack')!).overflowY).toBe('visible')
  })

  it('窄窗口里通知收窄到视口内，不越过左沿', async () => {
    await page.viewport(360, 640)
    await act(async () => toast.info('已复制本章正文'))
    const rect = liveToasts()[0].getBoundingClientRect()
    expect(rect.width).toBe(320)
    expect(rect.left).toBe(20)
  })

  it('点通知上的动作先执行回调再关闭', async () => {
    const open = vi.fn()
    await act(async () => actionToast.workflowComplete('「第 4 章」已完成', open))
    await userEvent.click(page.getByRole('button', { name: '打开查看' }))
    await wait(10)
    expect(open).toHaveBeenCalledTimes(1)
    expect(liveToasts()).toHaveLength(0)
  })
})

describe('Ctrl K 面板', () => {
  it('面板开着时点通知的关闭按钮，通知关闭而面板不关', async () => {
    const onClose = vi.fn()
    container = document.createElement('div')
    container.className = 'paper-ink'
    container.dataset.theme = 'light'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<StagePalette mode="commands" items={[]} container={container!} onClose={onClose} />))
    await act(async () => toast.success('已保存'))
    await userEvent.click(page.getByRole('button', { name: '关闭通知' }))
    await wait(200)
    expect(liveToasts()).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[role="combobox"]')).not.toBeNull()
  })
})

describe('旧 ui/Dialog 在新外壳下', () => {
  it('Portal 进纸墨宿主，外壳是浮笺，内容区的旧变量映射到纸墨令牌，尺寸仍听调用方', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <Dialog open>
        <DialogContent className="max-w-[480px]">
          <DialogHeader><DialogTitle>导出项目</DialogTitle></DialogHeader>
          <p className="px-6 text-[var(--color-accent)]">正文</p>
          <DialogFooter className="justify-end"><button type="button">导出</button></DialogFooter>
        </DialogContent>
      </Dialog>,
    ))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.closest('.paper-ink')).toBe(host())
    expect(dialog.className).toContain('pi-dialog')
    expect(dialog.getBoundingClientRect().width).toBe(480)
    expect(getComputedStyle(dialog.querySelector('p')!).color).toBe(LIGHT.accent)
    expect(getComputedStyle(dialog.querySelector('.pi-dialog-foot')!).justifyContent).toBe('flex-end')
    expect(dialog.querySelector('.pi-dialog-close')!.className).toContain('pi-btn--icon')
  })
})

describe('清除生成内容', () => {
  const project = { id: 'lighthouse', path: 'C:/novels/lighthouse', sessionLease: 'lease-clear' } as ProjectData
  const originalProject = useProjectStore.getState()
  let invoke: ReturnType<typeof vi.fn>
  let finishClear: (result: { success: boolean; error?: string }) => void = () => {}

  beforeEach(() => {
    invoke = vi.fn((channel: string) => channel === 'db:project-clear-generated-data'
      ? new Promise(resolve => { finishClear = resolve })
      : Promise.resolve({ success: true }))
    Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke, on: vi.fn(() => () => {}), once: vi.fn(), send: vi.fn() } })
    useProjectStore.setState({ currentProject: project })
    setActiveProjectSessionContext({ projectId: project.id, projectPath: project.path, leaseId: project.sessionLease! })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'aiNovelAPI')
    setActiveProjectSessionContext(null)
    useProjectStore.setState(originalProject)
  })

  async function renderClear(onClose: () => void = () => {}) {
    container = document.createElement('div')
    container.className = 'paper-ink'
    container.dataset.theme = 'light'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ClearProjectDataDialog open onClose={onClose} />))
    return document.querySelector<HTMLElement>('[role="dialog"]')!
  }

  it('新外壳里是标准危险确认：焦点在取消，勾选行改写后果句，全不选时不能确认', async () => {
    const dialog = await renderClear()
    expect(dialog.className).toContain('pi-dialog--marked')
    expect(focused().textContent).toBe('取消')
    const [consequence, recover, advice] = dialog.querySelectorAll<HTMLElement>('.pi-dialog-consequence > p')
    expect(consequence.textContent).toBe('将清除 3 类内容：故事架构与大纲、章节蓝图、草稿、定稿与审稿产物。')
    expect(recover.textContent).toBe('清除后不会自动恢复。')
    expect(getComputedStyle(recover).color).toBe('rgb(180, 35, 24)')
    expect(advice.textContent).toBe('若需要保留当前内容，请先复制到外部文件或导出项目备份。')
    expect(getComputedStyle(advice).color).toBe(LIGHT.ink)
    const boxes = [...dialog.querySelectorAll<HTMLElement>('.pi-check-row > .pi-check')]
    expect(boxes).toHaveLength(3)
    await page.screenshot({ path: `${SHOTS}/rdv-clear-light.png` })

    await userEvent.click(boxes[0])
    expect(consequence.textContent).toBe('将清除 2 类内容：章节蓝图、草稿、定稿与审稿产物。')
    await userEvent.click(boxes[1])
    await userEvent.click(boxes[2])
    expect(consequence.textContent).toBe('请至少选择一类内容。')
    expect(buttonNamed(dialog, '清除所选').disabled).toBe(true)
  })

  it('英文界面只选一类时写 1 kind，不写 1 kinds', async () => {
    const locale = useLocaleStore.getState()
    useLocaleStore.setState({ locale: 'en-US' })
    try {
      const dialog = await renderClear()
      const boxes = [...dialog.querySelectorAll<HTMLElement>('.pi-check-row > .pi-check')]
      await userEvent.click(boxes[0])
      await userEvent.click(boxes[1])
      expect(dialog.querySelector('.pi-dialog-consequence > p')!.textContent).toMatch(/^Clears 1 kind of data: /)
    } finally {
      useLocaleStore.setState(locale, true)
    }
  })

  it('按勾选清除；清除中按钮写「清除中…」，Esc 与点外部关不掉；失败走 alertError 后可再试', async () => {
    const onClose = vi.fn()
    const dialog = await renderClear(onClose)
    await userEvent.click(dialog.querySelectorAll<HTMLElement>('.pi-check-row > .pi-check')[1])
    await userEvent.click(buttonNamed(dialog, '清除所选'))
    expect(invoke.mock.calls.find(call => call[0] === 'db:project-clear-generated-data')).toEqual([
      'db:project-clear-generated-data',
      { creativeFields: true, blueprints: false, generatedText: true },
      project.path,
      { projectId: project.id, leaseId: project.sessionLease, projectPath: project.path },
    ])
    const busy = dialog.querySelector<HTMLButtonElement>('.pi-dialog-foot [aria-busy="true"]')!
    expect(busy.textContent).toBe('清除中…')
    expect(busy.disabled).toBe(true)

    await userEvent.keyboard('{Escape}')
    await clickScrim()
    await wait(200)
    expect(onClose).not.toHaveBeenCalled()
    expect(dialog.isConnected).toBe(true)

    await act(async () => finishClear({ success: false, error: '磁盘只读' }))
    const alert = await vi.waitFor(() => document.querySelector<HTMLElement>('[role="alertdialog"]')!)
    expect(alert.querySelector('.pi-dialog-title')!.textContent).toBe('清除失败')
    expect(alert.querySelector('.pi-dialog-message')!.textContent).toBe('磁盘只读')
    await userEvent.click(buttonNamed(alert, '确定'))
    await vi.waitFor(() => expect(buttonNamed(dialog, '清除所选').disabled).toBe(false))
    expect(onClose).not.toHaveBeenCalled()
  })

  /** 照顶栏作品菜单的接法：菜单项打开受控的旧对话框与清除确认，都没有 Dialog.Trigger。 */
  function WorkMenu() {
    const [open, setOpen] = useState<'export' | 'clear' | null>(null)
    return (
      <>
        <Menu label="作品菜单" groups={[{ id: 'files', items: [
          { id: 'export', label: '导出…', onSelect: () => setOpen('export') },
          { id: 'clear', label: '清除生成内容…', onSelect: () => setOpen('clear') },
        ] }]} />
        <Dialog open={open === 'export'} onOpenChange={next => { if (!next) setOpen(null) }}>
          <DialogContent><DialogHeader><DialogTitle>导出项目</DialogTitle></DialogHeader></DialogContent>
        </Dialog>
        <ClearProjectDataDialog open={open === 'clear'} onClose={() => setOpen(null)} />
      </>
    )
  }

  it('从作品菜单打开的导出与清除确认，取消或 Esc 关闭后焦点回到作品菜单按钮，不落到 body', async () => {
    container = document.createElement('div')
    container.className = 'paper-ink'
    container.dataset.theme = 'light'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkMenu />))
    const trigger = page.getByRole('button', { name: '作品菜单' })
    const pick = async (item: string) => {
      await userEvent.click(trigger)
      await userEvent.click(page.getByRole('menuitem', { name: item }))
      return vi.waitFor(() => document.querySelector<HTMLElement>('[role="dialog"]')!)
    }
    const closed = () => vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())

    await pick('导出…')
    await userEvent.keyboard('{Escape}')
    await closed()
    expect(focused()).toBe(trigger.element())

    const clear = await pick('清除生成内容…')
    await userEvent.click(buttonNamed(clear, '取消'))
    await closed()
    expect(focused()).toBe(trigger.element())

    await pick('清除生成内容…')
    await userEvent.keyboard('{Escape}')
    await closed()
    expect(focused()).toBe(trigger.element())
  })
})

describe('页面里的危险确认', () => {
  it('DangerConfirm 开着时点通知的关闭按钮，通知关闭而确认框不关', async () => {
    container = document.createElement('div')
    container.className = 'paper-ink'
    container.dataset.theme = 'light'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <DangerConfirm open onOpenChange={onOpenChange} title="删除《灯塔》" consequence="将删除全部章节。" recoverability="删除后无法恢复。"
        confirmLabel="永久删除" cancelLabel="取消" onConfirm={() => {}} />,
    ))
    await act(async () => toast.success('已保存'))
    await userEvent.click(page.getByRole('button', { name: '关闭通知' }))
    await wait(200)
    expect(liveToasts()).toHaveLength(0)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('纸墨根里的危险确认开着时，宿主已在也不会把新通知藏起来', async () => {
    await act(async () => { void alertError('写入失败') })
    await userEvent.keyboard('{Escape}')
    await promptClosed()
    container = document.createElement('div')
    container.className = 'paper-ink'
    container.dataset.theme = 'light'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <DangerConfirm open onOpenChange={onOpenChange} title="删除《灯塔》" consequence="将删除全部章节。" recoverability="删除后无法恢复。"
        confirmLabel="永久删除" cancelLabel="取消" onConfirm={() => {}} />,
    ))
    await act(async () => toast.error('导出失败'))
    const [item] = liveToasts()
    expect(item.textContent).toContain('导出失败')
    expect(item.closest('[aria-hidden="true"]')).toBeNull()
    expect(item.closest('[aria-live="polite"]')).not.toBeNull()
  })
})

describe('新外壳的普通对话框', () => {
  it('InkDialog 开着时点通知的关闭按钮，通知关闭而对话框不关；标题是墨色', async () => {
    onOpenChange.mockClear()
    container = document.createElement('div')
    container.className = 'paper-ink'
    container.dataset.theme = 'light'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <InkDialog open onOpenChange={onOpenChange} title="新建作品" footer={<button type="button">创建</button>} />,
    ))
    expect(getComputedStyle(document.querySelector('.pi-dialog-title')!).color).toBe(LIGHT.ink)
    await act(async () => toast.success('已保存'))
    await userEvent.click(page.getByRole('button', { name: '关闭通知' }))
    await wait(200)
    expect(liveToasts()).toHaveLength(0)
    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

describe('新外壳下的旧按钮变体', () => {
  it('旧 asChild 按钮在新外壳下仍渲染成它包着的元素，带纸墨类名', async () => {
    container = document.createElement('div')
    container.className = 'paper-ink'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Button asChild variant="outline"><a href="#export">导出</a></Button>))
    const link = container.querySelector('a')!
    expect([link.textContent, link.classList.contains('pi-btn--secondary'), container.querySelector('button')]).toEqual(['导出', true, null])
  })

  it('旧对话框与旧面板里的默认、AI、描边、幽灵、危险、图标按钮换成纸墨六种，主按钮与页面同为黛蓝', async () => {
    container = document.createElement('div')
    container.className = 'paper-ink'
    container.dataset.theme = 'light'
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader><DialogTitle>导出</DialogTitle></DialogHeader>
          <Button size="lg">导出</Button>
          <Button variant="ai" size="sm">AI 生成</Button>
          <Button variant="outline">选择文件夹</Button>
          <Button variant="ghost">取消</Button>
          <Button variant="destructive">取消当前云操作</Button>
          <Button variant="ghost" size="icon" aria-label="折叠">×</Button>
        </DialogContent>
      </Dialog>,
    ))
    const named = (name: string) => buttonNamed(host()!, name) ?? [...host()!.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === name)!
    expect(named('导出').className).toContain('pi-btn pi-btn--primary')
    expect(named('导出').className).not.toContain('btn-primary ')
    expect(getComputedStyle(named('导出')).backgroundColor).toBe(LIGHT.accent)
    expect(getComputedStyle(named('导出')).height).toBe('36px')
    expect(named('AI 生成').className).toContain('pi-btn--primary pi-btn--sm')
    expect(named('AI 生成').className).not.toContain('ai-glow')
    expect(named('选择文件夹').className).toContain('pi-btn--secondary pi-btn--sm')
    expect(named('取消').className).toContain('pi-btn--text')
    expect(named('取消当前云操作').className).toContain('pi-btn--danger-solid')
    expect(named('折叠').className).toContain('pi-btn--icon pi-btn--sm')
    expect(getComputedStyle(named('选择文件夹')).height).toBe('28px')
  })
})

