import type { Theme } from '../../../stores/theme-store'

/**
 * demo 的主题索引（0 浅色 / 1 星汉 / 2 纸质 / 3 黑夜）。
 *
 * 对应关系依据两侧的背景与墨色取值：
 * - light   → 0：产品浅色与 demo 浅色同为暖米纸底，取值几乎一致
 * - paper   → 2：产品的「宣纸墨韵」对应 demo 的暖黄纸质
 * - dark    → 3：同为深底浅字
 * - galaxy  → 1：v2-themes.css 的主题 1 已重写为「星汉」深空色板
 *                （天穹 #050B14 + 冰白星光 #EAF2FF + 星尘蓝 #7FB4E0），
 *                与 v1 的 .galaxy（Logo 背景 #0A1628 + 冰蓝 #7EC8E3）同族，
 *                切换 UI 版本时星空气质保持连续。
 *
 * 历史：主题 1 原为 demo 的浅冷调「星空」（纸底 #E8EDF2），明度与产品的深蓝底
 *       相反，于是曾被直接改接黑夜索引 3 —— 结果是 galaxy 与 dark 渲染完全一致，
 *       「星空」失去名字。现以重写主题 1 的方式还它一套自己的深空。
 */
export type V2ThemeIndex = '0' | '1' | '2' | '3'

export const V2_THEME_BY_THEME: Record<Theme, V2ThemeIndex> = {
  light: '0',
  paper: '2',
  galaxy: '1',
  dark: '3',
}