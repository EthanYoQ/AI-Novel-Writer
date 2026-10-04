import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExternalFileGrantService } from '../external-file-grant-service'

describe('ExternalFileGrantService', () => {
  it('binds a selected project directory to its sender, operation, root, expiry and one use', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-project-grant-'))
    let now = 1_000
    const grants = new ExternalFileGrantService({ now: () => now })
    const issue = (operation: 'project-create' | 'project-open' | 'legacy-import') => grants.issueDirectory({
      webContentsId: 17, directoryPath: root, operations: [operation], ttlMs: 500,
    }).grantId
    try {
      for (const operation of ['project-create', 'project-open', 'legacy-import'] as const) {
        const request = { grantId: issue(operation), webContentsId: 17, operation }
        expect(() => grants.resolveDirectoryPath({ ...request, grantId: root })).toThrow('不存在')
        expect(() => grants.resolveDirectoryPath({ ...request, webContentsId: 18 })).toThrow('不属于')
        expect(() => grants.resolveDirectoryPath({ ...request, operation: 'write' })).toThrow('未授予')
        expect(() => grants.resolveDirectoryPath({ ...request, operation: operation === 'project-open' ? 'legacy-import' : 'project-open' })).toThrow('未授予')
        expect(grants.resolveDirectoryPath(request)).toBe(fs.realpathSync.native(root))
        expect(() => grants.resolveDirectoryPath(request)).toThrow('不存在')
      }
      const expired = issue('project-open')
      now += 500
      expect(() => grants.resolveDirectoryPath({ grantId: expired, webContentsId: 17, operation: 'project-open' })).toThrow('过期')
      const file = path.join(root, 'book.txt')
      fs.writeFileSync(file, 'book')
      const fileGrant = grants.issueFile({ webContentsId: 17, filePath: file, operations: ['project-open'], ttlMs: 500 })
      expect(() => grants.resolveDirectoryPath({ grantId: fileGrant.grantId, webContentsId: 17, operation: 'project-open' })).toThrow('范围不符')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
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
      rootIdentity: expect.objectContaining({
        volumeSerialNumber: expect.any(String),
        fileIndex: expect.any(String),
      }),
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
      rootIdentity: expect.objectContaining({
        volumeSerialNumber: expect.any(String),
        fileIndex: expect.any(String),
      }),
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
      rootIdentity: expect.objectContaining({
        volumeSerialNumber: expect.any(String),
        fileIndex: expect.any(String),
      }),
      relativePath: 'chapter.txt',
      scope: 'directory',
    })
    expect(grants.resolve(request)).toEqual({
      rootPath: fs.realpathSync.native(root),
      rootIdentity: expect.objectContaining({
        volumeSerialNumber: expect.any(String),
        fileIndex: expect.any(String),
      }),
      relativePath: 'chapter.txt',
      scope: 'directory',
    })
    expect(grants.activeCount()).toBe(1)
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

  it('主进程可在消费前复核边界，最后一次消费会删除授权记录', () => {
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

    expect(grants.revalidate(request)).toEqual({
      rootPath: fs.realpathSync.native(root),
      rootIdentity: expect.objectContaining({
        volumeSerialNumber: expect.any(String),
        fileIndex: expect.any(String),
      }),
      relativePath: 'chapter.txt',
      scope: 'directory',
    })
    expect(grants.revalidate({ ...request, operation: 'create' })).toEqual({
      rootPath: fs.realpathSync.native(root),
      rootIdentity: expect.objectContaining({
        volumeSerialNumber: expect.any(String),
        fileIndex: expect.any(String),
      }),
      relativePath: 'chapter.txt',
      scope: 'directory',
    })
    grants.resolve(request)
    expect(grants.activeCount()).toBe(0)
    expect(() => grants.revalidate(request)).toThrow('外部文件授权不存在或已失效')

    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe('ExternalFileGrantService 精确路径授权（供仍以路径为入参的归档服务使用）', () => {
  const roots: string[] = []
  function tempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-external-grant-exact-'))
    roots.push(root)
    return root
  }
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('为尚不存在的保存目标签发精确授权，并只解析成用户选定的那一个路径', () => {
    const root = tempRoot()
    const target = path.join(root, 'backup.ainovel')
    const grants = new ExternalFileGrantService({ now: () => 1_000, newGrantId: () => 'exact-new-child' })
    const grant = grants.issueNewChild({
      webContentsId: 17, filePath: target, operations: ['create'], ttlMs: 500,
    })

    expect(fs.existsSync(target)).toBe(false)
    expect(grants.resolveExactPath({ grantId: grant.grantId, webContentsId: 17, operation: 'create' }))
      .toBe(path.join(fs.realpathSync.native(root), 'backup.ainovel'))
    // 单次授权：消费后即删除，不能重放。
    expect(grants.activeCount()).toBe(0)
    expect(() => grants.resolveExactPath({ grantId: grant.grantId, webContentsId: 17, operation: 'create' }))
      .toThrow('外部文件授权不存在或已失效')
  })

  it('已存在文件的精确授权同样解析成主进程持有的路径', () => {
    const root = tempRoot()
    const archive = path.join(root, 'selected.ainovel')
    fs.writeFileSync(archive, 'archive')
    const grants = new ExternalFileGrantService({ now: () => 1_000, newGrantId: () => 'exact-file' })
    const grant = grants.issueFile({
      webContentsId: 17, filePath: archive, operations: ['read'], ttlMs: 500, maxUses: 1,
    })

    expect(grants.resolveExactPath({ grantId: grant.grantId, webContentsId: 17, operation: 'read' }))
      .toBe(path.join(fs.realpathSync.native(root), 'selected.ainovel'))
  })

  it('拒绝伪造标识、其他窗口、错误操作与过期授权，且拒绝不会消费合法授权', () => {
    const root = tempRoot()
    let now = 1_000
    const grants = new ExternalFileGrantService({ now: () => now, newGrantId: () => 'exact-negative' })
    const grant = grants.issueNewChild({
      webContentsId: 17, filePath: path.join(root, 'copy'), operations: ['create'], ttlMs: 500,
    })
    const request = { grantId: grant.grantId, webContentsId: 17, operation: 'create' as const }

    expect(() => grants.resolveExactPath({ ...request, grantId: 'forged' })).toThrow('外部文件授权不存在')
    expect(() => grants.resolveExactPath({ ...request, webContentsId: 18 })).toThrow('外部文件授权不属于当前窗口')
    expect(() => grants.resolveExactPath({ ...request, operation: 'read' })).toThrow('未授予 read 操作')
    expect(grants.activeCount()).toBe(1)

    now = 1_501
    expect(() => grants.resolveExactPath(request)).toThrow('外部文件授权已过期')
  })

  it('拒绝目录范围授权冒充精确路径授权，并且不消费该目录授权', () => {
    const root = tempRoot()
    const grants = new ExternalFileGrantService({ now: () => 1_000, newGrantId: () => 'exact-scope' })
    const directoryGrant = grants.issueDirectory({
      webContentsId: 17, directoryPath: root, operations: ['create', 'write'], ttlMs: 500, maxUses: 1,
    })

    expect(() => grants.resolveExactPath({
      grantId: directoryGrant.grantId, webContentsId: 17, operation: 'create',
    })).toThrow('外部文件授权范围不符')
    expect(grants.activeCount()).toBe(1)
    expect(grants.resolve({
      grantId: directoryGrant.grantId, webContentsId: 17, operation: 'create', relativePath: 'later.md',
    })).toMatchObject({ scope: 'directory', relativePath: 'later.md' })
  })

  it('拒绝无法安全表达为单一子项的目标，或父目录不存在的目标', () => {
    const root = tempRoot()
    const grants = new ExternalFileGrantService({ now: () => 1_000, newGrantId: () => 'exact-invalid' })

    expect(() => grants.issueNewChild({
      webContentsId: 17, filePath: path.join(root, 'missing-parent', 'copy'), operations: ['create'], ttlMs: 500,
    })).toThrow()
    expect(() => grants.issueNewChild({
      webContentsId: 17, filePath: path.join(root, 'bad:name'), operations: ['create'], ttlMs: 500,
    })).toThrow('相对路径无效')
    expect(grants.activeCount()).toBe(0)
  })

  it('授权后父目录被替换成另一个目录时拒绝解析成路径', () => {
    const root = tempRoot()
    const parent = path.join(root, 'chosen')
    fs.mkdirSync(parent)
    const grants = new ExternalFileGrantService({ now: () => 1_000, newGrantId: () => 'exact-swapped' })
    const grant = grants.issueNewChild({
      webContentsId: 17, filePath: path.join(parent, 'copy'), operations: ['create'], ttlMs: 500,
    })

    fs.renameSync(parent, path.join(root, 'chosen-moved'))
    fs.mkdirSync(parent)

    expect(() => grants.resolveExactPath({ grantId: grant.grantId, webContentsId: 17, operation: 'create' }))
      .toThrow('外部文件授权目标已变化')
  })
})
