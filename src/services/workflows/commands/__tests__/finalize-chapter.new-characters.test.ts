/**
 * 正文新角色提名 —— 接住 `update_character_cards` 一直在返回、却一直没人读的
 * `newCharacters` 一段。
 *
 * 先生 2026-09-21：「明明是用户自己点 AI 生成出来的…这应该让用户自己来判断」。
 * 这段输出此前被解析器整段丢弃：正文里冒出来的新人物既不建档、也不提醒作者。
 * 现在它只做一件事 —— **提名**，去留交给作者在角色页裁决。
 *
 * 同日追加：提名里的 `currentState` 一度也被漏掉（只取 name / role），
 * 于是采纳建档出来的角色卡只有名字（先生报障）。见文件末尾两个用例。
 */
import { describe, expect, it } from 'vitest'

import { parseNewCharacterCandidates } from '../finalize-chapter.command'
import type { CharacterRosterEntry } from '../../../../shared/character-roster'

const ROSTER = [{ name: '林青檀' }, { name: '余思雨' }] as unknown as readonly CharacterRosterEntry[]
const CHAPTER = '林青檀撑着伞站在校门口。李莉莉小跑过来，压低声音说：“昨晚三眼会又动手了。”'

function respond(newCharacters: unknown): string {
  return JSON.stringify({ updates: [], newCharacters })
}

describe('parseNewCharacterCandidates', () => {
  it('只提名名单外的角色 —— 名单里已有的不算新人', () => {
    const result = parseNewCharacterCandidates(
      respond([
        { name: '林青檀', role: '主角' },
        { name: '李莉莉', role: '主要人物' },
      ]),
      ROSTER,
      CHAPTER,
      12,
    )
    expect(result.map(item => item.name)).toEqual(['李莉莉'])
    // 提示词里写的是「主要人物」，它得认出这是主角而不是兜底成配角。
    expect(result[0]?.role).toBe('protagonist')
    expect(result[0]?.chapterNumber).toBe(12)
  })

  it('随名字附一段本地正文依据；正文里找不到就留空，绝不编造', () => {
    const [hit] = parseNewCharacterCandidates(respond([{ name: '李莉莉' }]), ROSTER, CHAPTER, 3)
    expect(hit?.evidence).toContain('李莉莉小跑过来')

    const [miss] = parseNewCharacterCandidates(respond([{ name: '查无此人' }]), ROSTER, CHAPTER, 3)
    expect(miss?.evidence).toBe('')
  })

  it('同一次输出里重名（含首尾空白差异）只留一条', () => {
    const result = parseNewCharacterCandidates(
      respond([{ name: '李莉莉' }, { name: ' 李莉莉 ' }]),
      ROSTER,
      CHAPTER,
      4,
    )
    expect(result).toHaveLength(1)
  })

  it('读不懂的输出一律退化成空数组，绝不抛错', () => {
    // 它是定稿的附加信息：宁可少提一次名，也不能把整章定稿搞失败。
    expect(parseNewCharacterCandidates('{"updates":[]}', ROSTER, CHAPTER, 5)).toEqual([])
    expect(parseNewCharacterCandidates('{"newCharacters":"李莉莉"}', ROSTER, CHAPTER, 5)).toEqual([])
    expect(parseNewCharacterCandidates('{"updates":[', ROSTER, CHAPTER, 5)).toEqual([])
    expect(parseNewCharacterCandidates('', ROSTER, CHAPTER, 5)).toEqual([])
  })

  it('空名字与超长名字直接跳过', () => {
    const result = parseNewCharacterCandidates(
      respond([{ name: '   ' }, { name: '甲'.repeat(300) }, { name: '李莉莉' }]),
      ROSTER,
      CHAPTER,
      6,
    )
    expect(result.map(item => item.name)).toEqual(['李莉莉'])
  })

  /**
   * 先生（本轮报障）：「角色管理中，随着剧情推进，建立了角色新档，
   * 但新档只有名字，里面没有任何的内容？」
   *
   * 根因就在这里：提示词一直要求 `newCharacters` 的每一项带 `currentState`，
   * 解析器此前只取 name 与 role —— 状态整块被丢。这两个用例把它钉住。
   */
  it('接住模型随提名给出的 currentState', () => {
    const [candidate] = parseNewCharacterCandidates(
      respond([{
        name: '李莉莉',
        role: '配角',
        currentState: {
          location: '校门口',
          powerLevel: '凡人',
          physicalState: '轻伤',
          mentalState: '警惕',
          keyItems: '黑色录音笔',
          recentEvents: '把三眼会的事告诉了林青檀',
          updatedAtChapter: 12,
        },
      }]),
      ROSTER,
      CHAPTER,
      12,
    )

    expect(candidate?.currentState).toEqual({
      location: '校门口',
      powerLevel: '凡人',
      physicalState: '轻伤',
      mentalState: '警惕',
      keyItems: '黑色录音笔',
      recentEvents: '把三眼会的事告诉了林青檀',
      updatedAtChapter: 12,
    })
  })

  it('currentState 一律收口：认得的字段留下、其余丢掉，空状态就是空对象', () => {
    // 模型自述的章号与本地不一致时，以本地为准 —— 这一块描述的就是「本章的状态」。
    const [candidate] = parseNewCharacterCandidates(
      respond([{
        name: '李莉莉',
        currentState: {
          location: '校门口',
          updatedAtChapter: 7,
          // 提示词里没有的字段：一律不接
          hobby: '听歌',
        },
      }]),
      ROSTER,
      CHAPTER,
      12,
    )
    expect(candidate?.currentState).toEqual({ location: '校门口', updatedAtChapter: 12 })

    // 一个字段都读不到 → 空对象，绝不留下「第 0 章更新」这种噪声
    const [empty] = parseNewCharacterCandidates(
      respond([{ name: '李莉莉', currentState: { location: '   ' } }]),
      ROSTER,
      CHAPTER,
      12,
    )
    expect(empty?.currentState).toEqual({})

    // 压根没给 currentState（老格式的输出）→ 同样退化成空对象，不抛错
    const [missing] = parseNewCharacterCandidates(respond([{ name: '李莉莉' }]), ROSTER, CHAPTER, 12)
    expect(missing?.currentState).toEqual({})
  })
})
