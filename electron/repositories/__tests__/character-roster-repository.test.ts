import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { CharacterRosterRepository } from '../character-roster-repository'
import { ensureCharacterRosterSchema } from '../character-roster-schema'
import { CharacterRepository } from '../character-repository'
import { ProjectCoreRepository } from '../project-core-repository'
import type { CharacterRosterCommitRequest } from '../../../src/shared/character-roster'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database

function commitRequest(
  overrides: Partial<CharacterRosterCommitRequest> = {},
): CharacterRosterCommitRequest {
  return {
    operationId: 'architecture-run-001',
    expectedRevision: 0,
    schemaVersion: 1,
    entries: [
      {
        name: '林舟',
        role: 'protagonist',
        gender: '男',
        age: '十八岁',
        appearance: '灰袍少年',
        personality: '克制',
        background: '铁砧镇学徒',
        abilities: '锻造',
        motivation: '守住家人',
        relationships: [{ target: '苏绾', relation: '师徒' }],
        arc: '从学徒成长为守护者',
        notes: '左手有旧伤',
      },
      {
        name: '苏绾',
        role: 'supporting',
        gender: '女',
        age: '二十六岁',
        appearance: '青衣剑客',
        personality: '冷静',
        background: '游侠',
        abilities: '剑术',
        motivation: '偿还旧债',
        relationships: [{ target: '林舟', relation: '师徒' }],
        arc: '学会托付',
        notes: '',
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE project_core (
      id TEXT PRIMARY KEY,
      characters_arch TEXT DEFAULT ''
    );
    INSERT INTO project_core (id, characters_arch) VALUES ('main', '');
    CREATE TABLE characters (
      name TEXT PRIMARY KEY,
      role TEXT DEFAULT 'supporting',
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      appearance TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      background TEXT DEFAULT '',
      abilities TEXT DEFAULT '',
      motivation TEXT DEFAULT '',
      relationships TEXT DEFAULT '',
      arc TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      cs_location TEXT DEFAULT '',
      cs_power_level TEXT DEFAULT '',
      cs_physical_state TEXT DEFAULT '',
      cs_mental_state TEXT DEFAULT '',
      cs_key_items TEXT DEFAULT '',
      cs_recent_events TEXT DEFAULT '',
      cs_updated_at_chapter INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE blueprints (
      chapter_number INTEGER PRIMARY KEY,
      characters TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
  ensureCharacterRosterSchema(db)
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => {
  db.close()
})

function rawRosterStorage() {
  return {
    core: db.prepare("SELECT characters_arch FROM project_core WHERE id = 'main'").get(),
    cards: db.prepare('SELECT * FROM characters ORDER BY name').all(),
    meta: db.prepare(`
      SELECT schema_version, revision, migration_state, legacy_markdown, projection_hash, fact_hash, updated_at
      FROM character_roster_meta
      WHERE id = 'main'
    `).get(),
    operations: db.prepare(`
      SELECT operation_id, payload_hash, committed_revision, projection_hash, created_at
      FROM character_roster_operations
      ORDER BY operation_id
    `).all(),
  }
}

describe('CharacterRosterRepository public read/commit seam', () => {
  it('normalizes a finite numeric model age without widening other roster fields', () => {
    const base = commitRequest()
    const numericAge = {
      ...base,
      entries: base.entries.map((entry) => (
        entry.name === '林舟' ? { ...entry, age: 18 } : entry
      )),
    } as unknown as CharacterRosterCommitRequest

    const receipt = CharacterRosterRepository.commit(numericAge)
    expect(receipt.snapshot.entries.find((entry) => entry.name === '林舟')?.age).toBe('18')

    for (const invalidAge of [Number.NaN, Number.POSITIVE_INFINITY, true, null]) {
      expect(() => CharacterRosterRepository.commit({
        ...commitRequest({ operationId: `invalid-age-${String(invalidAge)}` }),
        entries: [{ ...base.entries[0], age: invalidAge }, base.entries[1]],
      } as unknown as CharacterRosterCommitRequest)).toThrow(/年龄必须是文本/)
    }
    expect(() => CharacterRosterRepository.commit({
      ...commitRequest({ operationId: 'invalid-name-number' }),
      entries: [{ ...base.entries[0], name: 7 }, base.entries[1]],
    } as unknown as CharacterRosterCommitRequest)).toThrow(/角色名必须是文本/)
  })

  it('renders the canonical shared minor-role label in the deterministic roster projection', () => {
    const receipt = CharacterRosterRepository.commit(commitRequest({
      entries: commitRequest().entries.map(entry => (
        entry.name === '苏绾' ? { ...entry, role: 'minor' as const } : entry
      )),
    }))

    expect(receipt.snapshot.renderedMarkdown).toContain('## 龙套：苏绾')
    expect(receipt.snapshot.renderedMarkdown).not.toContain('## 次要角色：苏绾')
  })

  it('uses one manual-edit receipt to rename, delete, preserve free-text relations, update blueprint references, and allow an empty roster', () => {
    const initial = CharacterRosterRepository.commit(commitRequest({
      intent: 'manual_edit',
      entries: commitRequest().entries.map(entry => (
        entry.name === '林舟'
          ? {
              ...entry,
              relationships: [],
              legacyRelationshipNotes: '作者手写的自由关系备注，不能被结构化保存吞掉',
            }
          : entry
      )),
    }))
    db.prepare('INSERT INTO blueprints (chapter_number, characters) VALUES (?, ?)')
      .run(1, JSON.stringify(['林舟', '苏绾']))

    const renamedAndTrimmed = CharacterRosterRepository.commit({
      operationId: 'manual-edit-rename-delete',
      expectedRevision: initial.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      renames: [{ originalName: '林舟', newName: '陆舟' }],
      entries: [{
        ...initial.snapshot.entries.find(entry => entry.name === '林舟')!,
        name: '陆舟',
        // This candidate still names the deleted card. The deep module must
        // remove that structural edge together with the omitted card.
        relationships: [{ target: '苏绾', relation: '旧师徒' }],
        currentState: {
          location: '北境',
          powerLevel: '炼气',
          physicalState: '轻伤',
          mentalState: '警觉',
          keyItems: '旧剑',
          recentEvents: '发现线索',
          updatedAtChapter: 3,
        },
      }],
    })

    expect(renamedAndTrimmed).toMatchObject({
      revision: 2,
      snapshot: {
        status: 'ready',
        entries: [expect.objectContaining({
          name: '陆舟',
          relationships: [],
          legacyRelationshipNotes: '作者手写的自由关系备注，不能被结构化保存吞掉',
          currentState: expect.objectContaining({ updatedAtChapter: 3 }),
        })],
      },
    })
    expect(renamedAndTrimmed.snapshot.factHash).not.toBe(initial.snapshot.factHash)
    expect(db.prepare('SELECT characters FROM blueprints WHERE chapter_number = 1').get())
      .toEqual({ characters: JSON.stringify(['陆舟']) })

    const empty = CharacterRosterRepository.commit({
      operationId: 'manual-edit-delete-last',
      expectedRevision: renamedAndTrimmed.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: [],
    })
    expect(empty.snapshot).toMatchObject({
      revision: 3,
      status: 'empty',
      entries: [],
      renderedMarkdown: '',
    })
  })

  it('fails closed when a legacy direct card write makes the ready roster inconsistent', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const existing = CharacterRepository.getByName('林舟')!
    CharacterRepository.upsert({ ...existing, notes: '旧旁路直接改写了角色事实' })

    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: first.revision,
      status: 'inconsistent',
    })
    expect(() => CharacterRosterRepository.commit(commitRequest({
      operationId: 'architecture-must-not-bypass-inconsistent-roster',
      expectedRevision: first.revision,
      intent: 'architecture_generation',
    }))).toThrow(/状态不一致/)
    expect(CharacterRepository.getByName('林舟')?.notes).toBe('旧旁路直接改写了角色事实')
  })

  it('rejects free-text relationship evidence outside a manual edit', () => {
    expect(() => CharacterRosterRepository.commit(commitRequest({
      intent: 'novel_import',
      entries: commitRequest().entries.map(entry => ({
        ...entry,
        legacyRelationshipNotes: '导入候选不得携带旧自由文本关系',
      })),
    }))).toThrow(/只有手工角色管理可以提交自由文本关系/)
  })

  it('commits a validated roster and its deterministic projection as one ready snapshot', () => {
    const receipt = CharacterRosterRepository.commit(commitRequest())

    expect(receipt).toMatchObject({
      idempotent: false,
      operationId: 'architecture-run-001',
      revision: 1,
      snapshot: {
        schemaVersion: 1,
        revision: 1,
        migrationState: 'ready',
        entries: [
          expect.objectContaining({
            name: '林舟',
            relationships: [{ target: '苏绾', relation: '师徒' }],
          }),
          expect.objectContaining({
            name: '苏绾',
            relationships: [{ target: '林舟', relation: '师徒' }],
          }),
        ],
        renderedMarkdown: [
          '# 角色图谱',
          '',
          '## 主角：林舟',
          '- 性别：男',
          '- 年龄：十八岁',
          '- 外貌：灰袍少年',
          '- 性格：克制',
          '- 背景：铁砧镇学徒',
          '- 能力：锻造',
          '- 动机：守住家人',
          '- 弧光：从学徒成长为守护者',
          '- 备注：左手有旧伤',
          '- 关系：苏绾（师徒）',
          '',
          '## 配角：苏绾',
          '- 性别：女',
          '- 年龄：二十六岁',
          '- 外貌：青衣剑客',
          '- 性格：冷静',
          '- 背景：游侠',
          '- 能力：剑术',
          '- 动机：偿还旧债',
          '- 弧光：学会托付',
          '- 关系：林舟（师徒）',
        ].join('\n'),
      },
    })

    expect(CharacterRosterRepository.read()).toEqual(receipt.snapshot)
  })

  it('returns the original receipt for an idempotent operation replay without writing a second revision', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const replay = CharacterRosterRepository.commit(commitRequest())

    expect(replay).toMatchObject({
      operationId: first.operationId,
      payloadHash: first.payloadHash,
      revision: 1,
      idempotent: true,
    })
    expect(CharacterRosterRepository.read().revision).toBe(1)
  })

  it('returns a current consistent idempotent observation when replaying an older operation after a later commit', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const second = CharacterRosterRepository.commit({
      operationId: 'manual-edit-after-first-operation',
      expectedRevision: first.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: first.snapshot.entries.map(entry => (
        entry.name === '林舟'
          ? { ...entry, notes: 'B 已成为当前角色事实' }
          : entry
      )),
    })
    const operationCountBeforeReplay = (db.prepare(
      'SELECT COUNT(*) AS count FROM character_roster_operations',
    ).get() as { count: number }).count

    const replay = CharacterRosterRepository.commit(commitRequest())

    expect(replay).toMatchObject({
      operationId: first.operationId,
      payloadHash: first.payloadHash,
      idempotent: true,
      revision: second.revision,
      snapshot: {
        revision: second.revision,
        entries: expect.arrayContaining([
          expect.objectContaining({ name: '林舟', notes: 'B 已成为当前角色事实' }),
        ]),
      },
    })
    expect(replay.revision).toBe(replay.snapshot.revision)
    expect(replay.snapshot).toEqual(second.snapshot)
    expect((db.prepare('SELECT COUNT(*) AS count FROM character_roster_operations').get() as { count: number }).count)
      .toBe(operationCountBeforeReplay)
  })

  it('rejects a reused operation ID with a different payload and a stale revision without changing the roster', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const differentPayload = commitRequest({
      entries: commitRequest().entries.map(entry => (
        entry.name === '林舟' ? { ...entry, notes: '不同 payload' } : entry
      )),
    })

    expect(() => CharacterRosterRepository.commit(differentPayload))
      .toThrow(/操作 ID 已被用于不同的角色名单/)
    expect(() => CharacterRosterRepository.commit(commitRequest({
      operationId: 'architecture-run-002',
      expectedRevision: 0,
    }))).toThrow(/revision 已过期/)
    expect(CharacterRosterRepository.read()).toEqual(first.snapshot)
  })

  it('rejects a candidate with a dangling relationship before any facts are written', () => {
    const invalid = commitRequest({
      entries: [{
        ...commitRequest().entries[0],
        relationships: [{ target: '不存在的角色', relation: '敌对' }],
      }],
    })

    expect(() => CharacterRosterRepository.commit(invalid))
      .toThrow(/不存在的关系目标/)
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'empty',
      entries: [],
      renderedMarkdown: '',
    })
  })

  it('fails closed for an unsupported schema, duplicate identity, invalid role and self relation', () => {
    const base = commitRequest()
    const invalidCandidates: Array<{ candidate: CharacterRosterCommitRequest; error: RegExp }> = [
      {
        candidate: { ...base, schemaVersion: 2 as 1 },
        error: /schema 版本不受支持/,
      },
      {
        candidate: {
          ...base,
          entries: [base.entries[0], {
            ...base.entries[1],
            name: '林舟',
            relationships: [],
          }],
        },
        error: /角色名必须唯一/,
      },
      {
        candidate: {
          ...base,
          entries: [{ ...base.entries[0], role: 'villain' as never }],
        },
        error: /定位无效/,
      },
      {
        candidate: {
          ...base,
          entries: [{
            ...base.entries[0],
            relationships: [{ target: '林舟', relation: '镜像' }],
          }],
        },
        error: /不能建立自指关系/,
      },
    ]

    for (const { candidate, error } of invalidCandidates) {
      expect(() => CharacterRosterRepository.commit(candidate)).toThrow(error)
    }
    expect(CharacterRosterRepository.read().revision).toBe(0)
  })

  it('rolls back cards, projection, revision and receipt together when the final receipt write faults', () => {
    db.exec(`
      CREATE TRIGGER character_roster_test_receipt_fault
      BEFORE INSERT ON character_roster_operations
      BEGIN
        SELECT RAISE(ABORT, 'injected receipt fault');
      END;
    `)

    expect(() => CharacterRosterRepository.commit(commitRequest()))
      .toThrow(/injected receipt fault/)
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'empty',
      entries: [],
      renderedMarkdown: '',
    })
    expect(ProjectCoreRepository.get()?.charactersArch).toBe('')
  })

  it('rolls back inserted cards when the projection write faults before meta and receipt are recorded', () => {
    db.exec(`
      CREATE TRIGGER character_roster_test_projection_fault
      BEFORE UPDATE OF characters_arch ON project_core
      BEGIN
        SELECT RAISE(ABORT, 'injected projection fault');
      END;
    `)

    expect(() => CharacterRosterRepository.commit(commitRequest()))
      .toThrow(/injected projection fault/)
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'empty',
      entries: [],
      renderedMarkdown: '',
    })
    expect(ProjectCoreRepository.get()?.charactersArch).toBe('')
  })

  it('exposes existing cards as preserved legacy facts and refuses to overwrite them through the new seam', () => {
    db.exec('DELETE FROM character_roster_meta')
    CharacterRepository.upsert({
      name: '手工角色',
      role: 'protagonist',
      gender: '',
      age: '',
      appearance: '',
      personality: '',
      background: '',
      abilities: '',
      motivation: '',
      relationships: '自由文本关系必须原样保留',
      arc: '',
      notes: '用户手工填写',
    })
    ensureCharacterRosterSchema(db)

    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'legacy_cards_preserved',
      status: 'inconsistent',
      entries: [expect.objectContaining({
        name: '手工角色',
        notes: '用户手工填写',
        legacyRelationshipNotes: '自由文本关系必须原样保留',
      })],
    })
    expect(() => CharacterRosterRepository.commit(commitRequest()))
      .toThrow(/已有角色数据受到保护/)
    expect(CharacterRosterRepository.read().entries).toEqual([
      expect.objectContaining({ name: '手工角色', notes: '用户手工填写' }),
    ])
  })

  it('safely regenerates a structured roster around existing manual cards without replacing non-empty fields', () => {
    db.exec('DELETE FROM character_roster_meta')
    CharacterRepository.upsert({
      name: '林舟',
      role: 'supporting',
      gender: '',
      age: '',
      appearance: '作者手写的旧斗篷',
      personality: '',
      background: '',
      abilities: '',
      motivation: '',
      relationships: '作者手工填写的旧关系备注，不得被生成 JSON 覆盖',
      arc: '',
      notes: '作者已确认，不应覆盖',
    })
    ensureCharacterRosterSchema(db)

    // 旧项目先由显式 adoption 固化 cards -> projection；架构重新生成不再
    // 获得绕过 inconsistent 状态的特权。
    const preserved = CharacterRosterRepository.read()
    const adopted = CharacterRosterRepository.commit({
      operationId: 'adopt-before-architecture-regeneration',
      expectedRevision: preserved.revision,
      schemaVersion: 1,
      entries: preserved.entries.map((entry) => {
        const structuredEntry = { ...entry }
        delete structuredEntry.legacyRelationshipNotes
        return structuredEntry
      }),
      intent: 'legacy_cards_adoption',
      expectedLegacyMarkdown: preserved.legacyMarkdown ?? '',
    })

    const receipt = CharacterRosterRepository.commit({
      ...commitRequest({
        operationId: 'architecture-regeneration-001',
        expectedRevision: adopted.revision,
      }),
      intent: 'architecture_generation',
    })

    expect(receipt.snapshot).toMatchObject({
      revision: 2,
      migrationState: 'ready',
      entries: expect.arrayContaining([
        expect.objectContaining({
          name: '林舟',
          role: 'supporting',
          appearance: '作者手写的旧斗篷',
          notes: '作者已确认，不应覆盖',
          background: '铁砧镇学徒',
          legacyRelationshipNotes: '作者手工填写的旧关系备注，不得被生成 JSON 覆盖',
        }),
        expect.objectContaining({ name: '苏绾', role: 'supporting' }),
      ]),
    })
    expect(CharacterRosterRepository.read().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: '林舟',
        appearance: '作者手写的旧斗篷',
        legacyRelationshipNotes: '作者手工填写的旧关系备注，不得被生成 JSON 覆盖',
      }),
      expect.objectContaining({ name: '苏绾' }),
    ]))
    expect(CharacterRepository.getByName('林舟')?.relationships)
      .toBe('作者手工填写的旧关系备注，不得被生成 JSON 覆盖')
  })

  it('creates a second roster revision while preserving a manual edit made after the first structured commit', () => {
    const first = CharacterRosterRepository.commit(commitRequest())
    const manual = CharacterRosterRepository.commit({
      operationId: 'manual-edit-after-first-generation',
      expectedRevision: first.revision,
      schemaVersion: 1,
      intent: 'manual_edit',
      entries: first.snapshot.entries.map(entry => (
        entry.name === '林舟'
          ? { ...entry, appearance: '作者在角色管理中补写的红色旧斗篷' }
          : entry
      )),
    })
    const newCharacter = {
      name: '顾临',
      role: 'antagonist' as const,
      gender: '男',
      age: '三十岁',
      appearance: '玄铁面具',
      personality: '偏执',
      background: '旧王朝遗臣',
      abilities: '阵法',
      motivation: '复辟旧朝',
      relationships: [],
      arc: '承认失败',
      notes: '',
    }

    const second = CharacterRosterRepository.commit({
      ...commitRequest({
        operationId: 'architecture-regeneration-002',
        expectedRevision: manual.revision,
        entries: [...commitRequest().entries, newCharacter],
      }),
      intent: 'architecture_generation',
    })

    expect(second).toMatchObject({ revision: 3, idempotent: false })
    expect(second.snapshot.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '林舟', appearance: '作者在角色管理中补写的红色旧斗篷' }),
      expect.objectContaining({ name: '顾临', role: 'antagonist' }),
    ]))
  })

  it('archives legacy Markdown as migration evidence instead of parsing it as a roster', () => {
    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core
      SET characters_arch = '## 主角：这段旧文本不能自动成为事实';
    `)
    ensureCharacterRosterSchema(db)

    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'legacy_markdown_pending',
      status: 'legacy_repair_required',
      entries: [],
      renderedMarkdown: '',
      legacyMarkdown: '## 主角：这段旧文本不能自动成为事实',
    })
  })

  it('rejects normal generation for a zero-card legacy graph without changing its raw evidence, cards, or roster metadata', () => {
    const legacyMarkdown = '旧角色图谱原文：没有角色卡时，普通架构生成不得把它转为 ready。'
    db.prepare('DELETE FROM character_roster_meta').run()
    db.prepare("UPDATE project_core SET characters_arch = ? WHERE id = 'main'").run(legacyMarkdown)
    ensureCharacterRosterSchema(db)
    const before = rawRosterStorage()

    expect(() => CharacterRosterRepository.commit(commitRequest({
      operationId: 'normal-generation-must-not-migrate-legacy-markdown',
      intent: 'architecture_generation',
    }))).toThrow(/只能通过显式旧角色图谱修复/)

    expect(rawRosterStorage()).toEqual(before)
    expect(CharacterRosterRepository.read()).toMatchObject({
      revision: 0,
      migrationState: 'legacy_markdown_pending',
      status: 'legacy_repair_required',
      entries: [],
      legacyMarkdown,
    })
  })

  it('repairs a v0.7.1 zero-card legacy graph only through an exact-evidence structured commit', () => {
    const legacyMarkdown = '矿场事故后，沈砺和顾湘从互相怀疑走向共同调查。这里没有可供程序解析的标题或编号。'
    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core
      SET characters_arch = '${legacyMarkdown}';
    `)
    ensureCharacterRosterSchema(db)
    const before = CharacterRosterRepository.read()

    const receipt = CharacterRosterRepository.commit({
      ...commitRequest({ operationId: 'legacy-repair-v071', expectedRevision: before.revision }),
      intent: 'legacy_repair',
      expectedLegacyMarkdown: legacyMarkdown,
    })

    expect(receipt).toMatchObject({
      revision: 1,
      idempotent: false,
      snapshot: {
        migrationState: 'ready',
        status: 'ready',
        legacyMarkdown,
        entries: expect.arrayContaining([
          expect.objectContaining({ name: '林舟' }),
          expect.objectContaining({ name: '苏绾' }),
        ]),
      },
    })
    expect(ProjectCoreRepository.get()?.charactersArch).toBe(receipt.snapshot.renderedMarkdown)
    expect(CharacterRosterRepository.commit({
      ...commitRequest({ operationId: 'legacy-repair-v071', expectedRevision: before.revision }),
      intent: 'legacy_repair',
      expectedLegacyMarkdown: legacyMarkdown,
    })).toMatchObject({ idempotent: true, revision: 1 })
  })

  it('rejects a legacy repair whose archived source changed, without touching cards or the old graph', () => {
    const legacyMarkdown = '旧图谱原文 A：只有自然语言关系，没有固定 Markdown 排版。'
    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core
      SET characters_arch = '${legacyMarkdown}';
    `)
    ensureCharacterRosterSchema(db)
    const before = CharacterRosterRepository.read()

    expect(() => CharacterRosterRepository.commit({
      ...commitRequest({ operationId: 'legacy-repair-stale-source' }),
      intent: 'legacy_repair',
      expectedLegacyMarkdown: '旧图谱原文 B：模型候选不可以写回 A。',
    })).toThrow(/旧角色图谱已变更/)

    expect(CharacterRosterRepository.read()).toEqual(before)
    expect(ProjectCoreRepository.get()?.charactersArch).toBe(legacyMarkdown)
  })

  it('classifies empty, existing-card, partial-card and damaged legacy projects without auto-writing', () => {
    expect(CharacterRosterRepository.read()).toMatchObject({
      migrationState: 'empty',
      status: 'empty',
      entries: [],
    })

    CharacterRepository.upsert({
      name: '已有角色',
      role: 'supporting',
      gender: '', age: '', appearance: '', personality: '', background: '', abilities: '', motivation: '',
      relationships: '', arc: '', notes: '用户已手工填写',
    })
    // #83 之前旧编辑入口还会直接写 characters；读取只把它当受保护事实，
    // 不触发任何 Markdown 解析或覆盖。
    expect(CharacterRosterRepository.read()).toMatchObject({
      migrationState: 'empty',
      status: 'inconsistent',
      entries: [expect.objectContaining({ name: '已有角色' })],
    })

    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core SET characters_arch = '旧图谱存在，但此前只保存了一张手工角色卡。';
    `)
    ensureCharacterRosterSchema(db)
    expect(CharacterRosterRepository.read()).toMatchObject({
      migrationState: 'legacy_cards_preserved',
      status: 'inconsistent',
      entries: [expect.objectContaining({ name: '已有角色', notes: '用户已手工填写' })],
    })

    // 将元数据刻意置为“待修复”而数据库已有卡，代表损坏/不一致状态。
    db.prepare("UPDATE character_roster_meta SET migration_state = 'legacy_markdown_pending'").run()
    expect(CharacterRosterRepository.read()).toMatchObject({ status: 'inconsistent' })
  })

  it('explicitly adopts existing legacy cards by rebuilding only the deterministic projection', () => {
    const legacyMarkdown = '旧角色图谱原文：已有角色卡是事实，不应重新从这里提取。'
    db.exec(`
      DELETE FROM character_roster_meta;
      UPDATE project_core SET characters_arch = '${legacyMarkdown}';
    `)
    CharacterRepository.upsert({
      name: '手工主角',
      role: 'protagonist',
      gender: '女', age: '二十五岁', appearance: '作者手写的黑色风衣', personality: '谨慎',
      background: '作者手工设定的背景', abilities: '调查', motivation: '寻找真相',
      relationships: '作者手工填写的自由文本关系，必须原样保留', arc: '学会信任', notes: '不可覆盖',
    })
    ensureCharacterRosterSchema(db)
    const before = CharacterRosterRepository.read()
    const cardBefore = CharacterRepository.getByName('手工主角')

    expect(before).toMatchObject({
      migrationState: 'legacy_cards_preserved',
      status: 'inconsistent',
      entries: [expect.objectContaining({ legacyRelationshipNotes: '作者手工填写的自由文本关系，必须原样保留' })],
    })

    const receipt = CharacterRosterRepository.commit({
      operationId: 'adopt-existing-cards',
      expectedRevision: before.revision,
      schemaVersion: 1,
      entries: before.entries.map((entry) => {
        const structuredEntry = { ...entry }
        delete structuredEntry.legacyRelationshipNotes
        return structuredEntry
      }),
      intent: 'legacy_cards_adoption',
      expectedLegacyMarkdown: legacyMarkdown,
    })

    expect(receipt.snapshot).toMatchObject({
      migrationState: 'ready',
      status: 'ready',
      legacyMarkdown,
      entries: [expect.objectContaining({ name: '手工主角' })],
    })
    expect(ProjectCoreRepository.get()?.charactersArch).toBe(receipt.snapshot.renderedMarkdown)
    expect(CharacterRepository.getByName('手工主角')).toEqual(cardBefore)
  })
})
