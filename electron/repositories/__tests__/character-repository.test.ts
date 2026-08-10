import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { BlueprintRepository, type BlueprintData } from '../blueprint-repository'
import {
  CharacterRepository,
  type CharacterData,
} from '../character-repository'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

function character(name: string, notes = ''): CharacterData {
  return {
    name,
    role: 'protagonist',
    gender: '',
    age: '',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    motivation: '',
    relationships: `自由文本中的${name}不应被盲目替换`,
    arc: '',
    notes,
  }
}

function blueprint(characters: string[]): BlueprintData {
  return {
    chapterNumber: 1,
    title: '启程',
    role: '建置',
    purpose: '自由文本中的旧名不应被替换',
    keyEvents: '旧名做出决定',
    characters,
    suspenseHook: '',
    userGuidance: '',
    notes: '旧名的章节备注',
    notesUpdatedAt: '',
  }
}

let db: BetterSqlite3.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
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
  `)
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => {
  db.close()
})

describe('CharacterRepository transactional rename', () => {
  it('normalizes missing and unknown persisted roles while preserving canonical roles', () => {
    const insert = db.prepare('INSERT INTO characters (name, role) VALUES (?, ?)')
    insert.run('缺少定位', null)
    insert.run('未知定位', 'legacy-custom-role')
    insert.run('法定主角', 'protagonist')

    expect(CharacterRepository.getByName('缺少定位')?.role).toBe('supporting')
    expect(CharacterRepository.getByName('未知定位')?.role).toBe('supporting')
    expect(CharacterRepository.getByName('法定主角')?.role).toBe('protagonist')
  })

  it('renames the primary key and exact structured blueprint references in one transaction', () => {
    CharacterRepository.upsert(character('旧名', '原始备注'))
    BlueprintRepository.upsert(blueprint(['旧名', '另一角色']))
    const renamedCard = character(' 新名 ', '改名后的备注')
    renamedCard.relationships = '自由文本中的旧名不应被替换'

    CharacterRepository.saveAll(
      [renamedCard],
      [{ originalName: '旧名', newName: ' 新名 ' }],
    )

    expect(CharacterRepository.getByName('旧名')).toBeNull()
    expect(CharacterRepository.getByName('新名')).toMatchObject({
      name: '新名',
      notes: '改名后的备注',
      relationships: '自由文本中的旧名不应被替换',
    })
    expect(BlueprintRepository.getByChapter(1)).toMatchObject({
      characters: ['新名', '另一角色'],
      purpose: '自由文本中的旧名不应被替换',
      keyEvents: '旧名做出决定',
      notes: '旧名的章节备注',
    })
  })

  it('rolls back the whole transaction when the target name conflicts', () => {
    CharacterRepository.upsert(character('旧名', '不得改变'))
    CharacterRepository.upsert(character('已存在', '目标角色'))
    BlueprintRepository.upsert(blueprint(['旧名']))

    expect(() => CharacterRepository.saveAll(
      [character('已存在', '不应写入')],
      [{ originalName: '旧名', newName: '已存在' }],
    )).toThrow(/已存在/)

    expect(CharacterRepository.getByName('旧名')).toMatchObject({ notes: '不得改变' })
    expect(CharacterRepository.getByName('已存在')).toMatchObject({ notes: '目标角色' })
    expect(BlueprintRepository.getByChapter(1)?.characters).toEqual(['旧名'])
  })

  it('rejects a target that is empty after trimming without changing persisted data', () => {
    CharacterRepository.upsert(character('旧名', '保持原样'))

    expect(() => CharacterRepository.saveAll(
      [character('   ', '不应写入')],
      [{ originalName: '旧名', newName: '   ' }],
    )).toThrow(/不能为空/)

    expect(CharacterRepository.getAll()).toEqual([
      expect.objectContaining({ name: '旧名', notes: '保持原样' }),
    ])
  })

  it('atomically applies a chained rename and rewrites each structured reference once', () => {
    CharacterRepository.upsert(character('A', '原 A'))
    CharacterRepository.upsert(character('C', '原 C'))
    BlueprintRepository.upsert(blueprint(['A', 'C', 'B']))

    CharacterRepository.saveAll(
      [character('B', '原 A 的新卡'), character('A', '原 C 的新卡')],
      [
        { originalName: 'A', newName: 'B' },
        { originalName: 'C', newName: 'A' },
      ],
    )

    expect(CharacterRepository.getAll()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'A', notes: '原 C 的新卡' }),
      expect.objectContaining({ name: 'B', notes: '原 A 的新卡' }),
    ]))
    expect(BlueprintRepository.getByChapter(1)?.characters).toEqual(['B', 'A', 'B'])
  })

  it('atomically swaps two names without rejecting the occupied original targets', () => {
    CharacterRepository.upsert(character('A', '原 A'))
    CharacterRepository.upsert(character('B', '原 B'))
    BlueprintRepository.upsert(blueprint(['A', 'B']))

    CharacterRepository.saveAll(
      [character('B', 'A 改成 B'), character('A', 'B 改成 A')],
      [
        { originalName: 'A', newName: 'B' },
        { originalName: 'B', newName: 'A' },
      ],
    )

    expect(CharacterRepository.getByName('A')).toMatchObject({ notes: 'B 改成 A' })
    expect(CharacterRepository.getByName('B')).toMatchObject({ notes: 'A 改成 B' })
    expect(BlueprintRepository.getByChapter(1)?.characters).toEqual(['B', 'A'])
  })

  it('rolls back an entire swap when a later structured-reference update fails', () => {
    CharacterRepository.upsert(character('A', '原 A'))
    CharacterRepository.upsert(character('B', '原 B'))
    db.prepare(`
      INSERT INTO blueprints (chapter_number, title, characters)
      VALUES (1, '损坏蓝图', 'not-json')
    `).run()

    expect(() => CharacterRepository.saveAll(
      [character('B', '不应写入'), character('A', '也不应写入')],
      [
        { originalName: 'A', newName: 'B' },
        { originalName: 'B', newName: 'A' },
      ],
    )).toThrow(/损坏/)

    expect(CharacterRepository.getByName('A')).toMatchObject({ notes: '原 A' })
    expect(CharacterRepository.getByName('B')).toMatchObject({ notes: '原 B' })
    expect(db.prepare('SELECT characters FROM blueprints WHERE chapter_number = 1').get())
      .toEqual({ characters: 'not-json' })
  })
})
