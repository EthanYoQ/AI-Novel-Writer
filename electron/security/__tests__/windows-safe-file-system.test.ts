import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
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
  return { rootPath, relativePath }
}

function replaceWithOutsideJunction(rootPath: string, outsidePath: string): void {
  const guardedPath = path.join(rootPath, 'guarded')
  fs.rmSync(guardedPath, { recursive: true, force: true })
  fs.symlinkSync(outsidePath, guardedPath, 'junction')
}

function runExternalNode(script: string, ...args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['-e', script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe.runIf(process.platform === 'win32')('Windows handle-bound secure file system', () => {
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
  })

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
    const output = capability(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(path.join(selectedRoot, 'chapter.txt'), 'old content', 'utf8')
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
    const output = capability(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
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
    const output = capability(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
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
    const output = capability(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
    fs.writeFileSync(attackerPath, 'attacker content', 'utf8')
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
    const output = capability(selectedRoot, 'chapter.txt')
    fs.mkdirSync(selectedRoot)
    fs.writeFileSync(targetPath, 'old content', 'utf8')
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
