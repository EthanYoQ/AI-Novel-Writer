/** Verify that Cordis loads the emitted Host entry and Harness discovers the shipped preset. */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import yaml from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const patchPath = join(root, manifest.dsh.bundle.patch)
const patches = yaml.load(await readFile(patchPath, 'utf8'), { schema: entryListSchema })
if (!Array.isArray(patches)) throw new TypeError(`${patchPath} must contain a YAML list`)

const host = new Context()
host.baseUrl = pathToFileURL(root).href + '/'
await host.plugin(Loader)
host.loader.builtins.include = Include
const builtModule = await import(pathToFileURL(join(root, manifest.main)).href)
if ('default' in builtModule) throw new Error('The emitted Host entry must not add a default export')
const unwrapped = host.loader.unwrapExports(builtModule)
if (unwrapped !== builtModule || unwrapped.name !== 'dsh-ai-novel-writer' || typeof unwrapped.apply !== 'function') {
  throw new Error('Loader export unwrapping did not preserve the emitted Host plugin')
}

try {
  await host.loader.create({
    name: 'cordis:include',
    config: {
      path: pathToFileURL(join(root, 'tests', 'fixtures', 'empty.cordis.yml')).href,
      patches,
    },
  })
  await host.loader.await()
  const entry = [...host.loader.entries()].find(candidate => candidate.options.id === 'ai-novel-writer')
  if (entry?.fiber === undefined) throw new Error('Cordis Loader did not mount the emitted Host entry')
} finally {
  await host.fiber.dispose()
}

const roster = new Context()
roster.baseUrl = pathToFileURL(root).href + '/'
await roster.plugin(Loader)
roster.loader.builtins.include = Include
await roster.plugin(AgentPresets, {
  default: 'ai-novel-writer',
  roots: [{ path: join(root, 'presets'), trust: 'system' }],
  includeUserRoot: false,
})

try {
  const preset = (await roster.agentPresets.list()).find(candidate => candidate.id === 'ai-novel-writer')
  if (preset === undefined || preset.broken !== undefined || preset.name !== 'AI 小说作家') {
    throw new Error(`Harness did not discover a usable AI novel preset: ${JSON.stringify(preset)}`)
  }
} finally {
  await roster.fiber.dispose()
}
