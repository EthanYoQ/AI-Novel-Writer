#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import {
  buildFocusedReviewMessages,
  parseFocusedReviewOutput,
} from "./lib/continuity-calibration.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CACHE_ROOT = path.join(ROOT, ".runtime", ".cache")
const SOURCE_SHA = "b96e102657a462b13e579bf2d98cd263e879fd84"
const BASE_URL = "https://api.siliconflow.cn/v1"
const MODEL = "deepseek-ai/DeepSeek-V4-Flash"
const TEMPERATURE = 0.7
const MAX_TOKENS = 16384
const MAX_REQUESTS = 20
const TIMEOUT_MS = 180000
const REVIEW_FOCUS = "只检查内容连续性与本章作者要求；不检查字数或个人风格偏好"

class PublicError extends Error {
  constructor(code, message) {
    super(code)
    this.code = code
    this.publicMessage = message
  }
}

function reject(code, message) {
  throw new PublicError(code, message)
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function encodeJson(value) {
  return JSON.stringify(value, null, 2) + "\n"
}

async function saveJson(filePath, value) {
  await writeFile(filePath, encodeJson(value), "utf8")
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireExactKeys(value, allowed, label) {
  if (!isObject(value)) reject("INVALID_INPUT", label + " 必须是对象")
  const extras = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extras.length) reject("INVALID_INPUT", label + " 含未许可字段：" + extras.join(", "))
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    reject("INVALID_INPUT", label + " 必须是非空字符串")
  }
  return value
}

function normalizeDocument(value, label) {
  requireExactKeys(value, ["id", "text"], label)
  return {
    id: requireText(value.id, label + ".id").trim(),
    text: requireText(value.text, label + ".text"),
  }
}

function normalizePacket(value, label) {
  requireExactKeys(value, ["authorRequirements", "sources", "chapter", "originalChapter"], label)
  const authorRequirements = Array.isArray(value.authorRequirements)
    ? value.authorRequirements.map((item, index) => requireText(item, label + ".authorRequirements[" + index + "]"))
    : requireText(value.authorRequirements, label + ".authorRequirements")
  if (Array.isArray(authorRequirements) && !authorRequirements.length) {
    reject("INVALID_INPUT", label + ".authorRequirements 不能为空")
  }
  if (!Array.isArray(value.sources)) reject("INVALID_INPUT", label + ".sources 必须是数组")
  const packet = {
    authorRequirements,
    sources: value.sources.map((item, index) => normalizeDocument(item, label + ".sources[" + index + "]")),
    chapter: normalizeDocument(value.chapter, label + ".chapter"),
  }
  if (value.originalChapter !== undefined) {
    packet.originalChapter = normalizeDocument(value.originalChapter, label + ".originalChapter")
  }
  return packet
}

function normalizeFixtures(value) {
  requireExactKeys(value, ["schemaVersion", "cases"], "fixtures")
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    reject("INVALID_INPUT", "fixtures schemaVersion 不支持")
  }
  if (!Array.isArray(value.cases) || !value.cases.length) {
    reject("INVALID_INPUT", "fixtures.cases 必须是非空数组")
  }
  const ids = new Set()
  const cases = value.cases.map((item, index) => {
    const label = "fixtures.cases[" + index + "]"
    requireExactKeys(item, ["id", "packet"], label)
    const id = requireText(item.id, label + ".id").trim()
    if (ids.has(id)) reject("INVALID_INPUT", "case id 重复：" + id)
    ids.add(id)
    const packet = normalizePacket(item.packet, label + ".packet")
    try {
      buildFocusedReviewMessages(packet)
    } catch {
      reject("INVALID_INPUT", "case " + id + " 的资料 id 或 focused packet 无效")
    }
    return { id, packet }
  })
  if (cases.length * 2 > MAX_REQUESTS) {
    reject("REQUEST_LIMIT", "计划请求 " + cases.length * 2 + " 次，超过上限 " + MAX_REQUESTS)
  }
  return { cases }
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value)
    url.hash = ""
    url.search = ""
    url.pathname = url.pathname.replace(/\/+$/u, "")
    return url.toString().replace(/\/$/u, "")
  } catch {
    return ""
  }
}

