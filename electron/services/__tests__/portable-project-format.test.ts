import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlueprintRepository } from '../../repositories/blueprint-repository'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  PORTABLE_FIELD_POLICY_COUNTS,
  assertPortableSourceSchema,
  getPortableFieldPolicy,
  listPortableFieldPolicyKeys,
  parsePortableProjectManifest,
} from '../portable-project-format'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []

function fixture(): { root: string; databasePath: string } {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/b01-portable-format')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, '项目-'))
  roots.push(root)
  const dataRoot = path.join(root, '.ai-novel')
  fs.mkdirSync(dataRoot)
  fs.writeFileSync(path.join(dataRoot, 'project.json'), JSON.stringify(createCanonicalProjectManifest({
    projectId: randomUUID(), createdAt: new Date().toISOString(),
  })))
  createProjectDatabase(root, Buffer.alloc(32, 1))
  return { root, databasePath: path.join(dataRoot, 'project.db') }
}

function openCurrent(): { databasePath: string; database: import('better-sqlite3').Database } {
  const project = fixture()
  initProjectDatabase(project.root)
  BlueprintRepository.listPendingCharacterSyncOperations()
  const database = getProjectDb()!
  return { databasePath: project.databasePath, database }
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const byteSize = 512 * 1024 * 1024
  return {
    formatVersion: 1,
    sourceSchemaVersion: 6,
    originProjectId: 'origin-project',
    snapshotGeneration: 'generation-0001',
    createdAt: '2026-09-20T00:00:00.000Z',
    declaredUncompressedBytes: byteSize,
    declaredCompressedBytes: 16 * 1024 * 1024,
    entries: [{ path: '正文/第一章-铜钥匙.txt', byteSize, sha256: 'a'.repeat(64), disposition: 'author-content' }],
    semanticCounts: { chapters: 120_000, characters: 800 },
    omittedItems: [{ id: 'vectors', reason: 'rebuild-stale' }],
    transferReceiptIds: ['transfer-1'],
    historyProjectionIds: ['history-1'],
    ...overrides,
  }
}

