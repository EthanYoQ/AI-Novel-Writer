import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CloudBackupProjectSessionContext } from '../../../src/shared/cloud-backup'
import type { CloudProjectBinding } from '../../services/cloud-project-binding-store'
import { WebDavBackupError } from '../../services/webdav-backup-service'
import {
  registerCloudBackupController,
  type CloudBackupControllerDependencies,
} from '../cloud-backup-controller'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const TARGET_PROJECT = '22222222-2222-4222-8222-222222222222'
const ACCOUNT = '33333333-3333-4333-8333-333333333333'
const ROTATED_ACCOUNT = '99999999-9999-4999-8999-999999999999'
const BOOK = '44444444-4444-4444-8444-444444444444'
const GENERATED_BOOK = '55555555-5555-4555-8555-555555555555'
const OPERATION = '66666666-6666-4666-8666-666666666666'
const OTHER_OPERATION = '77777777-7777-4777-8777-777777777777'
const GENERATION = '88888888-8888-4888-8888-888888888888'
const PARENT = 'parent-generation'
const roots: string[] = []

const session: CloudBackupProjectSessionContext = {
  projectId: PROJECT,
  leaseId: 'lease-a',
  projectPath: 'C:\\books\\source',
}

const writable: CloudProjectBinding = {
  localProjectId: PROJECT,
  cloudBookId: BOOK,
  localEndpointAccountId: ACCOUNT,
  lastSelectedParentGenerationIds: [PARENT],
  mode: 'writable',
  revision: 7,
}

const generation = {
  cloudBookId: BOOK,
  generationId: GENERATION,
  parentGenerationIds: [PARENT],
  createdAt: '2026-09-21T00:00:00.000Z',
  originProjectId: PROJECT,
  portableSnapshotGeneration: 'snapshot-a',
  archiveSha256: 'a'.repeat(64),
  archiveByteSize: 42,
  hasSibling: false,
  siblingGenerationIds: [],
}

type Handler = (_event: unknown, argument: unknown) => unknown

