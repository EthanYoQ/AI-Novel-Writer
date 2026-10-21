import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { it } from 'vitest'
import { assertNodeRunsTypeScript } from '../node-version.mjs'

const hint = version => `驱动脚本直接 import 应用里的 .ts，需要 Node 自带的类型剥离（Node 22.18、23.6 起默认开启，不能用 --no-experimental-strip-types 关掉），当前 ${version} 没有开启。可以用 fnm exec --using=22.23.1 -- node scripts/redesign/drive.mjs …`

it('Node 开着类型剥离时驱动照常运行', () => {
  for (const version of ['v22.18.0', 'v22.23.1', 'v23.6.0', 'v26.7.0']) assert.doesNotThrow(() => assertNodeRunsTypeScript(version, 'strip'))
})

it('类型剥离不可用时报清楚要什么、当前是哪个、怎么换：旧 Node，或新 Node 显式关掉', () => {
  for (const version of ['v20.19.0', 'v22.17.1', 'v26.7.0']) assert.throws(() => assertNodeRunsTypeScript(version, false), { message: hint(version) })
  assert.throws(() => assertNodeRunsTypeScript('v22.9.0', undefined), { message: hint('v22.9.0') })
})

it('关掉类型剥离再跑驱动：在加载场景之前就给出这句提示，不是 ERR_UNKNOWN_FILE_EXTENSION', () => {
  const result = spawnSync(process.execPath, ['--no-experimental-strip-types', 'scripts/redesign/drive.mjs', '--scenario', 'stage-reopen'], { encoding: 'utf8' })
  assert.deepEqual({ status: result.status, stderr: result.stderr }, { status: 2, stderr: `${hint(process.version)}\n` })
})

it('关掉类型剥离时 vitest 照样能导入驱动跑它的单测：守卫只在作为入口运行时检查', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'NODE_OPTIONS'))
  const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'scripts/redesign/__tests__/drive-args.test.mjs'],
    { encoding: 'utf8', env: { ...env, NODE_OPTIONS: '--no-experimental-strip-types' } })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
}, 120_000)
