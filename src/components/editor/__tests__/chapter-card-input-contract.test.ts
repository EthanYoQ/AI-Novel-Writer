/**
 * 章节蓝图的输入与可用性契约（源码静态断言）。
 *
 * 这些约束在截图上看不出来，却直接决定作者能不能把一张蓝图填完：
 *   · 出场人物必须绑定**作者敲下的原文** —— 绑定 join 结果会让分隔符当场被吃掉；
 *   · 主干字段必须标出必填，且与「未就绪」判据共用同一份定义；
 *   · 章节目录的宽度必须可以由作者拖出来；
 *   · 草稿行的删除按钮必须有自己的悬停态（否则整行 hover 的亮底会把它吞掉）。
 *
 * 组件本身跑在浏览器环境（见 ChapterCardEditor.write-entry.browser.tsx），
 * 这里守住的是在 node 环境也能验证的那部分。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const editorSource = readFileSync('src/components/editor/ChapterCardEditor.tsx', 'utf8')

describe('章节蓝图：出场人物输入', () => {
  it('输入框绑定作者原文，而不是名单的 join 结果', () => {
    // 旧实现：value 由 selected.characters.join('、') 生成，同时 onChange 立刻 split。
    // 结果是刚敲下的顿号当场被 filter 掉、光标被推到末尾、下一个名字与前一个黏成一串
    // —— 作者既打不出标点，也没法选中复制。
    expect(editorSource).not.toMatch(/value=\{selected\.characters\.join/)
    expect(editorSource).toContain('value={charactersText}')
    expect(editorSource).toContain('setCharactersText(e.target.value)')
  })

  it('解析规则接受顿号、逗号、分号与空白', () => {
    expect(editorSource).toContain('value.split(/[、，,;；\\s]+/).filter(Boolean)')
  })

  it('外部名单变化时才回填输入框（作者原文不被覆盖）', () => {
    // 判据必须是「解析结果是否与名单一致」：一致就跳过回填。
    expect(editorSource).toContain('const current = splitCharacterNames(charactersText)')
    expect(editorSource).toContain('current.every((name, index) => name === next[index])')
  })
})

describe('章节蓝图：必填标注与就绪判据', () => {
  it('四个主干字段都带必填标记，选填字段带选填标记', () => {
    for (const label of ['章节标题', '主角小目标', '实质冲突与转折', '末尾悬念钩子']) {
      expect(editorSource).toContain(label)
    }
    expect(editorSource).toContain('className="req"')
    expect(editorSource).toContain('className="opt"')
  })

  it('「未就绪」徽标列出缺项，与标记共用同一份判据', () => {
    expect(editorSource).toContain('selectedCardReady')
    expect(editorSource).toContain('missingReadyFields')
  })

  it('章节号与「本章引用的设定」也各有交代', () => {
    // 章节号是自动分配的只读值：标「必填」（它确实必须存在）并说明无需手填，
    // 免得作者对着一个改不动的框猜「这到底要不要我填」。
    expect(editorSource).toContain('系统按定稿进度自动分配')
    const refsSource = readFileSync('src/components/editor/ChapterWorldSettingRefs.tsx', 'utf8')
    expect(refsSource).toContain('className="opt"')
  })
})

describe('章节蓝图：目录可拖拽', () => {
  it('目录宽度由作者决定，并记住上次取值', () => {
    expect(editorSource).toContain('GripHandle')
    expect(editorSource).toContain('width: catalogWidth')
    expect(editorSource).toContain('CATALOG_WIDTH_MIN')
    expect(editorSource).toContain('CATALOG_WIDTH_MAX')
    expect(editorSource).toContain('CATALOG_WIDTH_STORAGE_KEY')
  })
})

describe('侧栏草稿行：删除按钮的悬停态', () => {
  it('删除按钮有自己的悬停颜色，不只改透明度', () => {
    const draftSource = readFileSync('src/components/panels/sidebar/DraftBoxGroup.tsx', 'utf8')
    expect(draftSource).toContain('className="draft-trash"')
    // 旧的 opacity-70 hover:opacity-100 + 固定浅灰，在亮起来的整行底上等于隐形。
    expect(draftSource).not.toContain('opacity-70 hover:opacity-100 rounded')

    const shellCss = readFileSync('src/styles/redesign/shell.css', 'utf8')
    expect(shellCss).toContain('.draft-trash:hover')
    expect(shellCss).toContain('--color-error-text')
  })
})
