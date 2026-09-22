import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { X } from 'lucide-react'

import { Button } from '../ui/Button'
import { toast } from '../ui/Toast'
import { useEditorStore } from '../../stores/editor-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useLocaleStore } from '../../stores/locale-store'
import { useOnboardingStore } from '../../stores/onboarding-store'
import { useUiVersionStore, isModernShell } from '../../stores/ui-version-store'
import { useProjectStore } from '../../stores/project-store'
import { openBuiltinEditor } from '../panels/sidebar/sidebar-file-openers'
import GuideMark from './GuideMark'

/**
 * 新手引导（Quick Start）—— 第一次打开软件时自动出现的一次性小教程。
 *
 * 设计取舍：
 *   1. 从「配置模型」讲起：没有模型，后面所有生成都用不了，所以它排第一。
 *   2. **指向式**而不是居中的固定卡片：每一步都尽量指向界面上的真实位置
 *      （顶栏的模型胶囊、文件菜单、侧栏那三个小球…），卡片贴着目标放，
 *      跟着目标走；找不到目标时才退回居中。
 *   3. **不挡作者要操作的地方**：没有全屏遮罩、不吃任何点击，卡片默认靠边放，
 *      而且整张卡片可以拖动 —— 打开模型设置去填 Key 的时候，卡片不会压住输入框。
 *   4. **动作按钮不推进步骤**：点「打开模型设置」只把设置开到模型那一栏，
 *      填完关掉设置，教程还在原地等着接着往下讲。
 *   5. 每一屏只讲一件事，底部固定「跳过这一步」，顶部随时「跳过全部」。
 */

type Placement = 'center' | 'below' | 'right' | 'right-pinned' | 'right-edge'

/**
 * 分步清单项的语义色。
 *   key  —— 关键动作 / 必填项（朱砂）
 *   good —— 推荐状态（松烟绿）
 *   warn —— 会踩坑的注意点（藤黄）
 *   risk —— 不可取的做法（朱砂红）
 */
type LineTone = 'key' | 'good' | 'warn' | 'risk'

/**
 * 分步清单里的一项。
 *   · 纯字符串 —— 普通一条，只有序号；
 *   · 带 tone —— 画成一块「重点色块」：左侧语义色竖条 + 同色浅底 + 加粗标签。
 *
 * 先生的原话：教程「完全没重点色块标识，玩家根本摸不到重点」——
 * 所以凡是「做对了才不白跑」的一条（选哪个模型、参数填什么、哪一步必须点击），
 * 都得有颜色，而不是埋在一整列同色的灰字里。
 */
interface QuickStartLine {
  text: string
  /** 色块开头的短标签，例如「主模型」「只配向量模型」 */
  label?: string
  tone?: LineTone
}

/** 色块取主题语义色，四套主题各自解析，不写死十六进制。 */
const LINE_TONES: Record<LineTone, { rule: string; surface: string; label: string }> = {
  key: {
    rule: 'var(--color-accent)',
    surface: 'color-mix(in srgb, var(--color-accent) 7%, transparent)',
    label: 'var(--color-accent)',
  },
  good: {
    rule: 'var(--color-success)',
    surface: 'color-mix(in srgb, var(--color-success) 9%, transparent)',
    label: 'var(--color-success-text)',
  },
  warn: {
    rule: 'var(--color-warning)',
    surface: 'color-mix(in srgb, var(--color-warning) 11%, transparent)',
    label: 'var(--color-warning-text)',
  },
  risk: {
    rule: 'var(--color-error)',
    surface: 'color-mix(in srgb, var(--color-error) 9%, transparent)',
    label: 'var(--color-error-text)',
  },
}

/** 一条清单项统一收敛成这个形状，渲染层不必再判类型。 */
function toLine(line: string | QuickStartLine): QuickStartLine {
  return typeof line === 'string' ? { text: line } : line
}

interface QuickStartStep {
  key: string
  titleZh: string
  titleEn: string
  bodyZh: string
  bodyEn: string
  /** 照着做的分步清单；有它就把正文展开成有序步骤。 */
  stepsZh?: Array<string | QuickStartLine>
  stepsEn?: Array<string | QuickStartLine>
  /** 「去操作」按钮的文案；没有则不显示按钮。 */
  actionZh?: string
  actionEn?: string
  /**
   * 该步要做的事。**进入这一步时会自动执行**（傻瓜式：切到哪一步就把哪一屏
   * 弹出来），按钮只是兜底 —— 作者自己关掉面板后还能再点一次。
   */
  run?: () => void
  /**
   * 离开这一步时要收起来的东西。只用于「临时弹出的模态」（设置、新建项目），
   * 编辑器标签不在此列 —— 那是作者的工作区，不该被引导关掉。
   */
  closeOnLeave?: () => void
  /** 指向界面上的哪个元素（data-tour 属性选择器）。 */
  anchor?: string
  placement: Placement
}

/** 卡片宽度（经典界面 v1）。 */
const CARD_WIDTH = 392
/**
 * 现代外壳（v2 墨纸书斋 / v3 时尚杂志）下的卡片宽度。
 *
 * 这两套外壳的排版度量整体上提了一档，392px 装不下底部那排按钮 ——
 * 「跳过这一步 / 上一步 / 动作按钮 / 下一步」最多四个，字号放大后
 * 会被压到换行、甚至把按钮内文字挤断。加宽到 460px 才有舒展的余地。
 */
const CARD_WIDTH_MODERN = 460
const CARD_MARGIN = 12
/** 目标元素可能晚一两帧才挂载（比如刚切完栏目），所以按固定节奏重新量一次位置。 */
const ANCHOR_POLL_MS = 400

/** 路线选择屏上的两张大按钮：左侧标题 + 右侧一句流程梗概。 */
const TRACK_BUTTON_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 4,
  padding: '11px 13px',
  textAlign: 'left',
  background: 'var(--color-panel)',
  color: 'var(--color-text)',
  border: '1px solid var(--color-border)',
  borderRadius: 10,
  cursor: 'pointer',
}

/** 需要项目才能实施的动作：没项目就先把作者送回「建立作品」那一步。 */
function requireProject(): boolean {
  if (useProjectStore.getState().currentProject?.path) return true
  const text = useLocaleStore.getState().text
  toast.warning(text('请先新建或打开一个作品', 'Create or open a project first'))
  useOnboardingStore.getState().setStepIndex(2)
  return false
}

/** 打开侧栏「目录」栏目，正文栏落到小说配置页。 */
function openNovelConfig(): void {
  if (!requireProject()) return
  const path = useProjectStore.getState().currentProject?.path
  if (!path) return
  useLayoutStore.getState().setSidebarView('project')
  useEditorStore.getState().openFile({
    id: 'config',
    name: useLocaleStore.getState().text('小说配置', 'Novel configuration'),
    type: 'config',
    projectKey: path,
  })
}

