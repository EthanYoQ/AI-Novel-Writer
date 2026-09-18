/**
 * V3「时尚杂志」刊标 —— **圆角框体里的双页 W**。
 *
 * 先生 2026-09-17 从六款候选里挑了 NO.02，随后又指了两处：
 *   「你的给我一个圆角框体框起来，才像 logo 啊，现在这样很难看。」
 *   「而且我要，朱砂变色，但是现在不是。」
 *
 * 于是这一版：
 *   · **圆角框体**：圆角方形（rx ≈ 24%），朱砂实底 —— 这才是一枚「标」，
 *     而不是两条飘在纸上的线。缩到 16px 时有块可依，辨识度也靠它。
 *   · **恒为朱砂**：框体填 `var(--mag-brand-seal, #C8564A)`。
 *     它是**品牌色**，不跟栏目换色、也不跟星空主题变蓝 —— 这一点先生说得直白：
 *     「而且我要，朱砂变色，但是现在不是」（上一版前页取 `--mag-sec` 栏目色，
 *     于是走到「人物」栏它就变靛蓝、「设定」栏变青绿，那确实不像品牌）。
 *     眼下没有主题定义 `--mag-brand-seal`，所以**实际恒为朱砂**；
 *     将来若想让品牌色随主题微调（比如夜刊深底上提亮一档），
 *     只需在 `mag-palette.css` 里定义这个变量，组件不用动。
 *   · 框内的 W 用白：后页灰白细笔（已翻过去的那一页）、前页纯白粗笔（摊在手边的这一页）。
 *
 * 几何按 40×40 视框设计：框留 1px 出血，W 在框内水平居中（中心 x=20、y=20）。
 * 纯展示组件：不读 store、不接事件 —— 点击回书架的行为留在外层 `.brand` 上，
 * 所以这里 aria-hidden，可访问名由外层 title 给出。
 */
export interface MagLogoProps {
  /** 正方形边长（px）。刊头 32、首页 Hero 64、文档内联 18。 */
  size?: number
  className?: string
}

export default function MagLogo({ size = 32, className }: MagLogoProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      {/* 圆角框体：品牌朱砂。1px 出血，避免缩放时边缘发虚。
          ⚠ 颜色必须走 `style`，**不能写成 fill 属性** —— SVG 的 presentation
          attribute 不解析 `var()`：写成 `fill="var(--…)"` 会整条失效、回落成黑，
          先生看到的就是「框是黑的，不是朱砂」。 */}
      <rect
        className="maglogo-frame"
        x="1"
        y="1"
        width="38"
        height="38"
        rx="9.5"
        style={{ fill: 'var(--mag-brand-seal, #C8564A)' }}
      />
      {/* 后页：已经翻过去的那一页 —— 灰白细笔 */}
      <path
        className="maglogo-back"
        d="M10 11 L14.5 29 L19 11"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.55"
        strokeWidth="1.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      {/* 前页：正摊在手边的这一页 —— 纯白粗笔 */}
      <path
        className="maglogo-front"
        d="M21 11 L25.5 29 L30 11"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  )
}
