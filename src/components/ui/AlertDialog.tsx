/**
 * 弹窗报错：需要作者明确知晓的关键错误（项目加载失败、文件读写错误等）。
 * 渲染为纸墨提示框（InkPrompt），跟随主题。
 *
 * 用法：
 *   alertError('不是有效的项目目录', { title: '打开项目失败' })
 */

import { useLocaleStore } from '../../stores/locale-store'
import { openInkPrompt } from './InkPrompt'

interface AlertOptions {
  /** 弹窗标题，默认「发生错误」 */
  title?: string
  /** 确认按钮文字，默认「确定」 */
  confirmText?: string
}

/**
 * 显示弹窗报错，返回 Promise（作者确认后 resolve）。也可以不 await。
 *
 * @example
 * await alertError('不是有效的项目目录', { title: '打开项目失败' })
 */
export function alertError(message: string, options?: AlertOptions): Promise<void> {
  const text = useLocaleStore.getState().text
  return openInkPrompt({
    kind: 'alert',
    title: options?.title ?? text('发生错误', 'Error'),
    message,
    confirmText: options?.confirmText ?? text('确定', 'OK'),
  }).then(() => undefined)
}