/** 「我想自己写」这条线：从配置模型开始，一步步把新书的地基搭好。 */
const SELF_STEPS: QuickStartStep[] = [
  {
    key: 'welcome',
    titleZh: '欢迎使用 AI 小说作家',
    titleEn: 'Welcome to AI Novel Writer',
    bodyZh: '跟着走一遍，就能把一本书的地基搭好。每一步都能跳过，以后也可以在欢迎页重新打开这份引导。',
    bodyEn: 'One pass sets up everything a novel needs. Every step can be skipped, and you can reopen this guide from the welcome page.',
    placement: 'center',
  },
  {
    key: 'model',
    titleZh: '配置模型',
    titleEn: 'Set up a model',
    bodyZh: '所有 AI 生成都要经过模型，所以这件事排第一。打开设置后照着下面做：',
    bodyEn: 'Every AI generation goes through a model, so this comes first. Open the settings and follow along:',
    stepsZh: [
      '在「AI 生成模型」这一栏点「添加生成模型」，填写「新建模型配置」表单；已有模型就点它右侧的编辑图标',
      '服务商：云端选 DeepSeek / OpenAI / xAI / 智谱 / Gemini，本地推理选 Ollama，接中转站选「自定义」',
      'API Key：从服务商控制台复制密钥粘贴进来；Ollama 这类本地服务可以留空',
      'base_url：官方地址已自动填好（DeepSeek 是 https://api.deepseek.com，别自己补 /v1）；只有走中转地址才改这里',
      {
        label: '获取模型列表',
        tone: 'key',
        text: '「端点模型列表」那一块点「获取模型列表」，软件会向服务商拉取可用模型，从下拉里直接选一个；若提示鉴权失败或端点不支持，就点「手动输入」照服务商文档填模型标识',
      },
      {
        label: '测试连接',
        tone: 'key',
        text: '点「测试连接」，看到「连接成功」再保存；报「连接失败」多半是 API Key 或 base_url 不对。结果只显示几秒，别等它消失',
      },
      '上下文窗口：照服务商文档如实填（deepseek-v4-flash 的预设值就是 100 万）。留空等于告诉软件「我不知道」，它就不再校验输入长度，超长时会被服务端悄悄截断',
      {
        label: '推理强度',
        tone: 'warn',
        text: '调低或关闭：思考内容会和正文抢同一份输出预算，容易把输出截断。温度 0.7 左右、最大输出 Token 用预设值即可',
      },
      '保存后它就是默认模型；配了多个时，把常用那个点一下卡片上的「设为默认」',
    ],
    stepsEn: [
      'In the “Generation models” section click “Add generation models” and fill in the form; for an existing model use the edit icon on its right',
      'Provider: DeepSeek / OpenAI / xAI / BigModel / Gemini in the cloud, Ollama for local inference, Custom for a gateway',
      'API key: paste the key from the provider console; leave it blank for local services such as Ollama',
      'base_url: the official address is filled in already (DeepSeek is https://api.deepseek.com — do not append /v1). Only a gateway needs a different value',
      {
        label: 'Refresh model list',
        tone: 'key',
        text: 'In “Endpoint model list” click “Refresh model list” to pull the models the provider offers and pick one from the dropdown; if it reports an auth failure or an unsupported endpoint, switch to “Enter manually” and type the model ID from the provider docs',
      },
      {
        label: 'Test connection',
        tone: 'key',
        text: 'Click “Test connection” and wait for “Connection succeeded” before saving; a failure almost always means the API key or base_url is wrong. The result only stays for a few seconds',
      },
      'Context window: enter the real number from the provider docs (deepseek-v4-flash is preset to 1,000,000). Leaving it blank tells the app “unknown”, so it stops checking input length and an oversized prompt is silently truncated',
      {
        label: 'Reasoning effort',
        tone: 'warn',
        text: 'Keep it low or off: thinking tokens compete with the text for the same output budget and tend to cut it off. Temperature around 0.7 and the preset max output are fine',
      },
      'The saved model becomes the default; with several models, click “Set as default” on the card you use most',
    ],
    actionZh: '打开模型设置',
    actionEn: 'Open model settings',
    run: () => useLayoutStore.getState().openSettings('llm'),
    // 离开这一步就把设置收起来，免得后面几步一直被面板压着。
    closeOnLeave: () => useLayoutStore.getState().closeSettings(),
    anchor: '[data-tour="model-pill"]',
    placement: 'right-edge',
  },
  {
    key: 'project',
    titleZh: '建立作品',
    titleEn: 'Create or open a project',
    bodyZh: '一个项目就是一部小说。顶栏「文件 → 新建项目」只填两件事，其余都在项目里配置。项目数据都放在你自己的项目目录与本地数据库里。',
    bodyEn: 'One project is one novel. “File → New project” in the title bar asks for two things only; everything else is configured inside the project, and all data stays in your own folder and local database.',
    stepsZh: [
      '作品名称：随手写一个就行，之后再改也不影响（例如「斗破苍穹」）',
      '保存位置：点「选择」挑一个空文件夹；项目文件、草稿与本地数据库都会落在那里，方便整体备份',
      {
        label: '其余配置',
        tone: 'key',
        text: '题材、总章数、每章字数、叙事视角、核心大纲都不在这个弹窗里 —— 建好项目后到「小说配置」填，那里也才看得见 AI 一键生成的入口',
      },
      '已经有作品：用「文件 → 打开项目」选到那个文件夹，就能接着写',
    ],
    stepsEn: [
      'Title: anything goes, and you can change it later',
      'Save location: use “Choose” to pick a folder; project files, drafts and the local database all live there, which makes backup easy',
      {
        label: 'Everything else',
        tone: 'key',
        text: 'Genre, chapter count, words per chapter, point of view and the core outline are not in this dialog — set them in “Novel configuration”, which is also where the AI one-click generation lives',
      },
      'Already have a project? Use “File → Open project” and pick its folder to continue',
    ],
    actionZh: '新建项目',
    actionEn: 'New project',
    run: () => useLayoutStore.getState().openNewProject(),
    closeOnLeave: () => useLayoutStore.getState().closeNewProject(),
    anchor: '[data-tour="file-menu"]',
    placement: 'below',
  },
  {
    key: 'config',
    titleZh: '小说配置',
    titleEn: 'Novel configuration',
    bodyZh: '侧栏第一个小球这一行。先定题材、总章数与叙事视角，再写下核心大纲 —— 它是后面所有生成的源头。填好之后这个球会变绿。',
    bodyEn: 'The first dot in the sidebar. Set the genre, chapter count and point of view, then write the core outline — everything generated later builds on it. The dot turns green once it is filled in.',
    stepsZh: [
      '先定规模：题材 + 总章数（长篇建议 100–300 章）+ 每章字数（网文 2000–3000 字）',
      '叙事视角慎选：第一人称 / 第三人称限知 / 全知视角，中途换会牵动全篇的写法',
      {
        label: '核心大纲',
        tone: 'key',
        text: '后面每一次生成都从这里出发：写清主角、金手指、主要冲突与结局方向，越具体 AI 越不跑偏',
      },
      {
        label: '写不出大纲',
        tone: 'key',
        text: '在大纲框里写一两句脑洞，点「AI 填充配置」让它把其余字段一并生成；只想补某一块时，用该区块右上角的「AI 生成」',
      },
      '世界观、金手指、主角档案可以先各写一句 —— 生成故事架构时 AI 会顺着它深度扩展',
      '填好后侧栏第一个小球会变绿，表示这一关过了',
    ],
    stepsEn: [
      'Set the scale first: genre, chapter count (100–300 for a long novel) and words per chapter (2,000–3,000 for web fiction)',
      'Choose the point of view carefully: first person, limited third person or omniscient — switching later changes how the whole book is written',
      {
        label: 'Core outline',
        tone: 'key',
        text: 'Every later generation starts here: protagonist, signature advantage, main conflicts and the direction of the ending. The more concrete, the less the AI drifts',
      },
      {
        label: 'Stuck on the outline',
        tone: 'key',
        text: 'Write a sentence or two of your idea, then click “Fill with AI” to generate the remaining fields; to fill a single block, use the “Generate with AI” button in its top-right corner',
      },
      'World, signature advantage and protagonist profile can start as one line each — architecture generation expands them',
      'Once filled in, the first dot in the sidebar turns green',
    ],
    actionZh: '打开小说配置',
    actionEn: 'Open configuration',
    run: openNovelConfig,
    anchor: '[data-tour="journey-config"]',
    placement: 'right',
  },
  {
    key: 'arch',
    titleZh: '故事架构',
    titleEn: 'Story architecture',
    bodyZh: '第二个小球这一行。按「故事前提 → 角色图谱 → 世界观 → 情节大纲」生成四份底稿，每份管一件事：',
    bodyEn: 'The second dot. Four foundations are generated in order — premise → cast → world → plot outline. Each owns one job:',
    stepsZh: [
      {
        label: '故事前提',
        tone: 'key',
        text: '故事钩子 · 核心冲突链 · 主角优势 · 悬念骨架 —— 决定这本书「一句话讲的是什么」，也是后面所有内容的锚',
      },
      {
        label: '角色图谱',
        tone: 'key',
        text: '角色弧光 · 关系网络 · 矛盾交织 —— 跑完会同时生成角色卡，人物编辑器和关系图谱都读它',
      },
      { label: '世界观', text: '核心规则 · 社会结构 · 深层危机 —— 写正文时检索得到，冲突才有依据' },
      { label: '情节大纲', text: '结构推进 · 转折节奏 · 伏笔闭环 —— 章数多时按批生成，中断了可以从断点续写' },
      '四份底稿的建议顺序就是上面这个顺序：前提定了，角色与世界观才有依附',
      '中途被长度上限截断也没关系：已完成的部分会保存成候选，可以查看、复制或接着写',
    ],
    stepsEn: [
      {
        label: 'Story premise',
        tone: 'key',
        text: 'Hook, core conflict chain, protagonist edge, suspense structure — it decides what the book is about in one sentence, and anchors everything else',
      },
      {
        label: 'Character map',
        tone: 'key',
        text: 'Arcs, relationships, interlocking tensions — running it also produces character cards, which the editors and the relation map read',
      },
      { label: 'Worldbuilding', text: 'Core rules, social structure, underlying crisis — retrievable while drafting, so conflicts have a basis' },
      { label: 'Plot outline', text: 'Progression, turning points, setup and payoff — long books run it in batches, and an interrupted run resumes from its checkpoint' },
      'The suggested order is exactly the order above: the premise comes first, then cast and world can hang off it',
      'If a run is cut off by the length limit, the finished part is kept as a candidate you can view, copy or continue',
    ],
    actionZh: '打开故事架构',
    actionEn: 'Open architecture',
    run: () => {
      if (!requireProject()) return
      openBuiltinEditor(
        'world-building-editor',
        useLocaleStore.getState().text('故事架构', 'Story architecture'),
        'world-building',
      )
    },
    anchor: '[data-tour="journey-arch"]',
    placement: 'right',
  },
  {
    key: 'arch-generate',
    titleZh: '「AI 生成架构」弹窗怎么用',
    titleEn: 'How the “Generate story architecture” dialog works',
    bodyZh: '点故事架构页右上角的「AI 生成架构」会弹出这个小窗口，它决定这一次生成哪几份底稿 —— 看懂三个地方再点确认：',
    bodyEn: 'The “Generate story architecture” button in the top-right opens a small dialog that decides which foundations this run produces. Three things matter before you confirm:',
    stepsZh: [
      '顶部「当前配置预览」：类型、受众、总章数、每章字数、核心大纲 —— 生成用的就是这些，先核一遍再点',
      {
        label: '勾选要生成的步骤',
        tone: 'key',
        text: '四个板块各自独立。没勾的保持原样不动，只勾你想做的那几份；已存在的板块勾上会标成「将覆盖」',
      },
      {
        label: '状态标签',
        tone: 'key',
        text: '绿色「保留」= 已有内容、这次不动它；黄色「将覆盖」= 已有内容会被这次生成替换掉；朱砂「待生成」= 还没有这份底稿',
      },
      {
        label: '情节大纲的范围',
        tone: 'warn',
        text: '总章数超过 20 章时默认只生成第 1–20 章：完成后再从下一章续批，已确认的部分不会被覆盖',
      },
      '确认后任务在底部任务栏里跑，可以一边做别的；跑完回这一页看四份底稿的状态与字数',
      '想重做某一份，再点一次「AI 生成架构」，只勾那一份即可（会覆盖旧内容）',
    ],
    stepsEn: [
      '“Current configuration” at the top: genre, audience, chapter count, words per chapter and the core outline — this is exactly what the run uses, so check it first',
      {
        label: 'Sections to generate',
        tone: 'key',
        text: 'The four sections are independent. Unchecked ones keep their content; ticking an existing one marks it “Overwrite”',
      },
      {
        label: 'Status badges',
        tone: 'key',
        text: 'Green “Keep” means content exists and stays untouched; yellow “Overwrite” means this run replaces it; accent “New” means the section does not exist yet',
      },
      {
        label: 'Plot outline scope',
        tone: 'warn',
        text: 'Above 20 chapters the run defaults to chapters 1–20; continue from the next chapter afterwards, and confirmed content is never overwritten',
      },
      'The run then proceeds in the bottom task panel while you keep working; when it ends, come back to see each section’s status and size',
      'To redo one section, open the dialog again and tick only that one — this overwrites it',
    ],
    run: () => {
      if (!requireProject()) return
      openBuiltinEditor(
        'world-building-editor',
        useLocaleStore.getState().text('故事架构', 'Story architecture'),
        'world-building',
      )
    },
    placement: 'center',
  },
  {
    key: 'blueprint',
    titleZh: '章节蓝图',
    titleEn: 'Chapter blueprints',
    bodyZh: '第三个小球这一行。给每一章定下定位、冲突和结尾钩子。有了蓝图，写正文时只会围绕当前这一章，不会跑到别的章上去。',
    bodyEn: 'The third dot. Give every chapter its role, conflict and closing hook. With blueprints in place each draft request stays on the chapter you are writing.',
    stepsZh: [
      '每张章卡要能回答三件事：这一章推进什么、冲突是什么、结尾留什么钩子',
      {
        label: '为什么值得花时间',
        tone: 'key',
        text: '写正文时只按当前这一章取上下文（本章蓝图 + 前文摘要 + 知识库检索），不会把整本书塞进提示词 —— 长篇不跑偏靠的就是它',
      },
      {
        label: '一次批量产出',
        tone: 'key',
        text: '点右上角「AI生成」，在弹出的窗口里选生成范围与模式（例如从第 1 章到第 20 章），一次跑完再逐章微调',
      },
      '单个章节不满意就手改那张卡；也可以用「手动新建一章蓝图」补齐缺的章',
      '「批量写作」能按连续蓝图一次开最多 10 章的写作任务，适合已经想清楚的时候用',
    ],
    stepsEn: [
      'Every card should answer three things: what this chapter advances, what the conflict is, what hook it ends on',
      {
        label: 'Why it pays off',
        tone: 'key',
        text: 'A draft request only pulls the context of the current chapter (its blueprint + earlier summaries + knowledge-base hits) instead of the whole book — this is what keeps a long novel on track',
      },
      {
        label: 'Generate in bulk',
        tone: 'key',
        text: 'Click “AI generate” in the top-right, choose the range and mode (for example chapters 1–20), then refine card by card',
      },
      'Unhappy with one chapter? Edit that card directly, or add a missing one with “Add a blueprint manually”',
      '“Batch write” runs up to 10 consecutive chapters from their blueprints — handy once the plan is settled',
    ],
    actionZh: '打开章节蓝图',
    actionEn: 'Open blueprints',
    run: () => {
      if (!requireProject()) return
      openBuiltinEditor(
        'chapter-card-editor',
        useLocaleStore.getState().text('章节蓝图', 'Chapter blueprints'),
        'chapter-card',
      )
    },
    anchor: '[data-tour="journey-blueprint"]',
    placement: 'right',
  },
  {
    key: 'write',
    titleZh: '开始写作',
    titleEn: 'Start writing',
    bodyZh: '三个小球都变绿，就可以开写了。打开任意一章：先写稿，再审稿，按报告修稿，最后定稿 —— 定稿后的正文会成为后面章节的事实依据。',
    bodyEn: 'Once all three dots are green you are ready. Open a chapter and work through draft → review → revision → finalize — a finalized chapter becomes the factual basis for later ones.',
    stepsZh: [
      '打开目录里的一章：先写稿 → 再审稿 → 按报告修稿 → 最后定稿，四步各有按钮',
      {
        label: '定稿是关键一步',
        tone: 'key',
        text: '定稿后的正文会成为后续章节的事实依据（人物状态、连续性都从它推），所以别在草稿阶段就定稿',
      },
      '修稿只看审稿报告里你认可的问题，不必全盘照改 —— 报告的判断也要作者把关',
      '下一章的蓝图还没生成时，先在「章节蓝图」补上，再回来写作',
    ],
    stepsEn: [
      'Open a chapter from the table of contents: draft → review → revise against the report → finalize, each with its own button',
      {
        label: 'Finalizing matters',
        tone: 'key',
        text: 'A finalized chapter becomes the factual basis for the ones after it (character state and continuity are derived from it), so do not finalize while it is still a rough draft',
      },
      'In the review report, revise only the issues you agree with — you still own the judgement',
      'If the next chapter has no blueprint yet, add it in “Chapter blueprints” first, then come back',
    ],
    actionZh: '打开目录',
    actionEn: 'Open the manuscript',
    run: () => {
      if (!requireProject()) return
      useLayoutStore.getState().setSidebarView('project')
    },
    placement: 'center',
  },
]

