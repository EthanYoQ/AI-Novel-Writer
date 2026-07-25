/* eslint-env node */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as lancedb from '@lancedb/lancedb'
import {
  Field,
  FixedSizeList as ArrowFixedSizeList,
  Float32,
  Int32,
  Schema as ArrowSchema,
  Utf8,
} from 'apache-arrow'

const PROJECT_MANIFEST_RELATIVE_PATH = '.vela/project.json'
const PROMPT_TEMPLATE_RELATIVE_PATH = '.vela/prompts/chapter-style.md'
const FINALIZED_MANUSCRIPT_RELATIVE_PATH = '第7章 失真的航标.txt'
const EMBEDDING_REGISTRY_RELATIVE_PATH = '.vela/embedding-spaces.json'
const LANCEDB_RELATIVE_PATH = '.vela/lancedb'
const ASSET_INVENTORY_RELATIVE_PATH = '.vela/upgrade-data-inventory.json'
const EMBEDDING_TABLE_NAME = 'chunks__space_1'
const EMBEDDING_DIMENSION = 768
const EMBEDDING_VECTOR = Array.from({ length: EMBEDDING_DIMENSION }, (_, index) => index / EMBEDDING_DIMENSION)
const EMBEDDING_SPACE = {
  generation: 1,
  tableName: EMBEDDING_TABLE_NAME,
  modelFingerprint: 'upgrade-fixture/non-2048-768',
  vectorDimension: EMBEDDING_DIMENSION,
  distanceMetric: 'l2',
  status: 'active',
  createdAt: '2026-01-02T03:12:05.000Z',
}
const KNOWLEDGE_DOCUMENT = {
  id: 'upgrade-fixture-knowledge-document',
  fileName: '升级知识库.txt',
  importedAt: '2026-01-02T03:12:05.000Z',
  chunkCount: 1,
  filePath: '',
}
const KNOWLEDGE_CHUNK = {
  id: 'upgrade-fixture-knowledge-chunk',
  docId: KNOWLEDGE_DOCUMENT.id,
  fileName: KNOWLEDGE_DOCUMENT.fileName,
  chapterNumber: 7,
  chapterTitle: '失真的航标',
  text: '升级夹具知识库：轨道港航标失真记录必须保留并可检索。',
  chunkIndex: 0,
  totalChunks: 1,
  importedAt: KNOWLEDGE_DOCUMENT.importedAt,
}
const PROJECT_MANIFEST = {
  schemaVersion: 1,
  kind: 'ai-novel-project',
  projectId: '02500000-0000-4000-8000-000000000024',
  createdAt: '2026-01-01T20:00:00.000Z',
}
const PROMPT_TEMPLATE = '# 第七章写作提示\n\n保留航标失真与日志缺失七秒钟的证据链。\n'
const FINALIZED_MANUSCRIPT = '第7章 失真的航标\n\n定稿：苏雨把两份日志并排放在终端上，缺失的七秒钟成为无法绕开的证据。\n'

const PROJECT_ROW = {
  id: 'main',
  project_name: '升级保留验证小说',
  genre: '科幻',
  sub_genre: '太空悬疑',
  target_audience: '全龄',
  total_chapters: 42,
  words_per_chapter: 2800,
  plot_structure: 'three_act',
  narrative_pov: 'third_limited',
  writing_style: '克制、清晰、保留人物行动细节',
  reference_works: '硬科幻调查叙事',
  global_guidance: '线索必须可回溯，避免无依据反转',
  golden_finger: '可解析失真导航信号',
  premise: '一支远航队在木卫二附近失联',
  worldbuilding: '轨道港与深空航线构成主要舞台',
  characters_arch: '林舟与苏雨组成调查搭档',
  synopsis: '调查从轨道港延伸至木卫二',
  character_states: '{"林舟":{"location":"轨道港","chapter":7}}',
  created_at: '2026-01-01 20:00:00',
  updated_at: '2026-01-02 03:12:05',
}

const CHARACTER_ROWS = [
  {
    name: '林舟',
    role: 'protagonist',
    gender: '男',
    age: '31',
    appearance: '常穿旧式航行夹克',
    personality: '审慎但坚定',
    background: '前远航导航员',
    abilities: '导航信号解析',
    motivation: '寻找失踪的远航队',
    relationships: '苏雨的调查搭档',
    arc: '从独自承担转为信任协作',
    notes: '保留导航核心',
    cs_location: '轨道港',
    cs_power_level: '资深导航员',
    cs_physical_state: '轻度失眠',
    cs_mental_state: '警觉',
    cs_key_items: '导航核心',
    cs_recent_events: '确认最后信号来自木卫二',
    cs_updated_at_chapter: 7,
    created_at: '2026-01-01 21:00:00',
    updated_at: '2026-01-02 03:12:05',
  },
  {
    name: '苏雨',
    role: 'supporting',
    gender: '女',
    age: '29',
    appearance: '短发，携带便携取证终端',
    personality: '敏锐、重视证据',
    background: '轨道港事故调查员',
    abilities: '现场取证',
    motivation: '查明事故记录被篡改的原因',
    relationships: '林舟的调查搭档',
    arc: '学会在证据不足时保留开放判断',
    notes: '负责证据链',
    cs_location: '轨道港档案区',
    cs_power_level: '高级调查员',
    cs_physical_state: '正常',
    cs_mental_state: '专注',
    cs_key_items: '取证终端',
    cs_recent_events: '发现事故日志时间戳异常',
    cs_updated_at_chapter: 7,
    created_at: '2026-01-01 21:05:00',
    updated_at: '2026-01-02 03:12:05',
  },
]

