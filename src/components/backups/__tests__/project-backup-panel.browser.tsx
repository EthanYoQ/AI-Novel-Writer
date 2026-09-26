import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import ProjectBackupPanel from '../ProjectBackupPanel'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PROJECT = {
  id: 'book-1',
  sessionLease: 'lease-1',
  name: '第一部小说',
  path: 'C:\\novels\\book-1',
  novelConfig: {},
} as never
const SESSION = { projectId: 'book-1', leaseId: 'lease-1', projectPath: 'C:\\novels\\book-1' }
const ACCOUNT = { accountId: 'account-1', endpoint: 'https://dav.example.test', username: 'writer', persistence: 'os-backed' as const }
const BINDING = {
  localProjectId: 'book-1', cloudBookId: 'cloud-book', localEndpointAccountId: 'account-1',
  lastSelectedParentGenerationIds: [], mode: 'writable' as const, revision: 3,
}
const GENERATION = {
  cloudBookId: 'cloud-book', generationId: 'generation-1', parentGenerationIds: [],
  createdAt: '2026-09-21T01:02:03.000Z', originProjectId: 'book-1',
  portableSnapshotGeneration: 'snapshot-7', archiveSha256: 'abcdef0123456789',
  archiveByteSize: 4096, hasSibling: true, siblingGenerationIds: ['generation-sibling'],
}

const originalProject = useProjectStore.getState()
const originalLocale = useLocaleStore.getState()
let container: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

function button(label: string) {
  const match = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent?.includes(label))
  if (!match) throw new Error(`Missing button: ${label}`)
  return match
}

function input(label: string) {
  const node = [...container.querySelectorAll<HTMLLabelElement>('label')]
    .find(candidate => candidate.textContent?.includes(label))
  const field = node?.htmlFor ? container.querySelector<HTMLInputElement>(`#${node.htmlFor}`) : null
  if (!field) throw new Error(`Missing input: ${label}`)
  return field
}

