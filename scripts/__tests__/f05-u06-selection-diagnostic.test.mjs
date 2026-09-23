/* global process */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'

const driver = fileURLToPath(new URL('../f05-u06-editor-journey.mjs', import.meta.url))

test('selection diagnostic rejects qualification and older diagnostic flags together', () => {
  const run = spawnSync(process.execPath, [driver, '--historical-classic', '--selection-diagnostic', '--phase-diagnostic'],
    { encoding: 'utf8', windowsHide: true })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /selection diagnostic cannot combine with phase diagnostic/u)
})
