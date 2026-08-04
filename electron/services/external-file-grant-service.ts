import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  captureSecureRootIdentity,
  normalizeSecureRelativePath,
  type SecureFileCapability,
  type SecureRootIdentity,
} from '../security/windows-safe-file-system'

/**
 * 短期外部文件授权由主进程签发并保存在内存中。渲染进程只能携带授权标识，
 * 不能借此传入任意绝对路径。
 */
export type ExternalFileGrantOperation = 'read' | 'list' | 'write' | 'create' | 'show'

export interface ExternalFileGrantRequest {
  grantId: string
  webContentsId: number
  operation: ExternalFileGrantOperation
  relativePath?: string
}

export interface ExternalFileGrantServiceOptions {
  now?: () => number
  newGrantId?: () => string
}

export interface DirectoryExternalFileGrantOptions {
  webContentsId: number
  directoryPath: string
  operations: readonly ExternalFileGrantOperation[]
  ttlMs: number
  maxUses?: number
}

export interface FileExternalFileGrantOptions {
  webContentsId: number
  filePath: string
  operations: readonly ExternalFileGrantOperation[]
  ttlMs: number
  maxUses?: number
}

export interface IssuedExternalFileGrant {
  grantId: string
  expiresAt: number
}

/**
 * This is an opaque main-process capability, not a path approved for Node fs.
 * Controllers must hand it to windowsSafeFileSystem, which opens it from the
 * root handle without following reparse points.
 */
export interface ResolvedExternalFileGrant extends SecureFileCapability {
  scope: 'file' | 'directory'
}

interface ExternalFileGrantRecord {
  webContentsId: number
  scope: 'file' | 'directory'
  rootPath: string
  rootIdentity: SecureRootIdentity
  fixedRelativePath: string | null
  operations: ReadonlySet<ExternalFileGrantOperation>
  expiresAt: number
  usesRemaining: number
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath)
  ) {
    throw new Error('外部文件授权的相对路径不能是绝对路径')
  }
  if (relativePath.includes('\0')) {
    throw new Error('外部文件授权的相对路径无效')
  }
  if (relativePath.split(/[\\/]+/).some(segment => segment === '..')) {
    throw new Error('外部文件授权的相对路径不得包含父目录遍历')
  }
}

function normalizedRelativePath(relativePath: string): string {
  assertSafeRelativePath(relativePath)
  try {
    return normalizeSecureRelativePath(relativePath)
  } catch {
    throw new Error('外部文件授权的相对路径无效')
  }
}

export class ExternalFileGrantService {
  private readonly now: () => number
  private readonly newGrantId: () => string
  private readonly grants = new Map<string, ExternalFileGrantRecord>()

  constructor(options: ExternalFileGrantServiceOptions = {}) {
    this.now = options.now ?? Date.now
    this.newGrantId = options.newGrantId ?? randomUUID
  }

  issueDirectory(options: DirectoryExternalFileGrantOptions): IssuedExternalFileGrant {
    const targetPath = fs.realpathSync.native(options.directoryPath)
    if (!fs.statSync(targetPath).isDirectory()) {
      throw new Error('外部文件授权目录必须是已存在的目录')
    }
    return this.issue({
      webContentsId: options.webContentsId,
      scope: 'directory',
      rootPath: targetPath,
      rootIdentity: captureSecureRootIdentity(targetPath),
      fixedRelativePath: null,
      operations: options.operations,
      ttlMs: options.ttlMs,
      maxUses: options.maxUses,
    })
  }

  issueFile(options: FileExternalFileGrantOptions): IssuedExternalFileGrant {
    const targetPath = fs.realpathSync.native(options.filePath)
    if (!fs.statSync(targetPath).isFile()) {
      throw new Error('外部文件授权目标必须是已存在的文件')
    }
    const rootPath = path.dirname(targetPath)
    return this.issue({
      webContentsId: options.webContentsId,
      scope: 'file',
      rootPath,
      rootIdentity: captureSecureRootIdentity(rootPath),
      fixedRelativePath: path.basename(targetPath),
      operations: options.operations,
      ttlMs: options.ttlMs,
      maxUses: options.maxUses,
    })
  }

  revoke(grantId: string): void {
    this.grants.delete(grantId)
  }

  revokeWebContents(webContentsId: number): void {
    for (const [grantId, grant] of this.grants) {
      if (grant.webContentsId === webContentsId) {
        this.grants.delete(grantId)
      }
    }
  }

  private issue(options: {
    webContentsId: number
    scope: 'file' | 'directory'
    rootPath: string
    rootIdentity: SecureRootIdentity
    fixedRelativePath: string | null
    operations: readonly ExternalFileGrantOperation[]
    ttlMs: number
    maxUses?: number
  }): IssuedExternalFileGrant {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('外部文件授权有效期必须为正数')
    }
    const maxUses = options.maxUses ?? 1
    if (!Number.isSafeInteger(maxUses) || maxUses <= 0) {
      throw new Error('外部文件授权使用次数必须是正整数')
    }

    const grantId = this.newGrantId()
    const expiresAt = this.now() + options.ttlMs
    this.grants.set(grantId, {
      webContentsId: options.webContentsId,
      scope: options.scope,
      rootPath: options.rootPath,
      rootIdentity: options.rootIdentity,
      fixedRelativePath: options.fixedRelativePath,
      operations: new Set(options.operations),
      expiresAt,
      usesRemaining: maxUses,
    })
    return { grantId, expiresAt }
  }

  resolve(request: ExternalFileGrantRequest): ResolvedExternalFileGrant {
    return this.resolveRequest(request, true)
  }

  /**
   * 仅供主进程在同一次已授权业务操作的临界点复核边界；不会新增一次使用。
   * 渲染进程从未得到该服务实例，不能借此绕过有限次数约束。
   */
  revalidate(request: ExternalFileGrantRequest): ResolvedExternalFileGrant {
    return this.resolveRequest(request, false)
  }

  private resolveRequest(
    request: ExternalFileGrantRequest,
    consumeUse: boolean,
  ): ResolvedExternalFileGrant {
    const grant = this.grants.get(request.grantId)
    if (!grant) {
      throw new Error('外部文件授权不存在或已失效')
    }
    if (this.now() >= grant.expiresAt) {
      this.grants.delete(request.grantId)
      throw new Error('外部文件授权已过期')
    }
    if (consumeUse && grant.usesRemaining <= 0) {
      throw new Error('外部文件授权已用尽')
    }
    if (grant.webContentsId !== request.webContentsId) {
      throw new Error('外部文件授权不属于当前窗口')
    }
    if (!grant.operations.has(request.operation)) {
      throw new Error(`外部文件授权未授予 ${request.operation} 操作`)
    }

    const requestedRelativePath = request.relativePath ?? ''
    let relativePath: string
    if (grant.scope === 'file') {
      if (requestedRelativePath !== '' && requestedRelativePath !== '.') {
        throw new Error('精确文件授权不接受子路径')
      }
      if (!grant.fixedRelativePath) {
        throw new Error('外部文件授权目标无效')
      }
      relativePath = grant.fixedRelativePath
    } else {
      relativePath = normalizedRelativePath(requestedRelativePath)
    }
    if (consumeUse) {
      grant.usesRemaining -= 1
    }
    return {
      rootPath: grant.rootPath,
      relativePath,
      rootIdentity: grant.rootIdentity,
      scope: grant.scope,
    }
  }
}

/** 主进程进程内唯一授权登记处；授权绝不落盘。 */
export const externalFileGrants = new ExternalFileGrantService()
