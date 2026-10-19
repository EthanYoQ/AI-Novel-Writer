// RD-X1 外部审查修复的实机场景：会丢数据、写错对象、会话与导航错位的缺陷，各按作者的操作在真实 Electron 里走一遍。
// 竞态用主进程通道上的门卡住（holdChannel），让「保存或读取还没返回时作者已经离开」稳定发生。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { chooseProjectDirectoryGrant } from '../project-directory-grant.mjs'
import * as blueprint from './pages/blueprint.mjs'
import * as chapterView from './pages/chapter-view.mjs'
import * as refs from './pages/refs.mjs'
import * as runSheet from './pages/run-sheet.mjs'
import * as stage from './pages/stage.mjs'
import { importMaterials, MATERIALS } from './refs-scenarios.mjs'
import { seedStageSample } from './scenarios.mjs'
import { countUnits, STAGE_SAMPLE, stageChapterTitle } from './stage-sample.mjs'

export const HARBOR = '港口'
const SKILL_URL = 'https://github.com/owner/skill'

/**
 * 卡住主进程 channel 接下来的 times 次调用，releaseChannel 之后放行。after 为 true 时先交给原处理函数、卡住的是回复：
 * 主进程已经做完，渲染进程迟迟收不到，正是「保存往返期间作者换了作品」的样子。
 */
export async function holdChannel(app, channel, { times = 1, after = false } = {}) {
  const ok = await app.evaluate(({ ipcMain }, [channel, times, after]) => {
    const handlers = ipcMain._invokeHandlers
    if (!(handlers instanceof Map) || !handlers.has(channel)) return false
    const original = handlers.get(channel)
    const gate = Promise.withResolvers()
    const state = { remaining: times, waiting: 0, release: gate.resolve }
    ;(globalThis.__driveHolds ??= {})[channel] = state
    handlers.set(channel, async (event, ...args) => {
      if (state.remaining <= 0) return original(event, ...args)
      state.remaining--
      const result = after ? await original(event, ...args) : undefined
      state.waiting++
      try { await gate.promise } finally { state.waiting-- }
      return after ? result : original(event, ...args)
    })
    return true
  }, [channel, times, after])
  assert.ok(ok, `能在主进程里卡住 ${channel}`)
}

