import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ProjectData } from '../../../shared/ipc-channels'
import { useCharacterStore, type CharacterCard } from '../../../stores/character-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import CharacterEditor from '../CharacterEditor'

const PROJECT_PATH = 'C:\\novels\\relationship-editor'
const originalCharacterState = useCharacterStore.getState()
const originalLocaleState = useLocaleStore.getState()
const originalProjectState = useProjectStore.getState()

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

beforeEach(() => {
  useCharacterStore.setState(originalCharacterState)
  useLocaleStore.setState(originalLocaleState)
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState({ locale: 'zh-CN' })
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
})

describe('CharacterEditor relationship field', () => {
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
      selectedName: '沈砺',
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
      selectedName: '沈砺',
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
})
