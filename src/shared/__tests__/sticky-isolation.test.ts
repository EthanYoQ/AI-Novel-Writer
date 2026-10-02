/**
 * 便利贴隔离契约。
 *
 * 先生 2026-09-20 定的铁律：便利贴**不参与 AI 创作工作流**。
 * 这是一句设计说明，但它必须能被机器验证 —— 否则半年后某次「顺手把它也
 * 注入一下上下文」的改动，不会有任何人发现。
 *
 * 所以这里用源码断言守住两件事：
 *   1. 写稿 / 定稿 / 审稿 / 助手上下文组装链路里，**查不到 sticky**（含注释）；
 *   2. 「清除项目生成内容」的范围里也**没有 sticky** —— 那些删的都是 AI 生成物，
 *      而便利贴是先生亲手敲的，被连带删掉是灾难。
 *
 * 断言去掉注释再查：注释里提一句旧实现就会误伤（这个项目在这上面栽过两次）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 任何与「AI 读到什么」有关的链路，都在这里点名。 */
const WRITING_PIPELINE_FILES = [
  'src/services/workflows/chapter-materials.ts',
  'src/services/workflows/commands/generate-draft.command.ts',
  'src/services/workflows/commands/finalize-chapter.command.ts',
  'src/services/workflows/commands/review-chapter.command.ts',
  'src/services/workflows/commands/refine-draft.command.ts',
] as const

/** 生成内容的清除白名单里不允许出现便利贴。 */
const PROJECT_CLEAR_FILES = [
  'electron/repositories/project-clear-repository.ts',
] as const

/** 去掉块注释与整行注释，避免注释里的词误伤断言。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('便利贴隔离契约', () => {
  it.each(WRITING_PIPELINE_FILES)('%s 不读取便利贴', (file) => {
    const source = stripComments(readFileSync(file, 'utf8'))
    expect(source.toLowerCase()).not.toContain('sticky')
  })

  it.each(PROJECT_CLEAR_FILES)('%s 不清除便利贴', (file) => {
    const source = stripComments(readFileSync(file, 'utf8'))
    expect(source.toLowerCase()).not.toContain('sticky')
  })

  it('助手工具集里也没有便利贴', () => {
    const files = readdirSync('src/services/agent/tools').filter(name => name.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const name of files) {
      const source = stripComments(readFileSync(`src/services/agent/tools/${name}`, 'utf8'))
      expect(source.toLowerCase(), `src/services/agent/tools/${name}`).not.toContain('sticky')
    }
  })

  it('便利贴仓库不被写稿链路 import', () => {
    for (const file of WRITING_PIPELINE_FILES) {
      expect(readFileSync(file, 'utf8')).not.toContain('sticky-note-repository')
    }
  })

  it('便利贴通道全部走 db: 前缀 —— 这样才自动吃项目会话门禁', () => {
    const channels = readFileSync('src/shared/ipc-channels.ts', 'utf8')
    const block = channels.slice(
      channels.indexOf('export interface StickyNoteChannels'),
      channels.indexOf('export interface KnowledgeBaseChannels'),
    )
    expect(block).toContain("'db:sticky-")
    // 块里出现的每一个通道名都必须以 db:sticky- 开头。
    const names = [...block.matchAll(/'([a-z][^']*)':\s*\{\s*args:/g)].map(match => match[1])
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(name.startsWith('db:sticky-')).toBe(true)
  })
})
