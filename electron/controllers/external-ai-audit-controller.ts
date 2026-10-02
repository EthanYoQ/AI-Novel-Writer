import { ipcMain, shell } from 'electron'

import { normalizeExternalAiUrl } from '../../src/shared/external-ai-audit'

export interface ExternalAiAuditControllerOptions {
  /** 可注入边界：测试里不把 shell 暴露给渲染进程，也能确定性地断言打开行为。 */
  openExternal?: (url: string) => Promise<void>
  ipc?: Pick<typeof ipcMain, 'handle'>
}

/**
 * 打开作者收藏的网页版 AI 对话页（走系统默认浏览器）。
 *
 * 与 model-provider-resource 那份「固定 ID 白名单」不同：作者可以自己新建入口、
 * 粘贴任意网页版 AI 的链接，所以这里**必须**接受渲染进程传来的地址。安全底线
 * 于是从「固定表」移到 URL 规范化上 —— 只放行 http/https，file:、javascript:
 * 之类的协议一律拒绝。
 *
 * 关键：渲染进程的输入永远不可信，校验必须在主进程**再做一次**，
 * 即使渲染侧已经校验过（那边只是为了早点给作者报错）。
 */
export function registerExternalAiAuditController({
  openExternal = url => shell.openExternal(url),
  ipc = ipcMain,
}: ExternalAiAuditControllerOptions = {}) {
  ipc.handle('external-ai-audit:open', async (_event, url: unknown) => {
    const target = normalizeExternalAiUrl(url)
    if (!target) {
      return { success: false, error: 'Unsupported external AI address.' }
    }

    try {
      await openExternal(target)
      return { success: true }
    } catch (error) {
      console.warn('[AI Novel Writer] Unable to open the external AI page.', error)
      return { success: false, error: 'Unable to open the external AI page.' }
    }
  })
}
