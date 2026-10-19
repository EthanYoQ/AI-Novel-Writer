import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { Save, Settings2, Zap, Eye, EyeOff, ChevronDown, RefreshCw, RotateCcw } from 'lucide-react'
import { useLLMStore } from '../../stores/llm-store'
import type { DiscoveredModel, ModelDiscoveryErrorCode, ModelProfile } from '../../shared/ipc-channels'
import { LOW_VRAM_EMBEDDING_OPTIONS, normalizeEmbeddingOptions } from '../../shared/embedding-options'
import type { ModelCapabilities, ProviderPreset } from '../../shared/provider-presets'
import { resolveModelProfileBudgetCapabilities } from '../../shared/provider-presets'
import { applyModelProfileSelection, DEFAULT_GENERATION_OUTPUT_TOKENS, modelCapabilitySource } from '../../shared/model-profile-draft'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'
import { cn } from '../../lib/utils'
import { useLocaleStore } from '../../stores/locale-store'
import { ModelReasoningOverrideSettings, ModelCapabilitySources, ProjectCreativeStrategySettings } from './ReasoningPolicySettings'
import { ChatgptPlanAccount } from './ChatgptPlanAccount'
import { openModelProviderResource } from './model-provider-resource'

/** 模型编辑表单 */
export function ModelForm({
  model, onChange, onSave, onCancel, saving, presets,
}: {
  model: ModelProfile
  onChange: (m: ModelProfile) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  purposeOptions: ModelProfile['purposes']
  /** 服务商预设（来自 BUILTIN_PRESETS 常量） */
  presets: ProviderPreset[]
}) {
  const text = useLocaleStore(s => s.text)
  const [showKey, setShowKey] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  // 标记"模型标识"是否使用自定义输入模式
  const [customModelName, setCustomModelName] = useState(false)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean, error?: string } | null>(null)
  const testConnection = useLLMStore(s => s.testConnection)
  const discoverModels = useLLMStore(s => s.discoverModels)
  const [discovering, setDiscovering] = useState(false)
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([])
  const [discoveryNotice, setDiscoveryNotice] = useState<ModelDiscoveryErrorCode | null>(null)
  const discoveryRevision = useRef(0)
  const currentDiscoveryConfig = useRef({
    id: model.id,
    provider: model.provider,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
  })

  useLayoutEffect(() => {
    currentDiscoveryConfig.current = {
      id: model.id,
      provider: model.provider,
      protocol: model.protocol,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
    }
  }, [model.apiKey, model.baseUrl, model.id, model.protocol, model.provider])

  useEffect(() => () => {
    discoveryRevision.current += 1
  }, [])

  const invalidateDiscovery = () => {
    discoveryRevision.current += 1
    setDiscovering(false)
    setDiscoveredModels([])
    setDiscoveryNotice(null)
  }

  const isChatgptPlan = model.provider === 'chatgpt-plan'
  const isEmbedding = model.purposes?.includes('embedding')
  const embeddingOptions = normalizeEmbeddingOptions(model.embeddingOptions)
  // 将预设数组转换为以 provider 为键的 Map 方便查找
  const presetMap = new Map(presets.map((p) => [p.provider, p]))
  const preset = presetMap.get(model.provider)
  const capabilitiesForPresetModel = (modelName: string) => isEmbedding
    ? preset?.embeddingModelCapabilities?.[modelName]
    : preset?.models.find((candidate) => candidate.name === modelName)?.capabilities
  // 生成模型列表为 ModelPreset[]，embedding 模型为 string列表转换过来的 ModelPreset
  const presetModels: import('../../shared/provider-presets').ModelPreset[] = isEmbedding
    ? (preset?.embeddingModels ?? []).map((name) => ({
        name,
        maxTokens: 0,
        capabilities: capabilitiesForPresetModel(name),
      }))
    : (preset?.models ?? [])

  /** 更新单个字段 */
  const up = <K extends keyof ModelProfile>(key: K, val: ModelProfile[K]) => {
    if (key === 'provider' || key === 'protocol' || key === 'baseUrl' || key === 'apiKey') {
      invalidateDiscovery()
    }
    onChange(!isEmbedding && ['modelName', 'baseUrl', 'protocol', 'provider'].includes(key)
      ? applyModelProfileSelection(model, { [key]: val }) : { ...model, [key]: val })
  }

  const currentCapabilities: ModelCapabilities = {
    contextWindowTokens: model.capabilities?.contextWindowTokens ?? null,
    maxOutputTokens: model.capabilities?.maxOutputTokens ?? model.maxTokens,
    reasoning: model.capabilities?.reasoning ?? false,
    structuredOutput: model.capabilities?.structuredOutput ?? false,
    usage: model.capabilities?.usage ?? false,
  }
  const providerOutputLimit = resolveModelProfileBudgetCapabilities(model)?.maxOutputTokens
  const outputLimits = [model.maxTokens, currentCapabilities.maxOutputTokens, providerOutputLimit]
    .filter((value): value is number => Number.isSafeInteger(value) && Number(value) > 0)
  const effectiveOutputLimit = outputLimits.length ? Math.min(...outputLimits) : null
  const contextOutputConflict = !isEmbedding
    && currentCapabilities.contextWindowTokens !== null
    && currentCapabilities.contextWindowTokens > 0
    && effectiveOutputLimit !== null
    && effectiveOutputLimit >= currentCapabilities.contextWindowTokens

  const updateCapabilities = (next: Partial<ModelCapabilities>) => {
    const capabilities = { ...currentCapabilities, ...next }
    const capabilitySources: NonNullable<ModelProfile['capabilitySources']> = {}
    for (const key of Object.keys(currentCapabilities) as Array<keyof ModelCapabilities>) {
      capabilitySources[key] = key in next ? 'manual' : modelCapabilitySource(model, key)
    }
    onChange({ ...model, capabilities, capabilitySources })
  }

  const resetAdvancedSettings = () => {
    const defaultMaxOutputTokens = Math.min(providerOutputLimit ?? DEFAULT_GENERATION_OUTPUT_TOKENS, DEFAULT_GENERATION_OUTPUT_TOKENS)
    const capabilitySources: NonNullable<ModelProfile['capabilitySources']> = {}
    for (const key of Object.keys(currentCapabilities) as Array<keyof ModelCapabilities>) {
      capabilitySources[key] = modelCapabilitySource(model, key)
    }
    onChange({
      ...model,
      temperature: 0.7,
      maxTokens: defaultMaxOutputTokens,
      capabilities: { ...currentCapabilities, maxOutputTokens: providerOutputLimit ?? DEFAULT_GENERATION_OUTPUT_TOKENS },
      capabilitySources: { ...capabilitySources, maxOutputTokens: providerOutputLimit === undefined ? 'unknown' : 'preset' },
      reasoningOverride: 'auto',
      reasoningMapping: undefined,
    })
  }

  /**
   * 切换服务商：从持久化预设中自动填充 baseUrl / protocol
   * 并将模型名重置为该服务商的第一个预设模型
   */
  const handleProviderChange = (provider: ModelProfile['provider']) => {
    const p = presetMap.get(provider)
    const firstModel = isEmbedding ? null : (p?.models[0] ?? null)
    const defaultModelName = isEmbedding
      ? (p?.embeddingModels[0] ?? '')
      : (firstModel?.name ?? '')
    const capabilities = isEmbedding
      ? p?.embeddingModelCapabilities?.[defaultModelName]
      : firstModel?.capabilities
    setCustomModelName(false)
    invalidateDiscovery()
    const selection = {
      ...model,
      provider,
      protocol: (p?.protocol ?? 'openai') as 'openai' | 'gemini',
      baseUrl: p?.baseUrl ?? '',
      modelName: defaultModelName,
      maxTokens: capabilities?.maxOutputTokens ?? firstModel?.maxTokens ?? 4096,
      capabilities: capabilities ? { ...capabilities } : undefined,
    }
    const updated = isEmbedding ? selection : applyModelProfileSelection(model, {
      provider, protocol: selection.protocol, baseUrl: selection.baseUrl, modelName: selection.modelName,
    })
    onChange(provider === 'chatgpt-plan' ? { ...updated, apiKey: '' } : updated)
  }

  /** 选择预设模型或切换到自定义输入 */
  const handleModelSelect = (val: string) => {
    if (val === '__custom__') {
      setCustomModelName(true)
      up('modelName', '')
    } else {
      setCustomModelName(false)
      const matched = presetModels.find((m) => m.name === val)
      const capabilities = matched?.capabilities
      onChange(isEmbedding ? {
        ...model,
        modelName: val,
        maxTokens: capabilities?.maxOutputTokens ?? matched?.maxTokens ?? model.maxTokens,
        capabilities: capabilities ? { ...capabilities } : undefined,
      } : applyModelProfileSelection(model, { modelName: val }))
    }
  }


  // 当前模型名是否在预设列表里（决定下拉框显示）
  const isPresetValue = presetModels.some((m) => m.name === model.modelName)
  const selectValue = customModelName || (!isPresetValue && presetModels.length > 0)
    ? '__custom__'
    : model.modelName

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    const result = await testConnection(model)
    setTestResult(result)
    setTesting(false)
    setTimeout(() => setTestResult(null), 3000)
  }

  const handleDiscoverModels = async () => {
    const requestRevision = discoveryRevision.current + 1
    discoveryRevision.current = requestRevision
    const requestConfig = { ...currentDiscoveryConfig.current }
    const isCurrentRequest = () => {
      const current = currentDiscoveryConfig.current
      return discoveryRevision.current === requestRevision
        && current.id === requestConfig.id
        && current.provider === requestConfig.provider
        && current.protocol === requestConfig.protocol
        && current.baseUrl === requestConfig.baseUrl
        && current.apiKey === requestConfig.apiKey
    }
    setDiscovering(true)
    setDiscoveredModels([])
    setDiscoveryNotice(null)
    try {
      const result = await discoverModels({
        provider: model.provider,
        protocol: model.protocol,
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
      })
      if (!isCurrentRequest()) return
      if (result.success) {
        setDiscoveredModels(result.models)
      } else {
        setDiscoveryNotice(result.errorCode)
      }
    } catch {
      if (isCurrentRequest()) setDiscoveryNotice('network')
    } finally {
      if (isCurrentRequest()) setDiscovering(false)
    }
  }

  const discoveryNoticeText = discoveryNotice === 'auth'
      ? isChatgptPlan ? text('请重新连接 ChatGPT 并授权订阅用量。', 'Reconnect ChatGPT and authorize plan usage.') : text('鉴权失败：请检查 API Key。手工模型 ID 仍可使用。', 'Authentication failed. Check the API key. Manual model IDs remain available.')
      : discoveryNotice === 'unsupported'
        ? text('该端点不支持标准模型列表接口。请继续手工填写模型 ID。', 'This endpoint does not support the standard model-list API. Continue with a manual model ID.')
        : discoveryNotice === 'network'
          ? text('网络请求失败，请检查端点或网络后重试。手工模型 ID 仍可使用。', 'The network request failed. Check the endpoint or network and retry. Manual model IDs remain available.')
          : discoveryNotice === 'invalid_response'
            ? text('端点返回了无法识别的模型列表。请继续手工填写模型 ID。', 'The endpoint returned an invalid model list. Continue with a manual model ID.')
            : discoveryNotice === 'empty'
              ? text('端点返回了空模型列表。请继续手工填写模型 ID。', 'The endpoint returned an empty model list. Continue with a manual model ID.')
              : null

  return (
    <div
      className="rounded-xl p-5 space-y-4"
      style={{ border: '1.5px solid var(--color-accent)', backgroundColor: 'var(--color-panel)' }}
    >
      <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        {model.name ? text(`编辑：${model.name}`, `Edit: ${model.name}`) : text('新建模型配置', 'New model configuration')}
      </h3>

      {/* 显示名称 */}
      <div>
        <Label>{text('显示名称', 'Display name')}</Label>
        <Input
          value={model.name}
          onChange={(e) => up('name', e.target.value)}
          placeholder={text('如：DeepSeek 主力 / GPT-4o 备用', 'e.g. DeepSeek primary / GPT-4o backup')}
        />
      </div>

      {/* 服务商 + 协议 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{text('服务商', 'Provider')}</Label>
          <NativeSelect
            value={model.provider}
            onChange={(e) => handleProviderChange(e.target.value as ModelProfile['provider'])}
          >
            <option value="openai">OpenAI</option>
            {!isEmbedding && <option value="chatgpt-plan">{text('ChatGPT 订阅', 'ChatGPT subscription')}</option>}
            <option value="novelai">NovelAI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="gemini">Google Gemini</option>
            <option value="xai">xAI(Grok)</option>
            <option value="siliconflow">SiliconFlow</option>
            <option value="ollama">{text('Ollama（本地）', 'Ollama (local)')}</option>
            <option value="bigmodel">{text('BigModel（智谱）', 'BigModel (Zhipu)')}</option>
            <option value="custom">{text('自定义', 'Custom')}</option>
          </NativeSelect>
        </div>
        <div>
          <Label>{text('调用协议', 'Protocol')}</Label>
          <NativeSelect
            disabled={isChatgptPlan}
            value={model.protocol}
            onChange={(e) => up('protocol', e.target.value as 'openai' | 'gemini')}
          >
            <option value="openai">OpenAI</option>
            <option value="gemini">Gemini</option>
          </NativeSelect>
        </div>
      </div>

      {/* 模型标识：有预设时显示下拉，否则纯输入 */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label className="mb-0">{text('model（模型名称）', 'model')}</Label>
          {presetModels.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (customModelName) {
                  // 切回预设列表
                  const first = presetModels[0]
                  handleModelSelect(first.name)
                } else {
                  // 切换到自定义输入
                  setCustomModelName(true)
                  up('modelName', '')
                }
              }}
              className="text-xs transition-colors"
              style={{ color: 'var(--color-accent)' }}
            >
              {customModelName ? text('从列表选择', 'Choose from list') : text('手动输入', 'Enter manually')}
            </button>
          )}
        </div>

        {/* 有预设模型 且 未切到手动输入 → 显示下拉 */}
        {presetModels.length > 0 && !customModelName ? (
          <NativeSelect
            value={selectValue}
            onChange={(e) => handleModelSelect(e.target.value)}
          >
            {presetModels.map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
            <option value="__custom__">{text('手动输入', 'Enter manually')}</option>
          </NativeSelect>
        ) : (
          <div>
            <Input
              value={model.modelName}
              onChange={(e) => up('modelName', e.target.value)}
              placeholder={isEmbedding ? 'text-embedding-3-small' : 'gpt-4o'}
              autoFocus={customModelName}
            />
          </div>
        )}
      </div>

      {isChatgptPlan && <ChatgptPlanAccount onChanged={invalidateDiscovery} />}
      {/* Base URL */}
      {!isChatgptPlan && <>
      <div>
        <Label>{text('base_url', 'base_url')}</Label>
        <Input
          value={model.baseUrl}
          onChange={(e) => up('baseUrl', e.target.value)}
          placeholder="https://api.openai.com"
        />
        {model.provider !== 'custom' && (
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {text(`已自动填入 ${model.provider} 官方地址，如使用中转地址可手动修改`, `The official ${model.provider} URL was filled automatically. Edit it when using a gateway.`)}
          </p>
        )}
      </div>

      {/* API Key */}
      <div>
        <Label>{text('API Key', 'API Key')}</Label>
        <div className="relative">
          <Input
            type={showKey ? 'text' : 'password'}
            value={model.apiKey}
            onChange={(e) => up('apiKey', e.target.value)}
            placeholder={model.provider === 'ollama' ? text('本地部署可留空', 'Optional for local deployment') : 'sk-...'}
            className="pr-9"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      </>}
      <div className="space-y-2 rounded-lg p-3" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-hover)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label className="mb-0">{text('端点模型列表', 'Endpoint model list')}</Label>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {isChatgptPlan ? text('连接 ChatGPT 後取得帐号可用模型，选择後储存。', 'Connect ChatGPT, refresh available models, then choose and save.') : text('填写端点与 API Key 后即可获取；选择模型后再保存配置。', 'Enter the endpoint and API key to refresh, then save after choosing a model.')}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={handleDiscoverModels} disabled={discovering}>
            <RefreshCw size={13} className={discovering ? 'animate-spin' : undefined} />
            {discovering ? text('获取中...', 'Refreshing...') : text('获取模型列表', 'Refresh model list')}
          </Button>
        </div>

        {discoveredModels.length > 0 && (
          <NativeSelect
            aria-label={text('端点模型列表', 'Endpoint model list')}
            value={discoveredModels.some(candidate => candidate.value === model.modelName) ? model.modelName : ''}
            onChange={(event) => {
              const value = event.target.value
              if (!value) return
              setCustomModelName(true)
              if (isEmbedding) up('modelName', value)
              else onChange(applyModelProfileSelection(model, { modelName: value },
                discoveredModels.find(candidate => candidate.value === value)?.capabilities))
            }}
          >
            <option value="">{text('选择端点返回的模型', 'Choose a model returned by the endpoint')}</option>
            {discoveredModels.map(candidate => (
              <option key={`${candidate.id}:${candidate.value}`} value={candidate.value}>
                {candidate.name === candidate.id ? candidate.id : `${candidate.name} (${candidate.id})`}
              </option>
            ))}
          </NativeSelect>
        )}

        {discoveryNoticeText && (
          <p role="status" className="text-xs" style={{ color: 'var(--color-error-text)' }}>
            {discoveryNoticeText}
          </p>
        )}
      </div>

      {isEmbedding && model.provider === 'siliconflow' && model.modelName === 'BAAI/bge-m3' && (
        <div className="rounded-lg p-3 space-y-2" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-hover)' }}>
          <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            {text('BAAI/bge-m3 当前在 SiliconFlow 提供免费调用。完成实名认证后可使用，仍受固定速率限制约束。', 'BAAI/bge-m3 is currently free on SiliconFlow. Verification is required; fixed rate limits still apply.')}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <button type="button" onClick={() => void openModelProviderResource('siliconflow-invite', text)} className="text-[var(--color-accent)] hover:underline">
              {text('邀请注册链接', 'Invitation registration link')}
            </button>
            <button type="button" onClick={() => void openModelProviderResource('siliconflow-console', text)} className="text-[var(--color-accent)] hover:underline">
              {text('官方控制台', 'Official console')}
            </button>
            <button type="button" onClick={() => void openModelProviderResource('siliconflow-docs', text)} className="text-[var(--color-accent)] hover:underline">
              {text('官方文档', 'Official documentation')}
            </button>
          </div>
        </div>
      )}

      <div>
        <Label>{text('上下文窗口', 'Context Window')}</Label>
        <Input
          aria-label={text('上下文窗口', 'Context Window')}
          type="number"
          min={0}
          value={model.capabilities?.contextWindowTokens ?? ''}
          placeholder={text('可选', 'Optional')}
          onChange={(e) => updateCapabilities({ contextWindowTokens: e.target.value === '' ? null : parseInt(e.target.value) || null })}
        />
      </div>

      {!isEmbedding && (
        <ProjectCreativeStrategySettings />
      )}
      {!isEmbedding && <ModelCapabilitySources model={model} />}

      {!isEmbedding && (
        <div className="rounded-lg border border-[var(--color-border)]" data-model-advanced-settings>
          <button
            type="button"
            aria-label={text('高级设置', 'Advanced settings')}
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(open => !open)}
            className="flex w-full items-center gap-2 p-3 text-left"
          >
            <Settings2 size={14} style={{ color: 'var(--color-accent)' }} />
            <span className="flex-1">
              <span className="block text-xs font-medium text-[var(--color-text)]">
                {text('高级设置', 'Advanced settings')}
              </span>
              <span className="mt-0.5 block text-[0.7rem] text-[var(--color-text-muted)]">
                {text('仅作用于当前模型；未调整时使用产品与服务商默认行为。', 'Applies only to this model. Unchanged values use product and provider defaults.')}
              </span>
            </span>
            <ChevronDown size={14} className={cn('transition-transform', advancedOpen && 'rotate-180')} />
          </button>

          {advancedOpen && (
            <div className="space-y-4 border-t border-[var(--color-border)] p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[0.7rem] text-[var(--color-text-muted)]">
                  {text('这些值随当前模型保存，连接测试和生成会读取已保存配置。', 'These values are saved with this model and used by connection tests and generation.')}
                </p>
                <Button type="button" size="sm" variant="outline" onClick={resetAdvancedSettings}>
                  <RotateCcw size={12} />
                  {text('恢复默认值', 'Restore defaults')}
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{text('温度', 'Temperature')}</Label>
                  <Input
                    aria-label={text('温度', 'Temperature')}
                    disabled={isChatgptPlan}
                    type="number" min={0} max={2} step={0.1}
                    value={model.temperature}
                    onChange={(e) => up('temperature', (e.target.value === '' ? '' : parseFloat(e.target.value)) as number)}
                    onBlur={() => {
                      const value = Number(model.temperature)
                      if (Number.isNaN(value)) up('temperature', 0.7)
                    }}
                  />
                  <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
                    {isChatgptPlan ? text('ChatGPT 订阅使用模型预设温度。', 'ChatGPT subscription uses the model default temperature.') : text('模型级采样偏好；固定温度模型不会收到此参数。', 'Model-level sampling preference. Fixed-temperature models do not receive this parameter.')}
                  </p>
                </div>
                <div>
                  <Label>{text('最大输出 Token', 'Max output tokens')}</Label>
                  <Input
                    aria-label={text('最大输出 Token', 'Max output tokens')}
                    type="number"
                    min={0}
                    value={model.maxTokens}
                    onChange={(e) => up('maxTokens', e.target.value === '' ? 0 : parseInt(e.target.value) || 0)}
                  />
                  <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
                    {text('作者设置的单次输出限制；实际请求仍受模型容量与任务预算约束。', 'Your per-response limit; model capacity and task budgets still apply.')}
                  </p>
                </div>
                <div>
                  <Label>{text('模型输出容量', 'Model output capacity')}</Label>
                  <Input aria-label={text('模型输出容量', 'Model output capacity')} type="number" min={1}
                    value={currentCapabilities.maxOutputTokens}
                    onChange={event => updateCapabilities({ maxOutputTokens: Number(event.target.value) })} />
                </div>
              </div>
              <p className="text-xs text-[var(--color-text-secondary)]" data-effective-output-limit={effectiveOutputLimit}>
                {text(`当前有效输出额度为 ${effectiveOutputLimit?.toLocaleString() ?? text('未设置', 'not configured')} Token。取作者设置、模型输出容量与已知服务商上限中的较小值；完整输入和本次剩余额度仍会影响请求。`, `Effective output allowance: ${effectiveOutputLimit?.toLocaleString() ?? text('未设置', 'not configured')} tokens. This uses the lowest configured or verified output limit. Prompt size and the remaining action allowance still affect each request.`)}
              </p>
              {contextOutputConflict && (
                <p
                  role="status"
                  className="rounded-lg border px-3 py-2 text-xs leading-5"
                  style={{
                    borderColor: 'var(--color-warning)',
                    backgroundColor: 'color-mix(in srgb, var(--color-warning) 8%, transparent)',
                    color: 'var(--color-warning-text)',
                  }}
                >
                  {text(
                    '最大输出 Token 没有给提示词留下安全空间。生成前预算检查会阻止请求；请降低最大输出或增大上下文窗口。此提示不会阻止保存。',
                    'Max output tokens leave no safe room for the prompt. The preflight budget check will block generation; lower the output limit or increase the context window. This warning does not block saving.',
                  )}
                </p>
              )}
              <ModelReasoningOverrideSettings model={model} onModelChange={onChange} />
            </div>
          )}
        </div>
      )}

      {isEmbedding && (
        <div className="space-y-3 rounded-lg p-3" style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-hover)' }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="mb-0">{text('向量化高级参数', 'Embedding advanced settings')}</Label>
              <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
                {text('按当前向量模型保存。降低批量数可减少本地显存占用；不会影响生成模型。', 'Saved with this embedding model. Lower batches reduce local VRAM use and do not affect generation models.')}
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => up('embeddingOptions', LOW_VRAM_EMBEDDING_OPTIONS)}>
              {text('应用低显存推荐', 'Use low-VRAM preset')}
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>{text('分块字符数', 'Chunk characters')}</Label>
              <Input type="number" min={100} max={4000} value={embeddingOptions.chunkSize}
                onChange={(e) => up('embeddingOptions', normalizeEmbeddingOptions({ ...embeddingOptions, chunkSize: Number(e.target.value) }))} />
            </div>
            <div>
              <Label>{text('重叠字符数', 'Overlap characters')}</Label>
              <Input type="number" min={0} max={embeddingOptions.chunkSize - 1} value={embeddingOptions.chunkOverlap}
                onChange={(e) => up('embeddingOptions', normalizeEmbeddingOptions({ ...embeddingOptions, chunkOverlap: Number(e.target.value) }))} />
            </div>
            <div>
              <Label>{text('请求批量', 'Request batch')}</Label>
              <Input type="number" min={1} max={50} value={embeddingOptions.batchSize}
                onChange={(e) => up('embeddingOptions', normalizeEmbeddingOptions({ ...embeddingOptions, batchSize: Number(e.target.value) }))} />
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={testing || !model.baseUrl || (!model.apiKey && model.provider !== 'ollama' && !isChatgptPlan)}
        >
          <Zap size={13} />
          {testing ? text('测试中...', 'Testing...') : text('测试连接', 'Test connection')}
        </Button>
        <Button
          className="flex-1"
          onClick={onSave}
          disabled={saving || !model.baseUrl.trim() || !model.modelName.trim() || (!model.apiKey.trim() && model.provider !== 'ollama' && !isChatgptPlan)}
        >
          <Save size={13} />
          {saving ? text('保存中...', 'Saving...') : text('保存配置', 'Save configuration')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{text('取消', 'Cancel')}</Button>
      </div>
      {testResult && (
        <div className={`text-xs p-2 rounded ${testResult.success ? 'bg-green-500/10 text-[var(--color-success-text)] border border-green-500/20' : 'bg-red-500/10 text-[var(--color-error-text)] border border-red-500/20'} break-all`}>
          {testResult.success ? text('连接成功', 'Connection succeeded') : text(`连接失败：${testResult.error}`, `Connection failed: ${testResult.error}`)}
        </div>
      )}
    </div>
  )
}
