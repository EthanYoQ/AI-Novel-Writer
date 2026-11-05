import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { publishManuscript, removeManuscriptIfUnchanged, republishTarget, resolveManuscriptTarget, serializeManuscript } from '../manuscript-publisher'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-manuscript-'))
  roots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('manuscript publisher target seam', () => {
  it('turns dangerous Windows titles into a non-empty direct-child target inside the trusted manuscript boundary', () => {
    const projectRoot = makeRoot()
    const target = resolveManuscriptTarget({
      projectRoot,
      chapterNumber: 1,
      chapterTitle: ' CON<>:"/\\|?* . ',
      finalizationId: 'finalization-1',
      reserved: new Set(),
    })

    expect(path.dirname(target.absolutePath)).toBe(projectRoot)
    expect(target.fileName).toMatch(/^第1章 /)
    expect(target.fileName).not.toMatch(/[<>:"/\\|?*]/)
    expect(target.fileName).not.toMatch(/[. ]\.txt$/)
    expect(target.fileName).not.toContain(' CON.')
  })

  it('uses a stable fallback for an empty title and never overwrites a collision', () => {
    const projectRoot = makeRoot()
    const first = resolveManuscriptTarget({
      projectRoot,
      chapterNumber: 2,
      chapterTitle: '   ',
      finalizationId: 'finalization-1',
      reserved: new Set(),
    })
    fs.writeFileSync(first.absolutePath, 'pre-existing user manuscript', 'utf8')

    const second = resolveManuscriptTarget({
      projectRoot,
      chapterNumber: 2,
      chapterTitle: '   ',
      finalizationId: 'finalization-2',
      reserved: new Set(),
    })

    expect(first.fileName).toBe('第2章.txt')
    expect(second.absolutePath).not.toBe(first.absolutePath)
    expect(fs.readFileSync(first.absolutePath, 'utf8')).toBe('pre-existing user manuscript')
  })

  it('refuses to overwrite a frozen target edited outside the app and reports a stable code (#474)', async () => {
    const projectRoot = makeRoot()
    fs.writeFileSync(path.join(projectRoot, '第3章 雨夜.txt'), '作者在应用外改过的正文', 'utf8')
    await expect(publishManuscript({ projectRoot, targetFileName: '第3章 雨夜.txt', chapterNumber: 3, chapterTitle: '雨夜', content: '定稿正文' }))
      .rejects.toThrow(/^MANUSCRIPT_TARGET_CONFLICT$/u)
    await expect(publishManuscript({ projectRoot, targetFileName: '../escape.txt', chapterNumber: 3, chapterTitle: '雨夜', content: '定稿正文' }))
      .rejects.toThrow(/^MANUSCRIPT_STORED_TARGET_INVALID$/u)
    expect(fs.readFileSync(path.join(projectRoot, '第3章 雨夜.txt'), 'utf8')).toBe('作者在应用外改过的正文')
  })
})

describe('被替换的旧正文文件', () => {
  it.skipIf(process.platform !== 'win32')('删除被占用、等待重试期间作者保存了修改：重新比对，改过的保留', () => {
    const projectRoot = makeRoot()
    const published = '第1章 雾钟\n\n当初发布的正文。'
    const edited = `${published}\n作者在占用期间保存的一行。`
    const file = path.join(projectRoot, '第1章 雾钟.txt')
    fs.writeFileSync(file, published, 'utf8')
    const unlink = fs.unlinkSync.bind(fs)
    let held = true
    vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
      if (held && String(target) === file) {
        held = false
        fs.writeFileSync(file, edited, 'utf8')
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      unlink(target)
    })

    expect(removeManuscriptIfUnchanged(projectRoot, '第1章 雾钟.txt', [published])).toBe('changed')
    expect(fs.readFileSync(file, 'utf8')).toBe(edited)
  })

  it('旧目标被作者换成文件夹时记为已改动，保留文件夹，不让清理失败', () => {
    const projectRoot = makeRoot()
    const dir = path.join(projectRoot, '第1章 雾钟.txt')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, '作者的笔记.md'), '留着', 'utf8')

    expect(removeManuscriptIfUnchanged(projectRoot, '第1章 雾钟.txt', ['任意已发布内容'])).toBe('changed')
    expect(fs.readFileSync(path.join(dir, '作者的笔记.md'), 'utf8')).toBe('留着')
  })
})

describe('从回收站恢复时重新发布的目标', () => {
  const chapter = { chapterNumber: 3, chapterTitle: '雨夜', content: '定稿正文', finalizationId: 'fin-restored', reserved: new Set<string>() }
  const stored = '第3章 雨夜.txt'

  it('原目标空着就沿用', () => {
    const projectRoot = makeRoot()
    expect(republishTarget({ projectRoot, targetFileName: stored, ...chapter })).toBe(stored)
  })

  it('原目标已是同一份正文就沿用，不另起一份', () => {
    const projectRoot = makeRoot()
    fs.writeFileSync(path.join(projectRoot, stored), serializeManuscript(chapter), 'utf8')
    expect(republishTarget({ projectRoot, targetFileName: stored, ...chapter })).toBe(stored)
  })

  it('作者在删除后放了同名的别的文件：换一个不撞名的目标，原文件不动', () => {
    const projectRoot = makeRoot()
    fs.writeFileSync(path.join(projectRoot, stored), '作者另写的东西', 'utf8')
    const target = republishTarget({ projectRoot, targetFileName: stored, ...chapter })
    expect(target).not.toBe(stored)
    expect(target).toContain('fin-restored')
    expect(fs.readFileSync(path.join(projectRoot, stored), 'utf8')).toBe('作者另写的东西')
  })

  it('同名位置是一个文件夹：换目标，不因读文件夹而抛错', () => {
    const projectRoot = makeRoot()
    fs.mkdirSync(path.join(projectRoot, stored))
    const target = republishTarget({ projectRoot, targetFileName: stored, ...chapter })
    expect(target).not.toBe(stored)
    expect(fs.existsSync(path.join(projectRoot, target))).toBe(false)
  })

  it('旧收据里的目标名不合法：按章节重新取名，不抛错', () => {
    const projectRoot = makeRoot()
    expect(republishTarget({ projectRoot, targetFileName: '../escape.txt', ...chapter })).toBe(stored)
  })
})
