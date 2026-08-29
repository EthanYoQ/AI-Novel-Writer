import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSecureFileCapability,
  createWindowsSafeFileSystem,
  type SecureFileCapability,
} from '../windows-safe-file-system'

const temporaryRoots: string[] = []
const REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS = 15_000

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-secure-fs-'))
  temporaryRoots.push(root)
  return root
}

function capability(rootPath: string, relativePath: string): SecureFileCapability {
  return createSecureFileCapability(rootPath, path.join(rootPath, relativePath))
}

function replaceWithOutsideJunction(rootPath: string, outsidePath: string): void {
  const guardedPath = path.join(rootPath, 'guarded')
  fs.rmSync(guardedPath, { recursive: true, force: true })
  fs.symlinkSync(outsidePath, guardedPath, 'junction')
}

function replaceRootWithOutsideJunction(rootPath: string, outsidePath: string): void {
  fs.rmSync(rootPath, { recursive: true, force: true })
  fs.symlinkSync(outsidePath, rootPath, 'junction')
}

function runExternalNode(script: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['-e', script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

function buildDarwinHelper(fixture: string): string {
  const output = path.join(fixture, 'darwin-safe-file-system')
  const source = path.resolve('electron/security/darwin-safe-file-system.m')
  const result = spawnSync('clang', [
    '-fobjc-arc',
    '-Wall',
    '-Werror',
    '-framework', 'Foundation',
    source,
    '-o', output,
  ], {
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  return output
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('bounded secure text reads', () => {
  it('passes the caller byte budget to the helper and enforces it on the response', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const requests: Array<Record<string, unknown>> = []
    fs.mkdirSync(selectedRoot)
    const safeFileSystem = createWindowsSafeFileSystem({
      invoke: async (request) => {
        requests.push({ ...request })
        return {
          ok: true,
          contentBase64: Buffer.from('1234', 'utf8').toString('base64'),
        }
      },
    })

    await expect(safeFileSystem.readText(capability(selectedRoot, 'chapter.txt'), 3))
      .rejects.toThrow('SECURE_FS_FILE_TOO_LARGE')
    expect(requests).toEqual([
      expect.objectContaining({ operation: 'read', maxBytes: 3 }),
    ])
  })

  it('returns arbitrary bytes through the same bounded capability helper', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00])
    const requests: Array<Record<string, unknown>> = []
    fs.mkdirSync(selectedRoot)
    const safeFileSystem = createWindowsSafeFileSystem({
      invoke: async (request) => {
        requests.push({ ...request })
        return { ok: true, contentBase64: binary.toString('base64') }
      },
    })

    await expect(safeFileSystem.readBytes(capability(selectedRoot, 'novel.epub'), binary.length))
      .resolves.toEqual(binary)
    expect(requests).toEqual([
      expect.objectContaining({ operation: 'read', maxBytes: binary.length }),
    ])
  })
})

describe('Darwin handle-bound secure file system', () => {
  it('binds every helper operation to the frozen root device and inode', () => {
    const source = fs.readFileSync(
      path.resolve('electron/security/darwin-safe-file-system.m'),
      'utf8',
    )

    expect(source).toContain('SECURE_FS_ROOT_CHANGED')
    expect(source).toContain('GetRootIdentity(request, &expectedRootDevice, &expectedRootFileIndex, &errorCode)')
    expect(source).toContain('identity.count != 2')
    expect(source).toContain('ParseUnsignedDecimal(identity[@"volumeSerialNumber"], UINT32_MAX, expectedDevice)')
    expect(source).toContain('ParseUnsignedDecimal(identity[@"fileIndex"], UINT64_MAX, expectedFileIndex)')
    expect(source).toContain('OpenRoot(rootPath, expectedDevice, expectedFileIndex, errorCode)')
    expect(source).toContain('(uint64_t)information.st_dev != expectedDevice || (uint64_t)information.st_ino != expectedFileIndex')
  })

  it('fails closed in packaged mode when the bundled Darwin helper is missing', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const missingResources = path.join(fixture, 'packaged-resources')
    fs.mkdirSync(selectedRoot)

    const safeFileSystem = createWindowsSafeFileSystem({
      platform: 'darwin',
      isPackaged: true,
      resourcesPath: missingResources,
    })

    await expect(safeFileSystem.exists(capability(selectedRoot, 'chapter.txt')))
      .rejects.toThrow('SECURE_FS_HELPER_UNAVAILABLE')
  })
})

