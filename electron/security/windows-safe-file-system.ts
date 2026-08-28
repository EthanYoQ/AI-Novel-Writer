import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import * as electron from 'electron'

/**
 * Windows exposes these as the volume serial number and 64-bit file index of
 * the root directory handle. The values are captured when authority is issued,
 * never re-sampled when the helper performs I/O.
 */
export interface SecureRootIdentity {
  readonly volumeSerialNumber: string
  readonly fileIndex: string
}

/**
 * A path capability is intentionally root-relative. Callers must never turn it
 * back into a host path for I/O: the platform helper opens every component from
 * a root directory handle without following symlinks or reparse points.
 */
export interface SecureFileCapability {
  rootPath: string
  relativePath: string
  rootIdentity: SecureRootIdentity
}

export interface SecureDirectoryEntry {
  name: string
  isDirectory: boolean
}

export interface AtomicWriteConstraints {
  /**
   * Require an existing target through commit. The platform helper must fail
   * closed when it cannot preserve that invariant.
   */
  mustAlreadyExist?: boolean
}

export interface SecureFileSystem {
  readText(capability: SecureFileCapability, maxBytes?: number): Promise<string>
  writeTextAtomically(
    capability: SecureFileCapability,
    content: string,
    beforeReplace?: () => void | Promise<void>,
    constraints?: AtomicWriteConstraints,
  ): Promise<void>
  mkdir(capability: SecureFileCapability): Promise<void>
  exists(capability: SecureFileCapability): Promise<boolean>
  listDirectory(capability: SecureFileCapability): Promise<SecureDirectoryEntry[]>
}

/**
 * Historical compatibility name. New production code should use
 * `SecureFileSystem`, which is implemented by both Windows and Darwin helpers.
 */
export type WindowsSafeFileSystem = SecureFileSystem

type HelperOperation = 'read' | 'write' | 'mkdir' | 'exists' | 'list'

interface HelperRequest {
  operation: HelperOperation
  rootPath: string
  relativePath: string
  rootIdentity: SecureRootIdentity
  contentBase64?: string
  mustAlreadyExist?: boolean
  maxBytes?: number
}

interface HelperResponse {
  ok: boolean
  code?: string
  phase?: string
  contentBase64?: string
  exists?: boolean
  entries?: unknown
}

export interface WindowsSafeFileSystemOptions {
  /** Test seam. Production always launches the bundled helper. */
  invoke?: (request: HelperRequest) => Promise<HelperResponse>
  helperPath?: string
  timeoutMs?: number
  platform?: NodeJS.Platform
  isPackaged?: boolean
  resourcesPath?: string
  cwd?: string
}

const MAX_PATH_CHARACTERS = 32_000
const MAX_SEGMENTS = 256
const MAX_TEXT_BYTES = 64 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 16_384
const MAX_HELPER_RESPONSE_BYTES = Math.ceil(MAX_TEXT_BYTES * 1.4) + (2 * 1024 * 1024)
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_UINT32 = BigInt('4294967295')
const MAX_UINT64 = BigInt('18446744073709551615')

const windowsReservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const unsignedDecimal = /^(?:0|[1-9]\d*)$/

function secureError(code: string): Error {
  return new Error(code)
}

function normalizeReadByteLimit(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return MAX_TEXT_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw secureError('SECURE_FS_INVALID_OPERATION')
  }
  return Math.min(maxBytes, MAX_TEXT_BYTES)
}

function validatedUnsignedDecimal(value: unknown, maximum: bigint): string | null {
  if (typeof value !== 'string' || !unsignedDecimal.test(value)) return null
  try {
    return BigInt(value) <= maximum ? value : null
  } catch {
    return null
  }
}

function validateRootIdentity(identity: unknown): SecureRootIdentity {
  if (!identity || typeof identity !== 'object') {
    throw secureError('SECURE_FS_INVALID_PATH')
  }
  const volumeSerialNumber = validatedUnsignedDecimal(
    (identity as SecureRootIdentity).volumeSerialNumber,
    MAX_UINT32,
  )
  const fileIndex = validatedUnsignedDecimal((identity as SecureRootIdentity).fileIndex, MAX_UINT64)
  if (!volumeSerialNumber || !fileIndex) throw secureError('SECURE_FS_INVALID_PATH')
  return Object.freeze({ volumeSerialNumber, fileIndex })
}

