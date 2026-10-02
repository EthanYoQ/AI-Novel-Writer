/**
 * 书架速览 —— 按路径**只读**打开另一个项目的 vela 库，聚合出首页卡片要显示的资料。
 *
 * 为什么需要它：产品是单项目架构（同一时刻只打开一个库），而书架上摆的是
 * 「最近打开过的项目」。要让「点哪本书就显示哪本书」成立，必须在不动用当前
 * 项目会话的前提下，短开一个只读连接去读对方的库 —— 不建表、不迁移、不写入，
 * 任何异常都降级成 null，由界面显示「读不到」而不是摆假数字。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import type { ProjectPeekOverview } from '../../src/shared/ipc-channels'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')

/** 「上一笔停在」最多取多少个字 */
const EXCERPT_LIMIT = 96

interface CoreRow {
  project_name: string | null
  genre: string | null
  sub_genre: string | null
  total_chapters: number | null
  words_per_chapter: number | null
  core_outline: string | null
  world_setting: string | null
  premise: string | null
  worldbuilding: string | null
  characters_arch: string | null
  synopsis: string | null
}

interface FocusRow {
  chapter_number: number
  draft_id: number
  word_count: number | null
}

/**
 * 卡片上的「简介」：与渲染层同一个口径 —— 取核心大纲的第一句话。
 * 空白归一化后再截断，避免正文里的缩进与换行把卡片撑变形。
 */
function firstSentence(value: string | null | undefined, max = EXCERPT_LIMIT): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const end = text.search(/[。！？!?]/)
  const sentence = end >= 0 ? text.slice(0, end + 1) : text
  return sentence.length > max ? `${sentence.slice(0, max)}…` : sentence
}

/** 尾部摘要：正文尾巴上的一句话，读不到就留空。 */
function tailExcerpt(value: string | null | undefined, max = EXCERPT_LIMIT): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const tail = text.slice(-max * 2)
  const parts = tail.split(/[。！？!?]/).filter((part) => part.trim().length > 0)
  const last = parts.length > 0 ? parts[parts.length - 1] : tail
  const sentence = last.trim()
  return sentence.length > max ? sentence.slice(-max) : sentence
}

/**
 * 表可能不存在（更早版本的库），所以每个查询都单独兜底：
 * 读不到就返回 undefined，由调用方把该字段降级成 null / 0。
 */
function safeGet<T>(db: BetterSqlite3.Database, sql: string, ...params: unknown[]): T | undefined {
  try {
    return db.prepare(sql).get(...params) as T
  } catch {
    return undefined
  }
}

/**
 * 只读打开目标项目的库。优先 readonly；如果库带 WAL 且只读连接打不开
 * （-shm 缺失等），退回普通打开 —— 后面只发 SELECT，不写任何业务数据。
 */
function openReadOnly(dbPath: string): BetterSqlite3.Database | null {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true })
  } catch {
    try {
      return new Database(dbPath, { fileMustExist: true })
    } catch {
      return null
    }
  }
}

