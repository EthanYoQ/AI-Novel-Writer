import type { WritingLanguage } from './writing-language'
import { inspectWritingSkillMarkdown, type WritingSkillInspection } from './writing-skills'

export interface BuiltinSkillMetadata {
  /** Skill 唯一名称 */
  name: string
  /** 显示名称 */
  displayName?: string
  /** 功能描述 */
  description: string
  /** 使用场景（用于 Agent 自动匹配） */
  whenToUse?: string
  /** 版本 */
  version?: string
  /** 允许的工具列表（白名单） */
  allowedTools?: string[]
  /** 参数提示 */
  argumentHint?: string
  /** 是否可由模型自动调用 */
  userInvocable?: boolean
}

/** Fresh data keeps registry mutations out of the main-process source authority. */
export function getBuiltinWritingSkills() {
  const builtins: Array<{
    metadata: BuiltinSkillMetadata
    content: string
    writingSkill?: WritingSkillInspection
    localizedContent?: Partial<Record<WritingLanguage, string>>
  }> = [
    {
      metadata: {
        name: 'long-form-continuity',
        displayName: '长篇连续性与场景推进',
        description: '在规划和正文阶段守住作者事实、因果链、角色状态与伏笔进度。',
        version: '1.0.0',
      },
      content: 'Treat established author facts as authoritative. Track causality, character state, and unresolved narrative threads. Build each scene around a character choice, its cost, and a concrete change in the story state.',
      localizedContent: {
        'zh-CN': '以作者已经确认的事实为最高依据。持续核对因果链、角色状态和未回收的叙事线索。每个场景围绕角色的主动选择、选择的代价，以及故事状态发生的具体变化展开。',
        'en-US': 'Treat established author facts as authoritative. Track causality, character state, and unresolved narrative threads. Build each scene around a character choice, its cost, and a concrete change in the story state.',
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: long-form-continuity\ndisplay_name: Long-form Continuity and Scene Progression\ndescription: Long-form continuity and scene progression\nversion: 1.0.0\nlanguage: bilingual\nstage: planning\n---\nTreat established author facts as authoritative. Track causality, character state, and unresolved narrative threads.`),
    },
    {
      metadata: {
        name: 'natural-prose-refinement',
        displayName: '自然语言润色',
        description: '在修稿阶段减少模板化表达，让动作、感官和句式服务于人物与场景。',
        version: '1.0.0',
      },
      content: 'Revise the prose without changing author facts or plot outcomes. Replace generic summaries with selective concrete action, vary sentence rhythm, preserve the viewpoint voice, and remove meta commentary and repetitive transitions.',
      localizedContent: {
        'zh-CN': '在不改变作者事实和情节结果的前提下润色正文。用有选择的具体动作替代空泛概述，调整句式节奏，保持视角人物的语言质感，并删除元话术和重复的过渡表达。',
        'en-US': 'Revise the prose without changing author facts or plot outcomes. Replace generic summaries with selective concrete action, vary sentence rhythm, preserve the viewpoint voice, and remove meta commentary and repetitive transitions.',
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: natural-prose-refinement\ndisplay_name: Natural Prose Refinement\ndescription: Natural prose refinement\nversion: 1.0.0\nlanguage: bilingual\nstage: refinement\n---\nRevise the prose without changing author facts or plot outcomes.`),
    },
    {
      metadata: {
        name: 'review-chapter',
        displayName: '章节审阅',
        description: '对指定章节进行全面的质量审阅，包括剧情逻辑、角色一致性、节奏感、伏笔呼应等多个维度。',
        whenToUse: '用户要求审阅、检查、评估某个章节时',
      },
      content: `# 章节审阅

请对目标章节进行专业的小说审阅。依次检查以下维度：

## 1. 剧情逻辑
- 情节是否连贯，有无逻辑矛盾
- 因果关系是否成立

## 2. 角色一致性
- 角色行为是否符合既定性格
- 对话风格是否一致

## 3. 节奏感
- 张弛是否有度
- 是否有不必要的拖沓或过于仓促的转折

## 4. 伏笔与呼应
- 已有伏笔是否得到了回应
- 新埋的伏笔是否自然

## 5. 文笔与风格
- 描写是否生动
- 是否符合整体文风设定

请先使用 read_drafts 工具读取目标章节，再使用 read_architecture 读取故事架构进行对比评估。
输出格式：每个维度评分（1-5星）+ 详细说明 + 修改建议。`,
      localizedContent: {
        'en-US': `# Chapter Review

Review the target chapter as a fiction editor. Check each dimension in order:

## 1. Plot logic
- Is the plot coherent and free of logical contradictions?
- Are cause and effect convincing?

## 2. Character consistency
- Do actions match established characterization?
- Does each character keep a consistent voice?

## 3. Pacing
- Is tension balanced with release?
- Are any passages needlessly slow or any turns too abrupt?

## 4. Foreshadowing and payoff
- Are established clues paid off where appropriate?
- Do new clues arise naturally?

## 5. Prose and style
- Is the description vivid and purposeful?
- Does it match the project's established style?

Use read_drafts to load the target chapter and read_architecture to compare it with the story plan.
For each dimension, provide a 1-5 rating, a concise explanation, and actionable revision suggestions.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: review-chapter\ndisplay_name: Chapter Review\ndescription: Reviews a chapter for plot logic, character consistency, pacing, foreshadowing, and prose quality.\nlanguage: bilingual\nstage: review\n---\nUse the read_drafts and read_architecture tools before reviewing the chapter.`),
    },
    {
      metadata: {
        name: 'brainstorm',
        displayName: '脑暴创意',
        description: '针对指定话题进行创意脑暴，生成多个创意方向和灵感。',
        whenToUse: '用户要求头脑风暴、找灵感、想创意时',
      },
      content: `# 创意脑暴

请围绕用户给出的话题进行专业的创意脑暴。

## 输出格式
为每个创意方向提供：
1. **创意概念**（一句话）
2. **详细展开**（100-200 字）
3. **可行性评估**（高/中/低）
4. **与已有剧情的融合度**

请先使用 read_architecture 和 read_project_state 了解项目背景，确保创意与现有设定不矛盾。
至少提供 5 个不同方向的创意。`,
      localizedContent: {
        'en-US': `# Creative Brainstorming

Brainstorm professionally around the user's topic.

## Output format
For every direction, provide:
1. **Concept** in one sentence
2. **Development** in 100-200 words
3. **Feasibility** as high, medium, or low
4. **Fit with the existing plot**

Use read_architecture and read_project_state first so the ideas do not contradict established project facts.
Provide at least five distinct directions.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: brainstorm\ndisplay_name: Creative Brainstorming\ndescription: Generates multiple creative directions and ideas for a chosen topic.\nlanguage: bilingual\nstage: planning\n---\nUse the read_architecture and read_project_state tools before brainstorming.`),
    },
    {
      metadata: {
        name: 'character-analysis',
        displayName: '角色分析',
        description: '深入分析指定角色的性格、动机、角色弧、人物关系等。',
        whenToUse: '用户想深入了解或调整角色设定时',
      },
      content: `# 角色深度分析

请对目标角色进行全方位的深度分析。

## 分析维度
1. **核心性格特质** — MBTI、大五人格倾向
2. **深层动机** — 驱动角色行动的核心诉求
3. **角色弧预测** — 基于当前设定推演角色成长轨迹
4. **关系网络** — 与其他角色的关系图谱
5. **冲突点** — 角色面临的核心矛盾和困境
6. **独特标识** — 口头禅、习惯动作、标志性特征

请先使用 read_characters 读取角色卡，以及 read_architecture 了解故事结构。`,
      localizedContent: {
        'en-US': `# Character Analysis

Analyze the target character in depth.

## Dimensions
1. **Core traits** — including useful personality-framework tendencies
2. **Deep motivation** — the need that drives action
3. **Character arc** — likely development based on established facts
4. **Relationship network** — ties to other characters
5. **Sources of conflict** — central pressures and dilemmas
6. **Distinctive markers** — speech patterns, habits, and recognizable traits

Use read_characters for the character cards and read_architecture for the story structure before analyzing.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: character-analysis\ndisplay_name: Character Analysis\ndescription: Analyzes a character's personality, motivation, arc, and relationships in depth.\nlanguage: bilingual\nstage: planning\n---\nUse the read_characters and read_architecture tools before analyzing the character.`),
    },
    {
      metadata: {
        name: 'continuity-check',
        displayName: '连续性检查',
        description: '检查小说中的设定一致性和连续性问题，发现矛盾和遗漏。',
        whenToUse: '用户想检查设定有没有矛盾、是否有不一致的地方时',
      },
      content: `# 连续性与一致性检查

请对项目进行全面的连续性检查。

## 检查项
1. **时间线一致性** — 事件发生顺序是否合理
2. **地理一致性** — 地点描述是否前后一致
3. **角色状态** — 角色的伤病、装备、能力等是否正确追踪
4. **设定遵守** — 是否与世界观设定产生矛盾
5. **伏笔追踪** — 哪些伏笔已回收，哪些待回收

请使用 list_chapters 了解进度，使用 read_architecture 获取设定，逐章检查关键节点。
输出为表格形式，标注问题严重程度（🔴严重 / 🟡注意 / 🟢正常）。`,
      localizedContent: {
        'en-US': `# Continuity Check

Run a comprehensive continuity check on the project.

## Checks
1. **Timeline** — whether events occur in a plausible order
2. **Geography** — whether locations remain consistent
3. **Character state** — injuries, equipment, abilities, and other tracked state
4. **Setting rules** — conflicts with established worldbuilding
5. **Foreshadowing** — clues already resolved and clues still open

Use list_chapters to understand progress and read_architecture for established facts, then inspect the key points chapter by chapter.
Return a table and label each finding as critical, warning, or clear.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: continuity-check\ndisplay_name: Continuity Check\ndescription: Checks the novel for continuity and setting inconsistencies, contradictions, and omissions.\nlanguage: bilingual\nstage: review\n---\nUse the list_chapters and read_architecture tools for a chapter-by-chapter continuity check.`),
    },
    {
      metadata: {
        name: 'writing-coach',
        displayName: '写作教练',
        description: '提供专业的写作技巧指导和文笔改善建议。',
        whenToUse: '用户想提高写作水平、求教写作技巧时',
      },
      content: `# 写作教练

作为专业的写作教练，为用户提供针对性的指导。

## 指导范围
- 叙述技巧（视角运用、时间线处理）
- 描写技法（环境渲染、人物刻画）
- 对话写作（个性化对话、潜台词运用）
- 节奏控制（场景切换、留白技巧）
- 悬念设置（钩子、反转、暗线）

请先使用 read_project_state 了解项目的写作风格设定，
再根据用户的具体问题提供定制化建议，并附上示例对比。`,
      localizedContent: {
        'en-US': `# Writing Coach

Act as a professional writing coach and give guidance tailored to the user's question.

## Areas
- Narrative technique, including viewpoint and timeline
- Description, including atmosphere and characterization
- Dialogue, including individual voice and subtext
- Pacing, including scene transitions and deliberate omission
- Suspense, including hooks, reversals, and hidden threads

Use read_project_state first to understand the project's established style. Then give focused advice with a short before-and-after example.`,
      },
      writingSkill: inspectWritingSkillMarkdown(`---\nname: writing-coach\ndisplay_name: Writing Coach\ndescription: Provides professional writing guidance and suggestions for improving prose.\nlanguage: bilingual\nstage: refinement\n---\nUse the read_project_state tool before giving tailored writing advice.`),
    },
  ]
  return builtins
}

/** The selected language body is exactly the body used by renderer skill bindings. */
export function readBuiltinWritingSkill(name: string, language: WritingLanguage): string | undefined {
  const skill = getBuiltinWritingSkills().find(entry => entry.metadata.name === name)
  if (!skill) return undefined
  const metadata = skill.writingSkill!.metadata
  const fields = { name: metadata.name, display_name: metadata.displayName, description: metadata.description, version: metadata.version, language: metadata.language, stage: metadata.stage }
  const frontmatter = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')
  return `---\n${frontmatter}\n---\n${skill.localizedContent?.[language] ?? skill.content}`
}
