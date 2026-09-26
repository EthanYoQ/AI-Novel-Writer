import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { ipcMain, safeStorage } from 'electron'

import type {
  CloudBackupAccountView,
  CloudBackupErrorCode,
  CloudBackupFailure,
  CloudBackupProjectSessionContext,
} from '../../src/shared/cloud-backup'
import { CANONICAL_PROJECT_DATABASE, CANONICAL_PROJECT_DIRECTORY } from '../../src/shared/project-format'
import { getCurrentProjectPath } from '../database'
import {
  CloudCredentialStore,
  type CloudCredentialMetadata,
  type CloudCredentialSaveInput,
  type CloudCredentialSaveResult,
  type ResolvedCloudCredential,
} from '../services/cloud-credential-store'
import {
  CloudProjectBindingStore,
  type CloudProjectBinding,
  type SaveCloudProjectBindingInput,
  type SaveWritableCloudProjectBindingInput,
} from '../services/cloud-project-binding-store'
import { getGlobalDataRoot } from '../services/app-data-locator'
import { projectAccess } from '../services/project-access'
import {
  exportPortableProject,
  type ExportPortableProjectInput,
  type ExportPortableProjectReceipt,
  type PortableAssetProvider,
} from '../services/project-archive-service'
import { createPortableProjectAssetProvider } from '../services/portable-project-assets'
import {
  restorePortableProject,
  type RestorePortableProjectInput,
  type RestorePortableProjectReceipt,
} from '../services/project-restore-service'
import {
  WebDavBackupError,
  WebDavBackupService,
  type AppendWebDavGenerationInput,
  type DownloadWebDavGenerationInput,
  type ListWebDavGenerationsInput,
  type WebDavAccount,
  type WebDavGeneration,
} from '../services/webdav-backup-service'
import { registerRecentProject, type RecentProject } from './project-controller'

const require = createRequire(import.meta.url)
const BetterSqlite = require('better-sqlite3') as typeof import('better-sqlite3')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const STAGING_DIRECTORY = 'cloud-backup-staging'

interface CloudBackupIpcRegistrar {
  handle(channel: string, handler: (_event: unknown, argument: unknown) => unknown): void
}

interface CredentialStoreFacade {
  list(): CloudCredentialMetadata[]
  save(input: CloudCredentialSaveInput): CloudCredentialSaveResult
  resolveSecret(accountId: string): ResolvedCloudCredential | null
  clear(accountId: string): boolean
}

interface BindingStoreFacade {
  get(localProjectId: string): CloudProjectBinding | null
  list(): CloudProjectBinding[]
  saveWritable(input: SaveWritableCloudProjectBindingInput): CloudProjectBinding
  saveOriginReadonly(input: SaveCloudProjectBindingInput): CloudProjectBinding
  markAccountUnconfigured(localEndpointAccountId: string): number
}

interface WebDavFacade {
  checkConnection(account: WebDavAccount, signal?: AbortSignal): Promise<unknown>
  appendGeneration(input: AppendWebDavGenerationInput): Promise<WebDavGeneration>
  listGenerations(input: ListWebDavGenerationsInput): Promise<WebDavGeneration[]>
  downloadGeneration(input: DownloadWebDavGenerationInput): Promise<unknown>
}

interface ActiveProject {
  projectId: string
  leaseId: string
  rootPath: string
}

export interface CloudBackupControllerDependencies {
  ipc: CloudBackupIpcRegistrar
  credentialStore: CredentialStoreFacade
  bindingStore: BindingStoreFacade
  webDav: WebDavFacade
  exportPortableProject(input: ExportPortableProjectInput): Promise<ExportPortableProjectReceipt>
  restorePortableProject(input: RestorePortableProjectInput): Promise<RestorePortableProjectReceipt>
  portableAssets: PortableAssetProvider
  assertCurrentProjectContext(context: CloudBackupProjectSessionContext | undefined, currentProjectPath: string | null): ActiveProject
  getCurrentProjectPath(): string | null
  sameCanonicalProjectRoot(left: string, right: string): boolean
  getGlobalDataRoot(): string
  readRestoredProjectName(projectRoot: string): string
  registerRecentProject(project: RecentProject): void
  idFactory(): string
  now(): Date
}

class CloudBackupControllerError extends Error {
  constructor(readonly code: CloudBackupErrorCode) {
    super(code)
  }
}