/**
 * 「我想导入小说」这条线。
 *
 * 与「自己写」的根本区别：作者手上已经有稿子了，所以第一件事不是建项目，
 * 而是把两个模型配好。导入会同时用到主模型（读懂并拆解）与向量模型（切块入库），
 * 两者的能力直接决定导入能不能跑完、拆得准不准 —— 这也是这条线把模型放在最前面的原因。
 * 配完再回到导入面板，按「选用途选文件 → 核对拆章预览 → 确认导入 → 等待 → 验收」走一遍。
 */
const IMPORT_STEPS: QuickStartStep[] = [
  {
    key: 'import-intro',
    titleZh: '导入已有小说，其实是「拆解」',
    titleEn: 'Importing is really an analysis pass',
    bodyZh: '导入不是把 txt 丢进软件就完事：它会先把整本书拆成章节，再让 AI 反向推演出世界观、角色和每一章的蓝图。走完这一趟，你就能接着往下写。',
    bodyEn: 'Importing is more than dropping a txt into the app. It splits the book into chapters, then has the AI infer the world, the cast and a blueprint for every chapter — after that you can keep writing.',
    stepsZh: [
      '入口在顶栏「文件 → 小说导入」，弹出的面板就是接下来要用的地方',
      '先配好两个模型：主模型负责「读懂并拆解」，向量模型负责「切块入库供检索」',
      '再回到导入面板：选用途、选文件、核对拆章预览、确认导入',
      '导入分阶段自动跑，中途可以关软件，重开后从断点继续，不会白跑',
      '导入完成后，推演出来的设定、角色卡和蓝图都可以照你的意思改',
    ],
    stepsEn: [
      'The entry point is “File → Import novel” in the title bar; the panel it opens is where everything happens',
      'Set up two models first: the generation model reads and analyses, the embedding model chunks the text into the knowledge base',
      'Then return to the import panel: pick the purpose, pick files, check the chapter split, confirm',
      'The run proceeds in stages; you may close the app and resume from the last checkpoint',
      'Everything inferred afterwards — settings, cast, blueprints — stays editable',
    ],
    placement: 'center',
  },
  {
    key: 'import-models',
    titleZh: '两个模型，各管一件事',
    titleEn: 'Two models, two jobs',
    bodyZh: '导入会同时用上两种模型。缺一个也能导，但结果差很多。先把分工搞清楚，后面每一步才知道自己在配什么。',
    bodyEn: 'An import uses both kinds of model. You can import with only one, but the result is much weaker. Knowing the split makes the next two steps obvious.',
    stepsZh: [
      {
        label: '主模型',
        tone: 'key',
        text: '（设置 →「AI 生成模型」）读懂全文并拆解 —— 全局设定、文风分析、每 5 章一次的蓝图推演，全由它完成。它决定「拆得对不对、要跑多久、花多少 token」',
      },
      {
        label: '向量模型',
        tone: 'key',
        text: '（设置 →「向量模型」）把每一章正文切成小块存进知识库，每章一次。它决定「AI 能不能检索到书里的细节」',
      },
      {
        label: '只配主模型',
        tone: 'warn',
        text: '能导完，但全局推演只能靠硬塞进去的首末章片段，中段的细节容易漏',
      },
      {
        label: '只配向量模型',
        tone: 'risk',
        text: '没有推演，等于只建了一个可检索的资料库',
      },
      {
        label: '两个都配',
        tone: 'good',
        text: '推荐状态，也正是下面两步要带你做的',
      },
    ],
    stepsEn: [
      {
        label: 'Generation model',
        tone: 'key',
        text: '(Settings → “Generation models”) reads the whole book and analyses it — global settings, style, and one blueprint call per five chapters. It decides whether the split is accurate, how long it takes and how many tokens it costs',
      },
      {
        label: 'Embedding model',
        tone: 'key',
        text: '(Settings → “Embedding model”) chunks each chapter into the knowledge base, once per chapter. It decides whether the AI can actually retrieve details from the book',
      },
      {
        label: 'Generation model only',
        tone: 'warn',
        text: 'The import finishes, but global inference sees little beyond the first and last chapters, so mid-book details are easily missed',
      },
      {
        label: 'Embedding model only',
        tone: 'risk',
        text: 'No inference at all — you merely get a searchable corpus',
      },
      {
        label: 'Both',
        tone: 'good',
        text: 'The recommended setup, and what the next two steps walk you through',
      },
    ],
    placement: 'center',
  },
  {
    key: 'import-llm',
    titleZh: '第一步：配置主模型',
    titleEn: 'Step 1: set up the generation model',
    bodyZh: '打开设置 →「AI 生成模型」。导入全程的大模型调用都从这里取，配错会直接卡住导入。',
    bodyEn: 'Open Settings → “Generation models”. Every model call during the import is taken from here, so a wrong value can stall the whole run.',
    stepsZh: [
      {
        label: '具体用哪个模型',
        tone: 'key',
        text: '云端推荐 DeepSeek 的 deepseek-v4-flash（预设即 100 万上下文、支持结构化输出，导入的蓝图推演很吃这一点）；要更强的推理可换 deepseek-v4-pro。本地推理可用 Ollama 的 qwen2.5:14b 一类，但一批 5 章的输入容易超出小模型的窗口',
      },
      '在「AI 生成模型」栏点「添加生成模型」，服务商、API Key 按服务商文档填；Ollama 的 API Key 可留空',
      {
        label: '获取模型列表',
        tone: 'key',
        text: '「端点模型列表」里点「获取模型列表」会去问服务商要一份可用模型清单，从下拉里选中即可；若提示鉴权失败、端点不支持或网络失败，改点「手动输入」照文档填模型标识',
      },
      {
        label: '测试连接',
        tone: 'key',
        text: '点「测试连接」，看到「连接成功」再保存。报「连接失败」时先查 API Key 与 base_url，再看网络 —— 结果是绿字就说明这条配置真能用',
      },
      {
        label: '上下文窗口',
        tone: 'warn',
        text: '一批要同时放 5 章正文（约 3 万字符），所以窗口建议 64K 以上、128K 更稳。如实填写：留空等于告诉软件「我不知道」—— 它就不再校验输入长度，超长时会被服务端悄悄截断，蓝图会失真且不报错',
      },
      'base_url 用预设默认值就好（DeepSeek 是 https://api.deepseek.com，别自己补 /v1）；地址对不上会让「已校验能力」失效，窗口又变回未知',
      {
        label: '推理强度',
        tone: 'warn',
        text: '建议调低或关闭：思考内容会和蓝图正文抢同一份输出预算，容易把蓝图截断',
      },
      '消耗心里有数：约 15K + 每章 4K tokens；耗时约（1 + 章数 ÷ 5）分钟',
    ],
    stepsEn: [
      {
        label: 'Which model',
        tone: 'key',
        text: 'In the cloud, DeepSeek’s deepseek-v4-flash is a good pick (1M context by preset, structured output — blueprints depend on it); deepseek-v4-pro for heavier reasoning. For local inference, Ollama with something like qwen2.5:14b works, but five chapters of input can exceed a small model’s window',
      },
      'Click “Add generation models”, then fill in the provider and API key from the provider docs; Ollama needs no API key',
      {
        label: 'Refresh model list',
        tone: 'key',
        text: 'In “Endpoint model list”, “Refresh model list” asks the provider for the models it offers — pick one from the dropdown. On an auth failure, unsupported endpoint or network error, switch to “Enter manually” and copy the model ID from the docs',
      },
      {
        label: 'Test connection',
        tone: 'key',
        text: 'Click “Test connection” and wait for “Connection succeeded” before saving. A failure means the API key or base_url first, the network second — green text means this entry really works',
      },
      {
        label: 'Context window',
        tone: 'warn',
        text: 'One batch fits five chapters (about 30k characters), so 64K or more is advisable and 128K is safer. Enter it honestly: blank tells the app “unknown”, so it stops checking input length, the provider silently truncates, and blueprints drift with no error',
      },
      'Keep the preset base_url (for DeepSeek https://api.deepseek.com — do not append /v1). A mismatched address voids the verified capabilities and the window becomes unknown again',
      {
        label: 'Reasoning effort',
        tone: 'warn',
        text: 'Keep it low or off: thinking tokens compete with the blueprint JSON for the same output budget and tend to truncate it',
      },
      'Budget rule of thumb: about 15K + 4K tokens per chapter; roughly (1 + chapters ÷ 5) minutes',
    ],
    actionZh: '打开模型设置',
    actionEn: 'Open model settings',
    run: () => useLayoutStore.getState().openSettings('llm'),
    closeOnLeave: () => useLayoutStore.getState().closeSettings(),
    anchor: '[data-tour="model-pill"]',
    placement: 'right-edge',
  },
  {
    key: 'import-embedding',
    titleZh: '第二步：配置向量模型',
    titleEn: 'Step 2: set up the embedding model',
    bodyZh: '同一个设置里切到「向量模型」。它把每章正文切块入库，供 AI 检索本书细节。',
    bodyEn: 'In the same settings window, switch to “Embedding model”. It chunks every chapter into the knowledge base so the AI can retrieve details.',
    stepsZh: [
      {
        label: '具体用哪个模型',
        tone: 'key',
        text: '推荐默认的 SiliconFlow BAAI/bge-m3：注册实名后免费调用，额度够导完整本书。本地推理可用 Ollama 的 bge-m3 或 nomic-embed-text；走 OpenAI 系就用 text-embedding-3-small',
      },
      '在「向量模型」栏点「添加向量模型」，服务商选 SiliconFlow，只需填 API Key（base_url 已自动填好）',
      {
        label: '获取模型列表与测试连接',
        tone: 'key',
        text: '点「获取模型列表」从返回清单里选 BAAI/bge-m3（拉不到就手动输入模型标识），再点「测试连接」，通过后保存',
      },
      {
        label: '向量化高级参数',
        tone: 'key',
        text: '分块字符数 500 / 重叠字符数 50 / 请求批量 50 —— 这是稳妥默认值。含义：每 500 字切成一段存进知识库，相邻两段重叠 50 字以免把跨段的内容切断，一次请求送 50 段去向量化',
      },
      {
        label: '本地显存小',
        tone: 'warn',
        text: '点「应用低显存推荐」会改成 分块 300 / 重叠 30 / 批量 4 —— 批量越小，一次送进显存的段数越少',
      },
      '不配也能导入，但知识库会退化成关键词检索，没有语义检索，全局推演的采样质量会明显下降',
      '导入完成后到「知识库」看一眼：若提示「向量索引待补全」，说明向量化中途失败过（它只会静默降级、不报错），点一下重建即可',
    ],
    stepsEn: [
      {
        label: 'Which model',
        tone: 'key',
        text: 'The default is a good choice: SiliconFlow’s BAAI/bge-m3 — free after verification, with enough quota for a whole book. Locally, Ollama offers bge-m3 or nomic-embed-text; on OpenAI use text-embedding-3-small',
      },
      'In the “Embedding model” section click “Add embedding models”, choose SiliconFlow and paste the API key (base_url is filled in)',
      {
        label: 'Refresh list and test',
        tone: 'key',
        text: 'Click “Refresh model list” and pick BAAI/bge-m3 from what comes back (or type the model ID manually), then “Test connection” and save',
      },
      {
        label: 'Embedding advanced settings',
        tone: 'key',
        text: 'Chunk characters 500 / overlap 50 / request batch 50 — safe defaults. In plain terms: every 500 characters become one stored chunk, neighbouring chunks share 50 characters so nothing is cut in half, and one request embeds 50 chunks',
      },
      {
        label: 'Small local GPU',
        tone: 'warn',
        text: '“Use low-VRAM preset” switches to chunk 300 / overlap 30 / batch 4 — a smaller batch means fewer chunks in VRAM at once',
      },
      'Importing without it still works, but the knowledge base degrades to keyword search — no semantic retrieval — and inference quality drops noticeably',
      'After the import, check the Knowledge base: a “Vector index needs completion” hint means embedding failed silently mid-run. One click rebuilds it',
    ],
    actionZh: '打开向量模型设置',
    actionEn: 'Open embedding settings',
    run: () => useLayoutStore.getState().openSettings('embedding'),
    closeOnLeave: () => useLayoutStore.getState().closeSettings(),
    placement: 'right-edge',
  },
  {
    key: 'import-open',
    titleZh: '第三步：回到导入面板，选用途和文件',
    titleEn: 'Step 3: back to the import panel',
    bodyZh: '模型配好后就可以导了。先决定这本书是拿来参考还是自己的原稿，再选文件。',
    bodyEn: 'With the models ready you can start. Decide whether the book is reference material or your own manuscript, then pick the files.',
    stepsZh: [
      '从顶栏「文件 → 小说导入」打开这个面板；顶部「导入目标」选「创建新项目」，还没有项目也能直接导',
      {
        label: '参考小说',
        tone: 'key',
        text: '用于知识库、结构与文风拆解，产出的蓝图和设定供你仿写；不会变成你的草稿或正文章节',
      },
      '「我的原稿」：按章节号导入为不可变权威定稿，供续写用；不会进入参考语料，也不做仿写拆解',
      '支持 .txt / .md / .epub，可以一次选多个文件，系统会按文件名顺序拼接',
      '文件必须是 UTF-8 编码，否则中文会变成乱码',
    ],
    stepsEn: [
      'Open the panel with “File → Import novel” in the title bar; set “Import destination” to “Create new project” to import without an existing project',
      {
        label: 'Reference novel',
        tone: 'key',
        text: 'Used for knowledge, structure and style analysis. The blueprints and settings it produces support your own writing; it never becomes your draft or manuscript',
      },
      '“My manuscript”: imported by chapter number as immutable authoritative text for continuation; it stays out of the reference corpus and gets no style analysis',
      'Supports .txt / .md / .epub, and multiple files at once — they are concatenated in filename order',
      'Files must be UTF-8, otherwise Chinese text turns into mojibake',
    ],
    actionZh: '打开导入面板',
    actionEn: 'Open the import panel',
    run: () => useLayoutStore.getState().openImportNovel(),
    closeOnLeave: () => useLayoutStore.getState().closeImportNovel(),
    anchor: '[data-tour="import-panel"]',
    placement: 'right-pinned',
  },
  {
    key: 'import-format',
    titleZh: '文件要满足的三个硬条件',
    titleEn: 'Three hard requirements for the file',
    bodyZh: '拆章靠识别章节标题。条件不满足，AI 拆出来的结构就是错的，后面全白跑 —— 这一步值得花两分钟。',
    bodyEn: 'Chapter splitting works by recognising headings. If the file does not cooperate the structure comes out wrong and everything downstream is wasted — two minutes here are worth it.',
    stepsZh: [
      '章节标题必须独占一行，并且写成这三种之一：「第X章 标题」「Chapter X」「# 第X章」',
      {
        label: '最要紧的一条',
        tone: 'warn',
        text: '一条标题都识别不到时，整个文件会被当成 1 章。那一章再长，AI 也只看得到前 6000 字',
      },
      {
        label: '章节号必须连续',
        tone: 'risk',
        text: '不能跳号，也不能重号，否则导入会直接报错',
      },
      '单章建议 2000–4000 字。超过 6000 字的章节，超出部分不参与蓝图推演',
      '段落之间留空行：分块和检索的效果都会更好',
    ],
    stepsEn: [
      'A chapter heading must own its line and look like one of: “第X章 标题”, “Chapter X”, or “# 第X章”',
      {
        label: 'Most important',
        tone: 'warn',
        text: 'If no heading is recognised, the whole file becomes a single chapter — and the AI only ever sees its first 6,000 characters',
      },
      {
        label: 'Numbers must be contiguous',
        tone: 'risk',
        text: 'No gaps and no duplicates, or the import fails outright',
      },
      'Aim for 2,000–4,000 characters per chapter. Beyond 6,000 the surplus never reaches blueprint inference',
      'Keep a blank line between paragraphs — it improves both chunking and retrieval',
    ],
    placement: 'center',
  },
  {
    key: 'import-preview',
    titleZh: '第四步：核对拆章预览与消耗',
    titleEn: 'Step 4: check the split and the cost',
    bodyZh: '选完文件会出现预览：共几章、平均多少字，以及这次导入的预估消耗。确认之前不会写入任何内容。',
    bodyEn: 'Once files are chosen a preview appears: chapter count, average length, and the estimated cost. Nothing is written before you confirm.',
    stepsZh: [
      '先核对「共 N 章」和章节列表前几行；标题错位就回去改文件再重选，不要硬导',
      '看一眼「预估 AI 消耗」与预计耗时：蓝图推演是大头',
      {
        label: '规模建议',
        tone: 'key',
        text: '单次 60–200 章（约 20–60 万字）最稳，再大就容易跑很久或中途失败',
      },
      {
        label: '百万字长篇',
        tone: 'warn',
        text: '请分卷导入：每卷不超过 20 万字，文件名能排序，例如 01_第1-70章.txt，这样后续批次按顺序接得上',
      },
      '系统上限：单次最多 5000 章、正文总量 128 MiB（约 3800 万汉字）、单个文件 64 MiB',
    ],
    stepsEn: [
      'Check the chapter count and the first rows of the chapter list; if headings are misaligned, fix the file and pick again instead of forcing it',
      'Look at the estimated AI usage and duration — blueprint inference dominates both',
      {
        label: 'Recommended size',
        tone: 'key',
        text: '60–200 chapters (about 200k–600k characters) per run is safest; larger runs take very long and fail more often',
      },
      {
        label: 'Million-character novels',
        tone: 'warn',
        text: 'Import volume by volume: at most 200k characters each, with sortable filenames such as 01_ch1-70.txt so later batches line up in order',
      },
      'Hard limits: 5,000 chapters, 128 MiB of text (about 38 million Chinese characters), 64 MiB per file',
    ],
    actionZh: '回到导入面板',
    actionEn: 'Back to the import panel',
    run: () => useLayoutStore.getState().openImportNovel(),
    closeOnLeave: () => useLayoutStore.getState().closeImportNovel(),
    anchor: '[data-tour="import-panel"]',
    placement: 'right-pinned',
  },
  {
    key: 'import-run',
    titleZh: '第五步：确认导入，然后等它跑完',
    titleEn: 'Step 5: confirm and let it run',
    bodyZh: '确认后按阶段自动执行。整个过程可以中断，也可以关掉软件 —— 每个批次都有存档点。',
    bodyEn: 'After you confirm it runs in stages. The run is safely interruptible — every batch leaves a checkpoint.',
    stepsZh: [
      '① 正文入库：每章切块做向量化，一章一次请求',
      '② 全局推演：读首末章，再用向量检索采样中段内容，推演题材、世界观、主角与金手指',
      '③ 文风分析：提取可复用的文风约束，供后续续写模仿',
      '④ 蓝图推演：每 5 章一批，一批一次模型调用 —— 这是最慢的一步，也是耗时与花费的主要来源',
      '⑤ 刷新项目状态：生成角色卡、章节蓝图与项目树',
      '进度在底部任务栏里：能看出跑到哪个阶段、第几批、失败在哪一批 —— 失败的那批可以单独重试，不用从头再来',
      '中途关掉软件也没关系：重开后打开导入面板，在「可继续的导入」里点「继续导入」，只会重跑没完成的那一批',
    ],
    stepsEn: [
      '① Text ingestion: each chapter is chunked and embedded, one request per chapter',
      '② Global inference: reads the first and last chapters, samples the middle via vector search, then infers genre, world, protagonist and central advantage',
      '③ Style analysis: extracts reusable style constraints for later continuation',
      '④ Blueprint inference: one model call per five chapters — the slowest stage and the bulk of the cost',
      '⑤ Refresh: builds character cards, chapter blueprints and the project tree',
      'Progress lives in the bottom task panel: which stage, which batch, which failure — a failed batch can be retried on its own instead of starting over',
      'Closing the app mid-run is fine: reopen the import panel and use “Continue import” under resumable imports — only the unfinished batches rerun',
    ],
    placement: 'center',
  },
  {
    key: 'import-after',
    titleZh: '导入完成后，先验收再开写',
    titleEn: 'After the import: review, then write',
    bodyZh: '数据已经都在项目里了。推演毕竟是猜，花几分钟过一遍，后面写起来会顺很多。',
    bodyEn: 'Everything now lives in the project. Inference is still a guess, so a few minutes of review saves a lot of rewriting later.',
    stepsZh: [
      '去侧栏「故事架构」验收推演出来的四份底稿：故事前提（钩子/冲突链）、角色图谱、世界观、情节大纲',
      '去「角色卡」核对角色：不想要的、认错的旧角色直接删掉，避免和新设定打架',
      '去「章节蓝图」看每章的定位、冲突与结尾钩子，不顺手的先改掉再开写',
      {
        label: '不满意就重做一块',
        tone: 'key',
        text: '点「AI 生成架构」，只勾想重做的那一份（勾上会标「将覆盖」），其余保持原样 —— 不必为一块内容把四份都重跑',
      },
      {
        label: '大纲分批推进',
        tone: 'warn',
        text: '章节多时默认只推第 1–20 章：确认完这批，下次再推第 21 章往后，已确认的部分不会被覆盖',
      },
      '一切就绪，打开第一章就能接着往下写了',
    ],
    stepsEn: [
      'Open “Story architecture” in the sidebar and review the four foundations: premise (hook and conflict chain), character map, worldbuilding, plot outline',
      'Open “Characters” and clean up the cast: delete unwanted or misidentified entries so they cannot conflict with the new setting',
      'Open “Chapter blueprints” to check each chapter’s role, conflict and closing hook, then fix what reads wrong',
      {
        label: 'Redo just one section',
        tone: 'key',
        text: 'Open “Generate story architecture” and tick only the section you want to redo (it will read “Overwrite”); the rest stays as is — no need to rerun all four',
      },
      {
        label: 'Outline in batches',
        tone: 'warn',
        text: 'With many chapters the run defaults to chapters 1–20; confirm that batch, then continue from chapter 21 — confirmed content is never overwritten',
      },
      'Then open chapter one and continue writing',
    ],
    placement: 'center',
  },
]

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * 把卡片放到目标旁边，并保证「不压住目标、不越出窗口」：
 * 右侧放不下就改到下方，下方也放不下就改到上方，都放不下才退回居中。
 */