/**
 * Snapshot the resolved root directory's Windows identity at the authorization
 * boundary. A later junction substitution can resolve the same rootPath to a
 * different directory, but cannot forge this handle identity.
 */
export function captureSecureRootIdentity(rootPath: string): SecureRootIdentity {
  try {
    const canonicalRoot = realpathSync.native(rootPath)
    const information = statSync(canonicalRoot, { bigint: true })
    if (!information.isDirectory() || information.dev < 0n || information.ino < 0n
      || information.dev > MAX_UINT32 || information.ino > MAX_UINT64) {
      throw secureError('SECURE_FS_INVALID_PATH')
    }
    return Object.freeze({
      volumeSerialNumber: information.dev.toString(),
      fileIndex: information.ino.toString(),
    })
  } catch (error) {
    if (error instanceof Error && /^SECURE_FS_[A-Z0-9_]+$/.test(error.message)) throw error
    throw secureError('SECURE_FS_NOT_FOUND')
  }
}

function assertSafeSegment(segment: string): void {
  if (
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.includes('\0')
    || segment.includes(':')
    || segment.endsWith('.')
    || segment.endsWith(' ')
    || windowsReservedNames.test(segment)
  ) {
    throw secureError('SECURE_FS_INVALID_PATH')
  }
}

/**
 * Keeps the lexical component of the capability deliberately boring. The
 * helper repeats this validation because its JSON input is a security boundary.
 */
export function normalizeSecureRelativePath(relativePath: string): string {
  if (
    typeof relativePath !== 'string'
    || relativePath.includes('\0')
    || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath)
  ) {
    throw secureError('SECURE_FS_INVALID_PATH')
  }

  const segments = relativePath.split(/[\\/]+/).filter(segment => segment !== '' && segment !== '.')
  if (segments.length > MAX_SEGMENTS) throw secureError('SECURE_FS_INVALID_PATH')
  for (const segment of segments) assertSafeSegment(segment)
  return segments.join('\\')
}

export function createSecureFileCapability(
  rootPath: string,
  requestedPath: string,
): SecureFileCapability {
  if (
    typeof rootPath !== 'string'
    || typeof requestedPath !== 'string'
    || rootPath.length === 0
    || rootPath.length > MAX_PATH_CHARACTERS
    || requestedPath.length > MAX_PATH_CHARACTERS
  ) {
    throw secureError('SECURE_FS_INVALID_PATH')
  }
  const root = path.resolve(rootPath)
  const target = path.resolve(requestedPath)
  const relativePath = path.relative(root, target)
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw secureError('SECURE_FS_INVALID_PATH')
  }
  return Object.freeze({
    rootPath: root,
    relativePath: normalizeSecureRelativePath(relativePath),
    rootIdentity: captureSecureRootIdentity(root),
  })
}

function validateCapability(capability: SecureFileCapability): SecureFileCapability {
  if (
    !capability
    || typeof capability.rootPath !== 'string'
    || capability.rootPath.length === 0
    || capability.rootPath.length > MAX_PATH_CHARACTERS
    || capability.rootPath.includes('\0')
    || !path.isAbsolute(capability.rootPath)
  ) {
    throw secureError('SECURE_FS_INVALID_PATH')
  }
  return {
    rootPath: path.resolve(capability.rootPath),
    relativePath: normalizeSecureRelativePath(capability.relativePath),
    rootIdentity: validateRootIdentity(capability.rootIdentity),
  }
}

type SecureFileSystemPlatform = Extract<NodeJS.Platform, 'win32' | 'darwin'>

function helperFileName(platform: SecureFileSystemPlatform): string {
  return platform === 'win32'
    ? 'windows-safe-file-system.ps1'
    : 'darwin-safe-file-system'
}

