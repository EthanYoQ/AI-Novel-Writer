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
 * workflowUiText（context, 中文, 英文）与工作流文件里的 localeText、textForLocale（locale, 中文, 英文）、Agent 工具的 agentToolText（context, 中文, 英文）在第 3 个，其余在第 2 个。
 */
const englishArgumentIndex = new Map([['localize', 2], ['stepDesc', 2], ['mainText', 2], ['projectError', 2], ['artifactError', 2], ['workflowUiText', 2], ['localeText', 2], ['textForLocale', 2], ['agentToolText', 2]])

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
  // 命令目录以外的工作流文件抛出的说明同样进运行卡片的失败说明、启动报错或恢复对话框（#471）：不能写只有中文的原文，
  // 也不能写只有英文的原文（#474，中文界面会出现英文）。整串的稳定错误码照旧放行。
  // 这里不拦转出的 .error/.message：这些文件还转出渲染端已按界面语言写好的说明（前置条件守卫的 message、运行记录的 error），
  // 语法上分不开；主进程原文转出由各处改用 workflowMainProcessError 处理。
  workflowErrorBoundaries: [
    'src/services/workflows',
  ],
  // 工作流目录以外的渲染层文件（含与主进程共用的 src/shared）抛出的说明会经各处 catch 显示给作者（#474）：
  // 同样不能写只有中文的原文。纯内部断言或只进日志的，在 throw 所在行或上一行写 `// i18n-exempt: <理由>`；
  // 同一个解析或校验函数里的多处可以写在函数声明正上一行。Promise.reject(new Error(...)) 按 throw 算。
  rendererThrowErrorBoundaries: [
    'src',
  ],
  // 渲染层把报错交给作者的显示处（#474）：主进程的 result.error、IPC 抛出的错误与 catch 到的原因
  // 不能原样交给 toast、提示框、报错状态或拼进 text() 的说明，要先经 displayedErrorMessage（或同类翻译函数）：
  // 否则主进程的错误码会以裸码出现在界面上。作者看不到或值本身不是字符串的，写 `// i18n-exempt: <理由>`。
  rendererErrorDisplayBoundaries: [
    'src',
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
  'knownAppErrorMessage',
  // Agent 工具的失败原因按作品写作语言说明。
  'agentToolErrorDetail',
  'localize',
  'translate',
  'stepDesc',
  'appErrorMessage',
  'displayedErrorMessage',
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
  // Agent 工具的说明按作品写作语言选文案（工具结果同时回给模型）。
  'agentToolText',
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

/** 翻译函数以外的拉丁词字面量，即只有英文的说明。整串的错误码与三元的条件不是给作者看的文字。 */
function nodeContainsEnglishCopy(node, sourceFile) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (ts.isConditionalExpression(node)) {
    return nodeContainsEnglishCopy(node.whenTrue, sourceFile) || nodeContainsEnglishCopy(node.whenFalse, sourceFile)
  }
  // result['message'] 的键是属性名，不是文案；只查被访问的值。
  if (ts.isElementAccessExpression(node)) return nodeContainsEnglishCopy(node.expression, sourceFile)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return !errorCode.test(node.text) && latinWord.test(node.text)
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head, ...node.templateSpans.map(span => span.literal)].some(part => latinWord.test(part.text))
      || node.templateSpans.some(span => nodeContainsEnglishCopy(span.expression, sourceFile))
  }
  let found = false
  ts.forEachChild(node, child => {
    if (!found && nodeContainsEnglishCopy(child, sourceFile)) found = true
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
/** 不在 __tests__ 目录里的测试、浏览器测试、Storybook 与类型声明文件也不进界面。 */
const testOrDeclarationFile = /\.(?:test|spec)\.tsx?$|\.browser\.tsx?$|\.stories\.tsx?$|\.d\.ts$/u
const exemptDirective =/\/\/\s*i18n-exempt:(.*)$/u

/**
 * throw 所在行行尾、或紧挨着的上一行（整行注释）的 `// i18n-exempt: <理由>`。
 * 理由是空的也算违规：豁免必须说得出为什么作者看不到。
 */
function exemption(sourceFile, node) {
  const lines = sourceFile.getFullText().split(/\r?\n/u)
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
  const commentLineAbove = (index) => lines[index - 1]?.trimStart().startsWith('//') ? lines[index - 1] : undefined
  const candidates = [lines[line], commentLineAbove(line)]
  // 写在函数声明正上一行的指令覆盖整个函数体：同一个解析或校验函数里的多处 throw 共用一条理由。
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue
    const declaration = ts.isVariableDeclaration(current.parent) ? current.parent.parent.parent : current
    candidates.push(commentLineAbove(sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line))
  }
  for (const text of candidates) {
    const match = text && exemptDirective.exec(text)
    if (match) return match[1].trim() ? 'exempt' : 'missing-reason'
  }
  return undefined
}

/** 显示处：通知与提示框、报错状态的 setter、store 的 set({ error })。 */
const errorDisplayCalls = new Set(['alertError', 'confirm', 'addLog', 'toast.error', 'toast.warning', 'toast.success', 'toast.info'])
const errorStateSetter = /^set\w*(?:Error|Message|Warning|Notice|Failure|Reason)$/u
const errorStateKey = /error|message|warning|reason|notice|^text$/iu
/** 第一个实参是界面语言、其余实参里拼着原因的翻译函数。 */
const textCallees = new Set(['text', 'localize', 'translate', 'workflowUiText', 'uiText', 'localeText', 'textForLocale', 'agentToolText'])

function isCatchVariable(node, sourceFile) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCatchClause(current) && current.variableDeclaration?.name.getText(sourceFile) === node.text) return true
  }
  return false
}

