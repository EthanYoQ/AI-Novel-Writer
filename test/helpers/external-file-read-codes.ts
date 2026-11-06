import fs from 'node:fs'
import path from 'node:path'

function codesIn(files: string[], pattern: RegExp): string[] {
  const codes = new Set<string>()
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern)) codes.add(match[0])
  }
  return [...codes].sort()
}

/** 安全文件层（Windows helper、macOS helper 与 TS 外壳）能交出的全部 SECURE_FS_* 码，按源码扫出，新增码自动纳入。 */
export function secureFileSystemCodes(): string[] {
  const directory = path.resolve('electron/security')
  const files = fs.readdirSync(directory)
    .filter(name => /\.(ts|m|ps1)$/.test(name))
    .map(name => path.join(directory, name))
  return codesIn(files, /SECURE_FS_[A-Z0-9_]+/g)
}

/** 授权服务能抛出的全部 EXTERNAL_FILE_GRANT_* 码。 */
export function externalFileGrantCodes(): string[] {
  return codesIn([path.resolve('electron/services/external-file-grant-service.ts')], /EXTERNAL_FILE_GRANT_[A-Z0-9_]+/g)
}

/** 授权已通过、读文件才失败时作者看到的说明（#593，中文界面）。 */
export const READ_FAILURE_TEXT = {
  SECURE_FS_INVALID_TEXT: '这个文件不是 UTF-8 编码的文本。请用文本编辑器另存为 UTF-8 后重新导入。',
  SECURE_FS_FILE_TOO_LARGE: '这个文件太大，读不进来。请拆成几个小文件后重新导入。',
  SECURE_FS_OPEN_FAILED: '系统不让打开这个文件。请把它复制到桌面等普通文件夹，再重新导入。',
  generic: '无法读取所选文件；请重新选择后再试。',
} as const

export function expectedReadFailureText(code: string): string {
  return Object.hasOwn(READ_FAILURE_TEXT, code)
    ? READ_FAILURE_TEXT[code as keyof typeof READ_FAILURE_TEXT]
    : READ_FAILURE_TEXT.generic
}
