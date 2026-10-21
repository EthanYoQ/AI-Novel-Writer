/* global process, console */
// 颜色只能来自一层令牌（design-system.md 第 6 条）。扫描 src/components 与纸墨样式目录里的十六进制、rgb、hsl 字面量，
// 除令牌文件与测试外一律不许有：没有允许清单。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCAN_ROOTS = Object.freeze(['src/components', 'src/styles/paper-ink'])
export const TOKEN_FILE = 'src/styles/paper-ink/tokens.css'
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])

const COLOR_LITERAL = /(?<![\w&/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/gi

const isTestFile = (relative) => relative.split('/').includes('__tests__') || relative.endsWith('.browser.tsx')

/**
 * 去掉注释但保留换行，使行号不变。字符串里的 // 与 /* 不算注释（单双引号字符串不跨行，模板字符串可以）；
 * CSS 没有行注释，url(//…) 照常扫描。
 */
function stripComments(source, lineComments) {
  let out = ''
  let quote = null
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (quote) {
      out += char
      if (char === '\\') out += source[++i] ?? ''
      else if (char === quote || (char === '\n' && quote !== '`')) quote = null
    } else if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end < 0 ? source.length : end + 2
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop - 1
    } else if (lineComments && char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      i = (end < 0 ? source.length : end) - 1
    } else {
      if (char === '"' || char === "'" || char === '`') quote = char
      out += char
    }
  }
  return out
}

export function findColorLiterals(source, { lineComments = true } = {}) {
  return stripComments(source, lineComments).split('\n').flatMap((text, index) =>
    [...text.matchAll(COLOR_LITERAL)].map((match) => ({ line: index + 1, literal: match[0] })))
}

function listScannedFiles(rootDir) {
  const files = []
  const walk = (relativeDir) => {
    const absolute = path.join(rootDir, relativeDir)
    if (!fs.existsSync(absolute)) return
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relative = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) walk(relative)
      else if (SCANNED_EXTENSIONS.has(path.extname(entry.name)) && !isTestFile(relative) && relative !== TOKEN_FILE) files.push(relative)
    }
  }
  SCAN_ROOTS.forEach(walk)
  return files
}

export function checkColorLiterals(rootDir) {
  const violations = []
  for (const file of listScannedFiles(rootDir)) {
    const hits = findColorLiterals(fs.readFileSync(path.join(rootDir, file), 'utf8'), { lineComments: path.extname(file) !== '.css' })
    violations.push(...hits.map((hit) => ({ file, ...hit })))
  }
  return { violations }
}

// import.meta.url 是解析过符号链接与 junction 的真实路径，入口路径也要解析后再比，否则经链接运行时什么都不扫就退出 0
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { violations } = checkColorLiterals(rootDir)
  for (const { file, line, literal } of violations) {
    console.error(`${file}:${line} 颜色字面量 ${literal}：改用 ${TOKEN_FILE} 里的令牌（如 var(--ink)、var(--accent)）`)
  }
  if (violations.length > 0) process.exit(1)
  console.log('check-color-literals: 通过')
}
