import type Database from 'better-sqlite3'
import { ProjectCoreRepository, type ProjectCoreData } from '../repositories/project-core-repository'
import { BlueprintRepository, type BlueprintData } from '../repositories/blueprint-repository'
import { textHash } from '../repositories/generation-run-repository'
import type { AgentDomainToolReceipt } from '../../src/shared/agent-generation'

const configStrings = new Set(['genre', 'subGenre', 'targetAudience', 'coreOutline', 'worldSetting', 'goldenFinger', 'protagonistProfile', 'globalGuidance', 'writingStyle', 'referenceWorks'])
const configEnums: Record<string, readonly string[]> = { plotStructure: ['three_act', 'heros_journey', 'save_the_cat', 'kishotenketsu', 'multi_thread', 'freeform'],
  narrativePOV: ['third_limited', 'first_person', 'third_omniscient', 'multi_pov'], writingLanguage: ['zh-CN', 'en-US'] }
const blueprintStrings = new Set(['title', 'role', 'purpose', 'keyEvents', 'suspenseHook', 'userGuidance', 'notes'])
const fail = (): never => { throw new Error('GENERATION_AGENT_DOMAIN_TOOL_INVALID') }
export function isAgentDomainToolCurrent(db: Database.Database, receipt: AgentDomainToolReceipt): boolean {
  const current = receipt.kind === 'config' ? ProjectCoreRepository.get(db)
    : BlueprintRepository.getAll(db).find(row => row.chapterNumber === receipt.chapterNumber)
  return !!current && textHash(JSON.stringify(current)) === receipt.afterHash
}

/** Called only inside the captured project's transaction, with a confirmed actual action. */
export function commitAgentDomainTool(db: Database.Database, toolCallId: string, name: string, args: Record<string, unknown>): AgentDomainToolReceipt {
  if (!db.inTransaction || !['propose_novel_config', 'propose_chapter_blueprint'].includes(name)) fail()
  const candidate = args.changes
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || !Object.keys(candidate).length) fail()
  const changes: Record<string, unknown> = {}
  const config = name === 'propose_novel_config'
  for (const [original, raw] of Object.entries(candidate as Record<string, unknown>)) {
    const field = config ? original === 'narrativePov' ? 'narrativePOV' : original : ['作者微操指导', '用户指引'].includes(original) ? 'userGuidance' : original
    const value = field === 'writingLanguage' ? raw === '简体中文' ? 'zh-CN' : raw === 'English' ? 'en-US' : raw : raw
    if (Object.hasOwn(changes, field)) fail()
    if ((config ? configStrings : blueprintStrings).has(field)) { if (typeof value !== 'string') fail() }
    else if (config && ['totalChapters', 'wordsPerChapter'].includes(field)) { if (!Number.isSafeInteger(value) || Number(value) < 1) fail() }
    else if (config && Object.hasOwn(configEnums, field)) { if (typeof value !== 'string' || !configEnums[field]!.includes(value)) fail() }
    else if (!config && field === 'characters') { if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail() }
    else fail()
    changes[field] = structuredClone(value)
  }
  if (config) {
    const before = ProjectCoreRepository.get(db)
    if (!before) fail()
    const data = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key === 'narrativePOV' ? 'narrativePov' : key, value])) as Partial<ProjectCoreData>
    ProjectCoreRepository.update(data, db)
    return { kind: 'config', toolCallId, changes, beforeHash: textHash(JSON.stringify(before)), afterHash: textHash(JSON.stringify(ProjectCoreRepository.get(db))) }
  }
  const chapterNumber = args.chapter_number
  if (!Number.isSafeInteger(chapterNumber) || Number(chapterNumber) < 1) fail()
  const before = BlueprintRepository.getAll(db).find(row => row.chapterNumber === chapterNumber)
  if (!before) fail()
  BlueprintRepository.upsert({ ...before, ...changes } as BlueprintData, db)
  return { kind: 'blueprint', toolCallId, changes, chapterNumber: Number(chapterNumber), beforeHash: textHash(JSON.stringify(before)),
    afterHash: textHash(JSON.stringify(BlueprintRepository.getAll(db).find(row => row.chapterNumber === chapterNumber))) }
}
