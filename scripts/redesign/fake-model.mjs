import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

// 与 f05-u05、f05-u12 旅程相同的做法：主进程 fetch 改道到本机假 OpenAI 兼容服务，零真实模型调用。
export const FAKE_MODEL = Object.freeze({ id: 'redesign-drive-fixture', name: '驱动夹具模型', provider: 'openai', protocol: 'openai',
  modelName: 'gpt-4.1', baseUrl: 'https://api.openai.com/v1', apiKey: 'redesign-drive-offline-key',
  maxTokens: 4096, temperature: 0.7, purposes: ['generation'] })

export const FIXTURE_ENDPOINT_MODELS = Object.freeze(['gpt-5.5-mini', 'gpt-4.1', 'gateway/novel-writer-pro', 'text-embedding-3-small',
  'gateway/very-long-model-identifier-for-layout-checks-2026-10-24-preview', ...Array.from({ length: 12 }, (_, index) => `gateway/model-${String(index + 1).padStart(2, '0')}`)])

export const FIXTURE_PROSE = '林岚沿着旧港的石阶往下走，潮水刚退，青石上还留着一层薄薄的盐霜。她把父亲留下的地图摊在膝头，对照远处灯塔的位置，一格一格数过去。守塔人站在塔下朝她招手，说昨夜的钟声比往常早了一刻。'
const FIXTURE_REVISED = `${FIXTURE_PROSE}林岚把这句话记进日志，又核对了一遍潮位表。`
const REVIEW = JSON.stringify({ summary: '时间线需要核对。', items: [
  { category: '连续性', severity: 'warning', description: '核对钟声提前一刻与潮位的关系。', quote: '昨夜的钟声比往常早了一刻' },
], goalReviews: [] })

/** 创作资料角色提取：每个资料块回一张守塔人与一张林岚（示例作品已有林岚，可以对应已有角色）。 */
function characterExtraction(prompt, cards) {
  const sourceIds = [...prompt.matchAll(/【资料 ([^｜】]+)｜/gu)].map(match => match[1])
  return JSON.stringify({ results: sourceIds.map(sourceId => ({ sourceId, characterCards: [
    { name: '守塔人', role: 'supporting', background: '灯塔看守，记得每一次钟声。' },
    { name: '林岚', role: 'protagonist', background: '旧港潮汐记录的测绘师。' },
  ].slice(0, cards) })) })
}

/** AI 填充小说配置：按配置 JSON 合同给出 9 个必填字段与两个枚举；规模字段省略，由作者设置决定。 */
export const FIXTURE_CONFIG = Object.freeze({
  genre: '悬疑', targetAudience: '全龄', subGenre: '海港悬疑',
  coreOutline: '测绘师在停用的灯塔里追查一条沉船。',
  worldSetting: '旧港以潮汐计时，港务局的档案按潮期装订。',
  goldenFinger: '林岚能从潮位刻痕里读出年份。',
  protagonistProfile: '林岚，测绘师，冷静而执拗，相信一切都能量出来。',
  globalGuidance: ['对白克制，不替人物解释动机。', '每章至少写到一次潮水或灯光。', '线索先于解释出现。', '不使用倒叙开篇。'].join('\n'),
  writingStyle: '短句为主，多用潮汐与灯光的意象，叙述距离贴近林岚。',
  plotStructure: 'three_act', narrativePOV: 'third_limited',
})

/** 情节大纲逐章生成：每次只要一章，回这一章的二级标题与一段正文，章号取自请求。 */
export const outlineChapter = number => `## 第${number}章：灯下第${number}夜
林岚在第${number}夜核对雾钟与潮位，找到一条新的线索，并决定下一步去问守塔人。她把这一夜的发现记进父亲的地图边上。`

/**
 * 剧情树夹具：定稿章与单数位的蓝图章进主线，双数位的蓝图章进一条支线。来源全部取自提示里的资料，能通过主进程的校验；
 * 不开时假模型回正文，剧情树落到按资料整理的单轨快照。
 */
