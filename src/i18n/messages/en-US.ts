import { CANONICAL_PROJECT_DIRECTORY } from '../../shared/project-format'
export const enUS = {
  'app.windowTitle': 'Pagekin',
  'error.knowledgeBaseNativeUnavailable': 'The knowledge base is unavailable because its Windows native component could not be loaded. Reinstall or download the complete release package.',
  'error.legacyVectorMigrationBlocked': 'Legacy knowledge-base data must be repaired before continuing. Fix vectors.json in the project, then try again.',
  'error.projectNotOpen': 'Open a project first.',
  'error.embeddingModelNotConfigured': 'Configure an embedding model first.',
  'error.projectStoragePathUnsupported': 'The project path is too deep for some local storage. Move the entire project folder closer to the drive root (for example, D:\\Novels), then try again.',
  'error.projectLegacyImportRequired': 'This is a legacy project. Use Import legacy project to create a new copy. The original is kept.',
  'error.projectRootRequired': `Select the project root folder that contains ${CANONICAL_PROJECT_DIRECTORY}/project.json, not its parent folder.`,
  'error.unknown': 'Something went wrong: {message}',
} as const

export type MessageKey = keyof typeof enUS
