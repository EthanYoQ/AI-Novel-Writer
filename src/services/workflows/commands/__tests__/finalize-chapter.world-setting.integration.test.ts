/**
 * 定稿后处理的「世界观落袋」链路回归 —— 工作流 → IPC → **真实仓储 + 真实 SQLite**。
 *
 * 为什么这个文件里不再 mock 世界观写入通道（review P1 的直接要求）：
 * 旧版本把 `world-setting:save` mock 成永远返回 `{ id: 999, name }`，于是
 * 「工作流调用了候选 save」被当成「候选写入安全」的证明 —— 而真实仓储的 save
 * 是按同名查找后 **UPDATE**（默认 author 权限、UPDATE 不改 status）。
 * 库里 `Nova` / `NOVA` 并存 + 模型报 `Nova` + 引文不在正文里时，
 * 整条链路会覆盖作者已确认的原文，CI 却全绿。
 *
 * 现在 list / append-derived / create-candidate 三个通道全部转发到真实仓储，
 * 断言也直接读真实数据库的行：任何「回退到覆盖式 save」的实现都会让本文件变红
 * （未知通道会撞上 default 分支的 throw）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type BetterSqlite3 from 'better-sqlite3'

import type { StepCallbacks, WorkflowContext } from '../../../../stores/workflow-store'
import { useLLMStore } from '../../../../stores/llm-store'
import { useProjectStore } from '../../../../stores/project-store'
import { FinalizeChapterCommand } from '../finalize-chapter.command'
import { getProjectDb } from '../../../../../electron/database'
import { WorldSettingRepository } from '../../../../../electron/repositories/world-setting-repository'

vi.mock('../../../../../electron/database', () => ({
  getProjectDb: vi.fn(),
}))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

let db: BetterSqlite3.Database

const finalizationClient = vi.hoisted(() => ({
  commitFinalizationSnapshot: vi.fn(),
}))

vi.mock('../../../finalization-client', () => finalizationClient)

function createSchema(database: BetterSqlite3.Database): void {
  database.exec(`
    CREATE TABLE world_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'world',
      name TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      importance TEXT NOT NULL DEFAULT 'side',
      related TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'confirmed',
      provenance TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name)
    );
    CREATE TABLE world_setting_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      setting_id INTEGER NOT NULL,
      setting_name TEXT NOT NULL DEFAULT '',
      setting_content_snapshot TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      statement TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );
  `)
}

/** 库里已有的条目：由真实仓储读回，而不是把固定数组喂给 IPC。 */
function seedEntry(overrides: {
  name: string
  content?: string
  summary?: string
  aliases?: string[]
}): number {
  const result = db.prepare(`
    INSERT INTO world_settings (category, name, aliases, summary, content, tags, importance, related, source, status, provenance)
    VALUES ('faction', ?, ?, ?, ?, '[]', 'main', '[]', 'manual', 'confirmed', ?)
  `).run(
    overrides.name,
    JSON.stringify(overrides.aliases ?? []),
    overrides.summary ?? '作者手写的摘要',
    overrides.content ?? '作者手写的原文',
    JSON.stringify({
      content: { kind: 'author' },
      summary: { kind: 'author' },
      aliases: { kind: 'author' },
      importance: { kind: 'author' },
    }),
  )
  return Number(result.lastInsertRowid)
}

function rawRow(id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM world_settings WHERE id = ?').get(id) as Record<string, unknown>
}

function allEntries(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM world_settings ORDER BY id ASC').all() as Array<Record<string, unknown>>
}

const PROJECT_PATH = 'C:\\novels\\world-settings'
const PROJECT_SESSION = Object.freeze({
  projectId: 'world-settings',
  leaseId: 'lease-world-settings',
  projectPath: PROJECT_PATH,
})

function workflowContext(): WorkflowContext {
  return {
    runId: 'finalize-world-settings',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    writingLanguage: 'zh-CN',
    uiLocale: 'zh-CN',
    data: {},
    cancelled: false,
  }
}

function modelLease() {
  return {
    leaseId: 'model-lease-world-settings',
    modelId: 'test-model',
    provider: 'custom',
    protocol: 'openai',
    modelName: 'test-model',
    modelRevision: 'a'.repeat(64),
    endpointFingerprint: 'b'.repeat(64),
    capabilityEvidence: {
      source: {
        contextWindowTokens: 'unknown',
        maxOutputTokens: 'user-operational-cap',
        featureFlags: 'unknown',
      },
      subjectFingerprint: 'c'.repeat(64),
      contextWindowTokens: null,
      maxOutputTokens: 8192,
      reasoning: null,
      structuredOutput: true,
      usage: null,
    },
    createdAt: 1_000,
    expiresAt: 61_000,
  }
}

