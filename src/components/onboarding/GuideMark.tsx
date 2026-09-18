/**
 * 新手引导的标记（自绘 SVG，不借用产品印章）。
 *
 * 造型取「墨纸书斋」的书卷意象：一圈虚线像未写完的行程，里面是一本摊开的书，
 * 书脊居中、两侧书页微微内收 —— 与产品的纸墨气质一致，又在 13px 下仍然认得出。
 * 全部用 currentColor 描边，所以放在什么颜色的按钮里就自动是什么色（教程按钮是白字）。
 */
export default function GuideMark({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* 外圈：虚线行程 */}
      <circle cx="12" cy="12" r="9.2" strokeDasharray="2.2 2.6" />
      {/* 摊开的书：左右两页 + 书脊 + 页边线 */}
      <path d="M12 8.6c-1.05-.85-2.45-1.25-3.75-1.25v7.9c1.3 0 2.7.4 3.75 1.25" />
      <path d="M12 8.6c1.05-.85 2.45-1.25 3.75-1.25v7.9c-1.3 0-2.7.4-3.75 1.25" />
      <path d="M12 8.6v7.9" />
    </svg>
  )
}
