/**
 * WorldSettingEditor — 世界观设定（正文栏）
 *
 * 信息架构（照章节蓝图）：侧栏选分类 → 这里看该分类的条目目录 → 点条目进入单条页面。
 * 排版规格（照人物档案 CharacterEditor）：**先阅读态、后编辑态**，两态共用页头与容器。
 *
 *   · 阅读态：archive-grid 字段网格 + archive-section 分节展示（衬线正文、首字下沉）
 *   · 编辑态：archive-editbar + archive-edit-field 表单
 *   · 待确认队列：同页头同宽度，每行给出「采纳 / 忽略」
 *
 * 按钮按人物档案定下的规矩：primary 只留给「进入动作」（编辑条目 / 新建条目），
 * 保存用 outline，取消用 ghost，AI 动作用 ai，删除用 outline + 红字。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowUpDown, AtSign, Check, Compass, Grid2x2, Grid3x3, List, ListTree, PenLine, Plus, Save, Sparkles, Trash2, X } from 'lucide-react'

import PagePlate from '../layout/v2/magazine/PagePlate'
import { PlateFigure, PlateTicks } from '../layout/v2/magazine/PlateFigures'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import WorldSettingCandidateDialog from './WorldSettingCandidateDialog'
import WorldSettingChapterRefDialog from './WorldSettingChapterRefDialog'
import { captureProjectSession, isProjectSessionCurrent } from '../project-session-gate'
import type { WorldSettingCandidate } from '../../services/workflows/commands/generate-world-setting.command'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { useWorldSettingStore } from '../../stores/world-setting-store'
import type { CatalogLayout, CatalogSort } from '../../stores/world-setting-store'
import { formatDbTimestamp } from '../../utils/time'
import { useAgentStore } from '../../stores/agent-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import { useLLMStore } from '../../stores/llm-store'
import {
  WORLD_SETTING_IMPORTANCE,
  getWorldSettingCategoryDescription,
  getWorldSettingCategoryLabels,
  getWorldSettingImportanceLabels,
} from '../../shared/world-setting'
import type {
  WorldSettingCategory,
  WorldSettingDraft,
  WorldSettingImportance,
} from '../../shared/world-setting'

/** 与其它子菜单同一套容器：1024 居中 + 左右 32px。 */
const PAGE_STYLE = { maxWidth: 1024, margin: '0 auto', padding: '0 32px 46px' } as const
/** 并排字段留 10px 缝隙（先生：紧贴不好看）。 */
const GRID_STYLE = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 16 } as const

/** 排列风格的三态循环顺序：两列 → 四列 → 列表 → 两列。 */
const CATALOG_LAYOUT_ORDER: CatalogLayout[] = ['grid2', 'grid4', 'list']

const NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

interface FormState {
  name: string
  category: WorldSettingCategory
  importance: WorldSettingImportance
  aliases: string
  summary: string
  content: string
  tags: string
}

const EMPTY_FORM: FormState = {
  name: '',
  category: 'world',
  importance: 'side',
  aliases: '',
  summary: '',
  content: '',
  tags: '',
}

/** 别名 / 标签一律按「顿号、逗号、换行」切分，作者怎么写都能认。 */
function splitList(value: string): string[] {
  return value.split(/[,，、\n]/).map(item => item.trim()).filter(Boolean)
}

/**
 * 编辑态字段：**沿用章节蓝图的 .fld / .fh / .fn 结构**。
 *
 * 先生要求小标题与「章节标题」「末尾悬念钩子」完全一致（字号、字体、间距），
 * 所以这里直接用同一套类名，而不是自己写一套 —— 以后调主题两处一起变。
 */
function EditField({ label, children, big }: { label: string; children: ReactNode; big?: boolean }) {
  return (
    <div className="fld" style={big ? { marginBottom: 14 } : undefined}>
      <div className="fh">
        <span className="fn">{label}</span>
      </div>
      {children}
    </div>
  )
}

/** 阅读态字段：沿用人物档案的 .archive-item（朱砂小标 + 衬线值）。 */
function ReadItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="archive-item">
      <b>{label}</b>
      <span>{value || '—'}</span>
    </div>
  )
}

