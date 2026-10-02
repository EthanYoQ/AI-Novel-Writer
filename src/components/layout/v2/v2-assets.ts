/**
 * v2 外壳的品牌素材地址。
 *
 * Vite 的 base 是相对路径（Electron 用 file:// 加载 dist），
 * public 资源必须按 BASE_URL 拼接，不能写死成绝对路径 —— 与
 * AppearanceSettings 里 ANIME_SKIN_URL 的处理方式保持一致。
 */
import type { Theme } from '../../../stores/theme-store'
import { isMagazine, type UiVersion } from '../../../stores/ui-version-store'

const assetBase = import.meta.env.BASE_URL === '/' ? './' : import.meta.env.BASE_URL

/** 顶栏印章（44px）。 */
export const BRAND_SEAL_URL = `${assetBase}brand/seal-44.png`

/** 书架首页 Hero 大印章（竖长印章，按真实比例完整显示）。 */
export const BRAND_SEAL_LARGE_URL = `${assetBase}brand/seal-100.png`

/** 书架首页的腊梅水墨背景（浅色 / 纸质 / 黑夜）。 */
export const BRAND_PLUM_BACKGROUND_URL = `${assetBase}brand/plum-blossom-1920.jpg`

/** 书架首页的星空背景（星空主题专用，先生给的图）。 */
export const BRAND_STARRY_BACKGROUND_URL = `${assetBase}brand/xingkong.png`

/** 浅纸上的压图渐变：上浅下实，让顶部印章清楚、底部自然过渡到纸色。
 *  —— 这是**墨纸书斋（v2）专属**的层，杂志版不引用它。 */
const PLUM_SHELF_SCRIM =
  'linear-gradient(180deg, rgba(252,249,240,.32) 0%, rgba(249,245,231,.58) 26%, '
  + 'rgba(245,240,223,.9) 56%, var(--paper2) 84%, var(--paper2) 100%)'

/**
 * 书架首页背景 —— 两个界面版本各一套（2026-09-16 重订）。
 *
 * 先生定调：**背景跟着「界面版本」走，不是跟着主题色走。**
 * 每个界面版本都有自己全新的背景页 —— 切换版本就是要换一整套视觉，
 * 同时**任何版本都不能蚕食另一个版本**。
 *
 *   · v1 / v2「墨纸书斋」：腊梅水墨（星空主题走先生给的星空图）+ 浅纸压图渐层，
 *     原样不动、逐像素不变 —— 切回 V2 时腊梅与星空必须原封不动地回来。
 *   · v3「时尚杂志」：不再引用任何图片，改成四层纯 CSS 叠出来的杂志版面 ——
 *     斜切色块 + 竖向栏线网格 + 纸色底。
 *
 * 教训留档：第一版曾把背景直接改成杂志版、只按 theme 分支，等于把 v2 的
 * 腊梅/星空一并吞掉（先生指出「我切换 V2，背景就要继续用腊梅和星空」）。
 * 界面版本的差异一律走 uiVersion 分支，不要只判断主题。
 */
export function shelfBackgroundStyle(theme: Theme, uiVersion: UiVersion) {
  /* ── v1 / v2：墨纸书斋原貌 ── */
  if (!isMagazine(uiVersion)) {
    const starry = theme === 'galaxy'
    return {
      backgroundColor: 'var(--paper2)',
      backgroundImage: starry
        ? `url("${BRAND_STARRY_BACKGROUND_URL}")`
        : `${PLUM_SHELF_SCRIM}, url("${BRAND_PLUM_BACKGROUND_URL}")`,
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'center',
      backgroundSize: 'cover',
    }
  }

  /* ── v3：时尚杂志 ──
   * 四层叠出来的版面，不是四张图：
   *   1 右上角一块斜切的珊瑚朱 —— 版面的一角，不是一幅画
   *   2 左下角一块斜切的靛蓝 —— 与上面成对角，两色相持
   *   3 竖向栏线网格（76px 一格）—— 杂志内页的分栏线
   *   4 纸色底：上浅下深，顶部印章清楚、底部自然收进纸色
   * 深浅主题各取一套透明度：深底上色块要略强、栏线要用浅色，否则整片糊死。 */
  const dark = theme === 'galaxy' || theme === 'dark'
  const coral = dark ? 'rgba(224, 128, 110, .10)' : 'rgba(200, 86, 74, .075)'
  const indigo = dark ? 'rgba(112, 137, 200, .09)' : 'rgba(39, 64, 122, .055)'
  const rule = dark ? 'rgba(255, 255, 255, .026)' : 'rgba(20, 19, 26, .028)'
  return {
    backgroundColor: 'var(--paper2)',
    backgroundImage: [
      `linear-gradient(115deg, transparent 0 60%, ${coral} 60% 100%)`,
      `linear-gradient(295deg, transparent 0 78%, ${indigo} 78% 100%)`,
      `repeating-linear-gradient(90deg, ${rule} 0 1px, transparent 1px 76px)`,
      'linear-gradient(180deg, var(--paper) 0%, var(--paper2) 100%)',
    ].join(', '),
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    backgroundSize: 'auto',
  }
}