const BLUEPRINT_ROWS = [
  {
    chapter_number: 7,
    title: '失真的航标',
    role: '线索升级',
    purpose: '确认失联事件与导航信号篡改有关',
    key_events: '["林舟复核航标","苏雨发现日志时间戳异常"]',
    characters: '["林舟","苏雨"]',
    suspense_hook: '航标中出现了早已注销的远航队识别码',
    user_guidance: '保留调查过程和证据链',
    notes: '第七章完成第一次证据闭环',
    notes_updated_at: '2026-01-02T03:04:05.000Z',
    created_at: '2026-01-01 22:00:00',
    updated_at: '2026-01-02 03:10:05',
  },
]

const CONTENT_ROWS = [
  {
    id: 701,
    body: '轨道港的航标在静默中重复闪烁。林舟逐位校验信号，确认失真不是设备故障。',
    created_at: '2026-01-02 03:04:05',
  },
  {
    id: 702,
    body: '定稿：苏雨把两份日志并排放在终端上，缺失的七秒钟成为无法绕开的证据。',
    created_at: '2026-01-02 03:05:05',
  },
  {
    id: 703,
    body: '修稿：补充航标校验的操作细节，并保留原始证据编号。',
    created_at: '2026-01-02 03:06:05',
  },
  {
    id: 704,
    body: '审稿报告：证据链完整，但需要明确日志时间戳与航标失真的先后关系。',
    created_at: '2026-01-02 03:07:05',
  },
]

const DRAFT_ROWS = [
  {
    id: 71,
    chapter_number: 7,
    version: 1,
    status: 'draft',
    source: 'write',
    content_id: 701,
    word_count: 37,
    created_at: '2026-01-02 03:04:05',
    updated_at: '2026-01-02 03:04:05',
  },
  {
    id: 72,
    chapter_number: 7,
    version: 2,
    status: 'finalized',
    source: 'rewrite',
    content_id: 702,
    word_count: 38,
    created_at: '2026-01-02 03:05:05',
    updated_at: '2026-01-02 03:08:05',
  },
]

const REVIEW_ROWS = [
  {
    id: 81,
    base_draft_id: 71,
    review_index: 1,
    content_id: 704,
    created_at: '2026-01-02 03:07:05',
  },
]

const REVISION_ROWS = [
  {
    id: 91,
    base_draft_id: 71,
    revision_index: 1,
    revision_type: 'review-fix',
    status: 'merged',
    merged_to_draft_id: 72,
    user_prompt: '保持克制文风，补足证据链的先后关系',
    review_source_id: 81,
    content_id: 703,
    word_count: 30,
    created_at: '2026-01-02 03:06:05',
    updated_at: '2026-01-02 03:08:05',
  },
]

const POST_PROCESS_RUN_ROWS = [
  {
    id: '02500000-0000-4000-8000-000000000001',
    trigger_source_type: 'chapter_finalize',
    trigger_source_id: '72',
    source_label: '第7章《失真的航标》定稿',
    all_critical_passed: 0,
    created_at: '2026-01-02 03:09:05',
    updated_at: '2026-01-02 03:11:05',
  },
]

const POST_PROCESS_STEP_ROWS = [
  {
    id: 101,
    run_id: '02500000-0000-4000-8000-000000000001',
    step_key: 'extract_chapter_notes',
    label: '提取章节要点',
    critical: 1,
    ok: 1,
    error_msg: '',
    attempt_count: 1,
    completed_at: '2026-01-02 03:10:05',
    last_attempt_at: '2026-01-02 03:10:05',
  },
  {
    id: 102,
    run_id: '02500000-0000-4000-8000-000000000001',
    step_key: 'update_character_states',
    label: '更新角色状态',
    critical: 1,
    ok: 0,
    error_msg: '旧版夹具保留的后处理失败证据',
    attempt_count: 2,
    completed_at: '',
    last_attempt_at: '2026-01-02 03:11:05',
  },
]

const LLM_CALL_ROWS = [
  {
    id: 111,
    model_id: 'legacy-model-success',
    model_name: 'v0.2.5 成功调用',
    purpose: 'review',
    prompt_tokens: 1200,
    completion_tokens: 320,
    total_tokens: 1520,
    duration_ms: 4321,
    success: 1,
    error_message: '',
    created_at: '2026-01-02 03:07:05',
  },
  {
    id: 112,
    model_id: 'legacy-model-failure',
    model_name: 'v0.2.5 失败调用',
    purpose: 'post_process',
    prompt_tokens: 900,
    completion_tokens: 0,
    total_tokens: 900,
    duration_ms: 6789,
    success: 0,
    error_message: '旧版限流错误证据',
    created_at: '2026-01-02 03:11:05',
  },
]

