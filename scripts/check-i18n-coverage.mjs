/* global process */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const han = /\p{Script=Han}/u
const latinWord = /[A-Za-z]{2,}/
/**
 * 英文里数量后的复数名词，中间可隔一两个修饰词（the ${n} existing blueprints）：数量是 1 时读成「1 chapters」，要走 pluralEn。
 * 插值后接 checks/changes 作动词（${who} checks the chapter）也会被拦：改写句子，或用 pluralEn。
 */
const fixedPluralAfterCount = /^ (?:[a-z]+ ){0,2}(?:chapters|files|characters|items|lines|calls|drafts|words|documents|chunks|days|notes|versions|entries|kinds|blueprints|events|minutes|passages|candidates|tasks|suggestions|changes|checks)\b/
/** 数量前的 these、those 与数量后直接跟的 have、are：数量是 1 时读成「these 1 log line」「1 have」。 */
const pluralBeforeCount = /\b(?:these|those)\s$/i
const pluralVerbAfterCount = /^ (?:have|are|were)\b/
const pluralHint = "Write the noun with pluralEn(count, 'chapter'); pass irregular plurals explicitly, as in pluralEn(count, 'entry', 'entries'). Write a verb that follows the count the same way, as in pluralEn(count, 'has', 'have')."
/**
 * 英文文案在哪个实参（从 0 数）：(locale, 中文, 英文) 形式的翻译函数与 projectError、artifactError（error, 中文兜底, 英文兜底）、
 * workflowUiText（context, 中文, 英文）与工作流文件里的 localeText、textForLocale（locale, 中文, 英文）在第 3 个，其余在第 2 个。
 */
const englishArgumentIndex = new Map([['localize', 2], ['stepDesc', 2], ['mainText', 2], ['projectError', 2], ['artifactError', 2], ['workflowUiText', 2], ['localeText', 2], ['textForLocale', 2]])

/**
 * The broad renderer roots preserve the existing visible-copy check.  The
 * boundary roots are deliberately small and correspond to actual user-facing
 * error delivery paths, not an ever-growing allow-list of string literals.
 */
