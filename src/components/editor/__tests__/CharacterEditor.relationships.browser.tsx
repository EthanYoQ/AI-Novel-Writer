import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../../styles/redesign/v2-index.css'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useCharacterStore, type CharacterCard } from '../../../stores/character-store'
import { useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import { useUiVersionStore } from '../../../stores/ui-version-store'
import CharacterEditor from '../CharacterEditor'

const PROJECT_PATH = 'C:\\novels\\relationship-editor'
const originalCharacterState = useCharacterStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
const originalUiVersionState = useUiVersionStore.getState()
const originalEditorState = useEditorStore.getState()

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

function project(): ProjectData {
  return {
    id: 'relationship-editor',
    sessionLease: 'relationship-editor-lease',
    name: '关系网测试项目',
    path: PROJECT_PATH,
    novelConfig: {
      genre: '玄幻',
      subGenre: '',
      targetAudience: '全龄',
      totalChapters: 10,
      wordsPerChapter: 3000,
      plotStructure: 'three_act',
      narrativePOV: 'third_limited',
      coreOutline: '',
      worldSetting: '',
      goldenFinger: '',
      protagonistProfile: '',
      globalGuidance: '',
    },
    characterStates: '',
    createdAt: '',
    updatedAt: '',
  }
}

function character(name: string, relationships = ''): CharacterCard {
  return {
    name,
    role: 'supporting',
    gender: '',
    age: '',
    appearance: '',
    personality: '',
    background: '',
    abilities: '',
    motivation: '',
    relationships,
    arc: '',
    notes: '',
  }
}

/**
 * 受控 textarea 上的原生键入：React 19 只从 DOM 的 input 事件取新值，
 * 所以先按浏览器插入字符后的样子写好 value、再派发 input —— 与真人敲键
 * （尤其按回车插入换行）留下的 DOM 状态一致。
 */
async function typeInto(field: HTMLTextAreaElement, nextValue: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(field, nextValue)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  // 图谱是「画布 + 318px 右侧人物简介」的两栏版式：视口太窄时左侧画布会被挤没，
  // 缩放工具条也就无从点击。给一个真实窗口尺寸，测的才是产品里的样子。
  await page.viewport(1280, 900)
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useUiVersionStore.setState(originalUiVersionState)
  useLocaleStore.setState({ locale: 'zh-CN' })
  // 图谱是独立标签，开标签会写 editor store —— 每个用例都从干净的标签栏开始。
  useEditorStore.setState({ ...originalEditorState, tabs: [], activeTabId: null })
  // v2「墨纸书斋」的图谱是移植自设计 demo 的 DOM 版，这里显式钉住，避免受本机
  // 持久化的界面版本影响；皮肤令牌挂在 html[data-ui='v2'] 上，与真实运行一致。
  useUiVersionStore.setState({ uiVersion: 'v2' })
  document.documentElement.setAttribute('data-ui', 'v2')
  useProjectStore.setState({ currentProject: project(), fileTree: [], loading: false })
  useCharacterStore.setState({
    characters: [
      character('沈砺', JSON.stringify([
        {
          target: '陆云飞',
          relation: '关系类型：竞争对手；矛盾张力：权力斗争；情感连接：无',
        },
      ])),
      character('陆云飞'),
    ],
    selectedName: '沈砺',
    dataProjectKey: PROJECT_PATH,
    loadingProjectKey: null,
    lastError: null,
    saving: false,
    identityBusy: false,
    rosterRevision: 1,
    dataProjectSession: {
      projectId: 'relationship-editor',
      leaseId: 'relationship-editor-lease',
      projectPath: PROJECT_PATH,
    },
  })
  container = document.createElement('div')
  // 图谱按容器高度铺满（.relation-view{height:100%}），给一个真实窗口尺寸，
  // 否则画布与工具条会塌成 0 高。宽度特意取 1400px —— 大于页头的 1024px 上限，
  // 这样「页头是否被 318px 的右侧简介栏挤偏」才测得出来。
  container.style.width = '1400px'
  container.style.height = '700px'
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useUiVersionStore.setState(originalUiVersionState)
  useEditorStore.setState({ ...originalEditorState, tabs: [], activeTabId: null })
  document.documentElement.removeAttribute('data-ui')
})

