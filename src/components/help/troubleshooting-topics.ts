/**
 * 常见错误排查清单。
 *
 * 每一条都对着代码里**真实抛出的报错**写：`symptom` 里的文案直接取自产品的
 * 错误提示（i18n 或命令里抛出的原文），`codes` 里是相关的 errorCode，方便按
 * 报错里的关键字搜到。也就是说，作者在界面上看到什么，就能在这里搜到什么。
 */

export type TroubleshootingCategory = 'model' | 'generation' | 'project' | 'knowledge' | 'app'

export interface TroubleshootingTopic {
  id: string
  category: TroubleshootingCategory
  titleZh: string
  titleEn: string
  /** 你可能会看到的报错原文（可多条）。 */
  symptomZh: string[]
  symptomEn: string[]
  causeZh: string
  causeEn: string
  /** 按顺序照做即可。 */
  fixZh: string[]
  fixEn: string[]
  /** 相关错误码 / 关键字，供搜索命中。 */
  codes?: string[]
}

export const TROUBLESHOOTING_CATEGORIES: Array<{
  id: TroubleshootingCategory
  zh: string
  en: string
}> = [
  { id: 'model', zh: '模型与连接', en: 'Model & connection' },
  { id: 'generation', zh: '生成与续写', en: 'Generation' },
  { id: 'project', zh: '项目与文件', en: 'Project & files' },
  { id: 'knowledge', zh: '知识库与向量', en: 'Knowledge base' },
  { id: 'app', zh: '应用与更新', en: 'App & updates' },
]

