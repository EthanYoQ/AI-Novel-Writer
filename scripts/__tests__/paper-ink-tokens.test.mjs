import assert from 'node:assert/strict'
import { test } from 'vitest'
import { declarations } from '../brand/paper-ink-tokens.mjs'

test('块里最后一条声明省略分号时照样读出', () => {
  const tokens = declarations('.paper-ink[data-theme="dark"] {\n  --frame: #111113;\n  --danger-press: color-mix(in srgb, var(--danger) 80%, var(--frame))\n}')
  assert.deepEqual([...tokens], [
    ['frame', '#111113'],
    ['danger-press', 'color-mix(in srgb, var(--danger) 80%, var(--frame))'],
  ])
})
