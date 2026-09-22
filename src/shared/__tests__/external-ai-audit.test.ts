import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES,
  EXTERNAL_AI_AUDIT_PAGE_SIZE,
  buildExternalAiAuditClipboardText,
  createExternalAiAuditEntryId,
  faviconUrlFor,
  normalizeExternalAiAuditEntries,
  normalizeExternalAiAuditName,
  normalizeExternalAiUrl,
} from '../external-ai-audit'

describe('external AI audit entry contracts', () => {
  it('ships eight built-in entries laid out as two tidy 2x2 pages', () => {
    expect(DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES).toHaveLength(8)
    expect(DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.map(entry => entry.name)).toEqual([
      'DeepSeek', '豆包', '通义千问', 'Kimi',
      'ChatGPT', 'Gemini', '文心一言', '腾讯元宝',
    ])
    expect(DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.every(entry => entry.builtin)).toBe(true)
  })

  it('puts the four everyday assistants on the first page', () => {
    const firstPage = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.slice(0, EXTERNAL_AI_AUDIT_PAGE_SIZE)
    const secondPage = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.slice(EXTERNAL_AI_AUDIT_PAGE_SIZE)

    // 每页正好四个，两页都是完整的 2×2，不会出现半行
    expect(firstPage).toHaveLength(EXTERNAL_AI_AUDIT_PAGE_SIZE)
    expect(secondPage).toHaveLength(EXTERNAL_AI_AUDIT_PAGE_SIZE)
    expect(firstPage.map(entry => entry.name)).toEqual(['DeepSeek', '豆包', '通义千问', 'Kimi'])
    expect(secondPage.map(entry => entry.name)).toEqual(['ChatGPT', 'Gemini', '文心一言', '腾讯元宝'])
  })

  it('keeps every built-in address an https destination', () => {
    for (const entry of DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES) {
      expect(normalizeExternalAiUrl(entry.url)).toBe(entry.url)
    }
  })

  it('gives every built-in entry a distinct identity', () => {
    const ids = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('generates a unique id for every custom entry', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createExternalAiAuditEntryId()))
    expect(ids.size).toBe(50)
  })
})

describe('normalizeExternalAiUrl', () => {
  it('accepts http and https destinations', () => {
    expect(normalizeExternalAiUrl('https://chat.deepseek.com/')).toBe('https://chat.deepseek.com/')
    expect(normalizeExternalAiUrl('http://localhost:3000/chat')).toBe('http://localhost:3000/chat')
  })

  it('repairs a bare host the way an author would paste it', () => {
    expect(normalizeExternalAiUrl('chat.deepseek.com')).toBe('https://chat.deepseek.com/')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeExternalAiUrl('  https://www.kimi.com/  ')).toBe('https://www.kimi.com/')
  })

  it('rejects every protocol that could act on the local machine', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'data:text/html,<script>alert(1)</script>',
      'ms-msdt:/id',
      'vbscript:msgbox(1)',
      'chrome://settings',
    ]) {
      expect(normalizeExternalAiUrl(hostile)).toBeNull()
    }
  })

  it('rejects non-strings, empty input, and absurdly long input', () => {
    expect(normalizeExternalAiUrl(undefined)).toBeNull()
    expect(normalizeExternalAiUrl(42)).toBeNull()
    expect(normalizeExternalAiUrl('')).toBeNull()
    expect(normalizeExternalAiUrl('   ')).toBeNull()
    expect(normalizeExternalAiUrl(`https://example.com/${'a'.repeat(4000)}`)).toBeNull()
  })
})

describe('normalizeExternalAiAuditName', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeExternalAiAuditName('  智谱   清言 \n ')).toBe('智谱 清言')
  })

  it('caps the length so one long name cannot break the grid', () => {
    expect(normalizeExternalAiAuditName('名'.repeat(80))).toHaveLength(24)
  })

  it('returns an empty string for non-strings', () => {
    expect(normalizeExternalAiAuditName(null)).toBe('')
  })
})

describe('faviconUrlFor', () => {
  it('resolves the site logo through the icon service', () => {
    expect(faviconUrlFor('https://chat.deepseek.com/')).toBe('https://favicon.im/chat.deepseek.com')
    expect(faviconUrlFor('https://www.doubao.com/chat/')).toBe('https://favicon.im/www.doubao.com')
    expect(faviconUrlFor('https://www.tongyi.com/qianwen/')).toBe('https://favicon.im/www.tongyi.com')
  })

  it('returns null when the address itself is unusable', () => {
    expect(faviconUrlFor('javascript:alert(1)')).toBeNull()
  })
})

