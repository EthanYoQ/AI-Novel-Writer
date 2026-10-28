// RD-4 运行侧页与隐藏聊天的实机场景：对应计划 RD-4 的 live lane 1～10 与 perf 的 write-stream。
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { FAKE_MODEL, FIXTURE_PROSE, streamingProse } from './fake-model.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapter from './pages/chapter.mjs'
import * as materials from './pages/materials.mjs'
import * as project from './pages/project.mjs'
import * as runPanel from './pages/run-panel.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { firstLine, seedStageSample, seedWithoutDraft, untilGateHolds } from './scenarios.mjs'
import { STAGE_SAMPLE } from './stage-sample.mjs'

/** 聊天入口与聊天字样：按钮、区域、可访问名称和可见文字里都不该出现。 */
const CHAT_WORDS = /AI Agent|Agent 面板|写作助手|切换回 Agent|恢复此助手任务|聊天|assistant|\bchat\b|\bagent\b/i
const { OUTPUT_TEXT } = runSheet

/** 整个窗口里的可见文字，加上所有按钮、区域与带名字元素的可访问名称。 */
function everyName(page) {
  return page.evaluate(() => [document.body.innerText,
    ...[...document.querySelectorAll('button, [role], [aria-label], [title]')].map(element =>
      `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${element.tagName === 'BUTTON' ? element.textContent : ''}`)].join('\n'))
}

async function writeNextFromBlueprint(page) {
  await blueprint.open(page)
  await blueprint.writeNext(page)
  await runSheet.waitUntilOpen(page)
}

/** 实时输出里已经显示了几句（每句以「。」结尾）。 */
function shownSentences(page) {
  return page.evaluate(selector => ([...document.querySelectorAll(selector)].at(-1)?.textContent?.split('。').length ?? 1) - 1, OUTPUT_TEXT)
}

/** 复制改写到页面里的记录，不碰系统剪贴板：驱动运行时作者可能正在用这台电脑。 */
async function recordClipboard(page) {
  await page.evaluate(() => {
    window.__driveCopied = []
    navigator.clipboard.writeText = async text => { window.__driveCopied.push(text) }
  })
  return () => page.evaluate(() => window.__driveCopied.at(-1) ?? null)
}

function hashTree(root) {
  const hashes = {}
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    hashes[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  }
  return hashes
}

/** 从这里起记下界面发给主进程的每个 invoke 通道与次数（包一层 ipcMain 已注册的处理函数）。 */
async function countMainInvokes(app) {
  const wrapped = await app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map)) return 0
    globalThis.__driveInvokes = {}
    for (const [channel, handler] of handlers) {
      handlers.set(channel, (...args) => {
        globalThis.__driveInvokes[channel] = (globalThis.__driveInvokes[channel] ?? 0) + 1
        return handler(...args)
      })
    }
    return handlers.size
  })
  assert.ok(wrapped > 0, '能在主进程里记下 invoke 通道')
}

/** 运行侧页的恢复列表读这两样：主进程算好的可恢复运行、旧恢复候选。 */
const RECOVERY_READS = ['generation:list-recovery', 'db:recovery-candidate-list']

/**
 * 从现在起数主进程答完的恢复读取。包装每个进程只装一次，之后的调用只清零：重复包装会丢掉中间别的包装（如 countMainInvokes）。
 */
async function countRecoveryReads(app) {
  await app.evaluate(({ ipcMain }, channels) => {
    globalThis.__driveRecoveryReads = Object.fromEntries(channels.map(channel => [channel, 0]))
    if (globalThis.__driveRecoveryWrapped) return
    globalThis.__driveRecoveryWrapped = true
    const handlers = ipcMain._invokeHandlers
    for (const channel of channels) {
      const original = handlers.get(channel)
      handlers.set(channel, async (...args) => {
        // 记在请求到达时的窗口里：清零前发出、清零后才答完的请求不算进新窗口
        const reads = globalThis.__driveRecoveryReads
        const result = await original(...args)
        reads[channel] += 1
        return result
      })
    }
  }, RECOVERY_READS)
}

