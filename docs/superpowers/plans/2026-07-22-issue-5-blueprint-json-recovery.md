# Issue #5 蓝图 JSON 恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在模型返回轻微损坏的章节蓝图 JSON 时，自动请求一次格式修复；同时让 Gemini 真正使用 JSON 响应格式约束。

**Architecture:** 目录工作流仍以现有严格解析与章节覆盖校验作为唯一可信入口。首次严格解析失败时，仅对 JSON 语法错误发起一次低随机度的同模型修复请求，再复用严格解析和持久化校验。Gemini provider 将已有的 `responseFormat` 选项映射为 Gemini 的 `responseMimeType`。

**Tech Stack:** TypeScript、Vitest、Electron LLM providers、Zustand stores。

## Global Constraints

- 不修改 README、品牌文案或既有无关测试。
- 不引入新的运行时依赖。
- 只对 `蓝图 JSON 解析失败` 执行一次修复重试；覆盖不足和持久化失败继续直接报错。

---

### Task 1: 目录工作流 JSON 修复回归测试

**Files:**
- Modify: `src/services/workflows/commands/__tests__/directory.command.test.ts`
- Modify: `src/services/workflows/commands/directory.command.ts`

**Interfaces:**
- Consumes: `GenerateDirectoryCommand.execute()` 和其受保护的 `callLLM()`。
- Produces: 解析错误时第二次 `callLLM()` 返回的合法 JSON 被保存并作为章节蓝图返回。

- [ ] **Step 1: Write the failing test**

```ts
it('repairs malformed blueprint JSON once before saving it', async () => {
  const command = new GenerateDirectoryCommand({ mode: 'full', count: 1 })
  const callLLM = vi.spyOn(command as unknown as { callLLM: () => Promise<string> }, 'callLLM')
    .mockResolvedValueOnce('{"blueprints":[{"chapterNumber" 1}]}')
    .mockResolvedValueOnce('[{"chapterNumber":1,"title":"启程","keyEvents":"主角发现异常"}]')

  await expect(command.execute({ step: {}, context, callbacks })).resolves.toHaveLength(1)
  expect(callLLM).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/workflows/commands/__tests__/directory.command.test.ts`

Expected: FAIL because the current workflow rejects malformed JSON after one model request.

- [ ] **Step 3: Write minimal implementation**

```ts
try {
  return parseTextBlueprintsStrict(resultText, cursor, endChapter)
} catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith('蓝图 JSON 解析失败：')) throw error
  callbacks.log('  蓝图 JSON 格式异常，正在请求模型修复格式...')
  const repairedText = await this.callLLM(repairPrompt, jsonSystemRole, callbacks, jsonOptions)
  return parseTextBlueprintsStrict(repairedText, cursor, endChapter)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/services/workflows/commands/__tests__/directory.command.test.ts`

Expected: PASS.

### Task 2: Gemini JSON MIME 格式测试

**Files:**
- Create: `electron/llm/__tests__/gemini-provider.test.ts`
- Modify: `electron/llm/gemini-provider.ts`

**Interfaces:**
- Consumes: `GeminiProvider.generate(model, messages, { responseFormat: { type: 'json_object' } })`。
- Produces: Gemini 请求体的 `generationConfig.responseMimeType === 'application/json'`。

- [ ] **Step 1: Write the failing test**

```ts
expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
  generationConfig: { responseMimeType: 'application/json' },
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run electron/llm/__tests__/gemini-provider.test.ts`

Expected: FAIL because `GeminiProvider` currently omits `responseMimeType`.

- [ ] **Step 3: Write minimal implementation**

```ts
if (opts.responseFormat?.type === 'json_object') {
  generationConfig.responseMimeType = 'application/json'
}
```

Apply the same generation config in both non-streaming and streaming methods.

- [ ] **Step 4: Run targeted verification**

Run: `pnpm vitest run electron/llm/__tests__/gemini-provider.test.ts src/services/workflows/commands/__tests__/directory.command.test.ts && pnpm typecheck`

Expected: PASS.

### Task 3: Scope and integration verification

**Files:**
- Review: `src/services/workflows/commands/directory.command.ts`
- Review: `electron/llm/gemini-provider.ts`

- [ ] **Step 1: Run full existing suite**

Run: `$env:CI='true'; pnpm test`

Expected: the issue-specific tests pass; document any pre-existing unrelated failures without changing their files.

- [ ] **Step 2: Inspect staged diff and commit**

Run: `git diff --check; git diff --cached --check; git status --short`

Expected: only issue #5 code, regression tests, and this plan are staged.
