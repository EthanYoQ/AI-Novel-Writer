import { useEffect } from 'react'
import { create } from 'zustand'
import { ipc } from '../../services/ipc-client'
import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { toast } from '../ui/Toast'

/** 设置页里还没保存的输入：各页用 useUnsavedSettings 登记，离开设置页或换页前由 leaveSettings 统一确认。 */
const unsaved = new Set<symbol>()
export function useUnsavedSettings(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return
    const token = Symbol('unsaved-settings')
    unsaved.add(token)
    return () => { unsaved.delete(token) }
  }, [dirty])
}

/** 等作者确认放弃修改的离开动作；为空时没有确认框。stay 在作者选继续编辑或确认框随设置页卸载时调用。 */
export const useSettingsLeave = create<{ pending: { proceed: () => void; stay?: () => void } | null }>(() => ({ pending: null }))

/** 关掉确认框：放弃就执行离开动作，否则通知发起方作者留下了。 */
export function settleSettingsLeave(discard: boolean): void {
  const pending = useSettingsLeave.getState().pending
  useSettingsLeave.setState({ pending: null })
  if (discard) pending?.proceed()
  else pending?.stay?.()
}

/** 设置页卸载时，还开着的放弃确认按作者留下结算。 */
export function useSettingsLeaveHost(): void {
  useEffect(() => () => settleSettingsLeave(false), [])
}

/**
 * 确认框开着时再来的离开请求（快捷键不受模态框拦）当作作者留下：确认框问的仍是原来那一个，
 * 新请求立即收到 stay，原请求由作者的回答结算，每个请求都恰好结算一次。作者按了却没反应会以为没按到，所以提示他先处理确认框。
 */
export function leaveSettings(action: () => void, stay?: () => void): void {
  if (unsaved.size === 0) action()
  else if (useSettingsLeave.getState().pending) {
    stay?.()
    toast.info(useLocaleStore.getState().text('请先处理「放弃未保存的修改？」', 'Resolve “Discard unsaved changes?” first'))
  } else useSettingsLeave.setState({ pending: { proceed: action, stay } })
}

/**
 * 会让设置页收起的导航（去别的阶段、回到书房、打开或新建作品）：有没保存的输入时先确认，取消就不走；
 * 确认后先收起设置页再执行，之后的自动落点（打开作品后落到哪一步）不会再问一次。
 */
export function leaveSettingsThen(action: () => void, stay?: () => void): void {
  leaveSettings(() => {
    useLayoutStore.getState().closeSettings()
    action()
  }, stay)
}

/**
 * 打开作品（作品菜单、命令面板、Ctrl O）：先确认放弃输入，再选文件夹，选到了才收起设置页去打开；
 * 选文件夹时取消，设置页与输入原样留着。
 */
export function openProjectFolder(): void {
  leaveSettings(() => void ipc.invoke('dialog:select-folder', 'project-open').then(folder => {
    if (!folder) return
    useLayoutStore.getState().closeSettings()
    return useProjectStore.getState().openProject(folder)
  }))
}

/**
 * 不经作者点击的自动导航（导入完成后、或任何时候 openProject 遇到设置页开着）用：有没保存的输入时先问。left 时设置页已收起；
 * stayed 是作者选了继续编辑；busy 是另一个放弃确认还开着，这次不问也不走。
 * 书房与作品里的设置页是两个实例，作品一提交书房里那个就卸载，所以要在提交之前问。
 */
export function confirmLeaveSettings(): Promise<'left' | 'stayed' | 'busy'> {
  if (useSettingsLeave.getState().pending) return Promise.resolve('busy')
  return new Promise(resolve => leaveSettingsThen(() => resolve('left'), () => resolve('stayed')))
}
