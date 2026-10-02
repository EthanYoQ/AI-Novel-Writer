/**
 * V3 刊标「圆角框体里的双页 W」—— 源码契约（node 环境）。
 *
 * 先生的两次定稿：
 *   ① 六款候选里挑 NO.02：「双页 W —— 两页对折的纸并立成 W」；
 *   ② 看到裸线稿之后：「你的给我一个圆角框体框起来，才像 logo 啊，现在这样很难看。
 *      而且我要，朱砂变色，但是现在不是。」
 *
 * 所以这条契约钉五件事：
 *   ① 圆角框体在（rx 圆角方形 + 朱砂实底）—— 没有框体就不像「标」；
 *   ② 框体**恒为朱砂**，且**不再引用 `--mag-sec`**（品牌色不跟栏目换色，这是先生纠正过的那一条）；
 *   ③ 几何就是选中的那一版（框内水平居中的两条折线，后页细、前页粗）；
 *   ④ v3 走 MagLogo、v2 仍走原来的印章图，分支都在；
 *   ⑤ 老的「朱砂书脊块 + 竖排作字」已经撤掉，别又冒出来。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8')

const magLogo = read('src/components/layout/v2/magazine/MagLogo.tsx')
const titleBar = read('src/components/layout/v2/TitleBarV2.tsx')
const welcome = read('src/components/pages/v2/WelcomePageV2.tsx')
const shellCss = read('src/styles/magazine/mag-shell.css')
const surfacesCss = read('src/styles/magazine/mag-surfaces.css')

describe('刊标 · 圆角框体', () => {
  it('有圆角方形框体，且是朱砂实底', () => {
    expect(magLogo).toMatch(/<rect[\s\S]*?rx="9\.5"/)
    /* ⚠ 颜色走 style，不走属性 —— SVG 的 presentation attribute 不解析 `var()`。
       先生实测那一版「框是黑的、不是朱砂」，根因就是写成了 fill="var(--…)"。 */
    expect(magLogo).toMatch(/style=\{\{\s*fill:\s*'var\(--mag-brand-seal, #C8564A\)'\s*\}\}/)
    /* 同样只看代码：注释里为记事写着那条会失效的写法 */
    const codeOnly = magLogo.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(codeOnly.includes('fill="var(')).toBe(false)
  })

  it('品牌色恒为朱砂 —— 不再跟着栏目色跑（先生纠正过的那一条）', () => {
    /* 只看代码，不看注释：文件头注释里为记事提到过旧的 --mag-sec 写法 */
    const codeOnly = magLogo.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(codeOnly.includes('--mag-sec')).toBe(false)
    expect(codeOnly).toContain('var(--mag-brand-seal, #C8564A)')
  })

  it('框内两笔是白色：后页灰白细、前页纯白粗', () => {
    expect(magLogo).toContain('stroke="#FFFFFF"')
    expect(magLogo).toContain('strokeOpacity="0.55"')
    expect(magLogo).toContain('strokeWidth="1.5"')
    expect(magLogo).toContain('strokeWidth="2.2"')
  })
})

describe('刊标 · 几何', () => {
  it('两条折线在框内水平居中（中心 x=20、y=20）', () => {
    expect(magLogo).toContain('d="M10 11 L14.5 29 L19 11"')
    expect(magLogo).toContain('d="M21 11 L25.5 29 L30 11"')
  })

  it('40×40 视框 —— 缩到 16px 仍立得住', () => {
    expect(magLogo).toContain('viewBox="0 0 40 40"')
  })
})

describe('刊标 · 接进界面的位置', () => {
  it('刊头：v3 出 MagLogo，v2 仍是最初的印章图', () => {
    expect(titleBar).toMatch(/magazine\s*\?\s*<MagLogo[^>]*\/>\s*:\s*<img src=\{BRAND_SEAL_URL\}/)
  })

  it('首页 Hero：同样分家', () => {
    expect(welcome).toMatch(/isMagazine\(uiVersion\)\s*\?\s*<MagLogo[^>]*\/>\s*:\s*<img src=\{BRAND_SEAL_LARGE_URL\}/)
  })

  it('两处都用 isMagazine 判断，而不是各自另起一套开关', () => {
    for (const [name, source] of [['TitleBarV2', titleBar], ['WelcomePageV2', welcome]]) {
      expect(source.includes('isMagazine'), `${name} 没走统一的版本开关`).toBe(true)
    }
  })
})

describe('刊标 · 老的朱砂块已经撤掉', () => {
  it('刊头：不再有竖长朱砂块、装饰细带与竖排「作」字', () => {
    expect(shellCss).toMatch(/\.sealmark::before,\s*\n?[^}]*\.sealmark::after \{\s*\n?\s*content: none/)
    expect(shellCss.includes("content: '作'")).toBe(false)
  })

  it('首页：不再是竖长朱砂块 + 竖排刊名', () => {
    expect(surfacesCss).toMatch(/\.shlogo::after \{\s*\n?\s*content: none/)
    expect(surfacesCss.includes("content: 'AI小说作家'")).toBe(false)
  })
})