describe.runIf(process.platform === 'win32')('Windows handle-bound secure file system', () => {
  it('rejects a selected file that grows past the caller byte budget', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const selectedPath = path.join(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(selectedPath, '123', 'utf8')
    const grantedCapability = capability(selectedRoot, 'chapter.txt')
    fs.writeFileSync(selectedPath, '1234', 'utf8')

    await expect(createWindowsSafeFileSystem().readText(grantedCapability, 3))
      .rejects.toThrow('SECURE_FS_FILE_TOO_LARGE')
  })

  it('fails closed in packaged mode when the resources helper is missing even if cwd contains a source helper', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const fakeCwd = path.join(fixture, 'working-directory')
    const missingResources = path.join(fixture, 'packaged-resources')
    const fakeSourceHelper = path.join(fakeCwd, 'electron', 'security', 'windows-safe-file-system.ps1')
    fs.mkdirSync(selectedRoot)
    fs.mkdirSync(path.dirname(fakeSourceHelper), { recursive: true })
    fs.writeFileSync(
      fakeSourceHelper,
      "$null = [Console]::In.ReadLine(); [Console]::Out.WriteLine('{\"ok\":true,\"exists\":false}')",
      'utf8',
    )

    const originalCwd = process.cwd()
    const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    process.chdir(fakeCwd)
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: missingResources,
      writable: true,
    })
    try {
      const safeFileSystem = createWindowsSafeFileSystem({
        platform: 'win32',
        isPackaged: true,
        resourcesPath: missingResources,
        cwd: fakeCwd,
      } as Parameters<typeof createWindowsSafeFileSystem>[0])

      await expect(safeFileSystem.exists(capability(selectedRoot, 'chapter.txt')))
        .rejects.toThrow('SECURE_FS_HELPER_UNAVAILABLE')
    } finally {
      process.chdir(originalCwd)
      if (originalResourcesPath) {
        Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
      } else {
        delete (process as unknown as { resourcesPath?: string }).resourcesPath
      }
    }
  })

  it('keeps the source helper fallback available for explicit development mode', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const fakeCwd = path.join(fixture, 'working-directory')
    const missingResources = path.join(fixture, 'development-resources')
    const fakeSourceHelper = path.join(fakeCwd, 'electron', 'security', 'windows-safe-file-system.ps1')
    fs.mkdirSync(selectedRoot)
    fs.mkdirSync(path.dirname(fakeSourceHelper), { recursive: true })
    fs.writeFileSync(
      fakeSourceHelper,
      "$null = [Console]::In.ReadLine(); [Console]::Out.WriteLine('{\"ok\":true,\"exists\":false}')",
      'utf8',
    )
    const safeFileSystem = createWindowsSafeFileSystem({
      platform: 'win32',
      isPackaged: false,
      resourcesPath: missingResources,
      cwd: fakeCwd,
    })

    await expect(safeFileSystem.exists(capability(selectedRoot, 'chapter.txt')))
      .resolves.toBe(false)
  })

  it('documents the old validate-then-read escape after a guarded directory becomes a junction', () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const outsideRoot = path.join(fixture, 'outside')
    const legacyTarget = path.join(selectedRoot, 'guarded', 'secret.txt')
    fs.mkdirSync(path.join(selectedRoot, 'guarded'), { recursive: true })
    fs.mkdirSync(outsideRoot)
    fs.writeFileSync(legacyTarget, 'inside', 'utf8')
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'outside', 'utf8')

    // This mirrors the old controller flow: it validates a string path, then
    // performs a separate path-based read. The validation succeeds before the
    // attacker swaps the guarded segment.
    expect(fs.realpathSync.native(legacyTarget)).toContain('selected')
    replaceWithOutsideJunction(selectedRoot, outsideRoot)

    expect(fs.readFileSync(legacyTarget, 'utf8')).toBe('outside')
  })

  it('rejects a read after a previously valid guarded directory becomes a junction', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const outsideRoot = path.join(fixture, 'outside')
    fs.mkdirSync(path.join(selectedRoot, 'guarded'), { recursive: true })
    fs.mkdirSync(outsideRoot)
    fs.writeFileSync(path.join(selectedRoot, 'guarded', 'secret.txt'), 'inside', 'utf8')
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'outside', 'utf8')

    const grantedCapability = capability(selectedRoot, 'guarded/secret.txt')
    replaceWithOutsideJunction(selectedRoot, outsideRoot)

    await expect(createWindowsSafeFileSystem().readText(grantedCapability))
      .rejects.toThrow('SECURE_FS_REPARSE_POINT')
  })

  it('rejects mkdir and atomic replacement after a guarded directory becomes a junction', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const outsideRoot = path.join(fixture, 'outside')
    fs.mkdirSync(path.join(selectedRoot, 'guarded'), { recursive: true })
    fs.mkdirSync(outsideRoot)
    const safeFileSystem = createWindowsSafeFileSystem()

    const grantedDirectory = capability(selectedRoot, 'guarded/new-folder')
    const grantedFile = capability(selectedRoot, 'guarded/result.txt')
    replaceWithOutsideJunction(selectedRoot, outsideRoot)

    await expect(safeFileSystem.mkdir(grantedDirectory)).rejects.toThrow('SECURE_FS_REPARSE_POINT')
    await expect(safeFileSystem.writeTextAtomically(grantedFile, 'must stay inside'))
      .rejects.toThrow('SECURE_FS_REPARSE_POINT')
    expect(fs.existsSync(path.join(outsideRoot, 'new-folder'))).toBe(false)
    expect(fs.existsSync(path.join(outsideRoot, 'result.txt'))).toBe(false)
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('lists ordinary entries when the directory also contains a junction without exposing the junction', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const outsideRoot = path.join(fixture, 'outside')
    fs.mkdirSync(selectedRoot)
    fs.mkdirSync(outsideRoot)
    fs.writeFileSync(path.join(selectedRoot, 'chapter.txt'), 'inside', 'utf8')
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'outside', 'utf8')
    fs.symlinkSync(outsideRoot, path.join(selectedRoot, 'linked-outside'), 'junction')

    const safeFileSystem = createWindowsSafeFileSystem()

    await expect(safeFileSystem.listDirectory(capability(selectedRoot, '')))
      .resolves.toEqual([{ name: 'chapter.txt', isDirectory: false }])
    await expect(safeFileSystem.listDirectory(capability(selectedRoot, 'linked-outside')))
      .resolves.toEqual([])
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('lists authorized roots reached through parent or root junctions without exposing child junctions', async () => {
    const fixture = fixtureRoot()
    const physicalParent = path.join(fixture, 'physical-parent')
    const selectedRoot = path.join(physicalParent, 'project')
    const junctionParent = path.join(fixture, 'junction-parent')
    const rootViaParentJunction = path.join(junctionParent, 'project')
    const rootJunction = path.join(fixture, 'project-junction')
    const outsideRoot = path.join(fixture, 'outside')
    fs.mkdirSync(selectedRoot, { recursive: true })
    fs.mkdirSync(outsideRoot)
    fs.writeFileSync(path.join(selectedRoot, 'chapter.txt'), 'inside', 'utf8')
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'outside', 'utf8')
    fs.symlinkSync(physicalParent, junctionParent, 'junction')
    fs.symlinkSync(selectedRoot, rootJunction, 'junction')
    fs.symlinkSync(outsideRoot, path.join(selectedRoot, 'linked-outside'), 'junction')

    const safeFileSystem = createWindowsSafeFileSystem()

    await expect(safeFileSystem.listDirectory(capability(rootViaParentJunction, '')))
      .resolves.toEqual([{ name: 'chapter.txt', isDirectory: false }])
    await expect(safeFileSystem.listDirectory(capability(rootJunction, '')))
      .resolves.toEqual([{ name: 'chapter.txt', isDirectory: false }])
    await expect(safeFileSystem.listDirectory(capability(rootViaParentJunction, 'linked-outside')))
      .resolves.toEqual([])
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('rejects read, list, and atomic write after an authorized ordinary root becomes an outside junction', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const outsideRoot = path.join(fixture, 'outside')
    fs.mkdirSync(selectedRoot)
    fs.mkdirSync(outsideRoot)
    fs.writeFileSync(path.join(selectedRoot, 'chapter.txt'), 'inside', 'utf8')
    fs.writeFileSync(path.join(outsideRoot, 'chapter.txt'), 'outside', 'utf8')

    const grantedRead = capability(selectedRoot, 'chapter.txt')
    const grantedList = capability(selectedRoot, '')
    const grantedWrite = capability(selectedRoot, 'new-chapter.txt')
    replaceRootWithOutsideJunction(selectedRoot, outsideRoot)

    const safeFileSystem = createWindowsSafeFileSystem()

    await expect(safeFileSystem.readText(grantedRead)).rejects.toThrow('SECURE_FS_ROOT_CHANGED')
    await expect(safeFileSystem.listDirectory(grantedList)).rejects.toThrow('SECURE_FS_ROOT_CHANGED')
    await expect(safeFileSystem.writeTextAtomically(grantedWrite, 'must stay inside'))
      .rejects.toThrow('SECURE_FS_ROOT_CHANGED')
    expect(fs.readFileSync(path.join(outsideRoot, 'chapter.txt'), 'utf8')).toBe('outside')
    expect(fs.existsSync(path.join(outsideRoot, 'new-chapter.txt'))).toBe(false)
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('keeps ordinary non-reparse reads, recursive mkdir, atomic writes, and enumeration working', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    fs.mkdirSync(selectedRoot)
    const safeFileSystem = createWindowsSafeFileSystem()
    const output = capability(selectedRoot, 'nested/chapter.txt')

    // This deliberately starts four real PowerShell helpers (mkdir, write,
    // read, list). Each helper compiles the native C# boundary, and concurrent
    // full-suite load can exceed Vitest's 5 second unit-test default.
    await safeFileSystem.mkdir(capability(selectedRoot, 'nested'))
    await safeFileSystem.writeTextAtomically(output, '正常内容')

    await expect(safeFileSystem.readText(output)).resolves.toBe('正常内容')
    await expect(safeFileSystem.listDirectory(capability(selectedRoot, 'nested')))
      .resolves.toEqual([{ name: 'chapter.txt', isDirectory: false }])
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('cancels a prepared atomic replacement when the main-process commit guard rejects it', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(path.join(selectedRoot, 'chapter.txt'), 'old content', 'utf8')
    const output = capability(selectedRoot, 'chapter.txt')
    const safeFileSystem = createWindowsSafeFileSystem()

    await expect(safeFileSystem.writeTextAtomically(output, 'new content', () => {
      throw new Error('lease-revalidation-rejected')
    })).rejects.toThrow('lease-revalidation-rejected')

    expect(fs.readFileSync(path.join(selectedRoot, 'chapter.txt'), 'utf8')).toBe('old content')
  })

  it('does not recreate a write-only target deleted before helper preparation', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const targetPath = path.join(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
    const output = capability(selectedRoot, 'chapter.txt')
    fs.rmSync(targetPath)
    const safeFileSystem = createWindowsSafeFileSystem()
    let reachedCommitGuard = false

    await expect(safeFileSystem.writeTextAtomically(
      output,
      'new content',
      () => {
        reachedCommitGuard = true
      },
      { mustAlreadyExist: true },
    )).rejects.toThrow('SECURE_FS_NOT_FOUND')

    expect(reachedCommitGuard).toBe(false)
    expect(fs.existsSync(targetPath)).toBe(false)
    expect(fs.readdirSync(selectedRoot)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^\.ai-novel-.*\.tmp$/),
    ]))
  })

  it('holds a write-only target against deletion by another process from ready through commit', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const targetPath = path.join(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
    const output = capability(selectedRoot, 'chapter.txt')
    const safeFileSystem = createWindowsSafeFileSystem()

    let writeError: unknown
    try {
      await safeFileSystem.writeTextAtomically(
        output,
        'new content',
        () => {
          const deletion = runExternalNode(
            "require('node:fs').rmSync(process.argv[1], { force: true })",
            targetPath,
          )
          expect(deletion.status, deletion.stderr).not.toBe(0)
          expect(fs.readFileSync(targetPath, 'utf8')).toBe('old content')
        },
        { mustAlreadyExist: true },
      )
    } catch (error) {
      writeError = error
    }

    if (writeError) {
      expect(writeError).toMatchObject({ message: 'SECURE_FS_WRITE_FAILED' })
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('old content')
    } else {
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('new content')
    }
  })

  it('holds a write-only target against replacement by another process from ready through commit', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const targetPath = path.join(selectedRoot, 'chapter.txt')
    const attackerPath = path.join(selectedRoot, 'attacker.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
    fs.writeFileSync(attackerPath, 'attacker content', 'utf8')
    const output = capability(selectedRoot, 'chapter.txt')
    const safeFileSystem = createWindowsSafeFileSystem()

    let writeError: unknown
    try {
      await safeFileSystem.writeTextAtomically(
        output,
        'new content',
        () => {
          const replacement = runExternalNode(
            "require('node:fs').renameSync(process.argv[1], process.argv[2])",
            attackerPath,
            targetPath,
          )
          expect(replacement.status, replacement.stderr).not.toBe(0)
          expect(fs.readFileSync(targetPath, 'utf8')).toBe('old content')
          expect(fs.readFileSync(attackerPath, 'utf8')).toBe('attacker content')
        },
        { mustAlreadyExist: true },
      )
    } catch (error) {
      writeError = error
    }

    if (writeError) {
      expect(writeError).toMatchObject({ message: 'SECURE_FS_WRITE_FAILED' })
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('old content')
    } else {
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('new content')
    }
    expect(fs.readFileSync(attackerPath, 'utf8')).toBe('attacker content')
  })

  it('fails closed without an older rename fallback when rename-ex is unsupported', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const targetPath = path.join(selectedRoot, 'chapter.txt')
    const unsupportedHelper = path.join(fixture, 'windows-safe-file-system-unsupported.ps1')
    const sourceHelper = path.resolve('electron/security/windows-safe-file-system.ps1')
    const helperSource = fs.readFileSync(sourceHelper, 'utf8')
    const unsupportedSource = helperSource.replace(
      'private const int FileRenameInformationEx = 65;',
      'private const int FileRenameInformationEx = 0x7fffffff;',
    )
    expect(unsupportedSource).not.toBe(helperSource)
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
    fs.writeFileSync(unsupportedHelper, unsupportedSource, 'utf8')
    const safeFileSystem = createWindowsSafeFileSystem({
      helperPath: unsupportedHelper,
      platform: 'win32',
      isPackaged: false,
    })

    await expect(safeFileSystem.writeTextAtomically(
      capability(selectedRoot, 'chapter.txt'),
      'new content',
      undefined,
      { mustAlreadyExist: true },
    )).rejects.toThrow('SECURE_FS_WRITE_FAILED')

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('old content')
  })

  it('allows a create-capable atomic write to create the target at commit', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const targetPath = path.join(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
    const output = capability(selectedRoot, 'chapter.txt')
    const safeFileSystem = createWindowsSafeFileSystem()

    await safeFileSystem.writeTextAtomically(
      output,
      'new content',
      () => fs.rmSync(targetPath),
      { mustAlreadyExist: false },
    )

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('new content')
  })
})

