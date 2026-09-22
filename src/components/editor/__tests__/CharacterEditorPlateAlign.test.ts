/**
 * 人物档案页的「页面排列」与其它子菜单看齐 —— 源码契约（node 环境）。
 *
 * 先生：「人物档案 / 当前状态 / 关系图谱 / 删除 / 编辑档案，这几个按钮往左边移动……
 *        不对！是人物档案这里的页面排列没有和设定集，剧情树与伏笔看齐的原因！」
 *
 * 查证：**他后一句才是真话**。设定集、剧情树与伏笔的页头都住在
 * `.pagehead-strip` 里（版心 1080px、左缘内距 36px、上留白 30px）；
 * 而人物档案的 v3 铭牌（`CharacterProfilePlate`）**直接躺在滚动栏里** ——
 * 少了那 36px 内距，整块比别的页头往左偏一格。缺的不是「往哪个方向挪」，
 * 是**住的容器不一样**。
 *
 * 这条契约钉住三件事：人物档案的铭牌住进同一个容器、v2 老路径不动、
 * 对齐基准（设定集 / 剧情树与伏笔）确实也用这个容器。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(resolve(process.cwd(), relative), 'utf8')

const characterEditor = read('src/components/editor/CharacterEditor.tsx')
const worldSetting = read('src/components/editor/WorldSettingEditor.tsx')
const narrativeThread = read('src/components/editor/NarrativeThreadEditor.tsx')

describe('人物档案页 · 页头容器', () => {
  it('v3 铭牌住在 .pagehead-strip 里（与其它子菜单同一容器）', () => {
    expect(characterEditor).toMatch(
      /<div className="pagehead-strip">\s*<CharacterProfilePlate/,
    )
  })

  it('v2 那条路径原样保留（老页头仍是 .pagehead-strip + .pagehead）', () => {
    expect(characterEditor).toMatch(
      /<div className="pagehead-strip">\s*<div className="pagehead">/,
    )
  })

  it('对齐基准：设定集 / 剧情树与伏笔的页头也用同一个容器', () => {
    for (const [name, source] of [
      ['设定集 WorldSettingEditor', worldSetting],
      ['剧情树与伏笔 NarrativeThreadEditor', narrativeThread],
    ]) {
      expect(source.includes('className="pagehead-strip"'), `${name} 没用 .pagehead-strip`).toBe(true)
    }
  })
})
