import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runGlobalDataMigration, activateGlobalData, GLOBAL_OBJECTS, type GlobalMigrationOptions } from '../global-data-migration'
import { resolveGlobalDataRoots } from '../app-data-locator'

const created: string[] = []
const retainedFailures = new Set<string>()
function fixture(): GlobalMigrationOptions {
  const cache = path.resolve('.runtime/.cache/novel-quality-modernization/s03-fixtures')
  fs.mkdirSync(cache, { recursive: true })
  const root = fs.mkdtempSync(path.join(cache, 'migration-')); created.push(root)
  return { legacySource: path.join(root, 'legacy'), canonicalTarget: path.join(root, 'canonical'), userData: path.join(root, 'userData'), exclusiveAccess: true }
}
function put(root: string, name: string, value: unknown) {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
function populate(root: string) {
  put(root, 'models.json', [{ id: 'model-a', name: 'Fixture', provider: 'openai', apiKey: 'fixture-only-secret', baseUrl: 'https://example.invalid', model: 'fixture' }])
  put(root, 'config.json', { defaultModelId: 'model-a', updatePreferences: { lastAutomaticCheckDate: '2026-09-13' } })
  put(root, 'recent-projects.json', [{ name: 'Synthetic', path: 'fixture-project' }])
  put(root, 'mcp_config.json', { mcpServers: { fixture: { command: 'never-launched', env: { TOKEN: 'fixture-mcp-secret' } } } })
  put(root, 'prompts/author.json', { key: 'author', content: '原文\r\nunchanged' })
  put(root, 'skills/author/SKILL.md', '# 原文\r\nKeep exact bytes')
  put(root, 'skins/manifest.json', { version: 1, activeSkin: 'anime' })
  put(root, 'logs/product.log', 'fixture log')
  put(root, 'metadata/product.json', { value: 'preserved' })
  put(root, 'update/receipt.json', { state: 'preserved' })
  put(root, 'shared-other-tool/do-not-import.txt', 'unrelated shared author data')
}
function snapshot(root: string): Record<string, string> {
  if (!fs.existsSync(root)) return {}
  const result: Record<string, string> = {}
  const walk = (directory: string) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(file)
    else result[path.relative(root, file)] = fs.readFileSync(file).toString('base64')
  } }
  walk(root); return result
}
afterEach(() => { vi.restoreAllMocks(); for (const root of created.splice(0)) if (!retainedFailures.has(root)) fs.rmSync(root, { recursive: true, force: true }) })

