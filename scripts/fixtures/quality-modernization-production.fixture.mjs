import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { test, vi } from 'vitest'
import { updateLedger, CAMPAIGN_ID } from '../quality-modernization-run.mjs'
import { selectOwnerDispatch, targetUnitsGateEvidence, createAttemptSupervisor, createOperationDispatchGate,
  createOutboundPreflightAssert, rejectOutsidePhysicalBoundary, assertNoOutboundPreflightFailures,
  fetchProviderResponse, measurePromptBytes, BRIDGE_SETTLEMENT_DEADLINE_MS,
  BRIDGE_TEST_TIMEOUT_MS } from '../quality-modernization-driver.mjs'
import { projectRecoveryCandidateSupplement, recordPersistedDraftObservation, safeReceiptDiagnostic } from '../quality-modernization-receipt.mjs'

// This adapter replaces the Electron transport, never a command/runtime/repository.
// The final provider fetch is the sole synthetic/real response switch.
const transport = vi.hoisted(() => ({ handlers: new Map(), listeners: new Map(), sender: null }))
vi.mock('electron', () => ({
  ipcMain: { handle: (name, handler) => { if (transport.handlers.has(name)) throw new Error(`DUPLICATE_IPC:${name}`); transport.handlers.set(name, handler) } },
  app: { getLocale: () => 'zh-CN', getPath: () => process.env.QUALITY_USER_DATA, isPackaged: false },
  BrowserWindow: { getAllWindows: () => transport.sender ? [{ webContents: transport.sender }] : [],
    fromWebContents: () => ({ webContents: transport.sender }) },
  dialog: {}, shell: {}, nativeImage: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const templateKeysForPhase = phase => phase === 'c16-c18'
  ? ['generate_chapter_notes', 'update_character_cards', 'first_chapter_draft', 'next_chapter_draft']
  : phase === 'early-review'
  ? ['consistency_check', 'refine_from_review']
  : ['chapter_blueprint_chunk', 'first_chapter_draft', 'next_chapter_draft']
/** 合成正文按目标单位数配长：既不低于 70% 下限，也不触发自动续写。 */
const syntheticDraftText = (countUnits, targetUnits, chapterNumber = 1) => {
  const line = index => chapterNumber === 2
    ? `午后，两人来到核查地点，第${index + 1}份申请被看守退回。风从门缝灌进来，桌边的烛火晃了一下。他们交出当天的工钱换取查阅机会，把收据收进口袋，等候下一轮登记。`
    : chapterNumber === 3
      ? `翌日，第${index + 1}处印迹与原件的缺口吻合。窗外已经放晴，光落在刚刚摊开的纸页上。他们选定公开证据的办法，将副本递交值班室。负责人签收之后暂停了相关手续，屋里的人逐一离去。`
      : `清晨，林澄核对第${index + 1}行登记，发现日期异常。他握紧铜钥匙，与沈岸商定雨停后到现场核查。`
  const lines = []
  while (countUnits(lines.join('\n')) < targetUnits && lines.length < 500) lines.push(line(lines.length))
  return lines.join('\n')
}
const optionalPredecessorBody = spec => `${spec.line.repeat(spec.repeat)}\n${spec.marker}`
const previousChapterEnding = content => {
  const trimmed = content.trim()
  if (trimmed.length <= 1_000) return trimmed
  const tail = trimmed.slice(-1_000)
  const firstBoundary = /(?:\r?\n\s*\r?\n|[。！？!?][”’"'）)\]】」』]*|\.[”’"')\]]*(?=\s|$))/u.exec(tail)
  return firstBoundary ? tail.slice(firstBoundary.index + firstBoundary[0].length).trim() || tail.trim() : tail.trim()
}
const REVIEW_DEFECT = '许遥把三种处置都抄进未决栏，又把纸推回桌角。她让周砚按原定时间收工，自己保留次日的主镜复核名额，也没有动用当日交通补贴；在山雨封路前，两人仍按原排班完成交接，没有产生任何新的执行凭据。'
const REVIEW_FIX = '许遥当场把次日的主镜复核名额让给替班员，电子排班表里她的名字随即被划去；她又用当日交通补贴支付山下值守员的夜间费用，把已到账的收据编号写进处置单。'
const reviewRevisionFixtureVerdict = text => {
  const performedChoice = /(?:当场|已经|随即|已到账|熬过|守了|拆下|接上).{0,40}(?:让给|划去|支付|失去|消耗|耗尽|承受|通宵|整夜|除湿器)/u.test(text)
  const realizedCost = /(?:名字随即被划去|用.{0,20}(?:补贴|应急金).{0,12}支付|已到账的收据|失去.{0,20}(?:名额|工资|休息)|熬过.{0,12}(?:通宵|整夜)|电量当场耗尽|守了一整夜|排班记录.{0,12}缺席)/u.test(text)
  const promiseOnly = /(?:决定承担|签字承担责任|保证负责|将放弃休息|以后补偿)/u.test(text)
  const contradiction = /(?:留下看守|守了一夜).{0,80}(?:仍按原定时间离开|仍离开)|(?:已经签字|签了字).{0,80}(?:签名栏空白|还没人落笔)/u.test(text)
  return { performedChoice, realizedCost, consistent: !contradiction, valid: performedChoice && realizedCost && !promiseOnly && !contradiction }
}
assert.equal(reviewRevisionFixtureVerdict(REVIEW_FIX).valid, true, 'PRIVATE_REVIEW_FIX_MUST_SATISFY_RUBRIC')
const naturalPredecessorText = scene => {
  const separator = scene.authorPredecessor.indexOf('：')
  const entry = separator >= 0 ? scene.authorPredecessor.slice(separator + 1) : scene.authorPredecessor
  return `${entry}\n\n值班室的旧钟仍停在交接时刻，桌上的现场记录尚未添上新的结论。`
}
const reviewSourceText = (countUnits, scene, chapter) => {
  assert.equal(`${scene.id}/${chapter.number}`, '场景3/2', 'REVIEW_SOURCE_SCENARIO_MISMATCH')
  const predecessorEntry = naturalPredecessorText(scene).split('\n\n', 1)[0]
  const narrative = [
    '同日午后，长夜观星台的穹顶仍压着一层灰白的云。许遥从值班室出来时，把清晨抄下的日期夹在硬纸板里，纸角被山风吹得不停发颤。她没有把那串相差一天的数字当成抄写错误，因为旧钟在整点报时后，记录仪上的分钟标记又慢了整整七格。',
    '维修员周砚已经等在主镜室门外。他的工具箱摊在脚边，里面少了常用的校准尺，多了一卷封条和两副棉布手套。周砚刚提到自己的猜测，许遥就在记录栏里画了一个铅笔问号，等现场痕迹给出下文。',
    `许遥翻到值班簿的前一页，清晨的交接记录还压在纸页下：${predecessorEntry} 她把记录夹回原处，准备从现场留下的痕迹继续核查。`,
    '主镜室的门一打开，冷气就从金属地板下涌上来。望远镜主镜开裂，不能进行精密观测，这件事已经写进故障簿。裂纹从镜缘向内伸出三道细叉，在侧灯下像结冰的河面。许遥没有靠近，只让周砚确认封条编号仍与清晨一致。',
    '周砚蹲下检查支架，先看螺栓上的漆记，再看底座周围的灰。他说昨夜没有人动过主镜，至少没有留下拆卸的痕迹。许遥写下“未见拆卸痕迹”，又把后面刚起笔的“无人进入”划掉；门锁记录和人员记录还没对完。',
    '他们的目标是找到日期错位发生在哪一道记录链上。观测台有三套时间来源：墙上的旧钟、记录仪内部时钟和山脚气象站每天上传的校时包。旧钟可以人工拨动，记录仪只有断电重启时会回到默认值，气象站的包则有独立签名。',
    '许遥先核对气象站的签名。三份纸质回执都盖着同一个椭圆章，墨色由深到浅，顺序正常。周砚把回执举到窗边，看见第二份背面沾着极细的白色粉末。那不是山路上的石灰，更像主镜室保温层脱落后的填料。',
    '“有人拿着回执来过这里。”周砚说。许遥把样品袋举到灯下：“先记回执背面的粉末。”她写上时间和地点，再把“观测员许遥”“维修员周砚”分别填进记录人与设备复核人两栏，各留一处签名线。',
    '记录仪的检修口在底座背面。周砚拆下外盖，发现备用电池的铅封完好，供电线却有一次重新压接的痕迹。铜片边缘很亮，和周围氧化的颜色不一致。他没有直接拔线，而是让许遥先拍下接点，再用万用表读取当前电压。',
    '数值稳定，说明眼下供电没有问题。真正需要核查的是前一夜有没有短暂掉电。设备日志可以回答，但日志被分成主机和手写两份：主机文件要在控制台导出，手写本锁在楼下档案柜，钥匙由当班观测员和维修员各持一半。',
    '两人下楼时，走廊尽头的应急灯忽明忽暗。许遥想起清晨值班员曾说过一次“灯闪”，当时没有写进交接。她只在便签上标了“待核实”，把便签别进未办夹，昨夜日志仍停在原来的最后一行。',
    '档案柜的双锁都没有撬痕。许遥开左锁，周砚开右锁，柜门却只弹开一条缝。里面有东西顶住了门。周砚用薄尺探进去，拨出一只倒下的铁皮文件盒，盒角正卡在门框后面，表面的灰被擦出一道新痕。',
    '文件盒里装的是最近三个月的供电检修单。许遥按日期排序，发现中间少了一张；编号从四十七直接跳到四十九。第四十八号单据的存根仍在装订册上，撕口很新，登记人一栏却只剩半个模糊的“周”字。',
    '周砚看了很久，说那不是他的笔迹。他写“周”字时习惯先收竖钩，存根上的钩向外挑。许遥让他在空白纸上写三遍作为对照，把对照纸和存根分别封存，故障簿的责任人一栏仍然空着。',
    '他们把缺失单据的编号输入控制台。系统显示第四十八号检修发生在昨夜二十二点十四分，项目是“时钟模块复位”，执行账号属于维修组。可周砚昨夜在山腰泵房，门禁记录和两名值班员都能证明他没有上楼。',
    '许遥继续查账号登录地点。控制台只保存终端编号，不保存房间名称；编号 T-03 按旧图纸应在主镜室，按去年改造清单又被移到了储藏层。她把两份文件并排夹好，终端位置一栏只写了一个问号。',
    '周砚提出去储藏层找 T-03。许遥没有同意立刻分开行动。她先把粉末样品、接线照片和文件盒依次排在桌上，让周砚逐件复核发现时间，两人完成签名后才合上封存袋。',
    '她在档案桌上铺开封存袋，逐件朗读编号。周砚复核后签名，两个人交换位置再查一遍。做到缺失单据存根时，楼顶传来一声沉闷的撞击，像穹顶制动器突然松开半格。紧接着，控制台的风扇声停了。',
    '核查途中突遇断电，核查受阻。走廊先暗，随后应急灯转成昏黄，档案柜的电磁锁在失电后自动闭合，把尚未取出的手写供电日志重新锁在里面。控制台也来不及导出主机文件，屏幕只留下一个没有保存的进度框。',
    '周砚立即去配电间，许遥留在档案室看守已取出的证物。对讲机里传来断续的电流声：山下线路正常，故障只在观星台内部。周砚让她不要碰总闸，因为保护器刚刚动作，贸然合闸可能烧坏仍连着主镜支架的传感器。',
    '窗外的云层压得更低，山路上的白线渐渐看不清。许遥点亮手电，把每一只封存袋的位置画在纸上。她能听见楼板里的金属管道冷却收缩，也能听见档案柜内有什么薄薄的东西慢慢滑落，却无法打开柜门确认。',
    '十五分钟后，周砚回来，手套上沾着黑色粉尘。他确认二层分路的熔断片烧断，备用熔断片却不在配电箱里。周砚只说旧设备清单记过一面备用镜，自己从未见过实物，也不知道任何未登记备件被移去了哪里。',
    '他只能用现有材料做临时隔离，不能恢复主镜室供电。若要在天黑前保住证据，就不能维持原来的安排：留在档案室守夜会错过次日唯一的主镜复核名额，请山下值守员赶来需要立刻垫付整日交通补贴，拆用个人应急电源则会让返程照明失去保障。',
    '许遥计算了剩余时间，把三种处置各自会失去的东西逐项写进未决栏。山雨正在封路，每一种选择都必须立刻执行才来得及，单凭写下风险不会改变证物的处境。',
    '周砚建议先把已取出的材料拍照，再等供电恢复。许遥摇头。相机只剩一格电，缺失的原始日志仍锁在柜内；她在“等待供电”旁记下山雨逼近的时间，把处置单压在记录本上。',
    '雨点开始敲击穹顶，声音由疏到密。许遥想起清晨那串日期：如果记录仪确实在昨夜复位，错误时间会影响裂纹扩展数据，却不会让裂纹本身消失。她必须保住能够证明复位发生过的纸面链条。',
    REVIEW_DEFECT,
    '这段处置记录写在临时单的末尾，墨迹比前面的字更重。周砚读完，没有替她补作选择，只把单据放回两人之间，等实际执行后再登记凭据。',
    '他们仍可以做不需要供电的工作。周砚拆下烧坏的熔断片，装入透明盒；许遥记录盒子的重量和封条号。两人沿着二层线路检查墙面，没有发现焦痕，却在通往控制台的线槽边找到一小段新剥落的绝缘皮。',
    '绝缘皮切口整齐，不像自然老化。周砚用尺量过宽度，在记录上写下“与控制台供电线同规格”，又在图纸上圈出三个待检测的位置。照明和绝缘检测都还没有恢复。',
    '档案室里的响动再次出现。许遥贴近柜门，听见纸张滑落的轻响。她在门外贴上跨缝封条，让周砚拍照并签字；记录本里，第四十八号单据那一栏仍然空着。',
    '下午五点，雨水沿西窗渗进来。两人把已封存的材料移到内侧桌面，移动前后各拍一张位置照。许遥在每条移动记录的理由栏里写下“避水”。',
    '周砚又检查了一遍主镜室门口的机械封条。封条完好。他随后用手电照过通风井和检修口，那里没有封条，许遥便把记录页对应的两格留空。',
    '备用镜的去向仍然没有答案。周砚只知道旧设备清单上曾有一面备用镜，却不知道它现在存放在哪里；许遥在清单旁画了问号，留待恢复供电后继续查找。',
    '天色彻底暗下去以前，供电仍未恢复。主机日志没有导出，手写本仍锁在柜内，第四十八号检修单也没有找到。处置单与当时形成的凭据一并压在记录本下面，留待交接时核验。',
    '许遥把清晨抄下的日期、粉末样品、存根和熔断片放进同一只周转箱，四件证物各自封装，没有混合。周砚核对箱号后在骑缝处签名。申请解锁的表格和线路检测工具仍放在桌上。',
    '离开档案室时，一阵穿堂风掀起记录本的最后一页。许遥伸手压住，处置单从下面露出半截，末尾的执行记录和凭据编号仍可逐项核对。',
  ].join('\n\n')
  const units = countUnits(narrative)
  assert.ok(units >= Math.floor(chapter.targetUnits * 0.7) && units <= Math.ceil(chapter.targetUnits * 1.3), 'REVIEW_SOURCE_TARGET_UNITS_FAILED')
  for (const fact of Object.values(chapter.oracle ?? {}).flatMap(value => Array.isArray(value) ? value : [value])
    .filter(fact => fact !== chapter.oracle?.knowledge && fact !== chapter.oracle?.planning)) {
    assert.ok(narrative.includes(fact), `REVIEW_SOURCE_ORACLE_FACT_MISSING:${fact}`)
  }
  assert.ok(narrative.includes('周砚只说旧设备清单记过一面备用镜，自己从未见过实物'), 'REVIEW_SOURCE_KNOWLEDGE_FACT_MISSING')
  assert.ok(narrative.includes('把便签别进未办夹，昨夜日志仍停在原来的最后一行'), 'REVIEW_SOURCE_PLANNING_FACT_MISSING')
  assert.equal(narrative.split(REVIEW_DEFECT).length - 1, 1, 'REVIEW_SOURCE_DEFECT_COUNT_INVALID')
  return narrative
}
function readCommittedDraftChapterInfo(db, chapter, projectPath, chapterGuidance) {
  const row = db.prepare(`SELECT chapter_number AS chapterNumber,title,role,purpose,key_events AS keyEvents,
    characters,suspense_hook AS suspenseHook,user_guidance AS userGuidance
    FROM blueprints WHERE chapter_number=?`).get(chapter.number)
  assert.ok(row && row.chapterNumber === chapter.number, 'DRAFT_COMMITTED_BLUEPRINT_REQUIRED')
  let characters
  try { characters = JSON.parse(row.characters) } catch { throw new Error('DRAFT_COMMITTED_BLUEPRINT_INVALID') }
  assert.ok([row.title, row.role, row.purpose, row.keyEvents].every(value => typeof value === 'string' && value.trim())
    && typeof row.suspenseHook === 'string' && typeof row.userGuidance === 'string'
    && Array.isArray(characters) && characters.every(value => typeof value === 'string' && value.trim()),
  'DRAFT_COMMITTED_BLUEPRINT_INVALID')
  return { projectPath, chapterNumber: row.chapterNumber, title: row.title, role: row.role, purpose: row.purpose,
    characters, keyEvents: row.keyEvents, suspenseHook: row.suspenseHook,
    userGuidance: [...new Set([row.userGuidance.trim(), chapterGuidance.trim()].filter(Boolean))].join('\n'),
    wordsTarget: chapter.targetUnits }
}
function draftPromptIncludesCommittedBlueprint(userPrompt, chapterInfo, purpose) {
  const initial = purpose === 'chapter-draft'
  if (!initial && !['chapter-draft-continuation', 'chapter-draft-no-progress-recovery'].includes(purpose)) return false
  const heading = initial ? chapterInfo.chapterNumber === 1 ? '【本章信息】' : '【本章写作方向与核心任务】' : '【本章蓝图】'
  const next = initial ? '【后续章节大纲预告】' : '【全局写作要求】'
  const marker = `\n${heading}\n`
  const start = userPrompt.indexOf(marker)
  if (start < 0 || userPrompt.indexOf(marker, start + marker.length) >= 0) return false
  const end = userPrompt.indexOf(`\n${next}`, start + marker.length)
  if (end < 0) return false
  let sent
  try { sent = JSON.parse(userPrompt.slice(start + marker.length, end).trim()) } catch { return false }
  return sent && typeof sent === 'object' && !Array.isArray(sent)
    && ['chapterNumber', 'title', 'role', 'purpose', 'characters', 'keyEvents', 'suspenseHook', 'userGuidance']
      .every(key => Object.hasOwn(sent, key) && JSON.stringify(sent[key]) === JSON.stringify(chapterInfo[key]))
}
const syntheticReview = chapter => JSON.stringify({
  summary: '本章完成受阻事件，但人物只罗列选择，没有执行会造成已实现损失的处置。',
  items: [{ category: '本章目标', severity: 'error', description: '人物罗列了代价方案，却没有执行任何会造成已实现损失或牺牲的选择，未满足当章“承担代价”的目标；有效修订必须同时写明已执行的选择、已经发生的具体损失，并消除后文反证，签字认责或承诺以后负责不算代价。', quote: REVIEW_DEFECT }],
  goalReviews: chapter.requiredEvents.map((event, index) => index === 0
    ? { id: `ch${chapter.number}:keyEvents:${index + 1}`, evidence: [{ quote: '核查途中突遇断电，核查受阻。' }],
        description: `${event}已有正文证据。`, status: 'completed' }
    : { id: `ch${chapter.number}:keyEvents:${index + 1}`, evidence: [{ quote: REVIEW_DEFECT }],
        description: `${event}被正文明确否定。`, status: 'unmet' }),
})

test('isolated production commands persist the selected phase operations', async () => {
  const requestBytes = fs.readFileSync(process.env.QUALITY_BRIDGE_REQUEST, 'utf8')
  const request = JSON.parse(requestBytes)
  const target = request.target
  const fullRun = request.phase === 'full'
  const continuityRun = request.phase === 'c16-c18'
  const evidenceRoot = request.evidenceRoot ?? target.isolationRoot
  const source = json(request.semanticPath)
  const continuityCase = continuityRun ? source.continuityQualificationCases.find(item => item.id === request.caseId) : null
  if (continuityRun) assert.ok(continuityCase && continuityCase.sceneId === request.sceneId
    && continuityCase.chapterNumber === request.chapterNumber, 'CONTINUITY_CASE_NOT_REGISTERED')
  const scene = source.scenes.find(value => value.id === request.sceneId)
  assert.ok(scene, 'SCENE_NOT_REGISTERED')
  const chapter = scene.chapters[request.chapterNumber - 1]
  assert.ok(chapter, 'CHAPTER_NOT_REGISTERED')
  const authorityFacts = Object.values(chapter.oracle ?? {}).flatMap(value => Array.isArray(value) ? value : [value])
  const chapterGuidance = `${source.template}\n本章时点：${chapter.oracle.time}`
  const authorityText = [scene.material, scene.longSetting,
    ...(fullRun ? scene.chapters.map(entry => `${entry.brief}\n${entry.requiredEvents.join('；')}\n本章时点：${entry.oracle.time}`) : [chapter.brief, chapter.requiredEvents]),
    scene.characters, chapterGuidance].flat().filter(Boolean).join('\n')
  for (const fact of authorityFacts)
    assert.ok(authorityText.includes(fact), `ORACLE_FACT_NOT_IN_AUTHOR_AUTHORITY:${fact}`)
  const contextSelection = request.phase === 'early-context' ? scene.contextSelection : null
  if (request.phase === 'early-context') {
    assert.equal(contextSelection?.scenarioRevision, request.scenarioRevision, 'CONTEXT_SCENARIO_REVISION_MISMATCH')
    assert.ok(Array.isArray(contextSelection.optionalPredecessors) && contextSelection.optionalPredecessors.length > 0,
      'OPTIONAL_PREDECESSORS_NOT_REGISTERED')
  }
  // 长设定只在预注册语义源里存在的场景携带；它作为作者资料进入受预算的必需材料。
  const authorSetting = [scene.material, scene.longSetting].filter(Boolean).join('\n')
  const load = relative => import(/* @vite-ignore */ pathToFileURL(path.join(target.repositoryRoot, relative)).href)
  const receipt = { schemaVersion: 1, invocationId: request.invocationId, arm: target.arm, mode: request.mode, action: request.action,
    protocolRevision: request.protocolRevision, protocolHash: request.protocolHash,
    phase: request.phase, milestone: request.milestone, caseId: request.caseId, sceneId: request.sceneId, chapterNumber: request.chapterNumber,
    operations: [], qualification: request.development ? 'development-only-unfrozen' : 'frozen-target', codeSha: target.codeSha,
    sourceHash: target.sourceHash, driverHash: request.driverHash,
    runtime: { node: process.version, abi: process.versions.modules }, physicalModelRequests: 0, syntheticDispatches: 0,
    invocations: [], attempts: [], status: 'running' }
  const candidate = target.arm === 'candidate'
  // 账本写入器在物理发送与守护之间共用：reserve 先占位，dispatch 先落盘再发网络。
  const record = event => updateLedger(request.ledgerPath, event, { campaignMode: request.mode })
  // 每个已 dispatch 的发送都由守护拥有一个短于桥测试超时的截止时间：到点时先写 unknown，
  // 再 abort，保证超时杀进程之前账本已经有一条终态，而不是只剩 reserve+dispatch。
  const supervisor = createAttemptSupervisor({ record })
  const originalFetch = globalThis.fetch
  let davFetch = null
  globalThis.fetch = async (...args) => davFetch ? davFetch(...args) : rejectOutsidePhysicalBoundary(receipt)
  let database, projectAccess, currentContext, sourceParity, countUnits, recoveryRows, localDispatchGateRejection
  let secret = null
  const safeDiagnostic = value => safeReceiptDiagnostic(value, request.mode)
  const streamSettlements = []
  try {
    assert.equal(target.protocolRevision, request.protocolRevision, 'PROTOCOL_REVISION_MISMATCH')
    assert.equal(target.protocolHash, request.protocolHash, 'PROTOCOL_HASH_MISMATCH')
    if (candidate) {
      const locator = await load('electron/services/app-data-locator.ts')
      locator.installGlobalDataLocator(target.roots.config, 'quality-isolated-generation-v1', target.roots.legacySource)
    }
    database = await load('electron/database.ts')
    ;({ countDraftUnits: countUnits } = await load('src/shared/draft-units.ts'))
    ;({ projectAccess } = await load('electron/services/project-access.ts'))
    const projectFile = path.join(target.isolationRoot, 'physical-project.json')
    let project
    if (request.action === 'prepare') {
      assert.equal(fs.existsSync(projectFile), false, 'PHYSICAL_FIXTURE_ALREADY_EXISTS')
      project = projectAccess.createProject(target.roots.project, scene.title)
      if (candidate) database.createProjectDatabase(project.rootPath, Buffer.alloc(32, 7))
      database.initProjectDatabase(project.rootPath, Buffer.alloc(32, 7))
      save(projectFile, project)
    } else {
      project = json(projectFile)
      database.initProjectDatabase(project.rootPath, Buffer.alloc(32, 7))
      assert.deepEqual(projectAccess.probeExistingProject(project.rootPath), project)
    }
    let db = database.getProjectDb()
    assert.equal(db.prepare('SELECT 1').pluck().get(), 1)
    let lease = projectAccess.beginSession(project)
    let session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
    receipt.projectEpoch = session.leaseId
    const sender = { id: 701, isDestroyed: () => false, send: (channel, ...args) => {
      for (const listener of transport.listeners.get(channel) ?? []) listener(...args)
    } }
    transport.sender = sender
    let pendingBaselineIpc = null, finalizedContext = null
    const invoke = async (channel, ...args) => {
      receipt.invocations.push(channel)
      if (!candidate && channel === 'llm:generate-stream') pendingBaselineIpc = {
        attemptId: args[0], runId: currentContext?.runId, projectId: args[1]?.projectSession?.projectId,
        epoch: args[1]?.projectSession?.leaseId, purpose: args[1]?.purpose, operationId,
      }
      if (channel === 'generation:bind-material-decision') {
        const decisions = receipt.materialDecisions ?? (receipt.materialDecisions = [])
        decisions.push({ operation: operationId, receipt: args[0]?.materialDecision })
      }
      const handler = transport.handlers.get(channel)
      if (!handler) throw new Error(`UNREGISTERED_PRODUCTION_IPC:${channel}`)
      try {
        const result = await handler({ sender }, ...args)
        if (continuityRun && ['finalization-generation:begin', 'finalization-generation:read'].includes(channel) && result)
          finalizedContext = result.context
        return result
      }
      catch (error) { (receipt.ipcFailures ??= []).push({ channel, error: safeDiagnostic(error.message) }); throw error }
    }
    const api = { invoke, on: (channel, listener) => {
      if (!transport.listeners.has(channel)) transport.listeners.set(channel, new Set())
      transport.listeners.get(channel).add(listener)
      return () => transport.listeners.get(channel).delete(listener)
    } }
    vi.stubGlobal('window', { aiNovelAPI: api, velaAPI: api, addEventListener() {}, removeEventListener() {} })
    let model = { id: 'quality-preregistered-model', name: '预注册合成验证模型', ...source.modelParameters,
      apiKey: 'synthetic-quality-never-network', baseUrl: `https://${source.modelParameters.endpointHost}/v1`, purposes: ['generation'] }
    delete model.parameterStatus
    if (request.mode === 'real') {
      if (request.development || !target.modelId) throw new Error('FROZEN_SAFE_MODEL_REQUIRED')
      model = json(path.join(target.roots.config, 'models.json')).find(value => value.id === target.modelId)
      if (!model || typeof model.apiKey !== 'string' || !model.apiKey) throw new Error('SAFE_MODEL_UNAVAILABLE')
      secret = model.apiKey
      for (const key of ['provider', 'protocol', 'modelName', 'temperature', 'maxTokens']) assert.equal(model[key], source.modelParameters[key], 'MODEL_PARAMETER_MISMATCH')
      assert.equal(new URL(model.baseUrl).host, source.modelParameters.endpointHost)
    } else if (request.mode !== 'synthetic') throw new Error('INVALID_PROVIDER_MODE')
    if (request.action === 'prepare' && request.mode === 'synthetic') {
      save(path.join(target.roots.config, 'models.json'), [model])
      save(path.join(target.roots.config, 'config.json'), { theme: 'dark', locale: 'zh-CN' })
    }
    const llm = (await load('electron/controllers/llm-controller.ts')).registerLLMController()
    if (candidate) (await load('electron/controllers/generation-controller.ts')).registerGenerationController(llm)
    ;(await load('electron/controllers/db-controller.ts')).registerDatabaseController()
    ;(await load('electron/controllers/fs-controller.ts')).registerFSController()
    ;(await load('electron/controllers/app-data-controller.ts')).registerAppDataController()
    ;(await load('electron/controllers/kb-controller.ts')).registerKBController()
    if (continuityRun) {
      assert.equal(candidate, true, 'CANDIDATE_REQUIRED')
      ;(await load('electron/controllers/project-archive-controller.ts')).registerProjectArchiveController()
      ;(await load('electron/controllers/finalization-controller.ts')).registerFinalizationController()
      ;(await load('electron/controllers/cloud-backup-controller.ts')).registerCloudBackupController()
      const embedding = (await load('electron/controllers/kb-controller.ts')).getEmbeddingConfig()
      receipt.embedding = { configured: embedding !== null, selectedSteps: ['chapter_notes', 'character_cards'], requests: 0 }
      assert.equal(embedding, null, 'UNREGISTERED_EMBEDDING_CONFIGURATION')
    }

    const config = { genre: '悬疑', targetAudience: '通用', totalChapters: scene.chapters.length, wordsPerChapter: scene.targetUnits,
      writingLanguage: 'zh-CN', creativeStrategy: 'auto', globalGuidance: source.template,
      coreOutline: scene.material, worldSetting: authorSetting, protagonistProfile: scene.characters.join('\n'),
      plotStructure: 'three_act', narrativePov: 'third_limited', writingStyle: '' }
    const projectStore = (await load('src/stores/project-store.ts')).useProjectStore
    projectStore.setState({ currentProject: { id: project.projectId, path: project.rootPath, name: scene.title,
      sessionLease: lease.leaseId, novelConfig: config } })
    const llmStore = (await load('src/stores/llm-store.ts')).useLLMStore
    llmStore.setState({ defaultModelId: model.id, models: [model] })
    const refinalize = async (draftId, suffix) => {
      const before = await invoke('db:continuity-read-source', draftId, project.rootPath, session)
      assert.equal(before.status, 'valid', 'REPLACED_SOURCE_NOT_CURRENT')
      const content = `${before.snapshot.content}\n\n${suffix}`
      const created = await invoke('db:draft-create', { chapterNumber: 1, source: 'write', content, wordCount: countUnits(content) }, project.rootPath, session)
      assert.ok(created?.success && created.id, 'REPLACEMENT_DRAFT_NOT_SAVED')
      const result = await (await load('src/services/finalization-client.ts')).commitFinalizationSnapshot({
        tabId: `quality:${request.caseId}`, projectPath: project.rootPath, projectSession: session, draftId: created.id,
        chapterNumber: 1, chapterTitle: scene.title, content, contentRevision: 1 })
      assert.ok(result?.success && result.committed, `SOURCE_REPLACEMENT_FAILED:${JSON.stringify(result)}`)
      const after = await invoke('db:continuity-read-source', created.id, project.rootPath, session)
      assert.equal(after.status, 'valid', 'REPLACEMENT_SOURCE_NOT_CURRENT')
      assert.notEqual(after.snapshot.source.finalizationId, before.snapshot.source.finalizationId, 'FINALIZATION_SOURCE_NOT_REPLACED')
      assert.equal(after.snapshot.content, content, 'REPLACEMENT_SOURCE_CONTENT_MISMATCH')
      const current = await invoke('db:draft-get-full', created.id, project.rootPath, session)
      return { before: before.snapshot.source, after: after.snapshot.source, content, draftId: created.id, version: current.version }
    }
    const prompts = await load('src/services/prompt-templates.ts')
    const templateKeys = templateKeysForPhase(request.phase)
    if (request.action === 'prepare') {
      let templates
      if (!candidate || continuityRun) {
        templates = templateKeys.map(key => structuredClone(prompts.getPromptTemplate(key)))
        assert.ok(templates.every(template => template?.content && template.key))
        save(request.templatesPath, { baselineSha: target.codeSha, templates })
      } else templates = json(request.templatesPath).templates
      fs.mkdirSync(path.join(target.roots.config, 'prompts'), { recursive: true })
      for (const template of templates) save(path.join(target.roots.config, 'prompts', `${template.key}.json`), template)
      const columns = { id: 'main', project_name: scene.title, genre: config.genre, target_audience: config.targetAudience,
        total_chapters: scene.chapters.length, words_per_chapter: scene.targetUnits, writing_language: 'zh-CN', global_guidance: source.template,
        core_outline: scene.material, world_setting: authorSetting, protagonist_profile: config.protagonistProfile,
        premise: scene.material, worldbuilding: scene.material, characters_arch: '',
        synopsis: scene.chapters.map(entry => `第${entry.number}章：${entry.brief}`).join('\n') }
      db.prepare(`INSERT INTO project_core (${Object.keys(columns).join(',')}) VALUES (${Object.keys(columns).map(() => '?').join(',')})`).run(...Object.values(columns))
      if (continuityRun) {
        const roster = await invoke('db:character-roster-read', project.rootPath, session)
        const saved = await invoke('db:character-roster-commit', { operationId: `quality-roster:${request.invocationId}`,
          intent: 'manual_edit', schemaVersion: 1, expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision,
          entries: scene.characters.map(name => ({ characterId: `draft:${randomUUID()}`, name, role: 'protagonist',
            gender: '', age: '', appearance: '', personality: '', background: '', abilities: '', motivation: '', arc: '', notes: '', relationships: [] })) }, project.rootPath, session)
        assert.ok(saved?.success, `AUTHOR_ROSTER_NOT_SAVED:${saved?.error}`)
      }
      for (const entry of fullRun ? [] : scene.chapters.slice(1)) db.prepare('INSERT INTO blueprints(chapter_number,title,role,purpose,key_events,characters,user_guidance) VALUES(?,?,?,?,?,?,?)')
        .run(entry.number, `作者预置第${entry.number}章`, '发展', entry.brief, entry.requiredEvents.join('；'), JSON.stringify(scene.characters),
          `${source.template}\n本章时点：${entry.oracle.time}`)
      if (request.phase === 'early-review') {
        const content = reviewSourceText(countUnits, scene, chapter)
        const created = await invoke('db:draft-create', { chapterNumber: chapter.number, source: 'write',
          content, wordCount: countUnits(content) }, project.rootPath, session)
        assert.ok(created?.success && created.id, 'REVIEW_SOURCE_DRAFT_NOT_SAVED')
        save(path.join(target.isolationRoot, 'review-source.json'), { draftId: created.id, contentHash: sha(content) })
      }
      // 合法前驱：第二章场景必须先有本臂自己的第一章来源。这里走生产草稿入口保存一份
      // 「作者前情」候选（不是另一臂的输出），第二臂只从自己的库里读回同一来源。
      if (!fullRun && request.chapterNumber > 1) {
        const registered = contextSelection?.optionalPredecessors ?? []
        const bodies = [
          { chapterNumber: request.chapterNumber - 1, marker: null, required: true,
            content: request.phase === 'early-review' ? naturalPredecessorText(scene)
              : `${scene.title}第${request.chapterNumber - 1}章正文（作者前情；本夹具预置的合法前驱候选）。\n\n${scene.authorPredecessor}` },
          ...registered.map(spec => ({ chapterNumber: spec.chapterNumber, marker: spec.marker, required: false,
            content: optionalPredecessorBody(spec) })),
        ]
        const records = []
        for (const item of bodies) {
          let draftId, sourceId
          if (item.required && continuityRun) {
            const created = await invoke('db:draft-create', { chapterNumber: item.chapterNumber, source: 'write', content: item.content,
              wordCount: countUnits(item.content) }, project.rootPath, session)
            assert.ok(created?.success && created.id, 'AUTHOR_DRAFT_NOT_SAVED')
            const finalized = await (await load('src/services/finalization-client.ts')).commitFinalizationSnapshot({
              tabId: `quality:${request.invocationId}`, projectPath: project.rootPath, projectSession: session,
              draftId: created.id, chapterNumber: item.chapterNumber, chapterTitle: scene.title, content: item.content, contentRevision: 1 })
            assert.ok(finalized?.committed && finalized.success, `AUTHOR_DRAFT_NOT_FINALIZED:${JSON.stringify(finalized)}`)
            draftId = created.id
            sourceId = `finalized:${draftId}`
          } else if (item.required && request.phase === 'early-review') {
            const authority = await invoke('db:draft-authority-sequence', project.rootPath, session)
            assert.equal(authority?.status, 'empty', 'PREDECESSOR_AUTHORITY_NOT_EMPTY')
            const imported = await invoke('db:draft-import-finalized-batch', {
              operationId: `quality:${request.invocationId}:early-review-predecessor`,
              expectedAuthorityFingerprint: authority.authorityFingerprint,
              chapters: [{ chapterNumber: item.chapterNumber, title: '错日晨钟', content: item.content,
                wordCount: countUnits(item.content) }],
            }, project.rootPath, session)
            const importedDraft = imported?.receipt?.drafts?.[0]
            assert.ok(imported?.success && importedDraft?.draftId && importedDraft.status === 'finalized'
              && importedDraft.publicationStatus === 'pending',
            `PREDECESSOR_DRAFT_NOT_FINALIZED:${safeDiagnostic(JSON.stringify(imported) ?? String(imported))}`)
            draftId = importedDraft.draftId
            sourceId = `finalized:${draftId}`
          } else {
            const created = await invoke('db:draft-create', { chapterNumber: item.chapterNumber, source: 'write',
              content: item.content, wordCount: countUnits(item.content) }, project.rootPath, session)
            assert.ok(created?.success && created.id, `PREDECESSOR_DRAFT_NOT_SAVED:${safeDiagnostic(JSON.stringify(created) ?? String(created))}`)
            draftId = created.id
            sourceId = `candidate:${draftId}`
          }
          const full = await invoke('db:draft-get-full', draftId, project.rootPath, session)
          assert.equal(full?.content, item.content, 'PREDECESSOR_SOURCE_CHANGED')
          if (item.required && (request.phase === 'early-review' || continuityRun)) assert.equal(full?.status, 'finalized', 'PREDECESSOR_STATUS_CHANGED')
          assert.ok(Number.isSafeInteger(full?.version) && full.version > 0, 'PREDECESSOR_VERSION_INVALID')
          const materialBody = item.required ? previousChapterEnding(full.content) : full.content
          records.push({ chapterNumber: item.chapterNumber, draftId, sourceId, version: full.version,
            contentHash: sha(full.content), persistedBytes: Buffer.byteLength(full.content, 'utf8'), marker: item.marker,
            required: item.required,
            materialContentHash: sha(`【未定稿候选 · 第${item.chapterNumber}章 · draft ${draftId} · v${full.version}】\n${materialBody}`) })
        }
        save(path.join(target.isolationRoot, 'predecessor.json'), { candidates: records })
      }
    }
    if (continuityRun && request.action === 'execute' && continuityCase.kind === 'extraction' && continuityCase.sourceSuffix) {
      if (continuityCase.authorMentalState) {
        const roster = await invoke('db:character-roster-read', project.rootPath, session)
        const edited = await invoke('db:character-roster-commit', { operationId: `quality-state:${request.invocationId}:${request.caseId}`,
          intent: 'manual_edit', schemaVersion: 1, expectedRevision: roster.revision, expectedIdentityRevision: roster.identityRevision,
          entries: roster.entries.map(entry => entry.currentState ? { ...entry,
            currentState: { ...entry.currentState, mentalState: continuityCase.authorMentalState } } : entry) }, project.rootPath, session)
        assert.ok(edited?.success, `AUTHOR_STATE_NOT_SAVED:${edited?.error}`)
      }
      const file = path.join(target.isolationRoot, 'predecessor.json'), previous = json(file)
      const record = previous.candidates.find(item => item.required)
      const replaced = await refinalize(record.draftId, continuityCase.sourceSuffix)
      receipt.sourceReplacement = replaced
      record.draftId = replaced.draftId; record.sourceId = `finalized:${replaced.draftId}`; record.version = replaced.version
      record.contentHash = sha(replaced.content); record.persistedBytes = Buffer.byteLength(replaced.content)
      save(file, previous)
    }
    const predecessorRecords = fullRun
      ? request.chapterNumber > 1 ? [{ ...request.predecessor, sourceId: `candidate:${request.predecessor?.draftId}`, required: true }] : []
      : request.chapterNumber > 1 ? json(path.join(target.isolationRoot, 'predecessor.json')).candidates : []
    if (fullRun && request.chapterNumber > 1) {
      assert.equal(request.predecessor?.projectId, project.projectId, 'FULL_PREDECESSOR_PROJECT_MISMATCH')
      assert.equal(request.predecessor?.chapterNumber, request.chapterNumber - 1, 'FULL_PREDECESSOR_CHAPTER_MISMATCH')
    }
    receipt.predecessor = fullRun ? request.predecessor ?? null : undefined
    // 每一条前驱都必须在使用前从生产 IPC 原样读回；command 只消费这些 readback，绝不旁路注入正文。
    const predecessorReadbacks = []
    for (const record of predecessorRecords) {
      const full = await invoke('db:draft-get-full', record.draftId, project.rootPath, session)
      assert.equal(sha(full?.content ?? ''), record.contentHash, 'PREDECESSOR_SOURCE_CHANGED')
      assert.equal(full?.version, record.version, 'PREDECESSOR_VERSION_CHANGED')
      assert.equal(full?.chapterNumber, record.chapterNumber, 'PREDECESSOR_CHAPTER_CHANGED')
      assert.equal(Buffer.byteLength(full?.content ?? '', 'utf8'), record.persistedBytes, 'PREDECESSOR_BYTES_CHANGED')
      predecessorReadbacks.push({ chapterNumber: record.chapterNumber, draftId: record.draftId, sourceId: record.sourceId,
        version: record.version, content: full.content, marker: record.marker, required: record.required,
        materialContentHash: record.materialContentHash })
    }
    const core = db.prepare('SELECT project_name,genre,target_audience,total_chapters,words_per_chapter,writing_language,global_guidance,core_outline,world_setting,protagonist_profile,premise,worldbuilding,characters_arch,synopsis FROM project_core WHERE id=?').get('main')
    const physicalTemplates = []
    for (const key of templateKeys) physicalTemplates.push(await prompts.resolvePromptTemplate(key, session, 'zh-CN'))
    const expectedTemplates = json(request.templatesPath).templates
    assert.deepEqual(physicalTemplates, expectedTemplates, 'ACTUAL_TEMPLATE_PARITY_FAILED')
    receipt.promptMapping = { baselineSha: json(request.templatesPath).baselineSha,
      guidanceHash: sha(source.template), templates: physicalTemplates.map(template => ({ key: template.key,
        templateHash: sha(template), contentHash: sha(template.content) })) }
    const actualModel = (await invoke('llm:list-models')).find(value => value.id === model.id)
    assert.ok(actualModel)
    const safeModel = Object.fromEntries(['provider', 'protocol', 'modelName', 'temperature', 'maxTokens', 'baseUrl'].map(key => [key, actualModel[key]]))
    const authorBlueprints = db.prepare('SELECT chapter_number,title,role,purpose,key_events,characters,user_guidance FROM blueprints WHERE chapter_number>1 ORDER BY chapter_number').all()
    const skillBindings = await (await load('src/services/agent/writing-skill-bindings.ts')).loadWritingSkillBindings(session)
    assert.deepEqual(skillBindings.bindings, {}, 'UNREGISTERED_WRITING_SKILL')
    sourceParity = { core, authorBlueprints, model: safeModel, templates: physicalTemplates, skills: skillBindings.bindings,
      predecessors: predecessorReadbacks.map(record => ({ sourceId: record.sourceId,
        chapterNumber: record.chapterNumber, version: record.version,
        revision: record.sourceId.startsWith('finalized:') ? record.draftId : record.version, contentHash: sha(record.content),
        persistedBytes: Buffer.byteLength(record.content, 'utf8'), markerHash: record.marker ? sha(record.marker) : null,
        required: record.required })),
      semanticHash: sha(source), guidanceHash: sha(source.template) }
    if (fullRun) {
      // Generated blueprints and prose diverge by arm; only original author inputs define initial parity.
      sourceParity = { ...sourceParity, authorBlueprints: [], predecessors: [] }
    }
    receipt.physicalProject = { path: project.rootPath, dbPath: db.name, projectId: project.projectId,
      format: candidate ? 'canonical' : 'legacy', parityHash: sha(sourceParity), readback: sourceParity }
    if (request.action === 'prepare') { assertNoOutboundPreflightFailures(receipt); receipt.status = 'prepared'; return }
    if (continuityRun) request.parityHash = sha(sourceParity)
    else assert.equal(sha(sourceParity), request.parityHash, 'PHYSICAL_PROJECT_PARITY_CHANGED')

    const restorationKind = continuityRun ? request.operations[0]?.restore : null
    let sourceDbPath, sourceBefore
    const sourceRows = connection => Object.fromEntries(['drafts', 'contents', 'generation_attempts', 'finalization_outbox']
      .map(table => [table, connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    if (restorationKind) {
      const origin = { ...project }, originEpoch = session.leaseId
      sourceDbPath = db.name
      sourceBefore = sourceRows(db)
      const targetProjectRoot = path.join(target.roots.project, request.caseId.toLowerCase())
      assert.equal(path.dirname(targetProjectRoot), path.resolve(target.roots.project), 'RESTORE_OUTSIDE_TARGET_ROOT')
      let restored, selectedGenerationId, bindingMode, branchGenerationIds
      if (restorationKind === 'local') {
        const archivePath = path.join(evidenceRoot, 'source.ainovel')
        const exported = await invoke('project:archive-export', { projectSession: session, targetArchivePath: archivePath })
        assert.ok(exported?.success, `ARCHIVE_EXPORT_FAILED:${exported?.error}`)
        restored = await invoke('project:archive-restore', { archivePath, targetProjectRoot })
      } else {
        assert.equal(restorationKind, 'webdav', 'UNREGISTERED_RESTORE_KIND')
        // The real WebDavBackupService sees a bounded in-memory DAV transport. No sockets are opened.
        const files = new Map(), collections = new Set(['/dav/'])
        receipt.dav = { transport: 'synthetic-loopback-fetch', requests: 0, externalRequests: 0 }
        davFetch = async (input, options) => {
          const url = new URL(String(input)), method = options.method
          assert.ok(url.origin === 'http://127.0.0.1:17861' && url.pathname.startsWith('/dav/')
            && !url.search && !url.hash && ['PROPFIND', 'MKCOL', 'PUT', 'GET', 'HEAD'].includes(method), 'DAV_OUTSIDE_REGISTERED_BOUNDARY')
          receipt.dav.requests++
          if (method === 'MKCOL') { collections.add(url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`); return new Response(null, { status: 201 }) }
          if (method === 'PUT') {
            const chunks = []
            if (Buffer.isBuffer(options.body) || typeof options.body === 'string') chunks.push(Buffer.from(options.body))
            else for await (const chunk of options.body) chunks.push(Buffer.from(chunk))
            files.set(url.pathname, Buffer.concat(chunks))
            return new Response(null, { status: 201 })
          }
          if (method === 'PROPFIND') {
            const root = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
            const children = [...collections].filter(item => item.startsWith(root) && item !== root && !item.slice(root.length).replace(/\/$/u, '').includes('/'))
            return new Response(`<d:multistatus xmlns:d="DAV:">${[root, ...children].map(item => `<d:response><d:href>${item}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`, { status: 207 })
          }
          const bytes = files.get(url.pathname)
          return new Response(method === 'HEAD' ? null : bytes ?? null, { status: bytes ? 200 : 404,
            headers: bytes ? { 'Content-Length': String(bytes.length) } : {} })
        }
        const connected = await invoke('cloud-backup:connect', { endpoint: 'http://127.0.0.1:17861/dav/', username: 'fixture', secret: 'synthetic-dav-only' })
        assert.ok(connected?.success, `DAV_CONNECT_FAILED:${JSON.stringify(connected)}`)
        const accountId = connected.account.accountId
        const existing = await invoke('cloud-backup:view', session)
        const bound = await invoke('cloud-backup:confirm-binding', { projectSession: session, localEndpointAccountId: accountId,
          lastSelectedParentGenerationIds: [], expectedRevision: existing.binding?.revision ?? null })
        assert.ok(bound?.success, 'DAV_BIND_FAILED')
        const backed = await invoke('cloud-backup:backup', { projectSession: session, operationId: randomUUID(), disclosureConfirmed: true })
        assert.ok(backed?.success && backed.bindingSaved, `DAV_BACKUP_FAILED:${JSON.stringify(backed)}`)
        if (continuityCase.otherBranchSuffix) {
          await refinalize(predecessorReadbacks.find(item => item.required).draftId, continuityCase.otherBranchSuffix)
          const branch = await invoke('cloud-backup:confirm-binding', { projectSession: session, localEndpointAccountId: accountId,
            cloudBookId: bound.binding.cloudBookId, lastSelectedParentGenerationIds: [], expectedRevision: backed.binding.revision })
          assert.ok(branch?.success, 'DAV_BRANCH_SELECTION_FAILED')
          const second = await invoke('cloud-backup:backup', { projectSession: session, operationId: randomUUID(), disclosureConfirmed: true })
          assert.ok(second?.success && second.bindingSaved, 'DAV_SECOND_BRANCH_FAILED')
          branchGenerationIds = [backed.generation.generationId, second.generation.generationId]
          sourceBefore = sourceRows(db)
        }
        const listed = await invoke('cloud-backup:list', { localEndpointAccountId: accountId, cloudBookId: bound.binding.cloudBookId })
        selectedGenerationId = backed.generation.generationId
        assert.ok(listed?.success && listed.generations.some(item => item.generationId === selectedGenerationId), 'DAV_SELECTED_GENERATION_MISSING')
        if (branchGenerationIds) assert.ok(branchGenerationIds.every(id => listed.generations.some(item => item.generationId === id && item.hasSibling)), 'DAV_COMPLETE_FORK_MISSING')
        restored = await invoke('cloud-backup:restore-copy', { localEndpointAccountId: accountId, cloudBookId: bound.binding.cloudBookId,
          generationId: selectedGenerationId, targetProjectRoot, operationId: randomUUID() })
        bindingMode = restored?.binding?.mode
        assert.equal(bindingMode, 'origin-readonly', 'DAV_RESTORED_BINDING_INVALID')
        davFetch = null
      }
      assert.ok(restored?.success, `RESTORE_FAILED:${JSON.stringify(restored)}`)
      assert.equal(restored.receipt.originProjectId, origin.projectId, 'RESTORE_ORIGIN_MISMATCH')
      assert.equal(restored.receipt.targetProjectRoot, targetProjectRoot, 'RESTORE_TARGET_MISMATCH')
      database.closeProjectDatabase(); projectAccess.invalidateCurrentSession()
      project = projectAccess.probeExistingProject(targetProjectRoot)
      assert.equal(project.projectId, restored.receipt.targetProjectId, 'RESTORE_IDENTITY_MISMATCH')
      assert.notEqual(project.projectId, origin.projectId, 'RESTORE_IDENTITY_REUSED')
      database.initProjectDatabase(project.rootPath, Buffer.alloc(32, 7))
      db = database.getProjectDb()
      lease = projectAccess.beginSession(project)
      session = { projectId: project.projectId, projectPath: project.rootPath, leaseId: lease.leaseId }
      assert.notEqual(session.leaseId, originEpoch, 'RESTORE_EPOCH_REUSED')
      projectStore.setState({ currentProject: { id: project.projectId, path: project.rootPath, name: scene.title, sessionLease: lease.leaseId, novelConfig: config } })
      llmStore.setState({ defaultModelId: model.id, models: [model] })
      const freeze = json(path.join(project.rootPath, '.ai-novel', 'portable-runtime-freeze.json'))
      const transfer = json(path.join(project.rootPath, '.ai-novel', 'portable-transfer-authority.json'))
      assert.equal(freeze.nonReplayable, true, 'RESTORE_HISTORY_NOT_FROZEN')
      for (const prior of predecessorReadbacks) {
        const restoredSource = await invoke('db:continuity-read-source', prior.draftId, project.rootPath, session)
        assert.equal(restoredSource.status, 'valid', 'RESTORED_SOURCE_NOT_CURRENT')
        assert.equal(sha(restoredSource.snapshot.content), sha(prior.content), 'RESTORED_SOURCE_CHANGED')
      }
      receipt.projectEpoch = session.leaseId
      receipt.physicalProject = { ...receipt.physicalProject, path: project.rootPath, dbPath: db.name, projectId: project.projectId }
      receipt.restoration = { ...restored.receipt, kind: restorationKind, selectedGenerationId, bindingMode, branchGenerationIds,
        transferReceiptHash: sha(transfer), oldWorkFrozen: true }
      receipt.restoration.currentAuthority = (await load('electron/services/portable-current-authority.ts')).readPortableCurrentAuthority({
        database: db, projectStorageRoot: path.join(project.rootPath, '.ai-novel'), projectId: project.projectId })
      if (continuityCase.sourceSuffix) {
        const previous = predecessorReadbacks.find(item => item.required)
        receipt.restoration.sourceReplacement = await refinalize(previous.draftId, continuityCase.sourceSuffix)
        previous.content = receipt.restoration.sourceReplacement.content
        previous.draftId = receipt.restoration.sourceReplacement.draftId
        previous.sourceId = `finalized:${previous.draftId}`
        previous.version = receipt.restoration.sourceReplacement.version
      }
    }

    let operationKind = null, operationId = null
    const repairPolicy = request.attemptPolicy?.milestone === request.milestone
      && request.attemptPolicy.arms?.includes(target.arm) ? request.attemptPolicy : null
    const { parseFinalizedCharacterStateResponse } = continuityRun ? await load('src/shared/finalized-continuity.ts') : {}
    const beforeOperationDispatch = createOperationDispatchGate({ repairPolicy, finalizationRepair: continuityRun, readPrimaryEvidence: first => {
      const attemptId = `${target.arm}:${first.attemptId}`
      const matches = receipt.attempts.filter(attempt => attempt.attemptId === attemptId)
      if (matches.length !== 1) return null
      if (!continuityRun && (matches[0].authorityEvidence?.allFactsSent !== true
        || JSON.stringify(matches[0].authorityEvidence.factHashes) !== JSON.stringify(authorityFacts.map(sha)))) return null
      const events = fs.readFileSync(request.ledgerPath, 'utf8').trimEnd().split('\n')
        .map(line => JSON.parse(line)).filter(event => event.attemptId === attemptId)
      if (continuityRun) {
        const artifact = db.prepare('SELECT artifact_json FROM generation_artifacts WHERE attempt_id=?').pluck().get(first.attemptId)
        if (!artifact || !finalizedContext) return null
        const saved = JSON.parse(artifact)
        let finalizedCharacterInvalid = false
        try { parseFinalizedCharacterStateResponse(saved.text, finalizedContext.identity) } catch { finalizedCharacterInvalid = true }
        return { attempt: matches[0], events, finalizedCharacterInvalid, ownerArtifactHash: sha(saved.text) }
      }
      return { attempt: matches[0], events }
    }, onReject: rejection => {
      localDispatchGateRejection = { ...rejection, operation: operationId, runId: currentContext?.runId,
        projectId: session.projectId, chapterNumber: request.chapterNumber }
    } })
    const physicalFetch = async (url, options) => {
      const preflight = createOutboundPreflightAssert(receipt.preflightFailures ??= [])
      preflight(new URL(String(url)).host === source.modelParameters.endpointHost, 'UNREGISTERED_PROVIDER_HOST')
      preflight(new URL(String(url)).pathname === '/v1/chat/completions', 'UNREGISTERED_PROVIDER_PATH')
      const body = JSON.parse(options.body)
      preflight(body.model === source.modelParameters.modelName, 'UNREGISTERED_PROVIDER_MODEL')
      preflight(body.temperature === source.modelParameters.temperature, 'UNREGISTERED_PROVIDER_TEMPERATURE')
      if (candidate && request.mode === 'synthetic')
        preflight(body.stream_options?.include_usage === true, 'OPENAI_USAGE_STREAM_NOT_REQUESTED')
      preflight(currentContext && operationKind, 'PHYSICAL_REQUEST_OUTSIDE_COMMAND')
      let actual
      let materialDecision = null
      if (candidate) {
        actual = selectOwnerDispatch(db, currentContext.mainGenerationRunHandle, session, body)
        const run = db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').get(actual.runId)
        materialDecision = JSON.parse(run.binding_json).sourceManifest?.materialDecision ?? null
        if (!['directory', 'chapter_notes', 'character_cards'].includes(operationKind)) preflight(materialDecision, 'MATERIAL_DECISION_RECEIPT_MISSING')
      }
      const observedIpc = candidate ? null : pendingBaselineIpc
      pendingBaselineIpc = null
      if (!candidate) preflight(observedIpc?.operationId === operationId
        && observedIpc.runId === currentContext.runId && observedIpc.projectId === session.projectId
        && observedIpc.epoch === session.leaseId, 'BASELINE_IPC_DISPATCH_IDENTITY_MISMATCH')
      if (repairPolicy && operationId === repairPolicy.operationId
        && (actual ?? observedIpc).purpose === repairPolicy.repairPurpose) await Promise.all(streamSettlements)
      if (continuityRun && operationKind === 'character_cards' && actual.purpose.includes(':repair:')) await Promise.all(streamSettlements)
      // The registered extra call must carry its real product purpose before campaign reserve.
      beforeOperationDispatch(operationId, actual ?? observedIpc)
      const structuredSyntaxRepair = repairPolicy?.operationId === operationId
        && repairPolicy.maxRepairAttempts === 1
        && (actual ?? observedIpc).purpose === repairPolicy.repairPurpose
      const attemptId = `${target.arm}:${actual?.attemptId ?? observedIpc.attemptId}`
      const promptText = body.messages.filter(message => typeof message?.content === 'string')
        .map(message => message.content).join('\n')
      const userMessages = body.messages.filter(message => message?.role === 'user' && typeof message.content === 'string')
      const userPromptHash = userMessages.length === 1 ? sha(userMessages[0].content) : null
      if (continuityRun && operationKind === 'draft') {
        preflight(actual.projectId === receipt.restoration.targetProjectId
          && materialDecision?.included.some(item => item.sourceId === `finalized:${predecessorReadbacks.find(record => record.required).draftId}`),
        'RESTORED_CURRENT_PREDECESSOR_NOT_SENT')
        if (continuityCase.otherBranchSuffix) preflight(!promptText.includes(continuityCase.otherBranchSuffix), 'DAV_UNSELECTED_BRANCH_SENT')
        if (receipt.restoration.sourceReplacement) {
          preflight(promptText.includes(continuityCase.sourceSuffix), 'RESTORED_REPLACEMENT_SOURCE_NOT_SENT')
          preflight(!materialDecision.included.some(item => item.category === 'derived-locator'), 'RESTORED_STALE_DERIVED_SENT')
        }
      }
      if (operationKind === 'draft') preflight(draftPromptIncludesCommittedBlueprint(userMessages.length === 1 ? userMessages[0].content : '',
        readCommittedDraftChapterInfo(db, chapter, project.rootPath, chapterGuidance), (actual ?? observedIpc).purpose), 'OUTBOUND_DRAFT_BLUEPRINT_MISSING')
      if (operationKind === 'recheck' && candidate) {
        const merged = db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC LIMIT 1')
          .pluck().get(chapter.number)
        const findings = db.prepare("SELECT finding_id,target_id FROM review_findings WHERE target_id IS NOT NULL AND status NOT IN ('unverified','resolved','author-waived') ORDER BY finding_id").all()
        preflight(typeof merged === 'string' && promptText.includes(merged), 'OUTBOUND_RECHECK_MERGED_DRAFT_MISSING')
        preflight(findings.length > 0, 'OUTBOUND_RECHECK_FINDINGS_MISSING')
        for (const finding of findings) {
          preflight(promptText.includes(finding.finding_id), 'OUTBOUND_RECHECK_FINDING_ID_MISSING')
          preflight(promptText.includes(finding.target_id), 'OUTBOUND_RECHECK_TARGET_ID_MISSING')
        }
      } else if (request.phase === 'early-review' && operationKind === 'refine') {
        const activeDraft = db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC,d.id DESC LIMIT 1')
          .pluck().get(chapter.number)
        preflight(typeof activeDraft === 'string' && promptText.includes(activeDraft), 'OUTBOUND_REFINE_SOURCE_DRAFT_MISSING')
      } else if (continuityRun && ['chapter_notes', 'character_cards'].includes(operationKind)) {
        const manifest = JSON.parse(db.prepare('SELECT binding_json FROM generation_runs WHERE run_id=?').pluck().get(actual.runId)).sourceManifest
        const task = manifest.finalizationGenerationTask
        preflight(finalizedContext && sha(finalizedContext) === manifest.finalizationGenerationContextHash
          && sha(task) === manifest.finalizationGenerationTaskHash
          && sha(finalizedContext.identity.content) === finalizedContext.slot.source.contentHash
          && promptText.includes(finalizedContext.identity.content), 'FINALIZATION_FROZEN_SOURCE_MISMATCH')
        preflight(JSON.stringify(body.messages.slice(0, task.messages.length)) === JSON.stringify(task.messages), 'FINALIZATION_FROZEN_TASK_MISMATCH')
      } else if (!structuredSyntaxRepair) {
        for (const fact of authorityFacts)
          preflight(promptText.includes(fact), `OUTBOUND_ORACLE_AUTHORITY_MISSING:${fact}`)
        if (request.chapterNumber > 1) {
          const requiredPredecessor = predecessorReadbacks.find(record => record.required)
          const predecessorEvidence = fullRun ? previousChapterEnding(requiredPredecessor?.content ?? '')
            : naturalPredecessorText(scene).split('\n\n', 1)[0]
          preflight(requiredPredecessor && promptText.includes(predecessorEvidence), 'OUTBOUND_REQUIRED_PREDECESSOR_MISSING')
        }
      }
      if (candidate && fullRun && request.chapterNumber > 1) {
        const predecessor = predecessorReadbacks[0]
        preflight(materialDecision?.included.some(item => item.sourceId === predecessor.sourceId
          && item.revision === predecessor.version), 'FULL_PREDECESSOR_MATERIAL_BINDING_MISMATCH')
      }
      if (candidate && request.phase === 'early-context') {
        preflight(userMessages.length === 1, 'CANDIDATE_USER_MESSAGE_NOT_UNIQUE')
        preflight(userPromptHash === materialDecision.promptHash, 'MATERIAL_DECISION_PROMPT_HASH_MISMATCH')
        const requiredPredecessor = predecessorReadbacks.find(record => record.required)
        preflight(requiredPredecessor && promptText.includes(scene.authorPredecessor),
          'CANDIDATE_REQUIRED_PREDECESSOR_NOT_SENT')
        preflight(materialDecision.included.some(item => item.sourceId === `candidate:${requiredPredecessor.draftId}`
          && item.required === true), 'CANDIDATE_REQUIRED_PREDECESSOR_RECEIPT_MISSING')
        for (const record of predecessorReadbacks.filter(record => record.marker))
          preflight(!promptText.includes(record.marker), 'CANDIDATE_OPTIONAL_MARKER_SENT')
      }
      if (request.phase === 'early-review' && operationKind === 'review') {
        const requiredPredecessor = predecessorReadbacks.find(record => record.required)
        preflight(requiredPredecessor && promptText.includes(naturalPredecessorText(scene).split('\n\n', 1)[0]),
          'REVIEW_REQUIRED_PREDECESSOR_NOT_SENT')
        if (candidate) {
          preflight(promptText.includes(requiredPredecessor.content), 'REVIEW_FINALIZED_PREDECESSOR_NOT_SENT')
          preflight(materialDecision.included.some(item => item.sourceId === requiredPredecessor.sourceId
            && item.required === true), 'REVIEW_REQUIRED_PREDECESSOR_RECEIPT_MISSING')
        }
        for (const forbidden of ['本夹具', '作者提供的前情', REVIEW_FIX])
          preflight(!promptText.includes(forbidden), `REVIEW_PROMPT_PRIVATE_FIXTURE_LEAK:${forbidden}`)
      }
      // phase / caseId / operation 全部来自本次选定的协议阶段，账本按协议逐字校验。
      const binding = { campaignId: CAMPAIGN_ID, invocationId: request.invocationId, mode: request.mode, arm: target.arm,
        protocolRevision: request.protocolRevision, protocolHash: request.protocolHash,
        codeSha: target.codeSha, sourceHash: target.sourceHash, driverHash: request.driverHash,
        parityId: request.parityHash, phase: request.phase, milestone: request.milestone, caseId: request.caseId,
        operation: operationId, ...(actual ? { actual } : { baselineIpc: observedIpc }) }
      record({ type: 'reserve', attemptId, binding })
      record({ type: 'dispatch', attemptId })
      // 发送规模证据：只记字节数，绝不记提示词原文或凭据，好让两臂在不花真实调用的前提下可比。
      const registeredOptional = predecessorReadbacks.filter(record => record.marker).map(record => ({
        sourceId: `candidate:${record.draftId}`, revision: record.version, contentHash: record.materialContentHash,
        persistedContentHash: sha(record.content), persistedBytes: Buffer.byteLength(record.content, 'utf8'), markerHash: sha(record.marker),
      }))
      const sentOptional = predecessorReadbacks.filter(record => record.marker && promptText.includes(record.marker))
        .map(record => ({ sourceId: `candidate:${record.draftId}`, revision: record.version, contentHash: record.materialContentHash,
          persistedContentHash: sha(record.content), persistedBytes: Buffer.byteLength(record.content, 'utf8'), markerHash: sha(record.marker) }))
      const requestReceipt = { attemptId, binding, requestedOutputTokens: body.max_tokens ?? body.max_completion_tokens,
        compiledPromptHash: sha(body.messages), systemPromptHash: sha(body.messages.filter(message => message.role === 'system')),
        composedPromptBytes: measurePromptBytes(body.messages),
        requestBodyBytes: Buffer.byteLength(typeof options.body === 'string' ? options.body : '', 'utf8'),
        authorityEvidence: operationKind === 'recheck' && candidate
          ? { mergedDraftHash: sha(db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC LIMIT 1')
              .pluck().get(chapter.number)), findingAnchorsSent: true }
          : request.phase === 'early-review' && operationKind === 'refine'
            ? { sourceDraftHash: sha(db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC,d.id DESC LIMIT 1')
                .pluck().get(chapter.number)), confirmedReviewBound: candidate ? materialDecision.included.some(item => item.sourceId.startsWith('review:confirmed:')) : true }
          : continuityRun && ['chapter_notes', 'character_cards'].includes(operationKind)
            ? { finalizedSource: finalizedContext.slot.source, contextHash: sha(finalizedContext) }
          : { factHashes: authorityFacts.map(sha), allFactsSent: authorityFacts.every(fact => promptText.includes(fact)),
              ...(request.chapterNumber > 1 ? { predecessorHash: sha(predecessorReadbacks.find(record => record.required)?.content ?? ''), predecessorSent: true } : {}) },
        userPromptHash, optionalMaterialEvidence: { registered: registeredOptional, sent: sentOptional,
          sentSourceIds: sentOptional.map(record => record.sourceId),
          ...(candidate ? { materialDecision } : {}) } }
      receipt.attempts.push(requestReceipt)
      const physicalOutputPath = path.join(evidenceRoot, `physical-output-${receipt.attempts.length}.txt`)
      // 从 dispatch 起由守护接管：到点会先为这次发送写 unknown，再 abort 下面的 fetch。
      const controller = new AbortController()
      supervisor.watch(attemptId, controller)
      const callerSignal = options?.signal
      const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal
      try {
        if (request.mode === 'synthetic') receipt.syntheticDispatches++
        else receipt.physicalModelRequests++
        let text
        if (operationKind === 'directory') text = JSON.stringify({ blueprints: (fullRun ? scene.chapters : [chapter]).map(entry => ({ chapterNumber: entry.number, title: scene.title, role: '开篇',
          purpose: entry.brief, keyEvents: entry.requiredEvents.join('；'), characters: scene.characters,
          relationships: [], suspenseHook: entry.oracle?.knowledge ?? '', userGuidance: fullRun ? `${source.template}\n本章时点：${entry.oracle.time}` : source.template })) })
        else if (operationKind === 'chapter_notes') text = finalizedContext.identity.content
        else if (operationKind === 'character_cards') {
          const identity = finalizedContext.identity
          const character = identity.characters.find(item => identity.content.includes(item.displayNameSnapshot))
          assert.ok(character, 'SYNTHETIC_CHARACTER_SOURCE_MISSING')
          text = JSON.stringify({ updates: [{ characterId: character.characterId,
            currentState: { recentEvents: '发现日期异常，决定到现场核查', mentalState: '决定核查' }, evidence: { text: identity.content } }] })
        }
        else if (operationKind === 'review') text = syntheticReview(chapter)
        else if (operationKind === 'refine') {
          const current = db.prepare('SELECT c.body FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC LIMIT 1')
            .pluck().get(chapter.number)
          assert.equal(typeof current, 'string', 'REVIEW_SOURCE_DRAFT_MISSING')
          text = current.replace(REVIEW_DEFECT, REVIEW_FIX)
          assert.notEqual(text, current, 'SYNTHETIC_TARGETED_REVISION_MISSING')
        } else if (operationKind === 'recheck') {
          if (candidate) {
            const cycle = db.prepare("SELECT cycle_id FROM review_cycles WHERE revision_status='merge-committed' ORDER BY rowid DESC LIMIT 1")
              .pluck().get()
            const findings = db.prepare("SELECT finding_id,target_id FROM review_findings WHERE cycle_id=? AND target_id IS NOT NULL AND status NOT IN ('unverified','resolved','author-waived') ORDER BY finding_id")
              .all(cycle)
            assert.ok(cycle && findings.length > 0, 'SYNTHETIC_RECHECK_FINDINGS_MISSING')
            text = JSON.stringify({ summary: '已核对定向修改后的新证据。', items: findings.map(finding => ({
              findingId: finding.finding_id, targetId: finding.target_id, resolved: true,
              evidenceQuote: REVIEW_FIX, reason: '合并后正文已逐字写明人物承担的代价。',
            })) })
          } else {
            text = JSON.stringify({ summary: '定向问题已修复。',
              items: [{ category: '本章目标', severity: 'pass', description: '人物承担代价已有正文证据。' }],
              goalReviews: chapter.requiredEvents.map((event, index) => ({
                id: `ch${chapter.number}:keyEvents:${index + 1}`, status: 'completed',
                description: `${event}已有正文证据。`, evidence: [{ quote: index === 0 ? '核查途中突遇断电，核查受阻。' : REVIEW_FIX }],
              })) })
          }
        } else text = syntheticDraftText(countUnits, chapter.targetUnits, fullRun ? chapter.number : 1)
        const promptTokens = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(body.messages), 'utf8') / 4))
        const completionTokens = Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4))
        const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens }
        const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`
        const response = request.mode === 'synthetic'
          ? new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } })
          : await fetchProviderResponse(originalFetch, url, { ...options, signal }, receipt.fetchFailures ??= [], safeDiagnostic)
        const [providerBody, ledgerBody] = response.body.tee()
        streamSettlements.push((async () => {
          let finishReason = null, buffer = '', visibleText = '', interrupted = false, malformed = false
          const reader = ledgerBody.getReader(), decoder = new TextDecoder()
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) break
              buffer += decoder.decode(next.value, { stream: true })
              const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
              for (const line of lines) {
                if (!line.startsWith('data:') || line.includes('[DONE]')) continue
                try { const event = JSON.parse(line.slice(5)); const reason = event.choices?.[0]?.finish_reason
                  const content = event.choices?.[0]?.delta?.content
                  if (typeof content === 'string') visibleText += content
                  if (typeof reason === 'string' && reason) finishReason = reason
                } catch { malformed = true }
              }
            }
          } catch { interrupted = true }
          finally { reader.releaseLock() }
          supervisor.terminal(attemptId, finishReason && !interrupted && !malformed ? 'settle' : 'unknown', finishReason ? { finishReason } : {})
          fs.writeFileSync(physicalOutputPath, visibleText)
          requestReceipt.outputPath = physicalOutputPath
          requestReceipt.visibleTextHash = sha(visibleText)
        })())
        return new Response(providerBody, { status: response.status, statusText: response.statusText, headers: response.headers })
      } catch (error) { supervisor.terminal(attemptId, 'unknown'); throw error }
    }
    globalThis.fetch = physicalFetch
    const callbacks = { log(text) { (receipt.diagnostics ??= []).push(safeDiagnostic(text)) }, setProgress() {}, appendText() {}, onChunk() {} }
    const latestDraft = () => db.prepare(`SELECT d.id,d.chapter_number AS chapterNumber,d.version,d.status,d.word_count AS wordCount,c.body AS content
      FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC LIMIT 1`).get(chapter.number)
    const reviewState = {}
    for (const operation of request.operations) {
      operationKind = operation.kind
      operationId = operation.id
      currentContext = { runId: randomUUID(), projectPath: project.rootPath, projectSession: session, writingLanguage: 'zh-CN',
        uiLocale: 'zh-CN', generationModelId: model.id, data: { architecture: authorityText, existingBlueprints: [] }, cancelled: false }
      const params = { context: currentContext, callbacks, step: { id: operationId, title: operationId } }
      const sourceDraft = latestDraft()
      let command
      if (continuityRun && ['chapter_notes', 'character_cards'].includes(operationKind)) {
        const predecessor = predecessorReadbacks.find(item => item.required)
        const readback = await invoke('db:continuity-read-source', predecessor.draftId, project.rootPath, session)
        assert.equal(readback.status, 'valid', 'FINALIZATION_SOURCE_NOT_CURRENT')
        command = new (await load('src/services/workflows/commands/finalize-chapter.command.ts')).RunFinalizePostProcessCommand({
          project: projectStore.getState().currentProject, chapterNumber: predecessor.chapterNumber, chapterTitle: scene.title,
          draftContent: readback.snapshot.content, draftId: predecessor.draftId, sourceLabel: 'quality-c16-existing',
          finalizedSource: readback.snapshot.source, stopOnFailure: true, stepKey: operationKind })
      }
      else if (operationKind === 'directory') command = new (await load('src/services/workflows/commands/directory.command.ts')).GenerateDirectoryCommand(
          { mode: 'append', startChapter: chapter.number, count: fullRun ? scene.chapters.length : 1 }, { expectedProjectPath: project.rootPath, novelConfig: config })
      else if (operationKind === 'draft') command = new (await load('src/services/workflows/commands/generate-draft.command.ts')).GenerateDraftCommand(
          readCommittedDraftChapterInfo(db, chapter, project.rootPath, chapterGuidance),
          // 第二章必须由本臂自己的库提供前驱候选（作者前情），不能借另一臂的输出。
          fullRun || predecessorReadbacks.some(record => record.marker)
            ? { selectedCandidateDrafts: predecessorReadbacks.map(({ marker, materialContentHash, sourceId, ...record }) => {
                void marker
                void materialContentHash
                void sourceId
                return record
              }) } : {})
      else {
        assert.ok(sourceDraft, 'REVIEW_SOURCE_DRAFT_MISSING')
        const frozenSource = { id: sourceDraft.id, chapterNumber: sourceDraft.chapterNumber,
          version: sourceDraft.version, status: sourceDraft.status, content: sourceDraft.content }
        const draftPath = candidate
          ? `ai-novel://draft/${sourceDraft.id}`
          : `vela://draft/ch${sourceDraft.chapterNumber}/v${sourceDraft.version}`
        if (operationKind === 'review') {
          command = new (await load('src/services/workflows/commands/review-chapter.command.ts')).ReviewChapterCommand({
            draftPath, draftContent: sourceDraft.content, sourceDraft: frozenSource, chapterNumber: chapter.number,
            reviewFocus: '只核对本章必需事件、作者事实与明确证据，不检查字数。对于“承担代价”，只有人物已经执行选择、具体损失或牺牲已经发生、后文没有反证，才算完成；签字认责或承诺以后负责不算代价。',
          })
        } else if (operationKind === 'refine') {
          const sourceReview = await invoke('db:review-get-full', reviewState.reviewId, project.rootPath, session)
          assert.ok(sourceReview?.sourceDraft, 'SOURCE_REVIEW_NOT_PERSISTED')
          const report = JSON.parse(sourceReview.content)
          let cycleId, selected
          if (candidate) {
            const cycle = db.prepare('SELECT cycle_id FROM review_cycles WHERE review_id=?').get(sourceReview.id)
            const finding = cycle && db.prepare(`SELECT finding_id,target_id,category,span_start,span_end FROM review_findings
              WHERE cycle_id=? AND target_id IS NOT NULL AND status IN ('unresolved','unknown') ORDER BY finding_id LIMIT 1`).get(cycle.cycle_id)
            assert.ok(cycle?.cycle_id && finding, 'TARGETED_REVIEW_FINDING_MISSING')
            const matched = report.items.find(item => item.goalId === finding.target_id || item.stableFactKey === finding.target_id)
            selected = { ...(matched ?? { category: finding.category, severity: 'error',
              description: '依据持久化 finding 定向修复。', quote: sourceDraft.content.slice(finding.span_start, finding.span_end) }),
              findingId: finding.finding_id, decision: 'apply', origin: 'ai' }
            cycleId = cycle.cycle_id
          } else {
            const matched = report.items.find(item => item.severity === 'error' || item.severity === 'warning')
            assert.ok(matched, 'TARGETED_REVIEW_ITEM_MISSING')
            selected = { ...matched, decision: 'apply', origin: 'ai' }
          }
          const human = await load('src/shared/human-confirmed-review.ts')
          const snapshot = human.createHumanConfirmedReviewSnapshot({ sourceReviewId: sourceReview.id,
            sourceDraft: sourceReview.sourceDraft, ...(cycleId ? { cycleId } : {}), summary: report.summary,
            authorGuidance: '只修复已选问题，其余正文保持不变。若问题要求人物在当章承担代价，必须同时满足三项：人物已经执行选择，具体损失或牺牲已经发生，后文不保留相反状态。签字认责、保证负责、简单否定翻转或承诺以后付出都不算代价。', items: [selected],
            ...(report.goalReview ? { goalReview: report.goalReview } : {}) })
          assert.ok(snapshot, 'CONFIRMATION_SNAPSHOT_INVALID')
          const confirmationContent = human.serializeHumanConfirmedReviewSnapshot(snapshot)
          const confirmation = await invoke('db:review-create', { baseDraftId: sourceDraft.id,
            content: confirmationContent, expectedSource: sourceReview.sourceDraft }, project.rootPath, session)
          assert.ok(confirmation?.success && confirmation.id, 'CONFIRMATION_NOT_PERSISTED')
          reviewState.confirmation = { reviewId: confirmation.id, contentHash: sha(confirmationContent),
            selectedItemHash: sha(selected), selectedFindingIds: selected.findingId ? [selected.findingId] : [],
            ...(cycleId ? { cycleId } : {}) }
          command = new (await load('src/services/workflows/commands/refine-from-review.command.ts')).RefineFromReviewCommand({
            draftPath, draftContent: sourceDraft.content, sourceDraft: frozenSource, chapterNumber: chapter.number,
            reviewSourceId: confirmation.id, confirmedReviewContent: confirmationContent,
          })
        } else {
          assert.equal(operationKind, 'recheck', 'UNREGISTERED_REVIEW_OPERATION')
          const merge = reviewState.merge
          command = new (await load('src/services/workflows/commands/review-chapter.command.ts')).ReviewChapterCommand({
            draftPath, draftContent: sourceDraft.content, sourceDraft: frozenSource, chapterNumber: chapter.number,
            reviewFocus: '只复核已选定问题的新证据。严格只输出模板约定的 JSON 根对象，不得输出 Markdown、前后说明或思考过程；若问题要求当章承担代价，必须同时核对人物已执行选择、具体损失已经发生、后文没有反证。签字认责、保证负责、简单否定翻转或承诺以后付出均不能证明完成。',
            ...(candidate ? { reviewCycleId: merge.cycleId, expectedMergedHash: merge.mergedHash } : {}),
          })
        }
      }
      const result = await command.execute(params)
      await Promise.all(streamSettlements)
      if (!fullRun || operationKind !== 'directory') assert.deepEqual(db.prepare('SELECT chapter_number,title,role,purpose,key_events,characters,user_guidance FROM blueprints WHERE chapter_number>1 ORDER BY chapter_number').all(), authorBlueprints, 'OUTSIDE_RANGE_REWRITTEN')
      const outputPath = path.join(evidenceRoot, `${receipt.operations.length + 1}-${operationKind}.${['directory', 'review', 'recheck'].includes(operationKind) ? 'json' : 'txt'}`)
      fs.writeFileSync(outputPath, typeof result === 'string' ? result : JSON.stringify(result, null, 2))
      const operationReceipt = { operation: operationId, kind: operationKind, returnedHash: sha(result),
        outputHash: sha(result), outputPath, handle: currentContext.mainGenerationRunHandle ?? null }
      receipt.operations.push(operationReceipt)
      if (continuityRun && ['chapter_notes', 'character_cards'].includes(operationKind)) {
        const slot = finalizedContext.slot
        const persisted = await invoke('finalization-generation:read', { slot }, session)
        assert.ok(persisted?.effect?.success && persisted.effect.stepKey === operationKind, 'FINALIZATION_EFFECT_NOT_SAVED')
        const count = receipt.attempts.length
        await command.execute(params)
        assert.equal(receipt.attempts.length, count, 'FINALIZATION_IDEMPOTENCY_DISPATCHED')
        receipt.finalizationEvidence ??= { source: slot.source, effects: [], idempotent: true }
        receipt.finalizationEvidence.effects.push({ stepKey: operationKind, effect: persisted.effect,
          effectHash: sha(persisted.effect), contextHash: sha(persisted.context) })
        if (operationKind === 'character_cards') {
          const roster = await invoke('db:character-roster-read', project.rootPath, session)
          const character = roster.entries.find(item => item.characterId === finalizedContext.identity.characters[0].characterId)
          const provenance = character?.currentState?.provenance?.recentEvents
          receipt.finalizationEvidence.derivedApplied = provenance?.kind === 'derived'
            && provenance.source.finalizationId === slot.source.finalizationId
          if (request.mode === 'synthetic') {
            assert.equal(character?.currentState?.recentEvents, '发现日期异常，决定到现场核查', 'DERIVED_STATE_NOT_APPLIED')
            assert.equal(receipt.finalizationEvidence.derivedApplied, true, 'DERIVED_PROVENANCE_MISSING')
          }
          if (['C16-B', 'C16-C'].includes(request.caseId)) {
            assert.equal(character?.currentState?.mentalState, '谨慎', 'AUTHOR_STATE_OVERWRITTEN')
            const candidates = await invoke('finalized-character:list-state-candidates', session)
            receipt.finalizationEvidence.authorProtected = candidates.some(item => item.characterId === character.characterId && item.field === 'mentalState')
            if (request.mode === 'synthetic') assert.equal(receipt.finalizationEvidence.authorProtected, true, 'AUTHOR_CONFLICT_CANDIDATE_MISSING')
          }
        }
      }
      if (operationKind === 'review') {
        const stored = await invoke('db:review-get-latest', sourceDraft.id, project.rootPath, session)
        assert.ok(stored?.id && stored.content, 'REVIEW_NOT_PERSISTED')
        const cycleId = candidate ? db.prepare('SELECT cycle_id FROM review_cycles WHERE review_id=?').pluck().get(stored.id) : null
        reviewState.reviewId = stored.id
        reviewState.review = { reviewId: stored.id, contentHash: sha(stored.content), ...(cycleId ? { cycleId } : {}) }
        operationReceipt.outputHash = reviewState.review.contentHash
        reviewState.source = { draftId: sourceDraft.id, contentHash: sha(sourceDraft.content) }
      } else if (operationKind === 'refine') {
        const revision = db.prepare(`SELECT r.id,r.status,c.body FROM revisions r JOIN contents c ON c.id=r.content_id
          WHERE r.base_draft_id=? ORDER BY r.revision_index DESC LIMIT 1`).get(sourceDraft.id)
        assert.ok(revision?.id && revision.status === 'pending', 'TARGETED_REVISION_NOT_PERSISTED')
        reviewState.revision = { revisionId: revision.id, contentHash: sha(revision.body) }
        const merged = await invoke('db:revision-merge', { revisionId: revision.id, targetDraftId: sourceDraft.id,
          expectedDraftContent: sourceDraft.content, mergedContent: revision.body, wordCount: countUnits(revision.body) }, project.rootPath, session)
        assert.ok(merged?.success && merged.receipt, 'TARGETED_REVISION_NOT_MERGED')
        reviewState.merge = { mergedHash: sha(revision.body), ...(merged.receipt.reviewCycle ?? {}) }
      } else if (operationKind === 'recheck') {
        const stored = await invoke('db:review-get-latest', sourceDraft.id, project.rootPath, session)
        assert.ok(stored?.id && stored.content, 'RECHECK_NOT_PERSISTED')
        if (candidate) {
          const cycle = db.prepare('SELECT cycle_id,recheck_count FROM review_cycles WHERE cycle_id=?').get(reviewState.merge.cycleId)
          const statuses = Object.fromEntries(db.prepare('SELECT status,COUNT(*) AS total FROM review_findings WHERE cycle_id=? GROUP BY status')
            .all(cycle.cycle_id).map(row => [row.status, row.total]))
          const recheckAttempt = receipt.attempts.find(attempt => attempt.binding?.operation === operation.id)
          const usageRow = db.prepare('SELECT usage_receipt_json FROM generation_attempts WHERE attempt_id=?')
            .get(recheckAttempt?.binding?.actual?.attemptId)
          const effect = usageRow ? JSON.parse(usageRow.usage_receipt_json).reviewCycleRecheck : null
          assert.ok((effect?.version === 1 || effect?.version === 2) && Array.isArray(effect.findings), 'RECHECK_EFFECT_RECEIPT_MISSING')
          reviewState.recheck = { reviewId: stored.id, contentHash: sha(stored.content), cycleId: cycle.cycle_id,
            recheckCount: cycle.recheck_count, disposition: cycle.recheck_count === 1 ? 'completed' : 'required', statuses,
            effect: { version: effect.version, findingMappings: effect.findings.length } }
        } else reviewState.recheck = { reviewId: stored.id, contentHash: sha(stored.content) }
        operationReceipt.outputHash = reviewState.recheck.contentHash
      }
    }
    if (request.phase === 'early-review') {
      receipt.reviewLifecycle = { source: reviewState.source, review: reviewState.review,
        confirmation: reviewState.confirmation, revision: reviewState.revision, merge: reviewState.merge,
        recheck: reviewState.recheck }
    }
    if ((!fullRun && !continuityRun) || request.operations.some(operation => operation.kind === 'draft')) {
      const draft = db.prepare('SELECT d.*,c.body AS content FROM drafts d JOIN contents c ON c.id=d.content_id WHERE d.chapter_number=? ORDER BY d.version DESC').all(chapter.number)
      assert.equal(draft.length, 1, 'ACTUAL_DRAFT_NOT_SAVED')
      const units = countUnits(draft[0].content)
      recordPersistedDraftObservation(receipt, { chapterNumber: chapter.number, targetUnits: chapter.targetUnits,
        units, contentHash: sha(draft[0].content) })
      receipt.saved = { chapterNumber: chapter.number, targetUnits: chapter.targetUnits,
        draftId: draft[0].id, version: draft[0].version, contentHash: sha(draft[0].content), units, persistedBytes: Buffer.byteLength(draft[0].content, 'utf8'),
        blueprintChapterNumbers: db.prepare('SELECT chapter_number FROM blueprints ORDER BY chapter_number').all().map(row => row.chapter_number) }
    }
    if (candidate) {
      receipt.ownerTerminal = db.prepare('SELECT a.attempt_id,a.attempt_json,a.usage_receipt_json,g.artifact_json FROM generation_attempts a JOIN generation_artifacts g ON g.attempt_id=a.attempt_id ORDER BY a.rowid').all()
        .filter(row => receipt.attempts.some(attempt => attempt.binding.actual.attemptId === row.attempt_id))
        .map(row => { const usage = JSON.parse(row.usage_receipt_json), artifact = JSON.parse(row.artifact_json)
          return { attemptId: row.attempt_id, status: JSON.parse(row.attempt_json).status, finishReason: usage.result?.finishReason,
            purpose: usage.purpose, trustedUsage: usage.result?.usage?.trusted === true,
            artifactId: artifact.artifactId, textHash: sha(artifact.text),
            hasFormalEffect: Boolean(usage.directoryProgress || usage.draftCommit || usage.reviewRevisionEffect || usage.finalizationEffect) } })
      assert.equal(receipt.ownerTerminal.length, receipt.attempts.length, 'OWNER_ATTEMPT_COVERAGE_MISMATCH')
      for (const attempt of receipt.attempts) {
        const terminal = receipt.ownerTerminal.find(row => row.attemptId === attempt.binding.actual.attemptId)
        assert.ok(terminal && ['settled', 'unknown'].includes(terminal.status))
        assert.equal(terminal.finishReason, 'stop')
        assert.equal(terminal.purpose, attempt.binding.actual.purpose)
        assert.ok(terminal.artifactId && terminal.textHash !== sha(''), 'OWNER_ARTIFACT_MISSING')
        const repairedDirectory = repairPolicy && attempt.binding.operation === repairPolicy.operationId
          && attempt.binding.actual.purpose === repairPolicy.primaryPurpose
          && receipt.attempts.some(other => other.binding.operation === repairPolicy.operationId
            && other.binding.actual?.purpose === repairPolicy.repairPurpose)
        const repairedCards = continuityRun && attempt.binding.operation === '定稿角色状态'
          && receipt.attempts.filter(other => other.binding.operation === '定稿角色状态').at(-1) !== attempt
        assert.equal(terminal.hasFormalEffect, !repairedDirectory && !repairedCards)
        if (request.mode === 'synthetic') assert.equal(terminal.trustedUsage, true)
        assert.equal(terminal.textHash, attempt.visibleTextHash, 'OWNER_ARTIFACT_OUTPUT_MISMATCH')
      }
    }
    if (restorationKind) {
      const { createRequire } = await import('node:module')
      const BetterSqlite = createRequire(path.join(target.repositoryRoot, 'package.json'))('better-sqlite3')
      const original = new BetterSqlite(sourceDbPath, { readonly: true, fileMustExist: true })
      try { assert.deepEqual(sourceRows(original), sourceBefore, 'RESTORE_SOURCE_MODIFIED') } finally { original.close() }
      receipt.restoration.sourceUnchanged = true
      assert.equal(json(projectFile).projectId, receipt.restoration.originProjectId, 'SOURCE_DESCRIPTOR_REWRITTEN')
      assert.ok(receipt.attempts.every(attempt => attempt.binding.actual.projectId === receipt.restoration.targetProjectId), 'RESTORE_DISPATCHED_OLD_PROJECT')
    }
    const ledgerEvents = fs.readFileSync(request.ledgerPath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    for (const attempt of receipt.attempts) {
      const rows = ledgerEvents.filter(event => event.attemptId === attempt.attemptId)
      assert.deepEqual(rows.map(event => event.type), ['reserve', 'dispatch', 'settle'], 'PHYSICAL_LEDGER_COVERAGE_MISMATCH')
      assert.deepEqual(rows[0].binding, attempt.binding, 'PHYSICAL_LEDGER_BINDING_MISMATCH')
      assert.ok(attempt.outputPath && attempt.visibleTextHash !== sha(''), 'PHYSICAL_OUTPUT_MISSING')
      assert.equal(sha(fs.readFileSync(attempt.outputPath, 'utf8')), attempt.visibleTextHash, 'PHYSICAL_OUTPUT_HASH_MISMATCH')
    }
    assertNoOutboundPreflightFailures(receipt)
    receipt.status = 'passed'
  } catch (error) {
    const canProjectRecoveryCandidate = request.mode === 'real'
      && !candidate
      && request.action === 'execute'
      && request.operations.length === 1
      && request.operations[0]?.kind === 'draft'
      && receipt.operations.length === 0
      && receipt.attempts.length === 1
      && Boolean(localDispatchGateRejection)
    if (canProjectRecoveryCandidate) {
      recoveryRows = database.getProjectDb().prepare('SELECT * FROM recovery_candidates').all()
    }
    const gateFailure = targetUnitsGateEvidence(error)
    if (gateFailure) receipt.gateFailure = gateFailure
    receipt.status = 'failed'; receipt.error = safeDiagnostic(error)
    throw request.mode === 'real' ? new Error('REAL_PRODUCTION_BRIDGE_FAILED') : error
  } finally {
    // 先等流收尾、再撤守护：守护计时器仍然活着，任何仍未终态的发送都会被它写 unknown。
    await Promise.allSettled(streamSettlements)
    supervisor.dispose()
    globalThis.fetch = originalFetch
    database?.closeProjectDatabase(); projectAccess?.invalidateCurrentSession()
    vi.unstubAllGlobals()
    // 每臂的请求规模证据（纯数字，不含提示词原文与凭据），两臂因此可在不花真实调用时比较。
    receipt.bridgeSettlementDeadlineMs = BRIDGE_SETTLEMENT_DEADLINE_MS
    receipt.requestSizes = receipt.attempts.map(attempt => ({ operation: attempt.binding.operation, arm: attempt.binding.arm,
      mode: attempt.binding.mode, attemptId: attempt.attemptId, composedPromptBytes: attempt.composedPromptBytes,
      requestBodyBytes: attempt.requestBodyBytes }))
    receipt.composedPromptBytes = receipt.attempts.reduce((sum, attempt) => sum + (attempt.composedPromptBytes ?? 0), 0)
    const serialized = JSON.stringify(receipt, null, 2) + '\n'
    const receiptBytes = secret ? serialized.split(secret).join('[REDACTED]') : serialized
    fs.writeFileSync(request.receiptPath, receiptBytes)
    if (recoveryRows) projectRecoveryCandidateSupplement({ request, requestBytes, receipt: JSON.parse(receiptBytes), receiptBytes,
      ledgerBytes: fs.readFileSync(request.ledgerPath, 'utf8'), recoveryRows, targetUnits: chapter.targetUnits,
      isolationRoot: target.isolationRoot, localDispatchGateRejection })
  }
}, BRIDGE_TEST_TIMEOUT_MS)