/** 列表读完：两样都答过。 */
async function recoveryReadsDone(app, page) {
  for (const deadline = Date.now() + 10_000; ; await page.waitForTimeout(50)) {
    const reads = await app.evaluate(() => globalThis.__driveRecoveryReads)
    if (RECOVERY_READS.every(channel => reads[channel] > 0)) break
    assert.ok(Date.now() < deadline, `10 秒内恢复列表没有重新读完：${JSON.stringify(reads)}`)
  }
  // 最后一次回复到页面、交给 React 渲染，等两帧
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

/** 助手任务里作者能看到的对话：输入、每一轮的可见回复与动作。运行状态与租约期限由主进程在重开作品时登记，不算对话内容。 */
function conversation(recovery) {
  return JSON.stringify({ input: recovery.context.input, rounds: recovery.rounds.map(round => ({ visibleText: round.visibleText, actions: round.actions })) })
}

/** 示例作品加一条第 5 章的旧恢复候选（写作中断时留下的正文）。 */
export const seedWithCandidate = context => seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
  const recorded = await invoke(page, 'db:recovery-candidate-record', { runId: randomUUID(), stepId: '写稿', chapterNumber: 5, chapterTitle: '潮汐表',
    source: { chapterNumber: 5, title: '潮汐表', role: '发展', purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: [] },
    sourceDraft: null, visibleText: '潮水退去，钟声早了一刻。林岚把潮汐表翻到三十年前那一页。', failureCode: 'timeout', failureReason: '模型长时间没有响应' },
  projectPath, session)
  assert.equal(recorded.success, true, recorded.error)
} })

