import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import ReasoningPolicySettings from '../ReasoningPolicySettings'
import { useLocaleStore } from '../../../stores/locale-store'
import { useProjectStore } from '../../../stores/project-store'
import type { ModelProfile } from '../../../shared/ipc-channels'

const originalProjectState = useProjectStore.getState()
const originalLocaleState = useLocaleStore.getState()

const grok: ModelProfile = {
  id: 'grok-4.5',
  name: 'Grok 4.5',
  provider: 'xai',
  protocol: 'openai',
  modelName: 'grok-4.5',
  apiKey: 'test-key',
  baseUrl: 'https://api.x.ai/v1',
  temperature: 0.7,
  maxTokens: 8192,
  purposes: ['generation'],
  reasoningOverride: 'max',
}

afterEach(() => {
  useProjectStore.setState(originalProjectState)
  useLocaleStore.setState(originalLocaleState)
})

describe('reasoning policy settings', () => {
  it('shows both persistence scopes and the requested-to-effective result', () => {
    useLocaleStore.setState({ locale: 'zh-CN' })
    useProjectStore.setState({
      currentProject: {
        id: 'project-a',
        name: 'Novel A',
        path: 'C:/projects/A',
        sessionLease: 'lease-a',
        novelConfig: {
          creativeStrategy: 'deep-planning',
          genre: 'fantasy', subGenre: '', targetAudience: 'all', totalChapters: 100,
          wordsPerChapter: 3000, plotStructure: 'three_act', narrativePOV: 'third_limited',
          coreOutline: '', worldSetting: '', goldenFinger: '', protagonistProfile: '', globalGuidance: '',
        },
        characterStates: '',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
    })

    const markup = renderToStaticMarkup(
      <ReasoningPolicySettings model={grok} onModelChange={() => {}} />,
    )

    expect(markup).toContain('创作策略（当前项目）')
    expect(markup).toContain('流畅起草')
    expect(markup).toContain('一致性优先')
    expect(markup).toContain('深度规划')
    expect(markup).toContain('模型推理覆盖（高级）')
    expect(markup).toContain('最高 → 高')
    expect(markup).toContain('已限制')
    expect(markup).toContain('关闭')
    expect(markup).toContain('低')
    expect(markup).toContain('中')
    expect(markup).toContain('高')
    expect(markup).toContain('最高')
  })

  it('localizes every reasoning override effort in English', () => {
    useLocaleStore.setState({ locale: 'en-US' })

    const markup = renderToStaticMarkup(
      <ReasoningPolicySettings model={grok} onModelChange={() => {}} />,
    )

    expect(markup).toContain('>Off<')
    expect(markup).toContain('>Low<')
    expect(markup).toContain('>Medium<')
    expect(markup).toContain('>High<')
    expect(markup).toContain('>Max<')
    expect(markup).toContain('Max → High')
  })
})