function selectModel(value) {
  if (!Array.isArray(value)) reject("INVALID_MODELS", "models-source 必须是模型配置数组")
  const matches = value.filter((profile) => (
    isObject(profile)
    && profile.protocol === "openai"
    && profile.modelName === MODEL
    && normalizeBaseUrl(profile.baseUrl) === BASE_URL
  ))
  if (matches.length !== 1) {
    reject("MODEL_SELECTION", "必须且只能匹配一个指定 SiliconFlow V4 配置，实际 " + matches.length + " 个")
  }
  if (typeof matches[0].apiKey !== "string" || !matches[0].apiKey.trim()) {
    reject("MODEL_SELECTION", "匹配的模型配置缺少 API Key")
  }
  if (matches[0].temperature !== TEMPERATURE || matches[0].maxTokens !== MAX_TOKENS) {
    reject("MODEL_SELECTION", "本轮冻结参数与当前配置不同，已拒绝静默覆盖")
  }
  return matches[0]
}

async function readJson(filePath, label) {
  try {
    const bytes = await readFile(filePath)
    return { bytes, value: JSON.parse(bytes.toString("utf8")) }
  } catch {
    reject("INVALID_JSON", label + " 无法读取或不是有效 JSON")
  }
}

function parseArgs(argv) {
  const values = new Map()
  let execute = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") return { help: true }
    if (arg === "--execute") {
      if (execute) reject("INVALID_ARGS", "--execute 不能重复")
      execute = true
      continue
    }
    if (!["--fixtures", "--models-source", "--output"].includes(arg)) {
      reject("INVALID_ARGS", "未知参数：" + arg)
    }
    if (values.has(arg)) reject("INVALID_ARGS", arg + " 不能重复")
    const next = argv[index + 1]
    if (!next || next.startsWith("--")) reject("INVALID_ARGS", arg + " 缺少值")
    values.set(arg, next)
    index += 1
  }
  for (const name of ["--fixtures", "--models-source", "--output"]) {
    if (!values.has(name)) reject("INVALID_ARGS", "缺少 " + name)
  }
  return {
    execute,
    fixturesPath: path.resolve(values.get("--fixtures")),
    modelsPath: path.resolve(values.get("--models-source")),
    outputPath: path.resolve(values.get("--output")),
  }
}

function printUsage() {
  console.log("用法：node scripts/run-continuity-calibration.mjs --fixtures <inputs.json> --models-source <models.json> --output <.runtime/.cache/新目录> [--execute]")
  console.log("先省略 --execute 准备并检查 prompt；确认后在同一目录显式 --execute 一次。")
}

async function requireOutputBoundary(outputPath, mustExist) {
  const cacheRoot = await realpath(CACHE_ROOT).catch(() => reject("OUTPUT_BOUNDARY", "当前工作树 .runtime/.cache 不存在"))
  if (mustExist && !existsSync(outputPath)) reject("OUTPUT_MISSING", "--execute 要求已准备的 output 目录")
  if (!mustExist && existsSync(outputPath)) reject("OUTPUT_EXISTS", "prepare 的 --output 必须是新目录")
  const target = mustExist ? await realpath(outputPath) : outputPath
  const parent = mustExist
    ? target
    : await realpath(path.dirname(outputPath)).catch(() => reject("OUTPUT_BOUNDARY", "--output 父目录必须已存在"))
  const relative = path.relative(cacheRoot, parent)
  if (relative.startsWith("..") || path.isAbsolute(relative) || parent === cacheRoot && mustExist) {
    reject("OUTPUT_BOUNDARY", "--output 必须是当前工作树 .runtime/.cache 下的子目录")
  }
  return target
}

function currentSourceSha() {
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim()
  } catch {
    reject("SOURCE_DRIFT", "无法核对生产源码 SHA")
  }
}