export function fixturePlotTree(facts) {
  const finals = new Set(facts.finalizedChapters.map(chapter => chapter.chapterNumber))
  const planned = facts.blueprints.filter(blueprint => !finals.has(blueprint.chapterNumber))
  const plan = blueprint => ({ status: 'planned', chapterNumber: blueprint.chapterNumber, summary: blueprint.title,
    sources: [{ type: 'blueprint', chapterNumber: blueprint.chapterNumber }] })
  const main = [
    ...facts.finalizedChapters.map(chapter => ({ status: 'occurred', chapterNumber: chapter.chapterNumber, summary: chapter.title,
      sources: [{ type: 'finalized-chapter', draftId: chapter.draftId, chapterNumber: chapter.chapterNumber }] })),
    ...planned.filter((_, index) => index % 2 === 0).map(plan),
  ].sort((left, right) => left.chapterNumber - right.chapterNumber)
  const side = planned.filter((_, index) => index % 2 === 1).map(plan)
  const span = events => ({ startChapter: Math.min(...events.map(event => event.chapterNumber)), endChapter: Math.max(...events.map(event => event.chapterNumber)) })
  return { tracks: [
    { id: 'main', title: '雾钟与沉船', role: 'main', ...span([...main, ...side]), summary: '林岚追查钟声提前的原因。', events: main },
    ...(side.length > 0 ? [{ id: 'side', title: '父亲的地图', role: 'subplot', parentTrackId: 'main', ...span(side), summary: '父亲留下的地图指向北堤外。', events: side }] : []),
  ] }
}

const IMPORT_CARD = { gender: '未知', age: '30', appearance: '风衣', personality: '谨慎', background: '旧港居民', abilities: '观察',
  motivation: '查明灯塔的秘密', relationships: [], arc: '从旁观到行动', notes: '导入推演',
  currentState: { location: '旧港', powerLevel: '普通', physicalState: '正常', mentalState: '警觉', keyItems: '地图', recentEvents: '找到旧信', updatedAtChapter: 0 } }

/** 参考小说导入的全局推演与分批蓝图推演；不开时与以前一样回正文。 */
function importReply(prompt) {
  if (prompt.includes('【不可变导入推演 JSON 合同】')) {
    return { kind: 'import-global', content: JSON.stringify({
      novelConfig: { genre: '悬疑', subGenre: '海港', targetAudience: '成年读者', plotStructure: 'three_act', narrativePOV: 'third_limited',
        coreOutline: '林岚追查灯塔与沉船的旧事', worldSetting: '雾中的旧港', goldenFinger: '无', protagonistProfile: '旧港测绘师', globalGuidance: '克制叙事' },
      architectureFiles: { premise: '灯塔里藏着沉船的真相', worldbuilding: '潮汐与雾钟主宰旧港', synopsis: '林岚一章章揭开沉船旧事' },
      characterCards: [['林岚', 'protagonist'], ['周叔', 'supporting'], ['沈舟', 'antagonist']].map(([name, role]) => ({ name, role, ...IMPORT_CARD })),
    }) }
  }
  const batch = /本批必须且只能完整返回以下 chapterNumber：([\d、]+)。/u.exec(prompt)
  if (batch) {
    return { kind: 'import-blueprints', content: JSON.stringify({ blueprints: batch[1].split('、').map(Number).map(chapterNumber => ({
      chapterNumber, title: `第${chapterNumber}章`, role: '发展', purpose: '推进灯塔线索', keyEvents: '林岚沿着潮汐表继续追查沉船的来历',
      characters: ['林岚'], relationships: [], suspenseHook: '雾钟又在深夜响起' })) }) }
  }
  return null
}

function responseFor(prompt, { extraction, plotTree, review, characterState, importInference }) {
  const imported = importInference ? importReply(prompt) : null
  if (imported) return imported
  if (prompt.includes('不可变小说配置 JSON 合同') || prompt.includes('Immutable novel-configuration JSON contract')) {
    return { kind: 'config', content: JSON.stringify(FIXTURE_CONFIG) }
  }
  if (typeof review === 'function') {
    const custom = review(prompt)
    if (custom !== null && custom !== undefined && typeof custom !== 'string') throw new Error('replyReview 的函数只能返回文本或空值')
    if (custom) return { kind: 'review', content: custom }
  }
  const outline = prompt.match(/本次只写第 (\d+) 章/)
  if (outline) return { kind: 'outline-chapter', content: outlineChapter(Number(outline[1])) }
  if (prompt.includes('【已确认纳入本次修稿的审稿项】')) return { kind: 'revision', content: FIXTURE_REVISED }
  if (prompt.includes('goalReviews')) return { kind: 'review', content: typeof review === 'string' ? review : REVIEW }
  if (prompt.includes('{"updates"')) return { kind: 'character-state', content: characterState?.(prompt) ?? '{"updates":[]}' }
  if (extraction && prompt.includes('【资料 ')) return { kind: 'character-extraction', content: characterExtraction(prompt, extraction) }
  if (plotTree && prompt.includes('小说剧情结构编辑')) return { kind: 'plot-tree', content: JSON.stringify(fixturePlotTree(JSON.parse(prompt.split('\n').find(line => line.startsWith('{"synopsis"'))))) }
  if (prompt.includes('只写短细纲')) return { kind: 'outline', content: FIXTURE_PROSE }
  return { kind: 'prose', content: FIXTURE_PROSE }
}

