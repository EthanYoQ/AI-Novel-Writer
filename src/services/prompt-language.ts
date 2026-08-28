import type { WritingLanguage } from '../shared/writing-language'

export interface PromptLanguageTemplate {
  systemRole: string
  content: string
  systemSuffix?: string
}

export interface CharacterArchitecturePromptSet {
  manifestSystem: string
  detailSystem: string
  detailContract: string
  manifestTask(context: string, minimum: number, maximum: number): string
  detailTask(input: {
    context: string
    manifest: string
    slotIds: string
    validatedPrefix: string
  }): string
}

/**
 * Built-in templates used by the forward-writing lifecycle. Every key in this
 * list must provide an English overlay; commands may not silently fall back to
 * the historical Chinese template for an English project.
 */
export const CORE_LOCALIZED_BUILTIN_PROMPT_KEYS = Object.freeze([
  'generate_global_config',
  'premise',
  'character_dynamics',
  'world_building',
  'synopsis',
  'chapter_blueprint',
  'chapter_blueprint_chunk',
  'first_chapter_draft',
  'next_chapter_draft',
  'refine_chapter',
  'consistency_check',
  'refine_from_review',
  'generate_chapter_notes',
  'update_character_cards',
] as const)

export type CoreLocalizedBuiltinPromptKey = typeof CORE_LOCALIZED_BUILTIN_PROMPT_KEYS[number]

const CORE_LOCALIZED_BUILTIN_PROMPT_KEY_SET = new Set<string>(CORE_LOCALIZED_BUILTIN_PROMPT_KEYS)

export function isCoreLocalizedBuiltinPromptKey(key: string): key is CoreLocalizedBuiltinPromptKey {
  return CORE_LOCALIZED_BUILTIN_PROMPT_KEY_SET.has(key)
}

const CHARACTER_ARCHITECTURE_PROMPTS: Readonly<Record<WritingLanguage, CharacterArchitecturePromptSet>> = {
  'zh-CN': {
    manifestSystem: `你是小说角色身份规划器。只规划角色身份、叙事职责和角色间关系，不生成角色详情。
只输出一个可由 JSON.parse 读取的 {"slots":[...]} 对象，不得输出 Markdown、解释、代码围栏或思考过程。`,
    detailSystem: `你是小说角色详情生成器。只为指定的冻结角色身份补全紧凑资料，不规划或改写角色身份和关系。
只输出一个可由 JSON.parse 读取的 {"entries":[...]} 对象，不得输出 schemaVersion、relationships、Markdown、解释、代码围栏或思考过程。`,
    detailContract: `【不可变角色详情 JSON 合同】
只输出 {"entries":[...]}。每项必须包含 slotId、name、role、gender、age、appearance、personality、background、abilities、motivation、arc、notes、currentState。
currentState 必填，必须包含 location、powerLevel、physicalState、mentalState、keyItems、recentEvents、updatedAtChapter；updatedAtChapter 必须是非负整数。
keyItems 可为非空字符串或非空字符串数组；recentEvents 可为非空字符串或非空字符串数组。数组每项必须是非空字符串，不得混入数字、对象或 null；没有内容时使用字符串“无”，不得输出空数组。
禁止输出 relationships、schemaVersion、角色图谱 Markdown、解释、代码围栏或思考过程。`,
    manifestTask: (context, minimum, maximum) => `【身份规划上下文】
${context}

【身份清单合同】
只输出 {"slots":[...]}，角色数量必须为 ${minimum}–${maximum}。每项必须含 slotId、name、role、narrativeDuty、relations；relations 每项含 targetSlotId、relation。slotId/name 必须唯一，role 仅 protagonist/antagonist/supporting/minor，且恰好一个 protagonist；关系只能引用本清单其他 slotId。`,
    detailTask: input => `【角色详情上下文】
${input.context}

${CHARACTER_ARCHITECTURE_PROMPTS['zh-CN'].detailContract}

【冻结身份与关系清单】
${input.manifest}

【本批必须完整生成的 slotId】
${input.slotIds}

【已验证详情前缀】
${input.validatedPrefix}

【详情精炼长度合同】
appearance/personality/abilities/motivation/arc/notes 各不超过 300 字符；background 不超过 500 字符；currentState 必填，其各文本字段不超过 300 字符。禁止输出 relationships，关系由冻结身份清单唯一生成。

只输出 {"entries":[...]}。每项必须额外回显 slotId，name/role 必须与冻结清单完全一致。不得复制、改写或补充关系。`,
  },
  'en-US': {
    manifestSystem: 'You plan character identities, narrative duties, and relationships for a novel. Do not generate character details. Output exactly one JSON.parse-compatible {"slots":[...]} object with no Markdown, explanation, code fence, or reasoning.',
    detailSystem: 'You complete compact character records for explicitly frozen identities. Do not plan or alter identities or relationships. Output exactly one JSON.parse-compatible {"entries":[...]} object with no schemaVersion, relationships, Markdown, explanation, code fence, or reasoning.',
    detailContract: `[Immutable character-detail JSON contract]
Output {"entries":[...]} only. Every entry must contain slotId, name, role, gender, age, appearance, personality, background, abilities, motivation, arc, notes, and currentState.
currentState is required and must contain location, powerLevel, physicalState, mentalState, keyItems, recentEvents, and a non-negative integer updatedAtChapter.
keyItems and recentEvents may each be a non-empty string or an array of non-empty strings. Use the string "none" when empty; never output an empty array.
Do not output relationships, schemaVersion, a rendered character map, explanations, code fences, or reasoning.`,
    manifestTask: (context, minimum, maximum) => `[Identity-planning context]
${context}

[Identity manifest contract]
Output {"slots":[...]} only, with ${minimum}–${maximum} characters. Every item must contain slotId, name, role, narrativeDuty, and relations; every relation must contain targetSlotId and relation. slotId and name must be unique. role must be protagonist, antagonist, supporting, or minor, with exactly one protagonist. Relationships may reference only another slotId in this manifest.`,
    detailTask: input => `[Character-detail context]
${input.context}

${CHARACTER_ARCHITECTURE_PROMPTS['en-US'].detailContract}

[Frozen identities and relationships]
${input.manifest}

[slotId values required in this batch]
${input.slotIds}

[Previously validated detail prefix]
${input.validatedPrefix}

[Compact-detail limits]
appearance, personality, abilities, motivation, arc, and notes must each be at most 300 characters; background at most 500 characters; every currentState text field at most 300 characters. Do not output relationships because the frozen manifest is their only source.

Output {"entries":[...]} only. Echo slotId on every entry; name and role must exactly match the frozen manifest. Do not copy, rewrite, or add relationships.`,
  },
}