export default function WorldSettingEditor() {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const currentProject = useProjectStore(s => s.currentProject)
  const entries = useWorldSettingStore(s => s.entries)
  const selectedId = useWorldSettingStore(s => s.selectedId)
  const activeCategory = useWorldSettingStore(s => s.activeCategory)
  /** 分类表（内置 + 作者自建）：下拉与所有分类名都从它取，不再依赖编译期常量。 */
  const categories = useWorldSettingStore(s => s.categories)
  const save = useWorldSettingStore(s => s.save)
  const remove = useWorldSettingStore(s => s.remove)
  const select = useWorldSettingStore(s => s.select)
  const setStatus = useWorldSettingStore(s => s.setStatus)
  const showPendingQueue = useWorldSettingStore(s => s.showPendingQueue)
  const setShowPendingQueue = useWorldSettingStore(s => s.setShowPendingQueue)
  const catalogLayout = useWorldSettingStore(s => s.catalogLayout)
  const catalogSort = useWorldSettingStore(s => s.catalogSort)
  const setCatalogLayout = useWorldSettingStore(s => s.setCatalogLayout)
  const setCatalogSort = useWorldSettingStore(s => s.setCatalogSort)
  const addPendingMention = useAgentStore(s => s.addPendingMention)
  const setAIPanelOpen = useLayoutStore(s => s.setAIPanelOpen)

  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  /** 生成出来的候选，等作者在预览里勾选。 */
  const [candidates, setCandidates] = useState<WorldSettingCandidate[]>([])
  const [showCandidates, setShowCandidates] = useState(false)
  /** 引用到章节的弹窗（先生：条目页也要能 @ 章节蓝图）。 */
  const [showChapterRef, setShowChapterRef] = useState(false)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  /**
   * 是否已有「配置生成」类任务在跑。
   *
   * 蓝汐刻意不自己维护 busy 标志：工作流一结束 activeRuns 就会变，
   * 按钮状态自动跟着回来，不会出现「任务早结束了按钮还转着」。
   */
  const generatingCandidates = useWorkflowStore(s => s.activeRuns.some(run => run.type === 'config_generation'))
  /** 目录态与「新建」共用 selectedId === null，靠这一位区分两者。 */
  const [isCreating, setIsCreating] = useState(false)
  /**
   * 单条页面的两种态：先阅读、后编辑（与人物档案同节奏）。
   * 新建条目直接落到编辑态。
   */
  const [viewMode, setViewMode] = useState<'read' | 'edit'>('read')

  const selected = useMemo(
    () => (selectedId === null ? null : entries.find(entry => entry.id === selectedId) ?? null),
    [entries, selectedId],
  )

  /**
   * 当前分类下的条目 —— **包含待确认候选**。
   *
   * 曾经把 pending 排除在外，理由是「它们还没被采纳」。但 AI 归纳出来的新设定
   * （定稿后处理自动沉淀的那种）只会落到 pending：作者在自己的分类栏目里一条都
   * 看不到，只会以为「AI 生成的内容没进来」。现在它们直接出现在该在的栏目里，
   * 用「待确认」标记与已采纳条目区分；**写作链路仍然只认 confirmed**。
   */
  const categoryEntries = useMemo(
    () => entries.filter(entry => entry.category === activeCategory),
    [entries, activeCategory],
  )

  /**
   * 目录的展示顺序（先生的排序下拉）：
   * 按时间 = 最近更新的在前；按名称 = 拼音 / 字母序。
   */
  const catalogEntries = useMemo(() => {
    const list = [...categoryEntries]
    if (catalogSort === 'name') {
      list.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name))
    } else {
      list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    }
    return list
  }, [categoryEntries, catalogSort])

  /** 待确认候选：AI 归纳或作者选词标记产生，采纳后才进创作链路。 */
  const pendingEntries = useMemo(
    () => entries.filter(entry => entry.status === 'pending'),
    [entries],
  )

  // 选中项变了就把表单重置成它的内容，并回到阅读态。
  // 表单是受控输入的命令式副本，且必须与 isCreating / viewMode 一起原子归位：
  // 拆成派生值会让「表单已换、模式还没换」的中间态渲染出来（按钮与字段错位）。
  useEffect(() => {
    if (!selected) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 换选中条目时原子重置表单与视图模式（见上）
    setIsCreating(false)
    setViewMode('read')
    setForm({
      name: selected.name,
      category: selected.category,
      importance: selected.importance,
      aliases: selected.aliases.join('、'),
      summary: selected.summary,
      content: selected.content,
      tags: selected.tags.join('、'),
    })
  }, [selected])

  if (!currentProject) {
    return (
      <div className="world-setting-placeholder flex h-full flex-col items-center justify-center gap-3">
        <div className="wsp-mark" aria-hidden="true">
          <Compass size={26} strokeWidth={1.4} />
        </div>
        <div className="wsp-kicker">{text('WORLD · 设定集', 'WORLD · SETTING')}</div>
        <p className="wsp-desc">{text('请先打开项目。', 'Open a project first.')}</p>
      </div>
    )
  }

  const backToCatalog = () => {
    setIsCreating(false)
    setViewMode('read')
    select(null)
    setForm(EMPTY_FORM)
  }

  /** 点击排列按钮：两列 → 四列 → 列表 → 两列。 */
  const cycleCatalogLayout = () => {
    const currentIndex = CATALOG_LAYOUT_ORDER.indexOf(catalogLayout)
    setCatalogLayout(CATALOG_LAYOUT_ORDER[(currentIndex + 1) % CATALOG_LAYOUT_ORDER.length])
  }

  const startCreate = () => {
    select(null)
    setIsCreating(true)
    setViewMode('edit')
    setForm({ ...EMPTY_FORM, category: activeCategory })
  }

  const handleSave = async () => {
    if (!form.name.trim() || busy) return
    setBusy(true)
    const draft: WorldSettingDraft = {
      ...(selected ? { id: selected.id } : {}),
      category: form.category,
      name: form.name.trim(),
      aliases: splitList(form.aliases),
      summary: form.summary.trim(),
      content: form.content,
      tags: splitList(form.tags),
      importance: form.importance,
      related: selected?.related ?? [],
      source: selected?.source ?? 'manual',
    }
    const saved = await save(draft)
    setBusy(false)
    if (saved) {
      setIsCreating(false)
      setViewMode('read')
      toast.success(text('已保存', 'Saved'))
    } else {
      toast.error(text('保存失败，请重试', 'Could not save. Please try again.'))
    }
  }

  const handleDelete = async () => {
    if (!selected) return
    const ok = await confirm(
      text(`删除设定「${selected.name}」？此操作不可撤销。`, `Delete “${selected.name}”? This cannot be undone.`),
      { title: text('删除设定条目', 'Delete entry') },
    )
    if (!ok) return
    setBusy(true)
    const done = await remove(selected.id)
    setBusy(false)
    if (done) {
      toast.success(text('已删除', 'Deleted'))
      backToCatalog()
    } else {
      toast.error(text('删除失败，请重试', 'Could not delete. Please try again.'))
    }
  }

  /**
   * 点「助手」：**只把这条设定攒进引用清单，不发送**。
   *
   * 先生指出的问题：原先这里一点就调 sendMessage，等于"@ 一下就开始对话"，
   * 可作者往往想一次 @ 主角、配角、好几条设定再统一提问 —— 那样后面就没法补了。
   * 现在它只是往输入框上方的引用区加一枚 chip，发送与否由作者在输入框决定。
   */
  const handleAskAssistant = () => {
    const name = selected?.name || form.name.trim()
    if (!name) {
      toast.error(text('先给这条设定起个名字。', 'Give this entry a name first.'))
      return
    }
    addPendingMention({
      type: 'world-setting',
      displayName: name,
      value: name,
      hint: form.summary.trim().slice(0, 24) || undefined,
    })
    setAIPanelOpen(true)
    toast.success(text(
      `已引用「${name}」；可以继续 @ 别的，写完再一起发送`,
      `Referenced “${name}”. @ more if you like, then send when ready.`,
    ))
  }

  /**
   * AI 生成：**作为一次工作流启动**，而不是裸调 LLM。
   *
   * 先生要的两件事，由这一次包装同时满足：
   *   · **任务面板与状态栏胶囊**：startWorkflow 之后进度、步骤名、取消/暂停全部接上，
   *     与其它 AI 任务读的是同一份 activeRuns；
   *   · **AI 输出面板**：命令内部用 callbacks.appendText 流式吐字，而输出面板读的
   *     正是活跃运行的流式文本 —— 作者能实时看见 AI 在分析什么、写什么。
   *
   * 三条规矩不变：分析式、一次不多（≤ 8 条）、先预览再入库（解析与弹窗放在 onComplete）。
   */
  const handleAIGenerate = async () => {
    if (generatingCandidates) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    if (!defaultModelId) {
      toast.error(text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
      return
    }

    const category = categories.find(item => item.key === activeCategory)
    const categoryName = category ? text(category.zhCN, category.enUS) : activeCategory
    /** 执行器的返回值放在闭包里供完成回调解析 —— definition 是普通对象，闭包足够。 */
    let rawResult = ''

    try {
      const { GenerateWorldSettingCandidatesCommand, parseWorldSettingCandidates } = await import(
        '../../services/workflows/commands/generate-world-setting.command'
      )
      await useWorkflowStore.getState().startWorkflow({
        type: 'config_generation',
        title: text(`生成「${categoryName}」设定候选`, `Draft “${categoryName}” setting candidates`),
        projectPath: projectSession.projectPath,
        projectSession,
        uiLocale: locale,
        steps: [{
          name: text('分析并生成候选', 'Analyze and draft candidates'),
          description: text(
            '读取小说配置、故事架构与知识库素材，产出与剧情强相关的设定候选',
            'Read the novel config, architecture and knowledge base, then propose story-relevant entries',
          ),
          executor: async (step, context, callbacks) => {
            const command = new GenerateWorldSettingCandidatesCommand({ categoryKey: activeCategory })
            const raw = await command.execute({ step, context, callbacks })
            rawResult = raw
            return raw
          },
        }],
        onComplete: {
          /**
           * 必须是 'open' —— workflow-store 只在 mode === 'open' 时调用 openResult
           * （see workflow-store.ts 的 `if (mode === 'open' && openResult)`）。
           * 写成 'silent' 会把这段解析与预览一起安静地跳过，作者什么都看不到。
           */
          mode: 'open',
          openResult: () => {
            if (!isProjectSessionCurrent(projectSession)) return
            const parsed = parseWorldSettingCandidates(rawResult, activeCategory)
            if (parsed.length === 0) {
              toast.info(text(
                'AI 没有产出值得立条的设定 —— 这符合「宁缺毋滥」。可以先补些正文或故事架构再试。',
                'The AI found nothing worth an entry, which matches "quality over quantity". Add prose or architecture and try again.',
              ))
              return
            }
            setCandidates(parsed)
            setShowCandidates(true)
          },
        },
      })
    } catch (error) {
      toast.error(text(`生成失败：${error}`, `Generation failed: ${error}`))
    }
  }

  /**
   * 预览确认后写入设定库。
   *
   * 作者是在预览里逐条勾选过的，所以直接按已确认入库（来源标 ai 便于追溯）；
   * 未勾选的候选连库都不进 —— 这正是「先预览再入库」的意义。
   */
  const handleConfirmCandidates = async (selected: WorldSettingCandidate[]) => {
    if (selected.length === 0) return
    setBusy(true)
    let savedCount = 0
    for (const candidate of selected) {
      const saved = await save({
        category: candidate.category || activeCategory,
        name: candidate.name,
        aliases: candidate.aliases,
        summary: candidate.summary,
        content: candidate.content,
        tags: candidate.tags,
        importance: candidate.importance,
        source: 'ai',
        status: 'confirmed',
      })
      if (saved) savedCount += 1
    }
    setBusy(false)
    setShowCandidates(false)
    setCandidates([])
    if (savedCount > 0) toast.success(text(`已写入 ${savedCount} 条设定`, `Added ${savedCount} entries`))
    else toast.error(text('写入失败，请重试', 'Could not save. Please try again.'))
  }

  /**
   * AI 产出落进条目并**立即入库**。
   *
   * 为什么不再像原来那样「只 setForm、等作者自己再点保存」：AI 生成是作者主动
   * 在这个栏目下发起的，生成完只在表单里悄悄变、库里一个字没动，作者回到栏目
   * 只会以为「AI 什么都没生成」。覆盖与否由作者在确认框里定；本条本来就是空的
   * 时候无需询问 —— 没有可失去的东西，直接写库。
   */
  const applyEntrySuggestionAndSave = async (
    suggestion: { summary: string; content: string; aliases: string[]; tags: string[] },
    overwrite: boolean,
  ): Promise<void> => {
    /**
     * 确认框是异步的：作者完全可能在这期间切到别的条目。此时闭包里捕获的
     * selected/form 已经过期，继续写就是把 A 条目的 AI 结果塞进 B 条目。
     */
    if (useWorldSettingStore.getState().selectedId !== (selected?.id ?? null)) {
      toast.info(text(
        '你已经切到别的条目，这次 AI 结果没有写入。回到那条再生成一次即可。',
        'You switched to another entry, so this AI result was not written. Re-run it on that entry.',
      ))
      return
    }
    const pick = (current: string, generated: string) => (
      overwrite || !current.trim() ? generated : current
    )
    const next = {
      ...form,
      summary: pick(form.summary, suggestion.summary),
      content: pick(form.content, suggestion.content),
      aliases: pick(form.aliases, suggestion.aliases.join('、')),
      tags: pick(form.tags, suggestion.tags.join('、')),
    }
    setForm(next)
    setBusy(true)
    const saved = await save({
      ...(selected ? { id: selected.id } : {}),
      category: next.category,
      name: next.name.trim(),
      aliases: splitList(next.aliases),
      summary: next.summary.trim(),
      content: next.content,
      tags: splitList(next.tags),
      importance: next.importance,
      related: selected?.related ?? [],
      // 内容确实出自 AI，即使只是补空字段也照实标记来源。
      source: 'ai',
    })
    setBusy(false)
    if (saved) {
      setIsCreating(false)
      setViewMode('read')
      toast.success(text(
        overwrite ? 'AI 内容已写入并保存到这个条目' : '空白字段已由 AI 补上并保存',
        overwrite ? 'AI content written and saved to this entry' : 'Blanks filled by AI and saved',
      ))
    } else {
      toast.error(text('保存失败，请重试', 'Could not save. Please try again.'))
    }
  }

  /**
   * 条目内的 AI 生成（先生：编辑页也要能一键写完整）。
   *
   * 同样走工作流，所以任务面板与 AI 输出面板一样看得见。
   * 产出直接落库（见 applyEntrySuggestionAndSave）：本条还是空的就零确认写入，
   * 已有内容时由作者选「用 AI 版覆盖」或「只补空白字段」—— 默认仍然不动作者写的字。
   */
  const handleGenerateEntryDraft = async () => {
    if (generatingCandidates || busy) return
    const projectSession = captureProjectSession(currentProject)
    if (!projectSession) return
    if (!defaultModelId) {
      toast.error(text('请先在设置中配置 AI 模型', 'Configure an AI model in Settings first.'))
      return
    }
    const name = form.name.trim()
    if (!name) {
      toast.error(text('先给这条设定起个名字，AI 才有依据。', 'Give this entry a name first so the AI has something to work from.'))
      return
    }

    let rawResult = ''
    try {
      const { GenerateWorldSettingEntryCommand, parseWorldSettingEntrySuggestion } = await import(
        '../../services/workflows/commands/generate-world-setting.command'
      )
      await useWorkflowStore.getState().startWorkflow({
        type: 'config_generation',
        title: text(`补全设定「${name}」`, `Draft entry “${name}”`),
        projectPath: projectSession.projectPath,
        projectSession,
        uiLocale: locale,
        steps: [{
          name: text('补全条目内容', 'Draft entry content'),
          description: text(
            '结合作品设定与同分类条目，补全摘要、详情、别名与标签',
            'Complete summary, details, aliases and tags from the project context',
          ),
          executor: async (step, context, callbacks) => {
            const command = new GenerateWorldSettingEntryCommand({
              categoryKey: form.category,
              name,
              existingSummary: form.summary,
              existingContent: form.content,
            })
            const raw = await command.execute({ step, context, callbacks })
            rawResult = raw
            return raw
          },
        }],
        onComplete: {
          // 必须 'open'：store 只在 mode === 'open' 时调用 openResult。
          mode: 'open',
          openResult: () => {
            if (!isProjectSessionCurrent(projectSession)) return
            const suggestion = parseWorldSettingEntrySuggestion(rawResult)
            if (!suggestion.summary && !suggestion.content) {
              toast.info(text(
                'AI 这次没给出可用内容，补充些信息再试，或自己写更快。',
                'The AI returned nothing usable — add some context, or just write it yourself.',
              ))
              return
            }
            // 本条还是空的：AI 产出就是它该有的内容，直接写库到当前栏目。
            if (!form.summary.trim() && !form.content.trim()) {
              void applyEntrySuggestionAndSave(suggestion, true)
              return
            }
            // 已有作者原文：不能默默覆盖，但也不能默默丢掉 AI 这一版 ——
            // 让作者二选一，两个选项都会继续（没有「什么都不做」的歧义出口）。
            void confirm(
              text(
                '本条已经有你写的内容。\n\n直接用 AI 这一版会覆盖你写的摘要与详情；选「只补空白字段」则保留你的原文，只填入还空着的地方。',
                'This entry already has your own text.\n\nUsing the AI version replaces your summary and details; “Fill blanks only” keeps your text and fills only what is still empty.',
              ),
              {
                title: text('这条已有你自己的内容', 'This entry already has your own text'),
                confirmText: text('用 AI 版覆盖', 'Replace with AI version'),
                cancelText: text('只补空白字段', 'Fill blanks only'),
              },
            ).then(overwrite => applyEntrySuggestionAndSave(suggestion, overwrite))
          },
        },
      })
    } catch (error) {
      toast.error(text(`生成失败：${error}`, `Generation failed: ${error}`))
    }
  }

  const handleAcceptCandidate = async (id: number) => {
    setBusy(true)
    const updated = await setStatus(id, 'confirmed')
    setBusy(false)
    if (updated) toast.success(text('已采纳为设定条目', 'Accepted as an entry'))
    else toast.error(text('采纳失败，请重试', 'Could not accept. Please try again.'))
  }

  const handleIgnoreCandidate = async (id: number) => {
    setBusy(true)
    const done = await remove(id)
    setBusy(false)
    if (done) toast.success(text('已忽略该候选', 'Candidate dismissed'))
    else toast.error(text('操作失败，请重试', 'Could not dismiss. Please try again.'))
  }

  /**
   * 待确认队列（先生认可的形态）：
   * 与目录共用同一套页头与居中宽度，只是每行多了「采纳 / 忽略」。
   * 采纳 = 转正为事实源，此后才进入正文生成与助手上下文；忽略 = 直接删掉。
   */
  if (showPendingQueue) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="pagehead-strip">
          <PagePlate section="world"
            kicker={text('WORLD · 待确认', 'WORLD · PENDING')}
            title={text('待确认候选', 'Pending candidates')}
            description={text(
              'AI 归纳或你标记出的设定候选。采纳后才成为事实源，参与正文生成与助手对话。',
              'Candidates from AI round-ups or your marks. Only accepted entries become canon and join generation.',
            )}
            actions={(
              <button className="btn ghost sm" type="button" onClick={() => setShowPendingQueue(false)} disabled={busy}>
                <ArrowLeft size={11} /> {text('返回目录', 'Back to list')}
              </button>
            )}
          />
        </div>
        <div style={PAGE_STYLE}>
          {pendingEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Compass size={26} strokeWidth={1.4} style={{ color: 'var(--color-text-muted)' }} />
              <p className="text-sm" style={{ color: 'var(--color-text)' }}>
                {text('没有待确认的候选', 'No pending candidates')}
              </p>
              <p className="text-[0.72rem] max-w-[420px] leading-[1.9]" style={{ color: 'var(--color-text-muted)' }}>
                {text(
                  'AI 生成、正文选词标记、定稿归纳产出的候选都会先落到这里，等你逐条过目。',
                  'Candidates from AI generation, inline marks and finalize round-ups all land here for review.',
                )}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {pendingEntries.map(entry => (
                <div className="ws-pending-row" key={entry.id}>
                  <div className="ws-pending-main">
                    <span className="ws-pending-name">
                      {entry.name}
                      <span className="ws-pending-cat">
                        {text(
                          getWorldSettingCategoryLabels(entry.category, categories).zhCN,
                          getWorldSettingCategoryLabels(entry.category, categories).enUS,
                        )}
                      </span>
                    </span>
                    <span className="ws-pending-summary">
                      {entry.summary || entry.content.slice(0, 80) || text('（暂无内容）', '(no content yet)')}
                    </span>
                  </div>
                  <div className="ws-pending-actions">
                    <button
                      className="btn ai sm"
                      type="button"
                      disabled={busy}
                      onClick={() => { void handleAcceptCandidate(entry.id) }}
                    >
                      <Check size={11} /> {text('采纳', 'Accept')}
                    </button>
                    <button
                      className="btn ghost sm"
                      type="button"
                      disabled={busy}
                      onClick={() => { void handleIgnoreCandidate(entry.id) }}
                    >
                      <X size={11} /> {text('忽略', 'Dismiss')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 分类名与说明都查分类表：作者改了名字、加了自建分类，这里立刻跟上。
  const categoryLabels = getWorldSettingCategoryLabels(activeCategory, categories)
  const categoryDescription = getWorldSettingCategoryDescription(activeCategory, categories)
  const isEditing = Boolean(selected) || isCreating
  const inEditMode = isCreating || viewMode === 'edit'
  const LayoutIcon = catalogLayout === 'grid2' ? Grid2x2 : catalogLayout === 'grid4' ? Grid3x3 : List
  const layoutLabel = catalogLayout === 'grid2'
    ? text('两列', 'Two columns')
    : catalogLayout === 'grid4'
      ? text('四列', 'Four columns')
      : text('列表', 'List')

  /**
   * 数据图形：各分类的条目量 —— 一根刻线一个分类，高的是多数派。
   * 「设定在哪一类写得最多、哪一类还是空的」是这一页最该被看见的一件事。
   */
  const categoryTicks = categories.map(category => {
    // 分类标签走共享解析（内置分类与自定义分类都覆盖）
    const labels = getWorldSettingCategoryLabels(category.key, categories)
    return {
      label: text(labels.zhCN, labels.enUS),
      value: entries.filter(entry => entry.category === category.key).length,
    }
  })

  return (
    <div className="h-full overflow-y-auto">
      {/* 页头：目录 / 阅读 / 编辑三态共用同一位置、同一宽度 */}
      <div className="pagehead-strip">
        {!isEditing ? (
          <PagePlate
            section="world"
            figure={(
              <PlateFigure caption={text(
                `${entries.length} 条设定 · ${categories.length} 个分类`,
                `${entries.length} entries · ${categories.length} categories`,
              )}>
                <PlateTicks items={categoryTicks} />
              </PlateFigure>
            )}
            kicker={text('WORLD · 设定集', 'WORLD · SETTING')}
            title={text(categoryLabels.zhCN, categoryLabels.enUS)}
            description={text(categoryDescription.zhCN, categoryDescription.enUS)}
            actions={(
              <>
                {/* 排列与排序（先生：半透明图标按钮 + 旁边的排序下拉） */}
                <button
                  className="btn ghost sm"
                  type="button"
                  onClick={cycleCatalogLayout}
                  title={text(`当前排列：${layoutLabel}（点击切换）`, `Layout: ${layoutLabel} (click to switch)`)}
                  aria-label={text('切换排列风格', 'Switch layout')}
                >
                  <LayoutIcon size={11} /> {layoutLabel}
                </button>
                <label className="ws-sort">
                  <ArrowUpDown size={11} aria-hidden="true" />
                  <select
                    value={catalogSort}
                    onChange={event => setCatalogSort(event.target.value as CatalogSort)}
                    aria-label={text('排序方式', 'Sort by')}
                  >
                    <option value="updated">{text('按时间', 'By time')}</option>
                    <option value="name">{text('按名称', 'By name')}</option>
                  </select>
                </label>
                <button className="btn ai sm" type="button" onClick={handleAIGenerate} disabled={busy || generatingCandidates}>
                  <Sparkles size={11} /> {generatingCandidates ? text('正在生成…', 'Generating…') : text('AI 生成', 'Generate with AI')}
                </button>
                {/* 先生：与「AI 生成」并列时不抢红 —— 实心主色只留给单独出现的进入动作。 */}
                <button className="btn outline sm" type="button" onClick={startCreate} disabled={busy}>
                  <Plus size={11} /> {text('新建条目', 'New entry')}
                </button>
              </>
            )}
          />
        ) : inEditMode ? (
          <PagePlate section="world"
            kicker={text(`WORLD · ${categoryLabels.zhCN}`, `WORLD · ${categoryLabels.enUS}`)}
            title={form.name || text('新建设定条目', 'New entry')}
            description={selected
              ? text(
                `最后更新：${formatDbTimestamp(selected.updatedAt, locale) || '—'}`,
                `Last updated: ${formatDbTimestamp(selected.updatedAt, locale) || '—'}`,
              )
              : text('填好后保存，条目会归入左侧选中的分类。', 'Save when done; the entry joins the category selected on the left.')}
            actions={(
              <>
                {/* 先生：条目内也要能一键让 AI 写完整（只填空白字段，不覆盖已写内容） */}
                <button
                  className="btn ai sm"
                  type="button"
                  onClick={() => { void handleGenerateEntryDraft() }}
                  disabled={busy || generatingCandidates || !form.name.trim()}
                  title={text('让 AI 补全这条设定的摘要与详情', 'Let the AI complete this entry')}
                >
                  <Sparkles size={11} /> {generatingCandidates ? text('正在生成…', 'Generating…') : text('AI 生成', 'Generate with AI')}
                </button>
                <button className="btn ghost sm" type="button" onClick={() => (isCreating ? backToCatalog() : setViewMode('read'))} disabled={busy}>
                  <X size={11} /> {text('取消', 'Cancel')}
                </button>
                {/* 规矩同人物档案：保存用虚框，实心只留给「进入动作」 */}
                <button className="btn outline sm" type="button" onClick={handleSave} disabled={busy || !form.name.trim()}>
                  <Save size={11} /> {text('保存修改', 'Save changes')}
                </button>
              </>
            )}
          />
        ) : (
          <PagePlate section="world"
            kicker={text(`WORLD · ${categoryLabels.zhCN}`, `WORLD · ${categoryLabels.enUS}`)}
            title={selected?.name || text('未命名', 'Untitled')}
            description={selected?.summary || text('这条设定还没有摘要', 'This entry has no summary yet')}
            actions={(
              <>
                <button className="btn ghost sm" type="button" onClick={backToCatalog} disabled={busy}>
                  <ArrowLeft size={11} /> {text('返回目录', 'Back to list')}
                </button>
                {/* 待确认候选现在也出现在分类目录里，所以详情页必须给得出一条出路 ——
                    否则作者在栏目里点开它，只能看到内容却找不到「采纳」在哪。 */}
                {selected?.status === 'pending' && (
                  <button
                    className="btn ai sm"
                    type="button"
                    disabled={busy}
                    onClick={() => { void handleAcceptCandidate(selected.id) }}
                  >
                    <Check size={11} /> {text('采纳为正式设定', 'Accept as canon')}
                  </button>
                )}
                <button className="btn outline sm" type="button" onClick={handleDelete} disabled={busy}>
                  <Trash2 size={11} /> {text('删除', 'Delete')}
                </button>
                <button className="btn primary sm" type="button" onClick={() => setViewMode('edit')} disabled={busy}>
                  <PenLine size={11} /> {text('编辑条目', 'Edit entry')}
                </button>
              </>
            )}
          />
        )}
      </div>

      <div style={PAGE_STYLE}>
        {/* ===== 目录态 ===== */}
        {!isEditing && (
          categoryEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <Compass size={26} strokeWidth={1.4} style={{ color: 'var(--color-text-muted)' }} />
              <p className="text-sm" style={{ color: 'var(--color-text)' }}>
                {text(`「${categoryLabels.zhCN}」分类下还没有条目`, `No entries under “${categoryLabels.enUS}” yet`)}
              </p>
              <div className="flex items-center gap-2">
                <button className="btn ai sm" type="button" onClick={handleAIGenerate} disabled={busy || generatingCandidates}>
                  <Sparkles size={11} /> {generatingCandidates ? text('正在生成…', 'Generating…') : text('AI 生成', 'Generate with AI')}
                </button>
                <button className="btn outline sm" type="button" onClick={startCreate} disabled={busy}>
                  <Plus size={11} /> {text('手动新建', 'Create manually')}
                </button>
              </div>
              <p className="text-[0.72rem] max-w-[420px] leading-[1.9]" style={{ color: 'var(--color-text-muted)' }}>
                {text(
                  'AI 生成会结合已有的知识库与正文，产出这个分类下的设定条目草稿，之后你可以在目录里逐条修改。',
                  'AI generation drafts entries for this category from your knowledge base and manuscript; you can refine each one afterwards.',
                )}
              </p>
            </div>
          ) : (
            <div className={`ws-catalog ws-catalog--${catalogLayout}`}>
              {catalogEntries.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  className="ws-entry-card"
                  onClick={() => select(entry.id)}
                >
                  <span className="ws-entry-name">{entry.name}</span>
                  <span className="ws-entry-summary">
                    {entry.summary || text('（还没有摘要）', '(no summary yet)')}
                  </span>
                  <span className="ws-entry-meta">
                    {/* 待确认标记放在 meta 行首：不动卡片的三行结构，长名字也不会因此换行 */}
                    {entry.status === 'pending' ? `${text('待确认', 'Pending')} · ` : ''}
                    {text(
                      getWorldSettingImportanceLabels(entry.importance).zhCN,
                      getWorldSettingImportanceLabels(entry.importance).enUS,
                    )}
                    {entry.aliases.length > 0 ? ` · ${entry.aliases.slice(0, 2).join('、')}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )
        )}

        {/* ===== 单条 · 阅读态（照人物档案的档案式排版）===== */}
        {isEditing && !inEditMode && selected && (
          <>
            <div className="archive-grid">
              <ReadItem
                label={text('分类', 'Category')}
                value={text(categoryLabels.zhCN, categoryLabels.enUS)}
              />
              <ReadItem
                label={text('重要度', 'Importance')}
                value={text(
                  getWorldSettingImportanceLabels(selected.importance).zhCN,
                  getWorldSettingImportanceLabels(selected.importance).enUS,
                )}
              />
              <ReadItem label={text('别名', 'Aliases')} value={selected.aliases.join('、')} />
              <ReadItem label={text('最后更新', 'Last updated')} value={formatDbTimestamp(selected.updatedAt, locale) || '—'} />
            </div>

            {selected.summary && (
              <section className="archive-section lead">
                <h3>{text('一句话摘要', 'Summary')}</h3>
                <p className="archive-lead">{selected.summary}</p>
              </section>
            )}

            <section className="archive-section">
              <h3>{text('详情正文', 'Details')}</h3>
              {selected.content.trim() ? (
                <p>{selected.content}</p>
              ) : (
                <p style={{ opacity: 0.5 }}>
                  {text('还没有正文，点右上角「编辑条目」补上。', 'No details yet — use “Edit entry” above.')}
                </p>
              )}
            </section>

            {selected.tags.length > 0 && (
              <section className="archive-section">
                <h3>{text('标签', 'Tags')}</h3>
                <p>{selected.tags.join('、')}</p>
              </section>
            )}

            {/* 条目下方的动作区：先生要的 @ 功能（助手已接，章节蓝图引用随后） */}
            <div className="flex items-center gap-2 pt-1">
              <button className="btn outline sm" type="button" onClick={handleAskAssistant} disabled={busy}>
                <AtSign size={11} /> {text('助手', 'Assistant')}
              </button>
              {/* 先生：@ 助手旁边也要能 @ 章节蓝图，否则条目挂不到具体章节上 */}
              <button
                className="btn outline sm"
                type="button"
                onClick={() => setShowChapterRef(true)}
                disabled={busy || !selected}
                title={text('把这条设定引用到某几章', 'Reference this entry into chapters')}
              >
                <ListTree size={11} /> {text('章节蓝图', 'Chapter')}
              </button>
              <span className="text-[0.72rem] opacity-45">
                {text(
                  '把这条设定交给 AI 助手，作为后续创作的既定事实。',
                  'Hand this entry to the AI assistant as established fact.',
                )}
              </span>
            </div>
          </>
        )}

        {/* ===== 单条 · 编辑态（照人物档案的 archive-edit-field）===== */}
        {isEditing && inEditMode && (
          <>
            <div className="archive-grid" style={GRID_STYLE}>
              <EditField label={text('名称', 'Name')}>
                <input
                  value={form.name}
                  onChange={event => setForm(prev => ({ ...prev, name: event.target.value }))}
                  placeholder={text('例如：青云宗', 'e.g. Azure Cloud Sect')}
                  aria-label={text('条目名称', 'Entry name')}
                />
              </EditField>
              <EditField label={text('分类', 'Category')}>
                <select
                  value={form.category}
                  onChange={event => setForm(prev => ({ ...prev, category: event.target.value as WorldSettingCategory }))}
                  aria-label={text('条目分类', 'Entry category')}
                >
                  {categories.map(category => (
                    <option key={category.key} value={category.key}>
                      {text(category.zhCN, category.enUS)}
                    </option>
                  ))}
                </select>
              </EditField>
              <EditField label={text('重要度', 'Importance')}>
                <select
                  value={form.importance}
                  onChange={event => setForm(prev => ({ ...prev, importance: event.target.value as WorldSettingImportance }))}
                  aria-label={text('条目重要度', 'Entry importance')}
                >
                  {WORLD_SETTING_IMPORTANCE.map(importance => (
                    <option key={importance} value={importance}>
                      {text(getWorldSettingImportanceLabels(importance).zhCN, getWorldSettingImportanceLabels(importance).enUS)}
                    </option>
                  ))}
                </select>
              </EditField>
              <EditField label={text('别名 / 别称（顿号分隔）', 'Aliases (comma separated)')}>
                <input
                  value={form.aliases}
                  onChange={event => setForm(prev => ({ ...prev, aliases: event.target.value }))}
                  placeholder={text('青云门、青宗', 'e.g. Azure Gate')}
                  aria-label={text('条目别名', 'Entry aliases')}
                />
              </EditField>
            </div>

            <EditField label={text('一句话摘要（给 AI 看的关键事实）', 'Summary (the key fact for the AI)')} big>
              <input
                value={form.summary}
                onChange={event => setForm(prev => ({ ...prev, summary: event.target.value }))}
                placeholder={text('一句话说清这条设定最关键的事实', 'One line stating the key fact of this entry')}
                aria-label={text('条目摘要', 'Entry summary')}
              />
            </EditField>

            <EditField label={text('详情正文', 'Details')} big>
              <textarea
                value={form.content}
                onChange={event => setForm(prev => ({ ...prev, content: event.target.value }))}
                aria-label={text('条目正文', 'Entry details')}
                rows={14}
              />
            </EditField>

            <EditField label={text('标签（顿号分隔）', 'Tags (comma separated)')} big>
              <input
                value={form.tags}
                onChange={event => setForm(prev => ({ ...prev, tags: event.target.value }))}
                placeholder={text('关键道具、主线势力…', 'key item, main faction…')}
                aria-label={text('条目标签', 'Entry tags')}
              />
            </EditField>
          </>
        )}
      </div>

      {/* AI 生成候选预览：勾选后才入库（先生：先预览再入库） */}
      <WorldSettingCandidateDialog
        open={showCandidates}
        candidates={candidates}
        categories={categories}
        defaultCategory={activeCategory}
        busy={busy}
        onClose={() => setShowCandidates(false)}
        onConfirm={(selected) => { void handleConfirmCandidates(selected) }}
      />

      {/* 引用到章节：可连着点好几章 */}
      <WorldSettingChapterRefDialog
        open={showChapterRef}
        settingId={selected?.id ?? null}
        settingName={selected?.name ?? form.name}
        onClose={() => setShowChapterRef(false)}
      />
    </div>
  )
}