export function peekProjectOverview(projectPath: string | null | undefined): ProjectPeekOverview | null {
  if (typeof projectPath !== 'string' || !projectPath.trim()) return null
  const dbPath = path.join(projectPath, '.vela', 'vela.db')
  if (!fs.existsSync(dbPath)) return null

  const db = openReadOnly(dbPath)
  if (!db) return null

  try {
    const core = safeGet<CoreRow>(
      db,
      `SELECT project_name, genre, sub_genre, total_chapters, words_per_chapter,
              core_outline, world_setting, premise, worldbuilding, characters_arch, synopsis
         FROM project_core WHERE id = 'main' LIMIT 1`,
    )

    // 每章最新一版：总字数与焦点章都按「最新版」计，与渲染层 summarizeDrafts 一致
    const latest = safeGet<{ drafted: number; total_words: number | null; newest_updated_at: string | null }>(
      db,
      `SELECT COUNT(*) AS drafted,
              COALESCE(SUM(latest.word_count), 0) AS total_words,
              MAX(latest.updated_at) AS newest_updated_at
         FROM (
           SELECT d.chapter_number, d.word_count, d.updated_at
             FROM drafts d
             JOIN (SELECT chapter_number, MAX(version) AS version FROM drafts GROUP BY chapter_number) m
               ON m.chapter_number = d.chapter_number AND m.version = d.version
         ) AS latest`,
    )

    // 定稿 / 审稿按章去重计数：该章只要有过一版定稿就算定稿（同样是渲染层的口径）
    const statusStats = safeGet<{ finalized: number; reviewed: number }>(
      db,
      `SELECT COUNT(DISTINCT CASE WHEN status = 'finalized' THEN chapter_number END) AS finalized,
              COUNT(DISTINCT CASE WHEN status IN ('finalized', 'reviewed') THEN chapter_number END) AS reviewed
         FROM drafts`,
    )

    // 焦点章 = 最近改动过的那一章（按每章最新版的 updated_at 排）
    const focus = safeGet<FocusRow>(
      db,
      `SELECT latest.chapter_number AS chapter_number,
              latest.id AS draft_id,
              latest.word_count AS word_count
         FROM (
           SELECT d.id, d.chapter_number, d.word_count, d.updated_at
             FROM drafts d
             JOIN (SELECT chapter_number, MAX(version) AS version FROM drafts GROUP BY chapter_number) m
               ON m.chapter_number = d.chapter_number AND m.version = d.version
         ) AS latest
        ORDER BY latest.updated_at DESC, latest.chapter_number DESC
        LIMIT 1`,
    )

    const focusBody = focus
      ? safeGet<{ body: string | null }>(
        db,
        `SELECT c.body AS body FROM drafts d JOIN contents c ON c.id = d.content_id WHERE d.id = ? LIMIT 1`,
        focus.draft_id,
      )
      : undefined

    const blueprintCount = safeGet<{ n: number }>(db, `SELECT COUNT(*) AS n FROM blueprints`)
    const characterCount = safeGet<{ n: number }>(db, `SELECT COUNT(*) AS n FROM characters`)
    // 待收伏笔：最新一条确认不是 resolved / abandoned 的都算还没收
    const threadsPending = safeGet<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM narrative_thread_plans p
        WHERE COALESCE(
          (SELECT c.event_type FROM narrative_thread_confirmations c
            WHERE c.plan_id = p.id ORDER BY c.id DESC LIMIT 1),
          'planted'
        ) NOT IN ('resolved', 'abandoned')`,
    )

    const genres = [core?.genre ?? '', core?.sub_genre ?? '']
      .map((value) => value.trim())
      .filter(Boolean)

    const plannedChapters = core?.total_chapters && core.total_chapters > 0
      ? core.total_chapters
      : null
    const targetWords = core?.words_per_chapter && core.words_per_chapter > 0
      ? core.words_per_chapter
      : null

    const draftedChapters = latest?.drafted ?? 0
    const totalWordsRaw = latest?.total_words ?? 0
    const focusWords = focus?.word_count ?? 0

    return {
      path: projectPath,
      name: (core?.project_name ?? '').trim() || path.basename(projectPath),
      genres,
      lede: firstSentence(core?.core_outline),
      totalWords: draftedChapters > 0 ? totalWordsRaw : null,
      draftedChapters,
      finalizedChapters: statusStats?.finalized ?? 0,
      reviewedOrBeyond: statusStats?.reviewed ?? 0,
      plannedChapters,
      blueprintChapters: blueprintCount?.n ?? null,
      characters: characterCount?.n ?? 0,
      threadsPending: threadsPending?.n ?? null,
      configReady: Boolean(
        (core?.core_outline ?? '').trim()
        || (core?.world_setting ?? '').trim()
        || (core?.genre ?? '').trim(),
      ),
      archReady: Boolean(
        (core?.premise ?? '').trim()
        || (core?.worldbuilding ?? '').trim()
        || (core?.characters_arch ?? '').trim()
        || (core?.synopsis ?? '').trim(),
      ),
      focusChapterNumber: focus?.chapter_number ?? null,
      focusDraftId: focus?.draft_id ?? null,
      focusWords,
      focusTargetWords: targetWords,
      focusExcerpt: tailExcerpt(focusBody?.body),
      savedAt: new Date().toISOString(),
    }
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      // 关闭失败不影响已经读到的结果
    }
  }
}
