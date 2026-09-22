import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from 'react'
import { ChevronLeft, ChevronRight, ClipboardPaste, Globe, Plus, RotateCcw, SlidersHorizontal, X } from 'lucide-react'

import deepseekIcon from '../../assets/brand-icons/deepseek.png'
import doubaoIcon from '../../assets/brand-icons/doubao.png'
import tongyiIcon from '../../assets/brand-icons/tongyi.png'
import kimiIcon from '../../assets/brand-icons/kimi.png'
import chatgptIcon from '../../assets/brand-icons/chatgpt.png'
import geminiIcon from '../../assets/brand-icons/gemini.png'
import yiyanIcon from '../../assets/brand-icons/yiyan.png'
import yuanbaoIcon from '../../assets/brand-icons/yuanbao.png'

import { useLocaleStore } from '../../stores/locale-store'
import { useExternalAiAuditStore } from '../../stores/external-ai-audit-store'
import {
  DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES,
  EXTERNAL_AI_AUDIT_PAGE_SIZE,
  EXTERNAL_AI_MATERIAL_SECTION_LABELS,
  faviconUrlFor,
  type ExternalAiAuditDelivery,
  type ExternalAiAuditEntry,
  type ExternalAiMaterialPreset,
  type ExternalAiMaterialSection,
  type ExternalAiMaterialSelection,
} from '../../shared/external-ai-audit'
import { copyExternalAiAuditFiles, openExternalAiPage, writeClipboardText } from '../../services/external-ai-audit-client'
import { buildExternalAiAuditReviewMaterial } from '../../services/external-ai-audit-review'
import {
  AUDIT_HANDOFF_CONFIG,
  type ExternalAiHandoffConfig,
} from './external-ai-handoff-config'
import { stripCodeFence } from '../../shared/external-ai-text'
import { toast } from '../ui/Toast'
import { Button } from '../ui/Button'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { WritingLanguage } from '../../shared/writing-language'

/**
 * 内置入口的站点图标 —— 随软件打包，断网也认得出是哪一家。
 *
 * 为什么内置的这一批不走 favicon 服务：
 *  - 通义千问抓回来的是一张**纯白空图**（先生实测：白得完全看不见），
 *    这里换成官方的蓝色 Qwen 标记；
 *  - 各家抓来的图标尺寸、底色、留白五花八门，混进同一张网格里参差不齐；
 *  - 收藏夹的图标不该依赖网络，离线时也不该退化成一片字母块。
 * 作者自建的入口仍然走 favicon 服务自动读取，取不到时回退首字母块。
 */
const BUILTIN_ENTRY_ICONS: Record<string, string> = {
  'builtin-deepseek': deepseekIcon,
  'builtin-doubao': doubaoIcon,
  'builtin-qwen': tongyiIcon,
  'builtin-kimi': kimiIcon,
  'builtin-chatgpt': chatgptIcon,
  'builtin-gemini': geminiIcon,
  'builtin-wenxin': yiyanIcon,
  'builtin-yuanbao': yuanbaoIcon,
}

/** 图标边长（px）。先生要求「按钮小一点」，18 是还能看清 logo 的最小舒服值。 */
const ICON_SIZE = 18

/**
 * 装配一份完整材料所需要的项目上下文。
 *
 * 由调用方（草稿编辑器）在点击的**那一刻**现取，而不是把一堆 store 依赖塞进
 * 这个板块 —— 项目会话随时可能失效，只有取的那一刻算数。
 */
export interface ExternalAiAuditReviewContext {
  projectSession: ProjectSessionContext
  projectPath: string
  novelConfig: Record<string, unknown>
  writingLanguage: WritingLanguage
  /** 与内置审稿同一份勾选结果（审稿用）。 */
  reviewFocus?: string
  /** 作者在修稿弹窗里填的额外要求（修稿用）。 */
  userRefinePrompt?: string
}

/** 本次装配的全部输入：审稿与修稿共用同一份约定。 */
export interface ExternalAiHandoffBuildInput extends ExternalAiAuditReviewContext {
  chapterTitle: string
  chapterNumber: number
  draftContent: string
  locale: 'zh-CN' | 'en-US'
  sections: ExternalAiMaterialSelection
  delivery: ExternalAiAuditDelivery
}

