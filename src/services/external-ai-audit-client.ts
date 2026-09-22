import { ipc } from './ipc-client'

/**
 * 「外部 AI 审计」的两件副作用：写剪贴板、开系统浏览器。
 *
 * 单独成文件是为了两件事：
 *  1. UI 只关心「成了没有」，不关心 navigator.clipboard 与 IPC 的细节；
 *  2. 这两件事都能注入替身，浏览器化测试里可以直接断言调用，不去碰真实剪贴板。
 */

/**
 * 写入剪贴板。
 *
 * 先走标准 clipboard API；它在 Electron 里理论上可用，但窗口未聚焦等场合会
 * reject，所以保留一条 document.execCommand('copy') 的回退 —— 宁可多留一条
 * 老路，也不要让作者点了按钮却什么也没复制到。
 */
export async function writeClipboardText(
  text: string,
  deps: { clipboard?: Pick<Clipboard, 'writeText'>; doc?: Document } = {},
): Promise<boolean> {
  const clipboard = deps.clipboard
    ?? (typeof navigator === 'undefined' ? undefined : navigator.clipboard)

  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // 落到下面的回退路径
    }
  }

  const doc = deps.doc ?? (typeof document === 'undefined' ? undefined : document)
  if (!doc) return false

  try {
    const textarea = doc.createElement('textarea')
    textarea.value = text
    // 固定在视口内但完全透明：某些浏览器会拒绝复制不可见/在屏幕外的选区
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '0'
    textarea.style.width = '1px'
    textarea.style.height = '1px'
    textarea.style.opacity = '0'
    doc.body.appendChild(textarea)
    textarea.select()
    const copied = typeof doc.execCommand === 'function' ? doc.execCommand('copy') : false
    doc.body.removeChild(textarea)
    return copied
  } catch {
    return false
  }
}

/**
 * 把审稿材料当「文件」放进系统剪贴板。
 *
 * 主进程会先把它们写成 .md（落在应用数据目录的 external-audit/），
 * 再用 Windows 的文件剪贴板格式投递 —— 作者到网页版 AI 输入框 Ctrl+V，
 * 浏览器会当成「粘贴了这几个文件」，直接触发上传。
 */
export async function copyExternalAiAuditFiles(
  files: Array<{ name: string; content: string }>,
  deps: { invoke?: typeof ipc.invoke } = {},
): Promise<{ success: boolean; directory?: string; fileCount?: number; error?: string }> {
  const invoke = deps.invoke ?? ipc.invoke
  try {
    return await invoke('external-ai-audit:copy-files', files)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unable to copy the review files.',
    }
  }
}

/**
 * 用系统默认浏览器打开外部 AI 页面。
 *
 * Electron 里必须走主进程：主窗口装过 setWindowOpenHandler，渲染进程自己
 * window.open 会被拦下。浏览器直开（无 velaAPI 的开发场景）才退回 window.open。
 */
export async function openExternalAiPage(
  url: string,
  deps: { invoke?: typeof ipc.invoke; openWindow?: (url: string) => void } = {},
): Promise<{ success: boolean; error?: string }> {
  if (!ipc.isElectron) {
    const openWindow = deps.openWindow ?? ((target: string) => { window.open(target, '_blank', 'noopener') })
    try {
      openWindow(url)
      return { success: true }
    } catch {
      return { success: false, error: 'Unable to open the external AI page.' }
    }
  }

  const invoke = deps.invoke ?? ipc.invoke
  try {
    return await invoke('external-ai-audit:open', url)
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unable to open the external AI page.',
    }
  }
}
