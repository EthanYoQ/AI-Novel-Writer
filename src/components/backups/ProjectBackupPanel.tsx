import { useEffect, useState } from 'react'
import { Archive, Cloud, Download, Upload } from 'lucide-react'

import { ipc } from '../../services/ipc-client'
import type {
  CloudBackupAccountView,
  CloudBackupBindingView,
  CloudBackupGenerationView,
} from '../../shared/cloud-backup'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { randomUUID } from '../../utils/id'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'

type Notice = { kind: 'error' | 'success' | 'info'; text: string } | null

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export default function ProjectBackupPanel() {
  const project = useProjectStore(state => state.currentProject)
  const projectSession = projectSessionContextFromProject(project)
  const sessionKey = projectSession
    ? `${projectSession.projectId}\0${projectSession.leaseId}\0${projectSession.projectPath}`
    : project?.id ?? 'no-project'
  return <ProjectBackupPanelSession
    key={sessionKey}
    project={project}
    projectSession={projectSession}
  />
}

function ProjectBackupPanelSession({
  project,
  projectSession,
}: {
  project: ReturnType<typeof useProjectStore.getState>['currentProject']
  projectSession: ReturnType<typeof projectSessionContextFromProject>
}) {
  const text = useLocaleStore(state => state.text)
  const sessionKey = projectSession
    ? `${projectSession.projectId}\0${projectSession.leaseId}\0${projectSession.projectPath}`
    : ''
  const [binding, setBinding] = useState<CloudBackupBindingView | null>(null)
  const [account, setAccount] = useState<CloudBackupAccountView | null>(null)
  const [endpoint, setEndpoint] = useState('')
  const [username, setUsername] = useState('')
  const [secret, setSecret] = useState('')
  const [cloudBookId, setCloudBookId] = useState('')
  const [parentIds, setParentIds] = useState<string[]>([])
  const [generations, setGenerations] = useState<CloudBackupGenerationView[]>([])
  const [selectedGenerationId, setSelectedGenerationId] = useState('')
  const [disclosureConfirmed, setDisclosureConfirmed] = useState(false)
  const [loadingView, setLoadingView] = useState(Boolean(projectSession))
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null)
  const [confirmClearCredential, setConfirmClearCredential] = useState(false)
  const [sessionOnlyCredential, setSessionOnlyCredential] = useState(false)
  const [bindingRefreshFailed, setBindingRefreshFailed] = useState(false)

  useEffect(() => {
    if (!projectSession) return
    let active = true
    void ipc.invoke('cloud-backup:view', projectSession).then(result => {
      if (!active) return
      if (!result.success) {
        setNotice({ kind: 'error', text: result.errorCode })
        return
      }
      setBinding(result.binding)
      setAccount(result.account)
      setSessionOnlyCredential(result.account?.persistence === 'session-only')
      if (result.account) {
        setEndpoint(result.account.endpoint)
        setUsername(result.account.username)
      }
      if (result.binding) {
        setCloudBookId(result.binding.cloudBookId)
        setParentIds(result.binding.lastSelectedParentGenerationIds)
      }
    }).catch(error => {
      if (active) setNotice({ kind: 'error', text: errorText(error) })
    }).finally(() => {
      if (active) setLoadingView(false)
    })
    return () => { active = false }
    // sessionKey is the frozen project/session boundary for this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  if (!project) {
    return <div className="space-y-3" data-testid="project-backup-panel">
      <p className="text-sm text-[var(--color-text)]">{text('请先打开一个项目，再导出存档或配置云备份。', 'Open a project before exporting an archive or configuring cloud backup.')}</p>
      <p className="text-xs text-[var(--color-text-muted)]">{text('恢复操作始终创建新副本，不会替换当前项目。', 'Restore always creates a new copy and never replaces the current project.')}</p>
    </div>
  }

  if (!projectSession) {
    return <p className="text-sm text-[var(--color-error-text)]">{text('当前项目缺少有效会话，请重新打开项目后再试。', 'The current project has no valid session. Reopen it and try again.')}</p>
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setNotice(null)
    try {
      await action()
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    } finally {
      setBusy(false)
    }
  }

  const exportLocal = () => run(async () => {
    const targetArchivePath = await ipc.invoke('dialog:select-project-archive-export', project.name)
    if (!targetArchivePath) return
    const result = await ipc.invoke('project:archive-export', { targetArchivePath, projectSession })
    if (!result.success) throw new Error(result.errorCode || result.error)
    setNotice({ kind: 'success', text: text(`本地存档已导出：${result.receipt.targetSha256}`, `Local archive exported: ${result.receipt.targetSha256}`) })
  })

  const restoreLocal = () => run(async () => {
    const archivePath = await ipc.invoke('dialog:select-project-archive')
    if (!archivePath) return
    const targetProjectRoot = await ipc.invoke('dialog:select-project-restore-target', `${project.name}-恢复副本`)
    if (!targetProjectRoot) return
    const result = await ipc.invoke('project:archive-restore', { archivePath, targetProjectRoot })
    if (!result.success) throw new Error(result.errorCode || result.error)
    setNotice({ kind: 'success', text: text(`已恢复新副本 ${result.receipt.targetProjectId}：${result.receipt.targetProjectRoot}`, `Restored copy ${result.receipt.targetProjectId}: ${result.receipt.targetProjectRoot}`) })
  })

  const connectAndBind = () => run(async () => {
    if (bindingRefreshFailed) throw new Error(text('本机凭据已清除，但绑定状态刷新失败。请关闭并重新打开设置后再连接。', 'The local credential was cleared, but the binding state could not be refreshed. Close and reopen settings before connecting.'))
    if (!endpoint.trim() || !username.trim() || !secret || !cloudBookId.trim()) throw new Error(text('请填写 WebDAV 地址、用户名、密钥和云书标识。', 'Enter the WebDAV endpoint, username, secret, and cloud book ID.'))
    const connected = await ipc.invoke('cloud-backup:connect', {
      endpoint: endpoint.trim(), username: username.trim(), secret,
    })
    if (!connected.success) throw new Error(connected.errorCode)
    const confirmed = await ipc.invoke('cloud-backup:confirm-binding', {
      projectSession,
      localEndpointAccountId: connected.account.accountId,
      cloudBookId: cloudBookId.trim(),
      lastSelectedParentGenerationIds: parentIds,
      expectedRevision: binding?.revision ?? null,
    })
    if (!confirmed.success) {
      const cleared = await ipc.invoke('cloud-backup:clear-credential', connected.account.accountId)
      if (!cleared.success) throw new Error(`${confirmed.errorCode}; ${cleared.errorCode}`)
      throw new Error(confirmed.errorCode)
    }
    const isSessionOnly = connected.warning === 'CLOUD_CREDENTIAL_SESSION_ONLY'
      || connected.account.persistence === 'session-only'
    setAccount(connected.account)
    setBinding(confirmed.binding)
    setSessionOnlyCredential(isSessionOnly)
    setSecret('')
    setNotice({
      kind: confirmed.staleCredentialRetained ? 'error' : isSessionOnly ? 'info' : 'success',
      text: confirmed.staleCredentialRetained
        ? text('WebDAV 已连接并绑定，但旧凭据未能清理；请检查本机凭据。尚未自动上传。', 'WebDAV connected and bound, but the old credential could not be cleared; check local credentials. Nothing was uploaded automatically.')
        : isSessionOnly
          ? text('WebDAV 已连接并绑定；凭据仅当前会话保存，重启后需重新输入。尚未自动上传。', 'WebDAV connected and bound; the credential is saved for this session only and must be entered again after restart. Nothing was uploaded automatically.')
          : text('WebDAV 已连接并绑定，尚未自动上传。', 'WebDAV connected and bound. Nothing was uploaded automatically.'),
    })
  })

  const confirmRebind = () => run(async () => {
    if (!account?.accountId || !cloudBookId.trim()) throw new Error(text('请先明确连接账号并填写云书标识。', 'Connect an account and enter a cloud book ID first.'))
    const result = await ipc.invoke('cloud-backup:confirm-binding', {
      projectSession,
      localEndpointAccountId: account.accountId,
      cloudBookId: cloudBookId.trim(),
      lastSelectedParentGenerationIds: parentIds,
      expectedRevision: binding?.revision ?? null,
    })
    if (!result.success) throw new Error(result.errorCode)
    setBinding(result.binding)
    setNotice({ kind: 'success', text: text('账号、云书和父世代已重新绑定；尚未上传。', 'Account, cloud book, and parents rebound. Nothing was uploaded.') })
  })

  const listGenerations = () => run(async () => {
    const localEndpointAccountId = account?.accountId ?? binding?.localEndpointAccountId
    const bookId = cloudBookId.trim() || binding?.cloudBookId
    if (!localEndpointAccountId || !bookId) throw new Error(text('请先连接并绑定云端账号。', 'Connect and bind a cloud account first.'))
    const result = await ipc.invoke('cloud-backup:list', { localEndpointAccountId, cloudBookId: bookId })
    if (!result.success) throw new Error(result.errorCode)
    setGenerations(result.generations)
    setNotice({ kind: 'success', text: text(`已读取 ${result.generations.length} 个云端世代。`, `Loaded ${result.generations.length} cloud generations.`) })
  })

  const backupNow = () => run(async () => {
    if (!disclosureConfirmed) throw new Error(text('请先确认云端披露说明。', 'Confirm the cloud disclosure first.'))
    if (binding?.mode !== 'writable') throw new Error(text('当前绑定不可写，请先重新绑定。', 'This binding is not writable. Rebind it first.'))
    const operationId = randomUUID()
    setActiveOperationId(operationId)
    try {
      const result = await ipc.invoke('cloud-backup:backup', { operationId, projectSession, disclosureConfirmed: true })
      if (!result.success) throw new Error(result.errorCode)
      if (result.binding) setBinding(result.binding)
      setNotice({ kind: 'success', text: text(`云备份完成：${result.generation.generationId}；备份点 ${result.backupPoint}${result.bindingSaved ? '' : '；绑定未保存'}`, `Cloud backup complete: ${result.generation.generationId}; backup point ${result.backupPoint}${result.bindingSaved ? '' : '; binding not saved'}`) })
    } finally {
      setActiveOperationId(current => current === operationId ? null : current)
    }
  })

  const restoreCloudCopy = () => run(async () => {
    const localEndpointAccountId = account?.accountId ?? binding?.localEndpointAccountId
    const bookId = cloudBookId.trim() || binding?.cloudBookId
    if (!localEndpointAccountId || !bookId || !selectedGenerationId) throw new Error(text('请先选择一个云端世代。', 'Select a cloud generation first.'))
    const targetProjectRoot = await ipc.invoke('dialog:select-project-restore-target', `${project.name}-恢复副本`)
    if (!targetProjectRoot) return
    const operationId = randomUUID()
    setActiveOperationId(operationId)
    try {
      const result = await ipc.invoke('cloud-backup:restore-copy', { operationId, localEndpointAccountId, cloudBookId: bookId, generationId: selectedGenerationId, targetProjectRoot })
      if (!result.success) throw new Error(result.errorCode)
      setNotice({ kind: 'success', text: text(`云端世代已恢复为新副本 ${result.receipt.targetProjectId}：${result.receipt.targetProjectRoot}${result.bindingSaved ? '' : '；绑定未保存'}`, `Cloud generation restored as copy ${result.receipt.targetProjectId}: ${result.receipt.targetProjectRoot}${result.bindingSaved ? '' : '; binding not saved'}`) })
    } finally {
      setActiveOperationId(current => current === operationId ? null : current)
    }
  })

  const cancelActiveOperation = async () => {
    if (!activeOperationId) return
    try {
      const result = await ipc.invoke('cloud-backup:cancel', activeOperationId)
      if (!result.success) throw new Error(result.errorCode)
      setNotice({
        kind: 'info',
        text: result.cancelled
          ? text('已发送取消请求，等待当前云操作停止。', 'Cancellation requested. Waiting for the current cloud operation to stop.')
          : text('当前云操作已无法取消，请等待最终结果。', 'The current cloud operation can no longer be cancelled. Wait for its final result.'),
      })
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error) })
    }
  }

  const clearCredential = () => run(async () => {
    const accountId = account?.accountId ?? binding?.localEndpointAccountId
    if (!accountId) throw new Error(text('当前没有可清除的本机凭据。', 'There is no local credential to clear.'))
    const result = await ipc.invoke('cloud-backup:clear-credential', accountId)
    if (!result.success) throw new Error(result.errorCode)
    setAccount(null)
    setBinding(null)
    setSecret('')
    setCloudBookId('')
    setDisclosureConfirmed(false)
    setGenerations([])
    setSelectedGenerationId('')
    setParentIds([])
    setSessionOnlyCredential(false)
    setConfirmClearCredential(false)
    setBindingRefreshFailed(true)
    const refreshed = await ipc.invoke('cloud-backup:view', projectSession)
    if (!refreshed.success) throw new Error(text(`本机凭据已清除，但绑定状态刷新失败：${refreshed.errorCode}。请关闭并重新打开设置后再连接。`, `The local credential was cleared, but the binding state could not be refreshed: ${refreshed.errorCode}. Close and reopen settings before connecting.`))
    setBinding(refreshed.binding)
    setAccount(refreshed.account)
    setCloudBookId(refreshed.binding?.cloudBookId ?? '')
    setParentIds(refreshed.binding?.lastSelectedParentGenerationIds ?? [])
    setSessionOnlyCredential(refreshed.account?.persistence === 'session-only')
    setBindingRefreshFailed(false)
    setNotice({ kind: 'success', text: text('本机凭据已清除，绑定现为未配置；历史云世代未删除。', 'The local credential was cleared and the binding is now unconfigured. Existing cloud generations were not deleted.') })
  })

  const toggleParent = (generationId: string) => setParentIds(current => current.includes(generationId) ? current.filter(id => id !== generationId) : [...current, generationId])
  const writable = binding?.mode === 'writable'

  return <div className="space-y-5" data-testid="project-backup-panel">
    <section className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Archive size={16} />{text('本地便携存档', 'Local portable archive')}</h3>
      <p className="text-xs text-[var(--color-text-muted)]">{text('导出完整项目；恢复始终创建新副本，不会打开或替换当前项目。', 'Export the complete project. Restore always creates a new copy without opening or replacing the current project.')}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void exportLocal()} disabled={busy}><Upload size={14} />{text('导出本地存档', 'Export local archive')}</Button>
        <Button type="button" variant="outline" onClick={() => void restoreLocal()} disabled={busy}><Download size={14} />{text('从本地存档恢复副本', 'Restore a copy from local archive')}</Button>
      </div>
    </section>

    <section className="space-y-3 rounded-lg border border-[var(--color-border)] p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Cloud size={16} />WebDAV</h3>
      {loadingView && <p role="status" className="text-xs">{text('正在读取云备份配置…', 'Loading cloud backup configuration…')}</p>}
      {!loadingView && (!binding || binding.mode === 'unconfigured') && <p className="text-sm">{text('尚未配置 WebDAV。填写下方信息并明确连接、绑定后，才可手动上传。', 'WebDAV is not configured. Enter the details and explicitly connect and bind before manually uploading.')}</p>}
      {binding?.mode === 'origin-readonly' && <p className="text-sm text-[var(--color-warning-text)]">{text('此项目携带来源只读绑定，或本机缺少对应凭据。重新选择账号、云书和父世代并确认绑定后才能上传。', 'This project has an origin-readonly binding or its credential is unavailable. Select an account, cloud book, and parents, then confirm the binding before uploading.')}</p>}
      {binding?.mode === 'writable' && <p className="text-xs text-[var(--color-text-muted)]">{text(`可写绑定：${binding.localEndpointAccountId} / ${binding.cloudBookId}`, `Writable binding: ${binding.localEndpointAccountId} / ${binding.cloudBookId}`)}</p>}
      {sessionOnlyCredential && <p role="status" className="text-sm text-[var(--color-warning-text)]">{text('凭据仅当前会话保存，重启后需重新输入。', 'The credential is saved for this session only and must be entered again after restart.')}</p>}
      {bindingRefreshFailed && <p role="alert" className="text-sm text-[var(--color-error-text)]">{text('本机凭据已清除，但绑定状态刷新失败。请关闭并重新打开设置后再连接。', 'The local credential was cleared, but the binding state could not be refreshed. Close and reopen settings before connecting.')}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label htmlFor="backup-endpoint">{text('WebDAV 地址', 'WebDAV endpoint')}</Label><Input id="backup-endpoint" value={endpoint} onChange={event => setEndpoint(event.target.value)} /></div>
        <div><Label htmlFor="backup-username">{text('用户名', 'Username')}</Label><Input id="backup-username" value={username} onChange={event => setUsername(event.target.value)} /></div>
        <div><Label htmlFor="backup-secret">{text('密码或应用密钥', 'Password or app secret')}</Label><Input id="backup-secret" type="password" value={secret} onChange={event => setSecret(event.target.value)} /></div>
        <div><Label htmlFor="backup-cloud-book">{text('云书标识', 'Cloud book ID')}</Label><Input id="backup-cloud-book" value={cloudBookId} onChange={event => setCloudBookId(event.target.value)} /></div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void connectAndBind()} disabled={busy || bindingRefreshFailed}>{text('连接并绑定', 'Connect and bind')}</Button>
        {account && <Button type="button" variant="outline" onClick={() => void confirmRebind()} disabled={busy}>{text('确认父世代并重新绑定', 'Confirm parents and rebind')}</Button>}
        {(account || binding) && <Button type="button" variant="outline" onClick={() => void listGenerations()} disabled={busy}>{text('刷新云端世代', 'Refresh cloud generations')}</Button>}
        {(account || binding?.localEndpointAccountId) && !confirmClearCredential && <Button type="button" variant="outline" onClick={() => setConfirmClearCredential(true)} disabled={busy}>{text('清除本机凭据', 'Clear local credential')}</Button>}
      </div>
      {confirmClearCredential && <div className="space-y-2 rounded border border-[var(--color-warning)] p-2 text-xs">
        <p>{text('只清除本机凭据并使绑定变为未配置；不会删除历史云世代。', 'This only clears the local credential and makes the binding unconfigured; it does not delete existing cloud generations.')}</p>
        <div className="flex gap-2">
          <Button type="button" variant="destructive" onClick={() => void clearCredential()} disabled={busy}>{text('确认清除本机凭据', 'Confirm clearing local credential')}</Button>
          <Button type="button" variant="outline" onClick={() => setConfirmClearCredential(false)} disabled={busy}>{text('取消清除', 'Cancel clearing')}</Button>
        </div>
      </div>}

      {generations.length > 0 && <ul className="space-y-2">
        {generations.map(generation => <li key={generation.generationId} className="rounded border border-[var(--color-border)] p-2 text-xs">
          <label className="flex items-center gap-2 text-[var(--color-text)]"><input type="radio" name="restore-generation" value={generation.generationId} checked={selectedGenerationId === generation.generationId} onChange={() => setSelectedGenerationId(generation.generationId)} /><strong>{generation.generationId}</strong></label>
          <p>{new Date(generation.createdAt).toLocaleString()} · {generation.archiveByteSize.toLocaleString()} bytes · SHA-256 {generation.archiveSha256.slice(0, 12)}…</p>
          <p>{text('备份点', 'Backup point')}: {generation.portableSnapshotGeneration} · {generation.hasSibling ? text(`分支同级：${generation.siblingGenerationIds.join(', ')}`, `Branch siblings: ${generation.siblingGenerationIds.join(', ')}`) : text('无分支同级', 'No branch sibling')}</p>
          <label className="mt-1 flex items-center gap-2"><input type="checkbox" checked={parentIds.includes(generation.generationId)} onChange={() => toggleParent(generation.generationId)} />{text('作为下次备份父世代', 'Use as parent for the next backup')}</label>
        </li>)}
      </ul>}

      <label className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]"><input type="checkbox" name="cloud-disclosure" checked={disclosureConfirmed} onChange={event => setDisclosureConfirmed(event.target.checked)} /><span>{text('我确认：此备份不是端到端加密，内容对我的云端服务可见，并包含项目正文、配置和便携资产。', 'I understand this backup is not end-to-end encrypted, is visible to my cloud provider, and includes the manuscript, configuration, and portable assets.')}</span></label>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void backupNow()} disabled={busy || !writable}>{text('立即云备份', 'Back up now')}</Button>
        <Button type="button" variant="outline" onClick={() => void restoreCloudCopy()} disabled={busy || !selectedGenerationId}>{text('恢复所选云端世代为副本', 'Restore selected cloud generation as a copy')}</Button>
        {activeOperationId && <Button type="button" variant="destructive" onClick={() => void cancelActiveOperation()}>{text('取消当前云操作', 'Cancel current cloud operation')}</Button>}
      </div>
    </section>

    {notice && <p role={notice.kind === 'error' ? 'alert' : 'status'} className="text-sm" style={{ color: notice.kind === 'error' ? 'var(--color-error-text)' : notice.kind === 'success' ? 'var(--color-success-text)' : 'var(--color-text-secondary)' }}>{notice.text}</p>}
  </div>
}