/** 装配产物：文本投递看 text，文件投递看 files。 */
export interface ExternalAiHandoffMaterial {
  delivery: ExternalAiAuditDelivery
  text: string
  files: Array<{ name: string; content: string }>
  writingSkillName: string | null
  characters: number
  sectionSizes: Array<{ label: string; characters: number }>
}

interface ExternalAiAuditBoardProps {
  /** 章节标题，进剪贴板文案的抬头。 */
  chapterTitle: string
  chapterNumber?: number
  /**
   * 取当前草稿正文。
   *
   * 由调用方提供而不是直接把 content 传进来：作者可能刚敲完字还没保存，
   * 复制的必须是**编辑器里当下这一份**，否则他审的是旧稿。
   */
  getDraftContent: () => string
  /** 取装配所需的项目上下文；会话失效时返回 null。 */
  getReviewContext: () => ExternalAiAuditReviewContext | null
  /**
   * 装配入口。默认就是真实实现。
   *
   * 留出这个注入口是因为**真实的装配必须读主进程数据**（连续性事实、角色档案、
   * 世界观、蓝图、写作 Skill），浏览器测试里跑不了那条链路；
   * 也不想为此把整条链路都 mock 掉 —— 组件测试只需证明「参数传对了、
   * 拿到材料后如约复制并打开」。
   */
  buildMaterial?: (input: ExternalAiHandoffBuildInput) => Promise<ExternalAiHandoffMaterial>
  /** 板块差异点（标题、文案、材料清单、预设、必带项、回流入口）。 */
  config?: ExternalAiHandoffConfig
  /** 回流入口：把网页版交回的正文交给调用方（修稿板块才有）。 */
  onApplyResult?: (text: string) => void
  /** 被选中的入口 id（卡片现在是**选择框**，点了不再直接开浏览器）。 */
  selectedEntryIds?: readonly string[]
  onToggleEntry?: (id: string) => void
  /**
   * 灰态：执行方式没选「外部」时整块不可交互。
   *
   * 用 `cursor: not-allowed` 挂在容器上、内层 `pointer-events: none` —— 反过来写
   * 的话鼠标样式也不会变（`pointer-events: none` 的元素收不到鼠标事件），
   * 先生就看不到「禁止」图标。
   */
  disabled?: boolean
  ref?: Ref<ExternalAiHandoffHandle>
}

/** 板块交给外面的命令式接口：确认执行时由弹窗按钮调它。 */
export interface ExternalAiHandoffHandle {
  /** 装配 → 复制（或写盘）→ 打开选中的所有入口。失败返回 false。 */
  launch: () => Promise<boolean>
}

/**
 * 「外部 AI 代劳」板块 —— 一块浏览器收藏夹式的入口网格。
 *
 * 审稿与修稿共用这一副骨架，差异全部由 `config` 给出：
 *  - 固定 2×2 网格，每页四个；超过一页才出现左右翻页，永不出现半行的参差。
 *  - 卡片统一高度、名称单行截断，长名字也不会把格子撑变形。
 *  - 点一下 = 把**与内置那一步同一份材料**复制走，再用系统浏览器打开该 AI。
 *    材料清单与装配入口都由调用方注入（审稿走 chapter-review-prompt，
 *    修稿走 chapter-refine-prompt），板块本身不关心它们的内容。
 *  - 修稿多一条回流：`onApplyResult` 把对方改好的正文交回编辑器。
 */
