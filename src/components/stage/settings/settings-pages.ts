import type { SettingsSection } from '../../../stores/layout-store'

type Pair = readonly [string, string]

/** 必需页判据读的模型配置（llm-store 的同名字段）。 */
interface ModelDefaults {
  defaultModelId: string | null
  defaultEmbeddingModelId: string | null
}

export interface SettingsPageSpec {
  id: SettingsSection
  name: Pair
  lede: Pair
  /** 不配置就有功能用不了的页：导航与页头标「必需」；missing 为真时标「未配置」。 */
  required?: { missing: (models: ModelDefaults) => boolean }
}

/** ia.md 的三组：常用、高级、其他。 */
export const SETTINGS_GROUPS: readonly { id: string; name: Pair; pages: readonly SettingsPageSpec[] }[] = [
  { id: 'common', name: ['常用', 'Common'], pages: [
    { id: 'llm', required: { missing: models => !models.defaultModelId }, name: ['AI 模型', 'AI models'], lede: ['写作、审稿、修稿都用这里的模型。标为默认的会预先选好，每次运行前仍可临时换。', 'Writing, reviews and revisions use these models. The default is preselected and can be changed before each run.'] },
    { id: 'embedding', required: { missing: models => !models.defaultEmbeddingModelId }, name: ['检索模型', 'Retrieval model'], lede: ['知识库用它理解资料的意思，按意思找到相关段落；伏笔、人物与前文都靠它找回。', 'The knowledge base uses it to understand your material and find passages by meaning, which is how foreshadowing, characters and earlier chapters are recalled.'] },
    { id: 'appearance', name: ['外观', 'Appearance'], lede: ['改动立即生效，不需要保存。', 'Changes apply right away. No need to save.'] },
  ] },
  { id: 'advanced', name: ['高级', 'Advanced'], pages: [
    { id: 'stage-models', name: ['分工模型', 'Models by stage'], lede: ['给不同环节指定不同的模型。没指定的环节用「AI 模型」里的默认模型；每次运行前仍可临时换。', 'Assign a model to each stage. Stages left on Default use the default from AI models. You can still switch before each run.'] },
    { id: 'proxy', name: ['网络代理', 'Network proxy'], lede: ['连接模型服务需要经过代理时在这里设置，所有 AI 请求都会走它。', 'Set this when model services must be reached through a proxy. Every AI request goes through it.'] },
    { id: 'prompts', name: ['提示词模板', 'Prompt templates'], lede: ['调整 AI 在每个创作环节收到的指导。可以只改这部作品，也可以改成全局默认。', 'Adjust the guidance AI receives at each writing step, for this book or as the global default.'] },
    { id: 'skills', name: ['写作 Skills', 'Writing skills'], lede: ['安装提示词型的写作 Skill，并绑定到创作阶段。安装前会先让你检查内容。', 'Install prompt-only writing skills and bind them to writing stages. You review each one before installing.'] },
  ] },
  { id: 'other', name: ['其他', 'Other'], pages: [
    { id: 'backup', name: ['项目备份', 'Project backup'], lede: ['把作品打包存到本机，或备份到你绑定的云端。恢复时总是另存为一份新的作品副本。', 'Archive the book locally or to a cloud you connect. Restoring always creates a new copy.'] },
    { id: 'about', name: ['关于与更新', 'About & updates'], lede: ['版本信息与应用更新。', 'Version information and app updates.'] },
  ] },
]

export const SETTINGS_PAGES: readonly SettingsPageSpec[] = SETTINGS_GROUPS.flatMap(group => group.pages)
