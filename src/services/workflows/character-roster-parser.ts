import { CHARACTER_ARRAY_KEYS, CHARACTER_FIELD_ALIASES } from './character-card-fields'

export type RawCharacterCard = Record<string, unknown>

export type RosterParseIssue = {
  kind: 'no_roster' | 'unmatched_candidate' | 'ambiguous_candidate' | 'duplicate_name'
  source: string
}

export type ArchitectureRosterParseResult = {
  cards: RawCharacterCard[]
  issues: RosterParseIssue[]
  complete: boolean
}

const NON_CHARACTER_OBJECT_KEYS = new Set([
  ...CHARACTER_ARRAY_KEYS,
  'relationships',
  'relations',
  '关系',
  '关系网',
  'meta',
  'metadata',
  '说明',
])

const FIELD_KEYS: Record<string, string> = {
  性别: 'gender',
  年龄: 'age',
  年龄段: 'age',
  外貌: 'appearance',
  外貌特征: 'appearance',
  外貌描写: 'appearance',
  性格: 'personality',
  性格特点: 'personality',
  性格特征: 'personality',
  背景: 'background',
  背景故事: 'background',
  身世: 'background',
  能力: 'abilities',
  '能力/技能': 'abilities',
  技能: 'abilities',
  动机: 'motivation',
  核心动机: 'motivation',
  动力: 'motivation',
  关系: 'relationships',
  关系网: 'relationships',
  角色关系: 'relationships',
  角色弧光: 'arc',
  成长轨迹: 'arc',
  成长线: 'arc',
  备注: 'notes',
  补充: 'notes',
}

const GENERIC_OR_NARRATIVE_TITLES = [
  '主角', '女主', '男主', '反派', '对手', '敌人', '配角', '核心角色', '第一核心',
  '第二核心', '第三核心', '主要反派', '重要配角', '关键同盟者', '同盟者', '盟友',
  '角色图谱总览', '角色图谱', '人物关系图', '序章', '楔子', '尾声',
  '宿命冲突', '核心冲突', '人物关系', '角色关系', '故事冲突', '剧情冲突',
]

function isRawCard(value: unknown): value is RawCharacterCard {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return ''
}

function readName(card: RawCharacterCard): string {
  for (const key of CHARACTER_FIELD_ALIASES.name) {
    const name = textValue(card[key])
    if (name) return name
  }
  return ''
}

function characterKey(name: string): string {
  return name.trim().toLocaleLowerCase('en-US')
}

function cleanModelText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '\n')
    .replace(/^[\s\S]*?<\/think>/i, '\n')
    .replace(/<\/?think>/gi, '\n')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function matchingClose(open: string): string {
  return open === '{' ? '}' : ']'
}

