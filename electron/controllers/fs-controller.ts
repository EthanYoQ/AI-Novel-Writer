import { ipcMain } from 'electron'
import path from 'node:path'
import { FileNode, type ProjectSessionContext } from '../../src/shared/ipc-channels'
import { isProjectSessionContext } from '../../src/shared/project-session-context'
import { getCurrentProjectPath } from '../database'
import { projectAccess } from '../services/project-access'
import { mainText } from '../i18n'
import {
  assertProjectFilePath,
  assertRequiredExpectedProjectPath,
} from '../utils/project-context'
import {
  createSecureFileCapability,
  windowsSafeFileSystem,
  type SecureFileCapability,
  type WindowsSafeFileSystem,
} from '../security/windows-safe-file-system'

function assertProjectFileOperation(
  context: ProjectSessionContext,
  filePath: string,
  expectedProjectPath: string,
  mode: 'existing' | 'writable',
): SecureFileCapability {
  // 每次真正触碰文件系统前都以调用时冻结的完整租约重新认证。不能只比较
  // 路径：同一路径重新打开会得到新 lease，旧请求必须在 mutex 中失败。
  const active = projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
  assertRequiredExpectedProjectPath(active.rootPath, expectedProjectPath)
  assertProjectFilePath(filePath, active.rootPath, mode)
  return createSecureFileCapability(active.rootPath, filePath)
}

// 全局文件操作锁（按文件绝对路径分配 Mutex 队列）
const fileMutexMap = new Map<string, Promise<void>>()

type ProjectFilesystemHandler<Args extends unknown[] = unknown[]> = (
  event: unknown,
  context: ProjectSessionContext,
  ...args: Args
) => unknown

function text(zhCNText: string, enUSText: string): string {
  // This controller also runs in isolated IPC tests where Electron's `app`
  // singleton is intentionally absent. The persisted locale remains the
  // source of truth for both production and tests.
  return mainText(undefined, zhCNText, enUSText)
}

/** Do not expose filesystem paths or raw Node errors across the IPC boundary. */
function projectFilesystemFailure(channel: string, error: unknown): unknown {
  const internalMessage = error instanceof Error ? error.message : ''
  const projectAccessMessage = () => {
    if (/缺少项目会话上下文/.test(internalMessage)) {
      return text(
        '缺少项目会话上下文，已拒绝操作。',
        'Project session context is missing; the operation was rejected.',
      )
    }
    if (/超出当前项目/.test(internalMessage)) {
      return text(
        '目标超出当前项目范围，已拒绝操作。',
        'The target is outside the current project; the operation was rejected.',
      )
    }
    if (/跨项目读写/.test(internalMessage)) {
      return text(
        '检测到跨项目读写，已拒绝操作。',
        'Cross-project file access was rejected.',
      )
    }
    if (/项目会话已失效|租约已失效/.test(internalMessage)) {
      return text(
        '项目租约已失效，已拒绝操作。',
        'The project lease has expired; the operation was rejected.',
      )
    }
    return undefined
  }
  const accessMessage = projectAccessMessage()
  if (channel === 'fs:read-file') {
    return { success: false, content: '', error: accessMessage ?? text('无法读取项目文件。', 'Could not read the project file.') }
  }
  if (channel === 'fs:read-json') {
    return { success: false, data: null, error: accessMessage ?? text('无法读取项目数据。', 'Could not read the project data.') }
  }
  if (
    channel === 'fs:write-file'
    || channel === 'fs:mkdir'
    || channel === 'fs:write-json'
  ) return { success: false, error: accessMessage ?? text('无法写入项目文件。', 'Could not write the project file.') }
  throw error
}

function registerFilesystemHandler<Args extends unknown[]>(
  channel: string,
  handler: ProjectFilesystemHandler<Args>,
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    const candidate = args.at(-1)
    const context = isProjectSessionContext(candidate) ? candidate : undefined
    if (context) args.pop()
    try {
      projectAccess.assertCurrentProjectContext(context, getCurrentProjectPath())
      if (!context) {
        throw new Error('缺少项目会话上下文，已拒绝操作')
      }
      return await handler(event, context, ...(args as Args))
    } catch (error) {
      return projectFilesystemFailure(channel, error)
    }
  })
}