function fail(code: CloudBackupErrorCode): never { throw new CloudBackupControllerError(code) }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CLOUD_BACKUP_INPUT_INVALID')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string' || !value) fail('CLOUD_BACKUP_INPUT_INVALID')
  return value
}

function operationId(value: unknown): string {
  const candidate = string(value)
  if (!UUID.test(candidate)) fail('CLOUD_BACKUP_INPUT_INVALID')
  return candidate
}

function projectSession(value: unknown): CloudBackupProjectSessionContext {
  const source = record(value)
  return {
    projectId: string(source.projectId),
    leaseId: string(source.leaseId),
    projectPath: string(source.projectPath),
  }
}

function webDavFailure(code: WebDavBackupError['code']): CloudBackupErrorCode {
  if (code === 'WEBDAV_AUTH') return 'CLOUD_BACKUP_AUTH_FAILED'
  if (code === 'WEBDAV_CANCELLED') return 'CLOUD_BACKUP_CANCELLED'
  if (code === 'WEBDAV_NETWORK') return 'CLOUD_BACKUP_NETWORK_FAILED'
  if (['WEBDAV_NOT_FOUND', 'WEBDAV_REMOTE_CONFLICT', 'WEBDAV_REMOTE_INVALID',
    'WEBDAV_DAV_RESPONSE_INVALID', 'WEBDAV_RESPONSE_TOO_LARGE'].includes(code)) return 'CLOUD_BACKUP_REMOTE_INVALID'
  return 'CLOUD_BACKUP_FAILED'
}

function errorCode(error: unknown): CloudBackupErrorCode {
  if (error instanceof CloudBackupControllerError) return error.code
  if (error instanceof WebDavBackupError) return webDavFailure(error.code)
  const message = error instanceof Error ? error.message : ''
  if (message === 'CLOUD_BINDING_REVISION_CONFLICT') return 'CLOUD_BACKUP_BINDING_CONFLICT'
  if (message === 'PORTABLE_RESTORE_CANCELLED') return 'CLOUD_BACKUP_CANCELLED'
  return 'CLOUD_BACKUP_FAILED'
}

function failure(error: unknown, currentOperationId?: string): CloudBackupFailure {
  const code = errorCode(error)
  return {
    success: false,
    state: code === 'CLOUD_BACKUP_CANCELLED' ? 'cancelled' : 'failed',
    errorCode: code,
    ...(currentOperationId ? { operationId: currentOperationId } : {}),
  }
}

function account(store: CredentialStoreFacade, accountId: string): WebDavAccount {
  const resolved = store.resolveSecret(accountId)
  if (!resolved?.secret || resolved.metadata.accountId !== accountId
    || !resolved.metadata.endpoint || !resolved.metadata.username) fail('CLOUD_BACKUP_CREDENTIAL_UNAVAILABLE')
  return { endpoint: resolved.metadata.endpoint, username: resolved.metadata.username, secret: resolved.secret }
}