export const I18N_COVERAGE_BOUNDARIES = Object.freeze({
  rendererRoots: [
    'src/App.tsx',
    'src/components',
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
  // 工作流命令里 throw new Error(...) 的说明原样进运行卡片的失败说明：不能是只有中文的原文或主进程转来的原文。
  // 整串的稳定错误码（GENERATION_DRAFT_RECEIPT_INVALID）不在这里拦：登记过的由失败面板按界面语言解释，
  // 其余按 src/i18n/__tests__/generation-error-codes.test.ts 的约定原样留给反馈定位。
  workflowCommandErrorBoundaries: [
    'src/services/workflows/commands',
  ],
  // 命令目录以外的工作流文件抛出的说明同样进运行卡片的失败说明、启动报错或恢复对话框（#471）：不能写只有中文的原文。
  // 这里不拦转出的 .error/.message：这些文件还转出渲染端已按界面语言写好的说明（前置条件守卫的 message、运行记录的 error），
  // 语法上分不开；主进程原文转出由各处改用 workflowMainProcessError 处理。
  workflowErrorBoundaries: [
    'src/services/workflows',
  ],
  // 这些命令连错误码也不能直接抛（#408）：每条失败都要给作者能读的说明。
  strictWorkflowCommandErrorBoundaries: [
    'src/services/workflows/commands/legacy-character-roster-repair.command.ts',
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
  'src/components/editor/use-chapter-blueprints.ts',
  'src/components/editor/review-checklist.ts',
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
  // 工作流命令按运行上下文里冻结的界面语言选文案；uiText 是命令里绑好上下文的简写。
  'workflowUiText',
  'uiText',
  // 批量创作与导入工作流里按冻结界面语言选文案的本地函数。
  'localeText',
  'textForLocale',
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

const isPluralEnCall = (expression, sourceFile) => expression.getText(sourceFile).startsWith('pluralEn(')

/**
 * 英文文案拆成文字与数量位交替的序列（texts 比 slots 多一段）。模板插值 ${n} 是数量位；带参数对象时，
 * 文字里的 {name} 占位符也是（text(中文, '{n} chapters', { n })）。参数对象里写成 pluralEn(...) 的占位符记为已变形的名词。
 */
function englishSlots(node, sourceFile, params) {
  const parts = ts.isTemplateExpression(node)
    ? [node.head.text, ...node.templateSpans.flatMap(span => [{ pluralEn: isPluralEnCall(span.expression, sourceFile) }, span.literal.text])]
    : [node.text]
  const filled = params && ts.isObjectLiteralExpression(params)
    ? new Map(params.properties.filter(property => property.name).map(property => [property.name.getText(sourceFile),
      ts.isPropertyAssignment(property) ? property.initializer : undefined]))
    : undefined
  const texts = [], slots = []
  let current = ''
  for (const part of parts) {
    if (typeof part !== 'string') {
      texts.push(current)
      slots.push(part)
      current = ''
      continue
    }
    let last = 0
    for (const match of params ? part.matchAll(/\{(\w+)\}/g) : []) {
      texts.push(current + part.slice(last, match.index))
      const value = filled?.get(match[1])
      slots.push({ pluralEn: Boolean(value && isPluralEnCall(value, sourceFile)) })
      current = ''
      last = match.index + match[0].length
    }
    current += part.slice(last)
  }
  texts.push(current)
  return { texts, slots }
}

/** text(中文, 英文) 的英文一侧里，`${n} chapters` 与 '{n} chapters' 这类数量后跟固定复数的文案。 */
function inspectEnglishCounts(violations, root, file, sourceFile, node, params) {
  const { texts, slots } = ts.isTemplateExpression(node) || ts.isStringLiteralLike(node)
    ? englishSlots(node, sourceFile, params)
    : { texts: [], slots: [] }
  if (
    slots.some((slot, index) => {
      const before = texts[index], after = texts[index + 1]
      // 「1–${n} chapters」里的数量是范围的终点，永远不是 1
      if (/[-–]$/.test(before)) return false
      // pluralEn(...) 是已经按数量变过的名词，不是数量；但它后面的 have/are 仍随数量变。
      // 数量所在分句里带 and 的是并列主语（the thread and its ${n} confirmed events are removed），本来就用复数动词
      if (slot.pluralEn) {
        return pluralVerbAfterCount.test(after) && !/\band\b[^.;:!?·—\n。：；！？]*$/i.test(texts.slice(0, index + 1).join(' '))
      }
      return fixedPluralAfterCount.test(after) || pluralBeforeCount.test(before) || pluralVerbAfterCount.test(after)
    })
  ) {
    add(violations, root, file, sourceFile, node, node.getText(sourceFile), 'english-plural')
  }
  ts.forEachChild(node, child => inspectEnglishCounts(violations, root, file, sourceFile, child, params))
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
    if (isLocalizedCall(node, sourceFile)) {
      const englishIndex = englishArgumentIndex.get(callName(node, sourceFile)) ?? 1
      const english = node.arguments[englishIndex]
      if (english) inspectEnglishCounts(violations, root, file, sourceFile, english, node.arguments[englishIndex + 1])
    }
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

const errorCode = /^[A-Z][A-Z0-9_]*$/

/** mode：'command' 拦一切未翻译的文字与转出的原文；'chinese' 只拦翻译函数以外的汉字。 */
function inspectThrownErrors(violations, root, file, sourceFile, mode, allowErrorCodes) {
  const bindings = collectBindings(sourceFile)
  const visit = (node) => {
    const thrown = ts.isThrowStatement(node) && node.expression
    const message = thrown && ts.isNewExpression(thrown) && thrown.expression.getText(sourceFile) === 'Error' && thrown.arguments?.[0]
    if (message && mode === 'chinese') {
      inspectVisibleExpression(violations, root, file, sourceFile, message, 'thrown-error')
    } else if (message && !(allowErrorCodes && ts.isStringLiteralLike(message) && errorCode.test(message.text))) {
      inspectBoundaryExpression(violations, root, file, sourceFile, message, 'thrown-error', bindings)
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
      if (relativePath(root, file).split('/').includes('__tests__')) continue
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
  const commandFiles = new Set(I18N_COVERAGE_BOUNDARIES.workflowCommandErrorBoundaries.flatMap(relative => filesAt(path.join(root, relative))))
  const workflowFiles = new Set([...commandFiles, ...I18N_COVERAGE_BOUNDARIES.workflowErrorBoundaries.flatMap(relative => filesAt(path.join(root, relative)))])
  for (const file of workflowFiles) {
    const relativeFile = relativePath(root, file)
    if (!file.endsWith('.ts') || relativeFile.split('/').includes('__tests__')) continue
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const allowErrorCodes = !I18N_COVERAGE_BOUNDARIES.strictWorkflowCommandErrorBoundaries.includes(relativeFile)
    inspectThrownErrors(violations, root, file, sourceFile, commandFiles.has(file) ? 'command' : 'chinese', allowErrorCodes)
  }
  return violations
}

export function runI18nCoverageCheck(root = process.cwd()) {
  const violations = collectI18nCoverageViolations(root)
  if (violations.length > 0) {
    console.error(`Found ${violations.length} unlocalized visible strings:\n${violations.join('\n')}`)
    if (violations.some(violation => violation.includes('[english-plural]'))) console.error(pluralHint)
    return 1
  }
  console.log('i18n coverage check passed: no unlocalized renderer or main-boundary copy')
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runI18nCoverageCheck()
}