/** 互斥锁执行器：确保同一文件的读写完全串行排队 */
async function withFileMutex<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  // Normalize path across OS
  const normalPath = path.resolve(filePath)
  const previousTask = fileMutexMap.get(normalPath) || Promise.resolve()
  
  const currentTask = (async () => {
    try {
      await previousTask
    } catch { /* 前置任务错误不影响后续任务启动 */ }
    return task()
  })()

  // 缓存 stored promise 引用，供 finally 比较用
  const stored = currentTask.then(() => {}).catch(() => {})
  fileMutexMap.set(normalPath, stored)
  
  try {
    return await currentTask
  } finally {
    // 垃圾回收防御：如果当前任务是最后在等待的，则移除记录
    if (fileMutexMap.get(normalPath) === stored) {
      fileMutexMap.delete(normalPath)
    }
  }
}

function parentCapability(capability: SecureFileCapability): SecureFileCapability {
  const parent = path.win32.dirname(capability.relativePath)
  return {
    rootPath: capability.rootPath,
    relativePath: parent === '.' ? '' : parent,
  }
}

function childCapability(
  parent: SecureFileCapability,
  name: string,
): SecureFileCapability {
  return {
    rootPath: parent.rootPath,
    relativePath: parent.relativePath ? `${parent.relativePath}\\${name}` : name,
  }
}

function capabilityDisplayPath(capability: SecureFileCapability): string {
  return capability.relativePath
    ? path.join(capability.rootPath, ...capability.relativePath.split('\\'))
    : capability.rootPath
}

