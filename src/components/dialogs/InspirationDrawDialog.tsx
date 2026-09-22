/**
 * InspirationDrawDialog — 便利贴的「AI 灵感」
 *
 * 先生 2026-09-20 定的形态（原话梳理）：
 *   · 点「AI 灵感」弹出，里面三个窗口：
 *     ① 引用框：4 个勾选框（故事前提 / 角色图谱 / 世界观 / 情节大纲）
 *        + 一个输入框，敲 @ 展开菜单引用角色 / 设定集 / 章节蓝图；
 *     ② 一个对话框：作者自己写构思想法；
 *     ③ 一个数字框：这次抽几张，默认 1，上限 10。
 *   · 右下角「开始抽卡」。
 *   · 出图后卡片**横排**；可以多选，选中的**按从左到右的次序**依次追加进便利贴正文；
 *     剩下没选的进待选箱（能再找回）。
 *
 * 两条项目里必须遵守的既有契约：
 *   · 弹窗装载 AI 生成结果 / 填到一半的参数时，**点蒙版不算关闭**
 *     （见 src/components/__tests__/modal-dismiss-safety.test.ts 的理由）。
 *   · 抽卡产物只进便利贴 —— 这条链路不写任何创作事实。
 */
import { useMemo, useRef, useState } from 'react'
import { Check, Loader2, Sparkles, X } from 'lucide-react'

import type { StickyMentionRef, StickyNote } from '../../shared/sticky-note'
import {
  STICKY_DRAW_DEFAULT_COUNT,
  STICKY_DRAW_MAX_COUNT,
  composeStickyIdeaBlock,
  mergeStickyAppendedBlocks,
  stickyNoteIdFromTabPath,
} from '../../shared/sticky-note'
import { STICKY_ARCH_FILES, parseInspirationCards } from '../../services/workflows/commands/draw-inspiration.command'
import type { MentionTarget } from '../../services/agent/intent-router'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { useEditorStore } from '../../stores/editor-store'
import { useStickyNoteStore } from '../../stores/sticky-note-store'
import { useStickyDrawStore } from '../../stores/sticky-draw-store'
import { useUiVersionStore, isMagazine } from '../../stores/ui-version-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/Dialog'
import { Button } from '../ui/Button'
import PageHead from '../ui/PageHead'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { toast } from '../ui/Toast'
import WritingSkillBubble from '../editor/WritingSkillBubble'
import MentionMenu, { type MentionAnchor } from '../panels/agent/MentionMenu'

/** 四个勾选框的初始值：全不勾。方向感来自作者的点选，不来自默认值。 */
const NO_INCLUDE = {
  premise: false,
  characters: false,
  worldbuilding: false,
  synopsis: false,
} as const

type IncludeKey = keyof typeof NO_INCLUDE

/**
 * 便利贴允许引用的五类 —— 先生定的。
 *
 * 同一份清单**同时**管两件事：@ 菜单里显示哪几类（allowedTypes），
 * 以及选中后允许成为哪种引用。两边用同一个常量，不会各自漂移。
 */
const STICKY_MENTION_TYPES = ['character', 'world-setting', 'blueprint', 'draft', 'manuscript'] as const
type StickyMentionType = typeof STICKY_MENTION_TYPES[number]

/**
 * 塔罗牌的尺寸与间距。
 *
 * 先生要的摆法是一排最多 5 张，那 5 张横排就得放得下 ——
 * 5 × 152 + 4 × 12 = 808px，加上弹窗内边距，正好落在一千像素的编辑区里。
 * 高按塔罗牌的比例（约 1 : 1.72）取 262。
 */
const STICKY_CARD_WIDTH = 152
const STICKY_CARD_HEIGHT = 262
const STICKY_CARD_GAP = 12