async function bundleProductionPrompt(outputPath) {
  verifyProductionBaseline()
  const bundlePath = path.join(outputPath, "baseline-production-prompt.cjs")
  try {
    await build({
      stdin: {
        contents: [
          "export { ReviewPromptBuilder } from './src/services/prompts/prompt-builder.ts'",
          "export { getBuiltinPromptTemplate } from './src/services/prompt-templates.ts'",
        ].join("\n"),
        loader: "ts",
        resolveDir: ROOT,
        sourcefile: "continuity-calibration-production-entry.ts",
      },
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node20",
      logLevel: "silent",
    })
    const loaded = createRequire(import.meta.url)(bundlePath)
    const template = loaded.getBuiltinPromptTemplate("consistency_check", "zh-CN")
    if (!template) reject("BASELINE_BUILD", "生产 consistency_check 模板不存在")
    return { ReviewPromptBuilder: loaded.ReviewPromptBuilder, template }
  } catch (error) {
    if (error instanceof PublicError) throw error
    reject("BASELINE_BUILD", "无法从生产源码构建 baseline prompt")
  }
}

function verifyProductionBaseline() {
  try {
    execFileSync("git", ["-C", ROOT, "diff", "--exit-code", SOURCE_SHA, "--", "src"], {
      stdio: "ignore", windowsHide: true,
    })
  } catch {
    reject("SOURCE_DRIFT", "生产 src 与批准的 b96e102 基线不同")
  }
}

async function implementationHashes() {
  const files = ["scripts/run-continuity-calibration.mjs", "scripts/lib/continuity-calibration.mjs"]
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha256(await readFile(path.join(ROOT, file)))])))
}

function buildBaselineMessages(packet, production) {
  const sources = packet.sources.map((source) => (
    "【资料 " + source.id + "】\n" + source.text
  )).join("\n\n")
  const builder = new production.ReviewPromptBuilder(production.template, "zh-CN")
    .withGlobalSummary(sources)
    .withChapterContent(packet.chapter.text)
    .withWorldBuilding("")
    .withCharacterStates("")
    .withReviewFocus(REVIEW_FOCUS)
  const requirements = Array.isArray(packet.authorRequirements)
    ? packet.authorRequirements.join("\n")
    : packet.authorRequirements
  const sections = [
    builder.build(),
    "【本章作者要求 authorRequirements】\n" + requirements,
  ]
  if (packet.originalChapter) {
    sections.push("【原稿 " + packet.originalChapter.id + "】\n" + packet.originalChapter.text)
  }
  return [
    { role: "system", content: builder.getSystemRole() },
    { role: "user", content: sections.join("\n\n") },
  ]
}

function requestDescription() {
  return {
    provider: "siliconflow",
    protocol: "openai",
    baseUrl: BASE_URL,
    modelName: MODEL,
    temperature: TEMPERATURE,
    maxTokens: MAX_TOKENS,
    stream: true,
    responseFormat: { type: "json_object" },
    timeoutMs: TIMEOUT_MS,
  }
}

function requestBody(messages) {
  return {
    model: MODEL,
    messages,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
    response_format: { type: "json_object" },
  }
}

function safeDirectory(index, id) {
  const slug = id.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "case"
  return String(index + 1).padStart(2, "0") + "-" + slug
}

