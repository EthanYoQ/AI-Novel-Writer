/** Verify that Cordis loads the emitted Host entry and Harness discovers the shipped preset. */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import yaml from 'js-yaml'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
for (const packagedLicenseFile of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await readFile(join(root, packagedLicenseFile), 'utf8')
  if (!manifest.files.includes(packagedLicenseFile)) {
    throw new Error(`${packagedLicenseFile} must be declared in package files`)
  }
}
const clientSource = await readFile(join(root, 'lib', 'client.js'), 'utf8')
if (!clientSource.includes('pluginCss') || !clientSource.includes('aiNovelContextDrawer')) {
  throw new Error('The emitted Client entry must carry its owned context-window styles')
}
if (/require\(["']\.\/style\.css["']\)/.test(clientSource)) {
  throw new Error('The emitted Client entry must not depend on a separately loaded stylesheet')
}
let clientHandoff
runInNewContext(clientSource, {
  window: { __ModuleLoader__: { load: handoff => { clientHandoff = handoff } } },
})
if (clientHandoff?.id !== manifest.name || typeof clientHandoff.factory !== 'function') {
  throw new Error('The emitted Client entry did not register its declared package id')
}
const clientModules = new Map([
  ['react', await import('react')],
  ['react/jsx-runtime', await import('react/jsx-runtime')],
  ['react-dom', await import('react-dom')],
  ['@deepseek-ai/dsh-client-ui-primitives', { IconListPenOutline16: () => null }],
])
const clientExports = clientHandoff.factory(specifier => {
  if (!clientModules.has(specifier)) throw new Error(`Unexpected emitted Client external: ${specifier}`)
  return clientModules.get(specifier)
})
if (typeof clientExports.apply !== 'function' || 'default' in clientExports) {
  throw new Error('The emitted Client factory must return named apply without a default export')
}
const patchPath = join(root, manifest.dsh.bundle.patch)
const patches = yaml.load(await readFile(patchPath, 'utf8'), { schema: entryListSchema })
if (!Array.isArray(patches)) throw new TypeError(`${patchPath} must contain a YAML list`)

const host = new Context()
host.baseUrl = pathToFileURL(root).href + '/'
let setupRegistered = false
host.provide('connection', {
  rpc: {
    handle(channel, _handler, options) {
      if (channel !== '/ai-novel' || options.authority !== 'loopback') {
        throw new Error('The emitted Host entry registered an unexpected setup channel')
      }
      setupRegistered = true
      return async () => {}
    },
  },
})
host.provide('workspaceRegistry', { get: () => undefined })
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
  if (!setupRegistered) throw new Error('The emitted Host entry did not register its loopback setup channel')
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
