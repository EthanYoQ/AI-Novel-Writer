import type { NovelConfig } from '../../shared/ipc-channels'

export const GENERATED_GLOBAL_GUIDANCE_MAX_CHARS = 600
export const GENERATED_GLOBAL_GUIDANCE_MIN_RULES = 4
export const GENERATED_GLOBAL_GUIDANCE_MAX_RULES = 8

export function generatedGlobalGuidanceRuleCount(content: string): number {
  return content
    .split(/\r?\n/u)
    .map(rule => rule.trim())
    .filter(Boolean)
    .length
}

export function isGeneratedGlobalGuidanceValid(content: string): boolean {
  const ruleCount = generatedGlobalGuidanceRuleCount(content)
  return Array.from(content.trim()).length <= GENERATED_GLOBAL_GUIDANCE_MAX_CHARS
    && ruleCount >= GENERATED_GLOBAL_GUIDANCE_MIN_RULES
    && ruleCount <= GENERATED_GLOBAL_GUIDANCE_MAX_RULES
}

export const EXPANDABLE_NOVEL_CONFIG_FIELDS = [
  'coreOutline',
  'worldSetting',
  'goldenFinger',
  'protagonistProfile',
  'globalGuidance',
  'writingStyle',
] as const satisfies readonly (keyof NovelConfig)[]

const AUTHOR_CHOICE_FIELDS = [
  'genre',
  'subGenre',
  'targetAudience',
  'plotStructure',
  'narrativePOV',
] as const satisfies readonly (keyof NovelConfig)[]

export function preserveAuthorText(existing: string | undefined, generated: string | undefined): string {
  const authorText = existing?.trim() ?? ''
  const generatedText = generated?.trim() ?? ''
  if (!authorText) return generatedText
  if (!generatedText || generatedText.includes(authorText)) return generatedText || authorText
  return `${authorText}\n\n${generatedText}`
}

export function mergeExpandedNovelConfig(
  existing: Partial<NovelConfig>,
  generated: Partial<NovelConfig>,
): Partial<NovelConfig> {
  const merged: Partial<NovelConfig> = { ...generated }
  for (const field of EXPANDABLE_NOVEL_CONFIG_FIELDS) {
    merged[field] = preserveAuthorText(existing[field], generated[field])
  }
  for (const field of AUTHOR_CHOICE_FIELDS) {
    const authorChoice = existing[field]
    if (typeof authorChoice === 'string' && authorChoice.trim()) {
      Object.assign(merged, { [field]: authorChoice })
    }
  }
  return merged
}
