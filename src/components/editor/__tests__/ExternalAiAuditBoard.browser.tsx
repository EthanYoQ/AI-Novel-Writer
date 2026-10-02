/* eslint-disable react-refresh/only-export-components -- 测试文件的宿主组件不参与 HMR，没必要为它拆文件 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/*
  浏览器测试默认不带全局样式表（测试 setup 里没有它），于是 Tailwind 的
  grid / flex 会**静默失效**，2×2 网格退化成竖排单列 —— 那样断言和截图都不作数。

  这三张表按 main.tsx 的顺序来：index.css → v2 基座 → v3 杂志皮肤。
  少任何一张，测出来的配色都代表不了先生看到的东西（曾经因此漏掉真问题）。
*/
import '../../../index.css'
import '../../../styles/redesign/v2-index.css'
import '../../../styles/magazine/mag-index.css'

const mocks = vi.hoisted(() => ({ buildMaterial: vi.fn() }))

/*
  装配会去读已定稿连续性事实、角色档案、世界观、蓝图与绑定的写作 Skill
  （全都要走主进程 IPC），浏览器测试里跑不了那条真实链路。
  所以替身从 **props 注入**（而不是 vi.mock —— 浏览器模式下模块 mock 不生效，
  试过，真实装配会被执行并报「不在 Electron 环境中」）。
*/
import ExternalAiAuditBoard, { type ExternalAiHandoffHandle } from '../ExternalAiAuditBoard'
import { REFINE_HANDOFF_CONFIG } from '../external-ai-handoff-config'
import { stripCodeFence } from '../../../shared/external-ai-text'
import { useLocaleStore } from '../../../stores/locale-store'
import {
  EXTERNAL_AI_AUDIT_STORAGE_KEY,
  useExternalAiAuditStore,
} from '../../../stores/external-ai-audit-store'
import {
  DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES,
  EXTERNAL_AI_FULL_SELECTION,
} from '../../../shared/external-ai-audit'

const DRAFT_BODY = '雾从港口漫上来，灯塔的光在水面上碎成一片。'
const ASSEMBLED_MATERIAL = [
  '【请审稿：雾港的灯】',
  '（以下由 AI 小说作家导出，与软件内置审稿用的是同一份材料……）',
  '',
  '【补充写作 Skill：连贯性审稿】',
  '【待审章节】' + DRAFT_BODY,
].join('\n')

/** 组件向调用方索要的项目上下文：草稿编辑器真实提供的那一份。 */
const REVIEW_CONTEXT = {
  projectSession: { projectId: '7', leaseId: 'lease-1', projectPath: 'C:\\novels\\wugang' },
  projectPath: 'C:\\novels\\wugang',
  novelConfig: { writingLanguage: 'zh-CN' },
  writingLanguage: 'zh-CN' as const,
  reviewFocus: '剧情连贯性、角色状态',
}

/** 卡片：先生（流程重构）之后它是一枚**选择框**，不是「点了就打开」的按钮。 */
function entryCard(name: string) {
  return page.getByRole('checkbox', { name, exact: true })
}

/**
 * 测试用的宿主：替先生管「选了哪几个入口」这份状态（真实界面里由草稿编辑器管），
 * 并把组件的命令式出口暴露出来 —— 测试里用它模拟弹窗底部那个「确认执行」。
 */
function BoardHarness({
  boardRef,
  config,
  onApplyResult,
  reviewContext,
  chapterNumber,
  disabled,
}: {
  boardRef: { current: ExternalAiHandoffHandle | null }
  config?: typeof REFINE_HANDOFF_CONFIG
  onApplyResult?: (text: string) => void
  reviewContext: typeof REVIEW_CONTEXT | null
  chapterNumber?: number
  disabled?: boolean
}) {
  const [selected, setSelected] = useState<string[]>([])
  return (
    <ExternalAiAuditBoard
      ref={boardRef}
      config={config}
      disabled={disabled}
      chapterTitle="雾港的灯"
      chapterNumber={chapterNumber}
      selectedEntryIds={selected}
      onToggleEntry={id => setSelected(current => (
        current.includes(id) ? current.filter(item => item !== id) : [...current, id]
      ))}
      getDraftContent={() => DRAFT_BODY}
      getReviewContext={() => reviewContext}
      buildMaterial={(...args) => mocks.buildMaterial(...args)}
      onApplyResult={onApplyResult}
    />
  )
}

