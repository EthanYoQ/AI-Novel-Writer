import assert from 'node:assert/strict'
import { test } from 'vitest'
import { brokenLinks, declarations } from '../brand/paper-ink-tokens.mjs'

test('块里最后一条声明省略分号时照样读出', () => {
  const tokens = declarations('.paper-ink[data-theme="dark"] {\n  --frame: #111113;\n  --danger-press: color-mix(in srgb, var(--danger) 80%, var(--frame))\n}')
  assert.deepEqual([...tokens], [
    ['frame', '#111113'],
    ['danger-press', 'color-mix(in srgb, var(--danger) 80%, var(--frame))'],
  ])
})

test('带标题的链接指向不存在的文件时报坏链接', () => {
  const doc = '[在](../assets/brand/pagekin-icon.svg "预览") [缺](../assets/brand/missing.svg "预览") [尖括号](<../assets/brand/gone.svg>)'
  assert.deepEqual(brokenLinks(doc), ['../assets/brand/missing.svg', '../assets/brand/gone.svg'])
})

test('相邻声明之间没有空白时两条都读出', () => {
  assert.deepEqual([...declarations('.paper-ink{--a:1px;--b:2px;}')], [['a', '1px'], ['b', '2px']])
})

test('href、单引号 src 和引用式链接指向不存在的文件时报坏链接', () => {
  const doc = "<a href=\"../gone-a.md\">a</a> <img src='../gone-b.png' />\n\n[ref]: ../gone-c.svg\n"
  assert.deepEqual(brokenLinks(doc), ['../gone-a.md', '../gone-b.png', '../gone-c.svg'])
})
