/**
 * Vela SQLite 数据库服务 — 主进程使用
 *
 * 负责 SQLite 实例的连接、生命周期与建表。
 * 具体业务逻辑由 /repositories 提供。
 */
import { createRequire } from 'node:module'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { loadApplicationImportSourceSecret } from './services/import-source-identity-secret'
import { countDraftUnits } from '../src/shared/draft-units'
import { migrateDraftUnitCounts } from './services/draft-unit-migration'
import { builtinCategoryRecords } from '../src/shared/world-setting'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
import type BetterSqlite3 from 'better-sqlite3'
import { ensureCharacterRosterSchema } from './repositories/character-roster-schema'

let projectDb: BetterSqlite3.Database | null = null
let currentProjectPath: string | null = null

/** 初始化项目数据库（打开项目时调用） */
export function initProjectDatabase(projectPath: string, importSourceSecret?: Buffer): void {
  closeProjectDatabase()
  currentProjectPath = projectPath

  const dbPath = path.join(projectPath, '.vela', 'vela.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  projectDb = new Database(dbPath)
  projectDb.pragma('journal_mode = WAL')
  projectDb.pragma('foreign_keys = ON')
  // 写锁等待：WAL 下仍可能有两个连接同时写（例如后台工作流落盘与界面保存撞在一起），
  // 没有 busy_timeout 时 SQLite 会**立即**抛 SQLITE_BUSY，作者看到的是莫名其妙的保存失败。
  // 给 5 秒退让窗口，让后到的写请求排队而不是直接失败。
  projectDb.pragma('busy_timeout = 5000')

  // 创建表结构
  createTables(projectDb, importSourceSecret)
  console.log(`[Vela DB] 项目数据库已打开: ${dbPath}`)
}

/** 关闭项目数据库 */
export function closeProjectDatabase(): void {
  // Clear the process-visible identity before closing the native handle. If
  // the close itself throws, callers still fail closed instead of treating a
  // half-closed database as the active project.
  const closingDatabase = projectDb
  projectDb = null
  currentProjectPath = null
  closingDatabase?.close()
}

/** 获取当前数据库实例 */
export function getProjectDb(): BetterSqlite3.Database | null {
  return projectDb
}

/** 获取当前已打开项目路径 */
export function getCurrentProjectPath(): string | null {
  return currentProjectPath
}

/** 创建完整表结构（9 张核心表 + 2 张沿用表） */
function createTables(db: BetterSqlite3.Database, importSourceSecret?: Buffer) {
  db.exec(`
    -- ============================================================
    -- 1. project_core — 项目主台账（NovelConfig + 架构四大件）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS project_core (
      id TEXT PRIMARY KEY DEFAULT 'main',
      project_name TEXT NOT NULL DEFAULT '',      -- 小说工程名
      -- [基础定位]
      genre TEXT DEFAULT '',                      -- 核心流派
      sub_genre TEXT DEFAULT '',                  -- 细分流派
      target_audience TEXT DEFAULT '',            -- 目标受众
      total_chapters INTEGER DEFAULT 100,         -- 预计总章数
      words_per_chapter INTEGER DEFAULT 3000,     -- 单章基准字数
      writing_language TEXT NOT NULL DEFAULT 'zh-CN', -- 项目级写作语言
      creative_strategy TEXT NOT NULL DEFAULT 'auto', -- 项目级创作策略
      narrative_thread_dormant_threshold INTEGER NOT NULL DEFAULT 3,
      -- [写作技法]
      plot_structure TEXT DEFAULT 'three_act',    -- 故事模型
      narrative_pov TEXT DEFAULT 'third_limited', -- 叙事视角
      writing_style TEXT DEFAULT '',              -- 文风描述
      reference_works TEXT DEFAULT '',            -- 参考作品
      global_guidance TEXT DEFAULT '',            -- 全局行文指导
      golden_finger TEXT DEFAULT '',              -- 金手指设定
      core_outline TEXT DEFAULT '',               -- 作者配置核心大纲（独立于推演摘要）
      world_setting TEXT DEFAULT '',              -- 作者配置世界设定（独立于架构世界观）
      protagonist_profile TEXT DEFAULT '',        -- 作者配置主角档案（独立于角色名单投影）
      -- [架构四大件]
      premise TEXT DEFAULT '',                    -- 故事前提
      worldbuilding TEXT DEFAULT '',              -- 世界观
      characters_arch TEXT DEFAULT '',            -- 人物群像网络
      synopsis TEXT DEFAULT '',                   -- 情节总大纲
      -- [系统缓存]
      character_states TEXT DEFAULT '',           -- 全书角色动态快照
      plot_tree_snapshot TEXT NOT NULL DEFAULT '',-- 可重建的剧情树派生快照
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 2. blueprints — 章节蓝图
    -- ============================================================
    CREATE TABLE IF NOT EXISTS blueprints (
      chapter_number INTEGER PRIMARY KEY,         -- 章节序号
      title TEXT NOT NULL DEFAULT '',             -- 章节标题
      role TEXT DEFAULT '',                       -- 章节角色
      purpose TEXT DEFAULT '',                    -- 核心目的
      key_events TEXT DEFAULT '',                 -- 关键事件
      characters TEXT DEFAULT '[]',               -- 出场角色 (JSON Array)
      suspense_hook TEXT DEFAULT '',              -- 悬念钩子
      user_guidance TEXT DEFAULT '',              -- 用户预设指导
      notes TEXT DEFAULT '',                      -- 后处理提取的章节要点
      notes_updated_at TEXT DEFAULT '',           -- notes 提取时间
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 3. characters — 角色卡（currentState 拍平为 cs_* 列）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS characters (
      name TEXT PRIMARY KEY,                      -- 角色名
      role TEXT DEFAULT 'supporting',             -- protagonist/antagonist/supporting/minor
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      appearance TEXT DEFAULT '',                 -- 外貌
      personality TEXT DEFAULT '',                -- 性格
      background TEXT DEFAULT '',                 -- 背景
      abilities TEXT DEFAULT '',                  -- 能力
      motivation TEXT DEFAULT '',                 -- 动机
      relationships TEXT DEFAULT '',              -- 关系链（结构化边 JSON 数组）
      relationship_notes TEXT DEFAULT '',         -- 关系备注（作者的自由文本原话，与结构化边并存）
      arc TEXT DEFAULT '',                        -- 弧光
      notes TEXT DEFAULT '',                      -- 备忘录
      avatar TEXT NOT NULL DEFAULT '',            -- 自定义头像文件名（图片本体存 <项目>/.vela/avatars/）
      cs_location TEXT DEFAULT '',                -- 当前位置
      cs_power_level TEXT DEFAULT '',             -- 修为境界
      cs_physical_state TEXT DEFAULT '',          -- 身体状态
      cs_mental_state TEXT DEFAULT '',            -- 心理状态
      cs_key_items TEXT DEFAULT '',               -- 关键道具
      cs_recent_events TEXT DEFAULT '',           -- 最近事件
      cs_updated_at_chapter INTEGER DEFAULT NULL, -- 状态更新于第几章；NULL = 无 currentState
      cs_provenance TEXT NOT NULL DEFAULT '{}',   -- currentState 字段级来源
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 4. world_settings — 世界观设定条目（结构化事实源）
    -- 先生定的方向：世界观不再只是 project_core.worldbuilding 的一整段文本，
    -- 而是可分类、可检索、可被 @ 引用的一条条设定。
    -- ============================================================
    CREATE TABLE IF NOT EXISTS world_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL DEFAULT 'world',   -- world/faction/geography/history/rule/race/item/concept
      name TEXT NOT NULL,                       -- 条目名，如「青云宗」
      aliases TEXT NOT NULL DEFAULT '[]',       -- 别名 / 别称 (JSON Array)，检索时一并命中
      summary TEXT NOT NULL DEFAULT '',         -- 一句话摘要：列表显示 + 注入提示词优先用它
      content TEXT NOT NULL DEFAULT '',         -- 详情正文（长文本，按需读取）
      tags TEXT NOT NULL DEFAULT '[]',          -- 标签 (JSON Array)
      importance TEXT NOT NULL DEFAULT 'side',  -- main/side/background，决定提示词取舍顺序
      related TEXT NOT NULL DEFAULT '[]',       -- 关联条目 (JSON Array: [{target, relation}])
      source TEXT NOT NULL DEFAULT 'manual',    -- manual/ai/architecture，可追溯来源
      status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed/pending：pending 不注入生成与助手上下文
      -- 字段级来源 (JSON Object)。做这个是为了让定稿后的自动更新
      -- **只追加作者手写过的内容、绝不改写**（与人物状态 cs_provenance 同一思路）。
      provenance TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name)
    );
    CREATE INDEX IF NOT EXISTS idx_world_settings_category ON world_settings(category);

    -- ============================================================
    -- 5. world_setting_categories — 世界观设定的分类表
    -- 分类**不是封闭枚举**：内置八条在首次打开项目时写入（builtin = 1），作者可自建。
    -- 每个分类都带一句说明 —— 它同时是 AI 生成与定稿归纳「该归哪一类」的判据。
    -- 条目只存 key，分类改名不影响已有条目。
    -- ============================================================
    CREATE TABLE IF NOT EXISTS world_setting_categories (
      key TEXT PRIMARY KEY,                     -- 内置 key，或自建的 cat_<...>
      name_zh TEXT NOT NULL DEFAULT '',
      name_en TEXT NOT NULL DEFAULT '',
      description_zh TEXT NOT NULL DEFAULT '',
      description_en TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,       -- 1 = 内置，不可删
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 6. chapter_world_settings — 章节 ↔ 世界观设定的引用关系
    --
    -- 先生定的路线：设定**不做全量注入**，每一章只带「明确引用过」的那几条。
    -- 引用来源有三处：作者在条目页 @ 章节、在蓝图页手动添加、AI 生成蓝图时自己提出。
    -- 复合主键天然去重：同一章同一条设定只会有一行。
    -- ============================================================
    CREATE TABLE IF NOT EXISTS chapter_world_settings (
      chapter_number INTEGER NOT NULL,
      setting_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',   -- manual / ai，可追溯这次引用是谁提的
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (chapter_number, setting_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_world_settings_chapter ON chapter_world_settings(chapter_number);

    -- ============================================================
    -- 7. world_setting_conflicts — 正文与设定的冲突裁决队列
    --
    -- 定稿后 AI 能发现「正文与某条设定直接矛盾」，但**不知道该听哪边** ——
    -- 自动改等于赌。所以这里只记录，把裁决交给作者，并且让冲突
    -- 出现在作者能一键处理的地方（不必自己去设定库里逐条翻找）。
    -- 两个内容快照是刻意冗余的：裁决界面要并排展示「正文说了什么」与「条目原写什么」。
    -- ============================================================
    CREATE TABLE IF NOT EXISTS world_setting_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      setting_id INTEGER NOT NULL,
      setting_name TEXT NOT NULL DEFAULT '',
      setting_content_snapshot TEXT NOT NULL DEFAULT '',
      evidence TEXT NOT NULL DEFAULT '',
      statement TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',        -- open / resolved / ignored
      resolution TEXT,                            -- adopted-draft / kept-entry
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_world_setting_conflicts_status ON world_setting_conflicts(status);
    CREATE INDEX IF NOT EXISTS idx_world_setting_conflicts_chapter ON world_setting_conflicts(chapter_number);

    -- ============================================================
    -- 4. contents — 文本内容池（正文与元数据分离）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL DEFAULT '',              -- 正文/报告内容
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 5. drafts — 草稿主线（finalized = 定稿）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,            -- 归属章节
      version INTEGER NOT NULL,                   -- v1, v2...
      status TEXT DEFAULT 'draft',                -- draft/revised/finalized/archived
      source TEXT DEFAULT 'write',                -- write/rewrite
      content_id INTEGER NOT NULL,                -- FK -> contents
      word_count INTEGER DEFAULT 0,               -- 字数缓存
      source_dependencies TEXT NOT NULL DEFAULT '[]', -- ordered draft ids + frozen prose hashes
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_chapter ON drafts(chapter_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_chapter_version
      ON drafts(chapter_number, version);

    -- Failed generation output is a recoverable candidate, never a draft or
    -- finalized fact. It remains project-local and requires an explicit user
    -- action before entering an unsaved editor buffer.
    CREATE TABLE IF NOT EXISTS recovery_candidates (
      candidate_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      chapter_number INTEGER NOT NULL CHECK(chapter_number > 0),
      chapter_title TEXT NOT NULL DEFAULT '',
      source_snapshot TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_draft_id INTEGER DEFAULT NULL,
      source_draft_version INTEGER DEFAULT NULL,
      source_draft_identity_captured INTEGER NOT NULL DEFAULT 0
        CHECK(source_draft_identity_captured IN (0, 1)),
      visible_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      failure_code TEXT NOT NULL DEFAULT '',
      failure_reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'continued', 'discarded')),
      replaces_candidate_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT DEFAULT NULL,
      FOREIGN KEY (replaces_candidate_id) REFERENCES recovery_candidates(candidate_id)
    );
    CREATE INDEX IF NOT EXISTS idx_recovery_candidates_pending
      ON recovery_candidates(status, created_at);

    -- ============================================================
    -- 5b. finalization_outbox — 定稿实体稿发布投影
    -- SQLite 中的正文与定稿状态先在同一事务提交；根目录实体稿由此 outbox
    -- 异步发布，失败保持 pending 并可根据冻结快照精确重试。
    -- ============================================================
    CREATE TABLE IF NOT EXISTS finalization_outbox (
      finalization_id TEXT PRIMARY KEY,
      draft_id INTEGER NOT NULL UNIQUE,
      chapter_number INTEGER NOT NULL,
      chapter_title TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      content_revision INTEGER NOT NULL,
      content_snapshot TEXT NOT NULL DEFAULT '',
      target_file_name TEXT NOT NULL,
      knowledge_document_id TEXT NOT NULL DEFAULT '',
      publication_status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT NOT NULL DEFAULT '',
      published_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_finalization_outbox_status
      ON finalization_outbox(publication_status);

    -- 已定稿章节删除：SQLite 事实删除与投影清理收据在同一事务登记。
    -- 实体稿和知识库跨存储清理失败后，可按冻结身份幂等重试。
    CREATE TABLE IF NOT EXISTS chapter_deletion_operations (
      operation_id TEXT PRIMARY KEY,
      draft_id INTEGER NOT NULL UNIQUE,
      chapter_number INTEGER NOT NULL,
      chapter_title TEXT NOT NULL DEFAULT '',
      finalization_id TEXT NOT NULL,
      target_file_name TEXT NOT NULL DEFAULT '',
      knowledge_document_id TEXT NOT NULL DEFAULT '',
      post_process_run_ids TEXT NOT NULL DEFAULT '[]',
      manuscript_status TEXT NOT NULL DEFAULT 'pending',
      manuscript_error TEXT NOT NULL DEFAULT '',
      knowledge_status TEXT NOT NULL DEFAULT 'pending',
      knowledge_error TEXT NOT NULL DEFAULT '',
      legacy_knowledge_authorization TEXT NOT NULL DEFAULT 'not_required',
      legacy_knowledge_authorized_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_deletion_status
      ON chapter_deletion_operations(status);

    -- Imported finalized chapters are committed as one idempotent unit. The
    -- stored receipt is replayed only after the immutable draft/outbox facts
    -- have been verified again.
    CREATE TABLE IF NOT EXISTS finalized_draft_import_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Global facts inferred during import are committed as one idempotent
    -- unit: project core plus the authoritative structured character roster.
    CREATE TABLE IF NOT EXISTS import_global_fact_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 6. revisions — 修稿（派生自 draft）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,             -- 父草稿 FK
      revision_index INTEGER NOT NULL,            -- r1, r2
      revision_type TEXT NOT NULL,                -- refine | review-fix
      status TEXT DEFAULT 'pending',              -- pending/merged/discarded
      merged_to_draft_id INTEGER,                 -- 合并产出的新 draft
      user_prompt TEXT DEFAULT '',                -- 用户指导
      review_source_id INTEGER,                   -- 关联审稿 ID
      source_draft_chapter_number INTEGER,        -- 生成时冻结源稿章节
      source_draft_version INTEGER,               -- 生成时冻结源稿版本
      source_draft_status TEXT,                   -- 生成时冻结源稿状态
      source_content TEXT,                        -- 生成时冻结源稿正文
      content_id INTEGER NOT NULL,                -- FK -> contents
      word_count INTEGER DEFAULT 0,               -- 字数缓存
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_revisions_draft_index
      ON revisions(base_draft_id, revision_index);

    -- ============================================================
    -- 7. reviews — 审稿（派生自 draft）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,             -- 审查对象 FK
      review_index INTEGER NOT NULL,              -- 审阅顺位
      source_draft_chapter_number INTEGER,        -- 审稿时冻结源稿章节
      source_draft_version INTEGER,               -- 审稿时冻结源稿版本
      source_draft_status TEXT,                   -- 审稿时冻结源稿状态
      source_content TEXT,                        -- 审稿时冻结源稿正文
      content_id INTEGER NOT NULL,                -- FK -> contents
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_draft_index
      ON reviews(base_draft_id, review_index);

    -- ============================================================
    -- 8. post_process_runs — 后处理跑批实例
    -- ============================================================
    CREATE TABLE IF NOT EXISTS post_process_runs (
      id TEXT PRIMARY KEY,                        -- UUID
      trigger_source_type TEXT NOT NULL,           -- chapter_finalize / arch_extract
      trigger_source_id TEXT NOT NULL,             -- 章节号 / draft_id
      source_label TEXT DEFAULT '',               -- UI 标签
      all_critical_passed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_post_runs_source
      ON post_process_runs(trigger_source_type, trigger_source_id);

    -- ============================================================
    -- 9. post_process_steps — 后处理步骤明细
    -- ============================================================
    CREATE TABLE IF NOT EXISTS post_process_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,                       -- FK -> post_process_runs
      step_key TEXT NOT NULL,                     -- 步骤标识
      label TEXT DEFAULT '',                      -- 展示名称
      critical INTEGER DEFAULT 0,                 -- 是否关键步骤
      ok INTEGER DEFAULT 0,                       -- 是否完成
      error_msg TEXT DEFAULT '',
      attempt_count INTEGER DEFAULT 0,
      completed_at TEXT DEFAULT '',
      last_attempt_at TEXT DEFAULT '',
      FOREIGN KEY (run_id) REFERENCES post_process_runs(id) ON DELETE CASCADE
    );

    -- ============================================================
    -- 沿用表：LLM 调用记录
    -- ============================================================
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      model_name TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 正文新角色候选（定稿后从正文里发现、名单里还没有的重要具名角色）
    --
    -- 只存「等人裁决的提名单」，**不是事实源**：作者在角色页点采纳之后，才由
    -- 渲染进程走既有的角色卡新增通道建档（见 character-store.addNamedCharacters）。
    -- 与角色名单彻底分家，于是「模型提了名但作者没点头」永远不会污染角色卡。
    -- ============================================================
    CREATE TABLE IF NOT EXISTS character_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'supporting',
      evidence TEXT NOT NULL DEFAULT '',
      chapter_number INTEGER NOT NULL,
      current_state TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'adopted', 'dismissed')),
      created_at TEXT DEFAULT (datetime('now')),
      decided_at TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_character_candidates_status
      ON character_candidates(status, chapter_number);

    -- ============================================================
    -- 沿用表：角色状态快照
    -- ============================================================
    CREATE TABLE IF NOT EXISTS summary_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER DEFAULT NULL,
      chapter_number INTEGER NOT NULL,
      character_states TEXT DEFAULT '',
      chapter_notes TEXT NOT NULL DEFAULT '',
      continuity_facts TEXT NOT NULL DEFAULT '[]',
      character_state_candidates TEXT NOT NULL DEFAULT '[]',
      source_finalization_id TEXT NOT NULL DEFAULT '',
      source_content_hash TEXT NOT NULL DEFAULT '',
      projection_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS narrative_thread_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      target_start_chapter INTEGER NOT NULL CHECK(target_start_chapter > 0),
      target_end_chapter INTEGER NOT NULL CHECK(target_end_chapter >= target_start_chapter),
      author_intent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS narrative_thread_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      draft_id INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('planted', 'progressing', 'resolved', 'abandoned')),
      evidence TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (plan_id) REFERENCES narrative_thread_plans(id) ON DELETE CASCADE,
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      UNIQUE(plan_id, draft_id, event_type, evidence)
    );
    CREATE INDEX IF NOT EXISTS idx_narrative_thread_confirmations_plan
      ON narrative_thread_confirmations(plan_id, draft_id, id);

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_llm_calls_time ON llm_calls(created_at);

    -- Reference imports are recoverable project facts, not generic workflow history.
    CREATE TABLE IF NOT EXISTS import_runs (
      id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL DEFAULT 'reference'
        CHECK(purpose IN ('reference', 'author-manuscript')),
      root_run_id TEXT NOT NULL,
      effect_namespace TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      manifest_fingerprint TEXT NOT NULL,
      authority_fingerprint TEXT NOT NULL DEFAULT '',
      legacy_source_fingerprint TEXT NOT NULL DEFAULT '',
      source_display_json TEXT NOT NULL DEFAULT '[]',
      locale TEXT NOT NULL CHECK(locale IN ('zh-CN', 'en-US')),
      stage TEXT NOT NULL DEFAULT 'knowledge'
        CHECK(stage IN (
          'parsing', 'prepared', 'knowledge', 'global', 'style', 'blueprints',
          'author-commit', 'author-publish', 'author-postprocess',
          'refresh', 'completed'
        )),
      status TEXT NOT NULL DEFAULT 'ready'
        CHECK(status IN ('ready', 'running', 'failed', 'cancelled', 'completed')),
      completed_batches_json TEXT NOT NULL DEFAULT '{}',
      last_error TEXT NOT NULL DEFAULT '',
      resumable INTEGER NOT NULL DEFAULT 1 CHECK(resumable IN (0, 1)),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
      execution_owner TEXT NOT NULL DEFAULT '',
      execution_epoch INTEGER NOT NULL DEFAULT 0,
      lease_expires_at INTEGER NOT NULL DEFAULT 0,
      total_chapters INTEGER NOT NULL,
      total_content_size INTEGER NOT NULL DEFAULT 0,
      manifest_chapter_count INTEGER NOT NULL,
      manifest_content_size INTEGER NOT NULL DEFAULT 0,
      manifest_word_count INTEGER NOT NULL DEFAULT 0,
      completed_chapters INTEGER NOT NULL DEFAULT 0,
      base_run_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY (base_run_id) REFERENCES import_runs(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_import_runs_source_status
      ON import_runs(source_fingerprint, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_import_runs_resumable
      ON import_runs(resumable, status, updated_at);

    CREATE TABLE IF NOT EXISTS import_run_chapters (
      run_id TEXT NOT NULL,
      chapter_number INTEGER NOT NULL,
      source_id TEXT NOT NULL DEFAULT '',
      source_chapter_number INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '',
      content_fingerprint TEXT NOT NULL,
      content_size INTEGER NOT NULL,
      content_snapshot TEXT NOT NULL,
      PRIMARY KEY (run_id, chapter_number),
      FOREIGN KEY (run_id) REFERENCES import_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_import_run_chapters_page
      ON import_run_chapters(run_id, chapter_number);

    CREATE TABLE IF NOT EXISTS import_run_sources (
      run_id TEXT NOT NULL,
      source_index INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      legacy_source_fingerprint TEXT NOT NULL DEFAULT '',
      display_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
      manifest_fingerprint TEXT NOT NULL DEFAULT '',
      chapter_count INTEGER NOT NULL DEFAULT 0,
      content_size INTEGER NOT NULL DEFAULT 0,
      word_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, source_id),
      UNIQUE (run_id, source_index),
      FOREIGN KEY (run_id) REFERENCES import_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS import_run_source_chapters (
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_chapter_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL,
      content_size INTEGER NOT NULL,
      word_count INTEGER NOT NULL,
      content_snapshot TEXT NOT NULL,
      PRIMARY KEY (run_id, source_id, source_chapter_number),
      FOREIGN KEY (run_id, source_id) REFERENCES import_run_sources(run_id, source_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_import_run_source_chapters
      ON import_run_source_chapters(run_id, source_id, source_chapter_number);

    CREATE TABLE IF NOT EXISTS import_legacy_identity_bridge (
      id TEXT PRIMARY KEY,
      ciphertext_hex TEXT NOT NULL,
      iv_hex TEXT NOT NULL,
      auth_tag_hex TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS import_source_aliases (
      alias_digest TEXT PRIMARY KEY,
      alias_kind TEXT NOT NULL CHECK(alias_kind IN ('location', 'file')),
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_import_source_aliases_source
      ON import_source_aliases(source_id);

    CREATE TABLE IF NOT EXISTS import_source_chapter_map (
      purpose TEXT NOT NULL CHECK(purpose IN ('reference', 'author-manuscript')),
      source_id TEXT NOT NULL,
      source_chapter_number INTEGER NOT NULL,
      chapter_number INTEGER NOT NULL,
      PRIMARY KEY (purpose, source_id, source_chapter_number),
      UNIQUE (purpose, chapter_number)
    );

    CREATE TABLE IF NOT EXISTS import_run_receipts (
      run_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      effect_namespace TEXT NOT NULL,
      effect_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared', 'committed')),
      effect_receipt_json TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, stage, batch_id),
      UNIQUE (effect_namespace, effect_key),
      FOREIGN KEY (run_id) REFERENCES import_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_import_run_receipts_state
      ON import_run_receipts(run_id, state, stage);

    CREATE TABLE IF NOT EXISTS import_run_knowledge_receipts (
      run_id TEXT NOT NULL,
      chapter_number INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_chapter_number INTEGER NOT NULL,
      content_fingerprint TEXT NOT NULL,
      document_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state = 'committed'),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (run_id, chapter_number),
      FOREIGN KEY (run_id, chapter_number)
        REFERENCES import_run_chapters(run_id, chapter_number) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_import_run_knowledge_receipts_affiliation
      ON import_run_knowledge_receipts(
        purpose, source_id, source_chapter_number, content_fingerprint, state
      );

    CREATE TABLE IF NOT EXISTS import_reference_documents (
      document_id TEXT PRIMARY KEY,
      idempotency_key_hash TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      chunk_set_hash TEXT NOT NULL,
      expected_chunk_count INTEGER NOT NULL,
      corpus_kind TEXT NOT NULL CHECK(corpus_kind = 'reference'),
      state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared', 'committed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ============================================================
    -- 14. 便利贴 —— 作者私有的灵感本子
    --
    -- 与其它所有表的根本区别：**便利贴不参与任何 AI 创作链路**。
    -- 写稿、定稿、审稿、助手上下文一处都不读它，因此它不需要
    -- world_settings 那套 pending/confirmed 闸门 —— 本子里没有
    -- 「待确认的事实」，只有作者自己写给自己看的东西。
    --
    -- 它是项目级数据（跟着书走），但「清除项目生成内容」的范围
    -- （project-clear-repository）刻意**不含**这三张表：那些删的都是
    -- AI 生成物，而便利贴是先生亲手敲的。
    -- ============================================================
    -- 便利贴的文件夹（先生 2026-09-20）：便利贴攒多了要能收纳。
    -- 只做一层 —— 侧栏本来就只有二百多像素宽，套两层反而是折磨。
    CREATE TABLE IF NOT EXISTS sticky_folders (
      folder_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sticky_notes (
      note_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      -- 所属文件夹；NULL = 直接放在便利贴根下。文件夹删掉时这里会被清回 NULL，
      -- 里面的便利贴**不跟着删** —— 收纳工具不该顺手毁掉作者写的东西。
      folder_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sticky_notes_created
      ON sticky_notes(created_at);

    -- 一次抽卡的输入存档。先生过两周打开待选箱时，只有这张表答得上
    -- 「这张卡当初是在什么前提下抽出来的」。
    CREATE TABLE IF NOT EXISTS sticky_draws (
      draw_id TEXT PRIMARY KEY,
      include_premise INTEGER NOT NULL DEFAULT 0 CHECK(include_premise IN (0, 1)),
      include_characters INTEGER NOT NULL DEFAULT 0 CHECK(include_characters IN (0, 1)),
      include_worldbuilding INTEGER NOT NULL DEFAULT 0 CHECK(include_worldbuilding IN (0, 1)),
      include_synopsis INTEGER NOT NULL DEFAULT 0 CHECK(include_synopsis IN (0, 1)),
      mentions TEXT NOT NULL DEFAULT '[]',
      idea TEXT NOT NULL DEFAULT '',
      requested_count INTEGER NOT NULL DEFAULT 1 CHECK(requested_count > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 待选箱：抽卡时没被选中的点子落在这里，可以随时找回。
    -- status 只改不删（找回即 pending → used），照 recovery_candidates 的
    -- 状态机范式；先生明确同意「清空待选箱」才物理删除，且不可找回。
    CREATE TABLE IF NOT EXISTS sticky_candidates (
      candidate_id TEXT PRIMARY KEY,
      draw_id TEXT NOT NULL,
      content TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'used')),
      note_id TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      used_at TEXT DEFAULT NULL,
      FOREIGN KEY (draw_id) REFERENCES sticky_draws(draw_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sticky_candidates_pending
      ON sticky_candidates(status, ordinal);
  `)

  const draftColumns = db.prepare('PRAGMA table_info(drafts)').all() as Array<{ name: string }>
  if (!draftColumns.some(column => column.name === 'source_dependencies')) {
    db.exec("ALTER TABLE drafts ADD COLUMN source_dependencies TEXT NOT NULL DEFAULT '[]'")
  }

  /**
   * 便利贴文件夹：老库补归属列。
   *
   * 存量便利贴一律留在根下（folder_id = NULL）—— 迁移不该自作主张把它们
   * 塞进某个文件夹里；先生自己分的那才叫分类。
   */
  const stickyNoteColumns = new Set(
    (db.prepare('PRAGMA table_info(sticky_notes)').all() as Array<{ name: string }>)
      .map(column => column.name),
  )
  if (!stickyNoteColumns.has('folder_id')) {
    db.exec('ALTER TABLE sticky_notes ADD COLUMN folder_id TEXT DEFAULT NULL')
  }

  // Legacy candidates did not freeze the draft identity. Keep them marked
  // unknown so update/continue fails closed instead of rebinding to today's draft.
  const recoveryCandidateColumns = new Set(
    (db.prepare('PRAGMA table_info(recovery_candidates)').all() as Array<{ name: string }>).map(column => column.name),
  )
  if (!recoveryCandidateColumns.has('source_draft_id')) {
    db.exec('ALTER TABLE recovery_candidates ADD COLUMN source_draft_id INTEGER')
  }
  if (!recoveryCandidateColumns.has('source_draft_version')) {
    db.exec('ALTER TABLE recovery_candidates ADD COLUMN source_draft_version INTEGER')
  }
  if (!recoveryCandidateColumns.has('source_draft_identity_captured')) {
    db.exec('ALTER TABLE recovery_candidates ADD COLUMN source_draft_identity_captured INTEGER NOT NULL DEFAULT 0')
  }

  // Legacy rows cannot be safely rebound to today's mutable draft body. Add
  // nullable columns and leave old source identity unknown so merge/refine can fail closed.
  for (const table of ['revisions', 'reviews'] as const) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name),
    )
    const addSourceColumn = (name: string, type: string) => {
      if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
    }
    addSourceColumn('source_draft_chapter_number', 'INTEGER')
    addSourceColumn('source_draft_version', 'INTEGER')
    addSourceColumn('source_draft_status', 'TEXT')
    addSourceColumn('source_content', 'TEXT')
  }

  // Durable continuity facts were added to the existing summary projection so
  // older projects keep their legacy snapshots while new rows bind to a
  // finalized draft identity.
  const summaryColumns = new Set(
    (db.prepare('PRAGMA table_info(summary_snapshots)').all() as Array<{ name: string }>).map(column => column.name),
  )
  if (!summaryColumns.has('draft_id')) {
    db.exec(`
      ALTER TABLE summary_snapshots
      ADD COLUMN draft_id INTEGER DEFAULT NULL REFERENCES drafts(id) ON DELETE CASCADE
    `)
  }
  if (!summaryColumns.has('chapter_notes')) {
    db.exec("ALTER TABLE summary_snapshots ADD COLUMN chapter_notes TEXT NOT NULL DEFAULT ''")
  }
  if (!summaryColumns.has('continuity_facts')) {
    db.exec("ALTER TABLE summary_snapshots ADD COLUMN continuity_facts TEXT NOT NULL DEFAULT '[]'")
  }
  if (!summaryColumns.has('character_state_candidates')) {
    db.exec("ALTER TABLE summary_snapshots ADD COLUMN character_state_candidates TEXT NOT NULL DEFAULT '[]'")
  }
  if (!summaryColumns.has('source_finalization_id')) {
    db.exec("ALTER TABLE summary_snapshots ADD COLUMN source_finalization_id TEXT NOT NULL DEFAULT ''")
  }
  if (!summaryColumns.has('source_content_hash')) {
    db.exec("ALTER TABLE summary_snapshots ADD COLUMN source_content_hash TEXT NOT NULL DEFAULT ''")
  }
  if (!summaryColumns.has('projection_generation')) {
    db.exec('ALTER TABLE summary_snapshots ADD COLUMN projection_generation INTEGER NOT NULL DEFAULT 0')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS continuity_projection_meta (
      id TEXT PRIMARY KEY CHECK (id = 'main'),
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      stale_from_chapter INTEGER DEFAULT NULL CHECK (stale_from_chapter IS NULL OR stale_from_chapter > 0)
    );
    INSERT OR IGNORE INTO continuity_projection_meta (id) VALUES ('main');
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_snapshots_draft
      ON summary_snapshots(draft_id) WHERE draft_id IS NOT NULL
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS consistency_exemptions (
      stable_fact_key TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
    )
  `)

  // Import-run columns were introduced incrementally during pre-release development.
  // Existing project databases must receive the same lease and manifest invariants.
  const importRunColumns = new Set(
    (db.prepare('PRAGMA table_info(import_runs)').all() as Array<{ name: string }>).map(column => column.name),
  )
  const addImportRunColumn = (name: string, definition: string) => {
    if (importRunColumns.has(name)) return
    db.exec(`ALTER TABLE import_runs ADD COLUMN ${name} ${definition}`)
    importRunColumns.add(name)
  }
  addImportRunColumn('execution_owner', "TEXT NOT NULL DEFAULT ''")
  addImportRunColumn('execution_epoch', 'INTEGER NOT NULL DEFAULT 0')
  addImportRunColumn('lease_expires_at', 'INTEGER NOT NULL DEFAULT 0')
  addImportRunColumn('manifest_chapter_count', 'INTEGER NOT NULL DEFAULT 0')
  addImportRunColumn('manifest_content_size', 'INTEGER NOT NULL DEFAULT 0')
  addImportRunColumn('manifest_word_count', 'INTEGER NOT NULL DEFAULT 0')
  addImportRunColumn('purpose', "TEXT NOT NULL DEFAULT 'reference'")
  addImportRunColumn('root_run_id', "TEXT NOT NULL DEFAULT ''")
  addImportRunColumn('effect_namespace', "TEXT NOT NULL DEFAULT ''")
  addImportRunColumn('authority_fingerprint', "TEXT NOT NULL DEFAULT ''")
  addImportRunColumn('legacy_source_fingerprint', "TEXT NOT NULL DEFAULT ''")
  db.exec(`
    UPDATE import_runs
    SET manifest_chapter_count = CASE WHEN manifest_chapter_count = 0 THEN total_chapters ELSE manifest_chapter_count END,
        manifest_content_size = CASE WHEN manifest_content_size = 0 THEN total_content_size ELSE manifest_content_size END,
        root_run_id = CASE WHEN root_run_id = '' THEN id ELSE root_run_id END,
        effect_namespace = CASE WHEN effect_namespace = '' THEN 'import:reference:' || id ELSE effect_namespace END
  `)
  const importRunSchema = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'import_runs'
  `).get() as { sql: string } | undefined
  if (
    importRunSchema
    && (!importRunSchema.sql.includes("'parsing'") || !importRunSchema.sql.includes("'author-commit'"))
  ) {
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE import_runs_stage_v3 (
            id TEXT PRIMARY KEY,
            purpose TEXT NOT NULL DEFAULT 'reference' CHECK(purpose IN ('reference', 'author-manuscript')),
            root_run_id TEXT NOT NULL,
            effect_namespace TEXT NOT NULL,
            source_fingerprint TEXT NOT NULL,
            manifest_fingerprint TEXT NOT NULL,
            authority_fingerprint TEXT NOT NULL DEFAULT '',
            legacy_source_fingerprint TEXT NOT NULL DEFAULT '',
            source_display_json TEXT NOT NULL DEFAULT '[]',
            locale TEXT NOT NULL CHECK(locale IN ('zh-CN', 'en-US')),
            stage TEXT NOT NULL DEFAULT 'knowledge'
              CHECK(stage IN (
                'parsing', 'prepared', 'knowledge', 'global', 'style', 'blueprints',
                'author-commit', 'author-publish', 'author-postprocess',
                'refresh', 'completed'
              )),
            status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready', 'running', 'failed', 'cancelled', 'completed')),
            completed_batches_json TEXT NOT NULL DEFAULT '{}',
            last_error TEXT NOT NULL DEFAULT '',
            resumable INTEGER NOT NULL DEFAULT 1 CHECK(resumable IN (0, 1)),
            cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
            execution_owner TEXT NOT NULL DEFAULT '',
            execution_epoch INTEGER NOT NULL DEFAULT 0,
            lease_expires_at INTEGER NOT NULL DEFAULT 0,
            total_chapters INTEGER NOT NULL,
            total_content_size INTEGER NOT NULL DEFAULT 0,
            manifest_chapter_count INTEGER NOT NULL,
            manifest_content_size INTEGER NOT NULL DEFAULT 0,
            manifest_word_count INTEGER NOT NULL DEFAULT 0,
            completed_chapters INTEGER NOT NULL DEFAULT 0,
            base_run_id TEXT DEFAULT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT DEFAULT NULL,
            FOREIGN KEY (base_run_id) REFERENCES import_runs_stage_v3(id) ON DELETE SET NULL
          );
          INSERT INTO import_runs_stage_v3 (
            id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint,
            authority_fingerprint, legacy_source_fingerprint,
            source_display_json, locale, stage, status, completed_batches_json, last_error,
            resumable, cancel_requested, execution_owner, execution_epoch, lease_expires_at,
            total_chapters, total_content_size, manifest_chapter_count, manifest_content_size,
            manifest_word_count, completed_chapters, base_run_id, created_at, updated_at, completed_at
          )
          SELECT
            id, purpose, root_run_id, effect_namespace, source_fingerprint, manifest_fingerprint,
            authority_fingerprint, legacy_source_fingerprint,
            source_display_json, locale, stage, status, completed_batches_json, last_error,
            resumable, cancel_requested, execution_owner, execution_epoch, lease_expires_at,
            total_chapters, total_content_size, manifest_chapter_count, manifest_content_size,
            manifest_word_count, completed_chapters, base_run_id, created_at, updated_at, completed_at
          FROM import_runs;
          DROP TABLE import_runs;
          ALTER TABLE import_runs_stage_v3 RENAME TO import_runs;
          CREATE INDEX idx_import_runs_source_status ON import_runs(source_fingerprint, status, updated_at);
          CREATE INDEX idx_import_runs_resumable ON import_runs(resumable, status, updated_at);
        `)
      })()
    } finally {
      db.pragma('foreign_keys = ON')
    }
    const violations = db.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) throw new Error('导入运行阶段迁移破坏了外键约束')
  }
  const importChapterColumns = new Set(
    (db.prepare('PRAGMA table_info(import_run_chapters)').all() as Array<{ name: string }>).map(column => column.name),
  )
  if (!importChapterColumns.has('source_id')) {
    db.exec("ALTER TABLE import_run_chapters ADD COLUMN source_id TEXT NOT NULL DEFAULT ''")
  }
  if (!importChapterColumns.has('source_chapter_number')) {
    db.exec('ALTER TABLE import_run_chapters ADD COLUMN source_chapter_number INTEGER NOT NULL DEFAULT 0')
  }
  db.exec(`
    UPDATE import_run_chapters
    SET source_id = 'legacy:' || COALESCE((
          SELECT runs.source_fingerprint FROM import_runs AS runs WHERE runs.id = import_run_chapters.run_id
        ), run_id),
        source_chapter_number = chapter_number
    WHERE source_id = '' OR source_chapter_number = 0;

    CREATE TABLE IF NOT EXISTS import_source_chapter_map (
      purpose TEXT NOT NULL CHECK(purpose IN ('reference', 'author-manuscript')),
      source_id TEXT NOT NULL,
      source_chapter_number INTEGER NOT NULL,
      chapter_number INTEGER NOT NULL,
      PRIMARY KEY (purpose, source_id, source_chapter_number),
      UNIQUE (purpose, chapter_number)
    );

    INSERT OR IGNORE INTO import_source_chapter_map (
      purpose, source_id, source_chapter_number, chapter_number
    )
    SELECT runs.purpose, chapters.source_id, chapters.source_chapter_number, chapters.chapter_number
    FROM import_run_chapters AS chapters
    JOIN import_runs AS runs ON runs.id = chapters.run_id
    ORDER BY runs.created_at, runs.rowid, chapters.chapter_number;
  `)
  const unmappedLegacyChapters = db.prepare(`
    SELECT DISTINCT runs.purpose, chapters.source_id, chapters.source_chapter_number
    FROM import_run_chapters AS chapters
    JOIN import_runs AS runs ON runs.id = chapters.run_id
    LEFT JOIN import_source_chapter_map AS source_map
      ON source_map.purpose = runs.purpose
      AND source_map.source_id = chapters.source_id
      AND source_map.source_chapter_number = chapters.source_chapter_number
    WHERE source_map.chapter_number IS NULL
    ORDER BY runs.created_at, runs.rowid, chapters.chapter_number
  `).all() as Array<{
    purpose: 'reference' | 'author-manuscript'
    source_id: string
    source_chapter_number: number
  }>
  const nextLegacyChapterByPurpose = new Map<string, number>()
  const insertLegacySourceMapping = db.prepare(`
    INSERT INTO import_source_chapter_map (
      purpose, source_id, source_chapter_number, chapter_number
    ) VALUES (?, ?, ?, ?)
  `)
  db.transaction(() => {
    for (const chapter of unmappedLegacyChapters) {
      let next = nextLegacyChapterByPurpose.get(chapter.purpose)
      if (next === undefined) {
        next = (db.prepare(`
          SELECT COALESCE(MAX(chapter_number), 0) AS value
          FROM import_source_chapter_map WHERE purpose = ?
        `).get(chapter.purpose) as { value: number }).value
      }
      next += 1
      nextLegacyChapterByPurpose.set(chapter.purpose, next)
      insertLegacySourceMapping.run(
        chapter.purpose,
        chapter.source_id,
        chapter.source_chapter_number,
        next,
      )
    }
  })()
  const legacyManifestRuns = db.prepare(`
    SELECT id, locale, manifest_chapter_count
    FROM import_runs
    WHERE manifest_word_count = 0 AND status <> 'completed' AND resumable = 1
      AND stage NOT IN ('parsing', 'prepared')
  `).all() as Array<{
    id: string
    locale: 'zh-CN' | 'en-US'
    manifest_chapter_count: number
  }>
  const readLegacySnapshots = db.prepare(`
    SELECT content_fingerprint, content_size, content_snapshot
    FROM import_run_chapters
    WHERE run_id = ?
    ORDER BY chapter_number
  `)
  const saveLegacyWordCount = db.prepare(`
    UPDATE import_runs
    SET manifest_word_count = ?, updated_at = datetime('now')
    WHERE id = ?
  `)
  const rejectLegacyResume = db.prepare(`
    UPDATE import_runs
    SET status = 'failed', resumable = 0, cancel_requested = 0, last_error = ?,
        execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
        updated_at = datetime('now')
    WHERE id = ?
  `)
  db.transaction(() => {
    for (const run of legacyManifestRuns) {
      const snapshots = readLegacySnapshots.all(run.id) as Array<{
        content_fingerprint: string
        content_size: number
        content_snapshot: string
      }>
      const snapshotsAreComplete = run.manifest_chapter_count > 0
        && snapshots.length === run.manifest_chapter_count
        && snapshots.every(snapshot =>
          snapshot.content_snapshot.length > 0
          && Buffer.byteLength(snapshot.content_snapshot, 'utf8') === snapshot.content_size
          && createHash('sha256').update(snapshot.content_snapshot).digest('hex') === snapshot.content_fingerprint,
        )
      if (snapshotsAreComplete) {
        saveLegacyWordCount.run(
          snapshots.reduce((total, snapshot) => total + countDraftUnits(snapshot.content_snapshot), 0),
          run.id,
        )
        continue
      }
      rejectLegacyResume.run(
        run.locale === 'en-US'
          ? 'This legacy import is missing complete frozen chapter snapshots and cannot be resumed. Select the source again to restart.'
          : '该旧导入缺少完整的冻结章节快照，不可恢复；请重新选择来源后开始。',
        run.id,
      )
    }
  })()
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_import_runs_source_status
      ON import_runs(source_fingerprint, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_import_runs_resumable
      ON import_runs(resumable, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_import_runs_purpose_source_status
      ON import_runs(purpose, source_fingerprint, status, updated_at);
  `)
  const importReceiptColumns = new Set(
    (db.prepare('PRAGMA table_info(import_run_receipts)').all() as Array<{ name: string }>).map(column => column.name),
  )
  if (!importReceiptColumns.has('schema_version')) {
    db.exec('ALTER TABLE import_run_receipts ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1')
  }
  const legacyIdentityTable = db.prepare(`
    SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = 'import_source_identity'
  `).get() as { value: number } | undefined
  if (legacyIdentityTable) {
    const migrationSecret = importSourceSecret ?? loadApplicationImportSourceSecret()
    if (!Buffer.isBuffer(migrationSecret) || migrationSecret.byteLength !== 32) {
      throw new Error('旧导入来源身份迁移需要有效的应用密钥')
    }
    const legacy = db.prepare('SELECT salt_hex FROM import_source_identity WHERE id = ?')
      .get('main') as { salt_hex: string } | undefined
    if (legacy) {
      const salt = Buffer.from(legacy.salt_hex, 'hex')
      if (salt.byteLength !== 32) throw new Error('旧导入来源身份盐损坏')
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', migrationSecret, iv)
      cipher.setAAD(Buffer.from('ai-novel:legacy-import-source-salt:v1', 'utf8'))
      const ciphertext = Buffer.concat([cipher.update(salt), cipher.final()])
      db.prepare(`
        INSERT OR REPLACE INTO import_legacy_identity_bridge (
          id, ciphertext_hex, iv_hex, auth_tag_hex
        ) VALUES ('main', ?, ?, ?)
      `).run(ciphertext.toString('hex'), iv.toString('hex'), cipher.getAuthTag().toString('hex'))
    }
    db.exec('DROP TABLE import_source_identity')
  }
  // Opening a project database is a process/session boundary. Any persisted
  // running owner belonged to the previous handle and must be fenced before a
  // new renderer can resume the run.
  db.exec(`
    UPDATE import_runs
    SET execution_owner = '', execution_epoch = execution_epoch + 1, lease_expires_at = 0,
        updated_at = datetime('now')
    WHERE status = 'running' AND (execution_owner <> '' OR lease_expires_at <> 0)
  `)

  // 角色事实继续存放于 characters；这里仅建立 revision、迁移与幂等元数据。
  // 旧角色图谱原文在首次打开时只归档，不自动解析或改写。
  ensureCharacterRosterSchema(db)

  // 兼容早期 #23 预览数据库：该表一旦已经存在，CREATE TABLE IF NOT EXISTS
  // 不会补列。正文快照必须留在 outbox，重试时不能再从可变 contents.body 回读。
  const outboxColumns = db.prepare('PRAGMA table_info(finalization_outbox)').all() as Array<{ name: string }>
  const addedContentSnapshotColumn = !outboxColumns.some(column => column.name === 'content_snapshot')
  if (addedContentSnapshotColumn) {
    db.exec(`
      ALTER TABLE finalization_outbox
      ADD COLUMN content_snapshot TEXT NOT NULL DEFAULT ''
    `)
    // 只在本次确实新增列时回填旧行。之后空正文也可能是合法冻结快照，绝不能在
    // 每次项目重开时又把它替换为可变 contents.body。
    db.exec(`
      UPDATE finalization_outbox
      SET content_snapshot = COALESCE((
        SELECT contents.body
        FROM drafts
        JOIN contents ON contents.id = drafts.content_id
        WHERE drafts.id = finalization_outbox.draft_id
      ), '')
      WHERE content_snapshot = ''
    `)
  }
  if (!outboxColumns.some(column => column.name === 'knowledge_document_id')) {
    db.exec(`
      ALTER TABLE finalization_outbox
      ADD COLUMN knowledge_document_id TEXT NOT NULL DEFAULT ''
    `)
  }

  const deletionColumns = new Set(
    (db.prepare('PRAGMA table_info(chapter_deletion_operations)').all() as Array<{ name: string }>)
      .map(column => column.name),
  )
  const addDeletionTextColumn = (column: string, defaultValue: string) => {
    if (deletionColumns.has(column)) return
    db.exec(`ALTER TABLE chapter_deletion_operations ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${defaultValue}'`)
    deletionColumns.add(column)
  }
  addDeletionTextColumn('legacy_knowledge_authorization', 'not_required')
  addDeletionTextColumn('legacy_knowledge_authorized_at', '')

  // 旧项目把作者配置字段映射到架构字段，导致重开漂移。新列保持独立事实：
  // 大纲和世界设定可从旧显示来源无损继承；主角档案绝不复制 characters_arch，
  // 因为后者是结构化角色名单的派生投影。
  const projectCoreColumns = new Set(
    (db.prepare('PRAGMA table_info(project_core)').all() as Array<{ name: string }>).map(column => column.name),
  )
  const addProjectCoreTextColumn = (column: string, legacySource?: string) => {
    if (projectCoreColumns.has(column)) return
    db.exec(`ALTER TABLE project_core ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`)
    if (legacySource) db.exec(`UPDATE project_core SET ${column} = COALESCE(${legacySource}, '')`)
    projectCoreColumns.add(column)
  }
  addProjectCoreTextColumn('core_outline', 'synopsis')
  addProjectCoreTextColumn('world_setting', 'worldbuilding')
  addProjectCoreTextColumn('protagonist_profile')
  addProjectCoreTextColumn('plot_tree_snapshot')
  if (!projectCoreColumns.has('writing_language')) {
    db.exec("ALTER TABLE project_core ADD COLUMN writing_language TEXT NOT NULL DEFAULT 'zh-CN'")
    projectCoreColumns.add('writing_language')
  }
  if (!projectCoreColumns.has('creative_strategy')) {
    db.exec("ALTER TABLE project_core ADD COLUMN creative_strategy TEXT NOT NULL DEFAULT 'auto'")
    projectCoreColumns.add('creative_strategy')
  }
  if (!projectCoreColumns.has('narrative_thread_dormant_threshold')) {
    db.exec('ALTER TABLE project_core ADD COLUMN narrative_thread_dormant_threshold INTEGER NOT NULL DEFAULT 3')
    projectCoreColumns.add('narrative_thread_dormant_threshold')
  }

  const characterStateColumns = new Set(
    (db.prepare('PRAGMA table_info(characters)').all() as Array<{ name: string }>).map(column => column.name),
  )
  if (!characterStateColumns.has('cs_provenance')) {
    db.exec("ALTER TABLE characters ADD COLUMN cs_provenance TEXT NOT NULL DEFAULT '{}'")
  }
  // 自定义头像只记文件名，图片本体存 <项目>/.vela/avatars/；旧库补列即得空头像。
  if (!characterStateColumns.has('avatar')) {
    db.exec("ALTER TABLE characters ADD COLUMN avatar TEXT NOT NULL DEFAULT ''")
  }

  /**
   * 角色候选：旧库补 current_state 列。
   *
   * 提示词一直要求 `newCharacters` 带 currentState，而候选表当初没有存它的地方 ——
   * 于是采纳建档出来的新档只有名字（先生报障）。旧库的存量候选**没有这份数据可回填**
   * （它从来没被读出来过），一律留空串，读出来就是「这条候选没带状态」；
   * 作者重新定稿一章即可拿到带状态的新候选。
   */
  const characterCandidateColumns = new Set(
    (db.prepare('PRAGMA table_info(character_candidates)').all() as Array<{ name: string }>)
      .map(column => column.name),
  )
  if (!characterCandidateColumns.has('current_state')) {
    db.exec("ALTER TABLE character_candidates ADD COLUMN current_state TEXT NOT NULL DEFAULT ''")
  }

  /**
   * 世界观设定：旧库补 status 列。
   * 老库里的条目都是作者手写或已确认的内容，一律按 confirmed 迁移 ——
   * 迁移不能让既有条目忽然变成「待确认」而从生成链路里消失。
   */
  const worldSettingColumns = new Set(
    (db.prepare('PRAGMA table_info(world_settings)').all() as Array<{ name: string }>).map(column => column.name),
  )
  if (!worldSettingColumns.has('status')) {
    db.exec("ALTER TABLE world_settings ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'")
  }

  /**
   * 世界观设定：旧库补 provenance 列，并把**存量条目整体标记为作者手写**。
   *
   * 为什么必须标记而不是留空：provenance 空 = 可被覆盖（等同 legacy）。
   * 而旧库里的条目都是作者在设定库里一条条敲进去的 —— 不标记它们，
   * 日后定稿自动更新就会改写作者亲手写的内容，这正是先生要防的「搞笑」。
   *
   * 只标 summary / content 两个承载语义的主字段：provenance 是「部分记录」，
   * 未记录的字段按 legacy（可更新）处理，所以漏标一个不会造成数据损坏。
   * json_set 万一不可用（SQLite 未编入 JSON1），退化为只加列 —— 不会让迁移失败。
   */
  if (!worldSettingColumns.has('provenance')) {
    db.exec("ALTER TABLE world_settings ADD COLUMN provenance TEXT NOT NULL DEFAULT '{}'")
    try {
      db.exec(
        "UPDATE world_settings SET provenance = json_set('{}', '$.summary', json('{\"kind\":\"author\"}'), '$.content', json('{\"kind\":\"author\"}'))",
      )
    } catch {
      // JSON1 不可用时保持空 provenance（等同 legacy），至少列已加好、不会阻塞打开项目。
    }
  }

  /**
   * 世界观设定的内置分类：首次打开项目时写入。
   *
   * 用 INSERT OR IGNORE 而不是「有则更新」—— 作者可能把「物品」改名成「法宝」，
   * 每次开项目都覆盖回默认名等于把他的命名吃掉。只补缺，不改已有的。
   */
  const insertBuiltinCategory = db.prepare(`
    INSERT OR IGNORE INTO world_setting_categories
      (key, name_zh, name_en, description_zh, description_en, builtin, sort_order)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `)
  for (const category of builtinCategoryRecords()) {
    insertBuiltinCategory.run(
      category.key,
      category.zhCN,
      category.enUS,
      category.descriptionZhCN,
      category.descriptionEnUS,
      category.sortOrder,
    )
  }

  // 兼容旧库：将「无 currentState」的哨兵 0 迁移为 NULL（chapter 0 合法状态不受影响）
  try {
    db.prepare(`
      UPDATE characters SET cs_updated_at_chapter = NULL
      WHERE cs_updated_at_chapter = 0
        AND IFNULL(cs_location, '') = ''
        AND IFNULL(cs_power_level, '') = ''
        AND IFNULL(cs_physical_state, '') = ''
        AND IFNULL(cs_mental_state, '') = ''
        AND IFNULL(cs_key_items, '') = ''
        AND IFNULL(cs_recent_events, '') = ''
    `).run()
  } catch {
    // 旧库结构差异时忽略
  }

  migrateDraftUnitCounts(db)
}