function snapshot(content: string) {
  return Object.freeze({
    tabId: 'draft-33',
    projectPath: PROJECT_PATH,
    projectSession: PROJECT_SESSION,
    draftId: 33,
    chapterNumber: 3,
    chapterTitle: '山行',
    content,
    contentRevision: 5,
  })
}

function chapterInfo() {
  return {
    projectPath: PROJECT_PATH,
    chapterNumber: 3,
    title: '山行',
    role: '发展',
    purpose: '推进剧情',
    keyEvents: '旅人离开客栈',
    characters: [],
  }
}

interface RunResult {
  invoke: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  /** 某个通道被调用的次数。 */
  calls: (channel: string) => unknown[][]
}

/**
 * 跑完整定稿流程。世界观三个写入通道全部转发到**真实仓储**（同一个内存库），
 * 所以断言看的是数据库里真实的行，而不是 mock 的返回值。
 */
async function runFinalize(
  content: string,
  worldResponse: string,
  options: { listSnapshot?: Array<Record<string, unknown>> } = {},
): Promise<RunResult> {
  const completedSteps = new Set<string>()
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    switch (channel) {
      case 'prompt:load-global':
        return { templates: [], diagnostics: [] }
      case 'fs:check-exists':
        return false
      case 'llm:begin-execution-lease':
        return { success: true, lease: modelLease() }
      case 'llm:close-execution-lease':
        return { success: true }
      case 'db:blueprint-get':
        return { chapterNumber: 3, title: '山行', characters: [] }
      case 'db:post-process-get-latest-run':
        return null
      case 'db:post-process-create-run':
        return { success: true, id: 'post-process-3' }
      case 'db:post-process-get-steps':
        return [...completedSteps].map((stepKey, index) => ({
          id: index + 1,
          runId: 'post-process-3',
          stepKey,
          label: stepKey,
          critical: stepKey !== 'character_cards' && stepKey !== 'world_settings',
          ok: true,
          attemptCount: 1,
          completedAt: '2026-09-18T00:00:00.000Z',
          lastAttemptAt: '2026-09-18T00:00:00.000Z',
        }))
      case 'db:post-process-mark-step-ok':
        completedSteps.add(String(args[1]))
        return { success: true }
      case 'kb:import-text':
        return { success: true, docId: 'knowledge-3', chunkCount: 1 }
      case 'db:finalization-link-knowledge-document':
        return { success: true }
      case 'db:continuity-save-finalized':
        return { success: true }
      case 'db:continuity-read-source':
        return {
          status: 'valid',
          snapshot: {
            source: {
              draftId: 33,
              finalizationId: 'finalization-3',
              chapterNumber: 3,
              contentHash: 'content-hash-3',
            },
            chapterTitle: '山行',
            content,
            projectionGeneration: 0,
          },
        }
      case 'db:blueprint-update-notes':
        return { success: true, updated: true }
      case 'db:character-roster-read':
        return { status: 'empty', revision: 0, entries: [] }
      case 'world-setting:list-chapter-refs':
        return []
      // ===== 以下三个通道不做替身，直接落到真实仓储 + 真实 SQLite =====
      case 'world-setting:list':
        // 不传快照就读真库；传了就用快照 —— 后者用来复现「读快照之后库里才多出同名条目」。
        return options.listSnapshot ?? WorldSettingRepository.getAll()
      case 'world-setting:append-derived':
        return WorldSettingRepository.appendDerived(
          args[0] as number,
          args[1] as { content?: string; summary?: string },
          args[2] as number,
        )
      case 'world-setting:create-candidate':
        return WorldSettingRepository.createCandidate(
          args[0] as Parameters<typeof WorldSettingRepository.createCandidate>[0],
        )
      case 'world-setting:record-conflict':
        return { id: 1 }
      default:
        // 任何回退到覆盖式 save（world-setting:save）的实现都会撞在这里。
        throw new Error(`unexpected IPC: ${channel}`)
    }
  })
  vi.stubGlobal('window', { velaAPI: { invoke } })

  let completionIndex = 0
  useLLMStore.setState({
    defaultModelId: 'test-model',
    generateStream: vi.fn(async (_messages, streamCallbacks) => {
      completionIndex += 1
      if (completionIndex === 1) {
        streamCallbacks.onDone?.(content, undefined, 'stop')
      } else if (completionIndex === 2) {
        streamCallbacks.onDone?.('{"updates":[]}', undefined, 'stop')
      } else {
        streamCallbacks.onDone?.(worldResponse, undefined, 'stop')
      }
      return `request-${completionIndex}`
    }),
  })

  const command = new FinalizeChapterCommand({
    draftPath: 'vela://draft/33',
    draftContent: '旧参数正文不得被读取',
    chapterNumber: 3,
    chapterInfo: chapterInfo(),
    snapshot: snapshot(content),
  })

  const log = vi.fn()
  const callbacks: StepCallbacks = { log, setProgress: vi.fn(), appendText: vi.fn() }

  await command.execute({
    step: {},
    context: workflowContext(),
    callbacks,
  })

  return {
    invoke,
    log,
    calls: (channel: string) => invoke.mock.calls.filter(([called]) => called === channel),
  }
}