/** 原样转出的报错：String(x)、.error/.warning/.message、catch 到的原因，以及经 const、??、||、三元或模板转一手的。 */
function forwardsRawError(node, sourceFile, bindings, seen = new Set()) {
  if (isLocalizedCall(node, sourceFile)) return false
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return forwardsRawError(node.expression, sourceFile, bindings, seen)
  }
  if (ts.isCallExpression(node)) return callName(node, sourceFile) === 'String'
  if (ts.isPropertyAccessExpression(node)) return ['error', 'warning', 'message'].includes(node.name.text)
  if (ts.isIdentifier(node)) {
    if (isCatchVariable(node, sourceFile)) return true
    if (seen.has(node.text)) return false
    const initializer = bindings.get(node.text)
    if (!initializer) return false
    seen.add(node.text)
    return forwardsRawError(initializer, sourceFile, bindings, seen)
  }
  if (ts.isBinaryExpression(node) && ['??', '||'].includes(node.operatorToken.getText(sourceFile))) {
    return forwardsRawError(node.left, sourceFile, bindings, seen) || forwardsRawError(node.right, sourceFile, bindings, seen)
  }
  if (ts.isConditionalExpression(node)) {
    return forwardsRawError(node.whenTrue, sourceFile, bindings, seen) || forwardsRawError(node.whenFalse, sourceFile, bindings, seen)
  }
  if (ts.isTemplateExpression(node)) return node.templateSpans.some(span => forwardsRawError(span.expression, sourceFile, bindings, seen))
  return false
}