async function prepare(args, fixturesRead, fixtures, modelsRead) {
  await requireOutputBoundary(args.outputPath, false)
  await mkdir(args.outputPath)
  const production = await bundleProductionPrompt(args.outputPath)
  const cases = fixtures.cases.map((fixture, index) => {
    const baseline = buildBaselineMessages(fixture.packet, production)
    const focused = buildFocusedReviewMessages(fixture.packet)
    return {
      id: fixture.id,
      packetSha256: sha256(JSON.stringify(fixture.packet)),
      directory: safeDirectory(index, fixture.id),
      arms: {
        baseline: { messages: baseline, promptSha256: sha256(JSON.stringify(baseline)) },
        focused: { messages: focused, promptSha256: sha256(JSON.stringify(focused)) },
      },
    }
  })
  const modelsHash = sha256(modelsRead.bytes)
  const prepared = {
    schemaVersion: 1,
    scope: "prompt级离线影子对比；非完整生产ReviewCommand验收，不调用IPC、不保存review、不定稿",
    sourceCommit: SOURCE_SHA,
    calibrationCommit: currentSourceSha(),
    implementationHashes: await implementationHashes(),
    baselineBundleSha256: sha256(await readFile(path.join(args.outputPath, "baseline-production-prompt.cjs"))),
    fixturesSha256: sha256(fixturesRead.bytes),
    modelsSourceSha256: modelsHash,
    requestsPlanned: cases.length * 2,
    requestLimit: MAX_REQUESTS,
    request: requestDescription(),
    cases,
  }
  const preparedBytes = Buffer.from(encodeJson(prepared))
  await writeFile(path.join(args.outputPath, "prepared.json"), preparedBytes)
  await saveJson(path.join(args.outputPath, "manifest.json"), {
    schemaVersion: 1,
    status: "prepared",
    executionRequested: false,
    sourceCommit: SOURCE_SHA,
    preparedSha256: sha256(preparedBytes),
    fixturesSha256: prepared.fixturesSha256,
    modelsSourceHashBefore: modelsHash,
    modelsSourceHashAfter: modelsHash,
    modelsSourceUnchanged: true,
    requestsPlanned: prepared.requestsPlanned,
    physicalRequestsStarted: 0,
    physicalRequestsCompleted: 0,
    results: [],
  })
  console.log("prepared: " + args.outputPath)
}

function validatePrepared(prepared, fixtures, fixturesHash, modelsHash) {
  if (!isObject(prepared)
    || prepared.sourceCommit !== SOURCE_SHA
    || prepared.fixturesSha256 !== fixturesHash
    || prepared.modelsSourceSha256 !== modelsHash
    || prepared.requestsPlanned !== fixtures.cases.length * 2
    || prepared.requestsPlanned > MAX_REQUESTS
    || !Array.isArray(prepared.cases)
    || prepared.cases.length !== fixtures.cases.length) {
    reject("PREPARED_MISMATCH", "冻结的 prepared 输入与本次参数不匹配")
  }
  for (let index = 0; index < fixtures.cases.length; index += 1) {
    const expected = fixtures.cases[index]
    const stored = prepared.cases[index]
    if (!isObject(stored)
      || stored.id !== expected.id
      || stored.packetSha256 !== sha256(JSON.stringify(expected.packet))
      || !isObject(stored.arms)) {
      reject("PREPARED_MISMATCH", "冻结案例与本次 fixtures 不匹配")
    }
    for (const arm of ["baseline", "focused"]) {
      const entry = stored.arms[arm]
      if (!isObject(entry)
        || !Array.isArray(entry.messages)
        || entry.promptSha256 !== sha256(JSON.stringify(entry.messages))) {
        reject("PREPARED_MISMATCH", "冻结 prompt 已变化")
      }
    }
  }
}

function usageOf(value) {
  if (!isObject(value)) return null
  const result = {
    promptTokens: Number.isFinite(value.prompt_tokens) ? value.prompt_tokens : null,
    completionTokens: Number.isFinite(value.completion_tokens) ? value.completion_tokens : null,
    totalTokens: Number.isFinite(value.total_tokens) ? value.total_tokens : null,
  }
  return Object.values(result).every((item) => item === null) ? null : result
}

function finishReasonOf(value) {
  return ["stop", "length", "content_filter"].includes(value) ? value : "unknown"
}

async function consumeSse(response, receipt, receiptPath, signal) {
  if (!response.body) reject("EMPTY_STREAM", "供应商未返回 SSE 流")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let doneMarker = false
  let lastSavedAt = 0

  const processEvent = async (event) => {
    const data = event.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim()
    if (!data) return
    if (data === "[DONE]") {
      doneMarker = true
      return
    }
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      reject("MALFORMED_SSE", "SSE 包含无法解析的数据")
    }
    if (!isObject(payload) || Object.hasOwn(payload, "error")) {
      reject("PROVIDER_STREAM_ERROR", "供应商在 SSE 中返回错误")
    }
    const usage = usageOf(payload.usage)
    if (usage) receipt.response.usage = usage
    if (Array.isArray(payload.choices) && isObject(payload.choices[0])) {
      const choice = payload.choices[0]
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        receipt.response.finishReason = finishReasonOf(choice.finish_reason)
      }
      if (isObject(choice.delta) && typeof choice.delta.content === "string") {
        receipt.response.content += choice.delta.content
      }
    }
    if (Date.now() - lastSavedAt >= 1000 || receipt.response.finishReason) {
      await saveJson(receiptPath, receipt)
      lastSavedAt = Date.now()
    }
  }

  while (true) {
    if (signal.aborted) reject("TIMEOUT", "请求超时")
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let separator = /\r?\n\r?\n/u.exec(buffer)
    while (separator) {
      const event = buffer.slice(0, separator.index)
      buffer = buffer.slice(separator.index + separator[0].length)
      await processEvent(event)
      separator = /\r?\n\r?\n/u.exec(buffer)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) await processEvent(buffer)
  return doneMarker
}