async function fill(label: string, value: string) {
  await act(async () => {
    const field = input(label)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function renderPanel() {
  await act(async () => {
    root.render(<ProjectBackupPanel />)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: PROJECT })
  invoke = vi.fn(async (channel: string) => channel === 'cloud-backup:view'
    ? { success: true, state: 'unconfigured', binding: null, account: null }
    : { success: true })
  Object.defineProperty(window, 'aiNovelAPI', { configurable: true, value: { invoke } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useProjectStore.setState(originalProject, true)
  useLocaleStore.setState(originalLocale, true)
  Reflect.deleteProperty(window, 'aiNovelAPI')
})

describe('ProjectBackupPanel', () => {
  it('guides an unconfigured project and connects before explicit binding', async () => {
    invoke.mockImplementation(async (channel: string, request?: unknown) => {
      if (channel === 'cloud-backup:view') return { success: true, state: 'unconfigured', binding: null, account: null }
      if (channel === 'cloud-backup:connect') return { success: true, state: 'connected', account: ACCOUNT }
      if (channel === 'cloud-backup:confirm-binding') return { success: true, state: 'configured', binding: BINDING }
      throw new Error(`Unexpected IPC: ${channel} ${JSON.stringify(request)}`)
    })
    await renderPanel()
    expect(container.textContent).toContain('尚未配置 WebDAV')
    expect(invoke).toHaveBeenCalledWith('cloud-backup:view', SESSION)

    await fill('WebDAV 地址', ACCOUNT.endpoint)
    await fill('用户名', ACCOUNT.username)
    await fill('密码或应用密钥', 'secret-value')
    await fill('云书标识', 'cloud-book')
    await act(async () => button('连接并绑定').click())

    expect(invoke).toHaveBeenCalledWith('cloud-backup:connect', {
      endpoint: ACCOUNT.endpoint, username: ACCOUNT.username, secret: 'secret-value',
    })
    expect(invoke).toHaveBeenCalledWith('cloud-backup:confirm-binding', {
      projectSession: SESSION,
      localEndpointAccountId: 'account-1',
      cloudBookId: 'cloud-book',
      lastSelectedParentGenerationIds: [],
      expectedRevision: null,
    })
  })

  it('stages a new account for writable credential rotation without overwriting the old binding', async () => {
    const rotatedAccount = { ...ACCOUNT, accountId: 'account-2' }
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'cloud-backup:view') return { success: true, state: 'configured', binding: BINDING, account: ACCOUNT }
      if (channel === 'cloud-backup:connect') return { success: true, state: 'connected', account: rotatedAccount }
      if (channel === 'cloud-backup:confirm-binding') return { success: true, state: 'configured', binding: { ...BINDING, localEndpointAccountId: rotatedAccount.accountId, revision: 4 }, staleCredentialRetained: true }
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    await renderPanel()
    await fill('密码或应用密钥', 'replacement-secret')
    await act(async () => button('连接并绑定').click())
    expect(invoke).toHaveBeenCalledWith('cloud-backup:connect', {
      endpoint: ACCOUNT.endpoint, username: ACCOUNT.username, secret: 'replacement-secret',
    })
    expect(invoke).toHaveBeenCalledWith('cloud-backup:confirm-binding', expect.objectContaining({
      localEndpointAccountId: rotatedAccount.accountId, expectedRevision: BINDING.revision,
    }))
    expect(container.textContent).toContain('旧凭据未能清理')
  })

  it('clears the staged account when binding confirmation conflicts', async () => {
    const rotatedAccount = { ...ACCOUNT, accountId: 'account-2' }
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'cloud-backup:view') return { success: true, state: 'configured', binding: BINDING, account: ACCOUNT }
      if (channel === 'cloud-backup:connect') return { success: true, state: 'connected', account: rotatedAccount }
      if (channel === 'cloud-backup:confirm-binding') return { success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_BINDING_CONFLICT' }
      if (channel === 'cloud-backup:clear-credential') return { success: true, state: 'unconfigured', affectedBindings: 0 }
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    await renderPanel()
    await fill('密码或应用密钥', 'replacement-secret')
    await act(async () => button('连接并绑定').click())
    expect(invoke).toHaveBeenCalledWith('cloud-backup:clear-credential', rotatedAccount.accountId)
    expect(container.textContent).toContain('CLOUD_BACKUP_BINDING_CONFLICT')
  })

  it('exports and restores a local copy with exact payloads without opening it', async () => {
    const openProject = vi.fn()
    useProjectStore.setState({ openProject })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'cloud-backup:view') return { success: true, state: 'unconfigured', binding: null, account: null }
      if (channel === 'dialog:select-project-archive-export') return 'C:\\exports\\book.anovel'
      if (channel === 'project:archive-export') return { success: true, receipt: { snapshotGeneration: '7', targetSha256: 'export-hash' } }
      if (channel === 'dialog:select-project-archive') return 'C:\\imports\\book.anovel'
      if (channel === 'dialog:select-project-restore-target') return 'C:\\novels\\book-restored'
      if (channel === 'project:archive-restore') return { success: true, receipt: { targetProjectId: 'copy-1', targetProjectRoot: 'C:\\novels\\book-restored' }, recentProjectUpdated: true }
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    await renderPanel()

    await act(async () => button('导出本地存档').click())
    expect(invoke).toHaveBeenCalledWith('dialog:select-project-archive-export', '第一部小说')
    expect(invoke).toHaveBeenCalledWith('project:archive-export', {
      targetArchivePath: 'C:\\exports\\book.anovel', projectSession: SESSION,
    })
    expect(container.textContent).toContain('export-hash')

    await act(async () => button('从本地存档恢复副本').click())
    expect(invoke).toHaveBeenCalledWith('dialog:select-project-archive')
    expect(invoke).toHaveBeenCalledWith('dialog:select-project-restore-target', '第一部小说-恢复副本')
    expect(invoke).toHaveBeenCalledWith('project:archive-restore', {
      archivePath: 'C:\\imports\\book.anovel', targetProjectRoot: 'C:\\novels\\book-restored',
    })
    expect(container.textContent).toContain('copy-1')
    expect(openProject).not.toHaveBeenCalled()
    expect(useProjectStore.getState().currentProject).toBe(PROJECT)
  })

  it('requires disclosure before upload and shows the backup point and unsaved binding', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'cloud-backup:view') return { success: true, state: 'configured', binding: BINDING, account: ACCOUNT }
      if (channel === 'cloud-backup:backup') return {
        success: true, state: 'binding-not-saved', operationId: 'op-1', generation: GENERATION,
        backupPoint: 'backup-point-7', bindingSaved: false, binding: BINDING,
      }
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    await renderPanel()

    await act(async () => button('立即云备份').click())
    expect(invoke.mock.calls.filter(call => call[0] === 'cloud-backup:backup')).toHaveLength(0)
    expect(container.textContent).toContain('请先确认云端披露说明')

    const disclosure = container.querySelector<HTMLInputElement>('input[type="checkbox"][name="cloud-disclosure"]')!
    await act(async () => disclosure.click())
    await act(async () => button('立即云备份').click())
    expect(invoke).toHaveBeenCalledWith('cloud-backup:backup', {
      operationId: expect.any(String), projectSession: SESSION, disclosureConfirmed: true,
    })
    expect(container.textContent).toContain('generation-1')
    expect(container.textContent).toContain('backup-point-7')
    expect(container.textContent).toContain('绑定未保存')
  })

  it('keeps origin-readonly unable to upload and exposes an explicit rebind path', async () => {
    invoke.mockImplementation(async (channel: string) => channel === 'cloud-backup:view'
      ? { success: true, state: 'configured', binding: { ...BINDING, mode: 'origin-readonly' }, account: null }
      : { success: true })
    await renderPanel()

    expect(container.textContent).toContain('来源只读')
    expect(button('立即云备份').disabled).toBe(true)
    expect(button('连接并绑定')).toBeTruthy()
    expect(invoke.mock.calls.filter(call => call[0] === 'cloud-backup:backup')).toHaveLength(0)
  })

  it('keeps the current project after list and restore-copy failures', async () => {
    let listAttempts = 0
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'cloud-backup:view') return { success: true, state: 'configured', binding: BINDING, account: ACCOUNT }
      if (channel === 'cloud-backup:list') {
        listAttempts += 1
        return listAttempts === 1
          ? { success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_NETWORK_FAILED' }
          : { success: true, state: 'listed', generations: [GENERATION] }
      }
      if (channel === 'dialog:select-project-restore-target') return 'C:\\novels\\cloud-copy'
      if (channel === 'cloud-backup:restore-copy') return { success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_RESTORE_FAILED' }
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    await renderPanel()

    await act(async () => button('刷新云端世代').click())
    expect(container.textContent).toContain('CLOUD_BACKUP_NETWORK_FAILED')
    expect(useProjectStore.getState().currentProject).toBe(PROJECT)

    await act(async () => button('刷新云端世代').click())
    const generationChoice = container.querySelector<HTMLInputElement>('input[type="radio"][value="generation-1"]')!
    await act(async () => generationChoice.click())
    await act(async () => button('恢复所选云端世代为副本').click())
    expect(invoke).toHaveBeenCalledWith('cloud-backup:restore-copy', {
      operationId: expect.any(String), localEndpointAccountId: 'account-1', cloudBookId: 'cloud-book',
      generationId: 'generation-1', targetProjectRoot: 'C:\\novels\\cloud-copy',
    })
    expect(container.textContent).toContain('CLOUD_BACKUP_RESTORE_FAILED')
    expect(useProjectStore.getState().currentProject).toBe(PROJECT)
  })

  it('cancels deferred backup and restore-copy with each active operation id', async () => {
    const backup = deferred<unknown>()
    const restore = deferred<unknown>()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'cloud-backup:view') return { success: true, state: 'configured', binding: BINDING, account: ACCOUNT }
      if (channel === 'cloud-backup:backup') return backup.promise
      if (channel === 'cloud-backup:list') return { success: true, state: 'listed', generations: [GENERATION] }
      if (channel === 'dialog:select-project-restore-target') return 'C:\\novels\\cloud-copy'
      if (channel === 'cloud-backup:restore-copy') return restore.promise
      if (channel === 'cloud-backup:cancel') return { success: true, cancelled: true }
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    await renderPanel()

    await act(async () => container.querySelector<HTMLInputElement>('input[name="cloud-disclosure"]')!.click())
    await act(async () => button('立即云备份').click())
    const backupOperationId = invoke.mock.calls.find(call => call[0] === 'cloud-backup:backup')?.[1].operationId
    await vi.waitFor(() => expect(button('取消当前云操作')).toBeTruthy())
    await act(async () => button('取消当前云操作').click())
    expect(invoke).toHaveBeenCalledWith('cloud-backup:cancel', backupOperationId)
    expect(container.textContent).toContain('已发送取消请求')
    expect(container.textContent).not.toContain('云备份完成')
    await act(async () => backup.resolve({ success: false, state: 'cancelled', errorCode: 'CLOUD_BACKUP_CANCELLED' }))

    await act(async () => button('刷新云端世代').click())
    await act(async () => container.querySelector<HTMLInputElement>('input[value="generation-1"]')!.click())
    await act(async () => button('恢复所选云端世代为副本').click())
    const restoreOperationId = invoke.mock.calls.find(call => call[0] === 'cloud-backup:restore-copy')?.[1].operationId
    await vi.waitFor(() => expect(button('取消当前云操作')).toBeTruthy())
    await act(async () => button('取消当前云操作').click())
    expect(invoke).toHaveBeenCalledWith('cloud-backup:cancel', restoreOperationId)
    expect(container.textContent).not.toContain('已恢复为新副本')
    await act(async () => restore.resolve({ success: false, state: 'cancelled', errorCode: 'CLOUD_BACKUP_CANCELLED' }))
  })

  it('clears a local credential only after the second confirmation and returns to unconfigured', async () => {
    let viewCount = 0
    const clearedBinding = {
      ...BINDING,
      mode: 'unconfigured' as const,
      revision: 4,
      lastSelectedParentGenerationIds: ['generation-parent'],
    }
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'cloud-backup:view') {
        viewCount += 1
        return viewCount === 1
          ? { success: true, state: 'configured', binding: BINDING, account: ACCOUNT }
          : { success: true, state: 'configured', binding: clearedBinding, account: null }
      }
      if (channel === 'cloud-backup:clear-credential') return { success: true, state: 'unconfigured', affectedBindings: 1 }
      if (channel === 'cloud-backup:connect') return { success: true, state: 'connected', account: ACCOUNT }
      if (channel === 'cloud-backup:confirm-binding') return { success: true, state: 'configured', binding: { ...BINDING, revision: 5 } }
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    await renderPanel()

    await act(async () => button('清除本机凭据').click())
    expect(invoke.mock.calls.filter(call => call[0] === 'cloud-backup:clear-credential')).toHaveLength(0)
    expect(container.textContent).toContain('不会删除历史云世代')

    await act(async () => button('确认清除本机凭据').click())
    expect(invoke).toHaveBeenCalledWith('cloud-backup:clear-credential', 'account-1')
    expect(container.textContent).toContain('尚未配置 WebDAV')
    expect(container.querySelector<HTMLInputElement>('input[name="cloud-disclosure"]')?.checked).toBe(false)
    expect(useProjectStore.getState().currentProject).toBe(PROJECT)

    await fill('密码或应用密钥', 'replacement-secret')
    await act(async () => button('连接并绑定').click())
    expect(invoke).toHaveBeenCalledWith('cloud-backup:confirm-binding', {
      projectSession: SESSION,
      localEndpointAccountId: 'account-1',
      cloudBookId: 'cloud-book',
      lastSelectedParentGenerationIds: ['generation-parent'],
      expectedRevision: 4,
    })
    expect(container.textContent).toContain('可写绑定')
    expect(useProjectStore.getState().currentProject).toBe(PROJECT)
  })

  it.each([
    ['session-only warning', { ...ACCOUNT, persistence: 'session-only' as const }, 'CLOUD_CREDENTIAL_SESSION_ONLY', true],
    ['os-backed credential', ACCOUNT, undefined, false],
  ] as const)('shows the correct persistence state after connect: %s', async (_label, connectedAccount, warning, expectsWarning) => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'cloud-backup:view') return { success: true, state: 'unconfigured', binding: null, account: null }
      if (channel === 'cloud-backup:connect') return { success: true, state: 'connected', account: connectedAccount, ...(warning ? { warning } : {}) }
      if (channel === 'cloud-backup:confirm-binding') return { success: true, state: 'configured', binding: BINDING }
      throw new Error(`Unexpected IPC: ${channel}`)
    })
    await renderPanel()
    await fill('WebDAV 地址', ACCOUNT.endpoint)
    await fill('用户名', ACCOUNT.username)
    await fill('密码或应用密钥', 'secret-value')
    await fill('云书标识', 'cloud-book')
    await act(async () => button('连接并绑定').click())

    const warningVisible = container.textContent?.includes('凭据仅当前会话保存，重启后需重新输入') ?? false
    expect(warningVisible).toBe(expectsWarning)
  })

  it('uses the unconfigured guidance for an explicit unconfigured binding', async () => {
    invoke.mockImplementation(async (channel: string) => channel === 'cloud-backup:view'
      ? { success: true, state: 'configured', binding: { ...BINDING, mode: 'unconfigured' }, account: null }
      : { success: true })
    await renderPanel()

    expect(container.textContent).toContain('尚未配置 WebDAV')
  })
})
