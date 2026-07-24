import type {
  UpdateActionResponse,
  UpdateCheckResponse,
  UpdateReminderDelay,
  UpdateState,
} from '../services/update-service'

/** 可替换的 IPC 注册边界，便于独立验证，不把 Electron 对象传入服务层。 */
export interface UpdateIpcRegistrar {
  handle(channel: string, handler: (_event: unknown, ...args: unknown[]) => unknown): void
}

export interface UpdateServiceFacade {
  getState(): UpdateState
  checkManually(): Promise<UpdateCheckResponse>
  deferReminder(days: UpdateReminderDelay): Promise<UpdateActionResponse>
  requestInstall(): Promise<UpdateActionResponse>
  subscribe(listener: (state: UpdateState) => void): () => void
}

export interface UpdateControllerDependencies {
  ipc: UpdateIpcRegistrar
  /** 由主进程提供，负责向已有窗口广播状态。 */
  publish(state: UpdateState): void
}

function toRendererState(state: UpdateState): UpdateState {
  return {
    ...state,
    ...(state.error ? { error: { ...state.error } } : {}),
    ...(state.downloadProgress ? { downloadProgress: { ...state.downloadProgress } } : {}),
  }
}

/**
 * 注册更新功能的 IPC 通道。
 * 更新器只存在于主进程；渲染进程只能读取普通数据、请求检查、延后提示和显式安装。
 */
export function registerUpdateController(
  service: UpdateServiceFacade,
  { ipc, publish }: UpdateControllerDependencies,
): () => void {
  ipc.handle('update:get-state', async () => service.getState())
  ipc.handle('update:check', async () => service.checkManually())
  ipc.handle('update:defer-reminder', async (_event, days: unknown) => {
    const delay = typeof days === 'number' ? days : Number.NaN
    return service.deferReminder(delay as UpdateReminderDelay)
  })
  ipc.handle('update:quit-and-install', async () => service.requestInstall())

  return service.subscribe((state) => publish(toRendererState(state)))
}