function defaultHelperPath(options: {
  platform: SecureFileSystemPlatform
  isPackaged: boolean
  resourcesPath: string | undefined
  cwd: string
}): string {
  const packagedPath = typeof options.resourcesPath === 'string'
    ? path.join(options.resourcesPath, 'security', helperFileName(options.platform))
    : null
  if (packagedPath && existsSync(packagedPath)) return packagedPath
  if (options.isPackaged) throw secureError('SECURE_FS_HELPER_UNAVAILABLE')

  // Development and tests may execute directly from the source tree.
  const sourcePath = path.resolve(options.cwd, 'electron', 'security', helperFileName(options.platform))
  if (existsSync(sourcePath)) return sourcePath
  throw secureError('SECURE_FS_HELPER_UNAVAILABLE')
}

function electronAppIsPackaged(): boolean {
  // Vitest/Node do not expose Electron's main-process `app` export. The
  // production Electron namespace does, and app.isPackaged is authoritative.
  try {
    return electron.app.isPackaged === true
  } catch {
    return false
  }
}

function parseResponse(raw: string): HelperResponse {
  if (raw.length === 0 || raw.length > MAX_HELPER_RESPONSE_BYTES) {
    throw secureError('SECURE_FS_HELPER_INVALID_RESPONSE')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw secureError('SECURE_FS_HELPER_INVALID_RESPONSE')
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as HelperResponse).ok !== 'boolean') {
    throw secureError('SECURE_FS_HELPER_INVALID_RESPONSE')
  }
  return parsed as HelperResponse
}

function spawnPlatformHelper(platform: SecureFileSystemPlatform, helperPath: string) {
  const command = platform === 'win32' ? 'powershell.exe' : helperPath
  const args = platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath]
    : []
  return spawn(command, args, {
    windowsHide: platform === 'win32',
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

async function invokeBundledHelper(
  request: HelperRequest,
  platform: SecureFileSystemPlatform,
  helperPath: string,
  timeoutMs: number,
): Promise<HelperResponse> {
  const input = JSON.stringify(request)
  if (Buffer.byteLength(input, 'utf8') > MAX_HELPER_RESPONSE_BYTES) {
    throw secureError('SECURE_FS_REQUEST_TOO_LARGE')
  }

  return new Promise<HelperResponse>((resolve, reject) => {
    const child = spawnPlatformHelper(platform, helperPath)
    let output = ''
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(() => reject(secureError('SECURE_FS_HELPER_TIMEOUT')))
    }, timeoutMs)

    child.once('error', () => finish(() => reject(secureError('SECURE_FS_HELPER_UNAVAILABLE'))))
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      output += chunk.toString('utf8')
      if (Buffer.byteLength(output, 'utf8') > MAX_HELPER_RESPONSE_BYTES) {
        child.kill()
        finish(() => reject(secureError('SECURE_FS_HELPER_INVALID_RESPONSE')))
      }
    })
    // stderr is intentionally not surfaced: it may contain host paths or
    // provider-specific diagnostics that must not travel back to the renderer.
    child.stderr.resume()
    child.once('close', () => finish(() => {
      try {
        resolve(parseResponse(output.trim()))
      } catch (error) {
        reject(error)
      }
    }))
    child.stdin.end(`${input}\n`, 'utf8')
  })
}

/**
 * The helper keeps the temporary file and both directory handles open while
 * this callback runs. That preserves the project-lease revalidation point
 * immediately before replacement without reopening a path by name.
 */
