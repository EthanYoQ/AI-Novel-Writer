/**
 * 写作 Skill 的界面文案（设置页与工作流弹窗共用）。
 *
 * 抽出来的理由很实际：阶段名与内置 Skill 的英文名原本只长在 SkillSettings 里，
 * 而「AI 修稿确认 / 审稿确认」这些弹窗也要显示同一批名字 —— 各写一份迟早会漂移
 * （设置页叫「AI 审稿」，弹窗里叫「审稿阶段」，作者就得多想一秒）。
 *
 * 这里只放**界面措辞**，不放任何逻辑；阶段本身的定义仍在 shared/writing-skills。
 */
import type { WritingSkillStage } from '../shared/writing-skills'
import type { LoadedSkill } from '../services/agent/skill-registry'

type Translate = (zhCN: string, enUS: string) => string

export const WRITING_SKILL_STAGE_COPY: Record<WritingSkillStage, readonly [string, string]> = {
  planning: ['设定与规划', 'Planning'],
  drafting: ['章节正文', 'Chapter drafting'],
  review: ['AI 审稿', 'AI review'],
  refinement: ['修稿与定稿前润色', 'Revision and pre-final polish'],
}

export const WRITING_SKILL_SOURCE_COPY = {
  builtin: ['内置', 'Built-in'],
  user: ['用户', 'User'],
  project: ['项目', 'Project'],
} as const

/**
 * 内置 Skill 的英文界面副本。
 *
 * 内置技能的 displayName 与描述在 SKILL.md 里只有中文（或中英混排），英文界面下
 * 直接显示会突兀，所以这里按 skillId 补一份英文；用户自带的不翻译 —— 作者的原文
 * 不该被我们改写。
 */
export const BUILTIN_SKILL_COPY_EN: Record<string, readonly [string, string]> = {
  'builtin:long-form-continuity': [
    'Long-form Continuity and Scene Progression',
    'Preserves author facts, causal chains, character state, and foreshadowing progress during planning and drafting.',
  ],
  'builtin:natural-prose-refinement': [
    'Natural Prose Refinement',
    'Reduces formulaic phrasing during revision so actions, sensory details, and sentence rhythm serve the characters and scene.',
  ],
  'builtin:review-chapter': [
    'Chapter Review',
    'Reviews a chapter for plot logic, character consistency, pacing, foreshadowing, and prose quality.',
  ],
  'builtin:brainstorm': [
    'Creative Brainstorming',
    'Generates multiple creative directions and ideas for a chosen topic.',
  ],
  'builtin:character-analysis': [
    'Character Analysis',
    "Analyzes a character's personality, motivation, arc, and relationships in depth.",
  ],
  'builtin:continuity-check': [
    'Continuity Check',
    'Checks the novel for continuity and setting inconsistencies, contradictions, and omissions.',
  ],
  'builtin:writing-coach': [
    'Writing Coach',
    'Provides professional writing guidance and suggestions for improving prose.',
  ],
}

export function skillLabel(skill: LoadedSkill): string {
  return skill.metadata.displayName ?? skill.metadata.name
}

export function localizedSkillLabel(skill: LoadedSkill, text: Translate): string {
  const copy = BUILTIN_SKILL_COPY_EN[skill.skillId]
  return copy ? text(skillLabel(skill), copy[0]) : skillLabel(skill)
}

export function localizedSkillDescription(skill: LoadedSkill, text: Translate): string {
  const copy = BUILTIN_SKILL_COPY_EN[skill.skillId]
  return copy ? text(skill.metadata.description, copy[1]) : skill.metadata.description
}

export function stageCopy(text: Translate, stage: WritingSkillStage): string {
  const copy = WRITING_SKILL_STAGE_COPY[stage]
  return text(copy[0], copy[1])
}
