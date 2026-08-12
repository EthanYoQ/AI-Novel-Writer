import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { BlueprintRepository, type BlueprintData } from '../blueprint-repository'
import { CharacterRosterRepository } from '../character-roster-repository'
import type { CharacterRosterEntry } from '../../../src/shared/character-roster'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

const blueprint: BlueprintData = {
  chapterNumber: 1,
  title: '启程',
  role: '建置',
  purpose: '引出主角目标',
  keyEvents: '主角发现异常',
  characters: ['主角'],
  suspenseHook: '门外传来敲门声',
  userGuidance: '',
  notes: '',
  notesUpdatedAt: '',
}

function rosterEntry(
  name: string,
  relationships: CharacterRosterEntry['relationships'] = [],
): CharacterRosterEntry {
  return {
    name,
    role: 'supporting',
    gender: '',
    age: '',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    motivation: '',
    relationships,
    arc: '',
    notes: '',
  }
}

function blueprintFor(chapterNumber: number): BlueprintData {
  return {
    ...blueprint,
    chapterNumber,
    title: `第${chapterNumber}章`,
    purpose: `推进第${chapterNumber}章`,
    keyEvents: `第${chapterNumber}章发生关键事件`,
  }
}

function createBlueprintDb(filename: string | Buffer = ':memory:'): BetterSqlite3.Database {
  const db = new Database(filename)
  db.exec(`
    CREATE TABLE IF NOT EXISTS blueprints (
      chapter_number INTEGER PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      role TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      key_events TEXT DEFAULT '',
      characters TEXT DEFAULT '[]',
      suspense_hook TEXT DEFAULT '',
      user_guidance TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      notes_updated_at TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS project_core (
      id TEXT PRIMARY KEY,
      characters_arch TEXT DEFAULT ''
    );
    INSERT OR IGNORE INTO project_core (id, characters_arch) VALUES ('main', '');
    CREATE TABLE IF NOT EXISTS characters (
      name TEXT PRIMARY KEY,
      role TEXT DEFAULT 'supporting',
      gender TEXT DEFAULT '', age TEXT DEFAULT '', appearance TEXT DEFAULT '',
      personality TEXT DEFAULT '', background TEXT DEFAULT '', abilities TEXT DEFAULT '',
      motivation TEXT DEFAULT '', relationships TEXT DEFAULT '', arc TEXT DEFAULT '', notes TEXT DEFAULT '',
      cs_location TEXT DEFAULT '', cs_power_level TEXT DEFAULT '', cs_physical_state TEXT DEFAULT '',
      cs_mental_state TEXT DEFAULT '', cs_key_items TEXT DEFAULT '', cs_recent_events TEXT DEFAULT '',
      cs_updated_at_chapter INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
  return db
}

beforeEach(() => {
  vi.mocked(getProjectDb).mockReturnValue(null)
})

describe('BlueprintRepository without an opened project DB', () => {
  it('throws for getAll', () => {
    expect(() => BlueprintRepository.getAll()).toThrow(/项目数据库未打开/)
  })

  it('throws for getByChapter', () => {
    expect(() => BlueprintRepository.getByChapter(1)).toThrow(/项目数据库未打开/)
  })

  it('throws for count', () => {
    expect(() => BlueprintRepository.count()).toThrow(/项目数据库未打开/)
  })

  it('throws for upsert', () => {
    expect(() => BlueprintRepository.upsert(blueprint)).toThrow(/项目数据库未打开/)
  })

  it('throws for upsertMany', () => {
    expect(() => BlueprintRepository.upsertMany([blueprint])).toThrow(/项目数据库未打开/)
  })
})

describe('BlueprintRepository range commit', () => {
  it('commits one exact logical range and returns its transaction readback receipt', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)

    try {
      const receipt = BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-run-1',
        startChapter: 1,
        endChapter: 3,
        blueprints: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
      })

      expect(receipt).toMatchObject({
        mode: 'replace-range',
        operationId: 'directory-run-1',
        startChapter: 1,
        endChapter: 3,
        chapterNumbers: [1, 2, 3],
        snapshot: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
        characterSyncInput: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
        idempotent: false,
        characterSyncOperation: {
          operationId: 'blueprint-sync-directory-run-1',
          blueprintCommitOperationId: 'directory-run-1',
          status: 'pending',
          startChapter: 1,
          endChapter: 3,
          characterSyncInput: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
        },
      })
      expect(receipt.payloadHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(BlueprintRepository.getAll()).toEqual(receipt.snapshot)
    } finally {
      db.close()
    }
  })

  it('rolls back the whole logical range when transaction readback does not match', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    db.prepare(`
      CREATE TRIGGER rewrite_second_blueprint
      AFTER INSERT ON blueprints
      WHEN NEW.chapter_number = 2
      BEGIN
        UPDATE blueprints SET title = '数据库改写' WHERE chapter_number = 2;
      END
    `).run()

    try {
      expect(() => BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-run-rollback',
        startChapter: 1,
        endChapter: 3,
        blueprints: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
      })).toThrow(/回读不一致/u)
      expect(BlueprintRepository.getAll()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects missing, duplicate, and out-of-range coverage before opening a transaction', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)

    try {
      for (const blueprints of [
        [blueprintFor(1), blueprintFor(3)],
        [blueprintFor(1), blueprintFor(2), blueprintFor(2)],
        [blueprintFor(1), blueprintFor(2), blueprintFor(4)],
      ]) {
        expect(() => BlueprintRepository.commitRange({
          mode: 'replace-range',
          operationId: 'directory-run-invalid',
          startChapter: 1,
          endChapter: 3,
          blueprints,
        })).toThrow(/完整且唯一/u)
      }
      expect(BlueprintRepository.getAll()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects a non-positive chapter range before any write', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)

    try {
      expect(() => BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-run-invalid-range',
        startChapter: 0,
        endChapter: 1,
        blueprints: [blueprintFor(0), blueprintFor(1)],
      })).toThrow(/范围无效/u)
      expect(BlueprintRepository.getAll()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('full mode removes old blueprints outside the newly committed complete range', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    BlueprintRepository.upsertMany([1, 2, 3, 4, 5].map(blueprintFor))

    try {
      const receipt = BlueprintRepository.commitRange({
        mode: 'full',
        operationId: 'directory-full-3',
        startChapter: 1,
        endChapter: 3,
        blueprints: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
      })

      expect(receipt.mode).toBe('full')
      expect(BlueprintRepository.getAll().map(item => item.chapterNumber)).toEqual([1, 2, 3])
    } finally {
      db.close()
    }
  })

  it('rolls back full-mode outside-range deletion when readback validation fails', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    const original = [1, 2, 3, 4, 5].map(chapterFor => ({
      ...blueprintFor(chapterFor),
      title: `原第${chapterFor}章`,
    }))
    BlueprintRepository.upsertMany(original)
    db.prepare(`
      CREATE TRIGGER rewrite_full_second_blueprint
      AFTER UPDATE ON blueprints
      WHEN NEW.chapter_number = 2
      BEGIN
        UPDATE blueprints SET title = '数据库改写' WHERE chapter_number = 2;
      END
    `).run()

    try {
      expect(() => BlueprintRepository.commitRange({
        mode: 'full',
        operationId: 'directory-full-rollback',
        startChapter: 1,
        endChapter: 3,
        blueprints: [blueprintFor(1), blueprintFor(2), blueprintFor(3)],
      })).toThrow(/回读不一致/u)
      expect(BlueprintRepository.getAll()).toEqual(original)
    } finally {
      db.close()
    }
  })

  it('replace-range mode changes only the exact range and preserves outside chapters', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    BlueprintRepository.upsertMany([1, 2, 3, 4, 5].map(blueprintFor))
    const replacements = [2, 3].map(chapterNumber => blueprintFor(chapterNumber))
      .map(item => ({ ...item, title: `${item.title}（替换）` }))

    try {
      BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-range-2-3',
        startChapter: 2,
        endChapter: 3,
        blueprints: replacements,
      })

      expect(BlueprintRepository.getAll().map(item => item.title)).toEqual([
        '第1章',
        '第2章（替换）',
        '第3章（替换）',
        '第4章',
        '第5章',
      ])
    } finally {
      db.close()
    }
  })

  it('replays the same operation and payload idempotently but rejects payload reuse', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    const request = {
      mode: 'replace-range' as const,
      operationId: 'directory-replay',
      startChapter: 1,
      endChapter: 2,
      blueprints: [
        blueprintFor(1),
        { ...blueprintFor(2), relationshipHints: [{ from: '甲', to: '乙', relation: '同盟' }] },
      ],
    }

    try {
      const first = BlueprintRepository.commitRange(request)
      const replay = BlueprintRepository.commitRange(request)

      expect(first.idempotent).toBe(false)
      expect(replay).toMatchObject({
        operationId: request.operationId,
        payloadHash: first.payloadHash,
        idempotent: true,
        chapterNumbers: [1, 2],
        characterSyncInput: request.blueprints,
      })
      expect(() => BlueprintRepository.commitRange({
        ...request,
        blueprints: [blueprintFor(1), { ...blueprintFor(2), title: '冲突载荷' }],
      })).toThrow(/操作 ID.*不同/u)
    } finally {
      db.close()
    }
  })

  it('persists a pending character-sync operation across restart and marks it completed durably', () => {
    let db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)

    try {
      const committed = BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-restart',
        startChapter: 1,
        endChapter: 2,
        blueprints: [
          blueprintFor(1),
          { ...blueprintFor(2), relationshipHints: [{ from: '甲', to: '乙', relation: '同盟' }] },
        ],
      })
      const firstRestartImage = db.serialize()
      db.close()

      db = createBlueprintDb(firstRestartImage)
      vi.mocked(getProjectDb).mockReturnValue(db)
      expect(BlueprintRepository.listPendingCharacterSyncOperations()).toEqual([
        expect.objectContaining({
          operationId: committed.characterSyncOperation.operationId,
          blueprintCommitOperationId: committed.operationId,
          status: 'pending',
          characterSyncInput: committed.characterSyncInput,
        }),
      ])

      CharacterRosterRepository.commit({
        operationId: committed.characterSyncOperation.operationId,
        expectedRevision: 0,
        schemaVersion: 1,
        intent: 'blueprint_sync',
        entries: [rosterEntry('主角')],
      })

      const completed = BlueprintRepository.completeCharacterSyncOperation(
        committed.characterSyncOperation.operationId,
      )
      expect(completed).toMatchObject({
        status: 'completed',
        completionReceipt: { status: 'committed' },
      })
      const secondRestartImage = db.serialize()
      db.close()

      db = createBlueprintDb(secondRestartImage)
      vi.mocked(getProjectDb).mockReturnValue(db)
      expect(BlueprintRepository.listPendingCharacterSyncOperations()).toEqual([])
      expect(BlueprintRepository.getCharacterSyncOperation(
        committed.characterSyncOperation.operationId,
      )).toMatchObject({
        status: 'completed',
        completionReceipt: { status: 'committed' },
      })
    } finally {
      if (db.open) db.close()
    }
  })

  it('refuses to close pending sync work until the authoritative roster proves its frozen facts', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    try {
      const committed = BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-needs-roster-facts',
        startChapter: 1,
        endChapter: 1,
        blueprints: [{
          ...blueprintFor(1),
          characters: ['林岚', '周砚'],
          relationshipHints: [{ from: '林岚', to: '周砚', relation: '同盟' }],
        }],
      })

      expect(() => BlueprintRepository.completeCharacterSyncOperation(
        committed.characterSyncOperation.operationId,
      )).toThrow(/缺少蓝图角色/u)
      expect(BlueprintRepository.listPendingCharacterSyncOperations()).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('derives a committed completion receipt from the real roster operation and rejects forged hash or revision', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    try {
      const committed = BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-authoritative-receipt',
        startChapter: 1,
        endChapter: 1,
        blueprints: [{ ...blueprintFor(1), characters: ['林岚'], relationshipHints: [] }],
      })
      const authoritativeCommit = CharacterRosterRepository.commit({
        operationId: committed.characterSyncOperation.operationId,
        expectedRevision: 0,
        schemaVersion: 1,
        intent: 'blueprint_sync',
        entries: [rosterEntry('林岚')],
      })
      const authoritativeRoster = authoritativeCommit.snapshot

      const restoreEvidence = () => db.prepare(`
        UPDATE character_roster_operations
        SET payload_hash = ?, committed_revision = ?, projection_hash = ?
        WHERE operation_id = ?
      `).run(
        authoritativeCommit.payloadHash,
        authoritativeCommit.revision,
        authoritativeCommit.snapshot.projectionHash,
        committed.characterSyncOperation.operationId,
      )
      db.prepare(`
        UPDATE character_roster_operations SET payload_hash = 'forged'
        WHERE operation_id = ?
      `).run(committed.characterSyncOperation.operationId)
      expect(() => BlueprintRepository.completeCharacterSyncOperation(
        committed.characterSyncOperation.operationId,
      )).toThrow(/操作证据/u)
      restoreEvidence()
      db.prepare(`
        UPDATE character_roster_operations SET committed_revision = 999
        WHERE operation_id = ?
      `).run(committed.characterSyncOperation.operationId)
      expect(() => BlueprintRepository.completeCharacterSyncOperation(
        committed.characterSyncOperation.operationId,
      )).toThrow(/操作证据/u)
      restoreEvidence()
      db.prepare(`
        UPDATE character_roster_operations SET projection_hash = 'forged'
        WHERE operation_id = ?
      `).run(committed.characterSyncOperation.operationId)
      expect(() => BlueprintRepository.completeCharacterSyncOperation(
        committed.characterSyncOperation.operationId,
      )).toThrow(/操作证据/u)
      restoreEvidence()

      const completed = BlueprintRepository.completeCharacterSyncOperation(
        committed.characterSyncOperation.operationId,
      )
      expect(completed.completionReceipt).toEqual({
        blueprintCommitOperationId: committed.operationId,
        operationId: committed.characterSyncOperation.operationId,
        status: 'committed',
        rosterReceipt: {
          operationId: committed.characterSyncOperation.operationId,
          payloadHash: authoritativeCommit.payloadHash,
          revision: authoritativeRoster.revision,
          idempotent: false,
        },
      })

      expect(BlueprintRepository.completeCharacterSyncOperation(
        committed.characterSyncOperation.operationId,
      )).toEqual(completed)
    } finally {
      db.close()
    }
  })

  it('rejects an unknown sync operation instead of manufacturing a completion receipt', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    try {
      expect(() => BlueprintRepository.completeCharacterSyncOperation('blueprint-sync-forged'))
        .toThrow(/不存在/u)
    } finally {
      db.close()
    }
  })

  it('marks an operation already satisfied only after current roster facts prove every frozen fact', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    try {
      CharacterRosterRepository.commit({
        operationId: 'prior-authoritative-roster-change',
        expectedRevision: 0,
        schemaVersion: 1,
        intent: 'blueprint_sync',
        entries: [
          rosterEntry('林岚', [{ target: '周砚', relation: '同盟' }]),
          rosterEntry('周砚', [{ target: '林岚', relation: '同盟' }]),
        ],
      })
      const committed = BlueprintRepository.commitRange({
        mode: 'replace-range',
        operationId: 'directory-already-satisfied',
        startChapter: 1,
        endChapter: 1,
        blueprints: [{
          ...blueprintFor(1),
          characters: ['林岚', '周砚'],
          relationshipHints: [{ from: '林岚', to: '周砚', relation: '同盟' }],
        }],
      })

      expect(BlueprintRepository.completeCharacterSyncOperation(
        committed.characterSyncOperation.operationId,
      )).toMatchObject({
        status: 'completed',
        completionReceipt: {
          operationId: committed.characterSyncOperation.operationId,
          status: 'already-satisfied',
        },
      })
    } finally {
      db.close()
    }
  })

  it('clears durable sync work together with the blueprint facts it belongs to', () => {
    const db = createBlueprintDb()
    vi.mocked(getProjectDb).mockReturnValue(db)
    try {
      const receipt = BlueprintRepository.commitRange({
        mode: 'full',
        operationId: 'directory-before-clear',
        startChapter: 1,
        endChapter: 1,
        blueprints: [blueprintFor(1)],
      })

      BlueprintRepository.clearAll()

      expect(BlueprintRepository.getAll()).toEqual([])
      expect(BlueprintRepository.listPendingCharacterSyncOperations()).toEqual([])
      expect(BlueprintRepository.getCharacterSyncOperation(
        receipt.characterSyncOperation.operationId,
      )).toBeNull()
    } finally {
      db.close()
    }
  })
})