async function invokeBundledAtomicWrite(
  request: HelperRequest,
  platform: SecureFileSystemPlatform,
  helperPath: string,
  timeoutMs: number,
  beforeReplace: (() => void | Promise<void>) | undefined,
): Promise<HelperResponse> {
  const input = JSON.stringify(request)
  if (Buffer.byteLength(input, 'utf8') > MAX_HELPER_RESPONSE_BYTES) {
    throw secureError('SECURE_FS_REQUEST_TOO_LARGE')
  }

  return new Promise<HelperResponse>((resolve, reject) => {
    const child = spawnPlatformHelper(platform, helperPath)
    let outputBuffer = ''
    let finalResponse: HelperResponse | null = null
    let ready = false
    let settled = false
    let beforeReplaceError: unknown
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback()
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(() => reject(secureError('SECURE_FS_HELPER_TIMEOUT')))
    }, timeoutMs)
    const sendCommand = (command: 'commit' | 'cancel') => {
      if (!child.stdin.destroyed) child.stdin.end(`${JSON.stringify({ command })}\n`, 'utf8')
    }
    const handleLine = (line: string) => {
      if (!line) return
      const response = parseResponse(line)
      if (!ready) {
        if (!response.ok) {
          finalResponse = response
          return
        }
        if (response.phase !== 'ready') throw secureError('SECURE_FS_HELPER_INVALID_RESPONSE')
        ready = true
        void Promise.resolve()
          .then(() => beforeReplace?.())
          .then(() => sendCommand('commit'))
          .catch((error: unknown) => {
            beforeReplaceError = error
            sendCommand('cancel')
          })
        return
      }
      finalResponse = response
    }

    child.once('error', () => finish(() => reject(secureError('SECURE_FS_HELPER_UNAVAILABLE'))))
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      outputBuffer += chunk.toString('utf8')
      if (Buffer.byteLength(outputBuffer, 'utf8') > MAX_HELPER_RESPONSE_BYTES) {
        child.kill()
        finish(() => reject(secureError('SECURE_FS_HELPER_INVALID_RESPONSE')))
        return
      }
      try {
        let newline = outputBuffer.indexOf('\n')
        while (newline >= 0) {
          const line = outputBuffer.slice(0, newline).trim()
          outputBuffer = outputBuffer.slice(newline + 1)
          handleLine(line)
          newline = outputBuffer.indexOf('\n')
        }
      } catch (error) {
        child.kill()
        finish(() => reject(error))
      }
    })
    child.stderr.resume()
    child.once('close', () => finish(() => {
      if (beforeReplaceError !== undefined) {
        reject(beforeReplaceError)
        return
      }
      try {
        if (outputBuffer.trim()) handleLine(outputBuffer.trim())
        if (!finalResponse) throw secureError('SECURE_FS_HELPER_INVALID_RESPONSE')
        resolve(finalResponse)
      } catch (error) {
        reject(error)
      }
    }))
    child.stdin.write(`${input}\n`, 'utf8')
  })
}

function responseError(response: HelperResponse): never {
  const code = typeof response.code === 'string' && /^SECURE_FS_[A-Z0-9_]+$/.test(response.code)
    ? response.code
    : 'SECURE_FS_HELPER_FAILED'
  throw secureError(code)
}

function parseDirectoryEntries(entries: unknown): SecureDirectoryEntry[] {
  if (!Array.isArray(entries) || entries.length > MAX_DIRECTORY_ENTRIES) {
    throw secureError('SECURE_FS_HELPER_INVALID_RESPONSE')
  }
  return entries.map((entry) => {
    if (
      !entry
      || typeof entry !== 'object'
      || typeof (entry as SecureDirectoryEntry).name !== 'string'
      || typeof (entry as SecureDirectoryEntry).isDirectory !== 'boolean'
    ) {
      throw secureError('SECURE_FS_HELPER_INVALID_RESPONSE')
    }
    assertSafeSegment((entry as SecureDirectoryEntry).name)
    return {
      name: (entry as SecureDirectoryEntry).name,
      isDirectory: (entry as SecureDirectoryEntry).isDirectory,
    }
  })
}

