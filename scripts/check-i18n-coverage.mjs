/* global process */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const han = /\p{Script=Han}/u
const latinWord = /[A-Za-z]{2,}/

/**
 * The broad renderer roots preserve the existing visible-copy check.  The
 * boundary roots are deliberately small and correspond to actual user-facing
 * error delivery paths, not an ever-growing allow-list of string literals.
 */
export const I18N_COVERAGE_BOUNDARIES = Object.freeze({
  rendererRoots: [
    'src/App.tsx',
    'src/components/layout',
    'src/components/pages',
    'src/components/dialogs',
    'src/components/settings/SettingsModal.tsx',
    'src/components/settings/PromptSettings.tsx',
    'src/components/settings/ModelSettings.tsx',
    'src/components/panels/Sidebar.tsx',
    'src/components/panels/KnowledgePanel.tsx',
    'src/components/panels/EditorArea.tsx',
    'src/components/panels/sidebar',
    'src/components/panels/agent/ToolCallBlock.tsx',
    'src/components/editor/NovelConfigEditor.tsx',
    'src/components/editor/ThreeWayMerge.tsx',
    'src/components/editor/DraftEditor.tsx',
    'src/components/editor/ChapterCardEditor.tsx',
    'src/components/editor/CharacterEditor.tsx',
    'src/components/editor/ReviewReport.tsx',
    'src/components/panels/sidebar/CharactersView.tsx',
    'src/components/ErrorBoundary.tsx',
    'src/components/ui/ActionToast.tsx',
    'src/components/ui/AlertDialog.tsx',
    'src/components/ui/Confirm.tsx',
    'src/components/ui/Dialog.tsx',
    'src/services/project-service.ts',
    'src/services/workflows/architecture-workflow.ts',
  ],
  rendererErrorBoundaries: [
    'src/stores/project-store.ts',
    'src/components/panels/agent/artifact-open.ts',
  ],
  mainReturnErrorBoundaries: [
    // `artifact-open` receives fs:read-file failures through this controller.
    'electron/controllers/fs-controller.ts',
  ],
})

/**
 * Exclusions are semantic, not file-by-file: the scanner only follows text
 * that reaches a renderer sink or a main-process returned-error boundary.
 * Model prompts, parser diagnostics and console-only logs do not cross either
 * boundary, so scanning them would create false positives without improving
 * the language users see.
 */
export const I18N_COVERAGE_EXCLUSIONS = Object.freeze([
  'LLM prompts and response-parser strings that do not reach a renderer notification sink.',
  'Console-only diagnostics that are not passed to a renderer notification sink.',
  'Internal identifiers, IPC channel names, paths and protocol values outside visible-copy properties.',
])

const visibleWorkflowProperties = new Set([
  'title',
  'name',
  'description',
  'label',
  'message',
])

const notificationCallNames = new Set([
  'alertError',
  'confirm',
  'addLog',
  'toast.error',
  'toast.success',
  'toast.warning',
  'cb.log',
  'cb.appendText',
  'runProjectEventTask',
])

const enhancedCoverageFiles = new Set([
  'src/components/editor/DraftEditor.tsx',
  'src/components/editor/ChapterCardEditor.tsx',
  'src/components/editor/CharacterEditor.tsx',
  'src/components/editor/ReviewReport.tsx',
  'src/components/panels/sidebar/CharactersView.tsx',
  'src/services/project-service.ts',
  'src/services/workflows/architecture-workflow.ts',
])

const localizationCallees = new Set([
  'text',
  'localize',
  'translate',
  'stepDesc',
  'appErrorMessage',
  // Small module-local wrappers used at renderer notification boundaries.
  'projectText',
  'projectError',
  'artifactText',
  'artifactError',
  // Main-process colocated translator.
  'mainText',
])

function filesAt(target) {
  if (!fs.existsSync(target)) return []
  const stat = fs.statSync(target)
  if (stat.isFile()) return [target]
  return fs.readdirSync(target, { withFileTypes: true }).flatMap(entry =>
    filesAt(path.join(target, entry.name)))
}

function relativePath(root, file) {
  return path.relative(root, file).replaceAll('\\', '/')
}

function add(violations, root, file, sourceFile, node, text, kind) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  violations.push(`${relativePath(root, file)}:${line} [${kind}] ${text.trim().replace(/\s+/g, ' ')}`)
}

function callName(node, sourceFile) {
  return node.expression.getText(sourceFile)
}

