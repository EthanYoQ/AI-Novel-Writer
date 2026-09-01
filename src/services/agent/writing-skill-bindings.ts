import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { WritingLanguage } from '../../shared/writing-language'
import {
  WRITING_SKILL_STAGES,
  type WritingSkillSource,
  type WritingSkillStage,
} from '../../shared/writing-skills'
import { ipc } from '../ipc-client'
import { skillRegistry } from './skill-registry'

interface WritingSkillBindingFile {
  version: 1
  bindings: Partial<Record<WritingSkillStage, string>>
}

export interface FrozenWritingSkill {
  readonly skillId: string
  readonly name: string
  readonly stage: WritingSkillStage
  readonly source: WritingSkillSource
  readonly writingLanguage: WritingLanguage
  readonly content: string
  readonly utf8Bytes: number
}

export type FrozenWritingSkillSnapshot = Readonly<Partial<Record<WritingSkillStage, FrozenWritingSkill>>>

const EMPTY_BINDINGS: WritingSkillBindingFile = { version: 1, bindings: {} }

function bindingPath(projectPath: string): string {
  return `${projectPath.replace(/[\\/]$/, '')}/.vela/writing-skills.json`
}

function parseBindings(value: unknown): WritingSkillBindingFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('写作 Skill 绑定文件已损坏（Writing skill binding file is invalid）')
  }
  const candidate = value as { version?: unknown; bindings?: unknown }
  if (candidate.version !== 1 || !candidate.bindings || typeof candidate.bindings !== 'object') {
    throw new Error('写作 Skill 绑定文件已损坏（Writing skill binding file is invalid）')
  }
  const bindings: Partial<Record<WritingSkillStage, string>> = {}
  for (const stage of WRITING_SKILL_STAGES) {
    const skillId = (candidate.bindings as Record<string, unknown>)[stage]
    if (skillId === undefined) continue
    if (
      typeof skillId !== 'string'
      || !/^(?:builtin|user|project):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillId)
    ) {
      throw new Error(`写作 Skill 绑定无效：${stage}（Invalid writing skill binding）`)
    }
    bindings[stage] = skillId
  }
  return { version: 1, bindings }
}

export async function loadWritingSkillBindings(
  projectSession: ProjectSessionContext,
): Promise<WritingSkillBindingFile> {
  const path = bindingPath(projectSession.projectPath)
  let exists: boolean
  try {
    exists = await ipc.invokeWithProjectSession(
      projectSession,
      'fs:check-exists',
      path,
      projectSession.projectPath,
    )
  } catch (error) {
    if (error instanceof ReferenceError && error.message === 'window is not defined') {
      return EMPTY_BINDINGS
    }
    throw error
  }
  if (!exists) return EMPTY_BINDINGS
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:read-file',
    path,
    projectSession.projectPath,
  )
  if (!result.success) {
    throw new Error(`无法读取写作 Skill 绑定（Could not read writing skill bindings）：${result.error || 'unknown error'}`)
  }
  try {
    return parseBindings(JSON.parse(result.content))
  } catch (error) {
    if (error instanceof Error && /Skill/.test(error.message)) throw error
    throw new Error('写作 Skill 绑定文件已损坏（Writing skill binding file is invalid）')
  }
}

function requireBoundSkill(skillId: string) {
  const skill = skillRegistry.getById(skillId)
  if (!skill) {
    throw new Error(`写作 Skill 绑定目标不存在：${skillId}（Writing skill binding target is missing）`)
  }
  if (!skill.writingSkill.compatible) {
    throw new Error(`写作 Skill 绑定目标不兼容：${skillId}（Writing skill binding target is incompatible）`)
  }
  return skill
}

export async function saveWritingSkillBinding(
  projectSession: ProjectSessionContext,
  stage: WritingSkillStage,
  skillId: string | null,
): Promise<void> {
  if (!WRITING_SKILL_STAGES.includes(stage)) throw new Error('Invalid writing skill stage')
  if (skillId !== null) {
    const skill = skillRegistry.getById(skillId)
    if (skill && !skill.writingSkill.compatible) {
      throw new Error('Incompatible writing skills cannot be bound to a workflow stage')
    }
    if (!/^(?:builtin|user|project):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillId)) {
      throw new Error('Invalid writing skill identifier')
    }
  }
  const current = await loadWritingSkillBindings(projectSession)
  const bindings = { ...current.bindings }
  if (skillId) bindings[stage] = skillId
  else delete bindings[stage]
  const result = await ipc.invokeWithProjectSession(
    projectSession,
    'fs:write-file',
    bindingPath(projectSession.projectPath),
    `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`,
    projectSession.projectPath,
  )
  if (!result.success) throw new Error(result.error || 'Could not save writing skill bindings')
}

export async function freezeWritingSkill(
  projectSession: ProjectSessionContext,
  stage: WritingSkillStage,
  writingLanguage: WritingLanguage,
): Promise<FrozenWritingSkill | null> {
  const { bindings } = await loadWritingSkillBindings(projectSession)
  const skillId = bindings[stage]
  if (!skillId) return null
  const skill = requireBoundSkill(skillId)
  const content = skill.localizedContent?.[writingLanguage] ?? skill.content
  return Object.freeze({
    skillId,
    name: skill.metadata.displayName ?? skill.metadata.name,
    stage,
    source: skill.source,
    writingLanguage,
    content,
    utf8Bytes: new TextEncoder().encode(content).byteLength,
  })
}

export async function freezeWritingSkillsSnapshot(
  projectSession: ProjectSessionContext,
  writingLanguage: WritingLanguage,
): Promise<FrozenWritingSkillSnapshot> {
  await skillRegistry.loadAll()
  const { bindings } = await loadWritingSkillBindings(projectSession)
  const snapshot: Partial<Record<WritingSkillStage, FrozenWritingSkill>> = {}
  for (const stage of WRITING_SKILL_STAGES) {
    const skillId = bindings[stage]
    if (!skillId) continue
    const skill = requireBoundSkill(skillId)
    const content = skill.localizedContent?.[writingLanguage] ?? skill.content
    snapshot[stage] = Object.freeze({
      skillId,
      name: skill.metadata.displayName ?? skill.metadata.name,
      stage,
      source: skill.source,
      writingLanguage,
      content,
      utf8Bytes: new TextEncoder().encode(content).byteLength,
    })
  }
  return Object.freeze(snapshot)
}
