import { useEffect, useMemo, useState, type ComponentType } from 'react'
import { ipc } from '../../services/ipc-client'
import { useAppearanceStore, type AppearanceBootstrapDependencies } from '../../stores/appearance-bootstrap'
import type { StartupState, StartupMigrationNotice, StartupBlockedCode } from '../../shared/startup-contract'

const desktopStartup: AppearanceBootstrapDependencies = {
  waitForMainReady: () => ipc.invoke('startup:get-state'),
  readSkinSnapshot: ready => ipc.invoke('startup:skin-snapshot', ready),
  acknowledgeReadback: ack => ipc.invoke('startup:appearance-ack', ack),
}
const loadApp = () => import('../../App')

/** Business modules are not imported until main and the renderer storage writer acknowledge readiness. */
export default function RendererStartup({
  loadWorkspace = loadApp,
  dependencies = desktopStartup,
}: {
  loadWorkspace?: () => Promise<{ default: ComponentType }>
  dependencies?: AppearanceBootstrapDependencies
}) {
  const [Workspace, setWorkspace] = useState<ComponentType | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loadFailed, setLoadFailed] = useState(false)
  const [migrationNotice, setMigrationNotice] = useState<StartupMigrationNotice>()
  const [blockedCode, setBlockedCode] = useState<StartupBlockedCode>()
  const [mainReady, setMainReady] = useState(false)
  const [noticeDismissed, setNoticeDismissed] = useState(false)
  const startupDependencies = useMemo(() => ({ ...dependencies, waitForMainReady: async () => {
    const state = await dependencies.waitForMainReady() as StartupState
    setMigrationNotice(state.migrationNotice)
    setBlockedCode(state.code)
    setMainReady(state.state === 'ready')
    return state
  } }), [dependencies])
  const phase = useAppearanceStore(state => state.phase)
  const notice = useAppearanceStore(state => state.notice)
  useEffect(() => {
    if (Workspace || !ipc.isElectron) return
    // No author editor exists before App mounts. After that App owns its dirty-work guard.
    return ipc.on('window:close-requested', ({ requestId }) => {
      void ipc.invoke('window:resolve-close', requestId, 'proceed').catch(() => undefined)
    })
  }, [Workspace])
  useEffect(() => {
    let disposed = false
    void useAppearanceStore.getState().bootstrap(startupDependencies).then(async ready => {
      if (!ready || disposed) return
      const module = await loadWorkspace()
      if (!disposed) setWorkspace(() => module.default)
    }).catch(() => { if (!disposed) setLoadFailed(true) })
    return () => { disposed = true }
  }, [attempt, startupDependencies, loadWorkspace])
  // A later preference write failure must not unmount editors or discard in-memory author work.
  if (Workspace) return <>
    {phase === 'blocked' && <div role="alert" className="fixed inset-x-0 top-10 z-50 bg-[var(--color-bg-primary)] px-4 py-2 text-center text-[var(--color-warning-text)]">{notice}</div>}
    {phase !== 'blocked' && !noticeDismissed && migrationNotice && (migrationNotice.legacySourceIgnored || migrationNotice.preservedUnknownCount > 0) &&
      <div role="status" className="fixed inset-x-0 top-10 z-50 flex items-center justify-center gap-4 bg-stone-100 px-4 py-2 text-stone-800">
        <span>{migrationNotice.legacySourceIgnored ? '旧来源已保留，后续修改需明确导入，当前不会自动回灌。' : ''}{migrationNotice.preservedUnknownCount > 0 ? '未导入的内容已保留在原处。' : ''}</span>
        <button type="button" className="rounded border border-stone-500 px-3 py-1" onClick={() => setNoticeDismissed(true)}>知道了</button>
      </div>}
    <Workspace />
  </>
  const blocked = phase === 'blocked' || loadFailed
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 bg-stone-100 px-8 text-stone-800" aria-busy={!blocked}>
      <h1 className="text-xl font-semibold">{blocked ? '启动尚未完成' : '正在检查现有配置'}</h1>
      <p role={blocked ? 'alert' : 'status'} className="max-w-xl text-center">
        {blocked ? blockedCode === 'GLOBAL_MODEL_CREDENTIALS_DIFFER' ? '新旧配置中同一模型的凭据不同。两份配置均已保留，请处理冲突后重新启动应用。' : notice ?? '工作台暂时无法加载。现有配置已保留，请重新启动应用。' : '确认配置和外观偏好后，将打开工作台。'}
      </p>
      {blocked && <>
        <p className="max-w-xl text-center text-sm">若全局配置存在冲突，请处理后重新启动应用。此页面不会用默认值覆盖现有配置。</p>
        <button type="button" className="rounded border border-stone-500 px-4 py-2" onClick={() => { setLoadFailed(false); setAttempt(value => value + 1) }}>重新检查</button>
        {mainReady && <button type="button" className="rounded border border-stone-500 px-4 py-2" onClick={() => { void ipc.invoke('window:close').catch(() => undefined) }}>关闭应用</button>}
      </>}
    </main>
  )
}