export default function ExternalAiAuditBoard({
  chapterTitle,
  chapterNumber,
  getDraftContent,
  getReviewContext,
  buildMaterial = buildExternalAiAuditReviewMaterial,
  config = AUDIT_HANDOFF_CONFIG,
  onApplyResult,
  selectedEntryIds = [],
  onToggleEntry,
  disabled = false,
  ref,
}: ExternalAiAuditBoardProps) {
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const entries = useExternalAiAuditStore(s => s.entries)
  const addEntry = useExternalAiAuditStore(s => s.addEntry)
  const removeEntry = useExternalAiAuditStore(s => s.removeEntry)
  const restoreDefaults = useExternalAiAuditStore(s => s.restoreDefaults)
  const materialSelection = useExternalAiAuditStore(s => s.materialSelection)
  const setMaterialSection = useExternalAiAuditStore(s => s.setMaterialSection)
  const setMaterialSelection = useExternalAiAuditStore(s => s.setMaterialSelection)
  const delivery = useExternalAiAuditStore(s => s.delivery)
  const setDelivery = useExternalAiAuditStore(s => s.setDelivery)

  /** 材料子菜单是否展开。 */
  const [materialsOpen, setMaterialsOpen] = useState(false)
  /** 回流入口是否展开（修稿专用）。 */
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  /** 上一次装配各块的字数：材料面板据此显示「这块有多重」。 */
  const [lastSectionSizes, setLastSectionSizes] = useState<Array<{ label: string; characters: number }>>([])

  const [rawPage, setPage] = useState(0)
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftUrl, setDraftUrl] = useState('')
  const [formError, setFormError] = useState('')
  /** 正在打开的入口地址；非空即视为进行中，防止连点开出一串浏览器窗口。 */
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)

  const pageCount = Math.max(1, Math.ceil(entries.length / EXTERNAL_AI_AUDIT_PAGE_SIZE))
  /*
    当前页码在渲染期收敛，而不是用 effect 回写 state：
    作者删到当前页空了要自动退回上一页，这是「由 entries 派生出来的值」，
    放进 effect 只会多一轮级联渲染（React 也明确不建议这么写）。
  */
  const page = rawPage > pageCount - 1 ? pageCount - 1 : rawPage

  const visibleEntries = entries.slice(
    page * EXTERNAL_AI_AUDIT_PAGE_SIZE,
    page * EXTERNAL_AI_AUDIT_PAGE_SIZE + EXTERNAL_AI_AUDIT_PAGE_SIZE,
  )
  const missingBuiltins = DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES
    .some(entry => !entries.some(candidate => candidate.id === entry.id))

  /**
   * 点某个入口：装配**与内置审稿同一份材料** → 复制 → 开浏览器。
   *
   * 装配是异步的（要读连续性事实、角色档案、世界观、蓝图与绑定 Skill），
   * 所以这里先置 pendingUrl 进入「准备中」态：既挡住连点，也让作者知道在等什么。
   */
  const handleLaunch = async (entries: readonly ExternalAiAuditEntry[]) => {
    if (pendingUrl || entries.length === 0) return false
    if (chapterNumber === undefined) {
      // 章节号是装配材料的锚点（连续性事实、蓝图、目标清单都按它取），
      // 拿不到就宁可不开浏览器 —— 否则作者会贴一份缺了上下文的材料还以为完整。
      toast.error(text(
        '尚未解析出本章章节号，暂时无法装配材料',
        'This chapter number is not resolved yet, so the material cannot be assembled.',
      ))
      return false
    }
    const context = getReviewContext()
    if (!context) {
      toast.error(text(
        '当前项目会话已失效，请重新打开这份草稿再试',
        'The project session is no longer available. Reopen this draft and try again.',
      ))
      return false
    }

    setPendingUrl(entries[0]!.url)
    try {
      const material = await buildMaterial({
        ...context,
        chapterTitle,
        chapterNumber,
        draftContent: getDraftContent(),
        locale,
        sections: materialSelection,
        delivery,
      })
      setLastSectionSizes(material.sectionSizes)

      /*
        两种投递：
        - inline：整段文本进剪贴板，作者到输入框 Ctrl+V；
        - files：每块各写成 .md，由主进程放进系统剪贴板的「文件列表」——
          浏览器会把它当成「粘贴了这几个文件」，直接触发上传。
      */
      const copied = material.delivery === 'files'
        ? (await copyExternalAiAuditFiles(material.files)).success
        : await writeClipboardText(material.text)

      // 选了几个就开几个：材料只装配一次，剪贴板里也只会有一份
      let openedCount = 0
      for (const entry of entries) {
        const opened = await openExternalAiPage(entry.url)
        if (opened.success) openedCount += 1
      }

      if (openedCount === 0) {
        toast.error(text(
          '打开链接失败，请检查链接是否有效',
          'Could not open the selected sites. Please check the links.',
        ))
        return false
      }

      const names = entries.map(entry => entry.name).join('、')
      if (copied) {
        const skillNote = material.writingSkillName
          ? text(`，含写作 Skill：${material.writingSkillName}`, ` incl. skill: ${material.writingSkillName}`)
          : ''
        toast.success(material.delivery === 'files'
          ? text(
            `已把 ${material.files.length} 份材料放进剪贴板（约 ${material.characters} 字${skillNote}），在 ${names} 的输入框按 Ctrl+V 即可当文件上传`,
            `${material.files.length} material files are on the clipboard (${material.characters} characters${skillNote}) — press Ctrl+V in ${names} to upload them.`,
          )
          : text(
            `已复制材料（约 ${material.characters} 字${skillNote}），在 ${names} 里粘贴即可开始`,
            `Material copied (${material.characters} characters${skillNote}) — paste it into ${names}.`,
          ))
      } else {
        toast.warning(text(
          `已打开 ${names}，但复制材料失败，请手动复制`,
          `Opened ${names}, but copying the material failed — please copy it manually.`,
        ))
      }
      return true
    } catch (error) {
      toast.error(text(
        `装配材料失败：${error instanceof Error ? error.message : String(error)}`,
        `Could not assemble the material: ${error instanceof Error ? error.message : String(error)}`,
      ))
      return false
    } finally {
      setPendingUrl(null)
    }
  }

  /*
    命令式出口：弹窗的「确认执行」按钮在外部模式下调它。
    放进 useImperativeHandle 是为了让调用方拿到**最新一次渲染**的函数，
    否则按钮会抓到一份过期的 materialSelection / delivery。
  */
  useImperativeHandle(ref, () => ({
    launch: () => handleLaunch(entries.filter(entry => selectedEntryIds.includes(entry.id))),
  }))

  /**
   * 预装配：先生一勾「外部」，就先把材料装一遍，好在材料面板里看见各块字数。
   *
   * 失败不打扰先生 —— 真要启动时会再报一次错，那时才是他需要知道的时候。
   * 依赖用 ref 兜住：调用方传的是内联函数，写进依赖数组会每渲染一次就重取一遍。
   */
  const preloadRef = useRef({
    buildMaterial, getReviewContext, getDraftContent, chapterTitle, chapterNumber, locale,
    materialSelection, delivery,
  })
  /*
    在 effect 里刷新这份依赖快照，而不是 render 期直接写 ——
    render 期写 ref 在并发渲染 / StrictMode 双调用下可能写进被丢弃的那一次渲染。
    本 effect 声明在下面的预装配之前，React 按声明顺序执行，预装配读到的必是最新值。
  */
  useEffect(() => {
    preloadRef.current = {
      buildMaterial, getReviewContext, getDraftContent, chapterTitle, chapterNumber, locale,
      materialSelection, delivery,
    }
  })
  const preloadedRef = useRef(false)
  useEffect(() => {
    if (disabled || preloadedRef.current) return
    const current = preloadRef.current
    // 收进局部常量：异步闭包里 TS 才认得住「已经不是 undefined」这件事
    const preloadChapterNumber = current.chapterNumber
    if (preloadChapterNumber === undefined) return
    let cancelled = false
    void (async () => {
      try {
        const context = current.getReviewContext()
        if (!context) return
        const material = await current.buildMaterial({
          ...context,
          chapterTitle: current.chapterTitle,
          chapterNumber: preloadChapterNumber,
          draftContent: current.getDraftContent(),
          locale: current.locale,
          sections: current.materialSelection,
          delivery: current.delivery,
        })
        if (cancelled) return
        preloadedRef.current = true
        setLastSectionSizes(material.sectionSizes)
      } catch {
        // 预取失败就静默 —— 启动时还会再装配一次并如实报错
      }
    })()
    return () => { cancelled = true }
  }, [disabled, chapterNumber])

  const handleAdd = () => {
    const result = addEntry(draftName, draftUrl)
    if (!result.success) {
      setFormError(result.reason === 'name'
        ? text('请先给这个入口起个名字', 'Give the entry a name first')
        : result.reason === 'url'
          ? text('链接不对，请填以 http:// 或 https:// 开头的网址', 'That link is not valid — use a http:// or https:// address')
          : text('这个网址已经在收藏里了', 'That address is already saved'))
      return
    }

    setDraftName('')
    setDraftUrl('')
    setFormError('')
    setAdding(false)
    toast.success(text(`已添加入口「${result.entry.name}」`, `Added “${result.entry.name}”`))
    // 跳到最后：新入口追加在末尾，让作者立刻看到它落位
    const nextEntries = useExternalAiAuditStore.getState().entries
    const index = nextEntries.findIndex(candidate => candidate.id === result.entry.id)
    if (index >= 0) setPage(Math.floor(index / EXTERNAL_AI_AUDIT_PAGE_SIZE))
  }

  const closeForm = () => {
    setAdding(false)
    setDraftName('')
    setDraftUrl('')
    setFormError('')
  }

  /**
   * 把网页版交回的正文交给调用方。
   *
   * 调用方（草稿编辑器）不会直接覆盖原稿 —— 它会打开**改稿差异对比**，
   * 先生逐处确认后才合并。这里只负责把围栏剥干净再交出去。
   */
  const applyPastedResult = () => {
    const value = pasteText.trim()
    if (!value || !onApplyResult) return
    onApplyResult(stripCodeFence(value))
    setPasteOpen(false)
    setPasteText('')
    toast.success(text(
      '已打开差异对比 —— 逐处确认后再合并',
      'Comparison opened — review the changes before merging.',
    ))
  }

  const sectionLabel = (section: ExternalAiMaterialSection) => text(
    EXTERNAL_AI_MATERIAL_SECTION_LABELS[section].zh,
    EXTERNAL_AI_MATERIAL_SECTION_LABELS[section].en,
  )

  /** 上次装配时这一块有多重（还不知道就返回 null）。 */
  const sectionSize = (section: ExternalAiMaterialSection): number | null => {
    const hit = lastSectionSizes.find(size => size.label === sectionLabel(section))
    return hit ? hit.characters : null
  }

  /**
   * 应用预设：**只改本板块用到的块**。
   *
   * 选择记录是审稿、修稿两份板块共用的 —— 整份覆盖会把另一个板块的勾选一起冲掉。
   */
  const applyPreset = (preset: ExternalAiMaterialPreset) => {
    const merged = { ...materialSelection }
    for (const section of config.sections) {
      const value = preset.selection[section]
      if (typeof value === 'boolean') merged[section] = value
    }
    setMaterialSelection(merged)
  }

  return (
    <div
      className={disabled ? 'mt-3 handoff-board-disabled' : 'mt-3'}
      aria-disabled={disabled || undefined}
    >
      {/* 板块标题：与上方「重点检查维度」同一层级，靠图标与字重区分 */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Globe size={12} style={{ color: 'var(--color-text-muted)' }} aria-hidden="true" />
          <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>
            {text(config.title[0], config.title[1])}
          </span>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* 材料子菜单：逐块取舍本次要带哪些上下文（先生要的那把剪刀） */}
          <button
            type="button"
            aria-expanded={materialsOpen}
            onClick={() => setMaterialsOpen(open => !open)}
            title={text('选择本次参与审计的材料', 'Choose which material this audit carries')}
            className="flex items-center gap-1 rounded-md transition-colors hover:bg-[var(--color-hover)]"
            style={{
              fontSize: '0.75rem',
              padding: '3px 8px',
              border: `1px solid ${materialsOpen ? 'var(--color-accent)' : 'var(--color-border)'}`,
              background: materialsOpen ? 'rgba(var(--color-accent-rgb), 0.08)' : 'transparent',
              color: materialsOpen ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              cursor: 'pointer',
            }}
          >
            <SlidersHorizontal size={10} aria-hidden="true" />
            {text('材料', 'Materials')}
          </button>

          {pageCount > 1 && (
            <div className="flex items-center gap-0.5">
              <PagerButton
                label={text('上一页', 'Previous page')}
                disabled={page === 0}
                onClick={() => setPage(Math.max(0, page - 1))}
              >
                <ChevronLeft size={13} strokeWidth={2.5} />
              </PagerButton>
              <span className="text-[0.75rem] tabular-nums px-1" style={{ color: 'var(--color-text-muted)' }}>
                {page + 1} / {pageCount}
              </span>
              <PagerButton
                label={text('下一页', 'Next page')}
                disabled={page >= pageCount - 1}
                onClick={() => setPage(Math.min(pageCount - 1, page + 1))}
              >
                <ChevronRight size={13} strokeWidth={2.5} />
              </PagerButton>
            </div>
          )}
        </div>
      </div>

      <p className="text-[0.75rem] leading-snug mb-2" style={{ color: 'var(--color-text-muted)' }}>
        {pendingUrl
          ? text(config.assemblingHint[0], config.assemblingHint[1])
          : text(config.hint[0], config.hint[1])}
      </p>

      {materialsOpen && (
        <div
          className="mb-2 rounded-lg p-2.5"
          style={{ border: '1px solid var(--color-border)', background: 'var(--color-raised)' }}
        >
          {/* 预设：一键在「全带 / 判连贯性最小集 / 只看这一章」之间切换 */}
          <div className="flex items-center gap-1.5 mb-2" style={{ fontSize: '0.75rem' }}>
            <span style={{ color: 'var(--color-text-muted)' }}>{text('预设：', 'Preset:')}</span>
            {config.presets.map(preset => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset)}
                className="rounded transition-colors hover:bg-[var(--color-hover)]"
                style={{
                  fontSize: '0.75rem',
                  padding: '3px 8px',
                  border: '1px solid var(--color-border)',
                  background: 'transparent',
                  color: 'var(--color-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {text(preset.label[0], preset.label[1])}
              </button>
            ))}
          </div>

          {/* 逐块勾选：右上角显示上次装配时各块的字数，便于判断砍哪块最省 */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {config.sections.map(section => {
              const required = config.requiredSections.includes(section)
              const checked = materialSelection[section]
              const characters = sectionSize(section)
              return (
                <label
                  key={section}
                  className="flex items-center gap-2 min-w-0"
                  style={{ fontSize: '0.75rem', cursor: required ? 'default' : 'pointer', opacity: required ? 0.75 : 1 }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={required}
                    aria-label={sectionLabel(section)}
                    onChange={event => setMaterialSection(section, event.target.checked)}
                    style={{
                      width: 15,
                      height: 15,
                      flexShrink: 0,
                      accentColor: 'var(--color-accent)',
                      cursor: required ? 'default' : 'pointer',
                    }}
                  />
                  <span className="truncate" style={{ color: 'var(--color-text)' }}>{sectionLabel(section)}</span>
                  {characters !== null && checked && (
                    <span className="ml-auto tabular-nums flex-shrink-0" style={{ color: 'var(--color-text-secondary)' }}>
                      {characters}
                    </span>
                  )}
                </label>
              )
            })}
          </div>

          {/* 交付方式：整段文本粘贴，或把每块写成 .md 放进剪贴板文件列表 */}
          <div
            className="flex items-center gap-1.5 mt-2 pt-2"
            style={{ borderTop: '1px solid var(--color-border)', fontSize: '0.75rem' }}
          >
            <span style={{ color: 'var(--color-text-muted)' }}>{text('交付方式：', 'Delivery:')}</span>
            {([
              ['inline', text('文本粘贴', 'Paste text'), text('一次 Ctrl+V 贴进输入框', 'Paste the whole thing with one Ctrl+V')],
              ['files', text('.md 文件粘贴', 'Paste .md files'), text('粘贴后当文件上传，可逐个查看', 'Pasted as files the site uploads; each block stays readable')],
            ] as const).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                title={hint}
                aria-pressed={delivery === value}
                onClick={() => setDelivery(value as ExternalAiAuditDelivery)}
                className="rounded transition-colors hover:bg-[var(--color-hover)]"
                style={{
                  fontSize: '0.75rem',
                  padding: '3px 8px',
                  border: `1px solid ${delivery === value ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  background: delivery === value ? 'rgba(var(--color-accent-rgb), 0.08)' : 'transparent',
                  color: delivery === value ? 'var(--color-accent)' : 'var(--color-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 2×2 网格：每页固定四个格子，永远是整齐的两行 */}
      <div className="grid grid-cols-2 gap-1.5">
        {visibleEntries.map(entry => (
          <ExternalAiAuditCard
            key={entry.id}
            entry={entry}
            busy={pendingUrl !== null}
            selected={selectedEntryIds.includes(entry.id)}
            disabled={disabled}
            onToggle={() => onToggleEntry?.(entry.id)}
            onRemove={() => removeEntry(entry.id)}
            removeLabel={text(`删除入口「${entry.name}」`, `Remove “${entry.name}”`)}
          />
        ))}
      </div>

      {/* 新建入口 / 恢复默认 */}
      {adding ? (
        <div
          className="mt-2 rounded-lg p-2.5 space-y-2"
          style={{ border: '1px dashed var(--color-border)' }}
        >
          <input
            className="w-full px-2 py-1.5 rounded-md text-xs"
            style={inputStyle}
            value={draftName}
            aria-label={text('入口名称', 'Entry name')}
            placeholder={text('名称，例如 智谱清言', 'Name, e.g. ChatGLM')}
            onChange={event => { setDraftName(event.target.value); setFormError('') }}
            onKeyDown={event => { if (event.key === 'Enter') handleAdd() }}
          />
          <input
            className="w-full px-2 py-1.5 rounded-md text-xs"
            style={inputStyle}
            value={draftUrl}
            aria-label={text('入口链接', 'Entry link')}
            placeholder={text('链接，例如 chat.example.com', 'Link, e.g. chat.example.com')}
            onChange={event => { setDraftUrl(event.target.value); setFormError('') }}
            onKeyDown={event => { if (event.key === 'Enter') handleAdd() }}
          />
          {formError && (
            <div className="text-[0.75rem]" style={{ color: 'var(--color-error)' }} role="alert">
              {formError}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={closeForm}>
              {text('取消', 'Cancel')}
            </Button>
            <Button size="sm" variant="default" onClick={handleAdd}>
              {text('添加', 'Add')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 text-[0.75rem] transition-opacity hover:opacity-75" style={linkishButtonStyle}>
              <Plus size={11} aria-hidden="true" />
              {text('新建入口', 'New entry')}
            </button>
            {/* 回流：修稿才有 —— 对方交回的是正文，得有条路把它拿回软件 */}
            {config.applyResult && onApplyResult && (
              <button
                type="button"
                aria-expanded={pasteOpen}
                onClick={() => setPasteOpen(open => !open)}
                className="flex items-center gap-1 text-[0.75rem] transition-opacity hover:opacity-75"
                style={linkishButtonStyle}
              >
                <ClipboardPaste size={11} aria-hidden="true" />
                {text(config.applyResult.open[0], config.applyResult.open[1])}
              </button>
            )}
          </div>
          {missingBuiltins && (
            <button type="button" onClick={restoreDefaults} className="flex items-center gap-1 text-[0.75rem] transition-opacity hover:opacity-75" style={linkishButtonStyle}>
              <RotateCcw size={11} aria-hidden="true" />
              {text('恢复默认入口', 'Restore defaults')}
            </button>
          )}
        </div>
      )}

      {/* 回流区：把网页版改好的正文贴进来，交给编辑器 */}
      {pasteOpen && config.applyResult && onApplyResult && (
        <div
          className="mt-2 rounded-lg p-2.5"
          style={{ border: '1px dashed var(--color-border)', background: 'var(--color-raised)' }}
        >
          <div className="mb-1.5" style={{ fontSize: '0.75rem', color: 'var(--color-text)' }}>
            {text(config.applyResult.title[0], config.applyResult.title[1])}
          </div>
          <textarea
            className="w-full px-2 py-1.5 rounded-md"
            style={{ ...inputStyle, minHeight: 96, resize: 'vertical', fontSize: '0.75rem' }}
            aria-label={text(config.applyResult.title[0], config.applyResult.title[1])}
            placeholder={text(config.applyResult.placeholder[0], config.applyResult.placeholder[1])}
            value={pasteText}
            onChange={event => setPasteText(event.target.value)}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setPasteOpen(false); setPasteText('') }}
            >
              {text(config.applyResult.cancel[0], config.applyResult.cancel[1])}
            </Button>
            <Button
              size="sm"
              variant="default"
              disabled={!pasteText.trim()}
              onClick={applyPastedResult}
            >
              {text(config.applyResult.apply[0], config.applyResult.apply[1])}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

const inputStyle = {
  /*
    背景用 --color-raised（真有其名的令牌，指向各皮肤的「次级面」）。
    原先写的 --color-bg-elevated 在整个项目里**从未定义过** —— 背景于是完全透明，
    输入框只剩一根细边，先生看到的「看不清」有它一份。
  */
  background: 'var(--color-raised)',
  border: '1px solid var(--color-border)',
  color: 'var(--color-text)',
  outline: 'none',
} as const

/** 「新建入口 / 恢复默认」这类轻量文字按钮：强调色、无边框、不抢版面。 */
const linkishButtonStyle = {
  background: 'transparent',
  border: 'none',
  color: 'var(--color-accent)',
  cursor: 'pointer',
  padding: 0,
} as const

/**
 * 剥掉整段的 Markdown 代码块围栏（实现见 shared/external-ai-text）。
 * 放在 shared 里是因为它是纯文本处理，与界面无关，也好单独测。
 */

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  /*
    左侧那个小三角按钮 —— 「很多网站那种」翻页控件的做法：
    描边小方块、悬停变色、到头那一侧淡出。
  */
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center justify-center rounded-md transition-all duration-200 hover:bg-[var(--color-hover)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-default"
      style={{
        width: 20,
        height: 20,
        background: 'transparent',
        border: '1px solid var(--color-border)',
        cursor: disabled ? 'default' : 'pointer',
        color: 'var(--color-text-secondary)',
        opacity: disabled ? 0.3 : 1,
      }}
    >
      {children}
    </button>
  )
}

/**
 * 单个入口卡片 —— 现在是一枚**选择框**。
 *
 * 先生（流程重构）：卡片不再「点了就开浏览器」，而是选中/取消选中；
 * 真正打开哪些，由弹窗的「确认执行」按钮统一决定（可以一次开好几个）。
 * 选中态靠强调色描边 + 淡底 + 名称变色表达，不额外塞勾选框 ——
 * 两列网格每格才 180 像素，多一个方块就把名字挤没了。
 */
function ExternalAiAuditCard({
  entry,
  busy,
  selected,
  disabled,
  onToggle,
  onRemove,
  removeLabel,
}: {
  entry: ExternalAiAuditEntry
  busy: boolean
  selected: boolean
  disabled: boolean
  onToggle: () => void
  onRemove: () => void
  removeLabel: string
}) {
  return (
    /*
      删除按钮刻意留在卡片**内部**（占一条固定的窄槽），不做负偏移外挂：
      这块网格会放进可滚动的内容区里，溢出卡片的绝对定位会被滚动容器裁掉。
      槽位常驻，所以按钮浮现时卡片宽度不会抖。
    */
    <div
      className="group flex items-stretch rounded-md transition-all duration-200 hover:border-[var(--color-accent)]"
      style={{
        border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
        background: selected ? 'rgba(var(--color-accent-rgb), 0.10)' : 'transparent',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={entry.name}
        onClick={onToggle}
        disabled={busy || disabled}
        title={entry.url}
        className="flex-1 min-w-0 flex items-center gap-1.5 pl-2 py-1.5"
        style={{
          background: 'transparent',
          border: 'none',
          cursor: busy || disabled ? 'default' : 'pointer',
          textAlign: 'left',
          opacity: busy ? 0.6 : 1,
        }}
      >
        <EntryIcon entry={entry} />
        <span
          className="flex-1 min-w-0 truncate font-medium"
          style={{
            color: selected ? 'var(--color-accent)' : 'var(--color-text)',
            fontSize: '0.7rem',
          }}
        >
          {entry.name}
        </span>
      </button>

      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        title={removeLabel}
        aria-label={removeLabel}
        className="flex items-center justify-center rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--color-hover)]"
        style={{
          width: 20,
          flexShrink: 0,
          background: 'transparent',
          border: 'none',
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
        }}
      >
        <X size={10} />
      </button>
    </div>
  )
}

/**
 * 入口图标。
 *
 * 内置入口用随包发布的品牌图标（见 BUILTIN_ENTRY_ICONS）；作者自建的入口走
 * favicon 服务自动读取网页 logo；两者都取不到时退回首字母块。
 *
 * 图标一律**垫在浅色圆角底上**——先生实测过通义千问那种白 logo：直接贴在深色
 * 主题上就是一块看不见的白。加一层固定浅底之后，白 logo、深底 logo（Kimi）、
 * 透明底 logo 在深浅两套主题下都有同样的对比度，整排图标也长得整齐。
 */
function EntryIcon({ entry }: { entry: ExternalAiAuditEntry }) {
  const [failed, setFailed] = useState(false)
  const src = BUILTIN_ENTRY_ICONS[entry.id] ?? faviconUrlFor(entry.url)
  const initial = entry.name.trim().charAt(0).toUpperCase() || '?'

  return (
    <span
      className="flex items-center justify-center flex-shrink-0 overflow-hidden"
      style={{
        width: ICON_SIZE,
        height: ICON_SIZE,
        borderRadius: 5,
        // 固定浅底（不随主题走）：白色 logo 与深色底 logo 才能都看清
        backgroundColor: '#ffffff',
        border: '1px solid rgba(0, 0, 0, 0.10)',
      }}
      aria-hidden="true"
    >
      {!src || failed ? (
        <span className="font-semibold" style={{ fontSize: '0.6rem', color: 'var(--color-accent)' }}>
          {initial}
        </span>
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          width={ICON_SIZE}
          height={ICON_SIZE}
          onError={() => setFailed(true)}
          style={{ width: ICON_SIZE, height: ICON_SIZE, objectFit: 'contain', display: 'block' }}
        />
      )}
    </span>
  )
}
