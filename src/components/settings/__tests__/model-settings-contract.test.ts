import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8')
}

describe('model settings contract', () => {
  it('keeps the user-facing field vocabulary and provider options aligned in both settings surfaces', () => {
    const settingsModal = source('src/components/settings/SettingsModal.tsx')
    const modelSettings = source('src/components/settings/ModelSettings.tsx')

    for (const field of [
      ['model（模型名称）', 'model'],
      ['base_url', 'base_url'],
      ['API Key', 'API Key'],
      ["上下文窗口", 'Context Window'],
      ["最大输出 Tokens", 'Max Output Tokens'],
    ]) {
      expect(settingsModal).toContain(`text('${field[0]}', '${field[1]}')`)
      expect(modelSettings).toContain(`text('${field[0]}', '${field[1]}')`)
    }

    for (const provider of ['xai', 'siliconflow']) {
      expect(settingsModal).toContain(`value="${provider}"`)
      expect(modelSettings).toContain(`value="${provider}"`)
    }
  })

  it('creates new embedding profiles from the SiliconFlow preset and opens only fixed provider resources through IPC', () => {
    const settingsModal = source('src/components/settings/SettingsModal.tsx')
    const resourceController = source('electron/controllers/model-provider-resource-controller.ts')

    expect(settingsModal).toContain('createModelProfileDraft')
    expect(settingsModal).toContain("openModelProviderResource('siliconflow-invite')")
    expect(settingsModal).toContain("openModelProviderResource('siliconflow-console')")
    expect(settingsModal).toContain("openModelProviderResource('siliconflow-docs')")
    expect(settingsModal).toContain('邀请注册链接')
    expect(settingsModal).toContain('BAAI/bge-m3')
    expect(settingsModal).toContain('免费')
    expect(settingsModal).not.toContain('window.open(')
    expect(settingsModal).not.toContain('shell.openExternal')
    expect(resourceController).toContain('MODEL_PROVIDER_RESOURCE_URLS[resource]')
  })
})
