/* eslint-disable react-refresh/only-export-components */
/**
 * Vela 全局 Toast 通知系统
 *
 * 用于轻量、非阻塞的操作反馈（成功、警告，普通信息）。
 * 关键错误请使用 alertError() — 见 AlertDialog.tsx。
 *
 * 使用 CSS 动画类替代 inline-style，统一与 index.css 中的 keyframes 对齐。
 *
 * 用法：
 *   import { toast } from '@/components/ui/Toast'
 *   toast.success('保存成功')
 *   toast.warning('字数超出限制')
 *   toast.info('提示信息')
 */

import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { X, CheckCircle2, AlertTriangle, Info } from 'lucide-react'

// ===== 类型定义 =====

export type ToastType = 'success' | 'error' | 'info' | 'warning'

interface ToastItem {
  id: number
  type: ToastType
  message: string
  duration: number
}

// ===== 全局状态 =====

let _toastCounter = 0
let _addToast: ((item: ToastItem) => void) | null = null

/** 挂载 Toast 容器到 DOM */
function ensureContainer() {
  if (document.getElementById('vela-toast-root')) return
  const container = document.createElement('div')
  container.id = 'vela-toast-root'
  document.body.appendChild(container)
  createRoot(container).render(<ToastContainer />)
}

// ===== Toast 容器组件 =====

function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    _addToast = (item) => {
      setToasts(prev => [...prev, item])
    }
    return () => { _addToast = null }
  }, [])

  const remove = (id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  /**
   * 先生：「已保存」要落在**正文栏内容区的右上角**才醒目 —— 那是写完一段后
   * 目光回落的地方；而贴整个窗口的最右侧会被右侧的 AI 助手栏占着，反而不显眼。
   *
   * 正文栏的右边界会随助手栏开合、侧栏折叠而变化，写死坐标必然错位，
   * 因此这里运行时测量工作区容器（.skin-workspace-page）的位置，
   * 把提示贴着它的右上角放；测不到就回落到窗口右上角。
   */
  const [rightOffset, setRightOffset] = useState(24)

  useEffect(() => {
    const update = () => {
      const workspace = document.querySelector('.skin-workspace-page')
      if (!workspace) {
        setRightOffset(24)
        return
      }
      const rect = workspace.getBoundingClientRect()
      setRightOffset(Math.max(16, Math.round(window.innerWidth - rect.right + 20)))
    }
    update()
    window.addEventListener('resize', update)
    // 助手栏开合不触发 resize，用一个很轻的轮询兜住布局变化
    const timer = window.setInterval(update, 800)
    return () => {
      window.removeEventListener('resize', update)
      window.clearInterval(timer)
    }
  }, [])

  return (
    <div
      className="fixed z-[9999] flex flex-col gap-2 pointer-events-none"
      style={{ top: 56, right: rightOffset }}
    >
      {toasts.map(t => (
        <ToastItemView key={t.id} item={t} onRemove={remove} />
      ))}
    </div>
  )
}

// ===== 单条 Toast =====

/** 类型 → 视觉映射（左边框颜色 + 图标 + 背景渐变） */
const TOAST_STYLE: Record<ToastType, { border: string; bg: string; icon: React.ReactNode }> = {
  success: {
    border: 'var(--color-success)',
    bg: 'color-mix(in srgb, var(--color-success) 10%, var(--color-raised))',
    icon: <CheckCircle2 size={15} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
  },
  error: {
    border: 'var(--color-error)',
    bg: 'color-mix(in srgb, var(--color-error) 10%, var(--color-raised))',
    icon: <AlertTriangle size={15} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
  },
  warning: {
    border: 'var(--color-warning)',
    bg: 'color-mix(in srgb, var(--color-warning) 10%, var(--color-raised))',
    icon: <AlertTriangle size={15} style={{ color: 'var(--color-warning)', flexShrink: 0 }} />
  },
  info: {
    border: 'var(--color-accent)',
    bg: 'color-mix(in srgb, var(--color-accent) 10%, var(--color-raised))',
    icon: <Info size={15} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
  },
}

function ToastItemView({ item, onRemove }: { item: ToastItem; onRemove: (id: number) => void }) {
  const [isExiting, setIsExiting] = useState(false)

  useEffect(() => {
    // 退场动画 - 提前 300ms 开始
    const t2 = setTimeout(() => setIsExiting(true), item.duration - 300)
    // 移除 DOM
    const t3 = setTimeout(() => onRemove(item.id), item.duration)
    return () => { clearTimeout(t2); clearTimeout(t3) }
  }, [item.id, item.duration, onRemove])

  const { border, bg, icon } = TOAST_STYLE[item.type]

  return (
    <div
      className={`
        pointer-events-auto flex items-start gap-3 px-4 py-3
        rounded-xl border backdrop-blur-xl
        ${isExiting ? 'animate-toast-exit' : 'animate-toast-enter'}
      `}
      style={{
        backgroundColor: bg,
        backdropFilter: 'blur(24px)',
        border: `1px solid var(--color-border)`,
        borderLeft: `3px solid ${border}`,
        boxShadow: 'var(--shadow-popover)',
        maxWidth: 380,
        minWidth: 260,
      }}
    >
      <div className="flex-shrink-0 mt-0.5">{icon}</div>
      <span
        className="flex-1 text-xs leading-relaxed"
        style={{
          color: 'var(--color-text)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {item.message}
      </span>
      <button
        onClick={() => onRemove(item.id)}
        className="flex-shrink-0 p-0.5 rounded transition-all duration-150 hover:bg-[var(--color-hover)]"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--color-text-muted)',
          lineHeight: 1,
        }}
      >
        <X size={13} />
      </button>
    </div>
  )
}

// ===== 公共 API =====

function show(message: string, type: ToastType = 'info', duration = 4000) {
  ensureContainer()
  const item: ToastItem = { id: ++_toastCounter, type, message, duration }
  // 等待下一帧确保容器已挂载
  requestAnimationFrame(() => _addToast?.(item))
}

export const toast = {
  success: (msg: string, duration = 3500) => show(msg, 'success', duration),
  error:   (msg: string, duration = 5000) => show(msg, 'error', duration),
  warning: (msg: string, duration = 4500) => show(msg, 'warning', duration),
  info:    (msg: string, duration = 4000) => show(msg, 'info', duration),
}