function placeCard(
  rect: DOMRect | null,
  placement: Placement,
  cardHeight: number,
  cardWidth: number = CARD_WIDTH,
): { left: number; top: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const centered = {
    left: clamp((vw - cardWidth) / 2, CARD_MARGIN, Math.max(CARD_MARGIN, vw - cardWidth - CARD_MARGIN)),
    top: clamp(vh / 2 - cardHeight / 2, CARD_MARGIN, Math.max(CARD_MARGIN, vh - cardHeight - CARD_MARGIN)),
  }
  if (!rect || placement === 'center') return centered

  if (placement === 'right-edge') {
    return {
      left: Math.max(CARD_MARGIN, vw - cardWidth - CARD_MARGIN),
      top: clamp(vh / 2 - cardHeight / 2, CARD_MARGIN, Math.max(CARD_MARGIN, vh - cardHeight - CARD_MARGIN)),
    }
  }

  /**
   * right-pinned：优先紧贴目标右侧，右侧空间不够就压到窗口最右边缘。
   *
   * 专为「目标是一张居中大对话框」而设（导入面板、设置面板）：这类目标自己占住
   * 屏幕中间，普通的 'right' 在窄窗口下会退化成居中、与目标完全重叠；这里宁可
   * 贴住窗口右边（允许少量压边），也要保证卡片不挡住对话框里的输入区。
   */
  if (placement === 'right-pinned') {
    const maxLeft = Math.max(CARD_MARGIN, vw - cardWidth - CARD_MARGIN)
    return {
      left: clamp(rect.right + CARD_MARGIN, CARD_MARGIN, maxLeft),
      top: clamp(vh / 2 - cardHeight / 2, CARD_MARGIN, Math.max(CARD_MARGIN, vh - cardHeight - CARD_MARGIN)),
    }
  }

  if (placement === 'right') {
    const roomRight = vw - rect.right - CARD_MARGIN * 2
    if (roomRight >= cardWidth) {
      return {
        left: rect.right + CARD_MARGIN,
        top: clamp(rect.top, CARD_MARGIN, Math.max(CARD_MARGIN, vh - cardHeight - CARD_MARGIN)),
      }
    }
    // 右边放不下就改到下方
    if (vh - rect.bottom - CARD_MARGIN * 2 >= cardHeight) {
      return {
        left: clamp(rect.left, CARD_MARGIN, Math.max(CARD_MARGIN, vw - cardWidth - CARD_MARGIN)),
        top: rect.bottom + CARD_MARGIN,
      }
    }
    return centered
  }

  // below
  if (vh - rect.bottom - CARD_MARGIN * 2 >= cardHeight) {
    return {
      left: clamp(rect.left, CARD_MARGIN, Math.max(CARD_MARGIN, vw - cardWidth - CARD_MARGIN)),
      top: rect.bottom + CARD_MARGIN,
    }
  }
  if (rect.top - CARD_MARGIN * 2 >= cardHeight) {
    return {
      left: clamp(rect.left, CARD_MARGIN, Math.max(CARD_MARGIN, vw - cardWidth - CARD_MARGIN)),
      top: rect.top - cardHeight - CARD_MARGIN,
    }
  }
  return centered
}