export const TROUBLESHOOTING_TOPICS: TroubleshootingTopic[] = [
  {
    id: 'no-model',
    category: 'model',
    titleZh: '顶栏显示「未配置模型」，生成时提示先配置模型',
    titleEn: 'The title bar says “No model configured”',
    symptomZh: ['顶栏模型胶囊与状态栏显示「未配置模型」', '生成时提示：请先配置模型'],
    symptomEn: ['The model pill and status bar read “No model configured”', 'Generation asks you to configure a model first'],
    causeZh: '还没有可用的默认模型，或者原来的默认模型被删除 / 换过 ID，默认项悬空了。',
    causeEn: 'There is no usable default model — either none was set, or the previous default was deleted and its id dangles.',
    fixZh: [
      '打开「设置 → 模型设置」，新建一个模型或编辑已有的',
      '点「测试连接」确认能通，再保存',
      '把它设为默认模型，并勾上「正文生成」等用途',
      '别名可以留空：顶栏与状态栏会自动显示模型标识（例如 deepseek-v4-flash）',
    ],
    fixEn: [
      'Open Settings → Model settings and create a model (or edit an existing one)',
      'Use “Test connection”, then save',
      'Set it as the default model and tick the writing purposes',
      'The alias may stay blank — the title bar falls back to the model identifier',
    ],
    codes: ['MODEL_NOT_FOUND'],
  },
  {
    id: 'connection-failed',
    category: 'model',
    titleZh: '「测试连接」失败：认证或网络问题',
    titleEn: '“Test connection” fails with an auth or network error',
    symptomZh: ['连接失败：unauthorized / 401 / 403', '连接失败：network（网络不可达或超时）'],
    symptomEn: ['Connection failed: unauthorized / 401 / 403', 'Connection failed: network (unreachable or timed out)'],
    causeZh: '最常见的是 API Key 无效或余额不足、Base URL 写错（多写或漏写路径）、以及本机代理拦住了请求。',
    causeEn: 'Usually an invalid or out-of-credit API key, a wrong Base URL (missing or extra path), or a local proxy blocking the request.',
    fixZh: [
      '回到服务商控制台复制一次最新的 Key，注意前后不要有空格',
      'Base URL 只填到版本路径，例如 https://api.deepseek.com 或 https://api.openai.com/v1',
      '若开了代理/加速器，先关掉再测一次；或把代理地址填进应用的代理设置',
      '确认账户余额与模型权限（有些模型需要单独开通）',
    ],
    fixEn: [
      'Copy a fresh key from the provider console, with no leading or trailing spaces',
      'Keep the Base URL to the version path, e.g. https://api.deepseek.com or https://api.openai.com/v1',
      'Turn off any proxy or accelerator and retry, or point the app at the proxy',
      'Check account balance and model permissions',
    ],
    codes: ['auth', 'network'],
  },
  {
    id: 'local-model',
    category: 'model',
    titleZh: 'Ollama 等本地模型连不上',
    titleEn: 'A local model such as Ollama will not connect',
    symptomZh: ['连接失败：network', '模型列表为空，看不到本地模型'],
    symptomEn: ['Connection failed: network', 'The model list is empty and no local model shows up'],
    causeZh: '本地服务用的是 OpenAI 兼容接口，地址必须带 /v1；写成 /api（Ollama 原生路径）或服务没启动都会失败。',
    causeEn: 'Local runtimes expose an OpenAI-compatible endpoint, so the URL must end in /v1; using /api (the native path) or leaving the server stopped both fail.',
    fixZh: [
      'Base URL 填 http://127.0.0.1:11434/v1 —— 结尾的 /v1 不能少',
      'API Key 可以留空，界面若要求就填任意占位值',
      '先在终端确认服务在跑（例如 ollama serve、ollama list）',
      '模型标识填本地已有的模型名，例如 qwen3:14b',
    ],
    fixEn: [
      'Use http://127.0.0.1:11434/v1 — the trailing /v1 is required',
      'The API key may be blank; if the form insists, put any placeholder',
      'Confirm the server is running (e.g. ollama serve, ollama list)',
      'Set the model identifier to a model you actually pulled, e.g. qwen3:14b',
    ],
    codes: ['network', 'MODEL_NOT_FOUND'],
  },
  {
    id: 'length-limit',
    category: 'generation',
    titleZh: '输出达到模型最大长度，结果不完整',
    titleEn: 'Output hit the model maximum length and is incomplete',
    symptomZh: [
      'AI 输出达到模型最大长度，结果不完整。请提高模型最大输出 Tokens 或缩短本次任务后重试。',
      'AI 输出连续达到模型最大长度，已自动续写 N 次仍未完成，结果未被保存。',
    ],
    symptomEn: [
      'AI output reached the model maximum length and is incomplete. Increase the maximum output tokens or shorten the task, then try again.',
      'AI output repeatedly reached the model maximum length. Automatic continuation ran N times but the output is still incomplete, so it was not saved.',
    ],
    causeZh: '单次请求的输出上限不够放完这一章 / 这一段。产品会先自动续写几轮，仍然写不完就整段不落盘，避免把半截稿存成正式内容。',
    causeEn: 'The per-request output cap is too small for this chapter or section. The app auto-continues a few rounds; if it still cannot finish, nothing is saved so a half-draft never becomes official content.',
    fixZh: [
      '把模型的「最大输出 Tokens」调大（至少 8192，长章建议 16000+）',
      '降低本章目标字数，或把一章拆成两章',
      '换一个输出能力更强的模型',
      '确认服务商真的支持你填的 max_tokens（部分中转会截断到更小值）',
    ],
    fixEn: [
      'Raise the model’s maximum output tokens (8192 is a floor; long chapters want 16000+)',
      'Lower the chapter target length, or split the chapter in two',
      'Switch to a model with greater output capacity',
      'Make sure the provider honours the max_tokens you set (some relays clamp it)',
    ],
    codes: ['DEADLINE_EXHAUSTED'],
  },
  {
    id: 'resume-candidate',
    category: 'generation',
    titleZh: '世界观 / 情节大纲生成中断，提示可以续写',
    titleEn: 'Worldbuilding or the plot outline stopped, and you are offered a resume',
    symptomZh: [
      '世界观未能完整生成，已保存未完成候选且未覆盖正式世界观。可查看、复制或稍后续写。',
      '情节大纲未完成，已保存断点，可以从断点继续生成。',
    ],
    symptomEn: [
      'Worldbuilding did not complete. The incomplete candidate was saved without overwriting the formal worldbuilding; you can view, copy, or resume it later.',
      'The plot outline is incomplete; a checkpoint was saved so you can continue from it.',
    ],
    causeZh: '生成撞上了输出长度上限（或中途网络中断）。已生成的部分会存成「候选 / 断点」，正式内容保持不动。',
    causeEn: 'The run hit the output length limit (or the network dropped). The finished part is kept as a candidate or checkpoint; official content is untouched.',
    fixZh: [
      '可以直接「继续生成 / 断点续写」，会从已完成的部分往下补，不重复请求已有的内容',
      '也可以先「查看候选」再手动复制，自己决定要不要用',
      '若期间改过故事前提、小说配置或模板，旧候选不能接到新上下文，需要重新生成那一步',
      '续写前不要再改这些源设定，否则会被安全校验拒绝',
    ],
    fixEn: [
      'Use “Continue” to resume from the finished part instead of regenerating it',
      'Or use “View candidate” and copy it manually',
      'If the premise, configuration or template changed meanwhile, the old candidate cannot continue — regenerate that step',
      'Avoid editing those sources before resuming, or the safety check will refuse it',
    ],
    codes: ['architecture-world-building-resume-available', 'architecture-synopsis-resume-available'],
  },
  {
    id: 'author-edit-protected',
    category: 'generation',
    titleZh: '生成期间我改了设定，结果没有写入正式内容',
    titleEn: 'My edits during generation were not overwritten',
    symptomZh: [
      '世界观生成期间正式内容已被修改，本次结果已保留为候选且未覆盖作者修改；可查看或复制候选。',
      '世界观生成期间故事前提、小说配置或模板已变化，本次结果已保留为候选且未写入正式世界观。',
    ],
    symptomEn: [
      'The formal worldbuilding changed while generation was running. This result was kept as a candidate and did not overwrite the author edit.',
      'The premise, novel configuration, or template changed while worldbuilding was being generated. This result was kept as a candidate and was not written to formal worldbuilding.',
    ],
    causeZh: '这是**有意的保护**：生成前和写入前各记一次指纹，只要正式内容或源设定在你的生成过程中被改过，结果就只作为候选保存，绝不覆盖你的修改。',
    causeEn: 'This is deliberate: fingerprints are taken before generating and again before writing. If the formal content or its sources changed in between, the result is kept as a candidate and never overwrites your edit.',
    fixZh: [
      '看一眼候选内容，决定采用哪一版',
      '想用模型这版：手动复制候选，或删掉候选后重新生成一次',
      '想用手改这版：直接丢弃候选即可，正式内容一直是你的版本',
    ],
    fixEn: [
      'Compare the candidate with your edit and decide which version you want',
      'To keep the generated one: copy the candidate, or discard it and regenerate once',
      'To keep yours: just discard the candidate — the formal content was never touched',
    ],
    codes: ['architecture-world-building-resume-available'],
  },
  {
    id: 'content-policy',
    category: 'generation',
    titleZh: '输出因内容限制被中断，结果未保存',
    titleEn: 'Output was stopped by the content policy and not saved',
    symptomZh: ['…输出因内容限制未完成，结果未保存。', 'finishReason=content_filter'],
    symptomEn: ['…output was stopped by the content policy and was not saved.', 'finishReason=content_filter'],
    causeZh: '模型服务商的内容安全策略拦下了这次输出。产品宁可整段不保存，也不写入被截断的内容。',
    causeEn: 'The provider’s content policy stopped this completion. The app prefers saving nothing over saving a truncated result.',
    fixZh: [
      '调整这一段的情节与用词，避开触发拦截的描写',
      '在「全局创作指导」里写明本书的尺度与禁忌，让模型自行规避',
      '换一个策略更宽松的服务商或模型再试',
    ],
    fixEn: [
      'Reword the scene so it no longer trips the filter',
      'State the book’s boundaries in the global writing guidance so the model avoids them',
      'Try a provider or model with a looser policy',
    ],
    codes: ['content_filter'],
  },
  {
    id: 'source-draft-changed',
    category: 'generation',
    titleZh: '审稿清单没保存：源草稿已变化',
    titleEn: 'The review checklist was not saved because the source draft changed',
    symptomZh: ['确认期间源草稿已变化，清单未保存；请重新运行 AI 审稿。'],
    symptomEn: ['The source draft changed during confirmation, so the checklist was not saved. Run AI review again.'],
    causeZh: '审稿报告生成后你（或自动保存）改动了这一章的正文，清单与新正文不再对应。',
    causeEn: 'After the report was produced the chapter text changed, so the checklist no longer matches the draft.',
    fixZh: [
      '确认这一章的正文已经改完、保存好',
      '重新运行 AI 审稿，得到与新正文对应的清单',
    ],
    fixEn: [
      'Finish and save your edits to this chapter first',
      'Run AI review again so the checklist matches the current draft',
    ],
    codes: ['SOURCE_DRAFT_CHANGED'],
  },
  {
    id: 'project-path',
    category: 'project',
    titleZh: '项目路径过深 / 选错了文件夹',
    titleEn: 'The project path is too deep, or the wrong folder was picked',
    symptomZh: [
      '项目路径过深，部分本地存储不可用。请将整个项目文件夹移动到更靠近磁盘根目录的位置（例如 D:\\Novels），然后重试。',
      '请选择项目根目录，也就是包含 .vela/project.json 的小说文件夹；不要选择它的上级文件夹。',
    ],
    symptomEn: [
      'The project path is too deep for some local storage. Move the entire project folder closer to the drive root (for example, D:\\Novels), then try again.',
      'Select the project root folder that contains .vela/project.json, not its parent folder.',
    ],
    causeZh: '两层原因：一是路径总长度超过 Windows 部分本地存储的上限；二是打开项目时要选中**装着 .vela 的那一层**。',
    causeEn: 'Two causes: the full path can exceed what some Windows local storage accepts, and opening a project requires selecting the folder that contains .vela.',
    fixZh: [
      '把整个小说文件夹（连同 .vela）移到更浅的位置，例如 D:\\Novels\\我的小说',
      '打开项目时选中这一层，不要选它的上级或下级',
      '移动之后如果旧路径仍被记住，重新打开一次即可，项目数据都在文件夹里',
    ],
    fixEn: [
      'Move the whole novel folder (including .vela) somewhere shallower, e.g. D:\\Novels\\MyNovel',
      'When opening, select exactly that folder — not its parent or child',
      'If the old path lingers in recent projects, just open it again; all data lives in the folder',
    ],
    codes: ['PROJECT_STORAGE_PATH_UNSUPPORTED', 'PROJECT_ROOT_REQUIRED'],
  },
  {
    id: 'project-switched',
    category: 'project',
    titleZh: '提示「当前项目已切换」，操作被中止',
    titleEn: '“The project changed” stops an operation',
    symptomZh: ['当前项目已切换，…已停止', '角色数据仍在切换项目，已拒绝跨项目保存'],
    symptomEn: ['The project changed, so … was stopped', 'Character data is still switching projects; the cross-project save was refused'],
    causeZh: '写操作都会带上「打开项目时的会话租约」，一旦你切到别的作品，旧窗口里排队中的请求就会被拒绝，避免把 A 书的正文写进 B 书。',
    causeEn: 'Every write carries the session lease from when the project was opened. After you switch novels, queued requests from the old window are refused so A’s text can never land in B.',
    fixZh: [
      '回到刚才那部作品，重新执行一次操作',
      '如果只是忘了保存：未保存的编辑仍在草稿账本里，切回该作品会自动恢复',
      '生成任务在切书时会被取消，切回后重新运行即可',
    ],
    fixEn: [
      'Switch back to that novel and repeat the action',
      'If you simply forgot to save: unsaved edits live in the draft ledger and come back when you reopen that novel',
      'Running workflows are cancelled on switch — start them again after returning',
    ],
    codes: ['LEASE_BEGIN_FAILED', 'LEASE_IDENTITY_MISMATCH'],
  },
  {
    id: 'embedding-missing',
    category: 'knowledge',
    titleZh: '知识库提示「请先配置向量模型」',
    titleEn: 'The knowledge base asks for an embedding model',
    symptomZh: ['请先配置向量模型。', 'error.embeddingModelNotConfigured'],
    symptomEn: ['Configure an embedding model first.', 'error.embeddingModelNotConfigured'],
    causeZh: '参考资料要做语义检索，需要专门的向量（embedding）模型；只配了对话模型是不够的。',
    causeEn: 'Semantic search over reference material needs a dedicated embedding model; a chat model alone is not enough.',
    fixZh: [
      '在「设置 → 模型设置」里再建一个模型（例如 BAAI/bge-m3、text-embedding-3-small）',
      '把它的「用途」只勾上 embedding，并设为默认向量模型',
      '不配也能用：知识库会退回 SQLite 全文检索（FTS），只是语义相近的段落搜不到',
    ],
    fixEn: [
      'Create another model in Settings → Model settings (e.g. BAAI/bge-m3, text-embedding-3-small)',
      'Tick only the embedding purpose and set it as the default embedding model',
      'Without it the knowledge base falls back to SQLite full-text search — exact words still work, semantic matches do not',
    ],
    codes: ['EMBEDDING_MODEL_NOT_CONFIGURED'],
  },
  {
    id: 'knowledge-native',
    category: 'knowledge',
    titleZh: '知识库不可用：原生组件加载失败',
    titleEn: 'The knowledge base is unavailable: native component failed to load',
    symptomZh: [
      '知识库不可用：Windows 原生组件加载失败。请重新安装或下载完整发布包。',
      '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。',
    ],
    symptomEn: [
      'The knowledge base is unavailable because its Windows native component could not be loaded. Reinstall or download the complete release package.',
      'Legacy knowledge-base data must be repaired before continuing. Fix vectors.json in the project, then try again.',
    ],
    causeZh: '向量检索依赖一个本地原生模块：安装包不完整、被杀软隔离，或项目里还留着旧版向量文件时会报这个。',
    causeEn: 'Vector search relies on a local native module: an incomplete install, antivirus quarantine, or leftover legacy vector files in the project all trigger this.',
    fixZh: [
      '从官方 Release 重新下载完整安装包并覆盖安装',
      '检查杀毒软件隔离区，把被隔离的模块恢复并加白名单',
      '旧项目提示修 vectors.json 时，先备份该文件，再按提示修复或删除后重建索引',
      '写作与生成不受影响 —— 只有知识库的语义检索会不可用',
    ],
    fixEn: [
      'Reinstall from the official Release package',
      'Check the antivirus quarantine, restore the module and allow-list it',
      'For the legacy vectors.json warning: back the file up first, then repair it or delete it and rebuild the index',
      'Writing and generation are unaffected — only semantic search is down',
    ],
    codes: ['KNOWLEDGE_BASE_NATIVE_UNAVAILABLE', 'LEGACY_VECTOR_MIGRATION_BLOCKED'],
  },
  {
    id: 'updates-disabled',
    category: 'app',
    titleZh: '检查更新不可用',
    titleEn: 'Update checks are unavailable',
    symptomZh: ['检查更新不可用', 'UPDATES_DISABLED'],
    symptomEn: ['Update checks are unavailable', 'UPDATES_DISABLED'],
    causeZh: '开发模式、免安装（绿色）运行，或网络访问不到 GitHub 时，更新检查会被关闭；这不影响写作。',
    causeEn: 'Update checks are off in development builds, portable runs, or when GitHub is unreachable. Writing is unaffected.',
    fixZh: [
      '用官方安装包安装一次，更新检查会恢复',
      '公司网络/代理环境请放行 GitHub 域名，或手动下载新版本覆盖安装',
    ],
    fixEn: [
      'Install once from the official package and update checks come back',
      'On a corporate network, allow GitHub domains or install new versions manually',
    ],
    codes: ['UPDATES_DISABLED'],
  },
]
