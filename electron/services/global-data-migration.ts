import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { installGlobalDataLocator, type GlobalDataRoots } from './app-data-locator'

export const GLOBAL_OBJECTS = ['config.json', 'models.json', 'recent-projects.json', 'mcp_config.json', 'prompts', 'skills', 'skins'] as const
/** No verified product writer owns arbitrary contents of these shared legacy directories. */
export const GLOBAL_PRESERVED_OBJECTS = ['logs', 'metadata', 'update'] as const
type Ready = { state: 'ready'; globalGeneration: string; dataRoot: string; legacySourceIgnored: boolean; preservedUnknownCount: number }
export type GlobalMigrationResult = Ready | { state: 'blocked'; code: string }
export interface GlobalMigrationOptions extends GlobalDataRoots {
  /** Main must hold the unchanged application single-instance lock before calling. */
  exclusiveAccess: boolean
  /** Deterministic fixture seam; errors model process interruption at durable boundaries. */
  checkpoint?: (step: string) => void
}
interface Journal { version: 1; generation: string; phase: 'prepared' | 'verified'; source: 'legacy' | 'canonical' | 'empty' }
interface Receipt { version: 1; generation: string; completed: true; preservedUnknownCount: number; requiredObjects: string[] }
const admitted = new WeakMap<object, string>()
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function fail(code: string): never { throw new Error(code) }
function parse(file: string): unknown { try {
  const info = fs.lstatSync(file)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('GLOBAL_JSON_INVALID')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
} catch { return fail('GLOBAL_JSON_INVALID') } }
function syncDirectory(directory: string): void {
  // Windows directory handles do not support fsync through Node. Files are flushed
  // before same-volume rename; restart verifies physical state against the journal.
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function durable(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`
  const fd = fs.openSync(temp, 'wx', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file); syncDirectory(path.dirname(file))
}
function safeRoot(root: string): string {
  const absolute = path.resolve(root)
  let cursor = path.parse(absolute).root
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    let info: fs.Stats | undefined
    try { info = fs.lstatSync(cursor) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) fail('GLOBAL_ROOT_UNSAFE')
    }
  }
  return absolute
}
function assertRoots(roots: GlobalDataRoots): void {
  const values = Object.values(roots).map(safeRoot).map(value => process.platform === 'win32' ? value.toLowerCase() : value)
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
    const a = values[i]!, b = values[j]!
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) fail('GLOBAL_ROOT_INTERSECTION')
  }
}
function files(root: string, prefix = ''): string[] {
  if (!fs.existsSync(root)) return []
  const result: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name), location = path.join(root, entry.name)
    if (entry.isSymbolicLink()) fail('GLOBAL_ASSET_LINK')
    if (entry.isDirectory()) result.push(...files(location, relative))
    else if (entry.isFile()) {
      if (fs.lstatSync(location).nlink !== 1) fail('GLOBAL_ASSET_HARDLINK')
      result.push(relative)
    }
    else fail('GLOBAL_ASSET_TYPE')
  }
  return result.sort()
}
function selectedFiles(root: string): string[] {
  return GLOBAL_OBJECTS.flatMap(name => {
    const location = path.join(root, name)
    let stat: fs.Stats
    try { stat = fs.lstatSync(location) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    if (stat.isSymbolicLink()) return fail('GLOBAL_ASSET_LINK')
    if (stat.isDirectory()) { if (name.endsWith('.json')) return fail('GLOBAL_ASSET_TYPE'); return files(location, name) }
    if (!name.endsWith('.json')) return fail('GLOBAL_ASSET_TYPE')
    if (!stat.isFile()) return fail('GLOBAL_ASSET_TYPE')
    if (stat.nlink !== 1) return fail('GLOBAL_ASSET_HARDLINK')
    return [name]
  }).sort()
}
function validate(root: string): void {
  const names = selectedFiles(root) // Link/type proof precedes every JSON or image read.
  const configPath = path.join(root, 'config.json'), modelsPath = path.join(root, 'models.json')
  const config = fs.existsSync(configPath) ? parse(configPath) : {}
  const models = fs.existsSync(modelsPath) ? parse(modelsPath) : []
  if (!record(config) || !Array.isArray(models)) fail('GLOBAL_CONFIG_SCHEMA_INVALID')
  const ids = new Set<string>()
  for (const model of models) {
    if (!record(model) || typeof model.id !== 'string' || !model.id || ids.has(model.id)) fail('GLOBAL_MODEL_ID_INVALID')
    for (const key of ['apiKey', 'baseUrl', 'name', 'provider', 'protocol', 'modelName']) {
      if (model[key] !== undefined && typeof model[key] !== 'string') fail('GLOBAL_MODEL_SCHEMA_INVALID')
    }
    ids.add(model.id)
  }
  if (config.updatePreferences !== undefined && !record(config.updatePreferences)) fail('GLOBAL_UPDATE_PREFERENCES_INVALID')
  for (const key of ['defaultModelId', 'defaultEmbeddingModelId']) {
    if (config[key] != null && (typeof config[key] !== 'string' || !ids.has(config[key] as string))) fail('GLOBAL_DEFAULT_MODEL_MISSING')
  }
  for (const name of ['recent-projects.json', 'mcp_config.json']) {
    const location = path.join(root, name)
    if (!fs.existsSync(location)) continue
    const value = parse(location)
    if (name === 'recent-projects.json' ? !Array.isArray(value) : !record(value) || !record(value.mcpServers)) fail('GLOBAL_OBJECT_SCHEMA_INVALID')
    if (name === 'mcp_config.json' && record(value) && record(value.mcpServers)) {
      for (const server of Object.values(value.mcpServers)) {
        if (!record(server)) fail('GLOBAL_MCP_INVALID')
        const command = typeof server.command === 'string' && server.command.trim().length > 0
        const url = typeof server.url === 'string' && server.url.trim().length > 0
        if (command === url || (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string')))
          || (server.env !== undefined && (!record(server.env) || Object.values(server.env).some(entry => typeof entry !== 'string')))) fail('GLOBAL_MCP_INVALID')
      }
    }
  }
  const manifest = path.join(root, 'skins', 'manifest.json')
  if (fs.existsSync(manifest)) {
    const value = parse(manifest)
    if (!record(value) || value.version !== 1 || !['classic', 'anime', 'custom'].includes(value.activeSkin as string)) fail('GLOBAL_SKIN_INVALID')
    if (value.stateRevision !== undefined && (!Number.isSafeInteger(value.stateRevision) || Number(value.stateRevision) < 0)) fail('GLOBAL_SKIN_INVALID')
    if (value.customSkin !== undefined) {
      const custom = value.customSkin
      if (!record(custom) || typeof custom.assetFile !== 'string' || !/^[a-f0-9]{64}\.(png|jpg)$/.test(custom.assetFile)
        || !fs.existsSync(path.join(root, 'skins', 'assets', custom.assetFile))) fail('GLOBAL_SKIN_INVALID')
      const bytes = fs.readFileSync(path.join(root, 'skins', 'assets', custom.assetFile))
      if (!['image/png', 'image/jpeg'].includes(custom.mime as string) || !Number.isSafeInteger(custom.width) || !Number.isSafeInteger(custom.height)
        || Number(custom.width) <= 0 || Number(custom.height) <= 0 || Number(custom.width) > 4096 || Number(custom.height) > 4096
        || Number(custom.width) * Number(custom.height) > 16_000_000 || custom.assetFile !== `${custom.revision}.${custom.mime === 'image/png' ? 'png' : 'jpg'}`
        || createHash('sha256').update(bytes).digest('hex') !== custom.revision) fail('GLOBAL_SKIN_INVALID')
    }
    if (value.activeSkin === 'custom' && !value.customSkin) fail('GLOBAL_SKIN_INVALID')
  }
  for (const name of names) {
    if (name.startsWith(`prompts${path.sep}`) && name.endsWith('.json') && !record(parse(path.join(root, name)))) fail('GLOBAL_PROMPT_INVALID')
  }
}
function equalSelected(source: string, target: string): boolean {
  const names = selectedFiles(source)
  return isDeepStrictEqual(names, selectedFiles(target)) && names.every(name => fs.readFileSync(path.join(source, name)).equals(fs.readFileSync(path.join(target, name))))
}
function conflictCode(legacy: string, target: string): string {
  const aPath = path.join(legacy, 'models.json'), bPath = path.join(target, 'models.json')
  if (fs.existsSync(aPath) && fs.existsSync(bPath)) {
    const a = parse(aPath) as Record<string, unknown>[], b = parse(bPath) as Record<string, unknown>[]
    for (const model of a) {
      const other = b.find(item => item.id === model.id)
      if (other && !isDeepStrictEqual(model.apiKey, other.apiKey)) return 'GLOBAL_MODEL_CREDENTIALS_DIFFER' // No values, IDs, or hashes escape.
    }
  }
  return 'GLOBAL_DUAL_ROOT_CONFLICT'
}
/** Source stays read-only. Receipt, not directory existence, is the cutover authority. */
export function runGlobalDataMigration(options: GlobalMigrationOptions): GlobalMigrationResult {
  try {
    if (!options.exclusiveAccess) fail('GLOBAL_EXCLUSIVE_ACCESS_REQUIRED')
    const roots = { legacySource: options.legacySource, canonicalTarget: options.canonicalTarget, userData: options.userData }
    assertRoots(roots)
    const target = path.resolve(options.canonicalTarget), legacy = path.resolve(options.legacySource)
    const control = path.join(target, '.migration'), generations = path.join(target, 'generations')
    safeRoot(control); safeRoot(generations)
    const receiptPath = path.join(control, 'receipt.json'), journalPath = path.join(control, 'journal.json')
    const checkpoint = options.checkpoint ?? (() => {})
    const ready = (receipt: Receipt): Ready => {
      const dataRoot = path.join(generations, receipt.generation)
      safeRoot(dataRoot)
      if (!fs.existsSync(dataRoot)) fail('GLOBAL_COMMITTED_GENERATION_MISSING')
      if (receipt.requiredObjects.some(name => !fs.existsSync(path.join(dataRoot, name)))) fail('GLOBAL_COMMITTED_OBJECT_MISSING')
      validate(dataRoot)
      const result: Ready = { state: 'ready', globalGeneration: receipt.generation, dataRoot,
        legacySourceIgnored: fs.existsSync(legacy), preservedUnknownCount: receipt.preservedUnknownCount }
      admitted.set(result, legacy); return result
    }
    if (fs.existsSync(receiptPath)) {
      const receipt = parse(receiptPath)
      if (!record(receipt) || receipt.version !== 1 || receipt.completed !== true || typeof receipt.generation !== 'string'
        || !/^[a-f0-9-]{36}$/.test(receipt.generation) || !Number.isSafeInteger(receipt.preservedUnknownCount) || Number(receipt.preservedUnknownCount) < 0
        || !Array.isArray(receipt.requiredObjects) || receipt.requiredObjects.some(name => !GLOBAL_OBJECTS.includes(name as typeof GLOBAL_OBJECTS[number]))) fail('GLOBAL_RECEIPT_INVALID')
      return ready(receipt as unknown as Receipt)
    }
    validate(legacy); validate(target)
    const legacyFiles = selectedFiles(legacy), targetFiles = selectedFiles(target)
    if (legacyFiles.length && targetFiles.length) fail(conflictCode(legacy, target))
    let journal: Journal
    if (fs.existsSync(journalPath)) {
      const value = parse(journalPath)
      if (!record(value) || value.version !== 1 || typeof value.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(value.generation)
        || !['prepared', 'verified'].includes(value.phase as string) || !['legacy', 'canonical', 'empty'].includes(value.source as string)) fail('GLOBAL_JOURNAL_INVALID')
      journal = value as unknown as Journal
    } else {
      // An unknown half-generation is preserved for explicit adjudication.
      if (fs.existsSync(generations) || fs.existsSync(control)) fail('GLOBAL_PARTIAL_TARGET_UNKNOWN')
      if (fs.existsSync(target) && fs.readdirSync(target).some(name => ![...GLOBAL_OBJECTS, ...GLOBAL_PRESERVED_OBJECTS].includes(name as typeof GLOBAL_OBJECTS[number]))) fail('GLOBAL_TARGET_UNKNOWN')
      journal = { version: 1, generation: randomUUID(), phase: 'prepared', source: legacyFiles.length ? 'legacy' : targetFiles.length ? 'canonical' : 'empty' }
      fs.mkdirSync(control, { recursive: true }); fs.mkdirSync(generations)
      durable(journalPath, journal); checkpoint('prepared')
    }
    const source = journal.source === 'legacy' ? legacy : target
    if ((journal.source === 'legacy' && targetFiles.length) || (journal.source === 'canonical' && legacyFiles.length)
      || (journal.source === 'empty' && (legacyFiles.length || targetFiles.length))) fail('GLOBAL_SOURCE_CHANGED')
    const staging = path.join(generations, `${journal.generation}.staging`), installed = path.join(generations, journal.generation)
    if (!fs.existsSync(installed)) {
      safeRoot(staging); fs.mkdirSync(staging, { recursive: true })
      files(staging) // Reject links planted in a retained interrupted staging before opening any file.
      if (fs.readdirSync(staging).some(name => !GLOBAL_OBJECTS.includes(name as typeof GLOBAL_OBJECTS[number]))) fail('GLOBAL_STAGING_UNKNOWN_OBJECT')
      const names = selectedFiles(source)
      if (journal.phase === 'verified' && !equalSelected(source, staging)) fail('GLOBAL_VERIFIED_SOURCE_CHANGED')
      // An interrupted write is retried only for this journal-owned staging.
      for (const name of journal.phase === 'prepared' ? names : []) {
        const destination = path.join(staging, name)
        safeRoot(path.dirname(destination))
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        // Never truncate a retained inode: it may have acquired another hard link.
        // Exclusive temp creation + rename also keeps partial writes unobservable.
        const temporary = `${destination}.${randomUUID()}.tmp`
        const bytes = fs.readFileSync(path.join(source, name)), fd = fs.openSync(temporary, 'wx', 0o600)
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(temporary, destination)
        syncDirectory(path.dirname(destination))
        checkpoint(`object:${name.replace(/\\/g, '/')}`)
      }
      if (!equalSelected(source, staging)) fail('GLOBAL_STAGING_MISMATCH')
      validate(staging)
      journal.phase = 'verified'; durable(journalPath, journal); checkpoint('verified')
      fs.renameSync(staging, installed); syncDirectory(generations); checkpoint('installed')
    } else if (journal.phase !== 'verified' || !equalSelected(source, installed)) fail('GLOBAL_INSTALLED_UNVERIFIED')
    const retainedCount = (root: string) => fs.existsSync(root) ? fs.readdirSync(root).filter(name => !GLOBAL_OBJECTS.includes(name as typeof GLOBAL_OBJECTS[number]) && !['.migration', 'generations'].includes(name)).length : 0
    const unknown = retainedCount(legacy) + retainedCount(target)
    const receipt: Receipt = { version: 1, generation: journal.generation, completed: true, preservedUnknownCount: unknown,
      requiredObjects: GLOBAL_OBJECTS.filter(name => fs.existsSync(path.join(installed, name))) }
    durable(receiptPath, receipt); checkpoint('receipt')
    return ready(receipt)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    return { state: 'blocked', code: /^GLOBAL_[A-Z_]+$/.test(message) ? message : 'GLOBAL_MIGRATION_IO_FAILED' }
  }
}
export function activateGlobalData(result: GlobalMigrationResult): void {
  if (result.state !== 'ready' || !admitted.has(result)) fail('GLOBAL_RESULT_NOT_VERIFIED')
  installGlobalDataLocator(result.dataRoot, result.globalGeneration, admitted.get(result)!)
}
