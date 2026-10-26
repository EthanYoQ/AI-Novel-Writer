import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODEL_STAGE_BY_OPERATION, stageOfOperation, type GenerationOperation, type ModelStage } from '../model-stage-routing'

const root = process.cwd()
const TABLE_FILE = 'src/shared/model-stage-routing.ts'

function sourcePaths(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourcePaths(path)
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec|browser)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

// 源码在模块加载时只读一遍，各条用例只做内存匹配：并行套件里同一批读取会从约 200ms 拉长到 9 秒，放在用例里会撞 5 秒超时。
const SOURCES = new Map([...sourcePaths('src'), ...sourcePaths('electron')].map(file => [file, readFileSync(resolve(root, file), 'utf8')]))
const sourceFiles = (dir: string) => [...SOURCES.keys()].filter(file => file.startsWith(`${dir}/`))
const read = (file: string) => SOURCES.get(file)!
const families = Object.keys(MODEL_STAGE_BY_OPERATION)
const OPERATION_LITERAL = /:\s*(['"`])([a-z][a-z0-9:-]*)\1/g
const sentOperations = (text: string) => [
  ...[...text.matchAll(/\boperation:\s*(['"`])([a-z][a-z0-9:-]*)\1/g)].map(match => match[2]),
  ...[...text.matchAll(/=\s*\{([^}]*)\}\s*as const satisfies Record<\w+, GenerationOperation>/g)]
    .flatMap(table => [...table[1].matchAll(OPERATION_LITERAL)].map(match => match[2])),
]

describe('operation stage registry coverage', () => {
  it('sees operations that commands pick from a typed operation table', () => {
    expect(sentOperations(read('src/services/workflows/commands/generate-field.command.ts'))).toEqual(expect.arrayContaining([
      'generate-field:core-outline', 'generate-field:world-setting', 'generate-field:golden-finger',
      'generate-field:protagonist-profile', 'generate-field:global-guidance', 'generate-field:writing-style',
    ]))
  })

  it('registers every operation that generation code sends', () => {
    // 不是生成 operation：source-draft-changed.ts 用它们区分提示文案。
    const notGeneration = new Set(['refine', 'review'])
    const unregistered = [...sourceFiles('src/services'), ...sourceFiles('electron/services')].flatMap(file =>
      sentOperations(read(file))
        .filter(operation => !notGeneration.has(operation) && !families.includes(operation.split(':')[0]))
        .map(operation => `${file}: ${operation}`))
    expect(unregistered, '新的生成 operation 要先登记到 src/shared/model-stage-routing.ts').toEqual([])
  })

  it('keeps no table entry that no source file uses any more', () => {
    const corpus = [...SOURCES].filter(([file]) => file !== TABLE_FILE).map(([, text]) => text).join('\n')
    const unused = families.filter(family => family === 'generate-field'
      ? !/['"`]generate-field:/.test(corpus)
      : !corpus.includes(`'${family}'`) && !corpus.includes(`"${family}"`))
    expect(unused).toEqual([])
  })
})

/**
 * 接缝在工作流首次开跑时钉住模型，同一工作流后面的步骤沿用它。
 * 所以一个工作流定义里只能有一个环节的 operation，否则后面的环节会悄悄用前一个环节的模型。
 */
describe('one stage per workflow definition', () => {
  const COMMANDS_DIR = 'src/services/workflows/commands'
  const commandSources = new Map<string, string>()
  for (const file of sourceFiles(COMMANDS_DIR)) {
    const text = read(file)
    const classes = [...text.matchAll(/export class (\w+Command) extends/g)]
    classes.forEach((match, index) => {
      const body = text.slice(match.index, classes[index + 1]?.index ?? text.length)
      commandSources.set(match[1], classes.length === 1 ? text : body)
    })
  }
  const operationStages = (text: string) => new Set<ModelStage>(families
    .filter(family => text.includes(`'${family}${family === 'generate-field' ? ':' : "'"}`))
    .map(family => stageOfOperation((family === 'generate-field' ? 'generate-field:x' : family) as GenerationOperation)))
  const commandStages = (name: string, seen = new Set<string>()): Set<ModelStage> => {
    if (seen.has(name)) return new Set()
    seen.add(name)
    const body = commandSources.get(name) ?? ''
    const nested = [...body.matchAll(/\b(\w+Command)\b/g)].map(match => match[1]).filter(other => other !== name && commandSources.has(other))
    return new Set([...operationStages(body), ...nested.flatMap(other => [...commandStages(other, seen)])])
  }

  function workflowDefinitionClosures(file: string): Map<string, string> {
    const text = read(file)
    const starts = [...text.matchAll(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+) =/gm)]
    const segments = new Map(starts.map((match, index) => [match[1] ?? match[2], text.slice(match.index, starts[index + 1]?.index ?? text.length)]))
    const closure = (name: string, seen: Set<string>): string => {
      if (seen.has(name)) return ''
      seen.add(name)
      const body = segments.get(name) ?? ''
      return body + [...segments.keys()].filter(other => other !== name && new RegExp(`\\b${other}\\b`).test(body)).map(other => closure(other, seen)).join('\n')
    }
    return new Map([...segments.keys()].filter(name => /^create\w+Workflow$|^migrateLegacyCharacterRoster$/.test(name)).map(name => [name, closure(name, new Set())]))
  }

  const MIXED_BY_DESIGN: Record<string, string> = {
    createBatchChapterWorkflow: '批量写作强制显式模型，自动定稿由主进程按写稿运行的模型继承',
    createImportWorkflow: '导入首跑冻结模型，导入里的定稿后处理沿用导入模型',
    createReviewRevisionRecoveryWorkflow: '恢复只运行其中一个命令，模型取自冻结的恢复记录',
  }

  const workflowFiles = sourceFiles('src/services/workflows').filter(file => /^src\/services\/workflows\/[^/]+-workflow\.ts$/.test(file))
  const definitions = workflowFiles.flatMap(file => [...workflowDefinitionClosures(file)].map(([name, text]) => ({ file, name, text })))
  const stagesOf = (text: string) => new Set([...text.matchAll(/\b(\w+Command)\b/g)].flatMap(match => [...commandStages(match[1])]))

  it('finds the workflow definitions it checks', () => {
    expect(definitions.map(definition => definition.name)).toEqual(expect.arrayContaining([
      'createArchitectureWorkflow', 'createReviewOnlyWorkflow', 'createRefineOnlyWorkflow', 'createFinalizeWorkflow',
      'createDirectoryWorkflow', 'createImportWorkflow', 'migrateLegacyCharacterRoster',
    ]))
    expect([...stagesOf(definitions.find(definition => definition.name === 'createArchitectureWorkflow')!.text)]).toEqual(['planning'])
    expect([...stagesOf(definitions.find(definition => definition.name === 'createFinalizeWorkflow')!.text)]).toEqual(['finalization'])
  })

  it('keeps every workflow definition inside one stage', () => {
    const mixed = definitions
      .map(definition => ({ ...definition, stages: [...stagesOf(definition.text)] }))
      .filter(definition => definition.stages.length > 1 && !MIXED_BY_DESIGN[definition.name])
      .map(definition => `${relative(root, resolve(root, definition.file))} ${definition.name}: ${definition.stages.join(', ')}`)
    expect(mixed, '一个工作流跨了环节：拆成两个工作流，或给这个定义显式传 generationModelId').toEqual([])
  })

  it('lists only definitions that really mix stages as intentional', () => {
    const stale = Object.keys(MIXED_BY_DESIGN).filter(name => {
      const definition = definitions.find(candidate => candidate.name === name)
      return !definition || stagesOf(definition.text).size < 2
    })
    expect(stale).toEqual([])
  })
})
