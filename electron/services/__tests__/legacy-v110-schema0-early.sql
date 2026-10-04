-- Exact schema0 DDL from the v1.1.0 old writer binary; no project rows.
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
CREATE TABLE contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
CREATE TABLE drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      version INTEGER NOT NULL,
      status TEXT DEFAULT 'draft',
      source TEXT DEFAULT 'write',
      content_id INTEGER NOT NULL,
      word_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
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
CREATE TABLE post_process_runs (
      id TEXT PRIMARY KEY,
      trigger_source_type TEXT NOT NULL,
      trigger_source_id TEXT NOT NULL,
      source_label TEXT DEFAULT '',
      all_critical_passed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
CREATE TABLE post_process_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      label TEXT DEFAULT '',
      critical INTEGER DEFAULT 0,
      ok INTEGER DEFAULT 0,
      error_msg TEXT DEFAULT '',
      attempt_count INTEGER DEFAULT 0,
      completed_at TEXT DEFAULT '',
      last_attempt_at TEXT DEFAULT '',
      FOREIGN KEY (run_id) REFERENCES post_process_runs(id) ON DELETE CASCADE
    );
CREATE TABLE project_core (
      id TEXT PRIMARY KEY DEFAULT 'main',
      project_name TEXT NOT NULL DEFAULT '',
      genre TEXT DEFAULT '',
      sub_genre TEXT DEFAULT '',
      target_audience TEXT DEFAULT '',
      total_chapters INTEGER DEFAULT 100,
      words_per_chapter INTEGER DEFAULT 3000,
      plot_structure TEXT DEFAULT 'three_act',
      narrative_pov TEXT DEFAULT 'third_limited',
      writing_style TEXT DEFAULT '',
      reference_works TEXT DEFAULT '',
      global_guidance TEXT DEFAULT '',
      golden_finger TEXT DEFAULT '',
      premise TEXT DEFAULT '',
      worldbuilding TEXT DEFAULT '',
      characters_arch TEXT DEFAULT '',
      synopsis TEXT DEFAULT '',
      character_states TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,
      review_index INTEGER NOT NULL,
      content_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
CREATE TABLE revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,
      revision_index INTEGER NOT NULL,
      revision_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      merged_to_draft_id INTEGER,
      user_prompt TEXT DEFAULT '',
      review_source_id INTEGER,
      content_id INTEGER NOT NULL,
      word_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
CREATE TABLE summary_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      character_states TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
CREATE INDEX idx_drafts_chapter ON drafts(chapter_number);
CREATE UNIQUE INDEX idx_drafts_chapter_version
      ON drafts(chapter_number, version);
CREATE INDEX idx_llm_calls_time ON llm_calls(created_at);
CREATE INDEX idx_post_runs_source
      ON post_process_runs(trigger_source_type, trigger_source_id);
CREATE UNIQUE INDEX idx_reviews_draft_index
      ON reviews(base_draft_id, review_index);
CREATE UNIQUE INDEX idx_revisions_draft_index
      ON revisions(base_draft_id, revision_index);
