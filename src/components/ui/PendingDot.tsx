/**
 * 未读小红点 —— 压在入口右上角那一颗。
 *
 * 先生 2026-09-21：「做个小红点？类似未读消息？让用户一看就知道这里有东西等着确认。」
 *
 * ── 为什么是绝对定位 ────────────────────────────────────────────────────────
 * 三处入口的宽度都已经压到极限：角色栏那一行在 v3 皮肤下只剩 1px 余量
 * （见 CharactersView 顶部那段注释），设定侧栏的分类行也排得满满当当。
 * 红点一旦参与布局，就会出现「有未读的时候标题被挤成省略号」这种本末倒置的事。
 * 所以它走 absolute，**不占一格宽度**，挂几颗都不影响排布。
 *
 * ── 描边那一圈是干嘛的 ──────────────────────────────────────────────────────
 * 红点压在两套皮肤的底上（侧栏底色、选中态的朱砂底、悬停灰底）。不加描边时，
 * 落在深色或同色系底上的红点会糊成一坨。用侧栏底色描 1.5px 把它「抠」出来，
 * 三套皮肤下都是同一颗干净的点；变量取不到时退化成不描边，不会画出一圈黑边。
 *
 * 纯装饰：不给它 title、也不接事件（`pointer-events-none`），
 * 「这里有什么」由入口按钮自己的 title 说清楚；红点只负责「一眼看见」。
 */
export interface PendingDotProps {
  /** 红点直径（px）。默认 6 —— 比入口文字的小圆角还小一号，不喧宾夺主。 */
  size?: number
  /** 压在容器的哪一角，默认右上角。 */
  offsetTop?: number
  offsetRight?: number
}

export default function PendingDot({
  size = 6,
  offsetTop = -1,
  offsetRight = -1,
}: PendingDotProps) {
  return (
    <span
      aria-hidden="true"
      data-pending-dot="1"
      className="pointer-events-none absolute rounded-full"
      style={{
        top: offsetTop,
        right: offsetRight,
        width: size,
        height: size,
        backgroundColor: 'var(--color-accent)',
        boxShadow: '0 0 0 1.5px var(--color-sidebar, transparent)',
      }}
    />
  )
}
