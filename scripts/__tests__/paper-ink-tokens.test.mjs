import assert from 'node:assert/strict'
import { test } from 'vitest'
import { linkProblems, parseTokens } from '../brand/paper-ink-tokens.mjs'

const theme = (light, dark) => `.paper-ink {\n${light}\n}\n\n.paper-ink[data-theme="dark"],\n[data-theme="dark"] .paper-ink {\n${dark}\n}\n`

test('块里最后一条声明省略分号时照样读出', () => {
  const { dark } = parseTokens(theme('--frame: #EEEDE8; --danger-press: red;', '  --frame: #111113;\n  --danger-press: color-mix(in srgb, var(--danger) 80%, var(--frame))'))
  assert.deepEqual([...dark], [
    ['frame', '#111113'],
    ['danger-press', 'color-mix(in srgb, var(--danger) 80%, var(--frame))'],
  ])
})

test('深色块里相邻声明之间没有空白时两条都读出', () => {
  const { dark } = parseTokens(theme('--a: red; --b: blue;', '--a: red;--b: blue;'))
  assert.deepEqual([...dark], [['a', 'red'], ['b', 'blue']])
})

test('tokens.css 出现两条主题规则以外的块时报错', () => {
  assert.throws(() => parseTokens(theme('--a: red;', '--a: blue;') + '@media (min-width: 1px) { .paper-ink { --a: green; } }'), /只支持/)
})

test('带标题或尖括号的行内链接指向不存在的文件时报坏链接', () => {
  const doc = '[在](../assets/brand/pagekin-icon.svg "预览") [缺](../assets/brand/missing.svg "预览") [尖括号](<../assets/brand/gone.svg>)'
  assert.deepEqual(linkProblems(doc), ['链接到不存在的文件：../assets/brand/missing.svg', '链接到不存在的文件：../assets/brand/gone.svg'])
})

test('img src 指向不存在的文件时报坏链接', () => {
  assert.deepEqual(linkProblems('<img src="../gone.png" />'), ['链接到不存在的文件：../gone.png'])
})

test('出现引用式链接定义时直接失败', () => {
  assert.deepEqual(linkProblems('[x][id]\n\n  [id]: ../assets/brand/pagekin-icon.svg\n'), ['出现引用式链接定义，品牌文档请使用行内链接'])
})
