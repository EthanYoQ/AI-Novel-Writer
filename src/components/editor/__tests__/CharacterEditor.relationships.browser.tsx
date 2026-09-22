import CharactersView from '../../panels/sidebar/CharactersView'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../../shared/project-session-context'
import { useCharacterStore, type CharacterCard } from '../../../stores/character-store'
import { saveDirtyEditorChangesForExit, useEditorStore } from '../../../stores/editor-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import CharacterEditor from '../CharacterEditor'

const PROJECT_PATH = 'C:\\novels\\relationship-editor'
const originalCharacterState = useCharacterStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()
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
    characterId: `id:${name}`,
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

beforeEach(() => {
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project(), fileTree: [], loading: false })
  setActiveProjectSessionContext({
    projectId: 'relationship-editor',
    leaseId: 'relationship-editor-lease',
    projectPath: PROJECT_PATH,
  })
  useCharacterStore.setState({
    characters: [
      character('沈砺', JSON.stringify([
        {
          target: '陆云飞', targetCharacterId: 'id:陆云飞',
          relation: '关系类型：竞争对手；矛盾张力：权力斗争；情感连接：无',
        },
      ])),
      character('陆云飞'),
    ],
    selectedId: 'id:沈砺', selectedName: '沈砺',
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
  useEditorStore.setState(originalEditorState, true)
  setActiveProjectSessionContext(null)
  delete window.aiNovelAPI
})

