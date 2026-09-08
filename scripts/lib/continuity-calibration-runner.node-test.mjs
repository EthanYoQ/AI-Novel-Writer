import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const CACHE_ROOT = path.join(ROOT, ".runtime", ".cache")
const RUNNER = path.join(ROOT, "scripts", "run-continuity-calibration.mjs")

test("dry prepare 冻结生产 prompt 且不泄露或修改模型配置", () => {
  const scratch = path.join(CACHE_ROOT, "continuity-runner-test-" + randomUUID())
  const fixturesPath = path.join(scratch, "inputs.json")
  const modelsPath = path.join(scratch, "models.json")
  const outputPath = path.join(scratch, "prepared")
  const secret = "calibration-test-secret"
  const fixtures = {
    schemaVersion: 1,
    cases: [{
      id: "state-transfer",
      packet: {
        authorRequirements: "检查钥匙归属。",
        sources: [{ id: "chapter-1", text: "林岚把钥匙交给周宁。" }],
        chapter: { id: "chapter-2", text: "周宁把钥匙放进口袋。" },
        originalChapter: { id: "chapter-2-original", text: "周宁收好钥匙。" },
      },
    }],
  }
  const models = [{
    id: "local-profile",
    name: "SiliconFlow",
    provider: "openai",
    protocol: "openai",
    modelName: "deepseek-ai/DeepSeek-V4-Flash",
    apiKey: secret,
    baseUrl: "https://api.siliconflow.cn/v1",
    temperature: 0.7,
    maxTokens: 16384,
    purposes: ["generation"],
  }]

  try {
    mkdirSync(scratch)
    writeFileSync(fixturesPath, JSON.stringify(fixtures))
    writeFileSync(modelsPath, JSON.stringify(models))
    const before = createHash("sha256").update(readFileSync(modelsPath)).digest("hex")
    const result = spawnSync(process.execPath, [
      RUNNER,
      "--fixtures", fixturesPath,
      "--models-source", modelsPath,
      "--output", outputPath,
    ], { encoding: "utf8", windowsHide: true })
    assert.equal(result.status, 0, result.stderr)

    const preparedText = readFileSync(path.join(outputPath, "prepared.json"), "utf8")
    const manifest = JSON.parse(readFileSync(path.join(outputPath, "manifest.json"), "utf8"))
    const after = createHash("sha256").update(readFileSync(modelsPath)).digest("hex")
    assert.equal(preparedText.includes(secret), false)
    assert.match(preparedText, /chapter-2-original/)
    assert.equal(manifest.status, "prepared")
    assert.equal(manifest.executionRequested, false)
    assert.equal(manifest.physicalRequestsStarted, 0)
    assert.equal(manifest.requestsPlanned, 2)
    assert.equal(before, after)

    // Child-process fetch is replaced before the runner loads: no network request.
    const mockPath = path.join(scratch, "mock-fetch.mjs")
    const callsPath = path.join(scratch, "mock-calls.txt")
    writeFileSync(mockPath, `
      import { appendFileSync } from "node:fs";
      globalThis.fetch = async (url, options) => {
        if (url !== "https://api.siliconflow.cn/v1/chat/completions"
          || options.headers.Authorization !== "Bearer calibration-test-secret") throw new Error("bad request");
        appendFileSync(${JSON.stringify(callsPath)}, "call\\n");
        if (process.env.CALIBRATION_MOCK_FAILURE === "1") return new Response("private provider error", {status: 401});
        const data = "data: " + JSON.stringify({choices: [{delta: {content: JSON.stringify({conclusion: "clear", findings: []})}, finish_reason: "stop"}], usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}}) + "\\n\\ndata: [DONE]\\n\\n";
        return new Response(new ReadableStream({start(controller) {
          const bytes = new TextEncoder().encode(data);
          controller.enqueue(bytes.slice(0, 17));
          controller.enqueue(bytes.slice(17));
          controller.close();
        }}));
      };
    `)
    const executeArgs = ["--import", pathToFileURL(mockPath).href, RUNNER,
      "--fixtures", fixturesPath, "--models-source", modelsPath,
      "--output", outputPath, "--execute"]
    const executed = spawnSync(process.execPath, executeArgs, { encoding: "utf8", windowsHide: true })
    assert.equal(executed.status, 0, executed.stderr)
    const completed = JSON.parse(readFileSync(path.join(outputPath, "manifest.json"), "utf8"))
    assert.equal(completed.status, "completed")
    assert.equal(completed.physicalRequestsStarted, 2)
    assert.equal(completed.physicalRequestsCompleted, 2)
    assert.equal(completed.modelsSourceUnchanged, true)
    const receiptText = readFileSync(path.join(outputPath, completed.results[0].directory, "focused.json"), "utf8")
    const receipt = JSON.parse(receiptText)
    assert.equal(receipt.focusedMechanicalValidation.valid, true)
    assert.equal(receipt.response.usage.totalTokens, 15)
    assert.equal(receiptText.includes(secret), false)
    const repeated = spawnSync(process.execPath, executeArgs, { encoding: "utf8", windowsHide: true })
    assert.notEqual(repeated.status, 0)
    assert.equal(readFileSync(callsPath, "utf8").trim().split("\n").length, 2)

    // A failed pair consumes its two attempts, stops later cases and cannot retry.
    fixtures.cases.push({ ...fixtures.cases[0], id: "not-dispatched" })
    writeFileSync(fixturesPath, JSON.stringify(fixtures))
    const failedOutput = path.join(scratch, "failure-prepared")
    const prepareFailure = spawnSync(process.execPath, [RUNNER,
      "--fixtures", fixturesPath, "--models-source", modelsPath, "--output", failedOutput],
    { encoding: "utf8", windowsHide: true })
    assert.equal(prepareFailure.status, 0, prepareFailure.stderr)
    const failureArgs = executeArgs.map((arg) => arg === outputPath ? failedOutput : arg)
    const failed = spawnSync(process.execPath, failureArgs, {
      encoding: "utf8", windowsHide: true, env: { ...process.env, CALIBRATION_MOCK_FAILURE: "1" },
    })
    assert.notEqual(failed.status, 0)
    const failureManifest = JSON.parse(readFileSync(path.join(failedOutput, "manifest.json"), "utf8"))
    assert.equal(failureManifest.status, "incomplete")
    assert.equal(failureManifest.physicalRequestsStarted, 2)
    assert.equal(failureManifest.physicalRequestsCompleted, 0)
    assert.equal(failureManifest.results.length, 1)
    assert.equal(failureManifest.requestsPlanned, 4)
    const failureReceipt = readFileSync(path.join(failedOutput, failureManifest.results[0].directory, "focused.json"), "utf8")
    assert.equal(failureReceipt.includes("private provider error"), false)
    assert.equal(failureReceipt.includes(secret), false)
    assert.equal(readFileSync(callsPath, "utf8").trim().split("\n").length, 4)
    assert.equal(createHash("sha256").update(readFileSync(modelsPath)).digest("hex"), before)
  } finally {
    assert.equal(path.dirname(path.resolve(scratch)), CACHE_ROOT)
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("拒绝 fixtures 中的 gold 字段且不创建 output", () => {
  const scratch = path.join(CACHE_ROOT, "continuity-runner-test-" + randomUUID())
  const fixturesPath = path.join(scratch, "inputs.json")
  const modelsPath = path.join(scratch, "models.json")
  const outputPath = path.join(scratch, "prepared")
  try {
    mkdirSync(scratch)
    writeFileSync(fixturesPath, JSON.stringify({
      cases: [{
        id: "forbidden-gold",
        gold: { conclusion: "conflict" },
        packet: {
          authorRequirements: "检查。",
          sources: [],
          chapter: { id: "chapter", text: "正文。" },
        },
      }],
    }))
    writeFileSync(modelsPath, JSON.stringify([{
      provider: "siliconflow",
      protocol: "openai",
      modelName: "deepseek-ai/DeepSeek-V4-Flash",
      apiKey: "test-only",
      baseUrl: "https://api.siliconflow.cn/v1",
    }]))
    const result = spawnSync(process.execPath, [
      RUNNER,
      "--fixtures", fixturesPath,
      "--models-source", modelsPath,
      "--output", outputPath,
    ], { encoding: "utf8", windowsHide: true })
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(outputPath), false)
  } finally {
    assert.equal(path.dirname(path.resolve(scratch)), CACHE_ROOT)
    rmSync(scratch, { recursive: true, force: true })
  }
})
