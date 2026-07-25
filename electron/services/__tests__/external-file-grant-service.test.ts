import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExternalFileGrantService } from '../external-file-grant-service'

describe('ExternalFileGrantService', () => {
  it('拒绝伪造的授权标识，不能借此读取用户选择的文件', () => {
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'real-grant-id',
    })

    expect(() => grants.resolve({
      grantId: 'forged-grant-id',
      webContentsId: 17,
      operation: 'read',
    })).toThrow('外部文件授权不存在')
  })

  it('拒绝把绝对路径伪装成目录授权的相对路径', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-root-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-outside-'))
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'directory-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['read'],
      ttlMs: 500,
    })

    expect(() => grants.resolve({
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'read',
      relativePath: outside,
    })).toThrow('相对路径不能是绝对路径')

    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('拒绝通过父目录遍历跨出用户选择的目录根', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-root-'))
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'traversal-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['read'],
      ttlMs: 500,
    })

    expect(() => grants.resolve({
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'read',
      relativePath: '../outside.txt',
    })).toThrow('相对路径不得包含父目录遍历')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('拒绝包含真实 NUL 字符的相对路径', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-root-'))
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'nul-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['read'],
      ttlMs: 500,
    })

    expect(() => grants.resolve({
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'read',
      relativePath: 'chapter\0.txt',
    })).toThrow('相对路径无效')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('拒绝另一 webContents 重放本窗口的授权', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-root-'))
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'sender-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['read'],
      ttlMs: 500,
    })

    expect(() => grants.resolve({
      grantId: grant.grantId,
      webContentsId: 18,
      operation: 'read',
      relativePath: 'chapter.txt',
    })).toThrow('外部文件授权不属于当前窗口')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('拒绝已过期的授权，即使标识与窗口仍然匹配', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-root-'))
    let now = 1_000
    const grants = new ExternalFileGrantService({
      now: () => now,
      newGrantId: () => 'expired-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['read'],
      ttlMs: 500,
    })
    now = 1_501

    expect(() => grants.resolve({
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'read',
      relativePath: 'chapter.txt',
    })).toThrow('外部文件授权已过期')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('拒绝把只读授权提升为写入授权', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-root-'))
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'read-only-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['read'],
      ttlMs: 500,
    })

    expect(() => grants.resolve({
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'write',
      relativePath: 'chapter.txt',
    })).toThrow('未授予 write 操作')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('只签发 root-relative capability；reparse 拒绝交给句柄绑定执行器', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-link-'))
    const root = path.join(fixture, 'selected')
    const outside = path.join(fixture, 'outside')
    const escape = path.join(root, 'escape')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside', 'utf8')
    fs.symlinkSync(outside, escape, 'junction')

    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'link-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['read'],
      ttlMs: 500,
    })

    expect(grants.resolve({
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'read',
      relativePath: 'escape/secret.txt',
    })).toEqual({
      rootPath: fs.realpathSync.native(root),
      relativePath: 'escape\\secret.txt',
      scope: 'directory',
    })

    fs.rmSync(fixture, { recursive: true, force: true })
  })

  it('精确文件授权只能解析用户明确选择的那一个文件', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-file-'))
    const selectedFile = path.join(root, 'selected.txt')
    const siblingFile = path.join(root, 'sibling.txt')
    fs.writeFileSync(selectedFile, 'selected', 'utf8')
    fs.writeFileSync(siblingFile, 'sibling', 'utf8')
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'file-grant-id',
    })
    const grant = grants.issueFile({
      webContentsId: 17,
      filePath: selectedFile,
      operations: ['read'],
      ttlMs: 500,
      maxUses: 2,
    })

    expect(grants.resolve({
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'read',
    })).toEqual({
      rootPath: path.dirname(fs.realpathSync.native(selectedFile)),
      relativePath: 'selected.txt',
      scope: 'file',
    })
    expect(() => grants.resolve({
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'read',
      relativePath: 'sibling.txt',
    })).toThrow('精确文件授权不接受子路径')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('有限次数授权用尽后不能被继续重放', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-uses-'))
    fs.writeFileSync(path.join(root, 'chapter.txt'), 'chapter', 'utf8')
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'limited-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['read'],
      ttlMs: 500,
      maxUses: 2,
    })
    const request = {
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'read' as const,
      relativePath: 'chapter.txt',
    }

    expect(grants.resolve(request)).toEqual({
      rootPath: fs.realpathSync.native(root),
      relativePath: 'chapter.txt',
      scope: 'directory',
    })
    expect(grants.resolve(request)).toEqual({
      rootPath: fs.realpathSync.native(root),
      relativePath: 'chapter.txt',
      scope: 'directory',
    })
    expect(() => grants.resolve(request)).toThrow('外部文件授权已用尽')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('窗口销毁时撤销该窗口的全部内存授权', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-revoke-'))
    fs.writeFileSync(path.join(root, 'chapter.txt'), 'chapter', 'utf8')
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'revoked-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['read'],
      ttlMs: 500,
    })

    grants.revokeWebContents(17)

    expect(() => grants.resolve({
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'read',
      relativePath: 'chapter.txt',
    })).toThrow('外部文件授权不存在或已失效')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('主进程的边界复核不额外消耗同一次业务操作的有限授权', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-revalidate-'))
    const grants = new ExternalFileGrantService({
      now: () => 1_000,
      newGrantId: () => 'revalidate-grant-id',
    })
    const grant = grants.issueDirectory({
      webContentsId: 17,
      directoryPath: root,
      operations: ['write', 'create'],
      ttlMs: 500,
      maxUses: 1,
    })
    const request = {
      grantId: grant.grantId,
      webContentsId: 17,
      operation: 'write' as const,
      relativePath: 'chapter.txt',
    }

    grants.resolve(request)
    expect(grants.revalidate(request)).toEqual({
      rootPath: fs.realpathSync.native(root),
      relativePath: 'chapter.txt',
      scope: 'directory',
    })
    expect(grants.revalidate({ ...request, operation: 'create' })).toEqual({
      rootPath: fs.realpathSync.native(root),
      relativePath: 'chapter.txt',
      scope: 'directory',
    })
    expect(() => grants.resolve(request)).toThrow('外部文件授权已用尽')

    fs.rmSync(root, { recursive: true, force: true })
  })
})