describe('FinalizeChapterCommand world-setting persistence boundaries', () => {
  beforeEach(() => {
    db = new Database(':memory:')
    createSchema(db)
    vi.mocked(getProjectDb).mockReturnValue(db)

    finalizationClient.commitFinalizationSnapshot.mockResolvedValue({
      success: true,
      committed: true,
      finalizationId: 'finalization-3',
      contentHash: 'content-hash-3',
      contentRevision: 5,
      draftId: 33,
      publicationStatus: 'published',
    })
    useProjectStore.setState({
      currentProject: {
        id: 'world-settings',
        name: 'World settings',
        path: PROJECT_PATH,
        sessionLease: PROJECT_SESSION.leaseId,
        novelConfig: {
          globalGuidance: '',
          wordsPerChapter: 1200,
          creativeStrategy: 'auto',
        },
      } as never,
      refreshFileTree: vi.fn().mockResolvedValue(undefined),
    })
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    useProjectStore.setState({ currentProject: null })
    useLLMStore.setState({ defaultModelId: null })
  })

  it('never auto-appends when the model evidence is not in the frozen manuscript', async () => {
    const content = '旅人独自离开了客栈，走向山路。'
    const entryId = seedEntry({ name: '青云宗', content: '青云宗已覆灭。' })

    const { calls } = await runFinalize(content, JSON.stringify({
      updates: [{
        entryName: '青云宗',
        evidence: '青云宗已经彻底覆灭。',
        statement: '青云宗已覆灭。',
      }],
      conflicts: [],
      newEntities: [],
    }))

    expect(calls('world-setting:append-derived')).toHaveLength(0)
    expect(rawRow(entryId)).toMatchObject({ content: '青云宗已覆灭。' })
  })

  it('auto-appends once when the evidence does appear in the frozen manuscript', async () => {
    const content = '旅人独自离开了客栈，走向山路。青云宗已经彻底覆灭。'
    const entryId = seedEntry({ name: '青云宗', content: '青云宗已覆灭。' })

    const { calls } = await runFinalize(content, JSON.stringify({
      updates: [{
        entryName: '青云宗',
        evidence: '青云宗已经彻底覆灭。',
        statement: '青云宗已覆灭。',
      }],
      conflicts: [],
      newEntities: [],
    }))

    expect(calls('world-setting:append-derived')).toEqual([[
      'world-setting:append-derived',
      entryId,
      { content: '青云宗已覆灭。' },
      3,
      PROJECT_PATH,
    ]])
    // 真库确认：只追加，作者原文仍在。
    expect(rawRow(entryId).content).toContain('青云宗已覆灭。')
  })

  it('creates a real pending candidate for a genuinely new entity', async () => {
    const content = '旅人踏入了从未有人涉足的雪原。'

    const { calls, log } = await runFinalize(content, JSON.stringify({
      updates: [],
      conflicts: [],
      newEntities: [{
        name: '雪原',
        evidence: '旅人踏入了从未有人涉足的雪原。',
        statement: '雪原存在于北方。',
      }],
    }))

    expect(calls('world-setting:create-candidate')).toHaveLength(1)
    // 真库确认：候选真的落了地，且是 pending。
    const rows = allEntries()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: '雪原', status: 'pending', source: 'ai' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 条新设定待确认'))
  })

  it('never guesses between two similar names; it queues a candidate instead of touching either entry', async () => {
    const content = '旅人走进了东城商会。'
    const eastId = seedEntry({ name: '东城商会', content: '东城商会的原文' })
    const westId = seedEntry({ name: '西城商会', content: '西城商会的原文' })
    const beforeEast = rawRow(eastId)
    const beforeWest = rawRow(westId)

    const { calls, log } = await runFinalize(content, JSON.stringify({
      updates: [{
        entryName: '商会',
        evidence: '旅人走进了东城商会。',
        statement: '旅人去了商会。',
      }],
      conflicts: [],
      newEntities: [],
    }))

    // 包含关系不算命中：绝不按长度差/数组顺序挑一条写进去（旧实现的行为）。
    expect(calls('world-setting:append-derived')).toHaveLength(0)
    expect(rawRow(eastId)).toEqual(beforeEast)
    expect(rawRow(westId)).toEqual(beforeWest)
    // 「商会」在库里没有全等命中 → 归为「正文引出、库里还没有」的设定，
    // 落成一条待作者确认的候选；两条既有条目一个字都没动。
    expect(calls('world-setting:create-candidate')).toHaveLength(1)
    expect(allEntries()).toHaveLength(3)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 条新设定待确认'))
  })

  it('never writes through the candidate path when Nova/NOVA are ambiguous, even with a real quotation', async () => {
    // review P1 的原始反例：两条合法的大小写不同条目 + 模型只报 Nova。
    // 引文**存在**与**不存在**两种都必须拒绝写入。
    const content = '旅人独自离开了客栈，走向山路。Nova has already been destroyed.'
    const upperId = seedEntry({ name: 'Nova', content: 'Nova 的作者原文' })
    const lowerId = seedEntry({ name: 'NOVA', content: 'NOVA 的作者原文' })
    const beforeUpper = rawRow(upperId)
    const beforeLower = rawRow(lowerId)

    const { calls, log } = await runFinalize(content, JSON.stringify({
      updates: [{
        entryName: 'Nova',
        evidence: 'Nova has already been destroyed.',
        statement: 'Nova has been destroyed.',
      }],
      conflicts: [],
      // 两个入口同时触发：updates 与 newEntities 都不能绕过。
      newEntities: [{
        name: 'Nova',
        evidence: 'Nova has already been destroyed.',
        statement: 'Nova has been destroyed.',
      }],
    }))

    expect(calls('world-setting:create-candidate')).toHaveLength(0)
    expect(calls('world-setting:append-derived')).toHaveLength(0)
    expect(rawRow(upperId)).toEqual(beforeUpper)
    expect(rawRow(lowerId)).toEqual(beforeLower)
    expect(allEntries()).toHaveLength(2)
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('条新设定待确认'))
  })

  it('does not auto-append a duplicate alias reported as a new entity', async () => {
    const content = '旅人路过北境仙门。'
    const firstId = seedEntry({ name: '青云宗', content: '青云宗的原文', aliases: ['北境仙门'] })
    const secondId = seedEntry({ name: '太玄宗', content: '太玄宗的原文', aliases: ['北境仙门'] })
    const beforeFirst = rawRow(firstId)
    const beforeSecond = rawRow(secondId)

    const { calls } = await runFinalize(content, JSON.stringify({
      updates: [],
      conflicts: [],
      // 模型把「北境仙门」报成新实体，但它其实是两个条目的重复别名。
      newEntities: [{
        name: '北境仙门',
        evidence: '旅人路过北境仙门。',
        statement: '北境仙门出现了。',
      }],
    }))

    expect(calls('world-setting:append-derived')).toHaveLength(0)
    expect(calls('world-setting:create-candidate')).toHaveLength(0)
    expect(rawRow(firstId)).toEqual(beforeFirst)
    expect(rawRow(secondId)).toEqual(beforeSecond)
    expect(allEntries()).toHaveLength(2)
  })

  it('reports a name collision instead of overwriting when the entry appeared after the snapshot was read', async () => {
    // 过期快照：工作流读到的列表里没有「变身」（据此判定 unmatched、准备建候选），
    // 但在候选写入前，库里已经有作者确认的同名条目 —— 存储层必须拒绝，不能覆盖它。
    const content = '旅人独自离开了客栈，走向山路。'
    const appearedId = seedEntry({ name: '变身', content: '作者手写的原文' })
    const before = rawRow(appearedId)

    const { calls, log } = await runFinalize(content, JSON.stringify({
      updates: [],
      conflicts: [],
      newEntities: [{
        name: '变身',
        evidence: '旅人独自离开了客栈，走向山路。',
        statement: '变身会发生。',
      }],
    }), { listSnapshot: [] })

    // 工作流确实试图建候选（它看到的是空快照）……
    expect(calls('world-setting:create-candidate')).toHaveLength(1)
    // ……但真实仓储拒绝了：原行一字未动，也没有多出 pending 行。
    expect(rawRow(appearedId)).toEqual(before)
    expect(allEntries()).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('条候选因同名已存在未写入'))
  })
})
