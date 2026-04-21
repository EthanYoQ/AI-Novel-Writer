import { useState, useRef } from 'react'
import { Save, Sparkles, Info, Loader2 } from 'lucide-react'
import { useProjectStore } from '../../stores/project-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import type { NovelConfig } from '../../shared/ipc-channels'
import type { GeneratableField } from '../../services/workflows/commands/generate-field.command'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { NativeSelect } from '../ui/NativeSelect'
import GenerateConfigDialog from '../dialogs/GenerateConfigDialog'

/** 小说配置编辑器 — Tab 内的可视化配置面板 */
export default function NovelConfigEditor() {
  // ✅ 用 selector 精确订阅：只有 currentProject 变化时才重新渲染
  //    不订阅 fileTree、recentProjects 等无关字段
  const currentProject = useProjectStore(s => s.currentProject)
  const updateNovelConfig = useProjectStore(s => s.updateNovelConfig)
  const saveProject = useProjectStore(s => s.saveProject)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  // ✅ addLog 用 getState() 命令式调用，不订阅 workflow store
  //    避免 AI 流式生成时 globalLogs 高频更新导致本组件被动重渲染
  const addLog = useWorkflowStore.getState().addLog
  const [saving, setSaving] = useState(false)
  const [showGenerateConfig, setShowGenerateConfig] = useState(false)

  // 各区块的独立生成状态
  const [generatingField, setGeneratingField] = useState<GeneratableField | null>(null)

  // 直接从 Store 读取配置 — 单一数据源，无需 local state 镜像
  const config = currentProject?.novelConfig ?? null

  if (!config) return (
    <div className="h-full flex items-center justify-center" style={{ color: 'var(--color-text-muted)' }}>
      <span className="text-sm opacity-50">加载配置中...</span>
    </div>
  )

  // 直接写 Store — 消除双向同步风险
  const update = <K extends keyof NovelConfig>(key: K, value: NovelConfig[K]) => {
    updateNovelConfig({ [key]: value })
  }

  /** 保存配置 — Store 已是最新数据，仅需持久化到磁盘 */
  const handleSave = async () => {
    if (!config || saving) return
    setSaving(true)
    try {
      await saveProject()
      addLog('info', '📝 小说配置已保存')
    } catch (error) {
      console.error('[NovelConfigEditor] 保存失败:', error)
      addLog('error', `保存失败: ${error}`)
    } finally {
      setSaving(false)
    }
  }

  /** AI 生成配置 — 打开弹框 */
  const handleAIGenerate = () => {
    if (!defaultModelId) {
      addLog('error', '⚠️ 请先在设置中配置 AI 模型')
      return
    }
    setShowGenerateConfig(true)
  }

  /** 单字段 AI 生成 */
  const handleFieldGenerate = async (fieldKey: GeneratableField) => {
    if (!defaultModelId) {
      addLog('error', '⚠️ 请先在设置中配置 AI 模型')
      return
    }
    if (generatingField) return // 防止并发

    setGeneratingField(fieldKey)
    try {
      const { GenerateFieldCommand } = await import('../../services/workflows/commands/generate-field.command')
      const cmd = new GenerateFieldCommand(fieldKey)
      await cmd.execute({
        step: { id: '', commandId: '', name: '', params: {} },
        context: { data: {}, cancelled: false },
        callbacks: {
          log: (msg: string) => useWorkflowStore.getState().addLog('info', msg),
          setProgress: () => { },
          appendText: () => { },
        },
      })
    } catch (e) {
      addLog('error', `生成失败：${e}`)
    } finally {
      setGeneratingField(null)
    }
  }

  const genres = ['玄幻', '仙侠', '都市', '科幻', '历史', '军事', '游戏', '末世', '悬疑', '灵异', '言情', '古言', '现言', '奇幻', '武侠', '轻小说', '同人', '职场']

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-6">
        {/* 头部 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
              小说配置
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              定义你的小说基本信息和写作参数
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ai" onClick={handleAIGenerate}>
              <Sparkles size={13} /> AI 填充配置
            </Button>
            <Button variant="outline" onClick={handleSave} disabled={saving}>
              <Save size={13} /> {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>

        {/* 配置表单 */}
        <div className="space-y-5">
          {/* 基本信息 */}
          <Section title="基本信息">
            <div className="grid grid-cols-3 gap-4">
              <Field label="类型">
                <NativeSelect value={config.genre} onChange={(e) => update('genre', e.target.value)}>
                  {genres.map((g) => <option key={g} value={g}>{g}</option>)}
                </NativeSelect>
              </Field>
              <Field label="细分类型">
                <Input value={config.subGenre} onChange={(e) => update('subGenre', e.target.value)} placeholder="如：修仙/重生/末世" />
              </Field>
              <Field label="目标受众">
                <NativeSelect value={config.targetAudience} onChange={(e) => update('targetAudience', e.target.value)}>
                  <option value="男频">男频</option>
                  <option value="女频">女频</option>
                  <option value="双性向">双性向</option>
                  <option value="全龄">全龄</option>
                </NativeSelect>
              </Field>
            </div>
            <div className="grid grid-cols-4 gap-4 mt-4">
              <Field label="故事结构" tipItems={[
                '三幕结构：经典的“建置→对抗→高潮”，适合大多数网文类型',
                '英雄之旅：神话学十二阶段，适合冒险/成长类，强调内在蜕变',
                '节拍表：好莱坞十五拍结构，节奏最精细，适合情感张力强的故事',
                '起承转合：中国传统四段式结构，适合古言/武侠/仙侠',
                '多线叙事：多条故事线并进交织，适合群像或复杂情节',
                '自由结构：不限定特定框架，AI 根据内容自适应，适合日常/轻小说',
              ]}>
                <NativeSelect value={config.plotStructure || 'three_act'} onChange={(e) => update('plotStructure', e.target.value as NovelConfig['plotStructure'])}>
                  <option value="three_act">三幕结构</option>
                  <option value="heros_journey">英雄之旅</option>
                  <option value="save_the_cat">节拍表</option>
                  <option value="kishotenketsu">起承转合</option>
                  <option value="multi_thread">多线叙事</option>
                  <option value="freeform">自由结构</option>
                </NativeSelect>
              </Field>
              <Field label="叙事视角" tipItems={[
                '第一人称："我"视角叙事，代入感最强，信息受限',
                '第三人称有限视角：跟随主角视角，兼顾代入感和灵活性，最常用',
                '第三人称全知视角：可自由切换角色内心，适合群像叙事',
                '多视角轮换：多名角色交替叙事，适合复杂群像故事',
              ]}>
                <NativeSelect value={config.narrativePOV || 'third_limited'} onChange={(e) => update('narrativePOV', e.target.value as NovelConfig['narrativePOV'])}>
                  <option value="first_person">第一人称</option>
                  <option value="third_limited">第三人称有限视角</option>
                  <option value="third_omniscient">第三人称全知视角</option>
                  <option value="multi_pov">多视角轮换</option>
                </NativeSelect>
              </Field>
              <Field label="总章数">
                <Input
                  type="number"
                  value={config.totalChapters}
                  onChange={(e) => update('totalChapters', (e.target.value === '' ? '' : parseInt(e.target.value)) as number)}
                  onBlur={() => {
                    const v = Number(config.totalChapters)
                    if (!v || v < 1) update('totalChapters', 100)
                  }}
                  placeholder="100"
                  min={1}
                />
              </Field>
              <Field label="每章字数">
                <Input
                  type="number"
                  value={config.wordsPerChapter}
                  onChange={(e) => update('wordsPerChapter', (e.target.value === '' ? '' : parseInt(e.target.value)) as number)}
                  onBlur={() => {
                    const v = Number(config.wordsPerChapter)
                    if (!v || v < 100) update('wordsPerChapter', 3000)
                  }}
                  placeholder="3000"
                  min={100}
                />
              </Field>
            </div>
          </Section>

          {/* 核心大纲 */}
          <Section
            title="核心大纲"
            desc="一段话概括整个故事：谁/在哪/要做什么。也是 AI 一键填充时的灵感输入"
            aiFieldKey="coreOutline"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
          >
            <Textarea value={config.coreOutline} onChange={(e) => update('coreOutline', e.target.value)} placeholder="在此输入你的创作想法，或让 AI 根据这段话一键生成全部配置..." rows={4} />
          </Section>

          {/* 世界观设定 */}
          <Section
            title="世界观 / 初始设定"
            desc="故事发生的背景、时代、力量体系（架构生成后可由 AI 自动扩展）"
            aiFieldKey="worldSetting"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
          >
            <Textarea value={config.worldSetting} onChange={(e) => update('worldSetting', e.target.value)} placeholder="描述故事发生的背景、时代、力量体系、社会结构（可简写，AI 生成架构时会自动丰富）..." rows={4} />
          </Section>

          {/* 金手指 */}
          <Section
            title="金手指 / 核心卖点"
            desc="主角的差异化优势：获取方式、核心能力、成长路径（架构生成时 AI 会深度扩展）"
            aiFieldKey="goldenFinger"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
          >
            <Textarea value={config.goldenFinger} onChange={(e) => update('goldenFinger', e.target.value)} placeholder="主角的独特优势或故事核心卖点（可简写，架构生成时AI会深度扩展）..." rows={3} />
          </Section>

          {/* 主角人设 */}
          <Section
            title="主角人设"
            desc="性格特征、背景故事、核心目标（架构生成时 AI 会补全关系网和角色弧光）"
            aiFieldKey="protagonistProfile"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
          >
            <Textarea value={config.protagonistProfile} onChange={(e) => update('protagonistProfile', e.target.value)} placeholder="主角的性格特征、背景故事、核心目标..." rows={4} />
          </Section>

          {/* 全局写作要求 */}
          <Section
            title="全局写作要求"
            desc="写作风格、禁忌事项、节奏控制等全局规则（AI 填充配置时会自动生成）"
            aiFieldKey="globalGuidance"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
          >
            <Textarea
              value={config.globalGuidance}
              onChange={(e) => update('globalGuidance', e.target.value)}
              placeholder="全局的写作风格要求、禁忌事项、特殊规则..."
              rows={6}
            />
          </Section>

          {/* 文风配置 */}
          <Section
            title="文风配置"
            desc="AI 写稿/修稿时会严格遵循这里的风格要求。可手动填写或由 AI 自动生成。"
            aiFieldKey="writingStyle"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
          >
            <Textarea
              value={config.writingStyle || ''}
              onChange={(e) => update('writingStyle', e.target.value)}
              placeholder="尚未配置。点击右上角「AI 生成」或手动填写…"
              rows={6}
            />
          </Section>

          {/* 参考作品 */}
          <Section title="参考作品" desc={'参考作品的风格、体系或机制，如："参考《证道》的修炼体系"'}>
            <Textarea value={config.referenceWorks || ''} onChange={(e) => update('referenceWorks', e.target.value)} placeholder="参考哪些作品的风格、设定或机制？（AI 架构生成时会参考）" rows={2} />
          </Section>
        </div>
      </div>

      {/* AI 生成配置弹框 */}
      <GenerateConfigDialog
        isOpen={showGenerateConfig}
        onClose={() => setShowGenerateConfig(false)}
        onGenerated={(parsed) => {
          // 直接写 Store，组件自动重新渲染
          updateNovelConfig(parsed)
        }}
      />
    </div>
  )
}

