import fs from 'node:fs'
import path from 'node:path'

import type {
  SecureDirectoryEntry,
  SecureFileCapability,
  SecureFileSystem,
} from '../../electron/security/windows-safe-file-system'

function secureError(code: string): Error {
  return new Error(code)
}

function assertContained(rootPath: string, candidatePath: string): void {
  const relative = path.relative(rootPath, candidatePath)
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw secureError('SECURE_FS_INVALID_PATH')
  }
}

function capabilitySegments(relativePath: string): string[] {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw secureError('SECURE_FS_INVALID_PATH')
  }
  return segments
}

function resolveCapability(capability: SecureFileCapability): string {
  const rootPath = fs.realpathSync.native(capability.rootPath)
  const rootStats = fs.statSync(rootPath, { bigint: true })
  if (
    !rootStats.isDirectory()
    || rootStats.dev.toString() !== capability.rootIdentity.volumeSerialNumber
    || rootStats.ino.toString() !== capability.rootIdentity.fileIndex
  ) {
    throw secureError('SECURE_FS_REPARSE_POINT')
  }

  const segments = capabilitySegments(capability.relativePath)
  let currentPath = rootPath
  for (let index = 0; index < segments.length; index += 1) {
    const nextPath = path.join(currentPath, segments[index])
    if (!fs.existsSync(nextPath)) {
      const unresolvedPath = path.join(nextPath, ...segments.slice(index + 1))
      assertContained(rootPath, unresolvedPath)
      return unresolvedPath
    }
    const information = fs.lstatSync(nextPath)
    if (information.isSymbolicLink()) {
      throw secureError('SECURE_FS_REPARSE_POINT')
    }
    const canonicalPath = fs.realpathSync.native(nextPath)
    assertContained(rootPath, canonicalPath)
    currentPath = canonicalPath
  }
  return currentPath
}

async function readBytes(
  capability: SecureFileCapability,
  maxBytes?: number,
): Promise<Buffer> {
  const targetPath = resolveCapability(capability)
  const content = fs.readFileSync(targetPath)
  if (maxBytes !== undefined && content.length > maxBytes) {
    throw secureError('SECURE_FS_FILE_TOO_LARGE')
  }
  return content
}

export const nodeTestSecureFileSystem: SecureFileSystem = {
  readBytes,

  async readText(capability, maxBytes) {
    const content = await readBytes(capability, maxBytes)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(content)
    } catch {
      throw secureError('SECURE_FS_INVALID_TEXT')
    }
  },

  async writeTextAtomically(capability, content, beforeReplace, constraints) {
    const initialTarget = resolveCapability(capability)
    if (constraints?.mustAlreadyExist && !fs.existsSync(initialTarget)) {
      throw secureError('SECURE_FS_NOT_FOUND')
    }
    await beforeReplace?.()
    const targetPath = resolveCapability(capability)
    if (constraints?.mustAlreadyExist && !fs.existsSync(targetPath)) {
      throw secureError('SECURE_FS_NOT_FOUND')
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
    )
    try {
      fs.writeFileSync(temporaryPath, content, 'utf8')
      fs.renameSync(temporaryPath, targetPath)
    } finally {
      fs.rmSync(temporaryPath, { force: true })
    }
  },

  async mkdir(capability) {
    const targetPath = resolveCapability(capability)
    fs.mkdirSync(targetPath, { recursive: true })
  },

  async exists(capability) {
    return fs.existsSync(resolveCapability(capability))
  },

  async listDirectory(capability): Promise<SecureDirectoryEntry[]> {
    const targetPath = resolveCapability(capability)
    return fs.readdirSync(targetPath, { withFileTypes: true }).map(entry => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
  },
}