function inspectRawErrorDisplays(violations, root, file, sourceFile) {
  const bindings = collectBindings(sourceFile)
  const report = (node, value, kind) => {
    const exempt = exemption(sourceFile, node)
    if (exempt === 'missing-reason') add(violations, root, file, sourceFile, node, value.getText(sourceFile), 'exempt-without-reason')
    else if (!exempt) add(violations, root, file, sourceFile, node, value.getText(sourceFile), kind)
  }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node, sourceFile)
      const [first] = node.arguments
      // get().addLog、useWorkflowStore.getState().addLog 这类成员调用也是日志显示处。
      const isAddLog = name === 'addLog' || name.endsWith('.addLog')
      if (isAddLog || errorDisplayCalls.has(name) || (ts.isIdentifier(node.expression) && errorStateSetter.test(name))) {
        const values = isAddLog ? node.arguments.slice(1, 2) : first ? [first] : []
        for (const value of values) {
          const forwarded = ts.isObjectLiteralExpression(value)
            ? value.properties.find(property => ts.isPropertyAssignment(property) && errorStateKey.test(property.name.getText(sourceFile))
              && forwardsRawError(property.initializer, sourceFile, bindings))
            : forwardsRawError(value, sourceFile, bindings) && value
          if (forwarded) report(node, forwarded, `raw-error-display:${name}`)
        }
      }
      if ((name === 'set' || name.endsWith('.setState')) && first && ts.isObjectLiteralExpression(first)) {
        for (const property of first.properties) {
          if (ts.isPropertyAssignment(property) && errorStateKey.test(property.name.getText(sourceFile))
            && forwardsRawError(property.initializer, sourceFile, bindings)) report(property, property.initializer, 'raw-error-display:state')
        }
      }
      if (textCallees.has(name) || name.endsWith('.text')) {
        const spans = node.arguments.flatMap(argument => ts.isTemplateExpression(argument)
          ? argument.templateSpans.map(span => span.expression)
          : ts.isObjectLiteralExpression(argument)
            ? argument.properties.filter(ts.isPropertyAssignment).map(property => property.initializer)
            : [])
        const forwarded = spans.find(span => forwardsRawError(span, sourceFile, bindings))
        if (forwarded) report(node, forwarded, `raw-error-display:${name}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

/**
 * mode：'command' 拦一切未翻译的文字与转出的原文；'untranslated' 拦翻译函数以外的汉字与拉丁词，不拦转出的原文；
 * 'chinese' 只拦翻译函数以外的汉字。
 */
function inspectThrownErrors(violations, root, file, sourceFile, mode, allowErrorCodes) {
  const bindings = collectBindings(sourceFile)
  const visit = (node) => {
    // Promise.reject(new Error(...)) 与 throw 同样把说明交给调用方的 catch。
    const thrown = ts.isThrowStatement(node) ? node.expression
      : ts.isCallExpression(node) && callName(node, sourceFile) === 'Promise.reject' && node.arguments[0]
    const message = thrown && ts.isNewExpression(thrown) && thrown.expression.getText(sourceFile) === 'Error' && thrown.arguments?.[0]
    const exempt = message && exemption(sourceFile, node)
    if (exempt === 'missing-reason') {
      add(violations, root, file, sourceFile, node, message.getText(sourceFile), 'exempt-without-reason')
    } else if (exempt) {
      // 写明理由的豁免：作者看不到这条说明。
    } else if (message && mode === 'chinese') {
      inspectVisibleExpression(violations, root, file, sourceFile, message, 'thrown-error')
    } else if (message && mode === 'untranslated') {
      if (nodeContainsHan(message, sourceFile) || nodeContainsEnglishCopy(message, sourceFile)) {
        add(violations, root, file, sourceFile, message, message.getText(sourceFile), 'thrown-error')
      }
    } else if (message && !(allowErrorCodes && ts.isStringLiteralLike(message) && errorCode.test(message.text))) {
      inspectBoundaryExpression(violations, root, file, sourceFile, message, 'thrown-error', bindings)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

/**
 * 主进程（electron/）只有中文的报错（#474）。现存的按「文件 → 所在函数 → 处数」记在基线里，不记行号：
 * 处数超过基线（新增）失败；低于基线（已修）也失败，要求运行 --update-baseline 把基线收紧，基线只减不增。
 * 作者看不到的写 `// i18n-exempt: <理由>`，规则与渲染层相同。
 */
export const MAIN_ERROR_BASELINE_PATH = 'scripts/i18n-main-error-baseline.json'
const MAIN_ERROR_ROOT = 'electron'
const mainErrorProperties = new Set(['error', 'warning', 'reason', 'errorMessage'])
const mainLocalizationCallees = new Set([...localizationCallees, 'mainT', 'importText'])

function isMainLocalized(node, sourceFile) {
  if (ts.isCallExpression(node)) {
    const callee = callName(node, sourceFile)
    if (mainLocalizationCallees.has(callee) || callee.endsWith('.text')) return true
  }
  // locale === 'en-US' ? 英文 : 中文 这类按语言的三元。
  return ts.isConditionalExpression(node) && /locale|en-US|zh-CN/iu.test(node.condition.getText(sourceFile))
}

function mainContainsHan(node, sourceFile) {
  if (isMainLocalized(node, sourceFile)) return false
  if (literalContainsHan(node)) return true
  let found = false
  ts.forEachChild(node, child => {
    if (!found && mainContainsHan(child, sourceFile)) found = true
  })
  return found
}

const isFunctionWithBody = node => ts.isFunctionLike(node) && Boolean(node.body)

function ownFunctionName(fn) {
  if (fn.name) return fn.name.getText()
  const parent = fn.parent
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name) {
    return parent.name.getText()
  }
  return '<anonymous>'
}

/** 报错所在的最外层具名函数（类方法带类名）；IPC handler 这类回调归到注册它的函数里，模块顶层记为 <module>。 */
function mainErrorOwner(node) {
  let owner
  for (let current = node.parent; current; current = current.parent) {
    if (isFunctionWithBody(current) && (!owner || ts.isSourceFile(current.parent) || ts.isClassDeclaration(current.parent) || ts.isVariableDeclaration(current.parent))) {
      owner = ownFunctionName(current)
    }
    if (ts.isClassDeclaration(current) && current.name && owner) return `${current.name.text}.${owner}`
  }
  return owner ?? '<module>'
}

function insideConsoleCall(node, sourceFile) {
  for (let current = node.parent; current && !isFunctionWithBody(current); current = current.parent) {
    if (ts.isCallExpression(current) && callName(current, sourceFile).startsWith('console.')) return true
  }
  return false
}

/** 与 #474 盘点脚本同一口径：throw、reject(...)、dialog.show*、单独构造的 new XxxError(...) 与 error/warning/reason/errorMessage 属性。 */
function collectMainErrorSites(root, violations) {
  const sites = []
  for (const file of filesAt(path.join(root, MAIN_ERROR_ROOT))) {
    const relativeFile = relativePath(root, file)
    if (!/\.tsx?$/u.test(file) || testOrDeclarationFile.test(file) || relativeFile.split('/').includes('__tests__')) continue
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const counted = new Set()
    const record = (node, reported = node) => {
      const exempt = exemption(sourceFile, node)
      if (exempt === 'missing-reason') {
        add(violations, root, file, sourceFile, node, reported.getText(sourceFile), 'exempt-without-reason')
      } else if (!exempt) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
        sites.push({ file: relativeFile, owner: mainErrorOwner(node), line, text: reported.getText(sourceFile).trim().replace(/\s+/g, ' ') })
      }
    }
    const visit = (node) => {
      if (ts.isThrowStatement(node) && node.expression && mainContainsHan(node.expression, sourceFile)) {
        record(node, node.expression)
        counted.add(node.expression)
      } else if (ts.isCallExpression(node) && /(?:^|\.)reject$/u.test(callName(node, sourceFile)) && node.arguments.some(argument => mainContainsHan(argument, sourceFile))) {
        record(node)
        node.arguments.forEach(argument => counted.add(argument))
      } else if (ts.isCallExpression(node) && /dialog\.show(?:ErrorBox|MessageBox|MessageBoxSync)$/u.test(callName(node, sourceFile)) && node.arguments.some(argument => mainContainsHan(argument, sourceFile))) {
        record(node)
      } else if (ts.isNewExpression(node) && /Error$/u.test(node.expression.getText(sourceFile)) && !counted.has(node)
        && node.arguments?.some(argument => mainContainsHan(argument, sourceFile)) && !insideConsoleCall(node, sourceFile)) {
        let parent = node.parent
        while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) parent = parent.parent
        if (!(parent && ts.isThrowStatement(parent))) record(node)
      } else if (ts.isPropertyAssignment(node) && mainErrorProperties.has(node.name.getText(sourceFile))
        && mainContainsHan(node.initializer, sourceFile) && !insideConsoleCall(node, sourceFile)) {
        record(node, node.initializer)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return sites
}

function countMainErrorSites(sites) {
  const counts = {}
  for (const site of [...sites].sort((left, right) => left.file.localeCompare(right.file) || left.owner.localeCompare(right.owner))) {
    counts[site.file] ??= {}
    counts[site.file][site.owner] = (counts[site.file][site.owner] ?? 0) + 1
  }
  return counts
}

function readMainErrorBaseline(root) {
  const file = path.join(root, MAIN_ERROR_BASELINE_PATH)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).files ?? {} : {}
}

const updateBaselineCommand = `node scripts/check-i18n-coverage.mjs --update-baseline`

/** 对照基线：新增的逐处列出；减少或已清零的要求收紧基线。 */
function compareMainErrorBaseline(sites, baseline, violations) {
  const counts = countMainErrorSites(sites)
  for (const [file, owners] of Object.entries(counts)) {
    for (const [owner, count] of Object.entries(owners)) {
      const allowed = baseline[file]?.[owner] ?? 0
      if (count <= allowed) continue
      for (const site of sites.filter(candidate => candidate.file === file && candidate.owner === owner)) {
        violations.push(`${site.file}:${site.line} [main-error] ${site.text}`)
      }
      violations.push(`${file} ${owner}: ${count} Chinese-only main-process error(s), baseline allows ${allowed}. Throw a registered error code, localize with mainText, or add \`// i18n-exempt: <reason>\`.`)
    }
  }
  for (const [file, owners] of Object.entries(baseline)) {
    for (const [owner, allowed] of Object.entries(owners)) {
      const count = counts[file]?.[owner] ?? 0
      if (count < allowed) {
        violations.push(`${file} ${owner}: baseline allows ${allowed} Chinese-only main-process error(s) but ${count} remain [main-error-baseline-stale]. Tighten the baseline: ${updateBaselineCommand}`)
      }
    }
  }
  return counts
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
    inspectThrownErrors(violations, root, file, sourceFile, commandFiles.has(file) ? 'command' : 'untranslated', allowErrorCodes)
  }
  const rendererThrowFiles = new Set(I18N_COVERAGE_BOUNDARIES.rendererThrowErrorBoundaries.flatMap(relative => filesAt(path.join(root, relative))))
  for (const file of rendererThrowFiles) {
    if (workflowFiles.has(file) || !/\.tsx?$/u.test(file) || testOrDeclarationFile.test(file)) continue
    if (relativePath(root, file).split('/').includes('__tests__')) continue
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    inspectThrownErrors(violations, root, file, sourceFile, 'chinese', true)
  }
  for (const file of new Set(I18N_COVERAGE_BOUNDARIES.rendererErrorDisplayBoundaries.flatMap(relative => filesAt(path.join(root, relative))))) {
    const relativeFile = relativePath(root, file)
    if (!/\.tsx?$/u.test(file) || testOrDeclarationFile.test(file) || relativeFile.split('/').includes('__tests__')) continue
    const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    inspectRawErrorDisplays(violations, root, file, sourceFile)
  }
  compareMainErrorBaseline(collectMainErrorSites(root, violations), readMainErrorBaseline(root), violations)
  return violations
}