export default function QuickStartGuide() {
  const open = useOnboardingStore((s) => s.open)
  const track = useOnboardingStore((s) => s.track)
  const stepIndex = useOnboardingStore((s) => s.stepIndex)
  const skippedSteps = useOnboardingStore((s) => s.skippedSteps)
  const setTrack = useOnboardingStore((s) => s.setTrack)
  const setStepIndex = useOnboardingStore((s) => s.setStepIndex)
  const markStepSkipped = useOnboardingStore((s) => s.markStepSkipped)
  const closeGuide = useOnboardingStore((s) => s.closeGuide)
  const text = useLocaleStore((s) => s.text)
  const locale = useLocaleStore((s) => s.locale)
  const uiVersion = useUiVersionStore((s) => s.uiVersion)
  /**
   * 卡片宽度按外壳版本取值：现代外壳的排版度量更大，需要更宽的卡片
   * 才能把底部那排按钮舒展开。位置计算与渲染宽度用同一个值，卡片才不会被
   * 算出界（placeCard 内部也用这个宽度做 clamp）。
   */
  const cardWidth = isModernShell(uiVersion) ? CARD_WIDTH_MODERN : CARD_WIDTH

  const cardRef = useRef<HTMLElement | null>(null)
  const [cardHeight, setCardHeight] = useState(0)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  /**
   * 作者拖动卡片后的位移。位移与「第几步」绑在一起：换一步自动失效、
   * 重新跟着新目标走 —— 于是不需要用 effect 回写状态。
   */
  const [drag, setDrag] = useState<{ step: number; x: number; y: number } | null>(null)
  const dragState = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

  /** 没选路线时先不挂步骤：先让作者在两条线里挑一条。 */
  const steps = track === 'import' ? IMPORT_STEPS : track === 'self' ? SELF_STEPS : []
  const choosing = track === 'choose'
  const total = steps.length
  const index = total > 0 ? clamp(stepIndex, 0, total - 1) : 0
  const step: QuickStartStep | null = steps[index] ?? null
  const dragOffset = drag && drag.step === index ? { x: drag.x, y: drag.y } : { x: 0, y: 0 }

  /**
   * 傻瓜式引导：切到哪一步，就把那一步要用的面板自动弹出来 —— 模型设置、
   * 新建项目、小说配置、架构编辑器、蓝图编辑器；离开时再把**临时弹出的模态**
   * 收回去（编辑器标签留着，那是作者的工作区）。
   * 作者自己关掉面板也能再点按钮打开，所以这里不需要额外状态。
   */
  useEffect(() => {
    if (!open || !step) return undefined
    const run = step.run
    const closeOnLeave = step.closeOnLeave
    run?.()
    return () => {
      closeOnLeave?.()
    }
    /**
     * 依赖 step 对象本身（模块级常量，引用稳定）而不是 [open, index]：
     * 两条线的同一下标是两个不同对象，所以切换路线时这里一定会重跑，
     * 不会把上一条线弹出的面板留在屏幕上。
     */
  }, [open, step])

  // 量目标元素的位置：目标可能晚一两帧才挂载（刚切栏目、刚开项目），所以按节奏重测。
  useEffect(() => {
    if (!open) return undefined
    const selector = step?.anchor
    /**
     * 必须做**值比较后再 setState**：getBoundingClientRect() 每次返回新的 DOMRect
     * 对象，即使坐标一模一样，React 的 Object.is 也判定为变化 →
     * 引导开启期间每 400ms 就强制重渲染一次（并连带重算卡片避让、重建子树）。
     */
    const measure = () => {
      if (!selector) {
        setAnchorRect(prev => (prev === null ? prev : null))
        return
      }
      const element = document.querySelector(selector)
      const next = element ? element.getBoundingClientRect() : null
      setAnchorRect(prev => (
        prev && next
        && prev.top === next.top && prev.left === next.left
        && prev.width === next.width && prev.height === next.height
          ? prev
          : next
      ))
    }
    measure()
    const timer = window.setInterval(measure, ANCHOR_POLL_MS)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [open, step?.anchor])

  // 卡片高度会随内容（分步清单）变化，量出来才能算好避让
  useEffect(() => {
    const element = cardRef.current
    if (!element) return undefined
    // 同样做值比较：ResizeObserver 回调里无条件 setState 容易与布局互相触发。
    const update = () => {
      const next = element.getBoundingClientRect().height
      setCardHeight(prev => (Math.abs(prev - next) < 0.5 ? prev : next))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [open, index])

  const onDragStart = useCallback((event: React.MouseEvent) => {
    dragState.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: dragOffset.x,
      baseY: dragOffset.y,
    }
    const onMove = (moveEvent: MouseEvent) => {
      const state = dragState.current
      if (!state) return
      setDrag({
        step: index,
        x: state.baseX + (moveEvent.clientX - state.startX),
        y: state.baseY + (moveEvent.clientY - state.startY),
      })
    }
    const onUp = () => {
      dragState.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [dragOffset.x, dragOffset.y, index])

  /**
   * 直接算，不做 useMemo：placeCard 只是几次矩形比较，成本可以忽略；
   * 而 React Compiler 无法证明「按路线选出来的步骤数组」里的对象不可变，
   * 把它塞进依赖数组会让整个组件的 memo 优化被跳过（lint 直接报错）。
   */
  const position = placeCard(anchorRect, step?.placement ?? 'center', cardHeight || 260, cardWidth)

  if (!open) return null

  /**
   * 先选路线：两条线的准备工作与步骤完全不同（自己写要先建项目，导入要先配两个模型），
   * 混在一条线里讲必然有一半是废话。选择屏不进步骤序列，也不计进度。
   */
  if (choosing) {
    return (
      <section
        ref={cardRef}
        role="dialog"
        aria-label={text('新手引导', 'Quick start guide')}
        data-quick-start-step="choose"
        style={{
          position: 'fixed',
          left: position.left,
          top: position.top,
          width: cardWidth,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 24px)',
          overflowY: 'auto',
          padding: '13px 16px 13px',
          background: 'var(--color-raised)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.18))',
          zIndex: 60,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            margin: '-4px 0 0',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--mag-fs-micro, 11px)', color: 'var(--color-text-muted)' }}>
            <GuideMark size={12} />
            {text('新手引导', 'Quick start')}
          </span>
          <button
            type="button"
            onClick={() => closeGuide('skipped')}
            title={text('跳过全部，不再自动出现', 'Skip the whole guide')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '2px 6px',
              fontSize: 'var(--mag-fs-micro, 11px)',
              color: 'var(--color-text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {text('跳过全部', 'Skip all')}
            <X size={12} />
          </button>
        </div>

        <h3 style={{ margin: '11px 0 0', fontSize: 'var(--mag-fs-lead, 15px)', fontWeight: 600 }}>
          {text('你想怎么开始？', 'How would you like to start?')}
        </h3>
        <p style={{ margin: '7px 0 0', fontSize: 'var(--mag-fs-caption, 12.5px)', lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
          {text(
            '两条路要准备的东西不一样，先挑一条。以后随时能从欢迎页或顶栏「帮助」重新打开这份引导。',
            'The two paths need different preparation, so pick one. You can reopen this guide any time from the welcome page or the Help menu.',
          )}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={() => setTrack('self')} style={TRACK_BUTTON_STYLE}>
            <span style={{ fontSize: 'var(--mag-fs-label, 13px)', fontWeight: 600 }}>
              {text('我想自己写', 'I want to write my own')}
            </span>
            <span style={{ fontSize: 'var(--mag-fs-kicker, 11.5px)', lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
              {text(
                '从零开始：配置模型 → 建立作品 → 小说配置 → 故事架构 → 章节蓝图 → 开写',
                'From scratch: model → project → configuration → architecture → blueprints → writing',
              )}
            </span>
          </button>
          <button type="button" onClick={() => setTrack('import')} style={TRACK_BUTTON_STYLE}>
            <span style={{ fontSize: 'var(--mag-fs-label, 13px)', fontWeight: 600 }}>
              {text('我想导入小说', 'I want to import a novel')}
            </span>
            <span style={{ fontSize: 'var(--mag-fs-kicker, 11.5px)', lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
              {text(
                '已经有稿子：主模型 + 向量模型 → 拆章导入 → 反向推演设定 → 接着写',
                'Already have a draft: generation + embedding models → split and import → infer the settings → continue writing',
              )}
            </span>
          </button>
        </div>
      </section>
    )
  }

  if (!step) return null

  const isLast = index === total - 1
  const goNext = () => {
    if (isLast) {
      closeGuide('completed')
      return
    }
    setStepIndex(index + 1)
  }
  const stepLines = locale === 'en-US' ? (step.stepsEn ?? []) : (step.stepsZh ?? [])

  return (
    <>
      {/* 目标高亮环：不修改目标元素自身的样式，只用一层描边把注意力带过去。 */}
      {anchorRect && (
        <div
          aria-hidden
          data-quick-start-anchor={step.key}
          style={{
            position: 'fixed',
            left: anchorRect.left - 4,
            top: anchorRect.top - 4,
            width: anchorRect.width + 8,
            height: anchorRect.height + 8,
            borderRadius: 9,
            boxShadow: '0 0 0 2px var(--color-accent), 0 0 0 7px color-mix(in srgb, var(--color-accent) 16%, transparent)',
            pointerEvents: 'none',
            /**
             * 必须高过 Dialog 的 z-50：对话框自带一层全屏遮罩（bg-black/30 + blur），
             * 卡片只要低于它就会被压在下面 —— 作者看到的就是「教程被这个面板遮住」。
             * 同时要低于 Toast / AlertDialog / 右键菜单的 9999，别去抢它们的层级。
             */
            zIndex: 59,
          }}
        />
      )}

      <section
        ref={cardRef}
        role="dialog"
        aria-label={text('新手引导', 'Quick start guide')}
        data-quick-start-step={step.key}
        style={{
          position: 'fixed',
          left: position.left + dragOffset.x,
          top: position.top + dragOffset.y,
          width: cardWidth,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 24px)',
          overflowY: 'auto',
          padding: '13px 16px 13px',
          background: 'var(--color-raised)',
          color: 'var(--color-text)',
          border: '1px solid var(--color-border)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.18))',
          zIndex: 60,
        }}
      >
        {/* 顶部：进度 + 跳过全部（整条可拖动） */}
        <div
          onMouseDown={onDragStart}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            cursor: 'grab',
            margin: '-4px 0 0',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 'var(--mag-fs-micro, 11px)', color: 'var(--color-text-muted)' }}>
            <GuideMark size={12} />
            {text('新手引导', 'Quick start')}
            {' · '}
            {text(`第 ${index + 1} / ${total} 步`, `Step ${index + 1} of ${total}`)}
            {skippedSteps.length > 0
              ? text(`（已跳过 ${skippedSteps.length} 步）`, ` (${skippedSteps.length} skipped)`)
              : null}
          </span>
          <button
            type="button"
            onClick={() => closeGuide('skipped')}
            title={text('跳过全部，不再自动出现', 'Skip the whole guide')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '2px 6px',
              fontSize: 'var(--mag-fs-micro, 11px)',
              color: 'var(--color-text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {text('跳过全部', 'Skip all')}
            <X size={12} />
          </button>
        </div>

        {/* 进度点 */}
        <div aria-hidden style={{ display: 'flex', gap: 5, margin: '9px 0 11px' }}>
          {steps.map((item, dotIndex) => (
            <span
              key={item.key}
              style={{
                width: dotIndex === index ? 16 : 6,
                height: 6,
                borderRadius: 99,
                background: dotIndex <= index ? 'var(--color-accent)' : 'var(--color-border)',
                transition: 'width 0.2s ease',
              }}
            />
          ))}
        </div>

        <h3 style={{ margin: 0, fontSize: 'var(--mag-fs-lead, 15px)', fontWeight: 600 }}>{text(step.titleZh, step.titleEn)}</h3>
        <p style={{ margin: '7px 0 0', fontSize: 'var(--mag-fs-caption, 12.5px)', lineHeight: 1.7, color: 'var(--color-text-secondary)' }}>
          {text(step.bodyZh, step.bodyEn)}
        </p>

        {/*
          分步清单：序号自己画（listStyle: none），这样带 tone 的一条才能整块染色 ——
          原生 ol 序号是浏览器画的，一旦给 li 上底色就会与序号脱节。
        */}
        {stepLines.length > 0 && (
          <ol
            style={{
              margin: '10px 0 0',
              padding: '9px 11px',
              listStyle: 'none',
              fontSize: 'var(--mag-fs-note, 12px)',
              lineHeight: 1.75,
              color: 'var(--color-text)',
              background: 'var(--color-panel)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {stepLines.map((rawLine, lineIndex) => {
              const item = toLine(rawLine)
              const tone = item.tone ? LINE_TONES[item.tone] : null
              return (
                <li
                  key={`${lineIndex}-${item.text}`}
                  style={{
                    display: 'flex',
                    gap: 7,
                    padding: '5px 9px 5px 7px',
                    borderLeft: `3px solid ${tone ? tone.rule : 'transparent'}`,
                    background: tone ? tone.surface : 'transparent',
                    borderRadius: '0 7px 7px 0',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      color: tone ? tone.label : 'var(--color-text-muted)',
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {lineIndex + 1}.
                  </span>
                  <span style={{ minWidth: 0 }}>
                    {item.label && (
                      <b style={{ color: tone ? tone.label : 'var(--color-text)', fontWeight: 600 }}>
                        {item.label}
                        {'：'}
                      </b>
                    )}
                    {item.text}
                  </span>
                </li>
              )
            })}
          </ol>
        )}

        {/*
          底部操作行：左侧「跳过这一步」，右侧一组推进按钮。
          外层用 space-between + wrap，右侧自成一组 —— 窗口窄或按钮多时，
          整组会换到下一行，而不是把每个按钮压扁。
          （flex 默认 nowrap 会把超出宽度的按钮压到内容宽以下，文字随之折断 ——
          这正是先生看到的「按钮挤压」。）
        */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 14,
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              markStepSkipped(index)
              goNext()
            }}
          >
            {text('跳过这一步', 'Skip this step')}
          </Button>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            {index > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStepIndex(index - 1)}>
                {text('上一步', 'Back')}
              </Button>
            )}
            {step.actionZh && step.run && (
              <Button variant="outline" size="sm" onClick={step.run}>
                {text(step.actionZh, step.actionEn ?? step.actionZh)}
              </Button>
            )}
            <Button variant="default" size="sm" onClick={goNext}>
              {isLast ? text('完成', 'Done') : text('下一步', 'Next')}
            </Button>
          </div>
        </div>
      </section>
    </>
  )
}