export default function InspirationDrawDialog() {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const notes = useStickyNoteStore(s => s.notes)
  const tabs = useEditorStore(s => s.tabs)
  const activeTabId = useEditorStore(s => s.activeTabId)
  /**
   * v3「时尚杂志」的装帧纪律：发丝直角、零阴影。v2「墨纸书斋」走原来的圆角。
   * 铁律三：这类分家必须显式判 isMagazine，不能让 v3 的改动渗回 v2。
   */
  const uiVersion = useUiVersionStore(s => s.uiVersion)
  const magazine = isMagazine(uiVersion)
  const frameRadius = magazine ? 2 : 'var(--radius-md)'
  const chipRadius = magazine ? 2 : 'var(--radius-sm)'

  /**
   * 抽卡的这几个状态**住在 store 里，不住在本组件里**。
   *
   * 先生：「AI 灵感库生成灵感的时候，如果我切去了其他面板，等 AI 后台生成灵感之后，
   * 我点击回来，就发现选择 AI 灵感的那个牌面的菜单不见了！内容也没进入待选，
   * 等于我的 token 白白浪费掉了！」
   * 根因就是原先它们是本组件的 useState —— 组件一被卸载，等结果的地址就没了。
   */
  const open = useStickyDrawStore(s => s.open)
  const stage = useStickyDrawStore(s => s.stage)
  const cards = useStickyDrawStore(s => s.cards)
  const selected = useStickyDrawStore(s => s.selected)
  const toggleCard = useStickyDrawStore(s => s.toggleCard)

  // 表单留在组件里：抽卡一旦发出它就没用了，切走丢掉无妨。
  const [include, setInclude] = useState<Record<IncludeKey, boolean>>({ ...NO_INCLUDE })
  const [mentions, setMentions] = useState<StickyMentionRef[]>([])
  const [idea, setIdea] = useState('')
  const [count, setCount] = useState(STICKY_DRAW_DEFAULT_COUNT)
  const [busy, setBusy] = useState(false)

  // @ 菜单：贴在输入框下方展开（与章节蓝图页的「本章引用」同一套做法）
  const [showMention, setShowMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionAnchor, setMentionAnchor] = useState<MentionAnchor | null>(null)
  const mentionInputRef = useRef<HTMLInputElement>(null)
  /** 中文输入法组合态：组合中不触发 @ 检测，避免拼音上屏中途错位。 */
  const composingRef = useRef(false)

  /**
   * 便利贴额外提供的两类根类别。
   *
   * 「草稿」「正文」不在 getAllMentionTargets 的静态列表里 —— 那份是给助手的，
   * 而助手**没有读草稿的工具**，摆在那儿等于给作者一个点了没用的项。
   * 所以由这里按需补进去，只出现在便利贴的 @ 菜单里。
   */
  const extraRootTargets = useMemo<MentionTarget[]>(() => {
    const t = useLocaleStore.getState().text
    return [
      { type: 'draft', displayName: t('草稿', 'Drafts'), value: 'sticky_drafts' },
      { type: 'manuscript', displayName: t('正文', 'Manuscript'), value: 'sticky_manuscripts' },
    ]
  }, [locale])

  /** 这次抽卡要追加进哪张便利贴：优先「当前打开的那一张」。 */
  const activeNote = useMemo(() => {
    const activeTab = tabs.find(tab => tab.id === activeTabId)
    const activeNoteId = activeTab?.type === 'sticky-note'
      ? stickyNoteIdFromTabPath(activeTab.filePath)
      : null
    return notes.find(note => note.noteId === activeNoteId) ?? notes[notes.length - 1] ?? null
  }, [tabs, activeTabId, notes])

  /**
   * 关窗**不重置**。
   *
   * 先生：「用户切去其他地方，但这个菜单应该是一直停留在这里等用户的才对。」
   * 原先这里一关就把 stage 清回 setup、牌面清空 —— 那等于把等了几分钟的结果
   * 顺手丢掉。现在关掉只是把视图收起来，结果原样留着，再打开还能接着挑。
   */

  const toggleInclude = (key: IncludeKey) => {
    setInclude(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const handleMentionChange = (value: string) => {
    if (composingRef.current) return
    const atIndex = value.lastIndexOf('@')
    if (atIndex < 0) {
      setShowMention(false)
      setMentionQuery('')
      return
    }
    const rect = mentionInputRef.current?.getBoundingClientRect()
    if (rect && typeof window !== 'undefined') {
      setMentionAnchor({
        left: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
      })
    }
    setMentionQuery(value.slice(atIndex + 1))
    setShowMention(true)
  }

  const handleMentionSelect = (target: MentionTarget) => {
    setShowMention(false)
    setMentionQuery('')
    if (mentionInputRef.current) mentionInputRef.current.value = ''
    if (!(STICKY_MENTION_TYPES as readonly string[]).includes(target.type)) {
      toast.info(text(
        '便利贴只引用角色、设定集、章节蓝图，以及具体的草稿 / 正文。',
        'Notes can reference characters, settings, blueprints, and specific drafts or manuscript chapters.',
      ))
      return
    }
    const next: StickyMentionRef = {
      type: target.type as StickyMentionType,
      name: target.displayName,
      // 草稿 / 正文要靠这个稳定 id 定位到具体那一稿；其余三类用不到，带上也无妨。
      value: target.value,
    }
    setMentions(prev => (prev.some(item => (
      item.type === next.type && item.name === next.name
    ))
      ? prev
      : [...prev, next]))
  }

  /** 确保有一张便利贴可追加；一张都没有就先建一张。 */
  const ensureTargetNote = async (): Promise<StickyNote | null> => {
    if (activeNote) return activeNote
    const created = await useStickyNoteStore.getState().createNote('')
    if (!created) {
      toast.error(text('新建便利贴失败，无法开始抽卡', 'Could not create a note to draw into.'))
      return null
    }
    return created
  }

  const startDraw = async () => {
    if (busy) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    if (!defaultModelId) {
      toast.error(text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
      return
    }
    const target = await ensureTargetNote()
    if (!target || !isProjectSessionCurrent(projectSession)) return

    const requested = Math.min(Math.max(Math.floor(count) || 1, 1), STICKY_DRAW_MAX_COUNT)
    setCount(requested)
    setBusy(true)
    // 进 drawing 态并把目标便利贴记在 store 里 —— 哪怕本组件随后被卸载，进度也还在。
    useStickyDrawStore.getState().beginDraw(target.noteId)
    /** 执行器返回值放在闭包里供完成回调解析 —— definition 是普通对象，闭包足够。 */
    let rawResult = ''

    try {
      const { DrawInspirationCommand } = await import('../../services/workflows/commands/draw-inspiration.command')
      const request = {
        includePremise: include.premise,
        includeCharacters: include.characters,
        includeWorldbuilding: include.worldbuilding,
        includeSynopsis: include.synopsis,
        mentions,
        idea,
        count: requested,
      }
      await useWorkflowStore.getState().startWorkflow({
        type: 'inspiration_draw',
        title: text('便利贴 · AI 灵感', 'Sticky note · AI ideas'),
        projectPath: projectSession.projectPath,
        projectSession,
        uiLocale: locale,
        steps: [{
          name: text('攒灵感', 'Draft ideas'),
          description: text(
            '按你勾选的底稿与写下的想法，给出几条彼此不同的构思方向',
            'Produce several distinct directions from the material you included',
          ),
          executor: async (step, context, callbacks) => {
            const command = new DrawInspirationCommand(request)
            const raw = await command.execute({ step, context, callbacks })
            rawResult = raw
            return raw
          },
        }],
        onComplete: {
          // 必须是 'open' —— workflow-store 只在 mode === 'open' 时调用 openResult。
          mode: 'open',
          openResult: () => {
            /**
             * 结果到了。这里**绝不静默返回**。
             *
             * 先生花了几分钟和 token 换来的东西，哪怕只剩一行提示也必须让他看见 ——
             * 静默正是「白跑一趟」的来源（原先这两处 return 都不出声，于是
             * 「生成了却没有牌面」根本查不出是哪一环出的事）。
             */
            if (!isProjectSessionCurrent(projectSession)) {
              useStickyDrawStore.getState().clearResult()
              toast.error(text(
                '抽卡期间项目已切换，这次的结果没有落到任何便利贴上（避免写进别的书）。',
                'The project changed while drawing, so this result was not written anywhere.',
              ))
              return
            }
            const parsed = parseInspirationCards(rawResult, requested)
            if (parsed.length === 0) {
              useStickyDrawStore.getState().backToSetup()
              toast.error(text(
                `模型这一轮没给出可用的点子（返回 ${rawResult.length} 字）。可以再试一次，或把想法写具体些。`,
                `The model returned no usable ideas this time (${rawResult.length} chars). Try again or make your idea more specific.`,
              ))
              return
            }
            /**
             * 亮牌 —— **写进 store**，与本组件是否还活着无关。
             *
             * 先生切去别的面板时，便利贴编辑器连同这个弹窗一起被卸载；
             * 只要结果落在 store 里，他切回来照样能看见那排牌面。
             * （showResult 默认全选：作者多半都要，想舍掉的再点掉更快。）
             */
            const wasOpen = useStickyDrawStore.getState().open
            useStickyDrawStore.getState().showResult(parsed)
            /**
             * 结果回来时窗口若正收着，必须出声喊一声。
             *
             * 牌面已经躺在 store 里了，但「牌在 store 里」先生是看不见的：
             * 便利贴编辑器被卸载时，连渲染这排牌的组件都不在。等了几分钟和
             * 一肚子 token 换来的东西，至少要让他知道去哪儿拿。
             */
            if (!wasOpen) {
              toast.info(text(
                `已抽到 ${parsed.length} 条灵感 —— 回到便利贴，点顶栏「AI 灵感」就能挑。`,
                `${parsed.length} ideas are ready — open the note and tap “AI ideas” to pick them.`,
              ))
            }
          },
        },
      })
    } catch (error) {
      useStickyDrawStore.getState().backToSetup()
      toast.error(text(`抽卡失败：${error}`, `Draw failed: ${error}`))
    } finally {
      /**
       * busy 必须在这里统一收口。
       *
       * 原先只在 catch 与 openResult 里各收一次 —— openResult 一旦因为
       * 「项目已切换」提前 return，busy 就永远卡在 true，按钮再也点不动。
       */
      setBusy(false)
    }
  }

  /**
   * 确认：选中的按**从左到右**依次追加进便利贴，没选的进待选箱。
   *
   * 追加顺序就是 cards 的原始次序（filter 不改变相对顺序），
   * 也就是先生看到的那排卡片从左到右的样子。
   */
  /**
   * 确认：选中的按**从左到右**依次追加进便利贴，没选的进待选箱。
   *
   * ⚠️ `chosenIndexes` **必须由调用方显式传进来，绝不能读组件的 selected 状态**。
   * 「都不要，存进待选箱」那颗按钮是先 setSelected(new Set()) 再调这里，而 setState
   * 是异步的 —— 读状态会读到旧的「全选」，于是「都不要」反过来把每一条都贴进了正文。
   * 先生就是这么撞上的：明明点了都不要，结果全给他贴出来了。
   */
  const confirmSelection = async (chosenIndexes: ReadonlySet<number>) => {
    if (busy) return
    const chosen = cards.filter((_, index) => chosenIndexes.has(index))
    const rejected = cards.filter((_, index) => !chosenIndexes.has(index))
    if (chosen.length === 0 && rejected.length === 0) {
      useStickyDrawStore.getState().closeDialog()
      return
    }

    setBusy(true)
    try {
      // 先落一条抽卡存档：待选箱里的卡日后要靠它回答「当初是在什么前提下抽的」。
      const draw = await useStickyNoteStore.getState().recordDraw({
        includePremise: include.premise,
        includeCharacters: include.characters,
        includeWorldbuilding: include.worldbuilding,
        includeSynopsis: include.synopsis,
        mentions,
        idea,
        requestedCount: count,
      })

      if (chosen.length > 0) {
        // 只有真要追加时才去建便利贴 —— 「都不要」不该顺手在侧栏里多出一张空本子。
        const target = await ensureTargetNote()
        if (!target) return
        /**
         * 追加时刻只取一次：既交给 appendIdeas 落库，也用来算「这次新增的那几段」。
         * 两处必须是同一个时刻，否则同步进编辑器的那一份会和库里差一个来源行。
         */
        const at = new Date().toISOString()
        const requests = chosen.map(card => ({
          idea: card,
          drawId: draw?.drawId ?? null,
          mentions,
          at,
        }))
        const updated = await useStickyNoteStore.getState().appendIdeas(target.noteId, requests)
        if (!updated) {
          toast.error(text('追加失败，点子没有写进便利贴', 'Could not append the ideas to the note.'))
          return
        }
        // 用同一批请求再算一遍，得到这次新增段落的原文，供编辑器按需合并。
        const appendedBlocks = requests
          .map(request => composeStickyIdeaBlock({ idea: request.idea, at, mentions }))
          .filter(Boolean)
        syncEditorAfterAppend(updated, appendedBlocks)
      }

      if (rejected.length > 0) {
        if (!draw) {
          toast.error(text(
            '抽卡记录保存失败，落选的点子没能进待选箱',
            'The draw record could not be saved, so the unselected ideas were not kept.',
          ))
        } else {
          await useStickyNoteStore.getState().recordCandidates(draw.drawId, rejected)
        }
      }

      toast.success(text(
        chosen.length > 0
          ? `已追加 ${chosen.length} 条灵感${rejected.length > 0 ? `，${rejected.length} 条进了待选箱` : ''}`
          : `${rejected.length} 条灵感已放进待选箱`,
        chosen.length > 0
          ? `Added ${chosen.length} idea${chosen.length > 1 ? 's' : ''}${rejected.length > 0 ? `; ${rejected.length} kept in the tray` : ''}`
          : `${rejected.length} idea${rejected.length > 1 ? 's' : ''} kept in the tray`,
      ))
      // 这一轮已经落库落箱，把牌面收干净；关窗只是收视图。
      useStickyDrawStore.getState().clearResult()
      useStickyDrawStore.getState().closeDialog()
    } finally {
      setBusy(false)
    }
  }

  const selectedCount = selected.size

  /**
   * 牌阵分行：一排最多 5 张，超过 5 张就分两行、上下尽量均分。
   * 每行渲染时各自居中 —— 于是 1 到 10 张都是左右对称的：
   * 6→3+3、7→4+3、8→4+4、9→5+4、10→5+5。
   */
  const cardRows = useMemo(() => {
    const indices = cards.map((_, index) => index)
    if (indices.length <= 5) return [indices]
    const topCount = Math.ceil(indices.length / 2)
    return [indices.slice(0, topCount), indices.slice(topCount)]
  }, [cards])

  return (
    <Dialog
      open={open}
      /**
       * **非模态**（先生 2026-09-20 报的三连症：@ 点不着、滚轮失效、搜索框进不去输入）。
       *
       * 模态弹窗会做三件事，而它们**全都只保护弹窗自己那棵子树**：
       *   · 把焦点锁在弹窗内容里（FocusScope）——@ 菜单的搜索框 autoFocus 立刻被抢回去，
       *     于是「输入不进去、也不过滤」；
       *   · 给 `<body>` 设 `pointer-events: none` —— 菜单在 body 下，鼠标整个穿透；
       *   · 锁背景滚动（react-remove-scroll）—— 菜单不是它的滚动容器，滚轮被拦。
       *
       * 我们的 @ 菜单是 Portal 到 body 的、正好在弹窗内容之外，三样一个不落全中。
       * 切成非模态后这些枷锁都不再加，菜单恢复成一个普通的浮层。
       * 「点蒙版不许关闭」照旧由下面的 onPointerDownOutside 兜住，与模态无关。
       */
      modal={false}
      onOpenChange={value => { if (!value) useStickyDrawStore.getState().closeDialog() }}
    >
      <DialogContent
        className={stage === 'result' ? 'max-w-[860px]' : 'max-w-[560px]'}
        /**
         * 装「填到一半的参数」或「AI 生成结果」的弹窗一律不许点蒙版关闭 ——
         * 先生定的规矩：等了几分钟才有的候选，手一抖点蒙版就没了（见
         * modal-dismiss-safety.test.ts 的名单与理由）。
         */
        onPointerDownOutside={(event) => event.preventDefault()}
        /**
         * 失焦同样不许关 —— 这条是 2026-09-21 补的，先生撞的就是它。
         *
         * Radix 的 DismissableLayer 把「点到外面」分成两路：pointerdown 与 focus。
         * 上面那行只挡住了指针那一半；而 `focusin` 落到本层 React 树之外时，
         * 它照样会调 onDismiss 把弹窗关掉（见 @radix-ui/react-dismissable-layer
         * 的 useFocusOutside：`if (!event.defaultPrevented) onDismiss?.()`）。
         *
         * 为什么偏偏在「开始抽卡」那一刻炸：先生按下那颗按钮，焦点就在它身上；
         * 一进 drawing 态，setup 那一屏连同按钮整块卸载，焦点掉回 <body> ——
         * 于是 Radix 判定「作者点到外面去了」，自己把弹窗收了起来。
         * 先生看到的就是「点完抽卡，窗口整个不见了」，而工作流还在后台跑，
         * 几十秒后结果回来时，牌面已经没有一个窗口能承接。
         *
         * 这里与「点蒙版不关」同一条规矩：只认明确的关闭动作（X、取消、放到后台）。
         */
        onFocusOutside={(event) => event.preventDefault()}
      >
        {/*
          子菜单标头统一走 PageHead（先生定的规矩，见 NewProjectDialog 的注释）：
          朱砂小字眉标 → 衬线标题 → 次要色说明。DialogTitle 退回 sr-only，
          只为保住无障碍名称 —— 视觉上由 PageHead 全权呈现。
          标题随阶段换：填表时是「AI 灵感」，出牌后是「灵感选取」。
        */}
        <DialogHeader className="app-dialog-head">
          <DialogTitle className="sr-only">
            {stage === 'result' ? text('灵感选取', 'Pick ideas') : text('AI 灵感', 'AI ideas')}
          </DialogTitle>
          <PageHead
            kicker={stage === 'result'
              ? text('INSPIRATION · 灵感选取', 'INSPIRATION · PICK')
              : text('INSPIRATION · AI 灵感', 'INSPIRATION')}
            title={stage === 'result'
              ? text('灵感选取', 'Pick ideas')
              : text('AI 灵感', 'AI ideas')}
            description={stage === 'result'
              ? text(
                  '点一张牌即选中；选中的按牌面次序追加进便利贴，没选的留在待选箱里随时找回。',
                  'Tap a card to select it; selected cards are appended to your note in order, the rest wait in the tray.',
                )
              : text(
                  '勾选让哪些底稿参与、写下自己的想法，再定抽几张；这里只攒点子，不会写进正文。',
                  'Include the background you want, write your own idea, and choose how many cards to draw. This only drafts ideas — it never touches your manuscript.',
                )}
          />
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {stage === 'setup' && (
            <>
              {/*
                写作 Skill —— 先生 2026-09-20：「在标题下方，和审稿、修稿一样，
                加入一个写作 Skill / 不启用 / 会随本次提示词一起交给模型 这样的选择。」
                直接复用审稿修稿那颗气泡（stage="planning"），作者可以拿它给灵感池
                加约束（比如「只从人物动机出发」「不要超自然元素」）。
                绑定在项目里，工作流**启动时冻结**，所以这里改了当次就生效。
              */}
              <section>
                <WritingSkillBubble stage="planning" />
              </section>

              {/* 目标便利贴：先生要的是「追加进当前便利贴」，所以这里要写清楚加到哪本 */}
              <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {text('追加到：', 'Appending to: ')}
                <span style={{ color: 'var(--color-text)' }}>
                  {activeNote
                    ? (activeNote.title.trim() || text('未命名便利贴', 'Untitled note'))
                    : text('（会自动新建一张便利贴）', '(a new note will be created)')}
                </span>
              </div>

              {/* ① 引用框：四个勾选框 + @ 引用 */}
              <section className="space-y-2">
                <div className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  {text('让哪些底稿参与这次抽卡', 'What to include in this draw')}
                </div>
                {/* 先生：4 个小的勾选框、左右两个排成两列 —— 就是 2×2。 */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  {STICKY_ARCH_FILES.map(file => (
                    <label
                      key={file.key}
                      className="flex items-center gap-1.5 text-xs cursor-pointer select-none"
                      style={{ color: 'var(--color-text)' }}
                    >
                      <input
                        type="checkbox"
                        checked={include[file.key as IncludeKey]}
                        onChange={() => toggleInclude(file.key as IncludeKey)}
                      />
                      {text(file.zh, file.en)}
                    </label>
                  ))}
                </div>

                <div className="relative">
                  <div
                    className="flex flex-wrap items-center gap-1.5"
                    onClick={() => mentionInputRef.current?.focus()}
                    style={{
                      minHeight: 36,
                      maxHeight: 160,
                      overflowY: 'auto',
                      padding: '6px 8px',
                      border: '1px solid var(--color-border)',
                      borderRadius: frameRadius,
                      backgroundColor: 'var(--color-panel)',
                    }}
                  >
                    {mentions.map(item => (
                      <span
                        key={`${item.type}:${item.name}`}
                        className="inline-flex items-center gap-1 text-[11px]"
                        style={{
                          padding: '2px 6px',
                          borderRadius: chipRadius,
                          backgroundColor: 'var(--color-hover)',
                          color: 'var(--color-text)',
                        }}
                      >
                        {item.name}
                        <button
                          type="button"
                          aria-label={text('移除引用', 'Remove reference')}
                          onClick={(event) => {
                            event.stopPropagation()
                            setMentions(prev => prev.filter(other => (
                              !(other.type === item.type && other.name === item.name)
                            )))
                          }}
                          style={{ color: 'var(--color-text-muted)' }}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    ))}
                    <input
                      ref={mentionInputRef}
                      className="flex-1 bg-transparent border-0 outline-none text-xs"
                      style={{ minWidth: 120, color: 'var(--color-text)' }}
                      placeholder={text('输入 @ 引用角色、设定集、章节蓝图…', 'Type @ to reference characters, settings, blueprints…')}
                      onCompositionStart={() => { composingRef.current = true }}
                      onCompositionEnd={() => { composingRef.current = false }}
                      onChange={event => handleMentionChange(event.target.value)}
                      onKeyDown={event => {
                        if (showMention) return
                        if (event.key === 'Enter') event.preventDefault()
                      }}
                    />
                  </div>
                  {showMention && (
                    <MentionMenu
                      query={mentionQuery}
                      anchor={mentionAnchor}
                      onSelect={handleMentionSelect}
                      onClose={() => setShowMention(false)}
                      // 先生说：其他引用不了的类别，别出现在这个菜单里。
                      allowedTypes={STICKY_MENTION_TYPES}
                      extraRootTargets={extraRootTargets}
                    />
                  )}
                </div>
              </section>

              {/* ② 构思想法 */}
              <section>
                <div className="text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {text('你自己的构思想法', 'Your own idea')}
                </div>
                <Textarea
                  value={idea}
                  rows={4}
                  placeholder={text(
                    '随便写 —— 想试的方向、卡住的地方、忽然冒出来的一个画面…',
                    'Anything — a direction to try, where you are stuck, an image that just came to you…',
                  )}
                  onChange={event => setIdea(event.target.value)}
                />
              </section>

              {/* ③ 抽卡数目 */}
              <section>
                <div className="text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {text('这次抽几张', 'How many ideas')}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={STICKY_DRAW_MAX_COUNT}
                    value={count}
                    style={{ width: 72 }}
                    onChange={event => {
                      const next = Number(event.target.value)
                      setCount(Number.isFinite(next) ? next : STICKY_DRAW_DEFAULT_COUNT)
                    }}
                    onBlur={() => {
                      const clamped = Math.min(Math.max(Math.floor(count) || 1, 1), STICKY_DRAW_MAX_COUNT)
                      setCount(clamped)
                    }}
                  />
                  <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                    {text(
                      `最多 ${STICKY_DRAW_MAX_COUNT} 张；建议 5 张以内，多了容易撞车。`,
                      `Up to ${STICKY_DRAW_MAX_COUNT}; five or fewer usually reads better.`,
                    )}
                  </span>
                </div>
              </section>
            </>
          )}

          {stage !== 'setup' && (
            <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {text('追加到：', 'Appending to: ')}
              <span style={{ color: 'var(--color-text)' }}>
                {activeNote
                  ? (activeNote.title.trim() || text('未命名便利贴', 'Untitled note'))
                  : text('（会自动新建一张便利贴）', '(a new note will be created)')}
              </span>
            </div>
          )}

          {stage === 'drawing' && (
            <div
              className="flex flex-col items-center gap-1.5 text-xs py-6"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <span className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                {text('正在攒灵感…可以关掉这个窗口先去忙', 'Drafting ideas… you can close this window.')}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
                {text(
                  '出牌时这张窗口会自己回来；若切去了其他页面，回到便利贴就能看到。',
                  'This window returns by itself when the cards are ready; if you switched away, come back to the note.',
                )}
              </span>
            </div>
          )}

          {stage === 'result' && (
            <section className="flex flex-col items-center">
              <div
                className="text-xs font-medium mb-3 text-center"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                {text(
                  `抽到 ${cards.length} 条 —— 点一张牌即选中；选中的按牌面次序追加`,
                  `${cards.length} ideas — tap a card to select; selected ones are appended in card order`,
                )}
              </div>

              {/*
                牌阵（先生 2026-09-20 定的摆法）：
                  · 一排最多 5 张；
                  · 1–5 张排一行，6–10 张分两行（上下尽量均分）；
                  · **每一行各自居中** —— 于是 1 到 10 张都是左右对称的：
                    1 张正中；2/3/4/5 张一行居中；6 张 3+3；7 张 4+3；
                    8 张 4+4；9 张 5+4；10 张 5+5。
              */}
              <div className="flex flex-col items-center" style={{ gap: STICKY_CARD_GAP }}>
                {cardRows.map((row, rowIndex) => (
                  <div
                    key={rowIndex}
                    className="flex justify-center"
                    style={{ gap: STICKY_CARD_GAP }}
                  >
                    {row.map((index) => {
                      const card = cards[index]
                      const isOn = selected.has(index)
                      return (
                        <button
                          key={`${index}:${card.slice(0, 12)}`}
                          type="button"
                          onClick={() => toggleCard(index)}
                          className="flex flex-col text-left flex-shrink-0"
                          style={{
                            width: STICKY_CARD_WIDTH,
                            height: STICKY_CARD_HEIGHT,
                            padding: '10px 11px',
                            border: `1px solid ${isOn ? 'var(--color-accent)' : 'var(--color-border)'}`,
                            borderRadius: frameRadius,
                            backgroundColor: isOn ? 'var(--color-hover)' : 'var(--color-panel)',
                            // 选中的牌再多一圈内描边：远看也认得出哪几张进了本子
                            boxShadow: isOn ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
                            opacity: isOn ? 1 : 0.72,
                            transition: 'opacity 160ms ease, border-color 160ms ease',
                            overflow: 'hidden',
                          }}
                          title={isOn
                            ? text('点击取消选择', 'Click to deselect')
                            : text('点击选中', 'Click to select')}
                        >
                          {/* 牌头：罗马式序号 + 勾选标记 */}
                          <span
                            className="flex items-center justify-between flex-shrink-0 mb-2 text-[10px]"
                            style={{ color: 'var(--color-text-muted)', letterSpacing: '0.1em' }}
                          >
                            <span>{text(`第 ${index + 1} 张`, `NO.${String(index + 1).padStart(2, '0')}`)}</span>
                            <span
                              className="inline-flex items-center justify-center"
                              style={{
                                width: 13,
                                height: 13,
                                borderRadius: 2,
                                border: `1px solid ${isOn ? 'var(--color-accent)' : 'var(--color-border)'}`,
                                backgroundColor: isOn ? 'var(--color-accent)' : 'transparent',
                                color: 'var(--color-accent-foreground, #fff)',
                              }}
                            >
                              {isOn && <Check size={9} />}
                            </span>
                          </span>
                          {/* 牌面正文：长点子在本张牌内滚动，不撑破牌形 */}
                          <span
                            className="flex-1 overflow-y-auto text-xs whitespace-pre-wrap"
                            style={{ color: 'var(--color-text)', lineHeight: 1.75 }}
                          >
                            {card}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* 先生：出牌之后，两个按钮摆在牌阵下方的正中（X 轴居中、Y 轴靠下）。 */}
        <DialogFooter className={stage === 'result'
          ? 'sm:justify-center items-center'
          : 'sm:justify-between items-center'}>
          {stage === 'setup' && (
            <span className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              {text('抽卡不会写进正文，AI 写作时也读不到便利贴', 'Drawing never touches your manuscript, and AI writing never reads notes')}
            </span>
          )}
          <div className="flex items-center gap-2">
            {stage === 'result' ? (
              <>
                {/*
                  「都不要」不是「扔掉」：先生定的是未选中的进待选箱（避免日后后悔），
                  所以它等于「全不选」—— 全部存进箱子，随时还能找回来。
                */}
                <Button
                  variant="outline"
                  onClick={() => {
                    // 显式传一个空集：追加的是「没有选中任何一张」，全部落进待选箱。
                    void confirmSelection(new Set())
                  }}
                  disabled={busy || selectedCount === 0}
                  title={text(
                    '一张都不追加，全部留在待选箱里（还能找回）',
                    'Append none; keep them all in the tray (they can be recalled)',
                  )}
                >
                  {text('都不要，存进待选箱', 'Keep all in the tray')}
                </Button>
                <Button
                  variant="ai"
                  size="lg"
                  onClick={() => { void confirmSelection(selected) }}
                  disabled={busy || selectedCount === 0}
                >
                  {text(`追加选中的 ${selectedCount} 条`, `Add ${selectedCount} selected`)}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => useStickyDrawStore.getState().closeDialog()}>
                  {stage === 'drawing' ? text('放到后台', 'Keep running') : text('取消', 'Cancel')}
                </Button>
                <Button
                  variant="ai"
                  size="lg"
                  onClick={() => { void startDraw() }}
                  disabled={busy || stage === 'drawing'}
                >
                  <Sparkles size={13} />
                  {text('开始抽卡', 'Start drawing')}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * 追加成功后，把新内容同步进已经打开的便利贴编辑器。
 *
 * 两种情况，**都不能把作者手里的字弄丢**：
 *   · 标签是干净的 → 整份替换并标记已保存（库里那份就是最新的）；
 *   · 标签有未保存改动 → 把这次新增的段落**接在他当前内容后面**，并保持 dirty，
 *     由他自己决定何时保存。段落之间照旧空一行，接上去是自然分段。
 *
 * 早先这里在第二种情况直接 `return` —— 那等于把刚抽到的点子吞了，
 * 先生看到的就是「AI 生成的内容没加进我打开的便利贴」。作者在写，
 * 要保护的是**他的字**，不是「那就不给他看新内容」。
 */
function syncEditorAfterAppend(note: StickyNote, appendedBlocks: readonly string[]): void {
  const editor = useEditorStore.getState()
  const tab = editor.tabs.find(item => (
    item.type === 'sticky-note'
    && stickyNoteIdFromTabPath(item.filePath) === note.noteId
  ))
  if (!tab) return
  if (!tab.dirty) {
    editor.syncTabContent(tab.id, note.body)
    editor.markTabSaved(tab.id, note.body)
    return
  }
  // 作者手里还有没保存的改动：只把新段落接上去，绝不覆盖他正在写的东西。
  editor.updateTabContent(tab.id, mergeStickyAppendedBlocks(tab.content ?? '', appendedBlocks))
}
