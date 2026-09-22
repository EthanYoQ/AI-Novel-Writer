/**
 * `forceImportant` —— 把一组属性以 `!important` 写进元素的内联样式（v3 专属工具）。
 *
 * ── 为什么需要它（三次实测换来的，逐条都有数）────────────────────────────────
 * 先生两次实测都否掉了 CSS 层的修复：「图谱依然没有无感画板」「依然是圆形」。
 * 在真 Electron 里量出来的覆盖链是这样的（`_probe-graph.mjs`）：
 *
 * ```
 * ① v2 基线（只挂类名）      画布背景 = rgb(255,255,255)   节点头像圆角 = 50%
 * ② 内联（无 !important）     仍然白                       仍然 50%   ← 内联压不过
 * ③ 内联 + !important        rgba(0,0,0,0) ✅              0px ✅     ← 只有这一条赢
 * ```
 *
 * **② 为什么失败**：v2 的图谱装帧当年为了压过 demo 基座，给关键属性锁了
 * `!important` + 深层选择器；而在 CSS 的权重规则里，**样式表里的 `!important`
 * 会压过内联的非 important 声明**。所以「写在 style 里」并不等于「一定赢」。
 *
 * **还有一个坑**：**React 的 `style` 对象不支持 `!important`** ——
 * React 用 `node.style[name] = value` 赋值，CSSStyleDeclaration 的普通赋值会把
 * `!important` 丢掉。唯一可靠的手段是 `style.setProperty(name, value, 'important')`。
 *
 * ── 它也是天然分家的 ────────────────────────────────────────────────────────
 * 调用方一律写成 `magazine ? forceImportant({...}) : undefined` ——
 * v2 拿到 `undefined`，一个属性都不会被写进去。
 *
 * ── 用在哪里 ────────────────────────────────────────────────────────────────
 * 只用在「v2 已经用 `!important` 锁死、CSS 层改不动」的地方（目前是关系图谱的
 * 画布背景与几处圆角）。**新代码优先走 CSS**，压不过时再用它，并在调用处写清原因。
 */
export function forceImportant(declarations: Record<string, string>) {
  return (element: HTMLElement | null): void => {
    if (!element) return
    for (const [property, value] of Object.entries(declarations)) {
      element.style.setProperty(property, value, 'important')
    }
  }
}
