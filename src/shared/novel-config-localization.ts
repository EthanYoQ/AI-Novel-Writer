import type { WritingLanguage } from './writing-language'

type LocalizedLabel = Readonly<{ zhCN: string; enUS: string }>

const GENRE_LABELS: Readonly<Record<string, LocalizedLabel>> = {
  玄幻: { zhCN: '玄幻', enUS: 'Eastern fantasy' },
  仙侠: { zhCN: '仙侠', enUS: 'Xianxia' },
  都市: { zhCN: '都市', enUS: 'Urban' },
  科幻: { zhCN: '科幻', enUS: 'Science fiction' },
  历史: { zhCN: '历史', enUS: 'Historical' },
  军事: { zhCN: '军事', enUS: 'Military' },
  游戏: { zhCN: '游戏', enUS: 'Game' },
  末世: { zhCN: '末世', enUS: 'Post-apocalyptic' },
  悬疑: { zhCN: '悬疑', enUS: 'Mystery' },
  灵异: { zhCN: '灵异', enUS: 'Supernatural' },
  言情: { zhCN: '言情', enUS: 'Romance' },
  古言: { zhCN: '古言', enUS: 'Historical romance' },
  现言: { zhCN: '现言', enUS: 'Contemporary romance' },
  奇幻: { zhCN: '奇幻', enUS: 'Fantasy' },
  武侠: { zhCN: '武侠', enUS: 'Wuxia' },
  轻小说: { zhCN: '轻小说', enUS: 'Light novel' },
  同人: { zhCN: '同人', enUS: 'Fan fiction' },
  职场: { zhCN: '职场', enUS: 'Workplace' },
}

const AUDIENCE_LABELS: Readonly<Record<string, LocalizedLabel>> = {
  男频: { zhCN: '男频', enUS: 'Male-oriented' },
  女频: { zhCN: '女频', enUS: 'Female-oriented' },
  双性向: { zhCN: '双性向', enUS: 'All audiences' },
  全龄: { zhCN: '全龄', enUS: 'All ages' },
}

const PLOT_STRUCTURE_LABELS: Readonly<Record<string, LocalizedLabel>> = {
  three_act: { zhCN: '三幕结构', enUS: 'Three-act' },
  三幕式: { zhCN: '三幕式', enUS: 'Three-act' },
  heros_journey: { zhCN: '英雄之旅', enUS: 'Hero’s journey' },
  save_the_cat: { zhCN: '节拍表', enUS: 'Beat sheet' },
  kishotenketsu: { zhCN: '起承转合', enUS: 'Kishōtenketsu' },
  multi_thread: { zhCN: '多线叙事', enUS: 'Multi-thread' },
  freeform: { zhCN: '自由结构', enUS: 'Freeform' },
}

const NARRATIVE_POV_LABELS: Readonly<Record<string, LocalizedLabel>> = {
  third_limited: { zhCN: '第三人称有限', enUS: 'Third-person limited' },
  第三人称限知: { zhCN: '第三人称限知', enUS: 'Third-person limited' },
  first_person: { zhCN: '第一人称', enUS: 'First person' },
  third_omniscient: { zhCN: '第三人称全知', enUS: 'Third-person omniscient' },
  multi_pov: { zhCN: '多视角', enUS: 'Multiple viewpoints' },
}

function localize(value: string | undefined, labels: Readonly<Record<string, LocalizedLabel>>, language: WritingLanguage): string {
  if (!value) return ''
  const label = labels[value]
  return label ? (language === 'en-US' ? label.enUS : label.zhCN) : value
}

type ModelFactConfig = Partial<Record<'genre' | 'targetAudience' | 'plotStructure' | 'narrativePOV', string>>

export function localizeNovelConfigFacts(config: ModelFactConfig, language: WritingLanguage) {
  return {
    genre: localize(config.genre, GENRE_LABELS, language),
    targetAudience: localize(config.targetAudience, AUDIENCE_LABELS, language),
    plotStructure: localize(config.plotStructure, PLOT_STRUCTURE_LABELS, language),
    narrativePOV: localize(config.narrativePOV, NARRATIVE_POV_LABELS, language),
  }
}

function englishLabels(labels: Readonly<Record<string, LocalizedLabel>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(labels).map(([value, label]) => [value, label.enUS]),
  ))
}

export const GENRE_EN = englishLabels(GENRE_LABELS)
export const AUDIENCE_EN = englishLabels(AUDIENCE_LABELS)
