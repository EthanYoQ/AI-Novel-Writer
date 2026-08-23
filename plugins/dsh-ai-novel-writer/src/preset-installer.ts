import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const PRESET_DIRECTORY = 'ai-novel-writer'
const BUNDLED_PRESET_DIRECTORIES = ['ai-novel-writer', 'ai-novel-writer-v2'] as const
const PRESET_FILES = ['agent.cordis.yml', 'preset.yml'] as const

/** Observable installation state for the bundled AI 小说作家 preset. */
export type PresetInstallStatus = { readonly status: 'not-installed' | 'installed' | 'conflict' }

/** Result of an explicit preset installation attempt. */
export interface PresetInstallResult {
  readonly status: 'installed' | 'conflict'
  readonly changed: boolean
}

/** Installs one immutable package preset into a configured user preset root. */
export interface PresetInstaller {
  /**
   * Inspect whether the target is absent, byte-identical, or conflicting.
   *
   * @param signal Optional cancellation signal.
   * @returns Current installation state.
   * @throws {AbortError} When signal is aborted.
   * @throws {Error} When a filesystem error prevents inspection.
   */
  status(signal?: AbortSignal): Promise<PresetInstallStatus>

  /**
   * Atomically install the preset directory when it is absent.
   *
   * @param signal Optional cancellation signal honored before directory publication.
   * @returns Whether the preset is installed and whether this call changed disk state.
   * @throws {AbortError} When signal is aborted before publication.
   * @throws {Error} When installation cannot be completed.
   */
  install(signal?: AbortSignal): Promise<PresetInstallResult>
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

function createDirectoryPresetInstaller(
  templateRoot: string,
  presetRoot: string,
  presetDirectory: string,
): PresetInstaller {
  const targetRoot = join(presetRoot, presetDirectory)

  return {
    status: signal => inspectTarget(templateRoot, targetRoot, signal),
    async install(signal) {
      const initial = await inspectTarget(templateRoot, targetRoot, signal)
      if (initial.status !== 'not-installed') return { status: initial.status, changed: false }

      await mkdir(presetRoot, { recursive: true, mode: 0o700 })
      const stagingRoot = await mkdtemp(join(presetRoot, `.${presetDirectory}-`))
      let published = false
      try {
        for (const filename of PRESET_FILES) {
          throwIfAborted(signal)
          const contents = await readFile(join(templateRoot, filename), 'utf8')
          await writeFileAtomic(join(stagingRoot, filename), contents, { mode: 0o600, dirMode: 0o700 })
        }
        throwIfAborted(signal)
        try {
          await rename(stagingRoot, targetRoot)
          published = true
          return { status: 'installed', changed: true }
        } catch (error) {
          const raced = await inspectTarget(templateRoot, targetRoot, signal)
          if (raced.status === 'not-installed') throw error
          return { status: raced.status, changed: false }
        }
      } finally {
        if (!published) await rm(stagingRoot, { recursive: true, force: true })
      }
    },
  }
}

/**
 * Create an installer for every immutable preset packaged by this plugin.
 *
 * @param packagePresetRoot Absolute package directory containing one subdirectory per preset.
 * @param presetRoot Absolute user preset root selected by Host configuration.
 * @returns An installer that keeps the legacy V1 preset and the independent V2 preset side by side.
 */
export function createBundledPresetInstaller(packagePresetRoot: string, presetRoot: string): PresetInstaller {
  if (!isAbsolute(packagePresetRoot) || !isAbsolute(presetRoot)) {
    throw new TypeError('Bundled preset template and destination roots must be absolute')
  }
  const installers = BUNDLED_PRESET_DIRECTORIES.map(presetDirectory =>
    createDirectoryPresetInstaller(join(packagePresetRoot, presetDirectory), presetRoot, presetDirectory),
  )
  return {
    async status(signal) {
      let installed = 0
      for (const installer of installers) {
        const state = await installer.status(signal)
        if (state.status === 'conflict') return { status: 'conflict' as const }
        if (state.status === 'installed') installed += 1
      }
      return { status: installed === installers.length ? 'installed' as const : 'not-installed' as const }
    },
    async install(signal) {
      const initialStates = []
      for (const installer of installers) initialStates.push(await installer.status(signal))
      if (initialStates.some(state => state.status === 'conflict')) return { status: 'conflict', changed: false }
      if (initialStates.every(state => state.status === 'installed')) return { status: 'installed', changed: false }

      let changed = false
      for (const installer of installers) {
        const result = await installer.install(signal)
        if (result.status === 'conflict') return { status: 'conflict', changed: false }
        changed = changed || result.changed
      }
      return { status: 'installed', changed }
    },
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function inspectTarget(
  templateRoot: string,
  targetRoot: string,
  signal?: AbortSignal,
): Promise<PresetInstallStatus> {
  throwIfAborted(signal)
  let targetStat
  try {
    targetStat = await lstat(targetRoot)
  } catch (error) {
    if (isMissing(error)) return { status: 'not-installed' }
    throw error
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return { status: 'conflict' }

  const entries = (await readdir(targetRoot)).sort()
  if (entries.length !== PRESET_FILES.length || entries.some((entry, index) => entry !== PRESET_FILES[index])) {
    return { status: 'conflict' }
  }
  for (const filename of PRESET_FILES) {
    throwIfAborted(signal)
    const entry = await lstat(join(targetRoot, filename))
    if (!entry.isFile() || entry.isSymbolicLink()) return { status: 'conflict' }
    const [expected, actual] = await Promise.all([
      readFile(join(templateRoot, filename)),
      readFile(join(targetRoot, filename)),
    ])
    if (!expected.equals(actual)) return { status: 'conflict' }
  }
  return { status: 'installed' }
}

/**
 * Create the package preset installer for one configured user preset root.
 *
 * @param templateRoot Absolute directory containing the immutable package preset.
 * @param presetRoot Absolute user preset root selected by Host configuration.
 * @returns An installer that never overwrites an existing target.
 * @throws {TypeError} When either root is not absolute.
 */
export function createPresetInstaller(templateRoot: string, presetRoot: string): PresetInstaller {
  if (!isAbsolute(templateRoot) || !isAbsolute(presetRoot)) {
    throw new TypeError('Preset template and destination roots must be absolute')
  }
  return createDirectoryPresetInstaller(templateRoot, presetRoot, PRESET_DIRECTORY)
}