function isLocalizedCall(node, sourceFile) {
  if (!ts.isCallExpression(node)) return false
  const callee = callName(node, sourceFile)
  return localizationCallees.has(callee) || callee.endsWith('.text')
}

function literalContainsHumanCopy(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return han.test(node.text) || latinWord.test(node.text)
  }
  if (ts.isTemplateExpression(node)) {
    return han.test(node.head.text)
      || latinWord.test(node.head.text)
      || node.templateSpans.some(span => han.test(span.literal.text) || latinWord.test(span.literal.text))
  }
  return false
}

function literalContainsHan(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return han.test(node.text)
  }
  if (ts.isTemplateExpression(node)) {
    return han.test(node.head.text) || node.templateSpans.some(span => han.test(span.literal.text))
  }
  return false
}

function nodeContainsHumanCopy(node, sourceFile) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (literalContainsHumanCopy(node)) return true
  let found = false
  ts.forEachChild(node, child => {
    if (!found && nodeContainsHumanCopy(child, sourceFile)) found = true
  })
  return found
}

function nodeContainsHan(node, sourceFile) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (literalContainsHan(node)) return true
  let found = false
  ts.forEachChild(node, child => {
    if (!found && nodeContainsHan(child, sourceFile)) found = true
  })
  return found
}

function nodeContainsUnlocalizedPromptDescription(node, sourceFile) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (ts.isIdentifier(node) && node.text === 'desc') return true
  // Nested JSX expressions and callback bodies are visited independently.  Do
  // not treat a map callback's `desc` parameter as visible copy by itself.
  if (
    ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node)
    || ts.isJsxElement(node)
    || ts.isJsxSelfClosingElement(node)
    || ts.isJsxFragment(node)
  ) return false
  let found = false
  ts.forEachChild(node, child => {
    if (!found && nodeContainsUnlocalizedPromptDescription(child, sourceFile)) found = true
  })
  return found
}

function collectBindings(sourceFile) {
  const bindings = new Map()
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      bindings.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return bindings
}

function isUnsafeErrorForward(node, sourceFile, bindings, seen = new Set()) {
  if (ts.isParenthesizedExpression(node)) {
    return isUnsafeErrorForward(node.expression, sourceFile, bindings, seen)
  }
  if (ts.isCallExpression(node) && callName(node, sourceFile) === 'String') return true
  if (
    ts.isPropertyAccessExpression(node)
    && ['error', 'warning', 'message'].includes(node.name.text)
  ) return true
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return false
    const initializer = bindings.get(node.text)
    if (!initializer) return false
    seen.add(node.text)
    return isUnsafeErrorForward(initializer, sourceFile, bindings, seen)
  }
  if (ts.isBinaryExpression(node) && ['??', '||'].includes(node.operatorToken.getText(sourceFile))) {
    return isUnsafeErrorForward(node.left, sourceFile, bindings, seen)
      || isUnsafeErrorForward(node.right, sourceFile, bindings, seen)
  }
  return false
}

function inspectVisibleExpression(violations, root, file, sourceFile, node, kind) {
  if (isLocalizedCall(node, sourceFile)) return
  if (nodeContainsHan(node, sourceFile)) {
    add(violations, root, file, sourceFile, node, node.getText(sourceFile), kind)
    return
  }
  ts.forEachChild(node, child => inspectVisibleExpression(violations, root, file, sourceFile, child, kind))
}

function inspectBoundaryExpression(violations, root, file, sourceFile, node, kind, bindings) {
  if (isLocalizedCall(node, sourceFile)) return
  if (isUnsafeErrorForward(node, sourceFile, bindings)) {
    add(violations, root, file, sourceFile, node, node.getText(sourceFile), kind)
    return
  }
  if (nodeContainsHumanCopy(node, sourceFile)) {
    add(violations, root, file, sourceFile, node, node.getText(sourceFile), kind)
    return
  }
  ts.forEachChild(node, child => inspectBoundaryExpression(
    violations,
    root,
    file,
    sourceFile,
    child,
    kind,
    bindings,
  ))
}

function inspectNotification(violations, root, file, sourceFile, node, bindings) {
  const name = callName(node, sourceFile)
  const [message, options] = node.arguments
  if (message) {
    inspectBoundaryExpression(violations, root, file, sourceFile, message, `notification:${name}`, bindings)
  }
  if (options && ts.isObjectLiteralExpression(options)) {
    for (const property of options.properties) {
      if (
        ts.isPropertyAssignment(property)
        && ['title', 'confirmText'].includes(property.name.getText(sourceFile))
      ) {
        inspectBoundaryExpression(
          violations,
          root,
          file,
          sourceFile,
          property.initializer,
          `notification:${name}`,
          bindings,
        )
      }
    }
  }
}