describe('CharacterEditor relationship field', () => {
  it('renders persisted structured relationships as prose rather than raw JSON', async () => {
    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })

    // 进入页面默认是阅览态（与 demo 一致）；关系字段的输入框只在点「编辑档案」后才出现。
    await act(async () => {
      await page.getByRole('button', { name: '编辑档案' }).click()
    })

    const relationshipField = Array.from(container?.querySelectorAll('textarea') ?? [])
      .find((field) => field.placeholder.includes('每行一位角色'))

    expect(relationshipField?.value).toBe(
      '陆云飞：竞争对手（权力斗争；情感连接：无）',
    )
    expect(relationshipField?.value).not.toContain('[{')
  })

  /**
   * 先生反馈：关系网里换不了行 —— 第一行写完按回车，第二行写不出来。
   * 根因是输入框的值每一帧都从结构化存储重新派生，而作者打字必然经过
   * 「刚敲完一行、正要换到下一行」的中间态：行尾那个换行在
   * 「结构化 → 逐行文本」的往返转换中被吃掉。编辑态必须由本地草稿承接原文。
   */
  it('keeps the line break the author just typed in the relationship field', async () => {
    useCharacterStore.setState({
      characters: [
        character('沈砺', JSON.stringify([{ target: '陆云飞', relation: '竞争对手' }])),
        character('陆云飞'),
        character('苏绾'),
      ],
      selectedName: '沈砺',
    })

    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })
    await act(async () => {
      await page.getByRole('button', { name: '编辑档案' }).click()
    })

    // 每次都重新取节点：受控值回退时 React 可能重设 DOM，但节点本身复用。
    const relationshipField = () => Array.from(container?.querySelectorAll('textarea') ?? [])
      .find((field) => field.placeholder.includes('每行一位角色')) as HTMLTextAreaElement
    expect(relationshipField()).toBeTruthy()

    // 作者的手：敲完第一行，按回车准备写第二行。
    await typeInto(relationshipField(), '陆云飞：竞争对手\n')
    expect(relationshipField().value).toBe('陆云飞：竞争对手\n')

    await typeInto(relationshipField(), '陆云飞：竞争对手\n苏绾：导师')

    // 两行都写全后，存储里是两条结构化关系；界面仍显示作者逐行敲的原文。
    const stored = useCharacterStore.getState().characters
      .find(card => card.name === '沈砺')?.relationships ?? ''
    expect(JSON.parse(stored)).toEqual([
      { target: '陆云飞', relation: '竞争对手' },
      { target: '苏绾', relation: '导师' },
    ])
    expect(relationshipField().value).toBe('陆云飞：竞争对手\n苏绾：导师')
  })

  /**
   * 草稿只属于它所在的编辑会话：取消编辑再进来，看到的必须是档案里的值，
   * 不能把上一轮的原文（尤其那个没提交的换行）带进新一轮编辑。
   */
  it('drops the relationship draft when the edit session ends', async () => {
    useCharacterStore.setState({
      characters: [
        character('沈砺', JSON.stringify([{ target: '陆云飞', relation: '竞争对手' }])),
        character('陆云飞'),
      ],
      selectedName: '沈砺',
    })

    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })
    await act(async () => {
      await page.getByRole('button', { name: '编辑档案' }).click()
    })

    const relationshipField = () => Array.from(container?.querySelectorAll('textarea') ?? [])
      .find((field) => field.placeholder.includes('每行一位角色')) as HTMLTextAreaElement

    await typeInto(relationshipField(), '陆云飞：竞争对手\n')
    expect(relationshipField().value).toBe('陆云飞：竞争对手\n')

    await act(async () => {
      await page.getByRole('button', { name: '取消' }).click()
    })
    await act(async () => {
      await page.getByRole('button', { name: '编辑档案' }).click()
    })

    expect(relationshipField().value).toBe('陆云飞：竞争对手')
  })

  it('shows repair guidance instead of an unknown persisted JSON object', async () => {
    const unknownJson = '[{"participant":"陆云飞","status":"待确认"}]'
    useCharacterStore.setState({
      characters: [character('沈砺', unknownJson), character('陆云飞')],
      selectedName: '沈砺',
    })

    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })

    // 进入页面默认是阅览态（与 demo 一致）；关系字段的输入框只在点「编辑档案」后才出现。
    await act(async () => {
      await page.getByRole('button', { name: '编辑档案' }).click()
    })

    const relationshipField = Array.from(container?.querySelectorAll('textarea') ?? [])
      .find((field) => field.placeholder.includes('每行一位角色'))

    expect(relationshipField?.value).toContain('关系数据格式无法识别')
    expect(relationshipField?.value).toContain('角色：关系')
    expect(relationshipField?.value).not.toContain('Relationship data format is unrecognized')
    expect(relationshipField?.value).not.toContain(unknownJson)
    expect(relationshipField?.value).not.toContain('[{')
  })

  it('uses English repair guidance when the UI locale is English', async () => {
    const unknownJson = '[{"participant":"陆云飞","status":"待确认"}]'
    useLocaleStore.setState({ locale: 'en-US' })
    useCharacterStore.setState({
      characters: [character('沈砺', unknownJson), character('陆云飞')],
      selectedName: '沈砺',
    })

    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })

    // 进入页面默认是阅览态（与 demo 一致）；关系字段的输入框只在点「编辑档案」后才出现。
    await act(async () => {
      await page.getByRole('button', { name: 'Edit profile' }).click()
    })

    const relationshipField = Array.from(container?.querySelectorAll('textarea') ?? [])
      .find((field) => field.placeholder.includes('One character per line'))

    expect(relationshipField?.value).toContain('Relationship data format is unrecognized')
    expect(relationshipField?.value).toContain('Character: relationship')
    expect(relationshipField?.value).not.toContain(unknownJson)
  })

  /**
   * 先生（头像行规格）：头像框放大 30%（58 → 75px），整行「头像框 + 角色名 +
   * 灰色注释」往右移 20px。真实尺寸来自 CSS（.character-avatar-wrap）与
   * CharacterEditor 里的 AVATAR_SIZE / AVATAR_ROW_INDENT，这条守住两者不脱节。
   */
  it('enlarges the profile avatar and indents the whole row', async () => {
    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })

    const wrap = container?.querySelector<HTMLElement>('.character-avatar-wrap')
    expect(wrap).not.toBeNull()
    expect(getComputedStyle(wrap as HTMLElement).width).toBe('75px')
    expect(getComputedStyle(wrap as HTMLElement).height).toBe('75px')

    const initial = wrap?.querySelector('span')
    expect(getComputedStyle(initial as HTMLElement).width).toBe('75px')
    expect(getComputedStyle(initial as HTMLElement).fontSize).toBe('34px')

    // 头像框的父元素就是那一整行，它带着姓名与灰色注释一起右移。
    const row = wrap?.parentElement as HTMLElement
    expect(getComputedStyle(row).marginLeft).toBe('20px')
    expect(row.textContent).toContain('沈砺')
    expect(row.textContent).toContain('配角')
  })

  /**
   * 先生：关系图谱该是独立的一栏 —— 塞在人物档案里，打开之后就回不去档案了。
   * 这条用例守的就是「点关系图谱 → 开/激活一个独立标签，档案标签原地不动」。
   * 图谱页面自己的行为（画布、缩放、右侧简介、清空全员）在 RelationsEditor 的用例里测。
   */
  it('opens the relationship graph as its own tab and leaves the profile tab untouched', async () => {
    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })

    // 人物档案在真实产品里由左栏/页面入口开成标签，这里先把它摆上。
    await act(async () => {
      useEditorStore.getState().openFile({
        id: 'character-editor',
        name: '人物档案',
        type: 'character',
        projectKey: PROJECT_PATH,
      })
    })

    await act(async () => page.getByRole('button', { name: '关系图谱' }).click())

    const state = useEditorStore.getState()
    const graphTab = state.tabs.find(tab => tab.type === 'relationship-graph')
    expect(graphTab).toBeTruthy()
    expect(graphTab?.name).toBe('人物关系图谱')
    expect(state.activeTabId).toBe(graphTab?.id)
    // 人物档案标签还在标签栏里 —— 这就是「能回退」的含义。
    expect(state.tabs.some(tab => tab.type === 'character')).toBe(true)

    // 反复点不会堆出第二个图谱页（固定 id = 同一页面只留一个标签）。
    await act(async () => page.getByRole('button', { name: '关系图谱' }).click())
    expect(useEditorStore.getState().tabs.filter(tab => tab.type === 'relationship-graph')).toHaveLength(1)
    expect(useEditorStore.getState().tabs.filter(tab => tab.type === 'character')).toHaveLength(1)
  })
})
