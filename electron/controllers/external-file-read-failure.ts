import { app } from 'electron'
import { mainText } from '../i18n'

const READ_FAILURES: Readonly<Record<string, readonly [zhCN: string, enUS: string]>> = {
  SECURE_FS_INVALID_TEXT: [
    '这个文件不是 UTF-8 编码的文本。请用文本编辑器另存为 UTF-8 后重新导入。',
    'This file is not UTF-8 text. Save it as UTF-8 in a text editor, then import it again.',
  ],
  SECURE_FS_FILE_TOO_LARGE: [
    '这个文件太大，读不进来。请拆成几个小文件后重新导入。',
    'This file is too large to read. Split it into smaller files, then import them again.',
  ],
  SECURE_FS_OPEN_FAILED: [
    '系统不让打开这个文件。请把它复制到桌面等普通文件夹，再重新导入。',
    'The system would not open this file. Copy it to a regular folder such as the Desktop, then import it again.',
  ],
}

const UNREADABLE = [
  '无法读取所选文件；请重新选择后再试。',
  'Could not read the selected files. Please choose them again.',
] as const

/** 授权已经通过、读外部文件才失败时的说明（#593）：说读文件的原因，不说授权。 */
export function externalFileReadFailureText(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  const [zhCN, enUS] = Object.hasOwn(READ_FAILURES, code) ? READ_FAILURES[code] : UNREADABLE
  return mainText(app.getLocale(), zhCN, enUS)
}
