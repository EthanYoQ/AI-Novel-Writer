/**
 * 全局通知：轻量、非阻塞的操作反馈（成功、警告、普通信息、错误）。
 * 关键错误请使用 alertError()，见 AlertDialog.tsx。所有通知进同一个纸墨提示栈（ToastStack）。
 *
 * 用法：
 *   toast.success('保存成功')
 *   toast.warning('字数超出限制')
 */

import { pushToast, type ToastTone } from './ToastStack'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

const INK_TONE: Record<ToastType, ToastTone> = { success: 'ok', error: 'danger', warning: 'warn', info: 'info' }

function show(message: string, type: ToastType = 'info', duration = 4000) {
  pushToast({ tone: INK_TONE[type], message, duration })
}

export const toast = {
  success: (msg: string, duration = 3500) => show(msg, 'success', duration),
  error:   (msg: string, duration = 5000) => show(msg, 'error', duration),
  warning: (msg: string, duration = 4500) => show(msg, 'warning', duration),
  info:    (msg: string, duration = 4000) => show(msg, 'info', duration),
}