async function callArm(input) {
  const receiptPath = path.join(input.casePath, input.arm + ".json")
  const startedAt = Date.now()
  const receipt = {
    schemaVersion: 1,
    status: "requesting",
    caseId: input.caseId,
    arm: input.arm,
    requestOrdinal: input.ordinal,
    attempt: 1,
    requestStartedAt: new Date(startedAt).toISOString(),
    request: requestDescription(),
    promptSha256: sha256(JSON.stringify(input.messages)),
    messages: input.messages,
    response: {
      httpStatus: null,
      finishReason: null,
      usage: null,
      durationMs: null,
      content: "",
    },
    focusedMechanicalValidation: null,
  }
  await saveJson(receiptPath, receipt)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + input.profile.apiKey,
      },
      body: JSON.stringify(requestBody(input.messages)),
      signal: controller.signal,
    })
    receipt.response.httpStatus = response.status
    await saveJson(receiptPath, receipt)
    if (!response.ok) reject("HTTP_ERROR", "供应商返回 HTTP " + response.status)
    const doneMarker = await consumeSse(response, receipt, receiptPath, controller.signal)
    if (!doneMarker) reject("INCOMPLETE_SSE", "SSE 未收到完成标记")
    if (receipt.response.finishReason !== "stop") {
      reject("ABNORMAL_FINISH", "请求未正常结束：" + (receipt.response.finishReason || "unknown"))
    }
    if (input.arm === "focused") {
      receipt.focusedMechanicalValidation = parseFocusedReviewOutput(receipt.response.content, input.packet)
    }
    receipt.status = "completed"
  } catch (error) {
    const timedOut = controller.signal.aborted
    receipt.status = timedOut ? "timeout" : "failed"
    receipt.error = {
      code: timedOut ? "TIMEOUT" : error instanceof PublicError ? error.code : "NETWORK_ERROR",
      message: timedOut
        ? "请求超时"
        : error instanceof PublicError
          ? error.publicMessage
          : "网络请求失败（未输出原始异常）",
    }
  } finally {
    clearTimeout(timer)
    receipt.response.durationMs = Date.now() - startedAt
    await saveJson(receiptPath, receipt)
  }
  return { status: receipt.status, httpStatus: receipt.response.httpStatus, receipt: path.basename(receiptPath) }
}

