import assert from 'node:assert/strict'
import { it } from 'vitest'

import { versionItemText, versionSwitcherName } from '../pages/stage.mjs'

it('版本切换按钮按 v 号整体认：v1 不认成 v10、v11', () => {
  assert.equal(versionSwitcherName(1).test('本章版本：草稿 v1 · 120 字'), true)
  assert.equal(versionSwitcherName(2).test('本章版本：修稿已合并 v2 · 1,024 字'), true)
  assert.equal(versionSwitcherName(1).test('本章版本：草稿 v10 · 120 字'), false)
  assert.equal(versionSwitcherName(1).test('本章版本：修稿已合并 v11 · 120 字'), false)
  assert.equal(versionSwitcherName(1).test('本章版本：定稿 · 120 字'), false)
})

it('版本菜单项按第一段的版本名认，后面紧跟的字数不会把 v1 读成 v1120', () => {
  assert.equal(versionItemText(1).test('草稿 v1'), true)
  assert.equal(versionItemText(1).test('草稿 v1 · 当前'), true)
  assert.equal(versionItemText(2).test('修稿已合并 v2 · 当前'), true)
  assert.equal(versionItemText(1).test('草稿 v10'), false)
  assert.equal(versionItemText(1).test('草稿 v1120 字 · 10/17 19:00'), false)
})
