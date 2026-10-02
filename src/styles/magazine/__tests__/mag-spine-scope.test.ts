/**
 * 「裸 `.spine` 撞车」回归护栏（node 环境）。
 *
 * 2026-09-17 从先生的截图上追出来的真凶：
 * V3 给**左侧导航书脊**写的规则用的是裸 `.spine`（`mag-shell.css`），
 * 而书架里**每本书的书脊也叫 `.spine`**（`BookShelf.tsx`）。
 * 于是那条 `width: var(--mag-w-spine)`（94px）连同纸白底色、`border-right`
 * 以及 `::after { content: 'AI-NOVEL-WRITER' }` 一起套到了每一本书上 ——
 * 先生的「一个个大胖子特别难看」「书脊的字完全看不清」都是它。
 *
 * 这类错误**不抛异常、不报错**，只是悄悄把另一个页面的元素改样，
 * 所以必须用一条契约把它钉住：杂志层里凡是给导航书脊写的规则，
 * 选择器都必须带上 `SpineNav` 的根类 `.v2-spine`。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const magazineDir = resolve(process.cwd(), 'src/styles/magazine')

const files = readdirSync(magazineDir).filter((name) => name.endsWith('.css'))

const stripped = new Map(
  files.map((name) => [
    name,
    readFileSync(resolve(magazineDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
  ]),
)

/** 去掉注释后的全部杂志层 CSS，拼成一份便于全库扫描的文本。 */
const allCss = [...stripped.entries()].map(([name, body]) => `/* ${name} */\n${body}`).join('\n')

/** 匹配「选择器部分以裸 .spine 收尾、且没有 .v2-spine 限定」的规则头。 */
function findBareSpineSelectors(css: string): string[] {
  const found: string[] = []
  const ruleHeads = css.match(/[^{}]+\{/g) ?? []
  for (const head of ruleHeads) {
    const selector = head.slice(0, -1).trim()
    if (!selector.startsWith("html[data-ui='v2'][data-mag]")) continue
    for (const branch of selector.split(',')) {
      const part = branch.trim()
      // 违规 = 除了 html 前缀以外**没有任何限定**：直接就是 .spine 本身或它的伪元素。
      // 换句话说，这条规则会同时套到导航书脊和书的书脊上 —— 正是踩过的坑。
      // 带 `.v6shelf` / `.spine.v2-spine` 限定的分支都是有意的，放行。
      if (
        /^html\[data-ui='v2'\]\[data-mag\]\s*\.spine(?![\w-])(::?[a-z-]+)?$/.test(part)
      ) {
        found.push(part)
      }
    }
  }
  return found
}

describe('杂志层不许用裸 .spine（书架的书脊也叫 .spine）', () => {
  it('没有任何一条规则把 .spine 本身/伪元素当导航书脊来改', () => {
    expect(findBareSpineSelectors(allCss)).toEqual([])
  })

  it('导航书脊的规则都带了 SpineNav 的根类 .v2-spine', () => {
    const shell = stripped.get('mag-shell.css') ?? ''
    expect(shell).toContain("html[data-ui='v2'][data-mag] .spine.v2-spine {")
    expect(shell).toContain("html[data-ui='v2'][data-mag] .spine.v2-spine::after {")
  })

  it('书架那侧另有一条兜底：书脊填满书的宽度，不吃导航的 94px', () => {
    const pages = stripped.get('mag-pages.css') ?? ''
    const shelfReset = pages.match(
      /html\[data-ui='v2'\]\[data-mag\]\s*\.v6shelf \.spine \{([^}]*)\}/g,
    ) ?? []
    const merged = shelfReset.join('\n')
    expect(merged).toContain('width: auto')
    expect(merged).toContain('border-right: 0')
  })
})