async function readDirRecursive(
  fileSystem: WindowsSafeFileSystem,
  directory: SecureFileCapability,
): Promise<FileNode[]> {
  const entries = await fileSystem.listDirectory(directory)
  const visibleEntries = entries
    .filter(entry => !entry.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
  return Promise.all(visibleEntries.map(async (entry) => {
    const child = childCapability(directory, entry.name)
    if (entry.isDirectory) {
      return {
        name: entry.name,
        path: capabilityDisplayPath(child),
        isDir: true,
        children: await readDirRecursive(fileSystem, child),
      }
    }
    return { name: entry.name, path: capabilityDisplayPath(child), isDir: false }
  }))
}

export function registerFSController(
  fileSystem: WindowsSafeFileSystem = windowsSafeFileSystem,
) {
  // 所有项目 fs:* 通道统一以当前租约与 canonical 项目根为权限边界。
  const ipcMain = { handle: registerFilesystemHandler }
  // 安全的异步读取
  ipcMain.handle('fs:read-file', async (
    _event,
    context: ProjectSessionContext,
    filePath: string,
    expectedProjectPath: string,
  ) => {
    try {
        assertProjectFileOperation(context, filePath, expectedProjectPath, 'existing')
        return await withFileMutex(filePath, async () => {
          const target = assertProjectFileOperation(context, filePath, expectedProjectPath, 'existing')
          const content = await fileSystem.readText(target)
          assertProjectFileOperation(context, filePath, expectedProjectPath, 'existing')
          return { success: true, content }
        })
    } catch (error) {
      return projectFilesystemFailure('fs:read-file', error)
    }
  })

  // 跨平台绝对安全异步写入（防踩空）
  ipcMain.handle('fs:write-file', async (
    _event,
    context: ProjectSessionContext,
    filePath: string,
    content: string,
    expectedProjectPath: string,
  ) => {
    try {
        assertProjectFileOperation(context, filePath, expectedProjectPath, 'writable')
        return await withFileMutex(filePath, async () => {
          const target = assertProjectFileOperation(context, filePath, expectedProjectPath, 'writable')
          // Both mkdir and replacement operate from the same type of bound
          // directory handle. Revalidate the full lease after each await.
          await fileSystem.mkdir(parentCapability(target))
          assertProjectFileOperation(context, filePath, expectedProjectPath, 'writable')
          await fileSystem.writeTextAtomically(target, content, () => {
            // The helper has the temp file and parent directory handles open at
            // this exact commit point; an old lease must not replace a file.
            assertProjectFileOperation(context, filePath, expectedProjectPath, 'writable')
          })
          assertProjectFileOperation(context, filePath, expectedProjectPath, 'existing')
          return { success: true }
        })
    } catch (error) {
      return projectFilesystemFailure('fs:write-file', error)
    }
  })

  ipcMain.handle('fs:list-dir', async (
    _event,
    context: ProjectSessionContext,
    dirPath: string,
    expectedProjectPath: string,
  ): Promise<FileNode[]> => {
    // 不把生产读取错误伪装成“空目录”；调用方需要区分真实空项目与读取失败。
    const directory = assertProjectFileOperation(context, dirPath, expectedProjectPath, 'existing')
    const tree = await readDirRecursive(fileSystem, directory)
    assertProjectFileOperation(context, dirPath, expectedProjectPath, 'existing')
    return tree
  })

  ipcMain.handle('fs:mkdir', async (
    _event,
    context: ProjectSessionContext,
    dirPath: string,
    expectedProjectPath: string,
  ) => {
    try {
      assertProjectFileOperation(context, dirPath, expectedProjectPath, 'writable')
      return await withFileMutex(dirPath, async () => {
        const directory = assertProjectFileOperation(context, dirPath, expectedProjectPath, 'writable')
        await fileSystem.mkdir(directory)
        assertProjectFileOperation(context, dirPath, expectedProjectPath, 'existing')
        return { success: true }
      })
    } catch {
      return { success: false, error: text('无法创建项目目录。', 'Could not create the project directory.') }
    }
  })

  ipcMain.handle('fs:check-exists', async (
    _event,
    context: ProjectSessionContext,
    filePath: string,
    expectedProjectPath: string,
  ) => {
    const target = assertProjectFileOperation(context, filePath, expectedProjectPath, 'writable')
    const exists = await fileSystem.exists(target)
    assertProjectFileOperation(context, filePath, expectedProjectPath, exists ? 'existing' : 'writable')
    return exists
  })

  ipcMain.handle('fs:read-json', async (
    _event,
    context: ProjectSessionContext,
    filePath: string,
    expectedProjectPath: string,
  ) => {
    try {
        assertProjectFileOperation(context, filePath, expectedProjectPath, 'existing')
        return await withFileMutex(filePath, async () => {
          const target = assertProjectFileOperation(context, filePath, expectedProjectPath, 'existing')
          const content = await fileSystem.readText(target)
          assertProjectFileOperation(context, filePath, expectedProjectPath, 'existing')
          return { success: true, data: JSON.parse(content) }
        })
    } catch {
      return { success: false, data: null, error: text('无法读取项目数据。', 'Could not read the project data.') }
    }
  })

  ipcMain.handle('fs:write-json', async (
    _event,
    context: ProjectSessionContext,
    filePath: string,
    data: unknown,
    expectedProjectPath: string,
  ) => {
    try {
        assertProjectFileOperation(context, filePath, expectedProjectPath, 'writable')
        return await withFileMutex(filePath, async () => {
          const target = assertProjectFileOperation(context, filePath, expectedProjectPath, 'writable')
          await fileSystem.mkdir(parentCapability(target))
          assertProjectFileOperation(context, filePath, expectedProjectPath, 'writable')
          await fileSystem.writeTextAtomically(target, JSON.stringify(data, null, 2), () => {
            assertProjectFileOperation(context, filePath, expectedProjectPath, 'writable')
          })
          assertProjectFileOperation(context, filePath, expectedProjectPath, 'existing')
          return { success: true }
        })
    } catch {
      return { success: false, error: text('无法写入项目数据。', 'Could not write the project data.') }
    }
  })

}