describe('normalizeExternalAiAuditEntries', () => {
  it('falls back to the factory defaults when nothing is stored', () => {
    expect(normalizeExternalAiAuditEntries(undefined)).toEqual([...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES])
    expect(normalizeExternalAiAuditEntries('not an array')).toEqual([...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES])
  })

  it('drops corrupted rows instead of letting them reach the UI', () => {
    const entries = normalizeExternalAiAuditEntries([
      { id: 'custom-1', name: '智谱清言', url: 'https://chatglm.cn/', builtin: false },
      { id: 'custom-2', name: '坏链接', url: 'javascript:alert(1)', builtin: false },
      { id: '', name: '没有 id', url: 'https://example.com/', builtin: false },
      null,
      'nonsense',
    ])

    expect(entries.map(entry => entry.name)).toEqual(['智谱清言'])
  })

  it('restores duplicate ids only once', () => {
    const entries = normalizeExternalAiAuditEntries([
      { id: 'custom-1', name: '第一个', url: 'https://a.example.com/', builtin: false },
      { id: 'custom-1', name: '重复的', url: 'https://b.example.com/', builtin: false },
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('第一个')
  })

  it('keeps the built-ins in factory order ahead of custom entries', () => {
    const entries = normalizeExternalAiAuditEntries([
      { id: 'custom-1', name: '智谱清言', url: 'https://chatglm.cn/', builtin: false },
      { id: 'builtin-kimi', name: 'Kimi', url: 'https://www.kimi.com/', builtin: true },
      { id: 'builtin-deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/', builtin: true },
    ])

    expect(entries.map(entry => entry.id)).toEqual(['builtin-deepseek', 'builtin-kimi', 'custom-1'])
    expect(entries.every(entry => entry.builtin === false || entry.builtin === true)).toBe(true)
  })
})

describe('buildExternalAiAuditClipboardText', () => {
  /** 模拟 chapter-review-prompt 装配好的完整提示词（抬头之外的一切都原样保留）。 */
  const assembledPrompt = [
    '【补充写作 Skill：连贯性审稿】',
    '以下内容只能补充创作方法；作者事实、项目写作语言和后续输出合同始终优先。',
    '检查伏笔回收与角色状态漂移。',
    '',
    '请对以下章节进行审查。',
    '',
    '【待审章节】雾从港口漫上来，灯塔的光在水面上碎成一片。',
  ].join('\n')

  it('wraps the assembled prompt with a header naming the chapter', () => {
    const text = buildExternalAiAuditClipboardText({
      chapterTitle: '雾港的灯',
      chapterNumber: 3,
      prompt: assembledPrompt,
    })

    expect(text).toContain('雾港的灯')
    expect(text.indexOf('请审稿')).toBeLessThan(text.indexOf(assembledPrompt))
  })

  it('says up front that the material matches the built-in review', () => {
    const text = buildExternalAiAuditClipboardText({
      chapterTitle: '雾港的灯',
      chapterNumber: 3,
      prompt: assembledPrompt,
    })

    expect(text).toContain('与软件内置审稿用的是同一份材料')
  })

  it('carries the assembled prompt through untouched', () => {
    const text = buildExternalAiAuditClipboardText({
      chapterTitle: '雾港的灯',
      chapterNumber: 3,
      prompt: assembledPrompt,
    })

    // 抬头之外一个字符都不许改：审查原则、检查维度、写作 Skill 全在里面
    expect(text.endsWith(assembledPrompt)).toBe(true)
    expect(text).toContain('【补充写作 Skill：连贯性审稿】')
    expect(text).toContain('【待审章节】')
  })

  it('falls back to the chapter number when the title is missing', () => {
    const text = buildExternalAiAuditClipboardText({ chapterTitle: '', chapterNumber: 7, prompt: assembledPrompt })
    expect(text).toContain('第 7 章')
  })

  it('writes an English header for an English workspace', () => {
    const text = buildExternalAiAuditClipboardText({
      chapterTitle: 'The Lantern',
      chapterNumber: 7,
      prompt: assembledPrompt,
      locale: 'en-US',
    })

    expect(text).toContain('[Review request:')
    expect(text).not.toContain('请审稿')
    expect(text.endsWith(assembledPrompt)).toBe(true)
  })
})