describe('external AI handoff board', () => {
  let container: HTMLDivElement
  let root: Root
  /** 组件的命令式出口：模拟弹窗底部的「确认执行」按钮。 */
  let boardRef: { current: ExternalAiHandoffHandle | null }

  beforeEach(() => {
    useLocaleStore.setState({ locale: 'zh-CN', initialized: true })
    localStorage.removeItem(EXTERNAL_AI_AUDIT_STORAGE_KEY)
    useExternalAiAuditStore.setState({
      entries: [...DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES],
      materialSelection: { ...EXTERNAL_AI_FULL_SELECTION },
      delivery: 'inline',
    })
    mocks.buildMaterial.mockReset().mockResolvedValue({
      delivery: 'inline',
      text: ASSEMBLED_MATERIAL,
      files: [],
      writingSkillName: '连贯性审稿',
      characters: ASSEMBLED_MATERIAL.length,
      sectionSizes: [],
    })

    boardRef = { current: null }
    container = document.createElement('div')
    // 宽度对齐「AI 审稿确认」弹窗的内容区（约 400px），截图才有参考价值
    container.style.width = '100%'
    container.style.maxWidth = '400px'
    container.style.padding = '16px'
    container.style.boxSizing = 'border-box'
    container.style.background = 'var(--color-bg, #ffffff)'
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await act(async () => root.unmount())
    container.remove()
  })

  async function renderBoard(options: {
    /** 传 null 模拟「项目会话已失效」。 */
    reviewContext?: typeof REVIEW_CONTEXT | null
    /** 传 null 模拟「章节号还没解析出来」。 */
    chapterNumber?: number | null
    config?: typeof REFINE_HANDOFF_CONFIG
    onApplyResult?: (text: string) => void
    disabled?: boolean
  } = {}) {
    const context = options.reviewContext === undefined ? REVIEW_CONTEXT : options.reviewContext
    const chapterNumber = options.chapterNumber === null ? undefined : (options.chapterNumber ?? 3)
    boardRef.current = null
    await act(async () => root.render(
      <BoardHarness
        boardRef={boardRef}
        config={options.config}
        onApplyResult={options.onApplyResult}
        reviewContext={context}
        chapterNumber={chapterNumber}
        disabled={options.disabled}
      />,
    ))
  }

  /**
   * 选中某个入口，再按「确认执行」。
   *
   * 先生（流程重构）：卡片点了只切换选中，真正装配与打开由弹窗底部的按钮触发 ——
   * 这里就直接调组件的那个命令式出口。
   */
  async function selectAndLaunch(name: string) {
    await entryCard(name).click()
    await act(async () => { await boardRef.current?.launch() })
  }

  async function settleIcons() {
    try {
      await vi.waitFor(() => {
        const images = Array.from(container.querySelectorAll('img'))
        expect(images.every(image => image.complete)).toBe(true)
      }, { timeout: 5000, interval: 200 })
    } catch {
      // 图标拿不到时回退成首字母块，属于预期内的降级
    }
  }

  /** 截图只取板块自己那一块，并先清掉前面用例留下的 toast（否则会盖在画面上）。 */
  async function archiveBoardLayout(fileName: string) {
    document.getElementById('vela-toast-root')?.remove()
    await settleIcons()
    await page.elementLocator(container).screenshot({ path: `../../../../artifacts/${fileName}` })
  }

  it('lays the four cards out as a tidy 2x2 grid', async () => {
    await renderBoard()

    for (const name of ['DeepSeek', '豆包', '通义千问', 'Kimi']) {
      await expect.element(entryCard(name)).toBeVisible()
    }

    const grid = container.querySelector<HTMLElement>('.grid')
    expect(grid).not.toBeNull()
    expect(getComputedStyle(grid!).gridTemplateColumns.split(' ').filter(Boolean)).toHaveLength(2)

    const cards = Array.from(grid!.children) as HTMLElement[]
    expect(cards).toHaveLength(4)
    const tops = cards.map(card => Math.round(card.getBoundingClientRect().top))
    expect(tops[0]).toBe(tops[1])
    expect(tops[2]).toBe(tops[3])
    expect(tops[2]!).toBeGreaterThan(tops[0]!)
  })

  it('翻到第二页就能看见 ChatGPT 与 Gemini 那一组', async () => {
    await renderBoard()
    expect(container.textContent).not.toContain('ChatGPT')

    await page.getByRole('button', { name: '下一页', exact: true }).click()

    for (const name of ['ChatGPT', 'Gemini', '文心一言', '腾讯元宝']) {
      await expect.element(entryCard(name)).toBeVisible()
    }
    expect(container.textContent).toContain('2 / 2')
    expect(container.textContent).not.toContain('DeepSeek')

    await page.getByRole('button', { name: '上一页', exact: true }).click()
    await expect.element(entryCard('DeepSeek')).toBeVisible()
  })

  it('treats an entry card as a selectable box, not a launch button', async () => {
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)

    await renderBoard()
    const card = page.getByRole('checkbox', { name: 'DeepSeek', exact: true })
    await expect.element(card).not.toBeChecked()

    await card.click()
    await expect.element(card).toBeChecked()
    // 只是选中 —— 绝不该顺手把浏览器打开
    expect(openWindow).not.toHaveBeenCalled()

    await card.click()
    await expect.element(card).not.toBeChecked()
  })

  it('opens every selected entry in one go, with a single copy of the material', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)

    await renderBoard()
    await entryCard('DeepSeek').click()
    await entryCard('豆包').click()
    await act(async () => { await boardRef.current?.launch() })

    await vi.waitFor(() => expect(openWindow).toHaveBeenCalledTimes(2))
    expect(openWindow).toHaveBeenCalledWith('https://chat.deepseek.com/', '_blank', 'noopener')
    expect(openWindow).toHaveBeenCalledWith('https://www.doubao.com/chat/', '_blank', 'noopener')
    /*
      材料复制**只有一份** —— 选了五家也只贴一次。
      装配会被调两次（进外部模式时的预取 + 启动时的重新装配，保证用的是最新正文），
      这是刻意的：预取只为给先生看字数，真启动时必须重新取一遍。
    */
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(ASSEMBLED_MATERIAL)
    expect(mocks.buildMaterial).toHaveBeenCalledTimes(2)
  })

  it('hands the assembly the right context and sections', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.spyOn(window, 'open').mockImplementation(() => null)

    await renderBoard()
    await selectAndLaunch('DeepSeek')

    expect(mocks.buildMaterial).toHaveBeenCalledWith(expect.objectContaining({
      chapterTitle: '雾港的灯',
      chapterNumber: 3,
      draftContent: DRAFT_BODY,
      novelConfig: REVIEW_CONTEXT.novelConfig,
      writingLanguage: 'zh-CN',
      reviewFocus: '剧情连贯性、角色状态',
      locale: 'zh-CN',
      projectSession: REVIEW_CONTEXT.projectSession,
      projectPath: REVIEW_CONTEXT.projectPath,
    }))
  })

  it('preloads the material so the author sees the sizes before deciding', async () => {
    mocks.buildMaterial.mockResolvedValue({
      delivery: 'inline',
      text: ASSEMBLED_MATERIAL,
      files: [],
      writingSkillName: '连贯性审稿',
      characters: 4321,
      sectionSizes: [
        { label: '本章正文', characters: 3240 },
        { label: '已定稿剧情事实', characters: 8120 },
      ],
    })

    await renderBoard()

    /*
      预装配：先生一进外部模式就把材料装一遍，让材料面板直接显示各块字数 ——
      不用等他点了卡片才看得到（他提的「点第一个链接时就开始装配」）。
    */
    await vi.waitFor(() => expect(mocks.buildMaterial).toHaveBeenCalled())

    await page.getByRole('button', { name: '材料', exact: true }).click()
    await expect.element(page.getByLabelText('本章正文')).toBeVisible()
    expect(container.textContent).toContain('3240')
    expect(container.textContent).toContain('8120')
  })

  it('reports the skill and the size in the success toast', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.spyOn(window, 'open').mockImplementation(() => null)
    // 本次独有的字数，避免被前几个用例留下的 toast 蒙混过关
    mocks.buildMaterial.mockResolvedValue({
      delivery: 'inline',
      text: ASSEMBLED_MATERIAL,
      files: [],
      writingSkillName: '连贯性审稿',
      characters: 7777,
      sectionSizes: [],
    })

    await renderBoard()
    await selectAndLaunch('DeepSeek')

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('约 7777 字')
    })
    expect(document.body.textContent).toContain('连贯性审稿')
  })

  it('refuses to launch when the project session is gone', async () => {
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)

    await renderBoard({ reviewContext: null })
    await selectAndLaunch('DeepSeek')

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('项目会话已失效')
    })
    expect(mocks.buildMaterial).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('refuses to launch when the chapter number is not resolved yet', async () => {
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)

    await renderBoard({ chapterNumber: null })
    await selectAndLaunch('DeepSeek')

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('尚未解析出本章章节号')
    })
    expect(mocks.buildMaterial).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('surfaces an assembly failure instead of opening the site silently', async () => {
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)
    mocks.buildMaterial.mockRejectedValue(new Error('未找到审稿模板'))

    await renderBoard()
    await selectAndLaunch('DeepSeek')

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('装配材料失败')
    })
    expect(openWindow).not.toHaveBeenCalled()
  })

  it('goes inert when the board is disabled', async () => {
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null)

    await renderBoard({ disabled: true })

    /*
      灰态：执行方式没选「外部」时，整块不可交互 ——
      卡片是禁用状态，容器上挂着「禁止光标」那一层的类，
      而且**不会预取材料**（省一次数据库读取）。
    */
    await expect.element(entryCard('DeepSeek')).toBeDisabled()
    expect(container.querySelector('.handoff-board-disabled')).not.toBeNull()
    expect(openWindow).not.toHaveBeenCalled()
    expect(mocks.buildMaterial).not.toHaveBeenCalled()
  })

  it('lets the author untick a material block before copying', async () => {
    await renderBoard()
    await page.getByRole('button', { name: '材料', exact: true }).click()

    const worldBuilding = page.getByLabelText('世界观总纲')
    await expect.element(worldBuilding).toBeVisible()
    await worldBuilding.click()

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    vi.spyOn(window, 'open').mockImplementation(() => null)

    await selectAndLaunch('DeepSeek')

    expect(mocks.buildMaterial).toHaveBeenCalledWith(expect.objectContaining({
      sections: expect.objectContaining({ worldBuilding: false, chapterContent: true }),
    }))
  })

  it('never lets the review instructions be switched off', async () => {
    await renderBoard()
    await page.getByRole('button', { name: '材料', exact: true }).click()

    await expect.element(page.getByLabelText('审稿要求')).toBeDisabled()
  })

  it('applies the lean preset', async () => {
    await renderBoard()
    await page.getByRole('button', { name: '材料', exact: true }).click()
    await page.getByRole('button', { name: '精简', exact: true }).click()

    await vi.waitFor(() => {
      expect(useExternalAiAuditStore.getState().materialSelection.blueprints).toBe(false)
    })
    const selection = useExternalAiAuditStore.getState().materialSelection
    expect(selection.chapterContent).toBe(true)
    expect(selection.finalizedHistory).toBe(true)
    expect(selection.characterStates).toBe(true)
    expect(selection.reviewInstructions).toBe(true)
  })

  it('passes the chosen delivery mode to the assembly', async () => {
    await renderBoard()
    await page.getByRole('button', { name: '材料', exact: true }).click()
    await page.getByRole('button', { name: '.md 文件粘贴', exact: true }).click()

    vi.spyOn(window, 'open').mockImplementation(() => null)
    await selectAndLaunch('DeepSeek')

    expect(mocks.buildMaterial).toHaveBeenCalledWith(expect.objectContaining({ delivery: 'files' }))
  })

  it('adds a custom entry and pages over to it', async () => {
    await renderBoard()

    await page.getByRole('button', { name: '新建入口', exact: true }).click()
    await page.getByLabelText('入口名称').fill('智谱清言')
    await page.getByLabelText('入口链接').fill('chatglm.cn')
    await page.getByRole('button', { name: '添加', exact: true }).click()

    await expect.element(entryCard('智谱清言')).toBeVisible()
    expect(container.textContent).toContain('3 / 3')
    expect(useExternalAiAuditStore.getState().entries)
      .toHaveLength(DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.length + 1)
  })

  it('keeps a rejected link out of the list', async () => {
    await renderBoard()

    await page.getByRole('button', { name: '新建入口', exact: true }).click()
    await page.getByLabelText('入口名称').fill('坏东西')
    await page.getByLabelText('入口链接').fill('javascript:alert(1)')
    await page.getByRole('button', { name: '添加', exact: true }).click()

    expect(container.textContent).toContain('链接不对')
    expect(useExternalAiAuditStore.getState().entries)
      .toHaveLength(DEFAULT_EXTERNAL_AI_AUDIT_ENTRIES.length)
  })

  it('removes an entry from the grid', async () => {
    await renderBoard()

    await entryCard('Kimi').hover()
    await page.getByRole('button', { name: '删除入口「Kimi」', exact: true }).click()

    expect(useExternalAiAuditStore.getState().entries.map(entry => entry.name)).not.toContain('Kimi')
    await expect.element(page.getByRole('button', { name: '恢复默认入口', exact: true })).toBeVisible()
  })

  it('uses the bundled brand icons for the built-in entries', async () => {
    await renderBoard()

    for (const slug of ['deepseek', 'doubao', 'tongyi', 'kimi']) {
      expect(container.querySelector(`img[src*="${slug}"]`), `missing icon for ${slug}`).not.toBeNull()
    }
  })

  it('renders the revision board with its own material list and a paste-back lane', async () => {
    const applied: string[] = []
    await renderBoard({ config: REFINE_HANDOFF_CONFIG, onApplyResult: text => applied.push(text) })

    expect(container.textContent).toContain('外部 AI 修稿')
    await page.getByRole('button', { name: '材料', exact: true }).click()
    await expect.element(page.getByLabelText('文风要求')).toBeVisible()
    expect(container.textContent).toContain('本章信息')
    // 审稿专属的块不该出现在修稿面板里
    expect(container.textContent).not.toContain('世界观总纲')

    /*
      回流水路：先生从网页版把正文（常连代码块围栏一起）复制过来，
      交出去时要剥掉围栏 —— 否则三个反引号会跟着走进差异对比。
      注意这里只交文本：**真正的对比与合并由草稿编辑器那边打开**。
    */
    await page.getByRole('button', { name: '贴回改好的正文', exact: true }).click()
    await page.getByLabelText('把网页版改好的正文贴在这里').fill('```\n雾从港口漫上来，灯灭了。\n```')
    await page.getByRole('button', { name: '对比并合并', exact: true }).click()

    expect(applied).toEqual(['雾从港口漫上来，灯灭了。'])
  })

  it('strips a surrounding code fence but leaves the prose alone', () => {
    expect(stripCodeFence('```\n雾从港口漫上来。\n```')).toBe('雾从港口漫上来。')
    expect(stripCodeFence('```markdown\n雾从港口漫上来。\n```')).toBe('雾从港口漫上来。')
    expect(stripCodeFence('雾从港口漫上来。')).toBe('雾从港口漫上来。')
  })

  it('archives the default board layout', async () => {
    await renderBoard()
    await archiveBoardLayout('ext-ai-audit-board-default.png')
  })

  it('archives the revision board with its paste-back lane', async () => {
    await renderBoard({ config: REFINE_HANDOFF_CONFIG, onApplyResult: () => {} })

    await page.getByRole('button', { name: '材料', exact: true }).click()
    await expect.element(page.getByLabelText('文风要求')).toBeVisible()
    await page.getByRole('button', { name: '贴回改好的正文', exact: true }).click()
    await expect.element(page.getByLabelText('把网页版改好的正文贴在这里')).toBeVisible()

    await archiveBoardLayout('ext-ai-refine-board.png')
  })

  it('archives the materials menu under the v3 magazine skin', async () => {
    /*
      先生跑的就是 v3「时尚杂志」。这里把皮肤的三个开关照 App.tsx 的做法挂到
      <html> 上（data-ui / data-mag / data-v2-theme），否则测出来的配色与
      先生看到的完全不是一回事。
    */
    mocks.buildMaterial.mockResolvedValue({
      delivery: 'inline',
      text: ASSEMBLED_MATERIAL,
      files: [],
      writingSkillName: '连贯性审稿',
      characters: 4321,
      sectionSizes: [
        { label: '本章正文', characters: 3240 },
        { label: '已定稿剧情事实', characters: 8120 },
        { label: '角色状态', characters: 1050 },
        { label: '世界观总纲', characters: 640 },
      ],
    })

    const htmlRoot = document.documentElement
    htmlRoot.setAttribute('data-ui', 'v2')
    htmlRoot.setAttribute('data-mag', '1')
    htmlRoot.setAttribute('data-v2-theme', '1') // 「星汉」深色版
    htmlRoot.classList.add('galaxy')
    container.style.background = 'transparent'
    try {
      await renderBoard()
      await vi.waitFor(() => expect(mocks.buildMaterial).toHaveBeenCalled())
      await page.getByRole('button', { name: '材料', exact: true }).click()
      await expect.element(page.getByLabelText('世界观总纲')).toBeVisible()

      /*
        钉住两件曾经把先生坑过的事：
        1. 面板必须**真的有底** —— 背景变量写错一个名字就会整块透明，
           字像飘在背景上（先生说的「看不清」有它一份）；
        2. 文字色不能与这个底撞色。
      */
      const label = container.querySelector('[aria-label="世界观总纲"]')?.closest('label')
      const nameSpan = label?.querySelector('span') as Element
      const panel = nameSpan.closest('div[style*="border"]') as Element | null
      expect(panel).not.toBeNull()
      const panelBackground = getComputedStyle(panel as Element).backgroundColor
      expect(panelBackground).not.toBe('rgba(0, 0, 0, 0)')
      expect(getComputedStyle(nameSpan).color).not.toBe(panelBackground)

      await archiveBoardLayout('ext-ai-audit-materials-v3.png')
    } finally {
      htmlRoot.removeAttribute('data-ui')
      htmlRoot.removeAttribute('data-mag')
      htmlRoot.removeAttribute('data-v2-theme')
      htmlRoot.classList.remove('galaxy')
    }
  })
})
