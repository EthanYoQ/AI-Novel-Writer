import { describe, expect, it } from 'vitest'

import {
  extractCompleteCharacterCards,
  normalizeCharacterCardsForPersistence,
  parseCharacterCardsFromModelOrSource,
} from '../character-card-normalizer'

describe('character card normalizer', () => {
  it('preserves extracted cards that use Chinese field names', () => {
    const cards = normalizeCharacterCardsForPersistence([
      {
        姓名: '林晓薇',
        定位: '主角',
        性别: '女',
        年龄: '27',
        外貌特征: '穿灰色职业套装，神情克制。',
        性格特点: '谨慎、压抑、观察力强',
        背景故事: '航司管理层候选人。',
        能力: '数据分析与谈判',
        核心动机: '保住职业上升通道',
        关系网: [{ name: 'Ethan', relation: '上级/压迫者' }],
        成长轨迹: '从被动忍耐到主动反制',
      },
      {
        name: 'Ethan',
        role: 'antagonist',
        relationships: '林晓薇：下属/被操控对象',
      },
    ])

    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatchObject({
      name: '林晓薇',
      role: 'protagonist',
      gender: '女',
      age: '27',
      appearance: '穿灰色职业套装，神情克制。',
      motivation: '保住职业上升通道',
      arc: '从被动忍耐到主动反制',
    })
    expect(JSON.parse(cards[0].relationships)).toEqual([
      { target: 'Ethan', relation: '上级/压迫者' },
    ])
  })

  it('converts relationship text into graph-readable edges when target names are known', () => {
    const cards = normalizeCharacterCardsForPersistence([
      {
        name: '林晓薇',
        role: 'protagonist',
        relationships: '她与Ethan是表面合作实则被压制；和周砚互相试探但共享线索。',
      },
      { name: 'Ethan', role: 'antagonist', relationships: '' },
      { name: '周砚', role: 'supporting', relationships: '' },
    ])

    expect(JSON.parse(cards[0].relationships)).toEqual([
      { target: 'Ethan', relation: '她与Ethan是表面合作实则被压制' },
      { target: '周砚', relation: '和周砚互相试探但共享线索。' },
    ])
  })

  it('filters nameless cards and stringifies persistence fields', () => {
    const cards = normalizeCharacterCardsForPersistence([
      { role: '主角', relationships: [{ target: '无人', relation: '无名卡' }] },
      { name: '周砚', role: '重要配角', abilities: ['调查', '推理'], relationships: [] },
    ])

    expect(cards).toHaveLength(1)
    expect(cards[0].name).toBe('周砚')
    expect(cards[0].role).toBe('supporting')
    expect(cards[0].abilities).toBe('调查；推理')
    expect(cards[0].relationships).toBe('')
  })

  it('falls back to source character objects when the local model returns prose instead of JSON', () => {
    const source = JSON.stringify({
      燕云: { 关系: ['父亲燕九鼎', '爷爷燕怀山'], 动力: '证明自己' },
      陈杰波: { 关系: ['刘丽'], 动力: '维持灰色利益链' },
    })

    const cards = parseCharacterCardsFromModelOrSource(
      '张力\n</think>\n\n段落一：燕云是核心角色，陈杰波是对手角色。',
      source,
    )

    expect(cards.map((card) => card.name)).toEqual(['燕云', '陈杰波'])
    expect(cards[0].motivation).toBe('证明自己')
    expect(cards[0].relationships).toContain('燕九鼎')
  })

  it('extracts fenced or prefixed JSON from local model output before normalizing', () => {
    const cards = parseCharacterCardsFromModelOrSource(
      [
        '以下是结构化结果：',
        '```json',
        '{"characters":[{"姓名":"林晓薇","定位":"主角","关系网":[{"target":"周砚","relation":"盟友"}]},{"姓名":"周砚","定位":"重要配角"}]}',
        '```',
      ].join('\n'),
      '',
    )

    expect(cards).toHaveLength(2)
    expect(cards[0].name).toBe('林晓薇')
    expect(JSON.parse(cards[0].relationships)).toEqual([{ target: '周砚', relation: '盟友' }])
  })

  it('completes a partial model response with every character represented in the source architecture', () => {
    const source = JSON.stringify({
      characters: [
        {
          name: '林晓薇',
          role: 'protagonist',
          relationships: [{ target: '周砚', relation: '共同追查真相' }],
        },
        { name: '周砚', role: 'supporting', background: '掌握关键线索的调查记者' },
        { name: 'Ethan', role: 'antagonist', background: '施压主角的上级' },
      ],
    })
    const model = JSON.stringify({
      characters: [{
        name: '林晓薇',
        role: 'protagonist',
        appearance: '灰色职业套装，神情克制。',
        relationships: [{ target: '周砚', relation: '互相试探的盟友' }],
      }],
    })

    const cards = parseCharacterCardsFromModelOrSource(model, source)

    expect(cards.map(card => card.name)).toEqual(['林晓薇', '周砚', 'Ethan'])
    expect(cards.map(card => card.role)).toEqual(['protagonist', 'supporting', 'antagonist'])
    expect(cards[0].appearance).toBe('灰色职业套装，神情克制。')
    expect(JSON.parse(cards[0].relationships)).toEqual([
      { target: '周砚', relation: '互相试探的盟友' },
    ])
  })

  it('extracts every character from the real markdown heading formats when the model is empty', () => {
    const source = [
      '# 角色图谱总览',
      '## 一、【第一核心：主角】',
      '### 陈默',
      '- 性别：男',
      '- 核心动机：摆脱深渊留下的命运',
      '### 角色一：苍青（盟友/共生线，非附庸）',
      '- 关系：与陈默共生',
      '### 角色二：墨无极（对手/宿敌线）',
      '- 关系：陈默：宿敌',
      '### 角色三：陶厌（灰色变数/独立线）',
      '- 背景：游走于各方势力之间',
      '## 三、深渊魔主残魂（B面人格/内在敌人）',
      '- 能力：侵蚀陈默的意志',
    ].join('\n')

    const cards = extractCompleteCharacterCards('', source)

    expect(cards.map(card => card.name)).toEqual(['陈默', '苍青', '墨无极', '陶厌', '深渊魔主残魂'])
    expect(cards.map(card => card.role)).toEqual([
      'protagonist',
      'supporting',
      'antagonist',
      'supporting',
      'antagonist',
    ])
    expect(cards.find(card => card.name === '陈默')?.motivation).toBe('摆脱深渊留下的命运')
  })

  it('does not mistake character overview or chapter headings for character cards', () => {
    const source = [
      '# 角色图谱总览',
      '## 第一卷：坠渊',
      '### 第1章：深渊来客',
      '### 第一节：命运裂缝',
      '## 一、【第一核心：主角】',
      '### 角色一：苍青（盟友/共生线，非附庸）',
      '## 第二卷：旧敌重逢',
      '### 第2章：墨色风暴',
    ].join('\n')

    const cards = extractCompleteCharacterCards('', source)

    expect(cards.map(card => card.name)).toEqual(['苍青'])
  })

  it('keeps a role section narrative heading out of the roster', () => {
    const source = [
      '# 角色图谱',
      '## 第一核心：主角',
      '### 陈默',
      '- 性别：男',
      '- 核心动机：摆脱深渊留下的命运',
      '### 宿命冲突',
      '- 主题：陈默必须在自由与责任之间作出选择',
    ].join('\n')

    const cards = extractCompleteCharacterCards('', source)

    expect(cards.map(card => card.name)).toEqual(['陈默'])
  })

  it('fails closed when a role candidate cannot be matched to a supported character entry', () => {
    const source = [
      '# 角色图谱',
      '## 主角：陈默',
      '- 性别：男',
      '## 反派：',
      '- 目标：阻止陈默离开深渊',
    ].join('\n')

    expect(() => extractCompleteCharacterCards('', source)).toThrow(
      '无法从角色图谱中安全识别完整角色清单',
    )
  })

  it('fails closed when a role candidate names multiple possible characters', () => {
    const source = [
      '# 角色图谱',
      '## 主角：陈默',
      '- 性别：男',
      '## 反派：墨无极 / 深渊魔主',
      '- 目标：阻止陈默离开深渊',
    ].join('\n')

    expect(() => extractCompleteCharacterCards('', source)).toThrow(
      '无法从角色图谱中安全识别完整角色清单',
    )
  })

  it('preserves free-form relationship notes that are not structured JSON', () => {
    const source = JSON.stringify({
      characters: [
        { name: '陈默', role: 'protagonist', relationships: '[暂无明确关系]' },
      ],
    })

    const cards = extractCompleteCharacterCards('', source)

    expect(cards).toEqual([
      expect.objectContaining({ name: '陈默', relationships: '[暂无明确关系]' }),
    ])
  })
})
