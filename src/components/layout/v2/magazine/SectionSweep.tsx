import { useMagOpenerStore } from '../../../../stores/mag-opener-store'
import { SECTION_SWEEP_MS, SECTIONS } from '../../../../shared/section-opener'

/**
 * 栏目扫线（Section Sweep）—— v3 切栏目时唯一的一次动效。
 *
 * ── 为什么只剩这一道线 ──────────────────────────────────────────────────────
 * 上一版这里是一整幅「栏目开篇页」：巨号编号 + 栏目名 + 出血色块，铺满编辑区
 * 停 1.44 秒再淡出。先生 2026-09-16 的判断很直接：
 *   「你这个开篇动画太慢，会让用户觉得卡顿。」
 * 对。过场不该让人等 —— 那一幅版面的价值（栏目身份）已经全部搬进**常驻背景**
 * （见 mag-backdrop.css），所以这里只留一道 300ms 的横向扫线：
 *
 *     0%  ├────────────▶  70%  ████████████  100%  ██████ (淡出)
 *
 * 它是「翻页的一声脆响」，不是「翻页要等一页」。底色与此同时已经换好了。
 *
 * ── 三道约束 ────────────────────────────────────────────────────────────────
 * 1. `pointer-events: none` —— 扫线期间点什么都照常落下去
 * 2. `aria-hidden` —— 屏幕阅读器读不到它
 * 3. 减少动效时组件不渲染（mag-opener-store 的闸门在 rail-routing 里）
 */
export default function SectionSweep() {
  const opening = useMagOpenerStore((s) => s.opening)
  if (!opening) return null

  const meta = SECTIONS[opening.key]
  return (
    <span
      /**
       * key = token：连点两栏时重挂载，动画从头再播一遍。
       * --mag-sec 是这一道线的颜色，与背景、左缘色带取同一个栏目色。
       */
      key={opening.token}
      className="mag-sweep"
      style={{ ['--mag-sec' as string]: `var(--mag-sec-${meta.mark})` }}
      /* 扫线的存续时长由 CSS 动画决定，这里只是把常量挂出来供测试比对 */
      data-duration={SECTION_SWEEP_MS}
      aria-hidden="true"
    />
  )
}