function inspectRendererFile(violations, root, file, sourceFile) {
  const relativeFile = relativePath(root, file)
  const enhanced = enhancedCoverageFiles.has(relativeFile)
  const strictBoundary = I18N_COVERAGE_BOUNDARIES.rendererErrorBoundaries.includes(relativeFile)
  const promptSettings = relativeFile === 'src/components/settings/PromptSettings.tsx'
  const bindings = collectBindings(sourceFile)

  const visit = (node) => {
    if (
      promptSettings
      && ts.isJsxExpression(node)
      && node.expression
      && nodeContainsUnlocalizedPromptDescription(node.expression, sourceFile)
    ) {
      add(
        violations,
        root,
        file,
        sourceFile,
        node,
        node.expression.getText(sourceFile),
        'prompt-variable-description',
      )
    }
    if (ts.isJsxText(node) && han.test(node.getText(sourceFile))) {
      add(violations, root, file, sourceFile, node, node.getText(sourceFile), 'jsx-text')
    }
    if (
      ts.isJsxAttribute(node)
      && node.name.getText(sourceFile) !== 'value'
      && node.initializer
      && ts.isStringLiteral(node.initializer)
      && han.test(node.initializer.text)
    ) {
      add(violations, root, file, sourceFile, node, node.initializer.text, `attribute:${node.name.getText(sourceFile)}`)
    }
    if (enhanced && ts.isJsxExpression(node) && node.expression) {
      inspectVisibleExpression(violations, root, file, sourceFile, node.expression, 'jsx-expression')
    }
    if (
      enhanced
      && ts.isPropertyAssignment(node)
      && visibleWorkflowProperties.has(node.name.getText(sourceFile))
    ) {
      inspectVisibleExpression(
        violations,
        root,
        file,
        sourceFile,
        node.initializer,
        `workflow:${node.name.getText(sourceFile)}`,
      )
    }
    if (
      (enhanced || strictBoundary)
      && ts.isCallExpression(node)
      && notificationCallNames.has(callName(node, sourceFile))
    ) {
      if (strictBoundary) {
        inspectNotification(violations, root, file, sourceFile, node, bindings)
      } else {
        const argumentsToInspect = callName(node, sourceFile) === 'runProjectEventTask'
          ? node.arguments.slice(0, 1)
          : node.arguments
        for (const argument of argumentsToInspect) {
          inspectVisibleExpression(
            violations,
            root,
            file,
            sourceFile,
            argument,
            `notification:${callName(node, sourceFile)}`,
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function inspectMainReturnErrors(violations, root, file, sourceFile) {
  const bindings = collectBindings(sourceFile)
  const visit = (node) => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      for (const property of node.expression.properties) {
        if (
          ts.isPropertyAssignment(property)
          && ['error', 'warning'].includes(property.name.getText(sourceFile))
        ) {
          inspectBoundaryExpression(
            violations,
            root,
            file,
            sourceFile,
            property.initializer,
            `main-return:${property.name.getText(sourceFile)}`,
            bindings,
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

export function collectI18nCoverageViolations(root = process.cwd()) {
  const violations = []
  const rendererRoots = [
    ...I18N_COVERAGE_BOUNDARIES.rendererRoots,
    ...I18N_COVERAGE_BOUNDARIES.rendererErrorBoundaries,
  ]
  const scannedRendererFiles = new Set()
  for (const relative of rendererRoots) {
    for (const file of filesAt(path.join(root, relative))) {
      if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue
      if (scannedRendererFiles.has(file)) continue
      scannedRendererFiles.add(file)
      const source = fs.readFileSync(file, 'utf8')
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      )
      inspectRendererFile(violations, root, file, sourceFile)
    }
  }
  for (const relative of I18N_COVERAGE_BOUNDARIES.mainReturnErrorBoundaries) {
    const file = path.join(root, relative)
    if (!fs.existsSync(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    inspectMainReturnErrors(violations, root, file, sourceFile)
  }
  return violations
}

export function runI18nCoverageCheck(root = process.cwd()) {
  const violations = collectI18nCoverageViolations(root)
  if (violations.length > 0) {
    console.error(`Found ${violations.length} unlocalized visible strings:\n${violations.join('\n')}`)
    return 1
  }
  console.log('i18n coverage check passed: no unlocalized renderer or main-boundary copy')
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runI18nCoverageCheck()
}
