/**
 * 异步确认对话框，替代 window.confirm()，返回 Promise<boolean>。
 * 渲染为纸墨提示框（InkPrompt）；danger 时进场焦点落在「取消」上。
 *
 * 用法：
 *   const ok = await confirm('确定要归档吗？', { title: '归档' })
 */

import { useLocaleStore } from '../../stores/locale-store'
import { openInkPrompt } from './InkPrompt'

interface ConfirmOptions {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

/**
 * 显示确认对话框，返回 Promise<boolean>
 *
 * @example
 * const ok = await confirm('确定要删除此草稿吗？', { danger: true })
 */
export function confirm(
  message: string,
  options?: Partial<Omit<ConfirmOptions, 'message'>>,
): Promise<boolean> {
  const text = useLocaleStore.getState().text
  return openInkPrompt({
    kind: options?.danger ? 'danger' : 'confirm',
    title: options?.title ?? text('确认操作', 'Confirm action'),
    message,
    confirmText: options?.confirmText ?? text('确认', 'Confirm'),
    cancelText: options?.cancelText ?? text('取消', 'Cancel'),
  })
}
