#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// 沿用原 pr-ci.yml paths 过滤的语义：规则按序匹配，最后命中的一条说了算；一条都不命中的文件要跑 CI。
const RULES = [
  ['**/*.md', true],
  ['LICENSE', true],
  ['docs/**', true],
  ['docs/**/*.json', false],
  ['docs/**/*.mjs', false],
  ['README*.md', false],
  ['.release/**', false],
  ['.github/**', false],
].map(([glob, docs]) => [globToRegExp(glob), docs])

function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 2
    } else if (glob.startsWith('**', i)) {
      source += '.*'
      i += 1
    } else if (glob[i] === '*') {
      source += '[^/]*'
    } else {
      source += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

function isDocsPath(file) {
  let docs = false
  for (const [pattern, verdict] of RULES) if (pattern.test(file)) docs = verdict
  return docs
}

export function isDocsOnly(files) {
  return files.length > 0 && files.every(isDocsPath)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean)
  console.log(String(isDocsOnly(files)))
}
