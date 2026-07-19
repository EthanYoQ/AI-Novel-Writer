import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const scanRoots = [path.join(root, 'src', 'components'), path.join(root, 'src', 'App.tsx')]
const han = /\p{Script=Han}/u
const violations = []

function filesAt(target) {
  if (!fs.existsSync(target)) return []
  const stat = fs.statSync(target)
  if (stat.isFile()) return [target]
  return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry =>
    filesAt(path.join(target, entry.name)))
}

function add(file, sourceFile, node, text, kind) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  violations.push(`${path.relative(root, file)}:${line} [${kind}] ${text.trim().replace(/\s+/g, ' ')}`)
}

for (const file of scanRoots.flatMap(filesAt).filter(file => file.endsWith('.tsx'))) {
  const source = fs.readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  function visit(node) {
    if (ts.isJsxText(node) && han.test(node.getText(sourceFile))) {
      add(file, sourceFile, node, node.getText(sourceFile), 'jsx-text')
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer) && han.test(node.initializer.text)) {
      add(file, sourceFile, node, node.initializer.text, `attribute:${node.name.getText(sourceFile)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

if (violations.length > 0) {
  console.error(`Found ${violations.length} unlocalized JSX strings:\n${violations.join('\n')}`)
  process.exit(1)
}

console.log('i18n coverage check passed: no raw Chinese JSX text or string attributes')
