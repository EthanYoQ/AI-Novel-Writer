import { describe, expect, it } from 'vitest'
import { appErrorMessage, displayedErrorMessage, knownAppErrorMessage } from '../app-errors'

describe('localized application errors', () => {
  it('maps stable error codes to localized messages', () => {
    expect(appErrorMessage('en-US', { code: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' }))
      .toContain('Windows native component')
    expect(appErrorMessage('zh-CN', { code: 'PROJECT_NOT_OPEN' }))
      .toBe('请先打开项目。')
    expect(appErrorMessage('en-US', { errorCode: 'PROJECT_NOT_OPEN' }))
      .toBe('Open a project first.')
    expect(appErrorMessage('zh-CN', { errorCode: 'PROJECT_ROOT_REQUIRED' }))
      .toContain('请选择项目根目录')
    expect(appErrorMessage('en-US', { errorCode: 'PROJECT_ROOT_REQUIRED' }))
      .toContain('Select the project root folder')
  })

  it('preserves an unknown error as localized diagnostic text', () => {
    expect(appErrorMessage('en-US', new Error('disk full'))).toBe('Something went wrong: disk full')
  })
})

it.each(['KNOWLEDGE_BASE_NATIVE_UNAVAILABLE','LEGACY_VECTOR_MIGRATION_BLOCKED'])('maps knowledge preparation IPC error %s without exposing internal details', code => {
 expect(appErrorMessage('en-US',new Error(`Error invoking remote method 'generation:prepare-draft-context': Error: ${code}`)))
   .toBe(appErrorMessage('en-US',{errorCode:code}))
})

describe('generation error codes from the main process', () => {
  it.each([
    ["Error invoking remote method 'generation:commit-draft': Error: GENERATION_DRAFT_DEPENDENCY_STALE", '前一章'],
    ["Error invoking remote method 'generation:begin': Error: GENERATION_DRAFT_NOT_CURRENT", '当前稿'],
    ["Error invoking remote method 'review-revision:prepare': Error: GENERATION_REVIEW_LINEAGE_UNPROVEN", '重新审稿'],
    ["Error invoking remote method 'character-proposal:list-pending-finalized': Error: GENERATION_PROJECT_SESSION_STALE", '重新打开'],
    ['Error: GENERATION_REQUEST_FAILED', '重试'],
    ["Error invoking remote method 'finalization-generation:commit': Error: FINALIZED_CHARACTER_SOURCE_CONFLICT", '当前状态'],
    ["Error invoking remote method 'finalization-generation:commit': Error: FINALIZED_CHARACTER_FIELD_CONFLICT", '生成期间'],
  ])('turns %s into a full sentence without the IPC wrapper', (raw, hint) => {
    for (const error of [raw, new Error(raw)]) {
      const zh = knownAppErrorMessage('zh-CN', error)
      expect(zh).toContain(hint)
      expect(zh).not.toMatch(/Error invoking|GENERATION_|FINALIZED_/u)
      expect(knownAppErrorMessage('en-US', error)).toMatch(/^[A-Z][^_]+\.$/u)
    }
  })

  it('leaves unregistered codes and prose to the caller', () => {
    expect(knownAppErrorMessage('zh-CN', "Error invoking remote method 'generation:begin': Error: GENERATION_SOMETHING_NEW")).toBeUndefined()
    expect(knownAppErrorMessage('zh-CN', '模型服务返回 HTTP 429')).toBeUndefined()
  })
})

it('does not promise that a stale-session action never ran', () => {
  // 主进程可能已经处理完，只是结果因会话失效被拒；文案只能说结果不可用。
  const raw = "Error invoking remote method 'generation:begin': Error: GENERATION_PROJECT_SESSION_STALE"
  const zh = knownAppErrorMessage('zh-CN', raw)!, en = knownAppErrorMessage('en-US', raw)!
  expect(zh).toContain('结果不可用')
  expect(zh).not.toMatch(/没有执行|未执行/u)
  expect(en).toContain('result')
  expect(en).not.toMatch(/did not run|was not run/iu)
})

// GENERATION_MODEL_CHANGED 由主进程续跑情节大纲时抛出，GENERATION_IMPORT_MODEL_CHANGED 由导入生成抛出；GENERATION_SOURCE_CHANGED_MODEL 由 #453 抛出。
it.each(['GENERATION_MODEL_CHANGED', 'GENERATION_IMPORT_MODEL_CHANGED', 'GENERATION_SOURCE_CHANGED_MODEL'])('explains %s mid-generation instead of falling back to the raw code', code => {
  const wrapped = `Error invoking remote method 'generation:execute': Error: ${code}`
  expect(knownAppErrorMessage('zh-CN', wrapped)).toContain('模型设置被修改')
  expect(knownAppErrorMessage('en-US', wrapped)).toContain('model settings changed')
})

// GENERATION_SKILL_BUNDLE_DAMAGED 由 #443 抛出，GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE 由 #447 抛出；无论哪个 PR 先合入都已登记。
it.each([
  ['GENERATION_SKILL_BUNDLE_DAMAGED', '重新导入', 'import'],
  ['GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE', '生成记录已变化', 'generation record changed'],
])('explains %s instead of falling back to the raw code', (code, zh, en) => {
  const wrapped = `Error invoking remote method 'generation:execute': Error: ${code}`
  expect(knownAppErrorMessage('zh-CN', wrapped)).toContain(zh)
  expect(knownAppErrorMessage('en-US', wrapped)).toContain(en)
})

// 这两个码在保存时的来源复核里也会抛出，那时模型已经回答过。
it.each(['GENERATION_DRAFT_NOT_CURRENT', 'GENERATION_FINALIZED_SOURCE_NOT_CURRENT'])('does not promise that %s happened before any model request', code => {
  const raw = `Error invoking remote method 'generation:commit-draft': Error: ${code}`
  expect(knownAppErrorMessage('zh-CN', raw)).not.toMatch(/没有调用模型|未调用模型/u)
  expect(knownAppErrorMessage('en-US', raw)).not.toMatch(/no model request/iu)
})

it('does not blame a book switch when the request carried no session at all', () => {
  const raw = "Error invoking remote method 'generation:begin': Error: GENERATION_PROJECT_SESSION_REQUIRED"
  const zh = knownAppErrorMessage('zh-CN', raw)!, en = knownAppErrorMessage('en-US', raw)!
  expect(zh).toContain('重新打开')
  expect(zh).not.toContain('已切换')
  expect(en).not.toMatch(/switched/iu)
})

// 审计点名的四个码与已登记的 GENERATION_SOURCE_CHANGED 走同一条转发路径、同一种作者情境（生成途中依据变了）。
it.each([
  'GENERATION_SOURCE_CHANGED_DURING_SNAPSHOT',
  'GENERATION_ASSET_CHANGED_DURING_SNAPSHOT',
  'GENERATION_REVIEW_CONTEXT_CHANGED',
  'GENERATION_AUTHOR_DRAFT_CHANGED',
])('explains %s as a mid-run source change', code => {
  const wrapped = `Error invoking remote method 'generation:begin': Error: ${code}`
  expect(knownAppErrorMessage('zh-CN', wrapped)).toBe(knownAppErrorMessage('zh-CN', 'GENERATION_SOURCE_CHANGED'))
  expect(knownAppErrorMessage('en-US', wrapped)).toBe(knownAppErrorMessage('en-US', 'GENERATION_SOURCE_CHANGED'))
})

// 名单版本冲突与角色不存在既来自批准角色提议，也来自普通的角色卡保存：说明不能只指向提议（#474 审计）。
it.each(['CHARACTER_ID_REVISION_CONFLICT', 'CHARACTER_ID_UNKNOWN'])('explains %s without assuming a proposal is open', code => {
  expect(knownAppErrorMessage('en-US', code)).not.toMatch(/proposal/iu)
  expect(knownAppErrorMessage('zh-CN', code)).not.toContain('提议')
})

describe('project session and external file errors from the main process (#474 B4)', () => {
  it.each([
    // db 读通道原样抛出：Electron 包上通道名，错误类名代替了 "Error"。
    ["Error invoking remote method 'db:draft-list': ProjectSessionStaleError: PROJECT_SESSION_DATABASE_MISMATCH", 'The project was switched or reopened'],
    // db 写通道返回 { error: String(error) }。
    ['ProjectSessionStaleError: PROJECT_SESSION_STALE', 'The project was switched or reopened'],
    ["Error invoking remote method 'kb:stats': Error: PROJECT_SESSION_REQUIRED", 'did not carry the session of the open project'],
    ['Error: PROJECT_CONTEXT_CHANGED', 'The project was switched or reopened'],
    ["Error invoking remote method 'project:create': Error: EXTERNAL_FILE_GRANT_EXPIRED", 'Choose it again'],
  ])('explains %s in English without the wrapper or the code', (raw, english) => {
    expect(appErrorMessage('en-US', raw)).toContain(english)
    expect(appErrorMessage('en-US', raw)).not.toMatch(/Error|PROJECT_|EXTERNAL_/u)
    expect(appErrorMessage('zh-CN', raw)).not.toMatch(/[A-Z]{3,}_/u)
  })

  it('translates a registered code thrown by a dialog handler and keeps renderer copy as is', () => {
    const exists = new Error("Error invoking remote method 'dialog:select-project-archive-export': Error: PROJECT_ARCHIVE_TARGET_EXISTS")
    expect(displayedErrorMessage('en-US', exists)).toBe('The target file already exists. Choose another file name; project archives never overwrite existing files.')
    expect(displayedErrorMessage('zh-CN', exists)).toBe('目标文件已存在，请选择其他文件名。项目存档不会覆盖已有文件。')
    expect(displayedErrorMessage('en-US', new Error('PORTABLE_GRANT_INVALID'))).toBe('PORTABLE_GRANT_INVALID')
  })
})

describe('显示处统一的报错说明（#474 渲染层消费处）', () => {
  it.each(['zh-CN', 'en-US'] as const)('%s：剥掉通道与类名前缀再认码，认不出的保留原文，没有内容时用兜底', locale => {
    const stale = knownAppErrorMessage(locale, 'PROJECT_SESSION_STALE')!
    for (const raw of [
      'PROJECT_SESSION_STALE',
      'Error: PROJECT_SESSION_STALE',
      new Error('PROJECT_SESSION_STALE'),
      new Error("Error invoking remote method 'kb:clear-all': Error: PROJECT_SESSION_STALE"),
      { errorCode: 'PROJECT_SESSION_STALE' },
    ]) expect(displayedErrorMessage(locale, raw, '兜底')).toBe(stale)
    expect(displayedErrorMessage(locale, "Error invoking remote method 'fs:read': Error: EBUSY: resource busy", '兜底')).toBe('EBUSY: resource busy')
    expect(displayedErrorMessage(locale, new Error("Error invoking remote method 'fs:read': TypeError: boom"), '兜底')).toBe('boom')
    expect(displayedErrorMessage(locale, '模型服务返回 HTTP 429', '兜底')).toBe('模型服务返回 HTTP 429')
    for (const empty of [undefined, null, '', '  ', new Error('')]) expect(displayedErrorMessage(locale, empty, '兜底')).toBe('兜底')
    // IPC 之外 reject 的普通对象：有字符串 message 就用它，没有就用兜底，不显示 [object Object]。
    expect(displayedErrorMessage(locale, { message: '磁盘只读' }, '兜底')).toBe('磁盘只读')
    expect(displayedErrorMessage(locale, { success: false }, '兜底')).toBe('兜底')
  })

  // project:create / project:open 的 catch 把 resolveDirectoryPath 抛出的码经 String(error) 原样放进 result.error。
  it.each(['zh-CN', 'en-US'] as const)('%s：选好的文件夹在使用前被移动或替换时，不把 EXTERNAL_FILE_GRANT_TARGET_CHANGED 交给作者', locale => {
    const shown = displayedErrorMessage(locale, 'Error: EXTERNAL_FILE_GRANT_TARGET_CHANGED')
    expect(shown).not.toMatch(/EXTERNAL_FILE_GRANT|Error:/u)
    expect(appErrorMessage(locale, 'Error: EXTERNAL_FILE_GRANT_TARGET_CHANGED')).toBe(shown)
  })
})

describe('cast, blueprint and draft errors from the main process (#474 B2)', () => {
  it.each([
    // 可写 db 通道返回 { error: String(error) }。
    ['Error: DRAFT_FINALIZED_READ_ONLY', 'This chapter is finalized', '这一章已经定稿'],
    ['Error: CHARACTER_ROSTER_REVISION_STALE', 'The cast changed in the meantime', '角色名单在这期间被改动了'],
    ['Error: CHARACTER_ROSTER_RELATIONSHIP_TARGET_UNKNOWN', 'must point to a character in the cast', '对象也必须是名单里已有的角色'],
    ["Error invoking remote method 'db:blueprint-character-sync-complete': Error: BLUEPRINT_CHARACTER_SYNC_ROSTER_NOT_READY", 'The cast needs repair first', '角色名单需要先修复'],
  ])('explains %s in the interface language without the code', (raw, english, chinese) => {
    expect(displayedErrorMessage('en-US', new Error(raw))).toContain(english)
    expect(displayedErrorMessage('en-US', new Error(raw))).not.toMatch(/[A-Z]{3,}_|\p{Script=Han}/u)
    expect(displayedErrorMessage('zh-CN', new Error(raw))).toContain(chinese)
    expect(displayedErrorMessage('zh-CN', new Error(raw))).not.toMatch(/[A-Z]{3,}_/u)
  })
})

describe('knowledge base and search index errors from the main process (#474 B3)', () => {
  it.each([
    // kb 通道的结果值：{ success: false, error: 码 }。
    ['KNOWLEDGE_BASE_COPY_CHANGED', 'Reopen the material', '请重新打开这份资料'],
    ['EMBEDDING_RESPONSE_INVALID', 'returned an unusable result', '返回的结果不合格'],
    // 检索与读取原样抛出：Electron 包上通道名与 "Error: "。
    ["Error invoking remote method 'kb:search': Error: EMBEDDING_SPACE_REGISTRY_INVALID", 'search index records of this book are damaged', '检索索引记录已损坏'],
    // vector-store 的 catch 曾用 String(error) 交出 "Error: 码"。
    ['Error: EMBEDDING_SPACE_UNREGISTERED_DATA', 'search index records of this book are damaged', '检索索引记录已损坏'],
  ])('explains %s in the interface language without the code', (raw, english, chinese) => {
    expect(appErrorMessage('en-US', raw)).toContain(english)
    expect(appErrorMessage('en-US', raw)).not.toMatch(/[A-Z]{3,}_|\p{Script=Han}/u)
    expect(appErrorMessage('zh-CN', raw)).toContain(chinese)
    expect(appErrorMessage('zh-CN', raw)).not.toMatch(/[A-Z]{3,}_/u)
  })

  it('prefers the code of a result whose error text was written in the system language', () => {
    const blocked = {
      success: false,
      errorCode: 'LEGACY_VECTOR_MIGRATION_BLOCKED',
      error: '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。',
    }
    expect(knownAppErrorMessage('en-US', blocked)).toContain('Legacy knowledge-base data must be repaired')
  })
})

describe('model, model settings and MCP errors from the main process (#474 B6)', () => {
  it.each([
    // llm-controller 的 catch 用 String(error) 交出 "Error: 码"。
    ['Error: LLM_GLOBAL_CONFIG_CORRUPT', 'model settings file is damaged', '模型设置文件已损坏'],
    ['Error: LLM_DEFAULT_MODEL_ROLLBACK_FAILED', 'model was not deleted', '模型没有删除'],
    ['Error: LLM_STAGE_MODEL_UNAVAILABLE', 'no longer available for writing', '不能用于文本生成'],
    ['Error: LLM_STAGE_MODEL_REQUEST_INVALID', 'stage setting was not saved', '分工设置没有保存'],
    // 执行租约的码由 ModelExecutionLeaseError 抛出，带自己的类名。
    ['ModelExecutionLeaseError: MODEL_ENDPOINT_INVALID', 'Base URL is invalid', 'Base URL 无效'],
    ['GENERATION_KIMI_TEMPERATURE_INVALID', 'temperature from 0 to 1', '温度必须在 0 到 1 之间'],
    // mcp 通道的结果值与工具调用的 String(error)。
    ['MCP_CONFIG_INVALID', 'MCP configuration file is damaged', 'MCP 配置文件损坏'],
    ['MCP_CONNECT_FAILED', 'Could not connect to the MCP server', 'MCP 服务器连接失败'],
    ['Error: MCP_REQUEST_TIMEOUT', 'did not respond in time', '没有及时响应'],
  ])('explains %s in the interface language without the code', (raw, english, chinese) => {
    expect(appErrorMessage('en-US', raw)).toContain(english)
    expect(appErrorMessage('en-US', raw)).not.toMatch(/[A-Z]{3,}_|\p{Script=Han}/u)
    expect(appErrorMessage('zh-CN', raw)).toContain(chinese)
    expect(appErrorMessage('zh-CN', raw)).not.toMatch(/[A-Z]{3,}_/u)
  })
})

it('names the output limit setting by its field label when that setting is invalid', () => {
  expect(appErrorMessage('zh-CN', { errorCode: 'MODEL_OUTPUT_LIMIT_INVALID' })).toContain('最大输出 Tokens')
  expect(appErrorMessage('en-US', { errorCode: 'MODEL_OUTPUT_LIMIT_INVALID' })).toContain('max output tokens')
})
