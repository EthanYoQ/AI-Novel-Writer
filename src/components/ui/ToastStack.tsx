/* eslint-disable react-refresh/only-export-components */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CircleCheck, Info, OctagonAlert, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { Button } from './Button'
import { toastStackMount } from './ink-overlay'

/**
 * toast.* 与 actionToast.* 共用的提示栈：右下角一列，新的在下；鼠标停在栈上时所有计时暂停。
 * 两个公共 API 的签名不变，只是往这里推条目。每条一到就露面，没有暗处排队：
 * 常驻、出错与带动作的通知从不让位，4 条上限只约束普通通知，超出时按 yieldRank 把已有的普通通知挤掉（播退场后拿掉）。
 * 同一句话再来一次不新起一条，原来那条重新计时。
 */
export type ToastTone = 'ok' | 'info' | 'warn' | 'danger'

export interface ToastStackAction {
  label: string
  onClick?: () => void | Promise<void>
  emphasis: 'secondary' | 'text'
}

interface ToastStackInput {
  tone: ToastTone
  /** 调用方写的整段消息；第一个空行之前是标题，之后是说明。 */
  message: string
  actions?: ToastStackAction[]
  /** 毫秒；0 表示不自动消失。 */
  duration: number
}

interface ToastStackEntry extends ToastStackInput {
  id: number
  /** 推入或被同一句话刷新的时刻。暂停期间已超过时长的算已过期。 */
  postedAt: number
  exiting: boolean
}

const TOAST_STACK_LIMIT = 4
const EXIT_MS = 140

const toneIcons: Record<ToastTone, LucideIcon> = { ok: CircleCheck, info: Info, warn: TriangleAlert, danger: OctagonAlert }

let entries: ToastStackEntry[] = []
let counter = 0
const listeners = new Set<() => void>()
let mount: HTMLElement | null = null
let stackRoot: Root | null = null
const cards = new Map<number, HTMLElement>()
/** 每次改栈之前卡片在屏幕上的位置（含正在进行的位移），重排后从这里补间到新位置。 */
let lastTops = new Map<number, number>()