const SUMMARY_SNAPSHOT_ROWS = [
  {
    id: 121,
    chapter_number: 6,
    character_states: '{"林舟":{"location":"远航船坞","chapter":6}}',
    created_at: '2026-01-01 23:00:00',
  },
  {
    id: 122,
    chapter_number: 7,
    character_states: '{"林舟":{"location":"轨道港","chapter":7},"苏雨":{"location":"轨道港档案区","chapter":7}}',
    created_at: '2026-01-02 03:12:05',
  },
]

const PROJECT_COLUMNS = Object.keys(PROJECT_ROW)
const CHARACTER_COLUMNS = Object.keys(CHARACTER_ROWS[0])
const BLUEPRINT_COLUMNS = Object.keys(BLUEPRINT_ROWS[0])
const CONTENT_COLUMNS = Object.keys(CONTENT_ROWS[0])
const DRAFT_COLUMNS = Object.keys(DRAFT_ROWS[0])
const REVIEW_COLUMNS = Object.keys(REVIEW_ROWS[0])
const REVISION_COLUMNS = Object.keys(REVISION_ROWS[0])
const POST_PROCESS_RUN_COLUMNS = Object.keys(POST_PROCESS_RUN_ROWS[0])
const POST_PROCESS_STEP_COLUMNS = Object.keys(POST_PROCESS_STEP_ROWS[0])
const LLM_CALL_COLUMNS = Object.keys(LLM_CALL_ROWS[0])
const SUMMARY_SNAPSHOT_COLUMNS = Object.keys(SUMMARY_SNAPSHOT_ROWS[0])

// Derived verbatim from v0.2.5:electron/database.ts. A newer release may append
// migrated columns, but it must retain every legacy column in its original order.
const V025_TABLE_COLUMNS = {
  project_core: [
    'id', 'project_name', 'genre', 'sub_genre', 'target_audience',
    'total_chapters', 'words_per_chapter', 'plot_structure', 'narrative_pov',
    'writing_style', 'reference_works', 'global_guidance', 'golden_finger',
    'premise', 'worldbuilding', 'characters_arch', 'synopsis',
    'character_states', 'created_at', 'updated_at',
  ],
  blueprints: [
    'chapter_number', 'title', 'role', 'purpose', 'key_events', 'characters',
    'suspense_hook', 'user_guidance', 'notes', 'notes_updated_at',
    'created_at', 'updated_at',
  ],
  characters: [
    'name', 'role', 'gender', 'age', 'appearance', 'personality', 'background',
    'abilities', 'motivation', 'relationships', 'arc', 'notes', 'cs_location',
    'cs_power_level', 'cs_physical_state', 'cs_mental_state', 'cs_key_items',
    'cs_recent_events', 'cs_updated_at_chapter', 'created_at', 'updated_at',
  ],
  contents: ['id', 'body', 'created_at'],
  drafts: [
    'id', 'chapter_number', 'version', 'status', 'source', 'content_id',
    'word_count', 'created_at', 'updated_at',
  ],
  revisions: [
    'id', 'base_draft_id', 'revision_index', 'revision_type', 'status',
    'merged_to_draft_id', 'user_prompt', 'review_source_id', 'content_id',
    'word_count', 'created_at', 'updated_at',
  ],
  reviews: ['id', 'base_draft_id', 'review_index', 'content_id', 'created_at'],
  post_process_runs: [
    'id', 'trigger_source_type', 'trigger_source_id', 'source_label',
    'all_critical_passed', 'created_at', 'updated_at',
  ],
  post_process_steps: [
    'id', 'run_id', 'step_key', 'label', 'critical', 'ok', 'error_msg',
    'attempt_count', 'completed_at', 'last_attempt_at',
  ],
  llm_calls: [
    'id', 'model_id', 'model_name', 'purpose', 'prompt_tokens',
    'completion_tokens', 'total_tokens', 'duration_ms', 'success',
    'error_message', 'created_at',
  ],
  summary_snapshots: ['id', 'chapter_number', 'character_states', 'created_at'],
}

function databasePath(projectRoot) {
  return join(resolve(projectRoot), '.vela', 'vela.db')
}

function inventoryPath(projectRoot) {
  return join(resolve(projectRoot), ASSET_INVENTORY_RELATIVE_PATH)
}