describe('single global generation cutover using synthetic roots only', () => {
  it('resolves distinct legacy/canonical environment roles without creating anything', () => {
    const roots = fixture()
    expect(resolveGlobalDataRoots(roots.userData, path.join(roots.userData, '..', 'appData'), { AI_NOVEL_VELA_HOME: roots.legacySource, AI_NOVEL_APP_DATA_HOME: roots.canonicalTarget })).toEqual({ legacySource: roots.legacySource, canonicalTarget: roots.canonicalTarget, userData: roots.userData })
    expect(fs.existsSync(roots.canonicalTarget)).toBe(false)
  })
  it('uses Electron appData for the production default and keeps userData unchanged', () => {
    const roots = fixture(), parent = path.dirname(roots.userData)
    const home = path.join(parent, 'home'), appData = path.join(parent, 'electron-app-data')
    expect(resolveGlobalDataRoots(roots.userData, appData, {}, home)).toEqual({
      legacySource: path.join(home, '.vela'), canonicalTarget: path.join(appData, 'ai-novel-writer'), userData: roots.userData,
    })
    expect(fs.existsSync(home)).toBe(false)
    expect(fs.existsSync(appData)).toBe(false)
    expect(() => resolveGlobalDataRoots(roots.userData, 'relative', {}, home)).toThrow('GLOBAL_APP_DATA_PATH_REQUIRED')
  })
  it('does not query the OS default when an explicit canonical root is configured', () => {
    const roots = fixture()
    const unavailableAppData = vi.fn(() => { throw new Error('Failed to get appData path') })
    expect(resolveGlobalDataRoots(roots.userData, unavailableAppData, {
      AI_NOVEL_LEGACY_SOURCE_HOME: roots.legacySource,
      AI_NOVEL_APP_DATA_HOME: roots.canonicalTarget,
    }).canonicalTarget).toBe(roots.canonicalTarget)
    expect(unavailableAppData).not.toHaveBeenCalled()
    expect(fs.existsSync(roots.canonicalTarget)).toBe(false)
    expect(() => resolveGlobalDataRoots(roots.userData, unavailableAppData, {})).toThrow('Failed to get appData path')
    expect(unavailableAppData).toHaveBeenCalledTimes(1)
  })
  it('queries Electron once and validates its lazy default without inventing a home fallback', () => {
    const roots = fixture(), appData = path.join(path.dirname(roots.userData), 'electron-app-data')
    const resolveAppData = vi.fn(() => appData)
    expect(resolveGlobalDataRoots(roots.userData, resolveAppData, {}).canonicalTarget).toBe(path.join(appData, 'ai-novel-writer'))
    expect(resolveAppData).toHaveBeenCalledTimes(1)
    expect(() => resolveGlobalDataRoots(roots.userData, () => 'relative', {})).toThrow('GLOBAL_APP_DATA_PATH_REQUIRED')
    expect(fs.existsSync(appData)).toBe(false)
  })
  it('refuses a default canonical root that overlaps Electron userData before creating files', () => {
    const roots = fixture(), appData = path.dirname(roots.userData)
    const userData = path.join(appData, 'ai-novel-writer')
    expect(runGlobalDataMigration({ ...resolveGlobalDataRoots(userData, appData, {}, path.join(appData, 'home')), exclusiveAccess: true })).toMatchObject({ state: 'blocked', code: 'GLOBAL_ROOT_INTERSECTION' })
    expect(fs.existsSync(userData)).toBe(false)
  })
  it('copies every global object byte-for-byte, retains unknown shared data and never touches userData', () => {
    const roots = fixture(); populate(roots.legacySource); put(roots.userData, 'sentinel', 'old renderer origin')
    const before = snapshot(roots.legacySource), userBefore = snapshot(roots.userData)
    const result = runGlobalDataMigration(roots)
    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw new Error('fixture migration failed')
    for (const name of GLOBAL_OBJECTS) expect(fs.existsSync(path.join(result.dataRoot, name))).toBe(true)
    expect(snapshot(roots.legacySource)).toEqual(before)
    expect(snapshot(roots.userData)).toEqual(userBefore)
    expect(fs.existsSync(path.join(result.dataRoot, 'shared-other-tool'))).toBe(false)
    expect(result.preservedUnknownCount).toBe(4)
    for (const name of ['logs', 'metadata', 'update']) expect(fs.existsSync(path.join(result.dataRoot, name))).toBe(false)
    const receipts = JSON.stringify(snapshot(path.join(roots.canonicalTarget, '.migration')))
    expect(receipts).not.toContain(Buffer.from('fixture-only-secret').toString('base64'))
    const receipt = fs.readFileSync(path.join(roots.canonicalTarget, '.migration/receipt.json'), 'utf8')
    expect(receipt).not.toMatch(/hash|apiKey|TOKEN|fixture-only-secret/)
  })
  it.each(['prepared', 'object:config.json', 'object:models.json', 'object:recent-projects.json', 'object:mcp_config.json', 'object:prompts/author.json', 'object:skills/author/SKILL.md', 'object:skins/manifest.json', 'verified', 'installed', 'receipt'])('recovers interruption after %s without changing source', step => {
    const roots = fixture(); populate(roots.legacySource); const before = snapshot(roots.legacySource)
    const interrupted = runGlobalDataMigration({ ...roots, checkpoint: current => { if (current === step) throw new Error('fixture interruption') } })
    expect(interrupted.state).toBe('blocked')
    const renameFailures: Array<{ code?: string; syscall?: string; source: string; target: string }> = []
    const originalRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      try { originalRename(source, target) } catch (error) {
        const failure = error as NodeJS.ErrnoException
        renameFailures.push({ code: failure.code, syscall: failure.syscall, source: path.basename(String(source)), target: path.basename(String(target)) })
        throw error
      }
    })
    const recovered = runGlobalDataMigration(roots)
    if (recovered.state !== 'ready') {
      const root = path.dirname(roots.legacySource)
      retainedFailures.add(root)
      fs.writeFileSync(path.join(root, 'failure-debug.json'), JSON.stringify({ checkpoint: step, recovered, renameFailures,
        sourceUnchanged: isDeepStrictEqual(snapshot(roots.legacySource), before), targetFiles: Object.keys(snapshot(roots.canonicalTarget)) }, null, 2))
    }
    expect(recovered).toMatchObject({ state: 'ready' })
    expect(snapshot(roots.legacySource)).toEqual(before)
  })
  it('accepts canonical-only data and empty installations with a receipt, not directory inference', () => {
    for (const mode of ['canonical', 'empty']) {
      const roots = fixture(); if (mode === 'canonical') populate(roots.canonicalTarget)
      // Unknown canonical objects require explicit adjudication even when known config is valid.
      if (mode === 'canonical') fs.rmSync(path.join(roots.canonicalTarget, 'shared-other-tool'), { recursive: true })
      const result = runGlobalDataMigration(roots); expect(result.state).toBe('ready')
    }
  })
  it.each(['config.json', 'models.json', 'mcp_config.json', 'recent-projects.json', 'prompts/author.json', 'skins/manifest.json'])('blocks corrupt %s before creating target', name => {
    const roots = fixture(); populate(roots.legacySource); put(roots.legacySource, name, '{broken')
    expect(runGlobalDataMigration(roots).state).toBe('blocked')
    expect(fs.existsSync(roots.canonicalTarget)).toBe(false)
    expect(fs.readFileSync(path.join(roots.legacySource, name), 'utf8')).toBe('{broken')
  })
  it('blocks missing default model references and duplicate IDs', () => {
    for (const mode of ['reference', 'duplicate']) {
      const roots = fixture(); populate(roots.legacySource)
      put(roots.legacySource, mode === 'reference' ? 'config.json' : 'models.json', mode === 'reference' ? { defaultModelId: 'missing' } : [{ id: 'model-a' }, { id: 'model-a' }])
      expect(runGlobalDataMigration(roots).state).toBe('blocked')
      expect(fs.existsSync(roots.canonicalTarget)).toBe(false)
    }
  })
  it('blocks same-ID differing credentials with no credential, ID, or digest in result', () => {
    const roots = fixture(); populate(roots.legacySource); populate(roots.canonicalTarget)
    put(roots.canonicalTarget, 'models.json', [{ id: 'model-a', apiKey: 'other-fixture-secret' }])
    const before = snapshot(roots.canonicalTarget)
    expect(runGlobalDataMigration(roots)).toEqual({ state: 'blocked', code: 'GLOBAL_MODEL_CREDENTIALS_DIFFER' })
    expect(snapshot(roots.canonicalTarget)).toEqual(before)
  })
  it('ignores later corrupt legacy changes after receipt and uses current canonical config', () => {
    const roots = fixture(); populate(roots.legacySource); const result = runGlobalDataMigration(roots)
    if (result.state !== 'ready') throw new Error('fixture migration failed')
    put(roots.legacySource, 'config.json', '{later corruption')
    put(result.dataRoot, 'config.json', { defaultModelId: null, authorNewPreference: true })
    const reopened = runGlobalDataMigration(roots)
    expect(reopened).toMatchObject({ state: 'ready', globalGeneration: result.globalGeneration, legacySourceIgnored: true })
    expect(JSON.parse(fs.readFileSync(path.join(result.dataRoot, 'config.json'), 'utf8')).authorNewPreference).toBe(true)
  })
  it('blocks a missing committed object and a changed verified source instead of writing defaults', () => {
    const roots = fixture(); populate(roots.legacySource)
    runGlobalDataMigration({ ...roots, checkpoint: step => { if (step === 'verified') throw new Error('fixture interruption') } })
    put(roots.legacySource, 'config.json', { defaultModelId: null })
    expect(runGlobalDataMigration(roots)).toMatchObject({ code: 'GLOBAL_VERIFIED_SOURCE_CHANGED' })
    const second = fixture(); populate(second.legacySource); const result = runGlobalDataMigration(second)
    if (result.state !== 'ready') throw new Error('fixture migration failed')
    fs.unlinkSync(path.join(result.dataRoot, 'models.json'))
    expect(runGlobalDataMigration(second)).toMatchObject({ code: 'GLOBAL_COMMITTED_OBJECT_MISSING' })
  })
  it('never writes outside the explicitly supplied synthetic roots', () => {
    const roots = fixture(); populate(roots.legacySource); put(roots.userData, 'sentinel', 'unchanged')
    const observed: string[] = [], originalOpen = fs.openSync, originalMkdir = fs.mkdirSync
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (typeof flags === 'string' && /[wa+]/.test(flags)) observed.push(String(file))
      return originalOpen(file, flags, mode)
    }) as typeof fs.openSync)
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      observed.push(String(directory)); return originalMkdir(directory, options)
    }) as typeof fs.mkdirSync)
    expect(runGlobalDataMigration(roots).state).toBe('ready')
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every(file => file.startsWith(roots.canonicalTarget + path.sep) || file === roots.canonicalTarget)).toBe(true)
    expect(fs.readFileSync(path.join(roots.userData, 'sentinel'), 'utf8')).toBe('unchanged')
  })
  it('blocks unknown partial generations, root intersection and missing exclusion proof', () => {
    const roots = fixture(); fs.mkdirSync(path.join(roots.canonicalTarget, 'generations'), { recursive: true })
    expect(runGlobalDataMigration(roots)).toMatchObject({ code: 'GLOBAL_PARTIAL_TARGET_UNKNOWN' })
    expect(runGlobalDataMigration({ ...roots, canonicalTarget: roots.legacySource })).toMatchObject({ code: 'GLOBAL_ROOT_INTERSECTION' })
    expect(runGlobalDataMigration({ ...roots, exclusiveAccess: false })).toMatchObject({ code: 'GLOBAL_EXCLUSIVE_ACCESS_REQUIRED' })
  })
  it('does not install unknown content planted in a journal-owned staging', () => {
    const roots = fixture(); populate(roots.legacySource)
    runGlobalDataMigration({ ...roots, checkpoint: step => { if (step === 'object:config.json') throw new Error('fixture interruption') } })
    const journal = JSON.parse(fs.readFileSync(path.join(roots.canonicalTarget, '.migration/journal.json'), 'utf8'))
    put(path.join(roots.canonicalTarget, 'generations', `${journal.generation}.staging`), 'unrecognized.txt', 'preserve for adjudication')
    expect(runGlobalDataMigration(roots)).toMatchObject({ code: 'GLOBAL_STAGING_UNKNOWN_OBJECT' })
    expect(fs.existsSync(path.join(roots.canonicalTarget, '.migration/receipt.json'))).toBe(false)
  })
  it('rejects a retained staging hardlink without changing source or userData', () => {
    const roots = fixture(); populate(roots.legacySource); put(roots.userData, 'sentinel.json', { authorSetting: 'untouched' })
    const beforeSource = snapshot(roots.legacySource), beforeUser = snapshot(roots.userData)
    runGlobalDataMigration({ ...roots, checkpoint: step => { if (step === 'object:config.json') throw new Error('fixture interruption') } })
    const journal = JSON.parse(fs.readFileSync(path.join(roots.canonicalTarget, '.migration/journal.json'), 'utf8'))
    const destination = path.join(roots.canonicalTarget, 'generations', `${journal.generation}.staging`, 'config.json')
    fs.unlinkSync(destination)
    fs.linkSync(path.join(roots.userData, 'sentinel.json'), destination)
    expect(fs.lstatSync(destination).nlink).toBe(2)
    expect(runGlobalDataMigration(roots)).toMatchObject({ code: 'GLOBAL_ASSET_HARDLINK' })
    expect(snapshot(roots.legacySource)).toEqual(beforeSource)
    expect(snapshot(roots.userData)).toEqual(beforeUser)
    expect(fs.existsSync(path.join(roots.canonicalTarget, '.migration/receipt.json'))).toBe(false)
  })
  it('rejects a hardlinked completed receipt without reusing it or changing either link', () => {
    const roots = fixture(); populate(roots.legacySource)
    expect(runGlobalDataMigration(roots).state).toBe('ready')
    fs.mkdirSync(roots.userData)
    const receipt = path.join(roots.canonicalTarget, '.migration/receipt.json')
    fs.linkSync(receipt, path.join(roots.userData, 'receipt-copy.json'))
    const before = snapshot(roots.userData)
    expect(runGlobalDataMigration(roots)).toMatchObject({ code: 'GLOBAL_JSON_INVALID' })
    expect(snapshot(roots.userData)).toEqual(before)
  })
  it('atomic staging replacement cannot truncate a hardlink inserted after inspection', () => {
    const roots = fixture(); populate(roots.legacySource); put(roots.userData, 'sentinel.json', { authorSetting: 'untouched' })
    const beforeSource = snapshot(roots.legacySource), beforeUser = snapshot(roots.userData)
    const originalOpen = fs.openSync
    let inserted = false
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      const location = String(file)
      if (!inserted && flags === 'wx' && location.includes('.staging') && path.basename(location).startsWith('config.json.')) {
        inserted = true
        fs.linkSync(path.join(roots.userData, 'sentinel.json'), path.join(path.dirname(location), 'config.json'))
      }
      return originalOpen(file, flags, mode)
    }) as typeof fs.openSync)
    expect(runGlobalDataMigration(roots).state).toBe('ready')
    expect(inserted).toBe(true)
    expect(snapshot(roots.legacySource)).toEqual(beforeSource)
    expect(snapshot(roots.userData)).toEqual(beforeUser)
  })
  it('rejects linked required assets without traversing or modifying their contents', () => {
    const roots = fixture(); populate(roots.legacySource)
    const outside = path.join(path.dirname(roots.legacySource), 'outside'); put(outside, 'sentinel', 'untouched')
    fs.symlinkSync(outside, path.join(roots.legacySource, 'skills/link'), 'junction')
    expect(runGlobalDataMigration(roots)).toMatchObject({ code: 'GLOBAL_ASSET_LINK' })
    expect(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8')).toBe('untouched')
  })
  it('does not accept a forged ready result for locator activation', () => {
    expect(() => activateGlobalData({ state: 'ready', globalGeneration: 'fake', dataRoot: 'fake', legacySourceIgnored: false, preservedUnknownCount: 0 })).toThrow('GLOBAL_RESULT_NOT_VERIFIED')
  })
  it('activates only the admitted generation and does not reopen legacy writes', async () => {
    const roots = fixture(); populate(roots.legacySource)
    const result = runGlobalDataMigration(roots); activateGlobalData(result)
    const locator = await import('../app-data-locator')
    expect(locator.VELA_HOME).toBe(result.state === 'ready' ? result.dataRoot : '')
    expect(locator.GLOBAL_CONFIG_PATH).toBe(path.join(locator.VELA_HOME, 'config.json'))
    expect(() => locator.assertGlobalPathAccess(path.join(roots.legacySource, 'config.json'))).toThrow('LEGACY_GLOBAL_SOURCE_READ_ONLY')
  })
})