function fixture(overrides: Partial<CloudBackupControllerDependencies> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-backup-controller-'))
  roots.push(root)
  const handlers = new Map<string, Handler>()
  const order: string[] = []
  const ipc = { handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)) }
  const deps: CloudBackupControllerDependencies = {
    ipc,
    credentialStore: {
      list: vi.fn(() => [{ accountId: ACCOUNT, endpoint: 'https://dav.example.test/root/', username: 'writer', persistence: 'os-backed' as const }]),
      save: vi.fn(input => ({ metadata: { accountId: input.accountId ?? ACCOUNT, endpoint: input.endpoint, username: input.username, persistence: 'os-backed' as const } })),
      resolveSecret: vi.fn(() => ({
        metadata: { accountId: ACCOUNT, endpoint: 'https://dav.example.test/root/', username: 'writer', persistence: 'os-backed' as const },
        secret: 'top-secret',
      })),
      clear: vi.fn(() => true),
    },
    bindingStore: {
      get: vi.fn(() => writable),
      list: vi.fn(() => [writable]),
      saveWritable: vi.fn(input => ({ ...writable, ...input, mode: 'writable' as const, revision: input.expectedRevision === null ? 1 : input.expectedRevision + 1 })),
      saveOriginReadonly: vi.fn(input => ({ ...input, mode: 'origin-readonly' as const, revision: 1 })),
      markAccountUnconfigured: vi.fn(() => 1),
    },
    webDav: {
      checkConnection: vi.fn(async () => { order.push('check') }),
      appendGeneration: vi.fn(async () => { order.push('append'); return generation }),
      listGenerations: vi.fn(async () => [generation]),
      downloadGeneration: vi.fn(async input => {
        order.push('download')
        fs.writeFileSync(input.targetArchivePath, 'archive')
        return { generationId: GENERATION, targetArchivePath: input.targetArchivePath, archiveSha256: 'a'.repeat(64), archiveByteSize: 7 }
      }),
    },
    exportPortableProject: vi.fn(async input => {
      order.push('export')
      fs.writeFileSync(input.targetArchivePath, 'archive')
      return {
        originProjectId: PROJECT,
        snapshotGeneration: 'snapshot-a',
        targetSha256: 'a'.repeat(64),
        targetByteSize: 7,
        sourceEvidence: { schemaVersion: 1, schemaFingerprint: 'fingerprint', tableCount: 1, fieldCount: 1 },
        entryCount: 1,
        requiresRuntimeFreezeGuard: true as const,
      }
    }),
    restorePortableProject: vi.fn(async input => {
      order.push('restore')
      return {
        originProjectId: PROJECT,
        targetProjectId: TARGET_PROJECT,
        targetProjectRoot: input.targetProjectRoot,
        snapshotGeneration: 'snapshot-a',
        portableDatabaseSha256: 'b'.repeat(64),
        requiresRuntimeFreezeGuard: true as const,
      }
    }),
    portableAssets: { snapshot: vi.fn() },
    assertCurrentProjectContext: vi.fn(() => ({ projectId: PROJECT, leaseId: 'lease-a', rootPath: session.projectPath })),
    getCurrentProjectPath: vi.fn(() => session.projectPath),
    sameCanonicalProjectRoot: vi.fn(() => true),
    getGlobalDataRoot: vi.fn(() => root),
    readRestoredProjectName: vi.fn(() => '恢复后的真实书名'),
    registerRecentProject: vi.fn(),
    idFactory: vi.fn(() => GENERATED_BOOK),
    now: vi.fn(() => new Date('2026-09-21T01:00:00.000Z')),
    ...overrides,
  }
  registerCloudBackupController(deps)
  const invoke = async (channel: string, argument: unknown) => handlers.get(channel)!(undefined, argument)
  return { deps, invoke, order, root }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('registerCloudBackupController', () => {
  it('checks a connection before saving and returns only renderer-safe credential metadata', async () => {
    const f = fixture()
    vi.mocked(f.deps.credentialStore.save).mockImplementation(input => {
      f.order.push('save')
      return {
        metadata: { accountId: ACCOUNT, endpoint: input.endpoint, username: input.username, persistence: 'session-only' },
        warning: 'CLOUD_CREDENTIAL_SESSION_ONLY',
      }
    })

    const result = await f.invoke('cloud-backup:connect', {
      endpoint: 'https://dav.example.test/root/', username: 'writer', secret: 'top-secret',
    })

    expect(f.order).toEqual(['check', 'save'])
    expect(result).toEqual({
      success: true,
      state: 'connected',
      account: { accountId: ACCOUNT, endpoint: 'https://dav.example.test/root/', username: 'writer', persistence: 'session-only' },
      warning: 'CLOUD_CREDENTIAL_SESSION_ONLY',
    })
    expect(JSON.stringify(result)).not.toContain('top-secret')
  })

  it('does not persist a credential when the controlled connection check fails', async () => {
    const f = fixture()
    vi.mocked(f.deps.webDav.checkConnection).mockRejectedValue(new WebDavBackupError('WEBDAV_AUTH'))

    const result = await f.invoke('cloud-backup:connect', {
      endpoint: 'https://dav.example.test/root/', username: 'writer', secret: 'top-secret',
    })

    expect(result).toEqual({ success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_AUTH_FAILED' })
    expect(f.deps.credentialStore.save).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('top-secret')
  })

  it('revalidates the current project for view and explicit binding confirmation', async () => {
    const f = fixture()

    await expect(f.invoke('cloud-backup:view', session)).resolves.toMatchObject({
      success: true, state: 'configured', binding: writable,
    })
    await expect(f.invoke('cloud-backup:confirm-binding', {
      projectSession: session,
      localEndpointAccountId: ACCOUNT,
      lastSelectedParentGenerationIds: [PARENT],
      expectedRevision: null,
    })).resolves.toMatchObject({
      success: true,
      state: 'configured',
      binding: { cloudBookId: GENERATED_BOOK, mode: 'writable', revision: 1 },
    })
    expect(f.deps.assertCurrentProjectContext).toHaveBeenCalledTimes(2)
    expect(f.deps.bindingStore.saveWritable).toHaveBeenCalledWith(expect.objectContaining({
      localProjectId: PROJECT,
      cloudBookId: GENERATED_BOOK,
      expectedRevision: null,
    }))
  })

  it('retires the old credential only after a successful account rotation leaves it unreferenced', async () => {
    const f = fixture()
    const rotated = { ...writable, localEndpointAccountId: ROTATED_ACCOUNT, revision: 8 }
    vi.mocked(f.deps.credentialStore.resolveSecret).mockImplementation(accountId => ({
      metadata: { accountId, endpoint: 'https://dav.example.test/root/', username: 'writer', persistence: 'os-backed' },
      secret: 'replacement-secret',
    }))
    vi.mocked(f.deps.bindingStore.saveWritable).mockReturnValue(rotated)
    vi.mocked(f.deps.bindingStore.list).mockReturnValue([rotated])

    await expect(f.invoke('cloud-backup:confirm-binding', {
      projectSession: session, localEndpointAccountId: ROTATED_ACCOUNT,
      cloudBookId: BOOK, lastSelectedParentGenerationIds: [], expectedRevision: writable.revision,
    })).resolves.toMatchObject({ success: true, binding: rotated })
    expect(f.deps.credentialStore.clear).toHaveBeenCalledWith(ACCOUNT)
  })

  it('preserves the old credential while another project still uses it', async () => {
    const f = fixture()
    const rotated = { ...writable, localEndpointAccountId: ROTATED_ACCOUNT, revision: 8 }
    vi.mocked(f.deps.credentialStore.resolveSecret).mockImplementation(accountId => ({
      metadata: { accountId, endpoint: 'https://dav.example.test/root/', username: 'writer', persistence: 'os-backed' },
      secret: 'replacement-secret',
    }))
    vi.mocked(f.deps.bindingStore.saveWritable).mockReturnValue(rotated)
    vi.mocked(f.deps.bindingStore.list).mockReturnValue([rotated, { ...writable, localProjectId: TARGET_PROJECT }])

    await expect(f.invoke('cloud-backup:confirm-binding', {
      projectSession: session, localEndpointAccountId: ROTATED_ACCOUNT,
      cloudBookId: BOOK, lastSelectedParentGenerationIds: [], expectedRevision: writable.revision,
    })).resolves.toMatchObject({ success: true, binding: rotated })
    expect(f.deps.credentialStore.clear).not.toHaveBeenCalled()
  })

  it('shows retained binding history as unconfigured when its secret is unavailable', async () => {
    const f = fixture()
    vi.mocked(f.deps.credentialStore.resolveSecret).mockReturnValue({
      metadata: { accountId: ACCOUNT, endpoint: 'https://dav.example.test/root/', username: 'writer', persistence: 'os-backed' },
      secret: null,
    })

    await expect(f.invoke('cloud-backup:view', session)).resolves.toEqual({
      success: true,
      state: 'unconfigured',
      binding: writable,
      account: { accountId: ACCOUNT, endpoint: 'https://dav.example.test/root/', username: 'writer', persistence: 'os-backed' },
    })
  })

  it('never upgrades an origin-readonly binding through view or backup', async () => {
    const readonly = { ...writable, mode: 'origin-readonly' as const }
    const f = fixture({ bindingStore: {
      get: vi.fn(() => readonly),
      list: vi.fn(() => [readonly]),
      saveWritable: vi.fn(),
      saveOriginReadonly: vi.fn(),
      markAccountUnconfigured: vi.fn(() => 0),
    } })

    await expect(f.invoke('cloud-backup:view', session)).resolves.toMatchObject({ binding: readonly })
    await expect(f.invoke('cloud-backup:backup', {
      operationId: OPERATION, projectSession: session, disclosureConfirmed: true,
    })).resolves.toEqual({
      success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_BINDING_READ_ONLY', operationId: OPERATION,
    })
    expect(f.deps.bindingStore.saveWritable).not.toHaveBeenCalled()
    expect(f.deps.exportPortableProject).not.toHaveBeenCalled()
  })

  it('exports before networking and advances only the captured binding revision and parents', async () => {
    const f = fixture()

    const result = await f.invoke('cloud-backup:backup', {
      operationId: OPERATION, projectSession: session, disclosureConfirmed: true,
    })

    expect(f.order).toEqual(['export', 'append'])
    expect(f.deps.webDav.appendGeneration).toHaveBeenCalledWith(expect.objectContaining({
      cloudBookId: BOOK,
      originProjectId: PROJECT,
      portableSnapshotGeneration: 'snapshot-a',
      parentGenerationIds: [PARENT],
    }))
    expect(f.deps.bindingStore.saveWritable).toHaveBeenCalledWith({
      localProjectId: PROJECT,
      cloudBookId: BOOK,
      localEndpointAccountId: ACCOUNT,
      lastSelectedParentGenerationIds: [GENERATION],
      expectedRevision: 7,
    })
    expect(result).toMatchObject({
      success: true, state: 'backup-complete', operationId: OPERATION,
      backupPoint: 'snapshot-a', bindingSaved: true,
    })
    expect(fs.readdirSync(path.join(f.root, 'cloud-backup-staging'))).toEqual([])
  })

  it('requires disclosure before export and resolves the upload secret only after export', async () => {
    const f = fixture()

    await expect(f.invoke('cloud-backup:backup', {
      operationId: OPERATION, projectSession: session, disclosureConfirmed: false,
    })).resolves.toEqual({
      success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_DISCLOSURE_CONFIRMATION_REQUIRED', operationId: OPERATION,
    })
    vi.mocked(f.deps.credentialStore.resolveSecret).mockReturnValue({
      metadata: { accountId: ACCOUNT, endpoint: 'https://dav.example.test/root/', username: 'writer', persistence: 'os-backed' },
      secret: null,
    })
    await expect(f.invoke('cloud-backup:backup', {
      operationId: OTHER_OPERATION, projectSession: session, disclosureConfirmed: true,
    })).resolves.toEqual({
      success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_CREDENTIAL_UNAVAILABLE', operationId: OTHER_OPERATION,
    })
    expect(f.deps.exportPortableProject).toHaveBeenCalledOnce()
    expect(f.deps.webDav.appendGeneration).not.toHaveBeenCalled()
  })

  it('does not upload with a credential cleared while export is in flight', async () => {
    let finishExport!: () => void
    const exportGate = new Promise<void>(resolve => { finishExport = resolve })
    let current: CloudProjectBinding = writable
    const f = fixture()
    vi.mocked(f.deps.bindingStore.get).mockImplementation(() => current)
    vi.mocked(f.deps.exportPortableProject).mockImplementation(async input => {
      await exportGate
      fs.writeFileSync(input.targetArchivePath, 'archive')
      return {
        originProjectId: PROJECT, snapshotGeneration: 'snapshot-a', targetSha256: 'a'.repeat(64), targetByteSize: 7,
        sourceEvidence: { schemaVersion: 1, schemaFingerprint: 'x', tableCount: 1, fieldCount: 1 },
        entryCount: 1, requiresRuntimeFreezeGuard: true,
      }
    })
    const pending = f.invoke('cloud-backup:backup', {
      operationId: OPERATION, projectSession: session, disclosureConfirmed: true,
    })
    await vi.waitFor(() => expect(f.deps.exportPortableProject).toHaveBeenCalledOnce())
    expect(f.deps.credentialStore.resolveSecret).not.toHaveBeenCalled()
    current = { ...writable, mode: 'unconfigured', revision: 8 }
    vi.mocked(f.deps.credentialStore.resolveSecret).mockReturnValue(null)

    finishExport()
    await expect(pending).resolves.toEqual({
      success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_NOT_CONFIGURED', operationId: OPERATION,
    })
    expect(f.deps.webDav.appendGeneration).not.toHaveBeenCalled()
    expect(f.deps.assertCurrentProjectContext).toHaveBeenCalledTimes(2)
  })

  it('does not upload to an old account or book after a rebind during export', async () => {
    let finishExport!: () => void
    const exportGate = new Promise<void>(resolve => { finishExport = resolve })
    let current: CloudProjectBinding = writable
    const f = fixture()
    vi.mocked(f.deps.bindingStore.get).mockImplementation(() => current)
    vi.mocked(f.deps.exportPortableProject).mockImplementation(async input => {
      await exportGate
      fs.writeFileSync(input.targetArchivePath, 'archive')
      return {
        originProjectId: PROJECT, snapshotGeneration: 'snapshot-a', targetSha256: 'a'.repeat(64), targetByteSize: 7,
        sourceEvidence: { schemaVersion: 1, schemaFingerprint: 'x', tableCount: 1, fieldCount: 1 },
        entryCount: 1, requiresRuntimeFreezeGuard: true,
      }
    })
    const pending = f.invoke('cloud-backup:backup', {
      operationId: OPERATION, projectSession: session, disclosureConfirmed: true,
    })
    await vi.waitFor(() => expect(f.deps.exportPortableProject).toHaveBeenCalledOnce())
    current = {
      ...writable,
      cloudBookId: GENERATED_BOOK,
      localEndpointAccountId: TARGET_PROJECT,
      lastSelectedParentGenerationIds: ['new-parent'],
      revision: 8,
    }

    finishExport()
    await expect(pending).resolves.toEqual({
      success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_BINDING_CONFLICT', operationId: OPERATION,
    })
    expect(f.deps.credentialStore.resolveSecret).not.toHaveBeenCalled()
    expect(f.deps.webDav.appendGeneration).not.toHaveBeenCalled()
  })

  it('keeps a successful remote generation when saving the advanced binding conflicts', async () => {
    const f = fixture()
    vi.mocked(f.deps.bindingStore.saveWritable).mockImplementation(() => { throw new Error('CLOUD_BINDING_REVISION_CONFLICT') })

    await expect(f.invoke('cloud-backup:backup', {
      operationId: OPERATION, projectSession: session, disclosureConfirmed: true,
    })).resolves.toMatchObject({
      success: true,
      state: 'binding-not-saved',
      operationId: OPERATION,
      generation,
      bindingSaved: false,
      binding: null,
    })
    expect(f.deps.webDav.appendGeneration).toHaveBeenCalledOnce()
  })

  it('waits for an in-flight export after cancellation and never starts the network upload', async () => {
    let finishExport!: () => void
    const exportGate = new Promise<void>(resolve => { finishExport = resolve })
    const f = fixture()
    vi.mocked(f.deps.exportPortableProject).mockImplementation(async input => {
      await exportGate
      fs.writeFileSync(input.targetArchivePath, 'archive')
      return {
        originProjectId: PROJECT, snapshotGeneration: 'snapshot-a', targetSha256: 'a'.repeat(64), targetByteSize: 7,
        sourceEvidence: { schemaVersion: 1, schemaFingerprint: 'x', tableCount: 1, fieldCount: 1 },
        entryCount: 1, requiresRuntimeFreezeGuard: true,
      }
    })
    const pending = f.invoke('cloud-backup:backup', {
      operationId: OPERATION, projectSession: session, disclosureConfirmed: true,
    })
    await vi.waitFor(() => expect(f.deps.exportPortableProject).toHaveBeenCalledOnce())

    await expect(f.invoke('cloud-backup:cancel', OPERATION)).resolves.toEqual({ success: true, cancelled: true })
    await expect(f.invoke('cloud-backup:backup', {
      operationId: OPERATION, projectSession: session, disclosureConfirmed: true,
    })).resolves.toEqual({
      success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_OPERATION_CONFLICT', operationId: OPERATION,
    })
    finishExport()
    await expect(pending).resolves.toEqual({
      success: false, state: 'cancelled', errorCode: 'CLOUD_BACKUP_CANCELLED', operationId: OPERATION,
    })
    expect(f.deps.webDav.appendGeneration).not.toHaveBeenCalled()
  })

  it('lists every explicit book generation with resolved main-process credentials', async () => {
    const f = fixture()

    await expect(f.invoke('cloud-backup:list', {
      localEndpointAccountId: ACCOUNT, cloudBookId: BOOK,
    })).resolves.toEqual({ success: true, state: 'listed', generations: [generation] })
    expect(f.deps.webDav.listGenerations).toHaveBeenCalledWith({
      account: { endpoint: 'https://dav.example.test/root/', username: 'writer', secret: 'top-secret' },
      cloudBookId: BOOK,
    })
  })

  it('restores a copy without switching sessions and reports independent binding and recent-list failures', async () => {
    const f = fixture()
    vi.mocked(f.deps.bindingStore.saveOriginReadonly).mockImplementation(() => { throw new Error('CLOUD_BINDING_REVISION_CONFLICT') })

    const result = await f.invoke('cloud-backup:restore-copy', {
      operationId: OTHER_OPERATION,
      localEndpointAccountId: ACCOUNT,
      cloudBookId: BOOK,
      generationId: GENERATION,
      targetProjectRoot: 'C:\\books\\restored',
    })

    expect(f.order).toEqual(['download', 'restore'])
    expect(f.deps.restorePortableProject).toHaveBeenCalledWith(expect.objectContaining({
      targetProjectRoot: 'C:\\books\\restored', signal: expect.any(AbortSignal),
    }))
    expect(f.deps.bindingStore.saveOriginReadonly).toHaveBeenCalledWith({
      localProjectId: TARGET_PROJECT,
      cloudBookId: BOOK,
      localEndpointAccountId: ACCOUNT,
      lastSelectedParentGenerationIds: [GENERATION],
    })
    expect(f.deps.readRestoredProjectName).toHaveBeenCalledWith('C:\\books\\restored')
    expect(f.deps.registerRecentProject).toHaveBeenCalledWith({
      name: '恢复后的真实书名', path: 'C:\\books\\restored', updatedAt: '2026-09-21T01:00:00.000Z',
    })
    expect(result).toMatchObject({
      success: true, state: 'binding-not-saved', bindingSaved: false, binding: null, recentProjectUpdated: true,
      receipt: { targetProjectId: TARGET_PROJECT },
    })
    expect(f.deps.assertCurrentProjectContext).not.toHaveBeenCalled()

    vi.mocked(f.deps.bindingStore.saveOriginReadonly).mockReturnValue({
      ...writable, localProjectId: TARGET_PROJECT, mode: 'origin-readonly', revision: 1,
      lastSelectedParentGenerationIds: [GENERATION],
    })
    vi.mocked(f.deps.registerRecentProject).mockImplementation(() => { throw new Error('recent list locked') })
    await expect(f.invoke('cloud-backup:restore-copy', {
      operationId: OPERATION,
      localEndpointAccountId: ACCOUNT,
      cloudBookId: BOOK,
      generationId: GENERATION,
      targetProjectRoot: 'C:\\books\\restored-2',
    })).resolves.toMatchObject({
      success: true, state: 'restore-complete', bindingSaved: true, recentProjectUpdated: false,
    })
  })

  it('does not create an origin binding when the credential is cleared during download', async () => {
    let finishDownload!: () => void
    const downloadGate = new Promise<void>(resolve => { finishDownload = resolve })
    const f = fixture()
    vi.mocked(f.deps.webDav.downloadGeneration).mockImplementation(async input => {
      await downloadGate
      fs.writeFileSync(input.targetArchivePath, 'archive')
      return { generationId: GENERATION, targetArchivePath: input.targetArchivePath, archiveSha256: 'a'.repeat(64), archiveByteSize: 7 }
    })
    const pending = f.invoke('cloud-backup:restore-copy', {
      operationId: OPERATION,
      localEndpointAccountId: ACCOUNT,
      cloudBookId: BOOK,
      generationId: GENERATION,
      targetProjectRoot: 'C:\\books\\restored-after-clear',
    })
    await vi.waitFor(() => expect(f.deps.webDav.downloadGeneration).toHaveBeenCalledOnce())
    vi.mocked(f.deps.credentialStore.resolveSecret).mockReturnValue(null)

    finishDownload()
    await expect(pending).resolves.toMatchObject({
      success: true,
      state: 'binding-not-saved',
      bindingSaved: false,
      binding: null,
      recentProjectUpdated: true,
      receipt: { targetProjectId: TARGET_PROJECT },
    })
    expect(f.deps.restorePortableProject).toHaveBeenCalledOnce()
    expect(f.deps.bindingStore.saveOriginReadonly).not.toHaveBeenCalled()
    expect(f.deps.credentialStore.resolveSecret).toHaveBeenCalledTimes(2)
  })

  it('marks every account binding unconfigured before clearing its secret', async () => {
    const f = fixture()
    vi.mocked(f.deps.bindingStore.markAccountUnconfigured).mockImplementation(() => {
      f.order.push('unbind')
      throw new Error('disk locked')
    })
    vi.mocked(f.deps.credentialStore.clear).mockImplementation(() => { f.order.push('clear'); return true })

    await expect(f.invoke('cloud-backup:clear-credential', ACCOUNT)).resolves.toEqual({
      success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_LOCAL_STATE_NOT_SAVED',
    })
    expect(f.order).toEqual(['unbind'])
    expect(f.deps.credentialStore.clear).not.toHaveBeenCalled()

    vi.mocked(f.deps.bindingStore.markAccountUnconfigured).mockImplementation(() => { f.order.push('unbind'); return 2 })
    await expect(f.invoke('cloud-backup:clear-credential', ACCOUNT)).resolves.toEqual({
      success: true, state: 'unconfigured', affectedBindings: 2,
    })
    expect(f.order.slice(-2)).toEqual(['unbind', 'clear'])
  })

  it('rejects malformed or unknown cancellation identifiers without creating operation state', async () => {
    const f = fixture()

    await expect(f.invoke('cloud-backup:cancel', 'not-a-uuid')).resolves.toEqual({
      success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_INPUT_INVALID',
    })
    await expect(f.invoke('cloud-backup:cancel', OPERATION)).resolves.toEqual({
      success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_OPERATION_NOT_FOUND',
    })
  })

  it('returns fixed failure codes without leaking secrets or raw server errors', async () => {
    const f = fixture()
    vi.mocked(f.deps.webDav.listGenerations).mockRejectedValue(new Error('server echoed top-secret at https://private.example'))

    const result = await f.invoke('cloud-backup:list', {
      localEndpointAccountId: ACCOUNT, cloudBookId: BOOK,
    })

    expect(result).toEqual({ success: false, state: 'failed', errorCode: 'CLOUD_BACKUP_FAILED' })
    expect(JSON.stringify(result)).not.toMatch(/top-secret|private\.example/u)
  })
})