function createStagingRoot(dataRoot: string, currentOperationId: string): string {
  const parent = path.join(path.resolve(dataRoot), STAGING_DIRECTORY)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const parentInfo = fs.lstatSync(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail('CLOUD_BACKUP_LOCAL_STATE_NOT_SAVED')
  const root = fs.mkdtempSync(path.join(parent, `${currentOperationId}-`))
  try { fs.chmodSync(root, 0o700) } catch { /* Windows may not expose POSIX modes. */ }
  return root
}

function removeStagingRoot(dataRoot: string, currentOperationId: string, stagingRoot: string): void {
  const parent = path.join(path.resolve(dataRoot), STAGING_DIRECTORY)
  const relative = path.relative(parent, stagingRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !path.basename(stagingRoot).startsWith(`${currentOperationId}-`)) return
  fs.rmSync(stagingRoot, { recursive: true, force: true })
}

function readRestoredProjectName(projectRoot: string): string {
  const database = new BetterSqlite(
    path.join(projectRoot, CANONICAL_PROJECT_DIRECTORY, CANONICAL_PROJECT_DATABASE),
    { readonly: true, fileMustExist: true },
  )
  try {
    const row = database.prepare("SELECT project_name FROM project_core WHERE id = 'main'").get() as {
      project_name?: unknown
    } | undefined
    const name = typeof row?.project_name === 'string' ? row.project_name.trim() : ''
    if (!name) throw new Error('RESTORED_PROJECT_NAME_INVALID')
    return name
  } finally {
    database.close()
  }
}

function productionDependencies(): CloudBackupControllerDependencies {
  return {
    ipc: {
      handle(channel, handler) {
        ipcMain.handle(channel, (event, argument) => handler(event, argument))
      },
    },
    credentialStore: new CloudCredentialStore({ safeStorage }),
    bindingStore: new CloudProjectBindingStore(),
    webDav: new WebDavBackupService(),
    exportPortableProject,
    restorePortableProject,
    portableAssets: createPortableProjectAssetProvider(),
    assertCurrentProjectContext: (context, currentPath) => projectAccess.assertCurrentProjectContext(context, currentPath),
    getCurrentProjectPath,
    sameCanonicalProjectRoot: (left, right) => projectAccess.sameCanonicalProjectRoot(left, right),
    getGlobalDataRoot,
    readRestoredProjectName,
    registerRecentProject,
    idFactory: randomUUID,
    now: () => new Date(),
  }
}

export function registerCloudBackupController(injected?: CloudBackupControllerDependencies): void {
  const deps = injected ?? productionDependencies()
  const operations = new Map<string, AbortController>()

  const runOperation = async <T>(rawId: unknown, operation: (signal: AbortSignal, id: string) => Promise<T>) => {
    let id: string
    try { id = operationId(rawId) } catch (error) { return failure(error) }
    if (operations.has(id)) return failure(new CloudBackupControllerError('CLOUD_BACKUP_OPERATION_CONFLICT'), id)
    const controller = new AbortController()
    operations.set(id, controller)
    try {
      return await operation(controller.signal, id)
    } catch (error) {
      return failure(error, id)
    } finally {
      operations.delete(id)
    }
  }

  deps.ipc.handle('cloud-backup:connect', async (_event, rawRequest) => {
    try {
      const request = record(rawRequest)
      const candidate = {
        accountId: typeof request.accountId === 'string' ? request.accountId : undefined,
        endpoint: string(request.endpoint),
        username: string(request.username),
        secret: string(request.secret),
      }
      await deps.webDav.checkConnection(candidate)
      let saved: CloudCredentialSaveResult
      try { saved = deps.credentialStore.save(candidate) }
      catch { return failure(new CloudBackupControllerError('CLOUD_BACKUP_LOCAL_STATE_NOT_SAVED')) }
      return {
        success: true as const,
        state: 'connected' as const,
        account: saved.metadata satisfies CloudBackupAccountView,
        ...(saved.warning ? { warning: saved.warning } : {}),
      }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('cloud-backup:view', async (_event, rawSession) => {
    try {
      const active = deps.assertCurrentProjectContext(projectSession(rawSession), deps.getCurrentProjectPath())
      const binding = deps.bindingStore.get(active.projectId)
      const resolved = binding ? deps.credentialStore.resolveSecret(binding.localEndpointAccountId) : null
      const metadata = binding
        ? resolved?.metadata.accountId === binding.localEndpointAccountId
          ? resolved.metadata
          : deps.credentialStore.list().find(candidate => candidate.accountId === binding.localEndpointAccountId) ?? null
        : null
      const configured = binding && binding.mode !== 'unconfigured'
        && resolved?.metadata.accountId === binding.localEndpointAccountId && Boolean(resolved.secret)
      return {
        success: true as const,
        state: configured ? 'configured' as const : 'unconfigured' as const,
        binding,
        account: metadata,
      }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('cloud-backup:confirm-binding', async (_event, rawRequest) => {
    try {
      const request = record(rawRequest)
      const active = deps.assertCurrentProjectContext(projectSession(request.projectSession), deps.getCurrentProjectPath())
      const accountId = string(request.localEndpointAccountId)
      account(deps.credentialStore, accountId)
      const parents = Array.isArray(request.lastSelectedParentGenerationIds)
        ? request.lastSelectedParentGenerationIds.map(string)
        : fail('CLOUD_BACKUP_INPUT_INVALID')
      const expectedRevision = request.expectedRevision === null
        ? null
        : typeof request.expectedRevision === 'number' ? request.expectedRevision : fail('CLOUD_BACKUP_INPUT_INVALID')
      const cloudBookId = request.cloudBookId === undefined ? deps.idFactory() : string(request.cloudBookId)
      const previousAccountId = deps.bindingStore.get(active.projectId)?.localEndpointAccountId
      const binding = deps.bindingStore.saveWritable({
        localProjectId: active.projectId,
        cloudBookId,
        localEndpointAccountId: accountId,
        lastSelectedParentGenerationIds: parents,
        expectedRevision,
      })
      let staleCredentialRetained = false
      if (previousAccountId && previousAccountId !== accountId) {
        try {
          if (!deps.bindingStore.list().some(candidate => candidate.localEndpointAccountId === previousAccountId)) {
            deps.credentialStore.clear(previousAccountId)
          }
        }
        catch { staleCredentialRetained = true }
      }
      return { success: true as const, state: 'configured' as const, binding,
        ...(staleCredentialRetained ? { staleCredentialRetained: true as const } : {}) }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('cloud-backup:backup', async (_event, rawRequest) => {
    const request = (() => {
      try { return record(rawRequest) } catch { return null }
    })()
    if (!request) return failure(new CloudBackupControllerError('CLOUD_BACKUP_INPUT_INVALID'))
    return runOperation(request.operationId, async (signal, id) => {
      if (request.disclosureConfirmed !== true) fail('CLOUD_BACKUP_DISCLOSURE_CONFIRMATION_REQUIRED')
      const currentSession = projectSession(request.projectSession)
      const active = deps.assertCurrentProjectContext(currentSession, deps.getCurrentProjectPath())
      const binding = deps.bindingStore.get(active.projectId)
      if (!binding || binding.mode === 'unconfigured') fail('CLOUD_BACKUP_NOT_CONFIGURED')
      if (binding.mode !== 'writable') fail('CLOUD_BACKUP_BINDING_READ_ONLY')
      const captured = {
        revision: binding.revision,
        parents: [...binding.lastSelectedParentGenerationIds],
        cloudBookId: binding.cloudBookId,
        accountId: binding.localEndpointAccountId,
      }
      const dataRoot = deps.getGlobalDataRoot()
      const stagingRoot = createStagingRoot(dataRoot, id)
      const archivePath = path.join(stagingRoot, 'backup.ainovel')
      try {
        let receipt: ExportPortableProjectReceipt
        try {
          receipt = await deps.exportPortableProject({
            sourceProjectRoot: active.rootPath,
            projectSession: currentSession,
            targetArchivePath: archivePath,
            attemptParentPath: stagingRoot,
            assets: deps.portableAssets,
            assertCurrentContext(context, sourceProjectRoot) {
              const checked = deps.assertCurrentProjectContext(context, deps.getCurrentProjectPath())
              return deps.sameCanonicalProjectRoot(checked.rootPath, sourceProjectRoot)
            },
          })
        } catch {
          if (signal.aborted) fail('CLOUD_BACKUP_CANCELLED')
          throw new CloudBackupControllerError('CLOUD_BACKUP_ARCHIVE_FAILED')
        }
        if (signal.aborted) fail('CLOUD_BACKUP_CANCELLED')
        deps.assertCurrentProjectContext(currentSession, deps.getCurrentProjectPath())
        const currentBinding = deps.bindingStore.get(active.projectId)
        if (!currentBinding || currentBinding.mode === 'unconfigured') fail('CLOUD_BACKUP_NOT_CONFIGURED')
        if (currentBinding.mode !== 'writable') fail('CLOUD_BACKUP_BINDING_READ_ONLY')
        if (currentBinding.revision !== captured.revision
          || currentBinding.localEndpointAccountId !== captured.accountId
          || currentBinding.cloudBookId !== captured.cloudBookId
          || currentBinding.lastSelectedParentGenerationIds.length !== captured.parents.length
          || currentBinding.lastSelectedParentGenerationIds.some((parent, index) => parent !== captured.parents[index])) {
          fail('CLOUD_BACKUP_BINDING_CONFLICT')
        }
        const remoteAccount = account(deps.credentialStore, captured.accountId)
        const remoteGeneration = await deps.webDav.appendGeneration({
          account: remoteAccount,
          cloudBookId: captured.cloudBookId,
          archivePath,
          originProjectId: receipt.originProjectId,
          portableSnapshotGeneration: receipt.snapshotGeneration,
          parentGenerationIds: captured.parents,
          signal,
        })
        try {
          const saved = deps.bindingStore.saveWritable({
            localProjectId: active.projectId,
            cloudBookId: captured.cloudBookId,
            localEndpointAccountId: captured.accountId,
            lastSelectedParentGenerationIds: [remoteGeneration.generationId],
            expectedRevision: captured.revision,
          })
          return {
            success: true as const,
            state: 'backup-complete' as const,
            operationId: id,
            generation: remoteGeneration,
            backupPoint: receipt.snapshotGeneration,
            bindingSaved: true,
            binding: saved,
          }
        } catch {
          return {
            success: true as const,
            state: 'binding-not-saved' as const,
            operationId: id,
            generation: remoteGeneration,
            backupPoint: receipt.snapshotGeneration,
            bindingSaved: false,
            binding: null,
          }
        }
      } finally {
        removeStagingRoot(dataRoot, id, stagingRoot)
      }
    })
  })

  deps.ipc.handle('cloud-backup:list', async (_event, rawRequest) => {
    try {
      const request = record(rawRequest)
      const accountId = string(request.localEndpointAccountId)
      const cloudBookId = string(request.cloudBookId)
      const generations = await deps.webDav.listGenerations({
        account: account(deps.credentialStore, accountId),
        cloudBookId,
      })
      return { success: true as const, state: 'listed' as const, generations }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('cloud-backup:restore-copy', async (_event, rawRequest) => {
    const request = (() => {
      try { return record(rawRequest) } catch { return null }
    })()
    if (!request) return failure(new CloudBackupControllerError('CLOUD_BACKUP_INPUT_INVALID'))
    return runOperation(request.operationId, async (signal, id) => {
      const accountId = string(request.localEndpointAccountId)
      const cloudBookId = string(request.cloudBookId)
      const generationId = string(request.generationId)
      const targetProjectRoot = string(request.targetProjectRoot)
      const remoteAccount = account(deps.credentialStore, accountId)
      const dataRoot = deps.getGlobalDataRoot()
      const stagingRoot = createStagingRoot(dataRoot, id)
      const archivePath = path.join(stagingRoot, 'restore.ainovel')
      try {
        await deps.webDav.downloadGeneration({
          account: remoteAccount,
          cloudBookId,
          generationId,
          targetArchivePath: archivePath,
          signal,
        })
        let receipt: RestorePortableProjectReceipt
        try {
          receipt = await deps.restorePortableProject({ archivePath, targetProjectRoot, signal })
        } catch (error) {
          if (signal.aborted || error instanceof Error && error.message === 'PORTABLE_RESTORE_CANCELLED') {
            fail('CLOUD_BACKUP_CANCELLED')
          }
          throw new CloudBackupControllerError('CLOUD_BACKUP_RESTORE_FAILED')
        }
        let binding: CloudProjectBinding | null = null
        let bindingSaved = false
        try {
          account(deps.credentialStore, accountId)
          binding = deps.bindingStore.saveOriginReadonly({
            localProjectId: receipt.targetProjectId,
            cloudBookId,
            localEndpointAccountId: accountId,
            lastSelectedParentGenerationIds: [generationId],
          })
          bindingSaved = true
        } catch { /* Restored data remains authoritative even if navigation metadata cannot be saved. */ }
        let recentProjectUpdated = false
        try {
          deps.registerRecentProject({
            name: deps.readRestoredProjectName(receipt.targetProjectRoot),
            path: receipt.targetProjectRoot,
            updatedAt: deps.now().toISOString(),
          })
          recentProjectUpdated = true
        } catch { /* The restored project remains on disk and can be opened explicitly. */ }
        return {
          success: true as const,
          state: bindingSaved ? 'restore-complete' as const : 'binding-not-saved' as const,
          operationId: id,
          receipt,
          bindingSaved,
          binding,
          recentProjectUpdated,
        }
      } finally {
        removeStagingRoot(dataRoot, id, stagingRoot)
      }
    })
  })

  deps.ipc.handle('cloud-backup:cancel', async (_event, rawId) => {
    try {
      const id = operationId(rawId)
      const operation = operations.get(id)
      if (!operation) fail('CLOUD_BACKUP_OPERATION_NOT_FOUND')
      operation.abort()
      return { success: true as const, cancelled: true }
    } catch (error) {
      return failure(error)
    }
  })

  deps.ipc.handle('cloud-backup:clear-credential', async (_event, rawAccountId) => {
    try {
      const accountId = string(rawAccountId)
      let affectedBindings: number
      try { affectedBindings = deps.bindingStore.markAccountUnconfigured(accountId) }
      catch { return failure(new CloudBackupControllerError('CLOUD_BACKUP_LOCAL_STATE_NOT_SAVED')) }
      try { deps.credentialStore.clear(accountId) }
      catch { return failure(new CloudBackupControllerError('CLOUD_BACKUP_LOCAL_STATE_NOT_SAVED')) }
      return { success: true as const, state: 'unconfigured' as const, affectedBindings }
    } catch (error) {
      return failure(error)
    }
  })
}
