export interface AgentProtocolToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface AgentResponseProtocol {
  textParts: string[]
  toolCalls: AgentProtocolToolCall[]
  visibleText: string
}

function objectArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRawCall(text: string, registered: ReadonlySet<string>): AgentProtocolToolCall | null {
  const match = /^\s*([A-Za-z][\w.-]*)[ \t]*\r?\n\s*(\{[\s\S]*\})\s*$/.exec(text)
  if (!match || !registered.has(match[1])) return null
  try {
    const args: unknown = JSON.parse(match[2])
    return objectArguments(args) ? { name: match[1], arguments: args } : null
  } catch { return null }
}

function parseEnvelope(text: string, registered: ReadonlySet<string>): AgentProtocolToolCall | null {
  const envelope = text.trim()
  if (!envelope.startsWith('{') || !envelope.endsWith('}')) return null
  try {
    const value: unknown = JSON.parse(envelope)
    if (!objectArguments(value)) return null
    const keys = Object.keys(value)
    if (keys.length !== 2 || !keys.includes('name') || !keys.includes('arguments')) return null
    return typeof value.name === 'string' && registered.has(value.name) && objectArguments(value.arguments)
      ? { name: value.name, arguments: value.arguments } : null
  } catch { return null }
}

function parseTaggedCall(text: string, registered: ReadonlySet<string>): AgentProtocolToolCall | null {
  const emptyTool = /^<([A-Za-z][\w.-]*)>\s*<\/\1>$/.exec(text)
  if (emptyTool && registered.has(emptyTool[1])) return { name: emptyTool[1], arguments: {} }
  const match = /^<name>\s*([A-Za-z][\w.-]*)\s*<\/name>\s*<arguments>\s*(\{[\s\S]*\})\s*<\/arguments>$/.exec(text)
  if (!match) return null
  try {
    const args: unknown = JSON.parse(match[2])
    return objectArguments(args) ? { name: match[1], arguments: args } : null
  } catch { return null }
}

function parseBlock(text: string, registered: ReadonlySet<string>): AgentProtocolToolCall | null {
  const parseJson = (content: string): AgentProtocolToolCall | null => {
    try {
      const value: unknown = JSON.parse(content)
      if (!objectArguments(value) || typeof value.name !== 'string' || !value.name) return null
      const args = value.arguments ?? {}
      return objectArguments(args) ? { name: value.name, arguments: args } : null
    } catch { return null }
  }
  // Tagged calls historically retain unknown names so the host can return the
  // existing unknown-tool observation. Parsing never grants tool authority.
  const direct = parseJson(text)
  if (direct) return direct
  // An inner wrapper cannot prove that an outer control block was complete.
  if (/<\/?(?:tool_call|｜DSML｜tool_call)(?=[\s>])/i.test(text)) return null
  const embeddedJson = text.match(/\{[\s\S]*\}/)?.[0]
  return parseTaggedCall(text, registered)
    ?? (embeddedJson ? parseJson(embeddedJson) : null)
}

const HIDDEN_TAGS = new Set(['think', 'thinking', 'analysis', 'reasoning'])
const PROTOCOL_TAGS = ['think', 'thinking', 'analysis', 'reasoning', 'tool_call', '｜DSML｜tool_call', 'tool_result']
const MARKER = /<(\/?)(think|thinking|analysis|reasoning|tool_call|｜DSML｜tool_call|tool_result)(?=[\s>])[^<>]*>/gi

function removePartialMarkerTail(text: string): string {
  const start = text.lastIndexOf('<')
  if (start < 0) return text
  const suffix = text.slice(start + 1).replace(/^\//, '').toLowerCase()
  if (!suffix || suffix.includes('>')) return text
  return PROTOCOL_TAGS.some(tag => tag.toLowerCase().startsWith(suffix)
    || suffix.startsWith(tag.toLowerCase()) && /^[\s/]/.test(suffix.slice(tag.length))) ? text.slice(0, start) : text
}

function scanProtocol(text: string, registered: ReadonlySet<string>) {
  const textParts: string[] = []
  const toolCalls: AgentProtocolToolCall[] = []
  let visible = ''
  let pendingText = ''
  let offset = 0
  const markers = new RegExp(MARKER)
  const flushText = () => {
    if (pendingText.trim()) textParts.push(pendingText.trim())
    visible += pendingText
    pendingText = ''
  }
  let marker: RegExpExecArray | null
  while ((marker = markers.exec(text)) !== null) {
    pendingText += text.slice(offset, marker.index)
    offset = markers.lastIndex
    const name = marker[2].toLowerCase()
    if (marker[1]) {
      // A missing opening reasoning tag leaves no proven visible prefix.
      if (HIDDEN_TAGS.has(name)) { pendingText = ''; visible = ''; textParts.length = 0; toolCalls.length = 0 }
      continue
    }
    if (HIDDEN_TAGS.has(name)) {
      const hiddenStack = [name]
      while (hiddenStack.length > 0 && (marker = markers.exec(text)) !== null) {
        const innerName = marker[2].toLowerCase()
        if (HIDDEN_TAGS.has(innerName)) {
          if (!marker[1]) hiddenStack.push(innerName)
          else if (hiddenStack.at(-1) === innerName) hiddenStack.pop()
        }
      }
      if (hiddenStack.length > 0) { offset = text.length; break }
      offset = markers.lastIndex
      continue
    }
    const closing = new RegExp(`</${marker[2]}>`, 'g')
    closing.lastIndex = offset
    const end = closing.exec(text)
    if (!end) { offset = text.length; break }
    if (name !== 'tool_result') {
      flushText()
      const parsed = parseBlock(text.slice(offset, end.index).trim(), registered)
      if (parsed) toolCalls.push(parsed)
    }
    offset = closing.lastIndex
    markers.lastIndex = offset
  }
  pendingText += removePartialMarkerTail(text.slice(offset))
  flushText()
  return { textParts, toolCalls, cleaned: visible.replace(/\n{3,}/g, '\n\n').trim() }
}

/** Parse a settled response against a frozen registry. This is not a streaming
 * prefix projection: an incomplete raw call may still turn into an action. */
export function parseAgentResponseProtocol(content: string, registeredToolNames: readonly string[]): AgentResponseProtocol {
  const registered = new Set(registeredToolNames)
  const rawCall = parseRawCall(content, registered) ?? parseEnvelope(content, registered)
  if (rawCall) return { textParts: [], toolCalls: [rawCall], visibleText: '' }
  const parsed = scanProtocol(content, registered)
  return { textParts: parsed.textParts, toolCalls: parsed.toolCalls,
    visibleText: parsed.textParts.join('').replace(/\n{3,}/g, '\n\n').trim() }
}

/** Preserve prose spacing when cleaning an already selected visible response. */
export function cleanAgentProtocolVisibleText(content: string, registeredToolNames: readonly string[]): string {
  const registered = new Set(registeredToolNames)
  if (parseRawCall(content, registered) ?? parseEnvelope(content, registered)) return ''
  return scanProtocol(content, registered).cleaned
}

/** A terminal interruption may retain prose, but never promotes a partial call
 * to a tool action. Ambiguous raw JSON/name prefixes are held back. */
export function projectInterruptedAgentVisibleText(content: string, registeredToolNames: readonly string[]): string {
  const visible = cleanAgentProtocolVisibleText(content, registeredToolNames)
  const trimmed = visible.trimStart()
  if (trimmed.startsWith('{')) return ''
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim()
  if (firstLine && registeredToolNames.some(name => name === firstLine || name.startsWith(firstLine) && !trimmed.includes('\n'))) return ''
  return visible
}
