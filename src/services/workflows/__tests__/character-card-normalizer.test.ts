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

  it('extracts every named character from prompt-conformant numbered character paragraphs', () => {
    const source = [
      '# 角色图谱',
      '## 1. 【第一核心：主角】',
      '1. 姓名/代号：沈砺',
      '- 表面追求与终极渴望：夺回被家族剥夺的矿脉经营权。',
      '- 标志性外貌特征：常穿沾有矿尘的旧风衣，左眉有旧伤。',
      '## 2. 【核心角色阵营】',
      '1. 姓名/代号：叶霜',
      '- 身份背景：矿区医师，掌握事故真相。',
      '- 标志性外貌特征：白色防尘面罩总挂在颈间。',
      '2. 姓名/代号：陆沉',
      '- 身份背景：家族派来的竞争者。',
      '- 标志性外貌特征：黑色手套从不离手。',
      '## 3. 【核心矛盾交织网】',
      '沈砺与陆沉争夺矿脉，叶霜夹在救人和保守秘密之间。',
    ].join('\n')

    const cards = extractCompleteCharacterCards('', source)

    expect(cards.map(card => card.name)).toEqual(['沈砺', '叶霜', '陆沉'])
    expect(cards.map(card => card.role)).toEqual(['protagonist', 'supporting', 'supporting'])
    expect(cards.find(card => card.name === '叶霜')?.background).toBe('矿区医师，掌握事故真相。')
  })

  it('matches model cards to prompt-conformant role-title character headings', () => {
    const source = [
      '# 角色图谱',
      '### 【第一核心：主角】 沈砺',
      '- 表面追求与终极渴望：查清矿区事故真相。',
      '### 【核心角色阵营】',
      '#### 核心盟友：老周（周同安）',
      '- 身份背景：退休检修员，保存了原始记录。',
      '#### 理念对立者：陈默（陈技术员 / 代号“指标”）',
      '- 身份背景：事故善后负责人，主张以稳定压过真相。',
      '#### 灰色观察者：小邱（邱屿）',
      '- 身份背景：矿区档案员，立场尚未明朗。',
      '### 【核心矛盾交织网】',
      '沈砺追查真相，陈默阻止公开，老周与小邱各有保留。',
    ].join('\n')
    const model = JSON.stringify({
      characters: [
        { name: '沈砺', role: 'protagonist' },
        { name: '老周', role: 'supporting' },
        { name: '陈默', role: 'antagonist' },
        { name: '小邱', role: 'supporting' },
      ],
    })

    const cards = extractCompleteCharacterCards(model, source)

    expect(cards.map(card => card.name)).toEqual(['沈砺', '老周', '陈默', '小邱'])
    expect(cards.map(card => card.role)).toEqual(['protagonist', 'supporting', 'antagonist', 'supporting'])
  })

  it('fails closed instead of treating an arbitrary colon title as a role-section character', () => {
    const source = [
      '# 角色图谱',
      '## 核心角色阵营',
      '### 线索说明：沈砺',
      '- 身份背景：这是一段叙事说明，不是角色条目。',
    ].join('\n')

    expect(() => extractCompleteCharacterCards('', source)).toThrow(
      '无法从角色图谱中安全识别完整角色清单',
    )
  })

  it('matches model cards to standalone bold prompt-conformant role headings', () => {
    const source = [
      '**【第一核心：主角】沈砺**',
      '- **姓名/代号**：沈砺 / “断指”技师。原矿场事故幸存者。',
      '- **标志性外貌特征**：左手缺一截食指，常穿旧工装。',
      '**【核心角色阵营】**',
      '**1. 顾湘（盟友/解密者）**',
      '- **姓名/代号**：顾湘 / “断指”技师。原矿场检修员。',
      '**2. 宋延军（竞争者/理念对立者）**',
      '- **姓名/代号**：宋延军 / 矿区安保负责人。',
    ].join('\n')
    const model = JSON.stringify({
      characters: [
        { name: '沈砺', role: 'protagonist' },
        { name: '顾湘', role: 'supporting' },
        { name: '宋延军', role: 'antagonist' },
      ],
    })

    const cards = extractCompleteCharacterCards(model, source)

    expect(cards.map(card => card.name)).toEqual(['沈砺', '顾湘', '宋延军'])
    expect(cards.map(card => card.role)).toEqual(['protagonist', 'supporting', 'antagonist'])
  })

  it('keeps an ordinary name field with aliases fail-closed', () => {
    const source = [
      '# 角色图谱',
      '## 核心角色阵营',
      '1. 姓名：顾湘 / “断指”技师',
      '- 身份背景：原矿场检修员。',
    ].join('\n')

    expect(() => extractCompleteCharacterCards('', source)).toThrow(
      '无法从角色图谱中安全识别完整角色清单',
    )
  })

  it('prefers an explicit competitor descriptor over an incidental protagonist mention', () => {
    const source = [
      '# 角色图谱',
      '## 核心角色阵营',
      '### 与主角理念对立的竞争者：宋延军',
      '- 身份背景：矿区安保负责人，主张用稳定压过真相。',
    ].join('\n')

    const cards = extractCompleteCharacterCards('', source)

    expect(cards).toEqual([
      expect.objectContaining({ name: '宋延军', role: 'antagonist' }),
    ])
  })

  it('fails closed for a bracketed conflict title with a trailing narrative label', () => {
    const source = [
      '# 角色图谱',
      '## 【核心冲突：主角与反派】宿命之战',
    ].join('\n')

    expect(() => extractCompleteCharacterCards('', source)).toThrow(
      '无法从角色图谱中安全识别完整角色清单',
    )
  })

  it('fails closed for a role-like institution title', () => {
    const source = [
      '# 角色图谱',
      '## 核心角色阵营',
      '### 导师制度：沈砺',
      '- 身份背景：矿区培训体系说明。',
    ].join('\n')

    expect(() => extractCompleteCharacterCards('', source)).toThrow(
      '无法从角色图谱中安全识别完整角色清单',
    )
  })

  it('fails closed when a parenthetical character role contains mutually exclusive signals', () => {
    const source = [
      '# 角色图谱',
      '## 陈默（主角，主要反派为其内在人格）',
      '- 身份背景：被内在人格持续侵蚀的矿区工程师。',
    ].join('\n')

    expect(() => extractCompleteCharacterCards('', source)).toThrow(
      '无法从角色图谱中安全识别完整角色清单',
    )
  })
})
