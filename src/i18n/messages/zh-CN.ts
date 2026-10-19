import { CANONICAL_PROJECT_DIRECTORY } from '../../shared/project-format'
import type { MessageKey } from './en-US'

export const zhCN = {
  'app.windowTitle': 'AI小说作家 — AI Novel Writer',
  'error.knowledgeBaseNativeUnavailable': '知识库不可用：Windows 原生组件加载失败。请重新安装或下载完整发布包。',
  'error.legacyVectorMigrationBlocked': '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。',
  'error.projectNotOpen': '请先打开项目。',
  'error.embeddingModelNotConfigured': '请先配置向量模型。',
  'error.projectStoragePathUnsupported': '项目路径过深，部分本地存储不可用。请将整个项目文件夹移动到更靠近磁盘根目录的位置（例如 D:\\Novels），然后重试。',
  'error.projectLegacyImportRequired': '这是旧版项目，请通过“导入旧项目”创建新版副本后继续。旧项目会保留。',
  'error.projectRootRequired': `请选择项目根目录，也就是包含 ${CANONICAL_PROJECT_DIRECTORY}/project.json 的小说文件夹；不要选择它的上级文件夹。`,
  'error.unknown': '发生错误：{message}',
  'error.generationRequestFailed': '生成请求在保存结果前出错，本次结果没有保存。请重试；如果反复出现，请把这条提示和出错时间反馈给我们。',
  'error.generationProjectSessionStale': '作品已切换或重新打开，这次操作属于之前打开的作品，没有执行。请在当前作品里重新操作。',
  'error.generationDraftNotCurrent': '所选的稿已不是这一章的当前稿（已有更新的稿或已定稿），没有调用模型。请打开这一章的当前稿后再操作。',
  'error.generationReviewLineageUnproven': '这份审稿没有可追溯的生成记录，不能直接按它修稿。请先重新审稿，再按新的意见修稿。',
  'error.generationDraftDependencyStale': '这一章依据的前文稿已被改动，本次正文没有保存。请先重写或定稿前一章的当前稿，再重新写这一章。',
  'error.generationDraftDependencyInvalid': '这一章记录的前文来源无法识别，本次正文没有保存。请重新写这一章；如果反复出现，请反馈给我们。',
  'error.generationSourceChanged': '生成期间，它依据的设定、蓝图或前文有了变化，结果没有保存。请重新生成。',
  'error.generationFinalizedSourceNotCurrent': '这次依据的前章定稿已被替换，没有调用模型。请重新开始写这一章。',
  'error.generationDraftIncomplete': '模型输出没有正常写完或不够目标字数，正文没有保存。请重试。',
  'error.sourceDraftChanged': '原稿在 AI 处理期间被改动，结果没有保存。请重新打开当前稿后再试。',
} satisfies Record<MessageKey, string>
