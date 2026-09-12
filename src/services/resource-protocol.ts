import type { ProjectSessionContext } from '../shared/ipc-channels'
import { parseResourceUri, resourceWriteAllowed } from '../shared/project-paths'
import { ipc } from './ipc-client'
export { parseResourceUri, formatResourceUri, canonicalResourceUri, isResourceUri, resourceWriteAllowed } from '../shared/project-paths'

export const CORE_FIELD_MAP: Record<string, string> = { premise: 'premise', worldbuilding: 'worldbuilding', characters: 'charactersArch', synopsis: 'synopsis' }
export function parseCoreField(value: string): string | null {
  const resource = parseResourceUri(value)
  return resource?.kind === 'core' ? CORE_FIELD_MAP[resource.key]! : null
}
export async function readCoreContent(value: string, session: ProjectSessionContext): Promise<string> {
  const resource = parseResourceUri(value)
  if (resource?.kind !== 'core') throw new Error('INVALID_RESOURCE_URI')
  if (resource.key === 'characters') {
    const roster = await ipc.invokeWithProjectSession(session, 'db:character-roster-read', session.projectPath)
    return roster.status === 'ready' ? roster.renderedMarkdown : roster.legacyMarkdown ?? ''
  }
  const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', session.projectPath)
  if (!core) throw new Error('无法读取故事架构内容')
  return core[resource.key] || ''
}
export async function writeCoreContent(value: string, content: string, session: ProjectSessionContext): Promise<boolean> {
  const resource = parseResourceUri(value)
  if (resource?.kind !== 'core' || !resourceWriteAllowed(value)) return false
  const result = await ipc.invokeWithProjectSession(session, 'db:project-core-update', { [CORE_FIELD_MAP[resource.key]!]: content }, session.projectPath)
  return result.success === true
}
export async function readResourceContent(value: string, session: ProjectSessionContext): Promise<string> {
  const resource = parseResourceUri(value)
  if (!resource) throw new Error('INVALID_RESOURCE_URI')
  if (resource.kind === 'core') return readCoreContent(value, session)
  if (!('id' in resource)) throw new Error('RESOURCE_REQUIRES_DOMAIN_RESOLVER')
  const full = resource.kind === 'draft' || resource.kind === 'manuscript'
    ? await ipc.invokeWithProjectSession(session, 'db:draft-get-full', resource.id, session.projectPath)
    : resource.kind === 'revision' ? await ipc.invokeWithProjectSession(session, 'db:revision-get-full', resource.id, session.projectPath)
      : await ipc.invokeWithProjectSession(session, 'db:review-get-full', resource.id, session.projectPath)
  if (!full) throw new Error('虚拟资源不存在或无法读取')
  return full.content
}
