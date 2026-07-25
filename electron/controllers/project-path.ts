import path from 'node:path'

const WINDOWS_ILLEGAL_FILE_NAME_CHARS = /[<>:"/\\|?*]/g

function replaceWindowsControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint <= 0x1f ? '_' : character
  }).join('')
}

export function sanitizeProjectName(name: string): string {
  const trimmed = name.trim()
  const baseName = trimmed.split(/[\\/]/).pop() || trimmed
  return replaceWindowsControlCharacters(
    baseName.replace(WINDOWS_ILLEGAL_FILE_NAME_CHARS, '_'),
  ).trim() || '未命名项目'
}

export function resolveProjectDir(parentPath: string, projectName: string): string {
  return path.join(parentPath, sanitizeProjectName(projectName))
}