/** 把基线收紧到当前处数。只减不增：有函数处数超过基线时拒绝写入。 */
export function updateMainErrorBaseline(root = process.cwd()) {
  const violations = []
  const sites = collectMainErrorSites(root, violations)
  const counts = compareMainErrorBaseline(sites, readMainErrorBaseline(root), violations)
  const blocking = violations.filter(violation => !violation.includes('[main-error-baseline-stale]'))
  // 没有基线文件时是首次建立：现存的全部记入。
  if (blocking.length > 0 && fs.existsSync(path.join(root, MAIN_ERROR_BASELINE_PATH))) {
    console.error(`Refusing to raise the main-process error baseline:\n${blocking.join('\n')}`)
    return 1
  }
  const total = Object.values(counts).flatMap(owners => Object.values(owners)).reduce((sum, count) => sum + count, 0)
  const baseline = {
    description: 'electron/ 里只有中文、尚未改成错误码或按语言文案的报错（#474）。按文件与所在函数计数，只减不增；由 node scripts/check-i18n-coverage.mjs --update-baseline 生成。',
    total,
    files: counts,
  }
  const baselineFile = path.join(root, MAIN_ERROR_BASELINE_PATH)
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true })
  fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  console.log(`Main-process error baseline written: ${total} site(s) in ${Object.keys(counts).length} file(s)`)
  return 0
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

/** 逐处列出 electron/ 里只有中文的报错（文件:行、所在函数、原文），供清理与复核。 */
export function listMainErrorSites(root = process.cwd()) {
  const sites = collectMainErrorSites(root, [])
  for (const site of sites) console.log([`${site.file}:${site.line}`, site.owner, site.text].join('\t'))
  console.log(`${sites.length} Chinese-only main-process error site(s)`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--update-baseline')) process.exitCode = updateMainErrorBaseline()
  else if (process.argv.includes('--list-main-errors')) process.exitCode = listMainErrorSites()
  else process.exitCode = runI18nCoverageCheck()
}