/** 界面打开作品后会话租约换了新的；核对磁盘数据时回到书房，由驱动自己再打开一次拿会话。 */
async function reopenForReading({ page, invoke, reload }, projectPath) {
  await reload()
  const opened = await invoke(page, 'project:open', projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  return { projectId: opened.project.id, projectPath, leaseId: opened.project.sessionLease }
}

/** Ctrl P 查找章节里标着「生成中」的章（流程脊只在正文阶段展开章节列表，Ctrl P 在哪一步都能看）。 */
async function writingChapters(page) {
  await page.keyboard.press('Control+P')
  await stage.paletteInput(page).waitFor({ state: 'visible' })
  const options = await stage.palette(page).getByRole('option').filter({ hasText: '生成中' }).allInnerTexts()
  await page.keyboard.press('Escape')
  await stage.palette(page).waitFor({ state: 'hidden' })
  return options.map(option => option.match(/第 \d+ 章/)?.[0])
}

async function waitForRunDone(page) {
  if (await runSheet.tab(page, '进行中').count() > 0) await runSheet.waitForRunDone(page)
  else await runPanel.waitForWorkflowDone(page)
}

export const RUN_SCENARIOS = {
  'run-write-steps': { model: true, setup: seedWithoutDraft, run: async ({ page }) => {
    await project.openBlueprints(page)
    await chapter.writeThisChapter(page, 100)
    await runPanel.waitForWorkflowDone(page)
    return {
      ...await runPanel.summary(page),
      chatButtons: await page.getByRole('button', { name: /AI Agent/ }).count(),
      chatRegions: await page.locator('[aria-label="写作助手"]').count(),
    }
  } },

  'run-live': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    fake.streamProse({ chunks: streamingProse(40, 50), intervalMs: 150 })
    await writeNextFromBlueprint(page)
    await runSheet.output(page).waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForFunction(selector => [...document.querySelectorAll(selector)].at(-1)?.textContent?.includes('第3句'), OUTPUT_TEXT)
    const before = await shownSentences(page)
    await page.waitForFunction(([selector, seen]) => ([...document.querySelectorAll(selector)].at(-1)?.textContent?.split('。').length ?? 1) - 1 >= seen + 3,
      [OUTPUT_TEXT, before], { timeout: 10_000 })
    const after = await shownSentences(page)
    assert.ok(after > before, '实时输出在侧页里持续追加')
    assert.equal(await runSheet.tab(page, '进行中').getAttribute('aria-selected'), 'true')
    return { sentencesShown: [before, after] }
  }, after: ({ page }) => runSheet.waitForRunDone(page) },

  'run-cancel': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    fake.gate.hold()
    await writeNextFromBlueprint(page)
    await untilGateHolds(fake.gate)
    const capsule = stage.root(page).getByRole('banner').getByRole('button', { name: /%|运行中|等你确认/ })
    await capsule.waitFor({ state: 'visible' })
    await runSheet.sheet(page).getByRole('button', { name: /^取消「/ }).click()
    await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).waitFor({ state: 'visible', timeout: 20_000 })
    assert.deepEqual(await runSheet.activeTitles(page), [], '取消后没有进行中的运行')
    await capsule.waitFor({ state: 'detached' })
    assert.match(await runSheet.anyCard(page).first().innerText(), /已取消/, '上一次运行写明已取消')
  }, after: ({ fake }) => fake.gate.release() },

  'run-batch': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    for (const chapterNumber of [3, 4]) {
      for (const draft of await invoke(page, 'db:draft-list', chapterNumber, projectPath, session)) {
        assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
      }
    }
  } }), run: async ({ page, fake }) => {
    fake.gate.hold()
    await blueprint.open(page)
    await blueprint.startBatch(page, 2)
    await runSheet.waitUntilOpen(page)
    await untilGateHolds(fake.gate)
    assert.deepEqual(await writingChapters(page), ['第 3 章'], '批量创作只把正在写的那一章标为生成中，排队的第 4 章不算')
    await runSheet.sheet(page).getByRole('button', { name: '暂停批量创作' }).click()
    await runSheet.sheet(page).getByText(/本章写完后暂停$/).waitFor({ state: 'visible' })
    fake.gate.release()
    await runSheet.sheet(page).getByText(/· 已暂停$/).waitFor({ state: 'visible', timeout: 60_000 })
    const pausedAt = fake.requests.length
    await new Promise(resolve => setTimeout(resolve, 2000))
    assert.equal(fake.requests.length, pausedAt, '暂停后不再开始下一章')
    assert.deepEqual(await writingChapters(page), [], '暂停时没有章标为生成中')
    assert.equal(await runSheet.sheet(page).getByRole('button', { name: '继续此批次' }).count(), 0, '暂停的这一批只显示为运行卡片，不再列为可恢复')
    assert.deepEqual(await runSheet.activeTitles(page), ['批量草稿待审 · 第 3 至 4 章'], '运行标题章号在后、只用间隔点')
    return { requestsWhenPaused: pausedAt }
  }, after: async ({ page, fake }) => {
    const pausedAt = fake.requests.length
    await runSheet.sheet(page).getByRole('button', { name: '继续批量创作' }).click()
    await runSheet.waitForRunDone(page, 120_000)
    assert.ok(fake.requests.length > pausedAt, '继续后写了下一章')
  } },

  'run-confirm': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    fake.replyCharacterCards()
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill('角色')
    await stage.palette(page).getByRole('option', { name: /^角色/ }).first().click()
    await materials.importCharacterCards(page, '姓名：守塔人\n身份：灯塔看守，记得每一次钟声。\n\n姓名：林岚\n身份：旧港潮汐记录的测绘师。')
    await runSheet.waitUntilOpen(page)
    const waiting = runSheet.anyCard(page).filter({ hasText: '等你确认' })
    await waiting.getByRole('button', { name: '按当前选择确认', disabled: false }).waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(await waiting.getByRole('combobox', { name: /^采用方式：/ }).count(), 2, '两张角色候选各有一个采用方式')
    assert.equal(await runSheet.sheet(page).locator('.pi-btn--primary').count(), 1, '侧页只有一个主按钮')
  }, after: async ({ page }) => {
    const waiting = runSheet.anyCard(page).filter({ hasText: '等你确认' })
    const keeper = waiting.getByRole('combobox', { name: /^采用方式：守塔人/ })
    const lin = waiting.getByRole('combobox', { name: /^采用方式：林岚/ })
    await lin.selectOption(await lin.locator('option').filter({ hasText: /^林岚 ·/ }).getAttribute('value'))
    await keeper.selectOption('create')
    await waiting.getByRole('button', { name: '按当前选择确认' }).click()
    await runSheet.waitForRunDone(page)
    const roster = stage.characterList(page)
    await roster.getByText('守塔人', { exact: true }).waitFor({ state: 'visible' })
    assert.equal(await roster.getByText('林岚', { exact: true }).count(), 1, '林岚对应已有角色，没有多出一个')
  } },

  'run-discard': { model: false, shell: 'stage', setup: seedWithCandidate, run: async ({ page }) => {
    const copied = await recordClipboard(page)
    await runSheet.openFromPalette(page)
    const card = runSheet.recovery(page).getByRole('article', { name: '原始候选 · 第5章 潮汐表' })
    await card.waitFor({ state: 'visible' })
    await card.getByRole('button', { name: '复制', exact: true }).click()
    assert.equal(await copied(), '潮水退去，钟声早了一刻。林岚把潮汐表翻到三十年前那一页。')
    await card.getByRole('button', { name: '放弃…' }).click()
    await card.getByRole('group').getByText(/^放弃后这 \d+ 字无法找回。$/).waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '保留', '就地确认出现时焦点在「保留」')
  }, after: async ({ app, page }) => {
    const card = runSheet.recovery(page).getByRole('article', { name: '原始候选 · 第5章 潮汐表' })
    await card.getByRole('group').getByRole('button', { name: '放弃', exact: true }).click()
    await card.waitFor({ state: 'detached' })
    await runSheet.sheet(page).getByRole('button', { name: '收起运行侧页' }).first().click()
    await countRecoveryReads(app)
    await runSheet.openFromPalette(page)
    await runSheet.tab(page, '进行中').waitFor({ state: 'visible' })
    await recoveryReadsDone(app, page)
    assert.equal(await card.count(), 0, '重新读取后候选不再列出')
  } },

  'run-diagnostics': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    for (const [purpose, promptTokens, completionTokens, durationMs, success] of [
      ['chapter-draft', 8420, 1236, 41_000, true], ['review-chapter', 4880, 1320, 27_000, true], ['character-state', 5310, null, 120_000, false]]) {
      assert.equal((await invoke(page, 'db:log-llm-call', { modelId: FAKE_MODEL.id, modelName: FAKE_MODEL.name, purpose, promptTokens, completionTokens,
        totalTokens: completionTokens === null ? null : promptTokens + completionTokens, durationMs, success }, projectPath, session)).success, true)
    }
  } }), run: async ({ page }) => {
    const copied = await recordClipboard(page)
    await writeNextFromBlueprint(page)
    await runSheet.waitForRunDone(page)
    await runSheet.tab(page, '诊断').click()
    const table = runSheet.sheet(page).getByRole('table')
    await table.getByRole('row').nth(1).waitFor({ state: 'visible', timeout: 10_000 })
    await table.getByRole('button', { name: '复制安全诊断' }).first().click()
    await page.getByText('已复制安全诊断').first().waitFor({ state: 'visible' })
    const diagnostic = await copied()
    assert.ok(diagnostic?.length > 0, '复制了安全诊断')
    assert.ok(!diagnostic.includes(firstLine(FIXTURE_PROSE)) && !diagnostic.includes(FAKE_MODEL.apiKey), '安全诊断不含正文与密钥')
    assert.doesNotMatch(await runSheet.visibleWords(page, { withoutLogLines: true }), /token/i, '诊断分页的界面文字不出现 token 字样')
    assert.ok(await runSheet.sheet(page).getByRole('list', { name: '日志内容' }).getByRole('listitem').count() > 0, '日志有内容')
    return { rows: await table.getByRole('row').count() - 1 }
  } },

  'run-en': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, invoke, reload, fake }) => {
    assert.equal((await invoke(page, 'config:set', { locale: 'en-US' })).success, true)
    await reload()
    await stage.openFromLibraryEn(page, '灯塔')
    const spine = page.getByRole('navigation', { name: 'Writing flow' })
    await spine.waitFor({ state: 'visible' })
    await page.keyboard.press('Control+K')
    const input = page.getByRole('dialog', { name: 'Search and jump' }).getByRole('combobox')
    for (const [query, expected] of [['assistant', 0], ['agent', 0], ['chat', 0], ['Run sheet', 1]]) {
      await input.fill(query)
      assert.equal(await page.getByRole('listbox', { name: 'Results' }).getByRole('option').count(), expected, `Ctrl K「${query}」`)
    }
    await page.keyboard.press('Escape')
    fake.gate.hold()
    await spine.getByRole('button', { name: /^Blueprint/ }).click()
    await page.getByRole('button', { name: /^Write chapter \d+$/ }).click()
    await runSheet.waitUntilOpen(page)
    await untilGateHolds(fake.gate)
    assert.deepEqual(await runSheet.sheet(page).getByRole('tab').allInnerTexts(), ['In progress', 'History', 'Diagnostics'])
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en-US')
    assert.doesNotMatch(await everyName(page), CHAT_WORDS, '英文界面没有聊天入口')
  }, after: async ({ page, fake }) => {
    fake.gate.release()
    await runSheet.anyCard(page).filter({ hasText: /^Last run/ }).getByText(/Complete/).waitFor({ state: 'visible', timeout: 90_000 })
  } },

  'palette-no-chat': { model: false, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false }), run: async ({ page }) => {
    await page.keyboard.press('Control+K')
    const input = stage.paletteInput(page)
    await input.waitFor({ state: 'visible' })
    for (const query of ['聊天', '对话', 'Agent', '助手']) {
      await input.fill(query)
      await page.waitForTimeout(600)
      assert.equal(await stage.palette(page).isVisible(), true, `Ctrl K 输入「${query}」后搜索仍开着，打开作品后的落点没有关掉它`)
      assert.equal(await stage.palette(page).getByRole('option').count(), 0, `Ctrl K「${query}」没有结果`)
    }
    await page.waitForFunction(() => [...document.querySelectorAll('nav[aria-label="位置"] span')].map(node => node.textContent).join('/') === '正文/第 4 章')
    assert.equal(await stage.palette(page).isVisible(), true, '落点在搜索后面照常打开，搜索仍开着')
  }, after: async ({ page }) => {
    await page.keyboard.press('Escape')
    await stage.palette(page).waitFor({ state: 'hidden' })
  } },

  'legacy-no-chat': { model: false, setup: seedWithoutDraft, run: async ({ page }) => {
    assert.equal(await page.getByRole('button', { name: 'AI 输出', exact: true }).count(), 1, '右侧栏只有 AI 输出')
    assert.equal(await page.getByRole('button', { name: /Agent/ }).count(), 0, '没有 Agent 按钮')
    await runPanel.waitUntilOpen(page)
    assert.equal(await page.getByRole('complementary', { name: 'AI 输出' }).count(), 1, '右侧区域就是 AI 输出')
    assert.doesNotMatch(await everyName(page), CHAT_WORDS, '旧外壳没有聊天入口')
    await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
    assert.equal(await runPanel.isOpen(page), false, '再点一次收起 AI 输出')
    await page.getByRole('button', { name: 'AI 输出', exact: true }).click()
    await runPanel.waitUntilOpen(page)
  } },

  'run-olddata': { model: true, shell: 'stage', setup: async context => {
    const errors = []
    context.page.on('pageerror', error => errors.push(String(error)))
    context.page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text())
      if (message.text().includes('[ProjectService] 项目数据加载完成')) context.projectLoaded = true
    })
    context.pageErrors = errors
    await seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
      const begun = await invoke(page, 'agent-generation:begin', { uiActionNonce: randomUUID(), modelId: FAKE_MODEL.id,
        input: { mode: 'fast', uiLocale: 'zh-CN', historyMessages: [{ role: 'user', content: '上一轮：灯塔是谁建的？' }, { role: 'assistant', content: '三十年前的港务局。' }],
          userMessage: '帮我检查灯塔的设定是否前后一致', tools: [] } }, session)
      await invoke(page, 'agent-generation:round', { handle: begun.handle, index: 0 }, session)
      context.agentHandle = begun.handle
      context.agentBefore = conversation(await invoke(page, 'agent-generation:read', { handle: begun.handle }, session))
      context.projectPath = projectPath
      context.filesBefore = hashTree(projectPath)
      await countMainInvokes(context.app)
    } })
  }, run: async context => {
    const { page } = context
    for (const deadline = Date.now() + 20_000; !context.projectLoaded; await page.waitForTimeout(100)) {
      assert.ok(Date.now() < deadline, '20 秒内作品数据没有加载完')
    }
    await countRecoveryReads(context.app)
    await runSheet.openFromPalette(page)
    await runSheet.tab(page, '进行中').waitFor({ state: 'visible' })
    await recoveryReadsDone(context.app, page)
    assert.doesNotMatch(await runSheet.visibleWords(page), /助手任务|恢复此助手任务|复制回复/, '运行侧页不列出助手任务')
    assert.doesNotMatch(await everyName(page), CHAT_WORDS)
  }, after: async context => {
    assert.deepEqual(context.pageErrors, [], '打开有旧助手数据的作品时没有报错')
    const invoked = await context.app.evaluate(() => globalThis.__driveInvokes)
    assert.ok(invoked['generation:list-recovery'] > 0, '记下了界面的 IPC 调用（运行侧页读过可恢复列表）')
    assert.deepEqual(Object.keys(invoked).filter(channel => channel.startsWith('agent-generation:')), [], '界面没有读写助手任务')
    const session = await reopenForReading(context, context.projectPath)
    const runs = await context.invoke(context.page, 'generation:list', session)
    assert.ok(runs.some(run => run.operation === 'agent-round'), '助手任务仍在库里：运行侧页不列它，不是因为它不存在')
    const after = await context.invoke(context.page, 'agent-generation:read', { handle: context.agentHandle }, session)
    assert.equal(conversation(after), context.agentBefore, '助手任务的对话内容与打开前一致')
    const filesAfter = hashTree(context.projectPath)
    const changed = Object.keys({ ...context.filesBefore, ...filesAfter })
      .filter(file => !/\.(db|sqlite)(-wal|-shm|-journal)?$/i.test(file) && context.filesBefore[file] !== filesAfter[file])
    assert.deepEqual(changed, [], '项目目录里数据库以外的文件没有改动')
  } },

  'run-tour': { model: true, shell: 'stage', setup: seedWithCandidate, run: async ({ page, fake }) => {
    const pause = ms => page.waitForTimeout(ms)
    fake.streamProse({ chunks: streamingProse(36, 50), intervalMs: 180 })
    await pause(1500)
    await blueprint.open(page)
    await pause(1200)
    await blueprint.writeNext(page)
    await runSheet.waitUntilOpen(page)
    await runSheet.output(page).waitFor({ state: 'visible', timeout: 20_000 })
    await runSheet.waitForRunDone(page)
    await pause(2500)
    await runSheet.tab(page, '历史').click()
    await pause(1200)
    await runSheet.sheet(page).getByRole('button', { name: /^第 \d+ 章 · 写稿/ }).first().click()
    await pause(2500)
    await runSheet.tab(page, '诊断').click()
    await pause(3500)
    await runSheet.tab(page, '进行中').click()
    await pause(1500)
    const candidate = runSheet.recovery(page).getByRole('article', { name: '原始候选 · 第5章 潮汐表' })
    await candidate.getByRole('button', { name: '放弃…' }).click()
    await pause(2500)
    await candidate.getByRole('group').getByRole('button', { name: '保留' }).click()
    await pause(1500)
    await runSheet.sheet(page).getByRole('button', { name: '收起运行侧页' }).first().click()
    await pause(1500)
    await runSheet.openFromPalette(page)
    await pause(2500)
  } },

  'write-stream': { model: true, setup: seedStageSample, run: async ({ page, fake }) => {
    const chunks = streamingProse(60, 50)
    fake.streamProse({ chunks, intervalMs: 50 })
    await page.evaluate(({ selector, total }) => {
      const now = () => performance.timeOrigin + performance.now()
      const shownAt = []
      const frames = []
      const sample = () => {
        const shown = ([...document.querySelectorAll(selector)].at(-1)?.textContent?.split('。').length ?? 1) - 1
        while (shownAt.length < shown) shownAt.push(now())
      }
      const tick = () => {
        frames.push(now())
        sample()
        if (shownAt.length < total) requestAnimationFrame(tick)
        else window.__driveStream = { shownAt, frames }
      }
      requestAnimationFrame(tick)
      new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true })
    }, { selector: OUTPUT_TEXT, total: chunks.length })
    if (await stage.root(page).count() > 0) {
      await blueprint.open(page)
      await blueprint.writeNext(page)
    } else {
      await project.openNode(page, '章节蓝图')
      await chapter.writeNextChapter(page, 100)
    }
    await page.waitForFunction(() => window.__driveStream, null, { timeout: 60_000 })
    const { shownAt, frames } = await page.evaluate(() => window.__driveStream)
    const latencies = fake.streamLog.map((sent, index) => shownAt[index] - sent.at).sort((a, b) => a - b)
    const quantile = ratio => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(ratio * latencies.length))])
    const [from, to] = [shownAt[0], shownAt.at(-1)]
    return {
      fps: Math.round(frames.filter(at => at >= from && at <= to).length / ((to - from) / 1000) * 10) / 10,
      appendMedianMs: quantile(0.5),
      appendP95Ms: quantile(0.95),
      streamSeconds: Math.round((to - from) / 10) / 100,
      chunks: chunks.length,
    }
  }, after: ({ page }) => waitForRunDone(page) },

  /** #409：第 3 章单章写作在本次打开里失败后，接着跑含第 3 章的批量（卡在假模型门上）：第 3 章的恢复卡照样列在运行侧页。 */
  'rst-batch-draft-card': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    for (const chapterNumber of [3, 4]) {
      for (const draft of await invoke(page, 'db:draft-list', chapterNumber, projectPath, session)) {
        assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
      }
    }
  } }), run: async ({ page, fake }) => {
    fake.failProse()
    await writeNextFromBlueprint(page)
    await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).getByText(/失败|出错|未完成/).first().waitFor({ state: 'visible', timeout: 60_000 })
    const card = runSheet.recovery(page).getByRole('article').filter({ hasText: /第3章候选/ })
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    fake.failProse(false)
    fake.gate.hold()
    await blueprint.open(page)
    await blueprint.startBatch(page, 2)
    await runSheet.waitUntilOpen(page)
    await untilGateHolds(fake.gate)
    const active = await runSheet.activeTitles(page)
    assert.ok(active.some(title => /^批量草稿待审 · 第 3 至 4 章/.test(title)), `批量运行含第 3 章：${active}`)
    await card.waitFor({ state: 'visible', timeout: 5000 })
    return { active, card: (await card.innerText()).replace(/\s+/g, ' ').slice(0, 160) }
  }, after: async ({ page, fake }) => {
    fake.gate.release()
    await runSheet.waitForRunDone(page, 120_000)
  } },

  /** #536：第 3 章单章写作失败留下的候选可以「不再显示」；点了之后卡片消失，重开作品也不再列出。 */
  'run-hide-draft': { model: true, shell: 'stage', setup: context => seedStageSample(context, { landOnChapter3: false, beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    for (const draft of await invoke(page, 'db:draft-list', 3, projectPath, session)) {
      assert.equal((await invoke(page, 'db:draft-delete', draft.id, projectPath, session)).success, true)
    }
  } }), run: async ({ page, fake }) => {
    fake.failProse()
    await writeNextFromBlueprint(page)
    await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).getByText(/失败|出错|未完成/).first().waitFor({ state: 'visible', timeout: 60_000 })
    const card = runSheet.recovery(page).getByRole('article').filter({ hasText: /第3章候选/ })
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await card.getByRole('button', { name: '不再显示' }).scrollIntoViewIfNeeded()
    fake.failProse(false)
    return { buttons: await card.getByRole('button').allInnerTexts() }
  }, after: async context => {
    const hide = runSheet.recovery(context.page).getByRole('article').filter({ hasText: /第3章候选/ })
    await hide.getByRole('button', { name: '不再显示' }).click()
    await hide.waitFor({ state: 'detached' })
    await context.restart()
    await stage.openAfterRestart(context.page, STAGE_SAMPLE.name)
    await countRecoveryReads(context.app)
    await runSheet.openFromPalette(context.page)
    await runSheet.tab(context.page, '进行中').waitFor({ state: 'visible' })
    await recoveryReadsDone(context.app, context.page)
    assert.equal(await runSheet.sheet(context.page).getByText(/第3章候选/).count(), 0, '重开作品后点过「不再显示」的候选仍不列出')
    await context.shoot('run-hide-draft-after-restart')
    const session = await reopenForReading(context, context.samplePath)
    const runs = await context.invoke(context.page, 'generation:list', session)
    assert.ok(runs.some(run => run.operation === 'chapter-draft' && run.status !== 'running'), '「不再显示」只改显示，第 3 章的生成运行仍在库里')
    const recoverable = await context.invoke(context.page, 'generation:list-recovery', session)
    assert.ok(recoverable.drafts.some(item => item.recovery.chapterNumber === 3), '主进程仍把第 3 章候选列为可恢复：卡片不见是显示偏好，不是数据变了')
  } },

  /** #441 后续：第 3 章正在用夹具模型写（卡在假模型门上），在设置里改这个模型后保存：先提示，等生成结束再保存则不保存、表单留着。 */
  'rst-model-save-prompt': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    fake.gate.hold()
    await writeNextFromBlueprint(page)
    await untilGateHolds(fake.gate)
    await stage.openSettings(page)
    const models = page.getByRole('list', { name: 'AI 模型' })
    await models.getByRole('button', { name: `编辑「${FAKE_MODEL.name}」` }).click()
    await page.getByRole('button', { name: '保存配置' }).click()
    const prompt = page.getByRole('dialog', { name: '这个模型正在生成' })
    await prompt.waitFor({ state: 'visible' })
    const message = await prompt.innerText()
    assert.match(message, /当前有生成在用这个模型（「.+」），保存后这次生成会在下一章停下/)
    return { message: message.replace(/\s+/g, ' ') }
  }, after: async ({ page, fake }) => {
    const before = fake.requests.length
    await page.getByRole('dialog', { name: '这个模型正在生成' }).getByRole('button', { name: '等生成结束再保存' }).click()
    await page.getByRole('dialog', { name: '这个模型正在生成' }).waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '保存配置' }).waitFor({ state: 'visible' })
    fake.gate.release()
    await runSheet.waitForRunDone(page, 120_000)
    assert.ok(fake.requests.length > before, '没保存模型，这次生成照常写完')
    assert.doesNotMatch(await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).innerText(), /失败|GENERATION_SOURCE_CHANGED/)
  } },
}