describe.runIf(process.platform === 'darwin')('Darwin handle-bound secure file system', () => {
  it('rejects read, list, and write after the selected root is replaced by an ordinary directory', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const movedRoot = path.join(fixture, 'moved-selected')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(path.join(selectedRoot, 'chapter.txt'), 'original', 'utf8')
    const readCapability = capability(selectedRoot, 'chapter.txt')
    const listCapability = capability(selectedRoot, '')
    const writeCapability = capability(selectedRoot, 'chapter.txt')
    fs.renameSync(selectedRoot, movedRoot)
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(path.join(selectedRoot, 'chapter.txt'), 'replacement', 'utf8')
    const safeFileSystem = createWindowsSafeFileSystem({
      platform: 'darwin',
      helperPath: buildDarwinHelper(fixture),
    })

    await expect(safeFileSystem.readText(readCapability))
      .rejects.toThrow('SECURE_FS_ROOT_CHANGED')
    await expect(safeFileSystem.listDirectory(listCapability))
      .rejects.toThrow('SECURE_FS_ROOT_CHANGED')
    await expect(safeFileSystem.writeTextAtomically(writeCapability, 'attacker write'))
      .rejects.toThrow('SECURE_FS_ROOT_CHANGED')
    expect(fs.readFileSync(path.join(selectedRoot, 'chapter.txt'), 'utf8')).toBe('replacement')
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('rejects a selected file that grows past the caller byte budget', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const selectedPath = path.join(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(selectedPath, '123', 'utf8')
    const grantedCapability = capability(selectedRoot, 'chapter.txt')
    fs.writeFileSync(selectedPath, '1234', 'utf8')
    const safeFileSystem = createWindowsSafeFileSystem({
      platform: 'darwin',
      helperPath: buildDarwinHelper(fixture),
    })

    await expect(safeFileSystem.readText(grantedCapability, 3))
      .rejects.toThrow('SECURE_FS_FILE_TOO_LARGE')
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('rejects symlink escapes for reads, mkdir, and atomic writes', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const outsideRoot = path.join(fixture, 'outside')
    fs.mkdirSync(path.join(selectedRoot, 'guarded'), { recursive: true })
    fs.mkdirSync(outsideRoot)
    fs.writeFileSync(path.join(selectedRoot, 'guarded', 'secret.txt'), 'inside', 'utf8')
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'outside', 'utf8')
    const safeFileSystem = createWindowsSafeFileSystem({
      platform: 'darwin',
      helperPath: buildDarwinHelper(fixture),
    })

    replaceWithOutsideJunction(selectedRoot, outsideRoot)

    await expect(safeFileSystem.readText(capability(selectedRoot, 'guarded/secret.txt')))
      .rejects.toThrow('SECURE_FS_REPARSE_POINT')
    await expect(safeFileSystem.mkdir(capability(selectedRoot, 'guarded/new-folder')))
      .rejects.toThrow('SECURE_FS_REPARSE_POINT')
    await expect(safeFileSystem.writeTextAtomically(
      capability(selectedRoot, 'guarded/result.txt'),
      'must stay inside',
    )).rejects.toThrow('SECURE_FS_REPARSE_POINT')
    expect(fs.existsSync(path.join(outsideRoot, 'new-folder'))).toBe(false)
    expect(fs.existsSync(path.join(outsideRoot, 'result.txt'))).toBe(false)
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('keeps ordinary operations and the atomic commit boundary working', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    fs.mkdirSync(selectedRoot)
    const safeFileSystem = createWindowsSafeFileSystem({
      platform: 'darwin',
      helperPath: buildDarwinHelper(fixture),
    })
    const output = capability(selectedRoot, 'nested/chapter.txt')

    await safeFileSystem.mkdir(capability(selectedRoot, 'nested'))
    await safeFileSystem.mkdir(capability(selectedRoot, 'nested/drafts'))
    await safeFileSystem.writeTextAtomically(output, 'normal content')

    await expect(safeFileSystem.readText(output)).resolves.toBe('normal content')
    await expect(safeFileSystem.exists(output)).resolves.toBe(true)
    await expect(safeFileSystem.listDirectory(capability(selectedRoot, 'nested')))
      .resolves.toEqual(expect.arrayContaining([
        { name: 'chapter.txt', isDirectory: false },
        { name: 'drafts', isDirectory: true },
      ]))

    await expect(safeFileSystem.writeTextAtomically(output, 'rejected replacement', () => {
      throw new Error('lease-revalidation-rejected')
    })).rejects.toThrow('lease-revalidation-rejected')
    expect(fs.readFileSync(path.join(selectedRoot, 'nested', 'chapter.txt'), 'utf8')).toBe('normal content')
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('does not recreate a must-exist target that was removed before preparation', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const targetPath = path.join(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
    fs.rmSync(targetPath)
    const safeFileSystem = createWindowsSafeFileSystem({
      platform: 'darwin',
      helperPath: buildDarwinHelper(fixture),
    })
    let reachedCommitGuard = false

    await expect(safeFileSystem.writeTextAtomically(
      capability(selectedRoot, 'chapter.txt'),
      'new content',
      () => {
        reachedCommitGuard = true
      },
      { mustAlreadyExist: true },
    )).rejects.toThrow('SECURE_FS_NOT_FOUND')

    expect(reachedCommitGuard).toBe(false)
    expect(fs.existsSync(targetPath)).toBe(false)
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('fails closed when a must-exist target changes during the commit guard', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const targetPath = path.join(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
    const safeFileSystem = createWindowsSafeFileSystem({
      platform: 'darwin',
      helperPath: buildDarwinHelper(fixture),
    })

    await expect(safeFileSystem.writeTextAtomically(
      capability(selectedRoot, 'chapter.txt'),
      'new content',
      () => fs.rmSync(targetPath),
      { mustAlreadyExist: true },
    )).rejects.toThrow('SECURE_FS_WRITE_FAILED')

    expect(fs.existsSync(targetPath)).toBe(false)
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)

  it('does not replace a must-exist target substituted during the commit guard', async () => {
    const fixture = fixtureRoot()
    const selectedRoot = path.join(fixture, 'selected')
    const targetPath = path.join(selectedRoot, 'chapter.txt')
    const attackerPath = path.join(selectedRoot, 'attacker.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
    fs.writeFileSync(attackerPath, 'attacker content', 'utf8')
    const safeFileSystem = createWindowsSafeFileSystem({
      platform: 'darwin',
      helperPath: buildDarwinHelper(fixture),
    })

    await expect(safeFileSystem.writeTextAtomically(
      capability(selectedRoot, 'chapter.txt'),
      'new content',
      () => fs.renameSync(attackerPath, targetPath),
      { mustAlreadyExist: true },
    )).rejects.toThrow('SECURE_FS_WRITE_FAILED')

    expect(fs.readFileSync(targetPath, 'utf8')).toBe('attacker content')
  }, REAL_WINDOWS_MULTI_HELPER_TIMEOUT_MS)
})
