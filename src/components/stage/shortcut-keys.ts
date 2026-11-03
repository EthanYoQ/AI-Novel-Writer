import { useLayoutStore } from '../../stores/layout-store'

export const IS_MAC = navigator.userAgent.includes('Mac')

/** 拉丁布局按 key 判断（Dvorak 等布局字母位置不同），非拉丁布局（俄文、希腊文等）按物理键位 code 判断。 */
function isLetter(event: Pick<KeyboardEvent, 'key' | 'code'>, letter: string): boolean {
  const key = event.key.toLowerCase()
  return /^[a-z]$/.test(key) ? key === letter : event.code === `Key${letter.toUpperCase()}`
}

/**
 * 平台的命令键加一个字母：macOS 只认 ⌘，其余平台只认 Ctrl，带 Alt 或 Shift 的组合不算。
 * macOS 上 Ctrl K、Ctrl P 是编辑器的行内命令（删到行尾、上一行），不能被外壳抢走。
 */
export function isCommand(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>, letter: string, mac = IS_MAC): boolean {
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return modifier && !event.altKey && !event.shiftKey && isLetter(event, letter)
}

export function commandLabel(letter: string, mac = IS_MAC): string {
  return mac ? `⌘${letter.toUpperCase()}` : `Ctrl ${letter.toUpperCase()}`
}

export function commandKeyLabel(key: string, mac = IS_MAC): string {
  return `${mac ? '⌘' : 'Ctrl'} + ${key}`
}

/** 输入法正在组字时，回车、方向键与 Esc 属于输入法（例如拼音选词），快捷键与列表都不接管。 */
export function isComposing(event: { isComposing?: boolean; keyCode: number }): boolean {
  return Boolean(event.isComposing) || event.keyCode === 229
}

const MODAL_SELECTOR = '[role="dialog"]:not(.pi-popover), [role="alertdialog"]'

/**
 * 界面上有模态层：旧的全局对话框（开关记在 layout-store）或页面上任何对话框、确认框、提示框。
 * 设置是页面而不是弹窗，不算模态层。
 * 模态层开着时外壳快捷键不在它下面再开层，否则新开的层被盖住，Radix 又抢走焦点，界面像冻住了一样。
 */
export function isModalOpen(): boolean {
  const layout = useLayoutStore.getState()
  return layout.exportOpen || layout.newProjectOpen || layout.importNovelOpen
    || document.querySelector(MODAL_SELECTOR) !== null
}
