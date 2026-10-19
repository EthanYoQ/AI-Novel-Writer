import { CANONICAL_PROJECT_DIRECTORY } from '../../shared/project-format'
import type { MessageKey } from './en-US'

export const zhCN = {
  'app.windowTitle': '书童 Pagekin',
  'error.knowledgeBaseNativeUnavailable': '知识库不可用：Windows 原生组件加载失败。请重新安装或下载完整发布包。',
  'error.legacyVectorMigrationBlocked': '旧版知识库数据需要先修复后才能继续。请修正项目中的 vectors.json，然后重试。',
  'error.projectNotOpen': '请先打开项目。',
  'error.embeddingModelNotConfigured': '请先配置向量模型。',
  'error.projectStoragePathUnsupported': '项目路径过深，部分本地存储不可用。请将整个项目文件夹移动到更靠近磁盘根目录的位置（例如 D:\\Novels），然后重试。',
  'error.projectLegacyImportRequired': '这是旧版项目，请通过“导入旧项目”创建新版副本后继续。旧项目会保留。',
  'error.projectRootRequired': `请选择项目根目录，也就是包含 ${CANONICAL_PROJECT_DIRECTORY}/project.json 的小说文件夹；不要选择它的上级文件夹。`,
  'error.unknown': '发生错误：{message}',
} satisfies Record<MessageKey, string>