/** 按固定节奏流出的正文：每块一句、以「。」结尾，界面里数「。」就知道哪一块已经显示出来。 */
export function streamingProse(chunks, chunkChars) {
  const filler = '林岚沿着旧港的石阶往下走潮水刚退青石上还留着一层薄薄的盐霜她把父亲留下的地图摊在膝头对照远处灯塔的位置一格一格数过去'
  return Array.from({ length: chunks }, (_, index) => {
    const head = `第${index + 1}句`
    return `${head}${filler.repeat(2).slice(0, chunkChars - head.length - 1)}。`
  })
}

export async function startFakeModel(diagnostics) {
  const requests = []
  /** 对话请求的模型与消息原文，按到达顺序；场景用它核对两边发给模型的参数是否一致。 */
  const chats = []
  let held = null
  let holdEmbeddings = false
  let waiting = 0
  let stream = null
  let extraction = 0
  let brokenCharacterState = false
  let droppedCharacterStates = 0
  let plotTree = false
  let failedProse = false
  let review = null
  let characterState = null
  let keylessEmbeddings = false
  let importInference = false
  let contextLengthRejection = null
  /** 每次被接受的嵌入请求带的 Authorization 头（没有时为 null），场景据此确认本机检索模型真的没带 Key。 */
  const embeddingAuthorizations = []
  const streamLog = []
  const gate = {
    /** 卡住之后的模型调用；embeddings 为 true 时连嵌入也卡住（参考文本入库这类只走嵌入的步骤）。 */
    hold: ({ embeddings = false } = {}) => { held ??= Promise.withResolvers(); holdEmbeddings = embeddings },
    release: () => { held?.resolve(); held = null; holdEmbeddings = false },
    /** 正卡在门上的请求数，场景据此确认运行已停在要截的那一步。 */
    get waiting() { return waiting },
  }
  const pass = async () => {
    if (!held) return
    waiting++
    try { await held.promise } finally { waiting-- }
  }
  /** 之后的正文回复按 chunks 逐块发出，块间隔 intervalMs；每块发出的时刻记进 streamLog（epoch 毫秒与累计块数）。 */
  const streamProse = plan => { stream = plan; streamLog.length = 0 }
  /** 之后的创作资料角色提取回一份合法 JSON（每份资料默认两张卡，cards 限定张数，夹具只有 1–2 张）；不开时与以前一样回正文，提取失败，导入类场景不会停在等你确认。 */
  const replyCharacterCards = (cards = 2) => {
    if (cards !== 1 && cards !== 2) throw new Error(`replyCharacterCards: cards 只能是 1 或 2，收到 ${cards}`)
    extraction = cards
  }
  /** 定稿后处理的角色状态更新收到不是 JSON 的回复，这一步失败；传 false 恢复，用来演示只重试失败的步骤。 */
  const breakCharacterState = (broken = true) => { brokenCharacterState = broken }
  /** 之后 times 次角色状态请求回 200 后不发任何内容就断开连接（#420 的断流），用来演示重试真的重新请求。 */
  const dropCharacterState = (times = 1) => { droppedCharacterStates = times }
  /** 之后的剧情树整理回一份两轨（主线加支线）的合法 JSON。 */
  const replyPlotTree = () => { plotTree = true }
  /** 之后的正文回复以 content_filter 结束：写稿在这次打开里失败，留下可恢复的候选。传 false 恢复。 */
  const failProse = (failed = true) => { failedProse = failed }
  /** 之后的审稿（含合并后的复验）回这份 JSON；不调用时回默认审稿。也可传函数：它对任意提示词返回非空文本时就回这段文本（含修稿请求），返回空值时照常作答；它给出的回复一律记作 review。 */
  const replyReview = content => { review = content }
  /** 之后的定稿后处理角色状态更新回 build(提示词) 给出的 JSON 文本；不调用时回空的 updates。 */
  const replyCharacterState = build => { characterState = build }
  /** 之后不带 Key 的嵌入请求也照常回向量，模拟不需要 Key 的本机检索服务；传 false 恢复拒绝。 */
  const acceptKeylessEmbeddings = (accepted = true) => { keylessEmbeddings = accepted }
  /** 之后的参考小说导入：全局推演回一份合法 JSON（三张角色卡），分批蓝图推演按本批章号回齐全的蓝图。 */
  const replyImport = () => { importInference = true }
  const rejectContextLength = (rejected = true) => {
    if (!rejected) { contextLengthRejection = null; return }
    const sample = new URL('../../electron/llm/__tests__/provider-context-length-samples.json', import.meta.url)
    try { contextLengthRejection = JSON.parse(readFileSync(sample, 'utf8')).deepseek }
    catch (error) { throw new Error(`rejectContextLength: 读不出错误体样本 ${fileURLToPath(sample)}`, { cause: error }) }
    if (!contextLengthRejection?.error?.message) throw new Error('rejectContextLength: 样本缺少 deepseek 错误体')
  }
  const record = (kind, detail) => {
    requests.push(kind)
    diagnostics.push(`[fake-model] ${kind} <- ${detail}`)
  }
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models' && request.headers.authorization === `Bearer ${FAKE_MODEL.apiKey}`) {
      record('models', 'GET /v1/models')
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: FIXTURE_ENDPOINT_MODELS.map(id => ({ id })) }))
      return
    }
    const keyless = keylessEmbeddings && request.url === '/v1/embeddings' && !(request.headers.authorization ?? '').replace(/^Bearer\s*/u, '')
    if (request.method !== 'POST' || (request.headers.authorization !== `Bearer ${FAKE_MODEL.apiKey}` && !keyless)) {
      response.writeHead(403).end(); return
    }
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'))
    if (request.url === '/v1/embeddings') {
      if (holdEmbeddings) await pass()
      const input = Array.isArray(body.input) ? body.input : [body.input]
      embeddingAuthorizations.push(request.headers.authorization ?? null)
      record('embedding', `${input.length} 条${keyless ? '（无 Key）' : ''}`)
      response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }))
      return
    }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
    await pass()
    if (contextLengthRejection) {
      record('context-length', `${Buffer.byteLength(JSON.stringify(body.messages ?? []))} 字节`)
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify(contextLengthRejection))
      return
    }
    const prompt = (body.messages ?? []).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
    const reply = responseFor(prompt, { extraction, plotTree, review, characterState, importInference })
    const { kind } = reply
    const content = kind === 'character-state' && brokenCharacterState ? '角色状态暂时无法整理。' : reply.content
    chats.push({ kind, model: body.model, messages: body.messages })
    record(kind, prompt.slice(0, 120).replace(/\s+/g, ' '))
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (kind === 'character-state' && droppedCharacterStates > 0) {
      droppedCharacterStates--
      response.flushHeaders()
      response.destroy()
      return
    }
    const finish = kind === 'prose' && failedProse ? 'content_filter' : 'stop'
    if (kind === 'prose' && stream) {
      for (const [index, chunk] of stream.chunks.entries()) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`)
        streamLog.push({ at: Date.now(), count: index + 1 })
        await new Promise(resolve => setTimeout(resolve, stream.intervalMs))
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`)
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`)
    }
    response.write('data: {"choices":[],"usage":{"prompt_tokens":400,"completion_tokens":200,"total_tokens":600}}\n\n')
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  server.unref()
  return { port: server.address().port, requests, chats, gate, streamProse, streamLog, replyCharacterCards, breakCharacterState, dropCharacterState, replyPlotTree, failProse, replyReview, replyCharacterState, acceptKeylessEmbeddings, replyImport, rejectContextLength, embeddingAuthorizations,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