/** 表单分组 — 支持右上角 AI 生成按钮 */
function Section({
  title,
  desc,
  children,
  aiFieldKey,
  generatingField,
  onAIGenerate,
}: {
  title: string
  desc?: string
  children: React.ReactNode
  /** 对应 NovelConfig 中的字段 key，传入则显示 AI 生成按钮 */
  aiFieldKey?: GeneratableField
  /** 当前正在生成的字段（全局共享状态，防止并发） */
  generatingField?: GeneratableField | null
  /** AI 生成回调 */
  onAIGenerate?: (fieldKey: GeneratableField) => void
}) {
  const isGenerating = aiFieldKey != null && generatingField === aiFieldKey
  const isAnyGenerating = generatingField != null
  const showAIButton = aiFieldKey != null && onAIGenerate != null

  return (
    <div className="p-4 rounded-xl bg-[var(--color-sidebar)] border border-[var(--color-border)]">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
          {desc && <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{desc}</p>}
        </div>
        {showAIButton && (
          <Button
            variant="ai"
            size="sm"
            onClick={() => onAIGenerate(aiFieldKey)}
            disabled={isAnyGenerating}
            className="flex-shrink-0 ml-3"
            title={isGenerating ? '正在生成...' : `AI 生成「${title}」`}
          >
            {isGenerating
              ? <Loader2 size={11} className="animate-spin" />
              : <Sparkles size={11} />
            }
            {isGenerating ? '生成中...' : 'AI 生成'}
          </Button>
        )}
      </div>
      {children}
    </div>
  )
}

/** 表单字段 */
function Field({ label, tipItems, children }: { label: string; tipItems?: string[]; children: React.ReactNode }) {
  const [showTip, setShowTip] = useState(false)
  const tipRef = useRef<HTMLDivElement>(null)

  return (
    <div>
      <label className="text-xs mb-1 flex items-center gap-1 font-medium text-[var(--color-text-muted)]">
        {label}
        {tipItems && tipItems.length > 0 && (
          <span
            style={{ position: 'relative', display: 'inline-flex' }}
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
          >
            <Info size={11} style={{ opacity: 0.5 }} />
            {showTip && (
              <div
                ref={tipRef}
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 6,
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 11,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-line',
                  color: 'var(--color-text)',
                  background: 'var(--color-bg-elevated, var(--color-sidebar))',
                  border: '1px solid var(--color-border)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                  zIndex: 9999,
                  width: 260,
                  pointerEvents: 'none',
                }}
              >
                {tipItems.map((item, i) => (
                  <div key={i} style={{ paddingLeft: 0 }}>
                    <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{item.split('：')[0]}</span>
                    {'：' + item.split('：').slice(1).join('：')}
                  </div>
                ))}
              </div>
            )}
          </span>
        )}
      </label>
      {children}
    </div>
  )
}