function publish(next: ToastStackEntry[]) {
  lastTops = new Map([...cards].map(([id, card]) => [id, card.getBoundingClientRect().top]))
  entries = next
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function ensureStack() {
  const target = toastStackMount()
  if (target === mount) return
  // 宿主被移走后旧栈不能留着：它的计时器会替新栈关掉条目
  stackRoot?.unmount()
  mount = target
  stackRoot = createRoot(target)
  stackRoot.render(<ToastStack />)
}

const liveEntries = (list: ToastStackEntry[]) => list.filter(entry => !entry.exiting)

function dismissToast(id: number) {
  if (!liveEntries(entries).some(entry => entry.id === id)) return
  publish(entries.map(entry => (entry.id === id ? { ...entry, exiting: true } : entry)))
  setTimeout(() => publish(entries.filter(entry => entry.id !== id)), EXIT_MS)
}

/** 常驻的「发现新版本」被挤掉后不会再弹，出错与动作没处找回，所以这三种不让位。 */
const isPinned = (entry: ToastStackInput) => entry.duration <= 0 || entry.tone === 'danger' || Boolean(entry.actions?.length)

/** 普通通知超出上限时谁先让位，数小的先走：已过期，再是完成与信息，再是提醒。 */
function yieldRank(entry: ToastStackEntry, now: number) {
  if (now - entry.postedAt >= entry.duration) return 0
  return entry.tone === 'warn' ? 2 : 1
}

/** 推入一条通知，返回关闭它的函数。 */
export function pushToast(input: ToastStackInput): () => void {
  ensureStack()
  const now = Date.now()
  const live = liveEntries(entries)
  const same = !input.actions?.length && live.find(entry => !entry.actions?.length && entry.tone === input.tone && entry.message === input.message)
  if (same) {
    publish(entries.map(entry => (entry === same ? { ...entry, postedAt: now } : entry)))
    return () => dismissToast(same.id)
  }
  // 新来的这条一定露面、不当受害者，它与不让位的各占一个名额，剩下的才留给已有的普通通知
  const ordinary = live.filter(entry => !isPinned(entry))
  const keep = Math.max(0, TOAST_STACK_LIMIT - 1 - (live.length - ordinary.length))
  const victims = ordinary
    .map(entry => ({ id: entry.id, rank: yieldRank(entry, now) }))
    .sort((a, b) => a.rank - b.rank || a.id - b.id)
    .slice(0, Math.max(0, ordinary.length - keep))
  const id = ++counter
  publish([...entries, { ...input, id, postedAt: now, exiting: false }])
  victims.forEach(victim => dismissToast(victim.id))
  return () => dismissToast(id)
}

/** 对话框开着时点通知不能被当成「点外部」而关掉对话框。 */
export function keepToastStackClickable(event: { target: EventTarget | null; preventDefault: () => void }) {
  if (event.target instanceof Element && event.target.closest('.pi-toast-stack')) event.preventDefault()
}

function splitMessage(message: string) {
  const at = message.indexOf('\n\n')
  return at < 0 ? { title: message, text: '' } : { title: message.slice(0, at), text: message.slice(at + 2).trim() }
}

function ToastCard({ entry, paused }: { entry: ToastStackEntry; paused: boolean }) {
  const text = useLocaleStore(s => s.text)
  const remaining = useRef(entry.duration)
  const Icon = toneIcons[entry.tone]
  const { title, text: detail } = splitMessage(entry.message)

  useEffect(() => {
    remaining.current = entry.duration
  }, [entry.postedAt, entry.duration])

  useEffect(() => {
    if (paused || entry.exiting || entry.duration <= 0) return
    const startedAt = Date.now()
    const timer = setTimeout(() => dismissToast(entry.id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current -= Date.now() - startedAt
    }
  }, [paused, entry.exiting, entry.duration, entry.id, entry.postedAt])

  const run = async (action: ToastStackAction) => {
    try {
      await action.onClick?.()
    } catch (error) {
      pushToast({ tone: 'danger', message: `${text('操作失败', 'Action failed')}\n\n${error instanceof Error ? error.message : String(error)}`, duration: 8000 })
    } finally {
      dismissToast(entry.id)
    }
  }

  return (
    <div
      ref={card => {
        if (card) cards.set(entry.id, card)
        return () => { cards.delete(entry.id) }
      }}
      className="pi-toast"
      data-tone={entry.tone}
      data-exiting={entry.exiting || undefined}
    >
      <span className="pi-toast-mark" aria-hidden><Icon /></span>
      <div className="pi-toast-body">
        <p className="pi-toast-title">{title}</p>
        {detail && <p className="pi-toast-text">{detail}</p>}
      </div>
      <Button variant="icon" size="sm" aria-label={text('关闭通知', 'Dismiss notification')} onClick={() => dismissToast(entry.id)}>
        <X aria-hidden />
      </Button>
      {entry.actions && entry.actions.length > 0 && (
        <div className="pi-toast-actions">
          {entry.actions.map(action => (
            <Button key={action.label} variant={action.emphasis} size="sm" onClick={() => void run(action)}>{action.label}</Button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 栈高过上限才改成滚动容器，平时 overflow 保持 visible，不裁卡片投影；刚变成可滚动或来了新的一条时滚到底让最新的露面。
 * 按布局高度量，不用 scrollHeight：进场与 FLIP 的位移也算进 scrollHeight，一条通知进场时就会误判。
 * 滚动条占走的宽度挪到栈右侧的留白里，卡片不跟着左移。
 */
function measureOverflow(stack: HTMLElement, revealNewest: boolean) {
  const last = stack.lastElementChild as HTMLElement | null
  const overflowing = last !== null && last.offsetTop + last.offsetHeight > stack.clientHeight + 1
  const was = stack.hasAttribute('data-overflow')
  stack.toggleAttribute('data-overflow', overflowing)
  stack.style.marginRight = overflowing ? `${stack.clientWidth - stack.offsetWidth}px` : ''
  if (overflowing && (revealNewest || !was)) stack.scrollTop = stack.scrollHeight
}

function ToastStack() {
  const items = useSyncExternalStore(subscribe, () => entries)
  const [paused, setPaused] = useState(false)
  const stackRef = useRef<HTMLDivElement>(null)
  const newestId = useRef(0)
  // 关掉最后一条时指针下已没有元素，mouseleave 不一定触发
  if (paused && items.length === 0) setPaused(false)

  // 增删一条时其余卡片从旧位置滑到新位置（FLIP）。只借用 CSS 的 transform 过渡，所以可打断，减少动态效果时也随之关掉
  useLayoutEffect(() => {
    const stack = stackRef.current
    if (stack) {
      const newest = items.at(-1)?.id ?? 0
      measureOverflow(stack, newest > newestId.current)
      newestId.current = Math.max(newestId.current, newest)
    }
    for (const [id, card] of cards) {
      const before = lastTops.get(id)
      if (before === undefined || card.dataset.exiting !== undefined) continue
      card.style.transitionProperty = 'opacity'
      card.style.transform = ''
      const shift = before - card.getBoundingClientRect().top
      if (Math.abs(shift) >= 1) {
        card.style.transform = `translateY(${shift}px)`
        card.getBoundingClientRect()
      }
      card.style.transitionProperty = ''
      card.style.transform = ''
    }
  }, [items])

  // 缩窗时栈的上限跟着变矮，条目没变也要重新判断
  useEffect(() => {
    const onResize = () => { if (stackRef.current) measureOverflow(stackRef.current, false) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return (
    // 模态的滚动锁在 document 上拦掉锁外的滚轮与触摸滚动；栈画在模态之上，滚动不该被锁，在冒泡到 document 之前截住
    <div
      ref={stackRef}
      className="pi-toast-stack"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onWheel={event => event.stopPropagation()}
      onTouchMove={event => event.stopPropagation()}
    >
      {items.map(entry => <ToastCard key={entry.id} entry={entry} paused={paused} />)}
    </div>
  )
}