afterEach(() => {
  closeProjectDatabase()
  vi.doUnmock('../portable-project-field-policy.json')
  vi.resetModules()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('portable v6 field policy', () => {
  it('与实际当前registry双向精确匹配50表479字段，并包含两个lazy表', () => {
    const { database } = openCurrent()
    expect(database.pragma('user_version', { simple: true })).toBe(6)
    expect(() => assertPortableSourceSchema(database)).not.toThrow()
    const tables = database.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    const fieldCount = tables.reduce((count, table) => count
      + (database.prepare(`PRAGMA table_info("${table.name}")`).all() as unknown[]).length, 0)
    expect({ tables: tables.length, fields: fieldCount }).toEqual({ tables: 50, fields: 479 })
    expect(PORTABLE_FIELD_POLICY_COUNTS).toEqual({ tables: 50, fields: 479 })
    expect(listPortableFieldPolicyKeys()).toContain('blueprint_commit_operations.operation_id')
    expect(listPortableFieldPolicyKeys()).toContain('blueprint_character_sync_operations.operation_id')
  })

  it('把签署S01基线35表356字段逐项投影，并精确增加M01-M05的15表/123字段', () => {
    const signed = JSON.parse(fs.readFileSync(path.resolve(
      'docs/research/novel-quality-modernization/s01-storage-contract.json'), 'utf8')) as {
      fieldDispositions: Array<{ table: string; field: string; portableDisposition: string }>
    }
    const normalize = (value: string) => value === 'exclude-machine-authority' ? 'exclude-machine-authority'
      : value === 'allowlist-rebuild-or-block' || value === 'safe-diagnostic-projection' ? 'redacted-projection'
        : value === 'historical-read-only-projection' || value === 'non-executable-history' ? 'historical-nonreplayable'
          : value === 'rebuildable-metric-version' ? 'rebuild-stale'
            : value === 'validate-relative-projection' ? 'validated-relative' : 'preserve-domain'
    expect(new Set(signed.fieldDispositions.map(field => field.table)).size).toBe(35)
    expect(signed.fieldDispositions).toHaveLength(356)
    for (const field of signed.fieldDispositions) {
      expect(getPortableFieldPolicy(field.table, field.field)).toMatchObject({
        disposition: normalize(field.portableDisposition),
        origin: 'signed-s01',
        signedDisposition: field.portableDisposition,
      })
    }
    const baseline = new Set(signed.fieldDispositions.map(field => `${field.table}.${field.field}`))
    const baselineTables = new Set(signed.fieldDispositions.map(field => field.table))
    const delta = listPortableFieldPolicyKeys().filter(key => !baseline.has(key))
    expect(delta).toHaveLength(123)
    expect(delta.every(key => getPortableFieldPolicy(...key.split('.') as [string, string]).origin === 'm01-m05-delta')).toBe(true)
    expect(new Set(delta.map(key => key.split('.')[0]).filter(table => !baselineTables.has(table!))).size).toBe(15)
    expect(delta.filter(key => key.startsWith('characters.')).sort()).toEqual([
      'characters.character_id', 'characters.identity_revision', 'characters.legacy_key',
      'characters.retired', 'characters.static_provenance',
    ])
  })

  it('机器权限、执行历史、未知nested与M05头像采用不同的fail-closed处置', () => {
    expect(getPortableFieldPolicy('import_runs', 'execution_owner').disposition).toBe('exclude-machine-authority')
    expect(getPortableFieldPolicy('import_legacy_identity_bridge', 'ciphertext_hex').disposition).toBe('exclude-machine-authority')
    expect(getPortableFieldPolicy('generation_runs', 'status').disposition).toBe('historical-nonreplayable')
    expect(getPortableFieldPolicy('review_cycles', 'revision_status').disposition).toBe('historical-nonreplayable')
    expect(getPortableFieldPolicy('import_effect_ledger', 'state').disposition).toBe('historical-nonreplayable')
    expect(getPortableFieldPolicy('generation_attempts', 'attempt_json').disposition).toBe('redacted-projection')
    expect(getPortableFieldPolicy('character_avatar_assets', 'relative_path').disposition).toBe('avatar-asset')
    expect(getPortableFieldPolicy('character_avatar_unresolved', 'disposition')).toMatchObject({
      disposition: 'avatar-asset', validator: 'character-asset-or-reference-only',
    })
    expect(getPortableFieldPolicy('contents', 'body').disposition).toBe('preserve-domain')
    expect(() => getPortableFieldPolicy('future_table', 'opaque_json')).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
  })

  it.each(['extra-table', 'extra-field', 'higher-version', 'lower-version'] as const)(
    '%s在只读门拒绝且不再改源DB', mode => {
      const project = fixture()
      const mutate = new Database(project.databasePath)
      try {
        if (mode === 'extra-table') mutate.exec('CREATE TABLE future_portable_data(id TEXT)')
        if (mode === 'extra-field') mutate.exec('ALTER TABLE contents ADD COLUMN future_payload TEXT')
        if (mode === 'higher-version') mutate.pragma('user_version = 7')
        if (mode === 'lower-version') mutate.pragma('user_version = 5')
      } finally { mutate.close() }
      const before = fs.readFileSync(project.databasePath)
      const database = new Database(project.databasePath)
      try { expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED') }
      finally { database.close() }
      expect(fs.readFileSync(project.databasePath)).toEqual(before)
    },
  )

  it('同表同字段但删除index的v6 DDL fork被registry fingerprint拒绝', () => {
    const project = fixture()
    const mutate = new Database(project.databasePath)
    try { mutate.exec('DROP INDEX idx_character_avatar_revision') } finally { mutate.close() }
    const before = fs.readFileSync(project.databasePath)
    const database = new Database(project.databasePath)
    try {
      database.pragma('foreign_keys = ON')
      const tables = database.prepare("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
      const fields = tables.reduce((count, table) => count
        + (database.prepare(`PRAGMA table_info("${table.name}")`).all() as unknown[]).length, 0)
      expect({ tables: tables.length, fields }).toEqual({ tables: 50, fields: 479 })
      expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    } finally { database.close() }
    expect(fs.readFileSync(project.databasePath)).toEqual(before)
  })

  it('recognized DDL含外键破坏时仍由integrity/foreign-key gate拒绝', () => {
    const project = fixture()
    const mutate = new Database(project.databasePath)
    try {
      mutate.pragma('foreign_keys = OFF')
      mutate.prepare(`INSERT INTO character_avatar_assets(
        character_id,asset_revision,relative_path,content_hash,mime,byte_size,source_reference
      ) VALUES(?,?,?,?,?,?,?)`).run('missing-character', 1, 'avatars/missing.png', 'a'.repeat(64), 'image/png', 1, '')
    } finally { mutate.close() }
    const before = fs.readFileSync(project.databasePath)
    const database = new Database(project.databasePath)
    try { expect(() => assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED') }
    finally { database.close() }
    expect(fs.readFileSync(project.databasePath)).toEqual(before)
  })

  it('删掉一个签署policy字段后拒绝实际v6且源DB不变', async () => {
    const project = fixture()
    const document = JSON.parse(fs.readFileSync(path.resolve(
      'electron/services/portable-project-field-policy.json'), 'utf8')) as {
      tables: Record<string, Record<string, string>>
    }
    delete document.tables.contents!.body
    vi.resetModules()
    vi.doMock('../portable-project-field-policy.json', () => ({ default: document }))
    const isolated = await import('../portable-project-format')
    const before = fs.readFileSync(project.databasePath)
    const database = new Database(project.databasePath)
    try { expect(() => isolated.assertPortableSourceSchema(database)).toThrow('PORTABLE_SCHEMA_UNSUPPORTED') }
    finally { database.close() }
    expect(fs.readFileSync(project.databasePath)).toEqual(before)
  })
})

describe('portable manifest v1', () => {
  it('接受有界的大型中文项目声明与引用标识', () => {
    const parsed = parsePortableProjectManifest(manifest())
    expect(parsed.entries[0]).toMatchObject({ path: '正文/第一章-铜钥匙.txt', disposition: 'author-content' })
    expect(parsed.transferReceiptIds).toEqual(['transfer-1'])
    expect(parsed.historyProjectionIds).toEqual(['history-1'])
  })

  it.each([
    '/absolute.txt', 'C:/machine.txt', '目录\\file.txt', '目录/../file.txt', '目录/./file.txt',
    '目录/con.txt', '目录/name.', '目录/name ', `目录/a\0b`, '目录／..／file.txt',
  ])('拒绝恶意或跨平台不安全路径 %s', unsafe => {
    expect(() => parsePortableProjectManifest(manifest({
      entries: [{ path: unsafe, byteSize: 1, sha256: 'a'.repeat(64), disposition: 'author-content' }],
      declaredUncompressedBytes: 1,
      declaredCompressedBytes: 1,
    }))).toThrow('PORTABLE_PATH_UNSAFE')
  })

  it('normalize前拒绝孤立或配对surrogate，避免与replacement character碰撞', () => {
    const entry = (path: string) => ({ path, byteSize: 1, sha256: 'a'.repeat(64), disposition: 'author-content' })
    expect(() => parsePortableProjectManifest(manifest({
      entries: [entry('assets/\uD800.txt'), entry('assets/\uFFFD.txt')],
      declaredUncompressedBytes: 2,
      declaredCompressedBytes: 1,
    }))).toThrow('PORTABLE_PATH_UNSAFE')
    expect(() => parsePortableProjectManifest(manifest({
      entries: [entry('assets/😀.txt')],
      declaredUncompressedBytes: 1,
      declaredCompressedBytes: 1,
    }))).toThrow('PORTABLE_PATH_UNSAFE')
    expect(parsePortableProjectManifest(manifest({
      entries: [entry('assets/\uFFFD.txt')],
      declaredUncompressedBytes: 1,
      declaredCompressedBytes: 1,
    })).entries[0]!.path).toBe('assets/\uFFFD.txt')
  })

  it.each([
    ['大小写折叠重复', ['Assets/头像.png', 'assets/头像.png']],
    ['Unicode折叠重复', ['正文/Café.txt', '正文/Café.txt']],
    ['文件目录冲突', ['assets', 'assets/avatar.png']],
  ])('拒绝%s', (_label, paths) => {
    expect(() => parsePortableProjectManifest(manifest({
      entries: (paths as string[]).map(item => ({ path: item, byteSize: 1, sha256: 'a'.repeat(64), disposition: 'author-content' })),
      declaredUncompressedBytes: 2,
      declaredCompressedBytes: 1,
    }))).toThrow('PORTABLE_PATH_CONFLICT')
  })

  it('拒绝未知格式、非法hash、非安全整数和声明总量不符', () => {
    expect(() => parsePortableProjectManifest(manifest({ sourceSchemaVersion: 7 }))).toThrow('PORTABLE_SCHEMA_UNSUPPORTED')
    expect(() => parsePortableProjectManifest(manifest({ entries: [{
      path: '正文/a.txt', byteSize: 1, sha256: 'A'.repeat(64), disposition: 'author-content',
    }], declaredUncompressedBytes: 1, declaredCompressedBytes: 1 }))).toThrow('PORTABLE_MANIFEST_INVALID')
    expect(() => parsePortableProjectManifest(manifest({ declaredUncompressedBytes: Number.MAX_VALUE })))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest({ declaredUncompressedBytes: 1 })))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
  })

  it('显式limits约束数量、单项、总量、压缩声明和压缩比', () => {
    const twoEntries = {
      entries: [
        { path: 'a.txt', byteSize: 1, sha256: 'a'.repeat(64), disposition: 'author-content' },
        { path: 'b.txt', byteSize: 1, sha256: 'b'.repeat(64), disposition: 'author-content' },
      ],
      declaredUncompressedBytes: 2,
      declaredCompressedBytes: 1,
    }
    expect(() => parsePortableProjectManifest(manifest(twoEntries), { maxEntries: 1 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest(), { maxEntryBytes: 1024 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest(), { maxTotalBytes: 1024 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest(), { maxDeclaredCompressedBytes: 1024 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(() => parsePortableProjectManifest(manifest({ declaredCompressedBytes: 1 }), { maxCompressionRatio: 2 }))
      .toThrow('PORTABLE_ARCHIVE_LIMIT_EXCEEDED')
    expect(DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxTotalBytes).toBeGreaterThan(8 * 1024 ** 3)
  })
})
