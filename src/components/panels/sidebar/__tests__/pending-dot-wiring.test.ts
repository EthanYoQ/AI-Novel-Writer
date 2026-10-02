/**
 * 小红点的「接线契约」—— 每一处入口都必须成套出现三件事。
 *
 * 为什么要有这份测试：红点最容易出的错不是逻辑，而是**接线漏一半**，而且
 * 漏的时候界面不会报错，只是「红点永远不灭」或者「永远不亮」—— 作者得用几天
 * 才发觉。三件事是：
 *   ① `usePendingUnread(...)` —— 拿到 unread 与 markSeen；
 *   ② 打开那个队列的**同一个动作**里调 `markSeen()` —— 否则点开了红点也不灭；
 *   ③ 入口里渲染 `<PendingDot />` —— 否则水位记得再准也看不见。
 *
 * 缺任何一件，这套机制就是坏的。所以这里按源码逐个文件核对，
 * 而不是只测其中一处组件（组件级行为另有 CharactersView / StickyNotesGroup 两份浏览器测试）。
 *
 * 加新入口时：把它加进 ENTRY_FILES，三件事照抄即可 —— 测试会替你检查有没有漏。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ENTRY_FILES = [
  'src/components/panels/sidebar/CharactersView.tsx',
  'src/components/panels/sidebar/WorldSettingSidebarPanel.tsx',
  'src/components/panels/sidebar/StickyNotesGroup.tsx',
] as const

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('待确认小红点的接线契约', () => {
  it.each(ENTRY_FILES)('%s：hook、记号、红点三件齐全', (file) => {
    const content = source(file)

    expect(content, '必须用 usePendingUnread 拿水位').toContain('usePendingUnread')
    expect(content, '必须定义 markSeen（打开队列时的记号动作）').toMatch(/markSeen:\s*\w+/)
    expect(content, '必须真的渲染红点组件').toMatch(/<PendingDot\b/)
    expect(content, '必须 import 红点组件').toMatch(/import PendingDot from '\.\.\/\.\.\/ui\/PendingDot'/)
    expect(content, '必须 import 水位 store').toMatch(/from '\.\.\/\.\.\/\.\.\/stores\/pending-badge-store'/)
  })

  it.each(ENTRY_FILES)('%s：markSeen 必须在「打开队列」的那一下调用，而不是渲染时', (file) => {
    const content = source(file)
    // 记号函数的实际调用点：`markXxxSeen()` 必须出现
    const calls = content.match(/mark\w*Seen\(\)/gu) ?? []
    expect(calls.length, '至少调一次 —— 否则红点永远不灭').toBeGreaterThan(0)
    // 绝不允许在渲染期顺手记一笔（那会让红点刚亮就灭，等于没有）
    expect(content, '不许把 markSeen 塞进 useEffect 里自动跑').not.toMatch(/useEffect\([^)]*mark\w*Seen/gu)
  })

  it('红点组件本身是绝对定位的（不参与布局，才不会挤掉侧栏标题）', () => {
    const dot = source('src/components/ui/PendingDot.tsx')
    expect(dot).toContain('absolute')
    expect(dot).toContain('var(--color-accent)')
    expect(dot, '取不到侧栏底色时退化成不描边，而不是画一圈黑边').toContain('var(--color-sidebar, transparent)')
  })
})