export async function untilHeld(app, channel, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (await app.evaluate((_, channel) => globalThis.__driveHolds[channel].waiting, channel) === 0) {
    assert.ok(Date.now() < deadline, `${timeoutMs} ms 内 ${channel} 没有卡在门上`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

export const releaseChannel = (app, channel) => app.evaluate((_, channel) => globalThis.__driveHolds[channel].release(), channel)

/** 记下这些通道之后每次调用所属的作品路径（取调用参数最后的项目会话）。 */
export async function recordCalls(app, channels) {
  const missing = await app.evaluate(({ ipcMain }, channels) => {
    const handlers = ipcMain._invokeHandlers
    const missing = channels.filter(channel => !handlers.has(channel))
    if (missing.length > 0) return missing
    const calls = globalThis.__driveCalls = []
    for (const channel of channels) {
      const original = handlers.get(channel)
      handlers.set(channel, (event, ...args) => {
        calls.push({ channel, projectPath: args.at(-1)?.projectPath ?? null, at: Date.now() })
        return original(event, ...args)
      })
    }
    return []
  }, channels)
  assert.deepEqual(missing, [], `主进程里有要记录的通道：${missing.join('、')}`)
}

const recordedCalls = app => app.evaluate(() => globalThis.__driveCalls)

/** 把主进程的 channel 换成固定回复，调用次数记进 globalThis.__driveStubs。 */
export async function stubChannel(app, channel, reply) {
  const ok = await app.evaluate(({ ipcMain }, [channel, reply]) => {
    if (!ipcMain._invokeHandlers.has(channel)) return false
    const counts = globalThis.__driveStubs ??= {}
    counts[channel] = 0
    ipcMain._invokeHandlers.set(channel, () => { counts[channel]++; return reply })
    return true
  }, [channel, reply])
  assert.ok(ok, `能在主进程里替换 ${channel}`)
}

const stubCalls = (app, channel) => app.evaluate((_, channel) => globalThis.__driveStubs[channel], channel)

async function untilStubCalls(app, channel, count, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (await stubCalls(app, channel) < count) {
    assert.ok(Date.now() < deadline, `${timeoutMs} ms 内 ${channel} 没有调到第 ${count} 次`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const discardDialog = page => page.getByRole('dialog', { name: '放弃未保存的修改？' })

/** 设置页「写作 Skills」里填一个没保存的 GitHub 地址。 */
async function dirtySkillsPage(page) {
  await stage.showSettingsPage(page, '写作 Skills')
  const url = stage.root(page).getByRole('textbox', { name: 'GitHub Skill 地址' })
  await url.fill(SKILL_URL)
  return url
}

async function paletteAction(page, query) {
  await page.keyboard.press('Control+K')
  await stage.paletteInput(page).waitFor({ state: 'visible' })
  await stage.paletteInput(page).fill(query)
  await page.keyboard.press('Enter')
}

/**
 * 另建一部作品「港口」：三章蓝图、三章定稿，第 3 章定稿带一份历史审稿。
 * 每部作品的库各自从 1 编号，它第 3 章定稿的稿 id 与灯塔第 3 章草稿相同，稿的 filePath 也就相同。
 */
export async function seedHarbor(context) {
  const { app, page, roots, invoke } = context
  const created = await invoke(page, 'project:create', { parentGrantId: (await chooseProjectDirectoryGrant(app, page, roots.projects)).grantId,
    name: HARBOR, genre: '悬疑', targetAudience: '成年读者', writingLanguage: 'zh-CN' }, randomUUID(), null)
  assert.equal(created.success, true, created.error)
  const opened = await invoke(page, 'project:open', created.projectPath, randomUUID(), null)
  assert.equal(opened.success, true, opened.error)
  const harbor = created.projectPath
  const session = { projectId: created.projectId, projectPath: harbor, leaseId: opened.project.sessionLease }
  for (const [index, title] of STAGE_SAMPLE.titles.slice(0, 3).entries()) {
    assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: index + 1, title, role: '发展', purpose: '港口的线索',
      keyEvents: '林岚在港口找到新的线索', characters: [] }, harbor, session)).success, true)
  }
  const chapters = [1, 2, 3].map(number => {
    const content = number === 3 ? STAGE_SAMPLE.drafts[3].text : STAGE_SAMPLE.finalized[number]
    return { chapterNumber: number, title: stageChapterTitle(number), content, wordCount: countUnits(content) }
  })
  const imported = await invoke(page, 'db:draft-import-finalized-batch', { operationId: randomUUID(), chapters }, harbor, session)
  assert.equal(imported.success, true, imported.error)
  const [finalized] = (await invoke(page, 'db:draft-list', 3, harbor, session)).filter(draft => draft.status === 'finalized')
  const full = await invoke(page, 'db:draft-get-full', finalized.id, harbor, session)
  const review = await invoke(page, 'db:review-create', { baseDraftId: full.id, content: STAGE_SAMPLE.drafts[3].review,
    expectedSource: { id: full.id, chapterNumber: 3, version: full.version, status: full.status, content: full.content } }, harbor, session)
  assert.equal(review.success, true, review.error)
  context.harbor = { path: harbor, chapter3DraftId: full.id }
}

/** 先建港口，再建并打开灯塔；beforeReload 里记下灯塔第 3 章草稿的 id。 */
const seedTwoBooks = (options = {}) => async context => {
  await seedHarbor(context)
  await seedStageSample(context, { ...options, beforeReload: async args => {
    const [draft] = await args.invoke(args.page, 'db:draft-list', 3, args.path, args.session)
    context.lighthouseChapter3DraftId = draft.id
    await options.beforeReload?.(args)
  } })
}

/** 第 3 章蓝图写上守塔人，一致性预检才有话说。 */
const keeperInChapter3 = async ({ page, invoke, path: projectPath, session }) => {
  assert.equal((await invoke(page, 'db:blueprint-upsert', { chapterNumber: 3, title: STAGE_SAMPLE.titles[2], role: '发展',
    purpose: '推进灯塔与沉船的线索', keyEvents: '林岚在灯塔里找到新的线索', characters: ['林岚', '守塔人'] }, projectPath, session)).success, true)
}

/** 主进程里把连续性事实换成「守塔人第 1 章已死」，写第 3 章时一致性预检提醒。 */
async function injectDeadKeeper(app) {
  await app.evaluate(({ ipcMain }) => {
    ipcMain._invokeHandlers.set('db:continuity-list-before', () => [{
      draftId: 1, chapterNumber: 1, chapterTitle: '旧港', chapterNotes: '守塔人死于第一章的风暴。',
      source: { draftId: 1, finalizationId: 'drive-fixture', chapterNumber: 1, contentHash: 'a'.repeat(64) },
      sourceStatus: 'current',
      facts: [{ category: 'character-state', entities: ['守塔人'], statement: '守塔人已经死亡。', sourceChapter: 1, evidence: '守塔人在风暴里没有再回来。' }],
    }])
  })
}

/** 书房里点了「打开」之后：新外壳在提交作品时就进作品；落点晚到的版本先留在书房，作者点「继续写作」进作品。 */
async function enterWorkAfterOpening(page) {
  const resume = stage.overview(page, STAGE_SAMPLE.name).getByRole('button', { name: /^继续写作/ })
  await Promise.race([stage.spine(page).waitFor({ state: 'visible' }), resume.waitFor({ state: 'visible' })])
  if (!await stage.spine(page).isVisible()) await resume.click()
  await stage.spine(page).waitFor({ state: 'visible' })
}

/** 从书房打开灯塔，读文件树卡在主进程门上。 */
async function openWithSlowFileTree(app, page) {
  await stage.previewBook(page, STAGE_SAMPLE.name)
  await holdChannel(app, 'fs:list-dir')
  await stage.overview(page, STAGE_SAMPLE.name).getByRole('button', { name: `打开《${STAGE_SAMPLE.name}》` }).click()
  await untilHeld(app, 'fs:list-dir')
  await enterWorkAfterOpening(page)
}

/**
 * 另起一个 PowerShell 进程以只共享读的方式打开文件（不带 FileShare.Delete），Windows 上删除它会得到 EBUSY。
 * 返回释放函数：按这个子进程的 PID 结束它。
 */
async function lockFile(path) {
  const child = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f = [System.IO.File]::Open($env:DRIVE_LOCK_PATH, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Seconds 600`],
  { env: { ...process.env, DRIVE_LOCK_PATH: path }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  const exited = new Promise(resolve => child.once('exit', resolve))
  await Promise.race([
    new Promise(resolve => child.stdout.on('data', chunk => { if (String(chunk).includes('locked')) resolve() })),
    exited.then(code => { throw new Error(`占住文件的进程提前退出：${code}`) }),
  ])
  return () => {
    child.kill()
    return exited
  }
}

export const X1_SCENARIOS = {
  // #388 T1：切走前点的资料读得慢，切回后改了另一份资料，迟到的读取不能盖掉修改。
  'x1-kb-late-read': { model: true, shell: 'stage', setup: seedStageSample, run: async context => {
    const { app, page } = context
    await importMaterials(context)
    await holdChannel(app, 'kb:read-document-copy')
    await refs.materialButton(page, '守塔人小传').click()
    await untilHeld(app, 'kb:read-document-copy')
    await refs.open(page, 'history')
    await refs.historyChapters(page).waitFor({ state: 'visible' })
    await stage.tab(page, '知识库').click()
    await refs.materialButton(page, '沉船名录').click()
    await assert.doesNotReject(() => page.waitForFunction(text => document.querySelector('textarea[aria-label="项目副本内容"]')?.value === text,
      MATERIALS['沉船名录.txt'], { timeout: 10_000 }), '切回后点的资料读出来了')
    const edited = `${MATERIALS['沉船名录.txt']}启明号的船钟停在三点。`
    await refs.copyEditor(page).fill(edited)
    await releaseChannel(app, 'kb:read-document-copy')
    await page.waitForTimeout(1500)
    const after = { text: await refs.copyEditor(page).inputValue(), dirty: await page.getByText('有未保存的修改').isVisible() }
    assert.deepEqual(after, { text: edited, dirty: true }, '迟到的读取没有盖掉另一份资料的修改')
    return after
  } },

  // #380 C4：设定页「下一步」的保存还没返回时作者回了书房，保存完成后不被拉去架构。
  'x1-setup-leave': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    await stage.dirtySetup(page)
    await holdChannel(app, 'project:save')
    await stage.setupNext(page).click()
    await untilHeld(app, 'project:save')
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await releaseChannel(app, 'project:save')
    await page.waitForTimeout(2000)
    const after = { library: await stage.shelf(page).isVisible(), spine: await stage.spine(page).isVisible() }
    assert.deepEqual(after, { library: true, spine: false }, '保存完成后仍在书房')
    return after
  } },

  // #405 r2 低项 7：设定页 Ctrl S 的保存还没返回时切到第 3 章标签再切回，下一步仍不可点，再按 Ctrl S 也不重发，保存只写一次。
  'x1-setup-save-remount': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stage.stageButton(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    await stage.dirtySetup(page)
    await recordCalls(app, ['project:save'])
    await holdChannel(app, 'project:save')
    await page.keyboard.press('Control+S')
    await untilHeld(app, 'project:save')
    await stage.tab(page, /^第 3 章/).click()
    await stage.setupOutline(page).waitFor({ state: 'hidden' })
    await stage.tab(page, '设定').click()
    await stage.setupOutline(page).waitFor({ state: 'visible' })
    const nextDisabled = await stage.setupNext(page).isDisabled()
    await page.keyboard.press('Control+S')
    await page.waitForTimeout(500)
    await releaseChannel(app, 'project:save')
    await page.waitForTimeout(2000)
    const after = { nextDisabled, saves: (await recordedCalls(app)).length }
    assert.deepEqual(after, { nextDisabled: true, saves: 1 }, '切回后下一步仍不可点，保存只写一次')
    return after
  } },

  // #380 C1：设置页里有没保存的输入时，命令面板「设置」、作品菜单「项目备份」换分区先确认。
  'x1-settings-section': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ page }) => {
    await stage.openSettings(page)
    const url = await dirtySkillsPage(page)
    await paletteAction(page, '设置')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 5000 })
    await discardDialog(page).getByRole('button', { name: '继续编辑' }).click()
    const kept = { page: await stage.currentSettingsPage(page), url: await url.inputValue() }
    assert.deepEqual(kept, { page: '写作 Skills', url: SKILL_URL }, '继续编辑后留在原分区，输入还在')
    await stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '项目备份')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 5000 })
    await discardDialog(page).getByRole('button', { name: '放弃修改' }).click()
    await stage.root(page).getByRole('heading', { level: 1, name: '项目备份', exact: true }).waitFor({ state: 'visible' })
    return kept
  } },

  // 本机 Skill 文件夹导入：系统对话框打桩为隔离目录里的 Agent Skill 文件夹，检查卡列出并入与跳过的文件，确认安装后能绑定到阶段。
  'skills-import-local': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page, roots, shoot }) => {
    const folder = join(roots.temp, 'scene-voice')
    mkdirSync(join(folder, 'references'), { recursive: true })
    mkdirSync(join(folder, 'scripts'), { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), [
      '---', 'name: scene-voice', 'description: >-', '  让每一场戏保持统一的叙述声音。', '  起草和修稿时使用。', 'license: Apache-2.0', '---',
      '遵循 [声音规则](references/voice.md)。格式参照 [表单说明](FORMS.md)。收尾前再读一遍 [声音规则](References/Voice.md)。',
    ].join('\n'))
    writeFileSync(join(folder, 'references', 'voice.md'), '使用第三人称近距离视角，动作先于心理。[返回](../SKILL.md)')
    writeFileSync(join(folder, 'scripts', 'lint.py'), 'print("lint")')
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] })
    }, folder)
    await stage.openSettings(page)
    await stage.showSettingsPage(page, '写作 Skills')
    await stage.root(page).getByRole('button', { name: '选择文件夹' }).click()
    const card = stage.root(page).getByRole('group', { name: '待安装的 Skill' })
    await card.waitFor({ state: 'visible' })
    const inspected = await card.innerText()
    assert.match(inspected, /^并入提示词: references\/voice\.md$/mu, '回链的 SKILL.md 与大小写不同的同一文件都只算一次，只并入 voice.md')
    assert.match(inspected, /scripts\/lint\.py/u, '检查卡列出不会安装的脚本')
    assert.match(inspected, /模型看不到：FORMS\.md/u, '检查卡列出没有随 Skill 安装的普通链接')
    await shoot('skills-import-local-inspected')
    await card.getByRole('button', { name: '确认安装' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click()
    await card.waitFor({ state: 'hidden' })
    const drafting = stage.root(page).getByLabel('章节正文 Skill')
    await drafting.selectOption('user:scene-voice')
    await page.waitForFunction(() => !document.querySelector('select[aria-label="章节正文 Skill"]')?.disabled, null, { timeout: 10_000 })
    const alerts = await stage.root(page).getByRole('alert').allInnerTexts()
    assert.deepEqual(alerts, [], '绑定没有报错')
    const bound = await drafting.inputValue()
    assert.equal(bound, 'user:scene-voice', '安装后的文件夹 Skill 兼容，可以绑定到章节正文')
    return { inspected, bound }
  } },

  // #387 C1：保存一致性安排的回复还没到时换了作品，回复到了也不在新作品里按旧蓝图开写。
  'x1-write-switch': { model: true, shell: 'stage', setup: seedTwoBooks({ beforeReload: keeperInChapter3 }), run: async context => {
    const { app, page, fake } = context
    await injectDeadKeeper(app)
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await blueprint.preflight(page).waitFor({ state: 'visible' })
    await blueprint.popover(page).getByLabel('安排说明').fill('守塔人以幽灵身份出现，是刻意安排。')
    await recordCalls(app, ['db:draft-authority-sequence', 'db:continuity-list-before'])
    await holdChannel(app, 'db:consistency-exemption-save', { after: true })
    await blueprint.preflight(page).getByRole('button', { name: '保存安排' }).click()
    await untilHeld(app, 'db:consistency-exemption-save')
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await stage.openFromPalette(page, HARBOR)
    await page.waitForTimeout(1500)
    const released = Date.now()
    await releaseChannel(app, 'db:consistency-exemption-save')
    await page.waitForTimeout(2500)
    const inHarbor = (await recordedCalls(app)).filter(call => call.at >= released && call.projectPath === context.harbor.path)
    const after = { launchCallsInHarbor: inHarbor.map(call => call.channel), proseRequests: fake.chats.filter(chat => chat.kind === 'prose').length }
    assert.deepEqual(after, { launchCallsInHarbor: [], proseRequests: 0 }, '换到港口后没有按灯塔的蓝图开始写')
    return after
  } },

  // #392 T1：每条意见都选「不修改此项」，主按钮变成确认不修改，确认后弃修决定落库，重开这一章仍在。
  // 意见要有复验周期的条目才能弃修，周期由 AI 审稿写回时建立，所以先对第 4 章跑一次审稿。
  'x1-waive-all': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, shoot }) => {
    await chapterView.open(page, 4)
    await chapterView.review(page)
    const sheet = chapterView.reviewSheet(page)
    await sheet.waitFor({ state: 'visible' })
    const waive = sheet.getByRole('button', { name: '不修改此项' })
    await waive.first().waitFor({ state: 'visible' })
    while (await waive.count() > 0) await waive.first().click()
    const confirm = chapterView.view(page).getByRole('button', { name: '确认不修改', exact: true })
    await confirm.waitFor({ state: 'visible', timeout: 5000 })
    await shoot('x1-waive-all-confirm')
    await confirm.click()
    const confirmed = chapterView.hint(page).filter({ hasText: '已确认不修改' })
    await confirmed.waitFor({ state: 'visible' })
    await chapterView.open(page, 3)
    await chapterView.open(page, 4)
    await confirmed.waitFor({ state: 'visible' })
    return { reopened: await chapterView.hint(page).innerText() }
  } },

  // #392 T2：第 3 章另有草稿 v1，把 v2 定稿（真实的定稿后处理写出正文文件并入知识库），正文文件被另一个进程占着时删除正文：
  // 数据库已删、正文清理失败。落在 v1 的单章视图上有「删除正文后的清理没有完成」；放开文件后点重试清理，提示消失、文件删掉。
  'x1-cleanup-retry': { model: true, shell: 'stage', setup: context => seedStageSample(context, { beforeReload: async ({ page, invoke, path: projectPath, session }) => {
    const text = `${STAGE_SAMPLE.drafts[3].text}\n\n堤脚的刻痕旁边，又多了一道新刻的线。`
    assert.equal((await invoke(page, 'db:draft-create', { chapterNumber: 3, version: 2, source: 'write', content: text, wordCount: countUnits(text) },
      projectPath, session)).success, true)
  } }), run: async ({ page, shoot, samplePath }) => {
    await chapterView.open(page, 3)
    await chapterView.finalize(page, 3)
    await chapterView.postProcess(page).getByText('4 / 4 完成').waitFor({ state: 'visible', timeout: 90_000 })
    const manuscript = readdirSync(samplePath).find(name => name.startsWith('第3章') && name.endsWith('.txt'))
    assert.ok(manuscript, '定稿写出了第 3 章的正文文件')
    const file = join(samplePath, manuscript)
    const release = await lockFile(file)
    try {
      await chapterView.more(page, '删除正文…')
      await page.getByRole('button', { name: '删除', exact: true }).click()
      const legacy = page.getByRole('button', { name: '我已人工核对/清理，继续删除' })
      if (await legacy.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await legacy.click()
      const notice = chapterView.view(page).getByText('删除正文后的清理没有完成')
      await notice.waitFor({ state: 'visible', timeout: 15_000 })
      const onDraft = await chapterView.versionButton(page).innerText()
      assert.match(onDraft, /草稿 v1/, '落在第 3 章的未定稿 v1 上')
      const failure = await chapterView.view(page).locator('[role="alert"], [role="status"]').filter({ hasText: '删除正文后的清理没有完成' }).innerText()
      assert.match(failure, /EBUSY/, '清理失败的原因是正文文件被占用')
      await shoot('x1-cleanup-retry-notice')
      await release()
      await chapterView.view(page).getByRole('button', { name: '重试清理' }).click()
      await notice.waitFor({ state: 'hidden', timeout: 15_000 })
      assert.equal(existsSync(file), false, '重试清理后正文文件已删除')
      return { onDraft, failure: failure.replace(/\s+/g, ' ').slice(0, 200), fileRemoved: true }
    } finally {
      await release()
    }
  } },

  // #381 C1：会话内写稿失败后，运行侧页「可恢复的内容」立即列出这一章的候选，不必重开作品。
  'x1-run-recovery': { model: true, shell: 'stage', setup: seedStageSample, run: async ({ page, fake }) => {
    fake.failProse()
    await blueprint.open(page)
    await blueprint.writeNext(page)
    await runSheet.waitUntilOpen(page)
    await runSheet.anyCard(page).filter({ hasText: /^上一次运行/ }).getByText(/失败|出错|未完成/).first().waitFor({ state: 'visible', timeout: 60_000 })
    const entry = runSheet.recovery(page).getByRole('article').filter({ hasText: /第3章候选/ })
    await entry.waitFor({ state: 'visible', timeout: 10_000 })
    return { recovery: await runSheet.recovery(page).getByRole('article').allInnerTexts() }
  } },

  // #399 §1：灯塔第 3 章开着审稿侧页时换到港口，港口里同 id 的已定稿第 3 章不自动展开审稿侧页。
  'x1-review-sheet-switch': { model: false, shell: 'stage', setup: seedTwoBooks(), run: async context => {
    const { page } = context
    assert.equal(context.harbor.chapter3DraftId, context.lighthouseChapter3DraftId, '两部作品第 3 章的稿 id 相同')
    await chapterView.reviewSheet(page).waitFor({ state: 'visible' })
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await stage.openFromPalette(page, HARBOR)
    await stage.findChapter(page, '3')
    await chapterView.view(page).waitFor({ state: 'visible' })
    await chapterView.view(page).getByText('已定稿，只读', { exact: true }).waitFor({ state: 'visible' })
    await page.waitForTimeout(1000)
    const after = { reviewSheet: await chapterView.reviewSheet(page).isVisible() }
    assert.deepEqual(after, { reviewSheet: false }, '港口的已定稿章不带着灯塔的审稿侧页')
    return after
  } },

  // #405 r2 C1：灯塔第 4 章审稿后每条意见都选不修改，确认还没返回时换到港口并打开运行侧页；
  // 确认回来后运行侧页还开着，没有被换成灯塔那一稿的审稿侧页。第 3 章的预置审稿没有复验周期，重新审稿又被生成源校验拒绝，所以用第 4 章。
  'x1-waiver-switch': { model: true, shell: 'stage', setup: seedTwoBooks(), run: async ({ app, page }) => {
    await chapterView.open(page, 4)
    await chapterView.review(page)
    const sheet = chapterView.reviewSheet(page)
    const waive = sheet.getByRole('button', { name: '不修改此项' })
    await waive.first().waitFor({ state: 'visible' })
    while (await waive.count() > 0) await waive.first().click()
    const confirm = chapterView.view(page).getByRole('button', { name: '确认不修改', exact: true })
    await confirm.waitFor({ state: 'visible', timeout: 5000 })
    await holdChannel(app, 'db:review-get-full')
    await confirm.click()
    await untilHeld(app, 'db:review-get-full')
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await stage.openFromPalette(page, HARBOR)
    await runSheet.openFromPalette(page)
    await releaseChannel(app, 'db:review-get-full')
    await page.waitForTimeout(1500)
    const after = { runSheet: await runSheet.sheet(page).isVisible(), reviewSheet: await sheet.isVisible() }
    assert.deepEqual(after, { runSheet: true, reviewSheet: false }, '确认回来后港口里作者开的运行侧页还开着')
    return after
  } },

  // #405 r2 O8：生成蓝图前读架构的那次 IPC 慢了 4.5 秒，「架构还不完整」晚于 3 秒才出现；generateRange 仍等到它并点继续生成，运行开始。
  'x1-generate-slow-warning': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ app, page }) => {
    await blueprint.open(page)
    await holdChannel(app, 'db:project-core-get')
    const generating = blueprint.generateRange(page, 13, 16)
    await untilHeld(app, 'db:project-core-get')
    await page.waitForTimeout(4500)
    await releaseChannel(app, 'db:project-core-get')
    assert.equal(await generating, true, '等到了晚出现的警告并点了继续生成')
    await runSheet.waitUntilOpen(page)
    return { warned: true, runSheet: await runSheet.sheet(page).isVisible() }
  } },

  // #405 r2 O8 的正常路径：架构齐全（主进程读架构时补上角色名单）不弹警告，generateRange 在运行开始时就返回，不白等 3 秒。
  'x1-generate-no-warning': { model: true, shell: 'stage', setup: context => seedStageSample(context, { totalChapters: 16 }), run: async ({ app, page }) => {
    await app.evaluate(({ ipcMain }, cast) => {
      const handlers = ipcMain._invokeHandlers
      const original = handlers.get('db:project-core-get')
      handlers.set('db:project-core-get', async (event, ...args) => ({ ...await original(event, ...args), charactersArch: cast }))
    }, `林岚：守塔人的女儿，沿着父亲的地图寻找沉船。守塔人：在灯塔里守了三十年，知道雾钟坏过的那一次，也知道那条船的名字。`)
    await blueprint.open(page)
    const started = Date.now()
    const warned = await blueprint.generateRange(page, 13, 16)
    const elapsedMs = Date.now() - started
    assert.equal(warned, false, '架构齐全时没有警告')
    return { warned, elapsedMs, runSheet: await runSheet.sheet(page).isVisible() }
  } },

  // #404-1：书房里导入旧项目副本，复制期间作者开了设置页并输入；复制完成要自动打开作品时先确认，继续编辑就不打开。
  'x1-import-settings': { model: false, shell: 'stage', setup: seedTwoBooks({ open: false }), run: async context => {
    const { app, page } = context
    await stubChannel(app, 'dialog:select-legacy-project', { grantId: 'drive-legacy', displayName: '旧港口' })
    await stubChannel(app, 'dialog:select-project-restore-target', { grantId: 'drive-target', displayName: '港口' })
    await stubChannel(app, 'project:import-legacy-copy', { state: 'ready', projectId: 'drive-harbor', targetRoot: context.harbor.path })
    await holdChannel(app, 'project:import-legacy-copy')
    await stage.root(page).getByRole('button', { name: /^导入/ }).click()
    await page.getByRole('menuitem', { name: '导入旧项目副本…' }).click()
    await untilHeld(app, 'project:import-legacy-copy')
    await stage.root(page).getByRole('banner').getByRole('button', { name: '设置', exact: true }).click()
    await stage.settingsNav(page).waitFor({ state: 'visible' })
    const url = await dirtySkillsPage(page)
    await releaseChannel(app, 'project:import-legacy-copy')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 10_000 })
    await discardDialog(page).getByRole('button', { name: '继续编辑' }).click()
    await page.waitForTimeout(1000)
    const after = { url: await url.inputValue(), page: await stage.currentSettingsPage(page), spine: await stage.spine(page).isVisible() }
    assert.deepEqual(after, { url: SKILL_URL, page: '写作 Skills', spine: false }, '继续编辑后设置页与输入都在，作品没有打开')
    return after
  } },

  // #405 r1-2：导入完成要自动打开作品时的放弃确认开着，作者又按 Ctrl N，提示先处理确认框（r2 低项 6）；选继续编辑后导入照样收尾（不再占着导入入口），也不弹新建。
  'x1-import-overlap': { model: false, shell: 'stage', setup: seedTwoBooks({ open: false }), run: async context => {
    const { app, page } = context
    await stubChannel(app, 'dialog:select-legacy-project', { grantId: 'drive-legacy', displayName: '旧港口' })
    await stubChannel(app, 'dialog:select-project-restore-target', { grantId: 'drive-target', displayName: '港口' })
    await stubChannel(app, 'project:import-legacy-copy', { state: 'ready', projectId: 'drive-harbor', targetRoot: context.harbor.path })
    await holdChannel(app, 'project:import-legacy-copy')
    const importMenu = stage.root(page).getByRole('button', { name: /^导入/ })
    await importMenu.click()
    await page.getByRole('menuitem', { name: '导入旧项目副本…' }).click()
    await untilHeld(app, 'project:import-legacy-copy')
    await stage.root(page).getByRole('banner').getByRole('button', { name: '设置', exact: true }).click()
    await stage.settingsNav(page).waitFor({ state: 'visible' })
    const url = await dirtySkillsPage(page)
    await releaseChannel(app, 'project:import-legacy-copy')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 10_000 })
    await page.keyboard.press('Control+N')
    const reminded = await page.locator('.pi-toast-title').filter({ hasText: '请先处理「放弃未保存的修改？」' })
      .waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)
    await discardDialog(page).getByRole('button', { name: '继续编辑' }).click()
    await page.waitForTimeout(1000)
    const dialogs = await page.locator('[role="dialog"]:visible, [role="alertdialog"]:visible').count()
    const typed = await url.inputValue()
    await url.fill('')
    await stage.root(page).getByRole('button', { name: '返回书房' }).click()
    await importMenu.click()
    const importItem = page.getByRole('menuitem', { name: '导入旧项目副本…' })
    await importItem.waitFor({ state: 'visible' })
    const after = { reminded, dialogs, url: typed, importEnabled: await importItem.isEnabled() }
    await page.keyboard.press('Escape')
    assert.deepEqual(after, { reminded: true, dialogs: 0, url: SKILL_URL, importEnabled: true }, '按 Ctrl N 时提示先处理确认框；继续编辑后没有弹新建，导入入口不再占着')
    return after
  } },

  // #404-2：设置页里有没保存的输入时，Ctrl O 与作品菜单「打开其他作品…」先问放弃，再弹选文件夹。
  'x1-open-folder-order': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stubChannel(app, 'dialog:select-folder', null)
    await stage.openSettings(page)
    const url = await dirtySkillsPage(page)
    const asked = []
    for (const open of [() => page.keyboard.press('Control+O'), () => stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '打开其他作品…')]) {
      await open()
      await discardDialog(page).waitFor({ state: 'visible', timeout: 5000 })
      asked.push(await stubCalls(app, 'dialog:select-folder'))
      await discardDialog(page).getByRole('button', { name: '继续编辑' }).click()
    }
    const after = { folderDialogsBeforeAnswer: asked, folderDialogs: await stubCalls(app, 'dialog:select-folder'), url: await url.inputValue() }
    assert.deepEqual(after, { folderDialogsBeforeAnswer: [0, 0], folderDialogs: 0, url: SKILL_URL }, '先问放弃，继续编辑就不弹选文件夹')
    return after
  } },

  // #405 r1-1：设置页开着时打开作品，选文件夹时取消，设置页与输入都留着。有没保存的输入时先选放弃修改（不问的版本直接弹选文件夹）；
  // Ctrl O、作品菜单各一次，再清空输入后 Ctrl O 一次。
  'x1-open-folder-cancel': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stubChannel(app, 'dialog:select-folder', null)
    await stage.openSettings(page)
    const url = await dirtySkillsPage(page)
    const opens = [() => page.keyboard.press('Control+O'), () => stage.openWorkMenuItem(page, STAGE_SAMPLE.name, '打开其他作品…'), async () => {
      await url.fill('')
      await page.keyboard.press('Control+O')
    }]
    const after = []
    for (const [index, open] of opens.entries()) {
      await open()
      const asked = await discardDialog(page).waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)
      if (asked) await discardDialog(page).getByRole('button', { name: '放弃修改' }).click()
      await untilStubCalls(app, 'dialog:select-folder', index + 1)
      await page.waitForTimeout(800)
      after.push({ settings: await stage.settingsNav(page).isVisible(), url: await url.isVisible() ? await url.inputValue() : null })
      if (!after.at(-1).settings) break
    }
    assert.deepEqual(after, [
      { settings: true, url: SKILL_URL },
      { settings: true, url: SKILL_URL },
      { settings: true, url: '' },
    ], '取消选文件夹后设置页还开着，放弃过的输入也还在')
    return after
  } },

  // #405 r1-1 选到文件夹的一路：灯塔设置页有没保存的输入时 Ctrl O，选放弃修改，系统选文件夹选到港口（只替换 Electron 的对话框，授权照常签发），
  // 设置页收起、打开港口，确认只问一次。
  'x1-open-folder-pick': { model: false, shell: 'stage', setup: seedTwoBooks(), run: async context => {
    const { app, page } = context
    await app.evaluate(({ dialog }, selectedPath) => {
      globalThis.__drivePicks = 0
      dialog.showOpenDialog = async () => { globalThis.__drivePicks++; return { canceled: false, filePaths: [selectedPath] } }
    }, context.harbor.path)
    await stage.openSettings(page)
    await dirtySkillsPage(page)
    await page.keyboard.press('Control+O')
    await discardDialog(page).waitFor({ state: 'visible', timeout: 5000 })
    const picksBeforeAnswer = await app.evaluate(() => globalThis.__drivePicks)
    await discardDialog(page).getByRole('button', { name: '放弃修改' }).click()
    const harborMenu = stage.root(page).getByRole('banner').getByRole('button', { name: `《${HARBOR}》作品菜单` })
    await harborMenu.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(1000)
    const after = { picksBeforeAnswer, picks: await app.evaluate(() => globalThis.__drivePicks),
      settings: await stage.settingsNav(page).isVisible(), askedAgain: await discardDialog(page).isVisible() }
    assert.deepEqual(after, { picksBeforeAnswer: 0, picks: 1, settings: false, askedAgain: false }, '放弃后才选文件夹，选到港口就收起设置页打开它，不再问')
    return after
  } },

  // #403：作者回过一次书房（书房的布局与之后再回书房完全相同），从书房的 Ctrl K 重新打开作品，读完文件树前进作品又回书房，
  // 读完后不被换回作品。落点晚到的版本只比较提交前后的布局，两次都是作者亲手回的书房，比较通过。
  'x1-library-return': { model: false, shell: 'stage', setup: seedStageSample, run: async ({ app, page }) => {
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await holdChannel(app, 'fs:list-dir')
    await page.keyboard.press('Control+K')
    await stage.paletteInput(page).fill(STAGE_SAMPLE.name)
    await stage.palette(page).getByRole('option', { name: `打开《${STAGE_SAMPLE.name}》` }).click()
    await untilHeld(app, 'fs:list-dir')
    await enterWorkAfterOpening(page)
    await stage.backToLibrary(page, STAGE_SAMPLE.name)
    await releaseChannel(app, 'fs:list-dir')
    await page.waitForTimeout(2000)
    const after = { library: await stage.shelf(page).isVisible(), spine: await stage.spine(page).isVisible() }
    assert.deepEqual(after, { library: true, spine: false }, '读完文件树后仍在书房')
    return after
  } },

  // #395：打开作品、读完文件树前打开运行侧页，读完后侧页仍开着。
  'x1-run-sheet-keep': { model: false, shell: 'stage', setup: context => seedStageSample(context, { open: false }), run: async ({ app, page }) => {
    await openWithSlowFileTree(app, page)
    await runSheet.openFromPalette(page)
    await releaseChannel(app, 'fs:list-dir')
    await page.waitForTimeout(2000)
    const after = { runSheet: await runSheet.sheet(page).isVisible() }
    assert.deepEqual(after, { runSheet: true }, '读完文件树后运行侧页仍开着')
    return after
  } },
}
