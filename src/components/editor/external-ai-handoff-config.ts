/**
 * 「外部 AI 代劳」板块的两份配置。
 *
 * 与组件分开成文件是刻意的：组件文件只导出组件，Fast Refresh 才能在改样式时
 * 只替换那一个模块（混着导出常量会被整页重载）。类型也跟着配置走，
 * 免得配置与组件互相 import 绕成环。
 */

import {
  EXTERNAL_AI_AUDIT_PRESETS,
  EXTERNAL_AI_AUDIT_REQUIRED_SECTIONS,
  EXTERNAL_AI_AUDIT_SECTIONS,
  EXTERNAL_AI_REFINE_PRESETS,
  EXTERNAL_AI_REFINE_REQUIRED_SECTIONS,
  EXTERNAL_AI_REFINE_SECTIONS,
} from '../../shared/external-ai-audit'
import type {
  ExternalAiMaterialPreset,
  ExternalAiMaterialSection,
} from '../../shared/external-ai-audit'

/**
 * 一个「外部 AI 代劳」板块的全部差异点。
 *
 * 骨架（入口网格、翻页、收藏夹、材料勾选、交付方式、文件剪贴板）在审稿与修稿之间
 * 一模一样，差别只有这几项 —— 所以做成配置，组件本身只留一份。
 */
export interface ExternalAiHandoffConfig {
  title: readonly [string, string]
  hint: readonly [string, string]
  assemblingHint: readonly [string, string]
  /** 本板块的材料块（顺序即面板里的排列顺序）。 */
  sections: readonly ExternalAiMaterialSection[]
  presets: readonly ExternalAiMaterialPreset[]
  requiredSections: readonly ExternalAiMaterialSection[]
  /** 修稿专用：点「贴回改好的正文」时的文案；不传就不显示这个入口。 */
  applyResult?: {
    open: readonly [string, string]
    title: readonly [string, string]
    placeholder: readonly [string, string]
    apply: readonly [string, string]
    cancel: readonly [string, string]
  }
}

/** 审稿板块的默认配置。 */
export const AUDIT_HANDOFF_CONFIG: ExternalAiHandoffConfig = {
  title: ['外部 AI 审计', 'External AI audit'],
  hint: [
    '点一下＝带上所选材料并在浏览器打开它；材料与内置审稿同源，可用右上「材料」逐块取舍。',
    'One click carries the selected material and opens the site — same source as the built-in review, and you can pick blocks via “Materials”.',
  ],
  assemblingHint: [
    '正在装配审稿材料（正文 · 已定稿剧情 · 角色状态 · 世界观 · 蓝图 · 写作 Skill）…',
    'Assembling the review material (draft, finalized plot, character states, world-building, blueprints, writing skill)…',
  ],
  sections: EXTERNAL_AI_AUDIT_SECTIONS,
  presets: EXTERNAL_AI_AUDIT_PRESETS,
  requiredSections: EXTERNAL_AI_AUDIT_REQUIRED_SECTIONS,
}

/** 修稿板块的配置：与审稿共用同一副骨架，只是材料、预设与文案换掉。 */
export const REFINE_HANDOFF_CONFIG: ExternalAiHandoffConfig = {
  title: ['外部 AI 修稿', 'External AI revision'],
  hint: [
    '点一下＝带上所选材料并在浏览器打开它；让网页版把这一章改好，再点「贴回改好的正文」拿回软件。',
    'One click carries the selected material and opens the site — have the web AI revise this chapter, then use “Paste revision back” to bring it home.',
  ],
  assemblingHint: [
    '正在装配修稿材料（正文 · 本章信息 · 写作指导 · 文风 · 写作 Skill）…',
    'Assembling the revision material (draft, chapter info, guidance, style, writing skill)…',
  ],
  sections: EXTERNAL_AI_REFINE_SECTIONS,
  presets: EXTERNAL_AI_REFINE_PRESETS,
  requiredSections: [
    ...EXTERNAL_AI_REFINE_REQUIRED_SECTIONS,
    // 正文是修稿的对象，没有它无从谈起 —— 列出来给先生看，但不给取消
    'chapterContent',
  ],
  applyResult: {
    open: ['贴回改好的正文', 'Paste revision back'],
    title: ['把网页版改好的正文贴在这里', 'Paste the revised chapter here'],
    placeholder: [
      '在网页版 AI 那里复制它改好的正文，粘贴到这里（随后会打开差异对比）',
      'Copy the revised text from the web AI and paste it here (a comparison opens next)',
    ],
    apply: ['对比并合并', 'Compare & merge'],
    cancel: ['取消', 'Cancel'],
  },
}
