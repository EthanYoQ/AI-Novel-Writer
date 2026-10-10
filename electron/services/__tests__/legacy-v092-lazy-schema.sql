-- Official 0.9.2 initializer at 5c6e73e522a4499d1c90d389b548e2906fe820ef, followed by its lazy blueprint tables.
-- Exact SQLite DDL fingerprint: 7a34ee78ddace39804d64ce8a42c054f11d9d27a559ff99cbd345921088ba050
CREATE TABLE blueprint_character_sync_operations (
        operation_id TEXT PRIMARY KEY,
        blueprint_commit_operation_id TEXT NOT NULL UNIQUE,
        blueprint_commit_payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed')),
        start_chapter INTEGER NOT NULL,
        end_chapter INTEGER NOT NULL,
        character_sync_input TEXT NOT NULL,
        completion_receipt TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT DEFAULT NULL,
        FOREIGN KEY (blueprint_commit_operation_id)
          REFERENCES blueprint_commit_operations(operation_id) ON DELETE CASCADE
      );

CREATE TABLE blueprint_commit_operations (
        operation_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('full', 'replace-range')),
        start_chapter INTEGER NOT NULL,
        end_chapter INTEGER NOT NULL,
        character_sync_input TEXT NOT NULL,
        committed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

CREATE TABLE blueprints (
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

CREATE TABLE chapter_deletion_operations (
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

CREATE TABLE character_roster_meta (
      id TEXT PRIMARY KEY CHECK (id = 'main'),
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      migration_state TEXT NOT NULL CHECK (
        migration_state IN (
          'empty',
          'legacy_cards_preserved',
          'legacy_markdown_pending',
          'ready'
        )
      ),
      legacy_markdown TEXT NOT NULL DEFAULT '',
      projection_hash TEXT NOT NULL DEFAULT '',
      fact_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE character_roster_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      committed_revision INTEGER NOT NULL,
      projection_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE characters (
      name TEXT PRIMARY KEY,                      -- 角色名
      role TEXT DEFAULT 'supporting',             -- protagonist/antagonist/supporting/minor
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      appearance TEXT DEFAULT '',                 -- 外貌
      personality TEXT DEFAULT '',                -- 性格
      background TEXT DEFAULT '',                 -- 背景
      abilities TEXT DEFAULT '',                  -- 能力
      motivation TEXT DEFAULT '',                 -- 动机
      relationships TEXT DEFAULT '',              -- 关系链
      arc TEXT DEFAULT '',                        -- 弧光
      notes TEXT DEFAULT '',                      -- 备忘录
      cs_location TEXT DEFAULT '',                -- 当前位置
      cs_power_level TEXT DEFAULT '',             -- 修为境界
      cs_physical_state TEXT DEFAULT '',          -- 身体状态
      cs_mental_state TEXT DEFAULT '',            -- 心理状态
      cs_key_items TEXT DEFAULT '',               -- 关键道具
      cs_recent_events TEXT DEFAULT '',           -- 最近事件
      cs_updated_at_chapter INTEGER DEFAULT NULL, -- 状态更新于第几章；NULL = 无 currentState
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE consistency_exemptions (
      stable_fact_key TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
    );

CREATE TABLE contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL DEFAULT '',              -- 正文/报告内容
      created_at TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,            -- 归属章节
      version INTEGER NOT NULL,                   -- v1, v2...
      status TEXT DEFAULT 'draft',                -- draft/revised/finalized/archived
      source TEXT DEFAULT 'write',                -- write/rewrite
      content_id INTEGER NOT NULL,                -- FK -> contents
      word_count INTEGER DEFAULT 0,               -- 字数缓存
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );

CREATE TABLE finalization_outbox (
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

CREATE TABLE finalized_draft_import_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE import_global_fact_operations (
      operation_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE import_legacy_identity_bridge (
      id TEXT PRIMARY KEY,
      ciphertext_hex TEXT NOT NULL,
      iv_hex TEXT NOT NULL,
      auth_tag_hex TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE import_reference_documents (
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

CREATE TABLE import_run_chapters (
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

CREATE TABLE import_run_knowledge_receipts (
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

CREATE TABLE import_run_receipts (
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

CREATE TABLE import_run_source_chapters (
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

CREATE TABLE import_run_sources (
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

CREATE TABLE import_runs (
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

CREATE TABLE import_source_aliases (
      alias_digest TEXT PRIMARY KEY,
      alias_kind TEXT NOT NULL CHECK(alias_kind IN ('location', 'file')),
      source_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE import_source_chapter_map (
      purpose TEXT NOT NULL CHECK(purpose IN ('reference', 'author-manuscript')),
      source_id TEXT NOT NULL,
      source_chapter_number INTEGER NOT NULL,
      chapter_number INTEGER NOT NULL,
      PRIMARY KEY (purpose, source_id, source_chapter_number),
      UNIQUE (purpose, chapter_number)
    );

CREATE TABLE llm_calls (
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

CREATE TABLE narrative_thread_confirmations (
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

CREATE TABLE narrative_thread_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      target_start_chapter INTEGER NOT NULL CHECK(target_start_chapter > 0),
      target_end_chapter INTEGER NOT NULL CHECK(target_end_chapter >= target_start_chapter),
      author_intent TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE post_process_runs (
      id TEXT PRIMARY KEY,                        -- UUID
      trigger_source_type TEXT NOT NULL,           -- chapter_finalize / arch_extract
      trigger_source_id TEXT NOT NULL,             -- 章节号 / draft_id
      source_label TEXT DEFAULT '',               -- UI 标签
      all_critical_passed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

CREATE TABLE post_process_steps (
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

CREATE TABLE project_core (
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

CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,             -- 审查对象 FK
      review_index INTEGER NOT NULL,              -- 审阅顺位
      content_id INTEGER NOT NULL,                -- FK -> contents
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );

CREATE TABLE revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,             -- 父草稿 FK
      revision_index INTEGER NOT NULL,            -- r1, r2
      revision_type TEXT NOT NULL,                -- refine | review-fix
      status TEXT DEFAULT 'pending',              -- pending/merged/discarded
      merged_to_draft_id INTEGER,                 -- 合并产出的新 draft
      user_prompt TEXT DEFAULT '',                -- 用户指导
      review_source_id INTEGER,                   -- 关联审稿 ID
      content_id INTEGER NOT NULL,                -- FK -> contents
      word_count INTEGER DEFAULT 0,               -- 字数缓存
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );

CREATE TABLE summary_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER DEFAULT NULL,
      chapter_number INTEGER NOT NULL,
      character_states TEXT DEFAULT '',
      chapter_notes TEXT NOT NULL DEFAULT '',
      continuity_facts TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
    );

CREATE TABLE text_metric_versions (
      metric TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE INDEX idx_blueprint_character_sync_status
        ON blueprint_character_sync_operations(status, created_at);

CREATE INDEX idx_chapter_deletion_status
      ON chapter_deletion_operations(status);

CREATE INDEX idx_drafts_chapter ON drafts(chapter_number);

CREATE UNIQUE INDEX idx_drafts_chapter_version
      ON drafts(chapter_number, version);

CREATE INDEX idx_finalization_outbox_status
      ON finalization_outbox(publication_status);

CREATE INDEX idx_import_run_chapters_page
      ON import_run_chapters(run_id, chapter_number);

CREATE INDEX idx_import_run_knowledge_receipts_affiliation
      ON import_run_knowledge_receipts(
        purpose, source_id, source_chapter_number, content_fingerprint, state
      );

CREATE INDEX idx_import_run_receipts_state
      ON import_run_receipts(run_id, state, stage);

CREATE INDEX idx_import_run_source_chapters
      ON import_run_source_chapters(run_id, source_id, source_chapter_number);

CREATE INDEX idx_import_runs_purpose_source_status
      ON import_runs(purpose, source_fingerprint, status, updated_at);

CREATE INDEX idx_import_runs_resumable
      ON import_runs(resumable, status, updated_at);

CREATE INDEX idx_import_runs_source_status
      ON import_runs(source_fingerprint, status, updated_at);

CREATE INDEX idx_import_source_aliases_source
      ON import_source_aliases(source_id);

CREATE INDEX idx_llm_calls_time ON llm_calls(created_at);

CREATE INDEX idx_narrative_thread_confirmations_plan
      ON narrative_thread_confirmations(plan_id, draft_id, id);

CREATE INDEX idx_post_runs_source
      ON post_process_runs(trigger_source_type, trigger_source_id);

CREATE UNIQUE INDEX idx_reviews_draft_index
      ON reviews(base_draft_id, review_index);

CREATE UNIQUE INDEX idx_revisions_draft_index
      ON revisions(base_draft_id, revision_index);

CREATE UNIQUE INDEX idx_summary_snapshots_draft
      ON summary_snapshots(draft_id) WHERE draft_id IS NOT NULL
  ;