export function createSecureFileSystem(
  options: WindowsSafeFileSystemOptions = {},
): WindowsSafeFileSystem {
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const helperPath = options.helperPath
  const isPackaged = options.isPackaged ?? false
  const resourcesPath = options.resourcesPath ?? (
    typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined
  )
  const cwd = options.cwd ?? process.cwd()
  const usingTestInvoke = options.invoke !== undefined
  const securePlatform = (): SecureFileSystemPlatform => {
    if (platform === 'win32' || platform === 'darwin') return platform
    throw secureError('SECURE_FS_UNSUPPORTED_PLATFORM')
  }
  const resolveHelperPath = (): string => {
    const supportedPlatform = securePlatform()
    if (helperPath === undefined) {
      return defaultHelperPath({ platform: supportedPlatform, isPackaged, resourcesPath, cwd })
    }
    if (isPackaged) {
      const packagedPath = resourcesPath
        ? path.join(resourcesPath, 'security', helperFileName(supportedPlatform))
        : null
      if (
        !packagedPath
        || (
          supportedPlatform === 'win32'
            ? path.resolve(helperPath).toLocaleLowerCase('en-US')
              !== path.resolve(packagedPath).toLocaleLowerCase('en-US')
            : path.resolve(helperPath) !== path.resolve(packagedPath)
        )
        || !existsSync(packagedPath)
      ) {
        throw secureError('SECURE_FS_HELPER_UNAVAILABLE')
      }
      return packagedPath
    }
    if (!existsSync(helperPath)) throw secureError('SECURE_FS_HELPER_UNAVAILABLE')
    return helperPath
  }
  const invoke = options.invoke ?? ((request: HelperRequest) => {
    const supportedPlatform = securePlatform()
    return invokeBundledHelper(request, supportedPlatform, resolveHelperPath(), timeoutMs)
  })

  const run = async (
    operation: HelperOperation,
    capability: SecureFileCapability,
    contentBase64?: string,
    maxBytes?: number,
  ): Promise<HelperResponse> => {
    const safeCapability = validateCapability(capability)
    const response = await invoke({
      operation,
      rootPath: safeCapability.rootPath,
      relativePath: safeCapability.relativePath,
      rootIdentity: safeCapability.rootIdentity,
      ...(contentBase64 === undefined ? {} : { contentBase64 }),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    })
    if (!response.ok) responseError(response)
    return response
  }

  return {
    async readText(capability, maxBytes) {
      const readByteLimit = normalizeReadByteLimit(maxBytes)
      const response = await run('read', capability, undefined, readByteLimit)
      if (typeof response.contentBase64 !== 'string') {
        throw secureError('SECURE_FS_HELPER_INVALID_RESPONSE')
      }
      const maximumEncodedLength = Math.ceil(readByteLimit / 3) * 4
      if (response.contentBase64.length > maximumEncodedLength) {
        throw secureError('SECURE_FS_FILE_TOO_LARGE')
      }
      const buffer = Buffer.from(response.contentBase64, 'base64')
      if (buffer.length > readByteLimit) throw secureError('SECURE_FS_FILE_TOO_LARGE')
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        throw secureError('SECURE_FS_INVALID_TEXT')
      }
    },

    async writeTextAtomically(capability, content, beforeReplace, constraints) {
      if (typeof content !== 'string') throw secureError('SECURE_FS_INVALID_TEXT')
      const buffer = Buffer.from(content, 'utf8')
      if (buffer.length > MAX_TEXT_BYTES) throw secureError('SECURE_FS_FILE_TOO_LARGE')
      const safeCapability = validateCapability(capability)
      const request: HelperRequest = {
        operation: 'write',
        rootPath: safeCapability.rootPath,
        relativePath: safeCapability.relativePath,
        rootIdentity: safeCapability.rootIdentity,
        contentBase64: buffer.toString('base64'),
        mustAlreadyExist: constraints?.mustAlreadyExist === true,
      }
      if (usingTestInvoke) {
        const response = await invoke(request)
        if (!response.ok) responseError(response)
        await beforeReplace?.()
        return
      }
      const supportedPlatform = securePlatform()
      const response = await invokeBundledAtomicWrite(
        request,
        supportedPlatform,
        resolveHelperPath(),
        timeoutMs,
        beforeReplace,
      )
      if (!response.ok) responseError(response)
    },

    async mkdir(capability) {
      await run('mkdir', capability)
    },

    async exists(capability) {
      const response = await run('exists', capability)
      if (typeof response.exists !== 'boolean') throw secureError('SECURE_FS_HELPER_INVALID_RESPONSE')
      return response.exists
    },

    async listDirectory(capability) {
      const response = await run('list', capability)
      return parseDirectoryEntries(response.entries)
    },
  }
}

/** Historical compatibility factory; prefer createSecureFileSystem in new code. */
export const createWindowsSafeFileSystem = createSecureFileSystem

/** The only production implementation. There is intentionally no Node fs fallback. */
export const windowsSafeFileSystem = createSecureFileSystem({
  isPackaged: electronAppIsPackaged(),
})