async function execute(args, fixturesRead, fixtures, modelsRead, profile) {
  const outputPath = await requireOutputBoundary(args.outputPath, true)
  verifyProductionBaseline()
  const preparedRead = await readJson(path.join(outputPath, "prepared.json"), "prepared")
  const manifestRead = await readJson(path.join(outputPath, "manifest.json"), "manifest")
  const manifest = manifestRead.value
  if (!isObject(manifest)
    || manifest.status !== "prepared"
    || manifest.executionRequested !== false
    || manifest.physicalRequestsStarted !== 0
    || manifest.preparedSha256 !== sha256(preparedRead.bytes)) {
    reject("ALREADY_EXECUTED", "该 output 未准备好或已经执行过，已拒绝再次请求")
  }
  const fixturesHash = sha256(fixturesRead.bytes)
  const modelsHash = sha256(modelsRead.bytes)
  validatePrepared(preparedRead.value, fixtures, fixturesHash, modelsHash)
  if (preparedRead.value.calibrationCommit !== currentSourceSha()
    || JSON.stringify(preparedRead.value.implementationHashes) !== JSON.stringify(await implementationHashes())
    || preparedRead.value.baselineBundleSha256 !== sha256(await readFile(path.join(outputPath, "baseline-production-prompt.cjs")))) {
    reject("SOURCE_DRIFT", "准备后实验代码或 baseline bundle 已变化")
  }
  try {
    await writeFile(path.join(outputPath, "execute.lock"), "one calibration run\n", { flag: "wx" })
  } catch {
    reject("ALREADY_EXECUTED", "执行权已经领取，已拒绝重复请求")
  }

  manifest.status = "running"
  manifest.executionRequested = true
  manifest.modelsSourceHashBefore = modelsHash
  manifest.modelsSourceHashAfter = null
  manifest.modelsSourceUnchanged = null
  await saveJson(path.join(outputPath, "manifest.json"), manifest)

  let ordinal = 0
  for (let index = 0; index < fixtures.cases.length; index += 1) {
    const fixture = fixtures.cases[index]
    const preparedCase = preparedRead.value.cases[index]
    const casePath = path.join(outputPath, preparedCase.directory)
    await mkdir(casePath)
    const result = { id: fixture.id, directory: preparedCase.directory, arms: {} }
    const arms = index % 2 === 0 ? ["baseline", "focused"] : ["focused", "baseline"]
    const dispatches = arms.map((arm) => {
      ordinal += 1
      if (ordinal > MAX_REQUESTS) reject("REQUEST_LIMIT", "物理请求上限已触发")
      return {
        arm,
        caseId: fixture.id,
        casePath,
        ordinal,
        messages: preparedCase.arms[arm].messages,
        packet: fixture.packet,
        profile,
      }
    })
    manifest.physicalRequestsStarted = ordinal
    await saveJson(path.join(outputPath, "manifest.json"), manifest)
    const armResults = await Promise.all(dispatches.map(callArm))
    for (let armIndex = 0; armIndex < arms.length; armIndex += 1) {
      const arm = arms[armIndex]
      const armResult = armResults[armIndex]
      result.arms[arm] = armResult
      if (armResult.status === "completed") manifest.physicalRequestsCompleted += 1
    }
    manifest.results.push(result)
    await saveJson(path.join(outputPath, "manifest.json"), manifest)
    console.log(JSON.stringify({ caseId: fixture.id, started: ordinal, completed: manifest.physicalRequestsCompleted, arms: result.arms }))
    if (armResults.some((item) => [401, 403].includes(item.httpStatus))
      || armResults.every((item) => item.status !== "completed")) {
      manifest.stopReason = "授权失败或双臂传输失败；未执行的后续案例不计通过"
      break
    }
  }

  let modelsAfter = null
  try {
    modelsAfter = sha256(await readFile(args.modelsPath))
  } catch {
    // The unchanged check fails closed without exposing the raw filesystem error.
  }
  manifest.modelsSourceHashAfter = modelsAfter
  manifest.modelsSourceUnchanged = modelsAfter === modelsHash
  const allCompleted = manifest.physicalRequestsCompleted === manifest.requestsPlanned
    && manifest.results.every((result) => (
      result.arms.baseline.status === "completed"
      && result.arms.focused.status === "completed"
    ))
  manifest.status = allCompleted && manifest.modelsSourceUnchanged ? "completed" : "incomplete"
  await saveJson(path.join(outputPath, "manifest.json"), manifest)
  console.log(manifest.status + ": " + outputPath)
  if (manifest.status !== "completed") process.exitCode = 1
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }
  const fixturesRead = await readJson(args.fixturesPath, "fixtures")
  const fixtures = normalizeFixtures(fixturesRead.value)
  const modelsRead = await readJson(args.modelsPath, "models-source")
  const profile = selectModel(modelsRead.value)
  if (args.execute) await execute(args, fixturesRead, fixtures, modelsRead, profile)
  else await prepare(args, fixturesRead, fixtures, modelsRead)
}

try {
  await main()
} catch (error) {
  const message = error instanceof PublicError
    ? error.publicMessage
    : "校准 runner 内部失败（未输出原始异常）"
  console.error("失败：" + message)
  process.exitCode = 1
}