function sha256Hex(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function normalizedRelativePath(rootPath, filePath) {
  return relative(rootPath, filePath).replaceAll('\\', '/')
}

function inspectFile(filePath, label) {
  assert(existsSync(filePath), `${label} is missing: ${filePath}`)
  const stats = statSync(filePath)
  assert(stats.isFile(), `${label} must be a file: ${filePath}`)
  return {
    byteSize: stats.size,
    sha256: sha256Hex(filePath),
  }
}

function readJsonRecord(filePath, label) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} must be a JSON object`)
  return parsed
}

function settingsSemanticSnapshot(settingsPath) {
  const settings = readJsonRecord(settingsPath, 'Upgrade fixture settings')
  const proxy = settings.proxy
  assert(proxy && typeof proxy === 'object' && !Array.isArray(proxy), 'Upgrade fixture settings.proxy must be an object')
  return {
    theme: settings.theme,
    locale: settings.locale,
    proxy: {
      enabled: proxy.enabled,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
    },
  }
}

function collectFilesRecursively(rootPath) {
  if (!existsSync(rootPath)) return []
  const files = []
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else if (entry.isFile()) {
        files.push(entryPath)
      } else {
        throw new Error(`Unsupported upgrade fixture asset entry: ${entryPath}`)
      }
    }
  }
  visit(rootPath)
  return files
}

function projectAsset(projectRoot, relativePath, semanticTags, verification) {
  const filePath = join(resolve(projectRoot), relativePath)
  return {
    location: 'project',
    path: relativePath.replaceAll('\\', '/'),
    semanticTags,
    verification,
    ...inspectFile(filePath, `Upgrade fixture asset ${relativePath}`),
  }
}

function settingsAsset(settingsPath) {
  return {
    location: 'settings',
    path: 'config.json',
    semanticTags: ['user-settings'],
    verification: 'settings-semantic',
    semanticSnapshot: settingsSemanticSnapshot(settingsPath),
    ...inspectFile(settingsPath, 'Upgrade fixture settings'),
  }
}

function createAssetInventory(projectRoot, settingsPath) {
  const resolvedProjectRoot = resolve(projectRoot)
  const assets = [
    projectAsset(
      resolvedProjectRoot,
      '.vela/vela.db',
      ['database', 'architecture', 'blueprints', 'characters', 'worldbuilding', 'drafts', 'body', 'history'],
      'sqlite-v025-semantic',
    ),
    projectAsset(resolvedProjectRoot, PROJECT_MANIFEST_RELATIVE_PATH, ['project-manifest'], 'exact'),
    projectAsset(resolvedProjectRoot, PROMPT_TEMPLATE_RELATIVE_PATH, ['prompt-template'], 'exact'),
    projectAsset(resolvedProjectRoot, FINALIZED_MANUSCRIPT_RELATIVE_PATH, ['finalized-manuscript'], 'exact'),
    projectAsset(resolvedProjectRoot, EMBEDDING_REGISTRY_RELATIVE_PATH, ['embedding-registry'], 'embedding-registry-semantic'),
    ...collectFilesRecursively(join(resolvedProjectRoot, LANCEDB_RELATIVE_PATH)).map(filePath => ({
      location: 'project',
      path: normalizedRelativePath(resolvedProjectRoot, filePath),
      semanticTags: ['knowledge-base', 'lancedb-storage'],
      verification: 'lancedb-semantic',
      ...inspectFile(filePath, 'LanceDB physical asset'),
    })),
  ]
  if (settingsPath) assets.push(settingsAsset(resolve(settingsPath)))
  return {
    version: 1,
    generatedAt: '2026-01-02T03:12:05.000Z',
    assets,
  }
}

function writeAssetInventory(projectRoot, inventory) {
  const filePath = inventoryPath(projectRoot)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8')
}

function assertRequiredInventoryCoverage(inventory, settingsPath) {
  const requiredAssets = [
    {
      location: 'project',
      path: '.vela/vela.db',
      semanticTags: ['database', 'architecture', 'blueprints', 'characters', 'worldbuilding', 'drafts', 'body', 'history'],
      verification: 'sqlite-v025-semantic',
    },
    {
      location: 'project',
      path: PROJECT_MANIFEST_RELATIVE_PATH,
      semanticTags: ['project-manifest'],
      verification: 'exact',
    },
    {
      location: 'project',
      path: PROMPT_TEMPLATE_RELATIVE_PATH,
      semanticTags: ['prompt-template'],
      verification: 'exact',
    },
    {
      location: 'project',
      path: FINALIZED_MANUSCRIPT_RELATIVE_PATH,
      semanticTags: ['finalized-manuscript'],
      verification: 'exact',
    },
    {
      location: 'project',
      path: EMBEDDING_REGISTRY_RELATIVE_PATH,
      semanticTags: ['embedding-registry'],
      verification: 'embedding-registry-semantic',
    },
  ]
  if (settingsPath) {
    requiredAssets.push({
      location: 'settings',
      path: 'config.json',
      semanticTags: ['user-settings'],
      verification: 'settings-semantic',
    })
  }

  for (const required of requiredAssets) {
    const asset = inventory.assets.find(candidate => (
      candidate
      && candidate.location === required.location
      && candidate.path === required.path
    ))
    assert(asset, `Upgrade fixture asset inventory is missing required asset: ${required.path}`)
    assert.deepEqual(asset.semanticTags, required.semanticTags, `Upgrade fixture asset tags changed: ${required.path}`)
    assert.equal(asset.verification, required.verification, `Upgrade fixture asset verification changed: ${required.path}`)
    assert(Number.isInteger(asset.byteSize) && asset.byteSize > 0, `Upgrade fixture asset size is invalid: ${required.path}`)
    assert(typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(asset.sha256), `Upgrade fixture asset SHA-256 is invalid: ${required.path}`)
  }

  const lancedbAssets = inventory.assets.filter(asset => (
    asset
    && asset.location === 'project'
    && asset.verification === 'lancedb-semantic'
    && Array.isArray(asset.semanticTags)
    && asset.semanticTags.includes('knowledge-base')
    && asset.semanticTags.includes('lancedb-storage')
  ))
  assert(lancedbAssets.length > 0, 'Upgrade fixture asset inventory is missing LanceDB physical assets')
}

function readAssetInventory(projectRoot, settingsPath) {
  const filePath = inventoryPath(projectRoot)
  const inventory = readJsonRecord(filePath, 'Upgrade fixture asset inventory')
  assert(inventory.version === 1, 'Upgrade fixture asset inventory version is invalid')
  assert(Array.isArray(inventory.assets) && inventory.assets.length > 0, 'Upgrade fixture asset inventory is empty')
  assertRequiredInventoryCoverage(inventory, settingsPath)
  return inventory
}

function canonicalChunkSchema() {
  return new ArrowSchema([
    new Field('id', new Utf8()),
    new Field('docId', new Utf8()),
    new Field('fileName', new Utf8()),
    new Field('chapterNumber', new Int32(), true),
    new Field('chapterTitle', new Utf8(), true),
    new Field('text', new Utf8()),
    new Field('chunkIndex', new Int32()),
    new Field('totalChunks', new Int32()),
    new Field('importedAt', new Utf8()),
  ])
}

function embeddingChunkSchema(dimension) {
  return new ArrowSchema([
    new Field('id', new Utf8()),
    new Field('docId', new Utf8()),
    new Field('fileName', new Utf8()),
    new Field('chapterNumber', new Int32(), true),
    new Field('chapterTitle', new Utf8(), true),
    new Field('text', new Utf8()),
    new Field('vector', new ArrowFixedSizeList(dimension, new Field('item', new Float32())), false),
    new Field('chunkIndex', new Int32()),
    new Field('totalChunks', new Int32()),
    new Field('importedAt', new Utf8()),
  ])
}

function readEmbeddingRegistry(projectRoot) {
  return readJsonRecord(join(resolve(projectRoot), EMBEDDING_REGISTRY_RELATIVE_PATH), 'Embedding-space registry')
}

async function seedEmbeddingAssets(projectRoot) {
  const lancedbPath = join(resolve(projectRoot), LANCEDB_RELATIVE_PATH)
  mkdirSync(lancedbPath, { recursive: true })
  const db = await lancedb.connect(lancedbPath)
  await db.createTable('chunks', [KNOWLEDGE_CHUNK], { schema: canonicalChunkSchema() })
  await db.createTable('documents', [KNOWLEDGE_DOCUMENT])
  await db.createTable(
    EMBEDDING_TABLE_NAME,
    [{ ...KNOWLEDGE_CHUNK, vector: EMBEDDING_VECTOR }],
    { schema: embeddingChunkSchema(EMBEDDING_DIMENSION) },
  )
  writeFileSync(
    join(resolve(projectRoot), EMBEDDING_REGISTRY_RELATIVE_PATH),
    `${JSON.stringify({ version: 1, activeGeneration: EMBEDDING_SPACE.generation, spaces: [EMBEDDING_SPACE] }, null, 2)}\n`,
    'utf8',
  )
  return validateEmbeddingAssets(projectRoot)
}

async function validateEmbeddingAssets(projectRoot) {
  const registry = readEmbeddingRegistry(projectRoot)
  assert(registry.version === 1, 'Embedding-space registry version changed during upgrade')
  assert(registry.activeGeneration === EMBEDDING_SPACE.generation, 'Embedding-space active generation changed during upgrade')
  assert(Array.isArray(registry.spaces), 'Embedding-space registry spaces are missing during upgrade')
  const active = registry.spaces.find(space => space && space.generation === registry.activeGeneration)
  assert.deepEqual(active, EMBEDDING_SPACE, 'Embedding-space registry content changed during upgrade')

  const db = await lancedb.connect(join(resolve(projectRoot), LANCEDB_RELATIVE_PATH))
  const tableNames = await db.tableNames()
  assert(tableNames.includes('chunks'), 'Knowledge-base canonical chunks table is missing during upgrade')
  assert(tableNames.includes('documents'), 'Knowledge-base document table is missing during upgrade')
  assert(tableNames.includes(EMBEDDING_TABLE_NAME), 'Embedding-space vector table is missing during upgrade')

  const canonicalRows = await (await db.openTable('chunks')).query().filter(`id = '${KNOWLEDGE_CHUNK.id}'`).toArray()
  assert.equal(canonicalRows.length, 1, 'Knowledge-base full-text chunk is missing during upgrade')
  const canonical = canonicalRows[0]
  assert.deepEqual({
    id: canonical.id,
    docId: canonical.docId,
    fileName: canonical.fileName,
    chapterNumber: canonical.chapterNumber,
    chapterTitle: canonical.chapterTitle,
    text: canonical.text,
    chunkIndex: canonical.chunkIndex,
    totalChunks: canonical.totalChunks,
    importedAt: canonical.importedAt,
  }, KNOWLEDGE_CHUNK, 'Knowledge-base full-text chunk changed during upgrade')
  const documentRows = await (await db.openTable('documents')).query().filter(`id = '${KNOWLEDGE_DOCUMENT.id}'`).toArray()
  assert.equal(documentRows.length, 1, 'Knowledge-base document catalog is missing during upgrade')
  const document = documentRows[0]
  assert.deepEqual({
    id: document.id,
    fileName: document.fileName,
    importedAt: document.importedAt,
    chunkCount: document.chunkCount,
    filePath: document.filePath,
  }, KNOWLEDGE_DOCUMENT, 'Knowledge-base document catalog changed during upgrade')

  const vectorTable = await db.openTable(EMBEDDING_TABLE_NAME)
  const vectorRows = await vectorTable.query().filter(`id = '${KNOWLEDGE_CHUNK.id}'`).toArray()
  assert.equal(vectorRows.length, 1, 'Embedding-space vector row is missing during upgrade')
  const vector = Array.from(vectorRows[0].vector ?? [])
  assert(vector.length === EMBEDDING_DIMENSION && vector.every(Number.isFinite), 'Embedding-space vector dimension changed during upgrade')
  const queryRows = await vectorTable.search(EMBEDDING_VECTOR).limit(1).toArray()
  assert.equal(queryRows.length, 1, 'Embedding-space query returned no rows during upgrade')
  assert.equal(queryRows[0].id, KNOWLEDGE_CHUNK.id, 'Embedding-space query returned the wrong chunk during upgrade')
  assert.equal(queryRows[0].text, KNOWLEDGE_CHUNK.text, 'Embedding-space query text changed during upgrade')

  return {
    activeGeneration: EMBEDDING_SPACE.generation,
    tableName: EMBEDDING_TABLE_NAME,
    vectorDimension: EMBEDDING_DIMENSION,
    queryResultCount: queryRows.length,
    queryText: queryRows[0].text,
    queryFileName: queryRows[0].fileName,
  }
}

function resolveInventoryAssetPath(projectRoot, settingsPath, asset) {
  if (asset.location === 'project') return join(resolve(projectRoot), asset.path)
  if (asset.location === 'settings') {
    assert(settingsPath, 'Upgrade fixture settings path is required to validate the preserved settings asset')
    return resolve(settingsPath)
  }
  throw new Error(`Unsupported upgrade fixture asset location: ${asset.location}`)
}

function validateAssetInventory(projectRoot, settingsPath, databaseEvidence, embeddingEvidence) {
  const inventory = readAssetInventory(projectRoot, settingsPath)
  const preservedAssets = inventory.assets.map((asset) => {
    assert(asset && typeof asset === 'object' && !Array.isArray(asset), 'Upgrade fixture asset inventory contains an invalid asset')
    const filePath = resolveInventoryAssetPath(projectRoot, settingsPath, asset)
    const actual = inspectFile(filePath, `Preserved upgrade asset ${asset.path}`)
    const hashMatched = actual.sha256 === asset.sha256
    let semanticVerified = false

    if (asset.verification === 'exact') {
      assert(hashMatched, `Upgrade asset content changed: ${asset.path}`)
    } else if (asset.verification === 'sqlite-v025-semantic') {
      assert(databaseEvidence && databaseEvidence.legacyTableCount === 11, 'Upgrade database semantic evidence is incomplete')
      semanticVerified = true
    } else if (asset.verification === 'embedding-registry-semantic') {
      assert(embeddingEvidence && embeddingEvidence.vectorDimension === EMBEDDING_DIMENSION, 'Embedding registry semantic evidence is incomplete')
      semanticVerified = true
    } else if (asset.verification === 'lancedb-semantic') {
      assert(embeddingEvidence && embeddingEvidence.queryResultCount === 1, 'LanceDB semantic query evidence is incomplete')
      semanticVerified = true
    } else if (asset.verification === 'settings-semantic') {
      assert.deepEqual(
        settingsSemanticSnapshot(filePath),
        asset.semanticSnapshot,
        'Upgrade settings semantic content changed',
      )
      semanticVerified = true
    } else {
      throw new Error(`Unsupported upgrade fixture asset verification strategy: ${asset.verification}`)
    }

    return {
      ...asset,
      actualByteSize: actual.byteSize,
      actualSha256: actual.sha256,
      hashMatched,
      semanticVerified,
    }
  })

  return {
    assetInventoryPath: ASSET_INVENTORY_RELATIVE_PATH,
    assetCount: inventory.assets.length,
    preservedAssetCount: preservedAssets.length,
    assetInventory: preservedAssets,
  }
}

function normalizeRow(row, columns) {
  return Object.fromEntries(columns.map(column => [column, row[column]]))
}

function createV025Tables(db) {
  db.exec(`
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
    CREATE INDEX idx_drafts_chapter ON drafts(chapter_number);
    CREATE UNIQUE INDEX idx_drafts_chapter_version
      ON drafts(chapter_number, version);

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
    CREATE UNIQUE INDEX idx_revisions_draft_index
      ON revisions(base_draft_id, revision_index);

    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,
      review_index INTEGER NOT NULL,
      content_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX idx_reviews_draft_index
      ON reviews(base_draft_id, review_index);

    CREATE TABLE post_process_runs (
      id TEXT PRIMARY KEY,
      trigger_source_type TEXT NOT NULL,
      trigger_source_id TEXT NOT NULL,
      source_label TEXT DEFAULT '',
      all_critical_passed INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_post_runs_source
      ON post_process_runs(trigger_source_type, trigger_source_id);

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

    CREATE TABLE summary_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      character_states TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_llm_calls_time ON llm_calls(created_at);
  `)
}

function insertRow(db, table, row) {
  const columns = Object.keys(row)
  const placeholders = columns.map(() => '?').join(', ')
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
  ).run(...columns.map(column => row[column]))
}

function assertV025SchemaCompatible(db) {
  for (const [table, expectedColumns] of Object.entries(V025_TABLE_COLUMNS)) {
    const actualColumns = db.prepare(`PRAGMA table_info(${table})`).all()
      .map(column => column.name)
    assert.deepEqual(
      actualColumns.slice(0, expectedColumns.length),
      expectedColumns,
      `${table} no longer retains the real v0.2.5 column layout`,
    )
  }
}

function readRows(db, table, columns, orderBy) {
  return db.prepare(
    `SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${orderBy}`,
  ).all().map(row => normalizeRow(row, columns))
}

function seedPhysicalProjectAssets(projectRoot) {
  const resolvedProjectRoot = resolve(projectRoot)
  writeFileSync(
    join(resolvedProjectRoot, PROJECT_MANIFEST_RELATIVE_PATH),
    `${JSON.stringify(PROJECT_MANIFEST, null, 2)}\n`,
    'utf8',
  )
  const promptPath = join(resolvedProjectRoot, PROMPT_TEMPLATE_RELATIVE_PATH)
  mkdirSync(dirname(promptPath), { recursive: true })
  writeFileSync(promptPath, PROMPT_TEMPLATE, 'utf8')
  writeFileSync(join(resolvedProjectRoot, FINALIZED_MANUSCRIPT_RELATIVE_PATH), FINALIZED_MANUSCRIPT, 'utf8')
}

async function seed(projectRoot, settingsPath) {
  const dbPath = databasePath(projectRoot)
  if (existsSync(dbPath)) {
    throw new Error(`Refusing to overwrite an existing upgrade fixture database: ${dbPath}`)
  }
  mkdirSync(join(resolve(projectRoot), '.vela'), { recursive: true })

  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    createV025Tables(db)
    db.exec('BEGIN IMMEDIATE')
    try {
      insertRow(db, 'project_core', PROJECT_ROW)
      for (const character of CHARACTER_ROWS) insertRow(db, 'characters', character)
      for (const blueprint of BLUEPRINT_ROWS) insertRow(db, 'blueprints', blueprint)
      for (const content of CONTENT_ROWS) insertRow(db, 'contents', content)
      for (const draft of DRAFT_ROWS) insertRow(db, 'drafts', draft)
      for (const review of REVIEW_ROWS) insertRow(db, 'reviews', review)
      for (const revision of REVISION_ROWS) insertRow(db, 'revisions', revision)
      for (const run of POST_PROCESS_RUN_ROWS) insertRow(db, 'post_process_runs', run)
      for (const step of POST_PROCESS_STEP_ROWS) insertRow(db, 'post_process_steps', step)
      for (const call of LLM_CALL_ROWS) insertRow(db, 'llm_calls', call)
      for (const snapshot of SUMMARY_SNAPSHOT_ROWS) {
        insertRow(db, 'summary_snapshots', snapshot)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
  seedPhysicalProjectAssets(projectRoot)
  await seedEmbeddingAssets(projectRoot)
  writeAssetInventory(projectRoot, createAssetInventory(projectRoot, settingsPath))
  return validate(projectRoot, settingsPath)
}

function validateDatabase(projectRoot) {
  const dbPath = databasePath(projectRoot)
  if (!existsSync(dbPath)) {
    throw new Error(`Upgrade fixture database is missing: ${dbPath}`)
  }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    assertV025SchemaCompatible(db)
    const integrity = db.prepare('PRAGMA integrity_check').get()
    assert.equal(
      integrity.integrity_check,
      'ok',
      'v0.2.5 fixture database failed SQLite integrity_check',
    )
    assert.deepEqual(
      db.prepare('PRAGMA foreign_key_check').all(),
      [],
      'v0.2.5 fixture database contains broken foreign-key references',
    )

    const projectRow = db.prepare(
      `SELECT ${PROJECT_COLUMNS.join(', ')} FROM project_core WHERE id = 'main'`,
    ).get()
    const project = projectRow ? normalizeRow(projectRow, PROJECT_COLUMNS) : undefined
    assert.deepEqual(project, PROJECT_ROW, 'project_core fields changed during upgrade')

    const characters = db.prepare(
      `SELECT ${CHARACTER_COLUMNS.join(', ')} FROM characters ORDER BY name`,
    ).all().map(row => normalizeRow(row, CHARACTER_COLUMNS))
    const expectedCharacters = [...CHARACTER_ROWS].sort((left, right) => left.name.localeCompare(right.name))
    assert.deepEqual(characters, expectedCharacters, 'characters fields or current state changed during upgrade')

    const blueprints = db.prepare(
      `SELECT ${BLUEPRINT_COLUMNS.join(', ')} FROM blueprints ORDER BY chapter_number`,
    ).all().map(row => normalizeRow(row, BLUEPRINT_COLUMNS))
    assert.deepEqual(blueprints, BLUEPRINT_ROWS, 'blueprint fields changed during upgrade')

    const contents = readRows(db, 'contents', CONTENT_COLUMNS, 'id')
    assert.deepEqual(contents, CONTENT_ROWS, 'content bodies changed during upgrade')

    const drafts = readRows(db, 'drafts', DRAFT_COLUMNS, 'id')
    assert.deepEqual(drafts, DRAFT_ROWS, 'draft or finalized records changed during upgrade')

    const reviews = readRows(db, 'reviews', REVIEW_COLUMNS, 'id')
    assert.deepEqual(reviews, REVIEW_ROWS, 'review records changed during upgrade')

    const revisions = readRows(db, 'revisions', REVISION_COLUMNS, 'id')
    assert.deepEqual(revisions, REVISION_ROWS, 'revision records changed during upgrade')

    const postProcessRuns = readRows(
      db,
      'post_process_runs',
      POST_PROCESS_RUN_COLUMNS,
      'id',
    )
    assert.deepEqual(
      postProcessRuns,
      POST_PROCESS_RUN_ROWS,
      'post-process run records changed during upgrade',
    )

    const postProcessSteps = readRows(
      db,
      'post_process_steps',
      POST_PROCESS_STEP_COLUMNS,
      'id',
    )
    assert.deepEqual(
      postProcessSteps,
      POST_PROCESS_STEP_ROWS,
      'post-process step records changed during upgrade',
    )

    const llmCalls = readRows(db, 'llm_calls', LLM_CALL_COLUMNS, 'id')
    assert.deepEqual(llmCalls, LLM_CALL_ROWS, 'LLM call history changed during upgrade')

    const summarySnapshots = readRows(
      db,
      'summary_snapshots',
      SUMMARY_SNAPSHOT_COLUMNS,
      'id',
    )
    assert.deepEqual(
      summarySnapshots,
      SUMMARY_SNAPSHOT_ROWS,
      'summary snapshots changed during upgrade',
    )

    return {
      databasePath: dbPath,
      legacyTableCount: Object.keys(V025_TABLE_COLUMNS).length,
      projectName: project.project_name,
      characterCount: characters.length,
      currentStateCount: characters.filter(character => character.cs_updated_at_chapter !== null).length,
      blueprintCount: blueprints.length,
      contentCount: contents.length,
      draftCount: drafts.length,
      finalizedDraftCount: drafts.filter(draft => draft.status === 'finalized').length,
      reviewCount: reviews.length,
      revisionCount: revisions.length,
      postProcessRunCount: postProcessRuns.length,
      postProcessStepCount: postProcessSteps.length,
      llmCallCount: llmCalls.length,
      failedLlmCallCount: llmCalls.filter(call => call.success === 0).length,
      summarySnapshotCount: summarySnapshots.length,
    }
  } finally {
    db.close()
  }
}

async function validate(projectRoot, settingsPath) {
  const databaseEvidence = validateDatabase(projectRoot)
  const embeddingSpace = await validateEmbeddingAssets(projectRoot)
  const inventoryEvidence = validateAssetInventory(
    projectRoot,
    settingsPath,
    databaseEvidence,
    embeddingSpace,
  )
  return {
    ...databaseEvidence,
    ...inventoryEvidence,
    embeddingSpace,
  }
}

async function main() {
  const [mode, projectRoot, settingsPath] = process.argv.slice(2)
  if (!projectRoot || (mode !== 'seed' && mode !== 'validate')) {
    throw new Error('Usage: electron upgrade-data-fixture.mjs <seed|validate> <project-root> [settings-path]')
  }

  const result = mode === 'seed'
    ? await seed(projectRoot, settingsPath)
    : await validate(projectRoot, settingsPath)
  process.stdout.write(`${JSON.stringify({ mode, ...result })}\n`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