describe('CharacterEditor relationship field', () => {
  it('shows unsaved feedback for the character auxiliary page without a character tab', async () => {
    useEditorStore.setState({ tabs: [], activeTabId: null, draftLedgers: {} })
    await act(async () => root?.render(<CharacterEditor projectKey={PROJECT_PATH} />))

    const nameInput = [...container!.querySelectorAll('input')].find(input => input.value === '沈砺')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, '沈砺二')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(useEditorStore.getState().tabs).toHaveLength(0)
    expect(JSON.parse(useEditorStore.getState().draftLedgers['character-editor-drafts']).projects[0].projectKey).toBe(PROJECT_PATH)
    await expect.element(page.getByRole('status').filter({ hasText: '未保存' })).toBeVisible()
  })

  it('renders persisted structured relationships as prose rather than raw JSON', async () => {
    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })

    const relationshipField = Array.from(container?.querySelectorAll('textarea') ?? [])
      .find((field) => field.placeholder.includes('每行一位角色'))

    expect(relationshipField?.value).toBe(
      '陆云飞：竞争对手（权力斗争；情感连接：无）',
    )
    expect(relationshipField?.value).not.toContain('[{')
  })

  it('shows repair guidance instead of an unknown persisted JSON object', async () => {
    const unknownJson = '[{"participant":"陆云飞","status":"待确认"}]'
    useCharacterStore.setState({
      characters: [character('沈砺', unknownJson), character('陆云飞')],
      selectedId: 'id:沈砺', selectedName: '沈砺',
    })

    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
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
      selectedId: 'id:沈砺', selectedName: '沈砺',
    })

    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })

    const relationshipField = Array.from(container?.querySelectorAll('textarea') ?? [])
      .find((field) => field.placeholder.includes('One character per line'))

    expect(relationshipField?.value).toContain('Relationship data format is unrecognized')
    expect(relationshipField?.value).toContain('Character: relationship')
    expect(relationshipField?.value).not.toContain(unknownJson)
  })

  it('zooms the relationship graph with controls and the mouse wheel, then fits the view', async () => {
    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })

    await act(async () => page.getByRole('button', { name: '关系图谱' }).click())
    await expect.element(page.getByText('100%')).toBeVisible()

    await act(async () => page.getByRole('button', { name: '放大关系图谱' }).click())
    await expect.element(page.getByText('110%')).toBeVisible()

    const canvas = container?.querySelector('canvas')
    expect(canvas).toBeTruthy()
    await act(async () => {
      canvas?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
    })
    await expect.element(page.getByText('120%')).toBeVisible()

    await act(async () => page.getByRole('button', { name: '适合视图' }).click())
    await expect.element(page.getByText('200%')).toBeVisible()
  })

  it('requires confirmation before clearing every character through the roster action', async () => {
    const clearAllCharacters = vi.fn().mockResolvedValue(true)
    useCharacterStore.setState({ clearAllCharacters })
    await act(async () => {
      root?.render(<CharacterEditor projectKey={PROJECT_PATH} />)
    })

    await act(async () => page.getByRole('button', { name: '关系图谱' }).click())
    await act(async () => page.getByRole('button', { name: '删除全部角色与关系' }).click())
    await expect.element(page.getByRole('dialog')).toBeVisible()
    expect(clearAllCharacters).not.toHaveBeenCalled()

    await act(async () => {
      await page.getByRole('button', { name: '取消' }).click()
      await new Promise(resolve => setTimeout(resolve, 220))
    })
    expect(clearAllCharacters).not.toHaveBeenCalled()

    await act(async () => page.getByRole('button', { name: '删除全部角色与关系' }).click())
    await act(async () => {
      await page.getByRole('button', { name: '确认删除全部' }).click()
      await new Promise(resolve => setTimeout(resolve, 220))
    })
    expect(clearAllCharacters).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.objectContaining({
        projectId: 'relationship-editor',
        leaseId: 'relationship-editor-lease',
      }),
    )
  })

  it('propagates character save failure to the exit gate', async () => {
    useCharacterStore.setState({
      saveAll: vi.fn(async () => { throw new Error('角色写入失败') }),
    })
    useEditorStore.setState({
      tabs: [{ id: 'character-exit', name: '角色档案', type: 'character', projectKey: PROJECT_PATH, dirty: true }],
      activeTabId: 'character-exit',
      draftLedgers: {},
    })
    await act(async () => root?.render(<CharacterEditor projectKey={PROJECT_PATH} />))

    let failure: unknown
    await act(async () => {
      try { await saveDirtyEditorChangesForExit(PROJECT_PATH) } catch (error) { failure = error }
    })
    expect(failure).toEqual(expect.objectContaining({ message: '角色写入失败' }))
    expect(useEditorStore.getState().tabs[0].dirty).toBe(true)
    expect(container?.textContent).toContain('保存失败')
  })

  it('previews, cancels, removes and replaces an avatar only through the profile save owner', async () => {
    const order: string[] = []
    const saveAll = vi.fn(async () => { order.push('profile') })
    const oldAvatar = { characterId: 'id:沈砺', assetRevision: 1, mime: 'image/png' as const, base64: btoa('old') }
    const newAvatar = { characterId: 'id:沈砺', assetRevision: 2, mime: 'image/png' as const, base64: btoa('new') }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'character-avatar:read-batch') return { success: true, avatars: [oldAvatar] }
      if (channel === 'character-avatar:choose') return { success: true, cancelled: false, image: { ...newAvatar, assetRevision: undefined } }
      if (channel === 'character-avatar:commit') { order.push('avatar'); return { success: true, avatar: newAvatar } }
      if (channel === 'character-avatar:remove') { order.push('remove'); return { success: true } }
      throw new Error(`unexpected ${channel}`)
    })
    window.aiNovelAPI = { invoke } as unknown as typeof window.aiNovelAPI
    useCharacterStore.setState({ saveAll })
    await act(async () => { root?.render(<CharacterEditor projectKey={PROJECT_PATH} />); await Promise.resolve() })

    await expect.element(page.getByRole('button', { name: '替换头像' })).toBeVisible()
    await act(async () => page.getByRole('button', { name: '替换头像' }).click())
    expect(invoke.mock.calls.some(([channel]) => channel === 'character-avatar:commit')).toBe(false)
    await expect.element(page.getByText('头像更改将在保存角色档案时提交。')).toBeVisible()
    await act(async () => page.getByRole('button', { name: '取消头像更改' }).click())
    await act(async () => page.getByRole('button', { name: '移除头像' }).click())
    expect(container?.querySelector('img[alt="沈砺头像预览"]')).toBeNull()
    await act(async () => page.getByRole('button', { name: '取消头像更改' }).click())
    expect(container?.querySelector('img[alt="沈砺头像预览"]')).not.toBeNull()
    await act(async () => page.getByRole('button', { name: '替换头像' }).click())
    await act(async () => page.getByRole('button', { name: '保存', exact: true }).click())
    expect(order).toEqual(['profile', 'avatar'])
    expect(saveAll).toHaveBeenCalledWith(PROJECT_PATH)
  })

  it('shows an avatar failure without claiming that saved profile fields or the old avatar were lost', async () => {
    const saveAll = vi.fn().mockResolvedValue(undefined)
    const oldAvatar = { characterId: 'id:沈砺', assetRevision: 1, mime: 'image/png' as const, base64: btoa('old') }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'character-avatar:read-batch') return { success: true, avatars: [oldAvatar] }
      if (channel === 'character-avatar:choose') return { success: true, cancelled: false, image: { characterId: 'id:沈砺', mime: 'image/png', base64: btoa('new') } }
      if (channel === 'character-avatar:commit') return { success: false, error: { code: 'AVATAR_SAVE_FAILED', message: '头像保存失败，原头像保持不变。' } }
      throw new Error(`unexpected ${channel}`)
    })
    window.aiNovelAPI = { invoke } as unknown as typeof window.aiNovelAPI
    useCharacterStore.setState({ saveAll })
    await act(async () => { root?.render(<CharacterEditor projectKey={PROJECT_PATH} />); await Promise.resolve() })
    await act(async () => page.getByRole('button', { name: '替换头像' }).click())
    await act(async () => page.getByRole('button', { name: '保存', exact: true }).click())
    expect(saveAll).toHaveBeenCalled()
    await expect.element(page.getByText('头像保存失败，原头像保持不变。', { exact: true })).toBeVisible()
    expect(container?.textContent).toContain('保存失败')
  })
})

it('实际列表同名两人选择与编辑按ID，改名不切换另一张卡', async () => {
 useCharacterStore.setState({ characters: [{ ...character('同名'), characterId: '甲ID', notes: '甲作者' }, { ...character('同名'), characterId: '乙ID', notes: '乙作者' }], selectedId: '甲ID', selectedName: '同名' })
 await act(async () => root!.render(<><CharactersView /><CharacterEditor projectKey={PROJECT_PATH} /></>))
 await act(async () => (container!.querySelector('[data-character-id="乙ID"]') as HTMLElement).click())
 expect(useCharacterStore.getState().selectedId).toBe('乙ID')
 await page.getByPlaceholder('输入备注...').fill('仅乙修改')
 expect(useCharacterStore.getState().characters.map(c => c.notes)).toEqual(['甲作者', '仅乙修改'])
 const nameInput = [...container!.querySelectorAll('input')].find(input => input.value === '同名')!
 await act(async () => {
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, '新乙名')
   nameInput.dispatchEvent(new Event('input', { bubbles: true }))
 })
 expect(useCharacterStore.getState().selectedId).toBe('乙ID')
 expect(useCharacterStore.getState().characters.map(c => c.name)).toEqual(['同名', '新乙名'])
})
