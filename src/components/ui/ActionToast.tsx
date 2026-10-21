/**
 * ActionToast：带操作按钮的通知，例如工作流完成后的「打开查看」「忽略」。
 * 与普通通知进同一个纸墨提示栈（ToastStack），只多了动作按钮。
 *
 * 用法：
 *   actionToast.show({ type: 'success', message: '草稿已生成', actions: [{ label: '打开查看', onClick: () => openDraft() }] })
 */

import { useLocaleStore } from '../../stores/locale-store'
import { pushToast, type ToastTone } from './ToastStack'

export type ActionToastType = 'success' | 'info' | 'warning' | 'error' | 'ai'

export interface ActionToastAction {
  /** 按钮文案 */
  label: string
  /** 点击回调（点击后通知自动关闭） */
  onClick?: () => void | Promise<void>
  /** 按钮风格：次按钮（primary）或文字按钮（ghost） */
  variant?: 'primary' | 'ghost'
}

export interface ActionToastOptions {
  /** 通知类型，决定语气符号 */
  type?: ActionToastType
  /** 通知消息 */
  message: string
  /** 操作按钮列表（最多 2 个） */
  actions?: ActionToastAction[]
  /** 自动消失时间（毫秒），设 0 表示不自动消失。默认 8000 */
  duration?: number
}

const INK_TONE: Record<ActionToastType, ToastTone> = { success: 'ok', info: 'info', warning: 'warn', error: 'danger', ai: 'info' }

function enqueue(options: ActionToastOptions): () => void {
  return pushToast({
    tone: INK_TONE[options.type ?? 'info'],
    message: options.message,
    actions: options.actions?.map(action => ({ label: action.label, onClick: action.onClick, emphasis: action.variant === 'ghost' ? 'text' : 'secondary' })),
    duration: options.duration ?? 8000,
  })
}

export const actionToast = {
  /** 显示带操作按钮的通知 */
  show: (options: ActionToastOptions) => enqueue(options),

  /** 工作流完成快捷方法 */
  workflowComplete: (message: string, openAction?: () => void | Promise<void>) => {
    const actions: ActionToastAction[] = []
    if (openAction) {
      const text = useLocaleStore.getState().text
      actions.push({ label: text('打开查看', 'Open'), onClick: openAction })
      actions.push({ label: text('忽略', 'Dismiss'), variant: 'ghost' })
    }
    enqueue({ type: 'ai', message, actions, duration: openAction ? 10000 : 6000 })
  },
}
