/* global process */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'vitest'
import { checkColorLiterals, findColorLiterals } from '../check-color-literals.mjs'

const script = fileURLToPath(new URL('../check-color-literals.mjs', import.meta.url))
const roots = []

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'color-literals-'))
  roots.push(root)
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

test('原语、外壳与沿用的旧组件目录写入色值时检查都失败', () => {
  const root = fixture({
    'src/components/ui/Fresh.tsx': "export const style = { color: '#2C4A8C' }\n",
    'src/components/stage/Spine.tsx': "const a = 'rgba(0, 0, 0, .5)'\nconst b = 'hsl(220 50% 40%)'\n",
    'src/styles/paper-ink/primitives.css': '.pi-x { background: #fff; }\n.pi-y { color: RGB(255, 0, 0); }\n',
    'src/components/editor/Old.tsx': "const c = '#123456'\n",
  })
  const { violations } = checkColorLiterals(root)
  assert.deepEqual(violations.map(({ file, line, literal }) => `${file}:${line}:${literal}`).sort(), [
    'src/components/editor/Old.tsx:1:#123456',
    'src/components/stage/Spine.tsx:1:rgba(',
    'src/components/stage/Spine.tsx:2:hsl(',
    'src/components/ui/Fresh.tsx:1:#2C4A8C',
    'src/styles/paper-ink/primitives.css:1:#fff',
    'src/styles/paper-ink/primitives.css:2:RGB(',
  ].sort())
})

test('令牌文件与测试文件不报错', () => {
  const root = fixture({
    'src/styles/paper-ink/tokens.css': '.paper-ink { --ink: #17171A; }\n',
    'src/components/ui/__tests__/Fresh.browser.tsx': "expect(color).toBe('rgb(23, 23, 26)')\n",
    'src/components/ui/Probe.browser.tsx': "const c = '#000'\n",
    'src/components/ui/Clean.tsx': "export const style = { color: 'var(--ink)' }\n",
  })
  assert.deepEqual(checkColorLiterals(root), { violations: [] })
})

test('注释、锚点、Issue 编号与 HTML 实体不算色值', () => {
  assert.deepEqual(findColorLiterals([
    '// 参见 #362，原色 #2C4A8C',
    '/* rgba(0,0,0,.1) */',
    "const href = '#section-1'",
    "const url = 'https://example.com/#fff'",
    "const entity = '&#123;'",
  ].join('\n')), [])
})

test('仓库当前状态通过检查，CLI 失败时退出码为 1 并写明令牌文件', () => {
  const pass = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true })
  assert.equal(pass.status, 0, pass.stderr)

  const root = fixture({ 'src/components/ui/Fresh.tsx': "const c = '#fff'\n", 'scripts/check-color-literals.mjs': fs.readFileSync(script, 'utf8') })
  const fail = spawnSync(process.execPath, [path.join(root, 'scripts/check-color-literals.mjs')], { encoding: 'utf8', windowsHide: true })
  assert.equal(fail.status, 1)
  assert.match(fail.stderr, /src\/components\/ui\/Fresh\.tsx:1 颜色字面量 #fff：改用 src\/styles\/paper-ink\/tokens\.css/u)
})

test('行注释只在字符串外才算：紧贴代码的 // 注释不误报，字符串里的 // 与 /* 之后的色值不漏报', () => {
  assert.deepEqual(findColorLiterals("const c = 'var(--danger)'// 原色 #B42318"), [])
  assert.deepEqual(findColorLiterals("const a = 'a // b', c = '#fff'"), [{ line: 1, literal: '#fff' }])
  assert.deepEqual(findColorLiterals("const glob = 'src/**', c = '#fff'\nconst d = '#000'"), [{ line: 1, literal: '#fff' }, { line: 2, literal: '#000' }])
})

test('CSS 里没有行注释：url(//…) 之后的色值照样报出', () => {
  const root = fixture({ 'src/components/stage/x.css': '.x { background: url(//cdn/a.png); color: #fff; }\n' })
  assert.deepEqual(checkColorLiterals(root).violations, [{ file: 'src/components/stage/x.css', line: 1, literal: '#fff' }])
})

test('经 junction 或符号链接运行时照样检查，有违规就退出 1', () => {
  const root = fixture({ 'src/components/ui/Fresh.tsx': "const c = '#fff'\n", 'scripts/check-color-literals.mjs': fs.readFileSync(script, 'utf8') })
  const link = path.join(os.tmpdir(), `color-literals-link-${process.pid}-${Date.now()}`)
  fs.symlinkSync(root, link, 'junction')
  try {
    const run = spawnSync(process.execPath, [path.join(link, 'scripts/check-color-literals.mjs')], { encoding: 'utf8', windowsHide: true })
    assert.equal(run.status, 1, run.stdout)
    assert.match(run.stderr, /src\/components\/ui\/Fresh\.tsx:1 颜色字面量 #fff/u)
  } finally {
    fs.rmSync(link, { recursive: false, force: true })
  }
})