function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = []

  for (let start = 0; start < text.length; start++) {
    const first = text[start]
    if (first !== '{' && first !== '[') continue

    const stack: string[] = []
    let inString = false
    let escaped = false

    for (let i = start; i < text.length; i++) {
      const char = text[i]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }

      if (char === '"') {
        inString = true
        continue
      }

      if (char === '{' || char === '[') {
        stack.push(matchingClose(char))
        continue
      }

      if ((char === '}' || char === ']') && stack.length > 0) {
        const expected = stack.pop()
        if (char !== expected) break
        if (stack.length === 0) {
          candidates.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }

  return candidates
}

function parseLooseJson(text: string): unknown | null {
  const cleaned = cleanModelText(text)
  if (!cleaned) return null

  const direct = parseJson(cleaned)
  if (direct !== null) return direct

  for (const candidate of extractBalancedJsonCandidates(cleaned)) {
    const parsed = parseJson(candidate)
    if (parsed !== null) return parsed
  }

  return null
}

function objectEntriesToCards(value: RawCharacterCard): RawCharacterCard[] {
  const cards: RawCharacterCard[] = []

  for (const [name, entry] of Object.entries(value)) {
    if (NON_CHARACTER_OBJECT_KEYS.has(name) || !isRawCard(entry)) continue
    cards.push({ name, ...entry })
  }

  return cards
}

function rawCardsFromParsedJson(parsed: unknown): RawCharacterCard[] {
  if (Array.isArray(parsed)) return parsed.filter(isRawCard)
  if (!isRawCard(parsed)) return []

  for (const key of CHARACTER_ARRAY_KEYS) {
    const value = parsed[key]
    if (Array.isArray(value)) return value.filter(isRawCard)
  }

  if (readName(parsed)) return [parsed]
  return objectEntriesToCards(parsed)
}

export function parseModelCharacterCards(text: string): RawCharacterCard[] {
  const parsed = parseLooseJson(text)
  return parsed === null ? [] : rawCardsFromParsedJson(parsed)
}

function roleFromText(text: string): string | undefined {
  if (/(?:女主角?|男主角?|核心主角|主角)/u.test(text)) return 'protagonist'
  if (/(?:大反派|主要反派|反派|内在敌人|敌人|对手)/u.test(text)) return 'antagonist'
  if (/(?:龙套|次要角色)/u.test(text)) return 'minor'
  if (/(?:重要配角|核心配角|配角|同盟者|盟友)/u.test(text)) return 'supporting'
  return undefined
}

function stripHeadingPrefix(title: string): string {
  return title
    .trim()
    .replace(/^(?:[一二三四五六七八九十百千万]+|\d+)[、.．]\s*/u, '')
    .replace(/^【\s*/u, '')
    .replace(/\s*】$/u, '')
    .trim()
}

function isNarrativeTitle(title: string): boolean {
  const normalized = stripHeadingPrefix(title)
  if (!normalized || GENERIC_OR_NARRATIVE_TITLES.includes(normalized)) return true
  if (/^第[一二三四五六七八九十百千万\d]+(?:章|节|卷|部|篇|回)/u.test(normalized)) return true
  return /(?:冲突|主题|世界观|剧情|情节|关系|弧光|成长|线索|危机|转折|阵营|事件|设定)/u.test(normalized)
}

function isCharacterScopeTitle(title: string): boolean {
  return /(?:角色|人物)(?:图谱|卡|设定|名单|列表|总览|关系)/u.test(stripHeadingPrefix(title))
}

function parseSingleName(value: string): { name?: string; issue?: RosterParseIssue['kind'] } {
  const name = stripHeadingPrefix(value)
    .split(/[（(【[]/u, 1)[0]
    .trim()
  if (!name || isNarrativeTitle(name) || /^第[一二三四五六七八九十百千万\d]+(?:章|节|卷|部|篇|回)/u.test(name)) {
    return { issue: 'unmatched_candidate' }
  }
  if (/[/|｜、，,]/u.test(name) || /\s(?:和|与|及)\s/u.test(name)) {
    return { issue: 'ambiguous_candidate' }
  }
  return { name }
}

type HeadingParse =
  | { kind: 'role_section'; role: string }
  | { kind: 'card'; name: string; role?: string }
  | { kind: 'issue'; issue: RosterParseIssue['kind'] }
  | { kind: 'none' }

function parseHeading(title: string): HeadingParse {
  const normalized = stripHeadingPrefix(title)
  const terminalRole = normalized.match(/[：:]\s*(.+?)\s*$/u)
  if (terminalRole && roleFromText(terminalRole[1])) {
    const beforeTerminalRole = normalized.slice(0, terminalRole.index ?? 0).replace(/[：:]\s*$/u, '').trim()
    if (!beforeTerminalRole || isNarrativeTitle(beforeTerminalRole)) {
      return { kind: 'role_section', role: roleFromText(terminalRole[1])! }
    }
  }

  const numbered = normalized.match(/^角色(?:[一二三四五六七八九十百千万\d]+)?\s*[：:]\s*(.*)$/u)
  if (numbered) {
    const parsedName = parseSingleName(numbered[1])
    return parsedName.name
      ? { kind: 'card', name: parsedName.name, role: roleFromText(normalized) }
      : { kind: 'issue', issue: parsedName.issue ?? 'unmatched_candidate' }
  }

  const roleLeading = normalized.match(/^(?:主角|女主角?|男主角?|反派|对手|敌人|配角|同盟者|盟友)\s*[：:]\s*(.*)$/u)
  if (roleLeading) {
    const parsedName = parseSingleName(roleLeading[1])
    return parsedName.name
      ? { kind: 'card', name: parsedName.name, role: roleFromText(normalized) }
      : { kind: 'issue', issue: parsedName.issue ?? 'unmatched_candidate' }
  }

  const parenthetical = normalized.match(/^(.+?)\s*[（(]([^）)]+)[）)]\s*$/u)
  if (parenthetical && roleFromText(parenthetical[2])) {
    const parsedName = parseSingleName(parenthetical[1])
    return parsedName.name
      ? { kind: 'card', name: parsedName.name, role: roleFromText(parenthetical[2]) }
      : { kind: 'issue', issue: parsedName.issue ?? 'unmatched_candidate' }
  }

  const trailingRole = normalized.match(/^(.+?)\s*[：:]\s*(.+)$/u)
  if (trailingRole && roleFromText(trailingRole[2])) {
    const parsedName = parseSingleName(trailingRole[1])
    return parsedName.name
      ? { kind: 'card', name: parsedName.name, role: roleFromText(trailingRole[2]) }
      : { kind: 'issue', issue: parsedName.issue ?? 'unmatched_candidate' }
  }

  if (roleFromText(normalized) && /[：:]\s*$/u.test(normalized)) {
    return { kind: 'issue', issue: 'unmatched_candidate' }
  }
  if (/^(?:主角|女主角?|男主角?|反派|对手|敌人|配角|同盟者|盟友)$/u.test(normalized)) {
    return { kind: 'role_section', role: roleFromText(normalized)! }
  }
  return { kind: 'none' }
}

type FieldBlock = {
  fields: RawCharacterCard
  name?: string
  hasCharacterField: boolean
  issue?: RosterParseIssue['kind']
}

function collectFieldBlock(lines: readonly string[], start: number, end: number): FieldBlock {
  const fields: RawCharacterCard = {}
  let name: string | undefined
  let hasCharacterField = false

  for (let index = start; index < end; index++) {
    const line = lines[index].trim()
    const field = line.match(/^(?:[-*+]\s*)?([^：:]+?)\s*[：:]\s*(.+)$/u)
    if (!field) continue
    const label = field[1].trim()
    const value = field[2].trim()
    if (!value) continue

    if ((CHARACTER_FIELD_ALIASES.name as readonly string[]).includes(label)) {
      const parsedName = parseSingleName(value)
      if (!parsedName.name) return { fields, hasCharacterField, issue: parsedName.issue ?? 'unmatched_candidate' }
      if (name && characterKey(name) !== characterKey(parsedName.name)) {
        return { fields, hasCharacterField, issue: 'ambiguous_candidate' }
      }
      name = parsedName.name
      continue
    }

    const key = FIELD_KEYS[label]
    if (!key) continue
    fields[key] = value
    hasCharacterField = true
  }

  return { fields, name, hasCharacterField }
}

type Heading = { level: number; title: string; line: number }

function headingsFromLines(lines: readonly string[]): Heading[] {
  return lines.flatMap((line, index) => {
    const heading = line.trim().match(/^(#{1,6})\s+(.+)$/u)
    return heading ? [{ level: heading[1].length, title: heading[2].trim(), line: index }] : []
  })
}

function validateStructuredCards(cards: RawCharacterCard[]): RosterParseIssue[] {
  const issues: RosterParseIssue[] = []
  const names = new Set<string>()
  for (const card of cards) {
    const name = readName(card)
    if (!name) {
      issues.push({ kind: 'unmatched_candidate', source: '结构化角色条目' })
      continue
    }
    const key = characterKey(name)
    if (names.has(key)) {
      issues.push({ kind: 'duplicate_name', source: name })
      continue
    }
    names.add(key)
  }
  return issues
}

function parseMarkdownRoster(text: string): ArchitectureRosterParseResult {
  const lines = text.split(/\r?\n/u)
  const headings = headingsFromLines(lines)
  const cards: RawCharacterCard[] = []
  const issues: RosterParseIssue[] = []
  const cardNames = new Set<string>()
  const roleSections: Array<{ level: number; role: string }> = []
  const scopes: number[] = []

  const addIssue = (kind: RosterParseIssue['kind'], source: string) => {
    issues.push({ kind, source })
  }
  const addCard = (name: string, role: string | undefined, fields: RawCharacterCard, source: string) => {
    const key = characterKey(name)
    if (cardNames.has(key)) {
      addIssue('duplicate_name', source)
      return
    }
    cardNames.add(key)
    cards.push({ name, ...(role ? { role } : {}), ...fields })
  }

  for (let headingIndex = 0; headingIndex < headings.length; headingIndex++) {
    const heading = headings[headingIndex]
    while (roleSections.length > 0 && roleSections.at(-1)!.level >= heading.level) roleSections.pop()
    while (scopes.length > 0 && scopes.at(-1)! >= heading.level) scopes.pop()

    const nextHeading = headings[headingIndex + 1]
    const blockEnd = nextHeading?.line ?? lines.length
    const immediateBlock = collectFieldBlock(lines, heading.line + 1, blockEnd)
    const parsedHeading = parseHeading(heading.title)
    let directRoleSection: { level: number; role: string } | undefined
    for (let index = roleSections.length - 1; index >= 0; index--) {
      const section = roleSections[index]
      if (heading.level === section.level + 1) {
        directRoleSection = section
        break
      }
    }
    const inCharacterScope = scopes.length > 0 || roleSections.length > 0

    if (parsedHeading.kind === 'issue') {
      addIssue(parsedHeading.issue, heading.title)
      continue
    }

    if (parsedHeading.kind === 'role_section') {
      if (immediateBlock.issue) addIssue(immediateBlock.issue, heading.title)
      if (immediateBlock.name) {
        addCard(immediateBlock.name, parsedHeading.role, immediateBlock.fields, heading.title)
      }
      roleSections.push({ level: heading.level, role: parsedHeading.role })
      scopes.push(heading.level)
      continue
    }

    if (parsedHeading.kind === 'card') {
      if (immediateBlock.issue) {
        addIssue(immediateBlock.issue, heading.title)
        continue
      }
      if (immediateBlock.name && characterKey(immediateBlock.name) !== characterKey(parsedHeading.name)) {
        addIssue('ambiguous_candidate', heading.title)
        continue
      }
      addCard(parsedHeading.name, parsedHeading.role, immediateBlock.fields, heading.title)
      continue
    }

    if (directRoleSection && !isNarrativeTitle(heading.title)) {
      const parsedName = parseSingleName(heading.title)
      if (!parsedName.name) {
        addIssue(parsedName.issue ?? 'unmatched_candidate', heading.title)
        continue
      }
      if (immediateBlock.issue) {
        addIssue(immediateBlock.issue, heading.title)
        continue
      }
      if (immediateBlock.name && characterKey(immediateBlock.name) !== characterKey(parsedName.name)) {
        addIssue('ambiguous_candidate', heading.title)
        continue
      }
      if (!immediateBlock.hasCharacterField && !immediateBlock.name) {
        addIssue('unmatched_candidate', heading.title)
        continue
      }
      addCard(parsedName.name, directRoleSection.role, immediateBlock.fields, heading.title)
      continue
    }

    if (isCharacterScopeTitle(heading.title)) scopes.push(heading.level)
    if (inCharacterScope && immediateBlock.name) {
      if (immediateBlock.issue) {
        addIssue(immediateBlock.issue, heading.title)
      } else {
        addCard(immediateBlock.name, undefined, immediateBlock.fields, heading.title)
      }
    }
  }

  if (cards.length === 0 && issues.length === 0) {
    addIssue('no_roster', '未找到受支持的角色区、角色标题或姓名字段')
  }
  return { cards, issues, complete: cards.length > 0 && issues.length === 0 }
}

export function parseArchitectureCharacterRoster(text: string): ArchitectureRosterParseResult {
  const parsed = parseLooseJson(text)
  if (parsed !== null) {
    const cards = rawCardsFromParsedJson(parsed)
    const issues = validateStructuredCards(cards)
    if (cards.length === 0 && issues.length === 0) {
      issues.push({ kind: 'no_roster', source: '结构化角色列表为空或不受支持' })
    }
    return { cards, issues, complete: cards.length > 0 && issues.length === 0 }
  }
  return parseMarkdownRoster(text)
}
