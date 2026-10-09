import path from 'node:path'
import vm from 'node:vm'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'
import * as pure from '../../../src/services/builtin-prompt-templates'
import { BUILTIN_PROMPTS as facadePrompts, getBuiltinPromptTemplate as facadeGetter } from '../../../src/services/prompt-templates'

describe('builtin prompts main-process import boundary', () => {
  it('executes the bundled pure module without renderer globals, IPC, stores or runtime imports', () => {
    const bundle = buildSync({ entryPoints: [path.resolve('src/services/builtin-prompt-templates.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true })
    const forbiddenInputs = Object.keys(bundle.metafile!.inputs).filter(file => /(?:ipc-client|prompt-catalog|\/stores\/|project-session-context)/u.test(file.replaceAll('\\', '/')))
    expect(forbiddenInputs).toEqual([])
    const module = { exports: {} as typeof pure }
    const sandbox: Record<string, unknown> = { module, exports: module.exports, require: () => { throw new Error('Unexpected runtime import') } }
    for (const name of ['window', 'document', 'localStorage', 'sessionStorage', 'fetch']) {
      Object.defineProperty(sandbox, name, { get: () => { throw new Error(`Unexpected renderer dependency: ${name}`) } })
    }
    vm.runInNewContext(bundle.outputFiles[0].text, sandbox, { timeout: 1000 })
    for (const template of pure.BUILTIN_PROMPTS) {
      for (const language of ['zh-CN', 'en-US'] as const) {
        expect(JSON.stringify(module.exports.getBuiltinPromptTemplate(template.key, language))).toBe(JSON.stringify(pure.getBuiltinPromptTemplate(template.key, language)))
      }
    }
  })
  it('keeps the renderer facade on the identical builtin objects and getter', () => {
    expect(facadePrompts).toBe(pure.BUILTIN_PROMPTS)
    expect(facadeGetter).toBe(pure.getBuiltinPromptTemplate)
    expect(new Set(pure.BUILTIN_PROMPTS.map(template => template.key)).size).toBe(pure.BUILTIN_PROMPTS.length)
  })
})