/**
 * 杂志层 CSS 卫生 —— 选择器里不许出现中文（node 环境）。
 *
 * 2026-09-17 一次极阴险的事故：`mag-pages.css` 里某条规则的收尾 `}` 后面
 * 粘了一截注释残骸，
 *
 *     }—— 先生拿着截图说：
 *
 * 于是**紧随其后那条规则的选择器被污染**，成了
 * `—— 先生拿着截图说： html[data-ui='v2'][data-mag] .v6shelf .spine { … }`。
 * 后果不是报错，而是：
 *   · 规则在源码里明明写着、grep 得到、构建也带进了 dist；
 *   · 却**永远不匹配任何元素** —— 书架书脊的兜底宽度（`width: auto`）整个失效，
 *     于是书脊落回 v2 基座的 `.spine { width: var(--w-spine) }`，
 *     而 v3 把 `--w-spine` 提到 94px —— 书全被撑成「大胖子」。
 *
 * 这条陷阱用眼睛查不出来（文件看着好端端的），所以钉成契约：
 * **去掉注释之后，任何选择器里都不许出现中日韩字符。**
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const magazineDir = resolve(process.cwd(), 'src/styles/magazine')
const files = readdirSync(magazineDir).filter((name) => name.endsWith('.css'))

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/

/** 去注释（保留换行），返回正文。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => '\n'.repeat((match.match(/\n/g) ?? []).length))
}

/** 抽出所有「{ 之前的那段」——也就是选择器，检查里面有没有中文。 */
function selectorsWithCjk(css: string): string[] {
  const found: string[] = []
  const body = stripComments(css)
  let index = 0
  while (index < body.length) {
    const brace = body.indexOf('{', index)
    if (brace < 0) break
    const selector = body.slice(index, brace)
    if (CJK.test(selector)) {
      const line = body.slice(0, brace).split('\n').length
      found.push(`第 ${line} 行：${selector.trim().split('\n').slice(-2).join(' ').slice(-90)}`)
    }
    let depth = 1
    let cursor = brace + 1
    while (cursor < body.length && depth > 0) {
      if (body[cursor] === '{') depth += 1
      else if (body[cursor] === '}') depth -= 1
      cursor += 1
    }
    index = cursor
  }
  return found
}

describe('杂志层 CSS 卫生', () => {
  it('选择器里没有中文（残骸会把整条规则变成永不匹配）', () => {
    const problems = files.flatMap((name) =>
      selectorsWithCjk(readFileSync(resolve(magazineDir, name), 'utf8')).map(
        (detail) => `${name} ${detail}`,
      ),
    )
    expect(problems).toEqual([])
  })

  it('注释都成对（未闭合的注释会把后面的规则整段吃掉）', () => {
    for (const name of files) {
      const body = stripComments(readFileSync(resolve(magazineDir, name), 'utf8'))
      expect(body.includes('/*'), `${name} 里有未闭合的注释`).toBe(false)
    }
  })

  it('书架的兜底规则仍在：书脊宽度跟着书走，不吃导航的 --w-spine', () => {
    const pages = stripComments(readFileSync(resolve(magazineDir, 'mag-pages.css'), 'utf8'))
    const rule = pages.match(
      /html\[data-ui='v2'\]\[data-mag\]\s*\.v6shelf \.spine\s*\{([^}]*)\}/,
    )?.[1]
    expect(rule, '书架的 .v6shelf .spine 兜底规则不见了').toBeTruthy()
    expect(rule).toContain('width: auto')
  })

  /**
   * 第十五轮的教训 —— **子串匹配的类属性选择器会误伤邻居**。
   *
   * `mag-pages.css` 里曾经有这样一条「选中态」规则：
   *
   *     .ws-category-item[class*='bg-['] { background: var(--mag-active-sec) }
   *
   * `[class*=]` 是子串匹配，而**每一个未选中**的分类条目 className 里都带着
   * `hover:bg-[var(--color-hover)]` —— 子串 `bg-[` 命中，于是整排条目被染成
   * 实心的当前栏目色，先生说的「平时是白色」从未成立过。
   * 选中态现在走语义类（`.ws-category-item-on`），不再靠猜 Tailwind 类名。
   */
  it('杂志层不许用 [class*=bg-…] 子串去匹背景类（会误伤未选中项）', () => {
    const offenders: string[] = []
    for (const name of files) {
      const body = stripComments(readFileSync(resolve(magazineDir, name), 'utf8'))
      /**
       * 只盯**背景类**的子串选择器 —— `[class*='text-[0.65rem]']`、`[class*='rounded-md']`
       * 这类既有的尺寸/圆角匹配不在其列（它们不会因为「未选中项也带着 hover:bg-」而误伤）。
       */
      for (const match of body.matchAll(/\[class\*=[^\]]*bg-/g)) {
        const line = body.slice(0, match.index).split('\n').length
        offenders.push(`${name}:${line} ${match[0].trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('设定分类的选中态是语义类，不是 Tailwind 类名', () => {
    const pages = stripComments(readFileSync(resolve(magazineDir, 'mag-pages.css'), 'utf8'))
    expect(pages).toContain('.ws-category-item-on')
    expect(pages).toContain('var(--mag-active-sec')
  })
})