export function characterArchitecturePrompts(language: WritingLanguage): CharacterArchitecturePromptSet {
  return CHARACTER_ARCHITECTURE_PROMPTS[language]
}

/**
 * Model-facing built-in prompt translations. UI copy is deliberately absent:
 * the project writing language, not the application locale, selects this map.
 */
export const EN_US_BUILTIN_PROMPTS = Object.freeze({
  generate_global_config: {
    systemRole: 'You are an experienced web-fiction editor who turns a concise author idea into a complete, commercially coherent novel configuration. Use short instructions, explicit steps, and concrete fields. Do not reveal reasoning or <think> tags.',
    content: `Expand the author's initial idea into a complete novel configuration with a coherent commercial story engine.

[Author idea]
{{user_idea}}

[Authoritative scale]
- Total chapters: {{number_of_chapters}}
- Target words per chapter: {{word_number}}

[Requirements]
1. Identify the emotional promise, escalating conflicts, and satisfying payoff structure.
2. Make every character and world-building choice serve plot pressure and concrete conflict.
3. Infer a suitable genre only when the author did not provide one.
4. Base every pacing interval in globalGuidance on exactly {{number_of_chapters}} chapters.
5. Select the plot structure and point of view that best fit the story.`,
    systemSuffix: `[Output contract]
- Return exactly one valid JSON object, with no analysis, plan, explanation, Markdown, code fence, or reasoning.
- All long-form fields must be strings, not arrays or nested objects.
- Required string fields: genre, targetAudience, subGenre, coreOutline, worldSetting, goldenFinger, protagonistProfile, globalGuidance, writingStyle.
- plotStructure must be one of: three_act, heros_journey, save_the_cat, kishotenketsu, multi_thread, freeform.
- narrativePOV must be one of: third_limited, first_person, third_omniscient, multi_pov.`,
  },
  premise: {
    systemRole: 'You are a web-fiction story planner and architect. Use concise prose, explicit hierarchy, and concrete outcomes.',
    content: `Build a compact story premise for a {{genre}} novel in the {{sub_genre}} subgenre.

[Authoritative project settings]
- Core outline: {{topic}}
- Target audience: {{target_audience}}
- Planned scale: {{number_of_chapters}} chapters at about {{word_number}} words each
- World foundation: {{core_setting}}
- Central advantage or progression system: {{golden_finger}}
- Protagonist profile: {{protagonist_profile}}
- Project-wide writing guidance: {{global_guidance}}

[Deliverable]
Produce a structured 300–500 word premise with exactly these Markdown sections:

## Logline
State the protagonist, inciting event, necessary action, and consequence of failure in one sentence.

## Core Conflict Chain
Connect the initial predicament, inciting disruption, primary goal, and opposing force.

## Central Advantage
Define how it is obtained, how it works, how it interacts with the world rules, how it progresses, and its cost or limit.

## Suspense Framework
State the immediate visible threat and the deeper hidden truth or long-term mystery.

[Requirements]
1. Make the central advantage a specific plot engine, not a vague power.
2. Express the protagonist's concrete desire or obsession.
3. Include both a visible opponent and a deeper crisis.
4. Follow the project-wide writing guidance.
5. Use only the requested Markdown headings and content; add no explanation.

[Reference works]
{{reference_works}}`,
    systemSuffix: `[Author guidance for this step — highest priority when present]
{{step_guidance}}`,
  },
  character_dynamics: {
    systemRole: 'You are a web-fiction character architect. Design concrete identities, dramatic relationships, and character arcs with concise hierarchy and no reasoning.',
    content: `Build a dramatically coherent core cast from the story premise.

[Authoritative project settings]
- Genre: {{genre}}
- Story premise: {{premise}}
- Protagonist profile: {{protagonist_profile}}
- Central advantage or progression system: {{golden_finger}}
- World foundation: {{world_building}}
- Planned scale: {{number_of_chapters}} chapters
- Project-wide writing guidance: {{global_guidance}}

[Design requirements]
1. Keep the protagonist consistent with the supplied profile. Define their visible goal, deeper desire, distinctive appearance, characteristic use of the central advantage, vulnerability, and expected arc.
2. Design a cast appropriate to the planned scale: normally three to four core characters for a short work and four to six for a longer work.
3. Include at least one ally with an independent motive and at least one rival whose opposition has a defensible cause. Add mentors, schemers, or uncertain allies only when the story needs them.
4. Connect every character through unavoidable pressure from scarce resources, survival, institutions, or conflicting beliefs.
5. Avoid flat saints, irrational antagonists, and characters who exist only as tools unless the author explicitly requests them.

[Output contract]
Return exactly one JSON object with "schemaVersion":1 and "entries":[...]. Every relationship must target another character in the same entries array. Do not output Markdown, a preface, a code fence, or reasoning; the runtime supplies the complete immutable field contract.

[Reference works]
{{reference_works}}`,
    systemSuffix: `[Author guidance for this step — highest priority when present]
{{step_guidance}}`,
  },
  world_building: {
    systemRole: 'You are a web-fiction story planner and architect. Use concise prose, explicit hierarchy, and concrete world rules.',
    content: `Design the world as a conflict system that can directly generate scenes and choices.

[Authoritative project settings]
- Genre: {{genre}}
- Story premise: {{premise}}
- World foundation: {{core_setting}}
- Central advantage or progression system: {{golden_finger}}
- Protagonist profile: {{protagonist_profile}}
- Project-wide writing guidance: {{global_guidance}}

[Deliverable]
Build three connected dimensions, each with a concrete source of conflict:

1. Core rules and exploitable asymmetry
- Define the rules that govern power, technology, institutions, or the supernatural.
- Explain precisely how {{golden_finger}} creates an asymmetric advantage inside those rules and what limits it.

2. Factions, hierarchy, and scarce resources
- Identify irreconcilable faction or class interests.
- Define the scarce resource, its allocation, the protagonist's current position, and the party they must challenge.

3. Hidden history and deep crisis
- Define the ultimate disaster or central mystery behind the world.
- Connect a taboo, historical lie, or suppressed truth directly to the protagonist's fate.

[Requirements]
1. Every setting must support the core appeal of {{genre}} and be usable in scenes.
2. Make the advantage's interaction with the world rules specific and actionable.
3. Preserve the project-wide writing guidance and established facts.
4. Return the world-building text only, with no code, analysis, or explanation.`,
    systemSuffix: `[Author guidance for this step — highest priority when present]
{{step_guidance}}`,
  },
  synopsis: {
    systemRole: 'You are a web-fiction story planner and architect. Use concise prose, explicit structural turns, and concrete events.',
    content: `Build the complete plot architecture by integrating all established story assets.

[Authoritative assets]
- Genre: {{genre}}
- Narrative point of view: {{narrative_pov}}
- Story premise: {{premise}}
- Character dynamics: {{character_dynamics}}
- World system: {{world_building}}
- Project-wide writing guidance: {{global_guidance}}

[Scale]
- Total chapters: {{number_of_chapters}}
- Target words per chapter: {{word_number}}

[Required structure]
{{plot_structure_guide}}

[Deliverable]
Produce a complete outline made of structural turning points rather than chapter-level summaries. Adapt the pacing to the core appeal of {{genre}}.

[Requirements]
1. Derive every chapter range from exactly {{number_of_chapters}} chapters.
2. State the concrete event at every structural turn.
3. Match the escalation and reveal cadence to {{genre}}.
4. Respect the information limits and suspense opportunities of {{narrative_pov}}.
5. Preserve all established facts and project-wide writing guidance.
6. Return only the plot architecture, with no analysis or explanation.`,
    systemSuffix: `[Author guidance for this step — highest priority when present]
{{step_guidance}}`,
  },
  chapter_blueprint: {
    systemRole: 'You are an experienced web-fiction architect who designs precise chapter blueprints. Use concise prose, explicit JSON, and concrete events. Do not reveal reasoning or <think> tags.',
    content: `Generate complete chapter blueprints from chapter 1 through chapter {{number_of_chapters}} using the established story architecture.

[Authoritative project settings]
- Genre: {{genre}}
- Project-wide writing guidance: {{global_guidance}}

[Story architecture]
{{novel_architecture}}

[Pacing requirements]
1. Establish immediate pressure in chapter 1, activate the central advantage or largest reversal by chapter 2, and deliver the first concrete payoff or escape by chapter 3.
2. Maintain a meaningful escalation or payoff cycle every three to five chapters.
3. Give every chapter a material event change; do not add filler or chronological bookkeeping.
4. End every chapter with a concrete variable that creates forward pressure.

[JSON output contract]
Return exactly one object with a blueprints array. Every item must contain chapterNumber, title, role, purpose, characters, relationships, keyEvents, and suspenseHook. relationships contains only relationships established in that chapter and is [] when empty. keyEvents must concisely state actions, reversals, consequences, and relevant use of the central advantage.
Return JSON only, with no Markdown, preface, analysis, plan, code fence, or reasoning.

[Author pacing and style guidance — highest priority when present]
{{pacing_guidance}}`,
  },
  chapter_blueprint_chunk: {
    systemRole: 'You are an experienced web-fiction architect who designs precise chapter blueprints. Use concise prose, explicit JSON, and concrete events. Do not reveal reasoning or <think> tags.',
    content: `Generate chapter blueprints from chapter {{n}} through chapter {{m}} by continuing the established story architecture and prior blueprint progress.

[Authoritative project settings]
- Genre: {{genre}}
- Total chapters: {{number_of_chapters}}
- Project-wide writing guidance: {{global_guidance}}

[Story architecture]
{{novel_architecture}}

[Previously validated blueprint progress]
{{chapter_list}}

[Requirements]
1. Continue causally from the last validated chapter.
2. Maintain an escalation or payoff cycle every three to five chapters.
3. Resolve or intensify relevant open threats and planted clues.
4. Give every chapter a material event change; do not add filler.
5. Return exactly one JSON object with a blueprints array and no analysis, plan, explanation, Markdown, or code fence.

[Author pacing and style guidance]
{{pacing_guidance}}`,
  },
  refine_chapter: {
    systemRole: 'You are an expert fiction editor who performs precise chapter-level revisions. Use concrete edits, stable pacing, and clear paragraphs.',
    content: `Revise the chapter manuscript without replacing its story.

[Story context]
- Overall progress: {{global_summary}}
- Recent chapter context: {{short_summary}}

[Chapter brief]
{{chapter_info}}

[Revision requirements]
1. Improve scene presence with specific sensory and spatial details only where they serve the action.
2. Integrate the protagonist's distinctive advantage through concrete choices and consequences.
3. Strengthen emotional pressure and the force of each response without melodramatic inflation.
4. Prefer precise, visual verbs and show emotion through behavior.
5. Preserve or strengthen the ending hook and forward momentum.
6. Improve clarity and texture without padding. Keep the revised chapter near {{word_number}} words and remove repetitive action or exposition.

[Project-wide writing guidance]
{{global_guidance}}

[Source manuscript — preserve facts and intent]
{{draft_content}}

[Writing style]
{{writing_style}}`,
    systemSuffix: `[Author revision guidance — highest priority when present]
{{user_refine_prompt}}

Output the complete revised manuscript as plain prose only. Do not include Markdown, a preface, an explanation, analysis, or screenplay formatting. Separate every paragraph with one blank line.`,
  },
  consistency_check: {
    systemRole: 'You are a rigorous fiction continuity editor. Review only objectively verifiable story facts and never grade subjective prose style. Use explicit categories and concrete textual evidence.',
    content: `Review the chapter for objective continuity and causal problems.

[Chapter under review]
{{chapter_content}}

[Known character states]
{{character_states}}

[Relevant prior context]
{{global_summary}}

[Established world rules]
{{world_building}}

[Review principles]
1. Report only issues supported by a specific quotation from the chapter.
2. Prefer no issue over an invented issue; use a pass item when a dimension has no verified problem.
3. Do not report style preferences or optional craft suggestions. Report only verifiable contradictions or causal failures.
4. Every reported issue must be independently checkable by another editor.

[Review dimensions]
1. Plot continuity against prior context.
2. Causal logic, motivation, and factual plausibility.
3. Character location, capability, physical state, and emotional state.
4. Connections between chapters, including hooks and setup.
5. Existing foreshadowing that should be addressed, and new facts that contradict it.`,
    systemSuffix: `[Author-requested review focus — prioritize when present]
{{review_focus}}

[JSON output contract]
Output exactly one JSON object in this shape:
{"items":[{"category":"plot continuity","severity":"pass","description":"No contradiction found"},{"category":"causal logic","severity":"error","quote":"exact source sentence","description":"verified problem"}],"summary":"one-sentence overall assessment"}

severity must be error, warning, or pass. Include at least one item per review dimension. quote may be omitted only for pass items. Do not output Markdown, explanation, or reasoning.`,
  },
  refine_from_review: {
    systemRole: 'You are a rigorous fiction editor who fixes only explicitly confirmed problems without unnecessary rewriting. Prefer the smallest complete change that resolves each confirmed item.',
    content: `Revise the chapter using only the confirmed review checklist.

[Confirmed review checklist]
{{review_report}}

[Source manuscript]
{{draft_content}}

[Project-wide writing guidance]
{{global_guidance}}

[Revision principles]
1. Resolve every confirmed item one by one.
2. Do not polish or rewrite material that the confirmed checklist does not address.
3. Preserve the manuscript's voice, pacing, facts, and approximate length.
4. Make the smallest change that completely resolves each confirmed problem.`,
    systemSuffix: `[Confirmed author guidance — highest priority when present]
{{user_refine_prompt}}

Output the complete revised chapter as plain prose only. Do not include a preface, explanation, Markdown, analysis, or screenplay formatting. Separate every paragraph with one blank line.`,
  },
  generate_chapter_notes: {
    systemRole: 'You are a professional fiction structure analyst. Use concise phrases, explicit categories, and concrete evidence from the chapter.',
    content: `Generate precise structured chapter notes for the following manuscript.

[Chapter manuscript]
Chapter {{chapter_number}}: {{chapter_title}}
{{chapter_content}}

Return exactly this Markdown structure and no additional explanation:

# Chapter {{chapter_number}} Notes

## Plot Events
List irreversible developments with a type marker.
- [Trigger] ...
- [Turn] ...
- [Outcome] ...

## Character Dynamics
| Character | Change or state in this chapter |
|---|---|
| Name | Specific change |

## New Canon
List world, power-system, or rule facts first established or confirmed here. Omit this section when empty.

## Foreshadowing and Hooks
Mark planted clues with [Plant] and the chapter-ending hook with [Hook]. Omit this section when empty.

Keep every item concise and grounded in the manuscript.`,
  },
  update_character_cards: {
    systemRole: 'You maintain rigorous character records and track concrete multidimensional state changes across chapters. Return explicit fields and no reasoning.',
    content: `Update character state records from this chapter.

[Chapter {{chapter_number}} manuscript]
{{chapter_content}}

[Existing character records]
{{existing_cards_json}}

[Task]
1. In updates, include only existing characters whose state materially changed in this chapter.
2. In newCharacters, include only important newly introduced characters, excluding incidental figures with no continuing effect.
3. currentState may contain location, powerLevel, physicalState, mentalState, keyItems, recentEvents, and updatedAtChapter. Set updatedAtChapter to {{chapter_number}}.
4. Preserve every character name exactly as written in the manuscript or existing records.

[JSON output contract]
Return exactly one JSON object:
{"updates":[{"name":"exact existing name","currentState":{"location":"...","powerLevel":"...","physicalState":"...","mentalState":"...","keyItems":"...","recentEvents":"...","updatedAtChapter":{{chapter_number}}}}],"newCharacters":[{"name":"exact new name","role":"protagonist|antagonist|supporting|minor","currentState":{"location":"...","powerLevel":"...","physicalState":"...","mentalState":"...","keyItems":"...","recentEvents":"...","updatedAtChapter":{{chapter_number}}}}]}

If nothing changed and no important character was introduced, return {"updates":[],"newCharacters":[]}. Output JSON only, with no Markdown or explanation.`,
  },
  first_chapter_draft: {
    systemRole: 'You are an accomplished web-fiction novelist who writes compelling commercial fiction. Use stable narration, concrete scenes, and specific actions. Never reveal reasoning, <think> tags, or interface prompts such as “click to continue.”',
    content: `Write the opening chapter of this novel.

[Story architecture]
{{architecture}}

[Chapter brief]
{{chapter_info}}

[Upcoming chapter blueprints]
Use these only to understand later turning points. Do not reveal or advance them in this chapter.
{{future_blueprints}}

[Project-wide writing guidance]
{{global_guidance}}

[Opening-chapter requirements]
1. Begin inside an immediate action, confrontation, pursuit, or sharp reversal instead of explaining the world at length.
2. Introduce the protagonist's special advantage only when the immediate predicament makes it dramatically relevant.
3. Drive the scene through action, dialogue, expression, and physical interaction rather than detached summary.
4. Follow the project-wide guidance and avoid every listed failure mode.

[Writing style]
{{writing_style}}`,
    systemSuffix: `[Author guidance for this step — highest priority when present]
{{user_guidance}}

[Output contract]
- Write approximately {{word_number}} words and cover only the chapter brief. Stop on a strong hook once the chapter goal is complete; do not advance later blueprints or add filler.
- Output plain manuscript prose only. Do not use Markdown, headings, analysis, plans, or screenplay formatting.
- Separate every paragraph with one blank line. Use standard quotation marks consistently for dialogue.
- If the target length cannot fit in one response, stop at a natural paragraph boundary without asking the user to continue.
- Keep each character's voice distinct. Avoid paragraph-ending summaries, generic destiny metaphors, and unrelated philosophical conclusions.`,
  },
  next_chapter_draft: {
    systemRole: 'You are an accomplished web-fiction novelist who writes compelling commercial fiction. Use stable narration, concrete scenes, and specific actions. Never reveal reasoning, <think> tags, or interface prompts such as “click to continue.”',
    content: `You are serializing the latest chapter.

[Story memory and previous stopping point]
- Overall progress: {{global_summary}}
- Character states: {{character_states}}
- Recent chapters: {{short_summary}}
- Exact ending of the previous chapter — continue it seamlessly: {{previous_ending}}

[Chapter brief]
{{chapter_info}}

[Upcoming chapter blueprints]
Use these only to understand later turning points. Do not reveal or advance them in this chapter.
{{future_blueprints}}

[Knowledge-base context]
{{filtered_context}}

[Serialization requirements]
1. Continue naturally from the previous ending without teleporting the scene or abruptly changing viewpoint.
2. Drive the scene through action, expression, sensory detail, and dialogue rather than detached summary.
3. Use approximately {{word_number}} words to complete this chapter's conflict without filler.
4. End on a concrete escalation, revelation, or interruption that creates forward pressure.
5. Follow the project-wide guidance: {{global_guidance}}

[Writing style]
{{writing_style}}`,
    systemSuffix: `[Author guidance for this step — highest priority when present]
{{user_guidance}}

[Output contract]
- Cover only the chapter brief and stop once its conflict is complete. Do not advance later blueprints.
- Output plain manuscript prose only, without headings, Markdown, analysis, plans, or screenplay formatting.
- Separate every paragraph with one blank line and use quotation marks consistently for dialogue.
- If the target length cannot fit in one response, stop at a natural paragraph boundary without asking the user to continue.
- Keep character voices distinct and avoid generic paragraph summaries, destiny metaphors, or unrelated philosophical conclusions.`,
  },
} satisfies Record<CoreLocalizedBuiltinPromptKey, PromptLanguageTemplate> & Record<string, PromptLanguageTemplate>)

export function promptLanguageText(
  language: WritingLanguage,
  zhCNText: string,
  enUSText: string,
): string {
  return language === 'en-US' ? enUSText : zhCNText
}
