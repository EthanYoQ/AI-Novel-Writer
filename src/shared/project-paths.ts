/**
 * 项目目录结构常量
 *
 * 全量 DB 化后，项目根目录只剩下：
 * 1. 定稿后的 .txt 投影文件
 * 2. .vela 隐藏目录（包含数据库与模板）
 */

/** 定稿输出目录 */


/** 内部系统隐藏目录（数据库、提示词模板等） */
export const DIR_VELA_INTERNAL = '.vela'

/** 自定义提示词模板目录（保留文件 IO 以便用户自定义修改） */
export const DIR_PROMPTS = '.vela/prompts'

/** Virtual DB resources are not filesystem capabilities. Legacy input is read-only. */
export type CoreResourceKey = 'premise' | 'worldbuilding' | 'characters' | 'synopsis'
export type ResourceAddress =
  | { kind: 'core'; key: CoreResourceKey }
  | { kind: 'draft' | 'manuscript' | 'revision' | 'review'; id: number }
  | { kind: 'chapter'; chapter: number; version?: number; reviewIndex?: number }
  | { kind: 'recovery'; candidateId: string }
export type ParsedResource = ResourceAddress & { legacy: boolean }
const positiveId = (value: string): number | null => /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
export function parseResourceUri(value: string): ParsedResource | null {
  const match = /^(ai-novel|vela):\/\/([^?#%\\\s]+)$/u.exec(value)
  if (!match) return null
  const legacy = match[1] === 'vela'
  const parts = match[2]!.split('/')
  if (parts[0] === 'core' && parts.length === 2 && ['premise', 'worldbuilding', 'characters', 'synopsis'].includes(parts[1]!)) return { kind: 'core', key: parts[1] as CoreResourceKey, legacy }
  if (['draft', 'manuscript', 'revision', 'review'].includes(parts[0]!) && parts.length === 2) {
    const id = positiveId(parts[1]!)
    if (id !== null) return { kind: parts[0] as 'draft' | 'manuscript' | 'revision' | 'review', id, legacy }
  }
  const chapter = /^draft\/ch([1-9]\d*)(?:\/v([1-9]\d*)(?:\/review(0|[1-9]\d*))?)?$/u.exec(match[2]!)
  if (chapter && positiveId(chapter[1]!) !== null && (!chapter[2] || positiveId(chapter[2]) !== null)
    && (!chapter[3] || Number.isSafeInteger(Number(chapter[3])))) return { kind: 'chapter', chapter: Number(chapter[1]), ...(chapter[2] ? { version: Number(chapter[2]) } : {}), ...(chapter[3] !== undefined ? { reviewIndex: Number(chapter[3]) } : {}), legacy }
  if (parts[0] === 'recovery' && parts.length === 2 && /^[A-Za-z0-9_-]+$/u.test(parts[1]!)) return { kind: 'recovery', candidateId: parts[1]!, legacy }
  return null
}
export function formatResourceUri(resource: ResourceAddress): string {
  const suffix = resource.kind === 'core' ? `core/${resource.key}`
    : resource.kind === 'chapter' ? `draft/ch${resource.chapter}${resource.version === undefined ? '' : `/v${resource.version}`}${resource.reviewIndex === undefined ? '' : `/review${resource.reviewIndex}`}`
      : resource.kind === 'recovery' ? `recovery/${resource.candidateId}` : `${resource.kind}/${resource.id}`
  const uri = `ai-novel://${suffix}`
  if (!parseResourceUri(uri)) throw new Error('INVALID_RESOURCE_URI')
  return uri
}
export function canonicalResourceUri(value: string): string | null {
  const resource = parseResourceUri(value)
  return resource ? formatResourceUri(resource) : null
}
export function isResourceUri(value: string): boolean { return parseResourceUri(value) !== null }
export function resourceWriteAllowed(value: string): boolean {
  const resource = parseResourceUri(value)
  return resource !== null && !resource.legacy && (resource.kind === 'draft' || resource.kind === 'core' && resource.key !== 'characters')
}
