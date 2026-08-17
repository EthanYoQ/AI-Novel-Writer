import type { PresetSetupState } from './setup-store.ts'

/** Props for the framework-independent setup state body. */
export interface PresetSetupBodyProps {
  readonly state: PresetSetupState
  readonly install: () => void
  readonly retry: () => void
}

/**
 * Render the setup result and its explicit action without owning dialog chrome.
 *
 * @param props Current state and user-triggered actions.
 * @returns Accessible status content for the setup dialog.
 */
export function PresetSetupBody({ state, install, retry }: PresetSetupBodyProps) {
  switch (state.status) {
    case 'idle':
    case 'loading':
      return <p role="status">正在检查安装状态…</p>
    case 'not-installed':
      return (
        <div aria-live="polite">
          <p>安装后，请新建会话并选择“AI 小说作家”Preset。</p>
          <button type="button" className="aiNovelPresetPrimary" onClick={install}>安装 AI 小说作家 Preset</button>
        </div>
      )
    case 'installed':
      return (
        <div role="status" aria-live="polite">
          <p>Preset 已安装。</p>
          <p>请新建会话并选择“AI 小说作家”，现有会话不会被改写。</p>
        </div>
      )
    case 'conflict':
      return (
        <div role="alert">
          <p>检测到同名 Preset 冲突。</p>
          <p>插件没有覆盖任何用户文件；请重命名或移走现有目录后重试。</p>
          <button type="button" className="aiNovelPresetSecondary" onClick={retry}>重新检查</button>
        </div>
      )
    case 'error':
      return (
        <div role="alert">
          <p>安装状态读取失败：{state.message}</p>
          <button type="button" className="aiNovelPresetSecondary" onClick={retry}>重试</button>
        </div>
      )
    case 'disconnected':
      return (
        <div role="alert">
          <p>Harness 连接已断开。</p>
          <button type="button" className="aiNovelPresetSecondary" onClick={retry}>重新连接后重试</button>
        </div>
      )
  }
}
