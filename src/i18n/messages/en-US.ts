import { CANONICAL_PROJECT_DIRECTORY } from '../../shared/project-format'
export const enUS = {
  'app.windowTitle': 'AI Novel Writer',
  'error.knowledgeBaseNativeUnavailable': 'The knowledge base is unavailable because its Windows native component could not be loaded. Reinstall or download the complete release package.',
  'error.legacyVectorMigrationBlocked': 'Legacy knowledge-base data must be repaired before continuing. Fix vectors.json in the project, then try again.',
  'error.projectNotOpen': 'Open a project first.',
  'error.embeddingModelNotConfigured': 'Configure an embedding model first.',
  'error.projectStoragePathUnsupported': 'The project path is too deep for some local storage. Move the entire project folder closer to the drive root (for example, D:\\Novels), then try again.',
  'error.projectLegacyImportRequired': 'This is a legacy project. Use Import legacy project to create a new copy. The original is kept.',
  'error.projectRootRequired': `Select the project root folder that contains ${CANONICAL_PROJECT_DIRECTORY}/project.json, not its parent folder.`,
  'error.unknown': 'Something went wrong: {message}',
  'error.generationRequestFailed': 'The generation request failed before its result was saved. Try again. If it keeps happening, report this message and when it occurred.',
  'error.generationProjectSessionStale': 'The book was switched or reopened, so this action from the earlier session did not run. Repeat it in the book that is open now.',
  'error.generationDraftNotCurrent': 'The selected draft is no longer the current draft of this chapter (a newer draft exists or it was finalized). No model request was sent. Open the current draft and try again.',
  'error.generationReviewLineageUnproven': 'This review has no traceable generation record, so it cannot drive a revision. Review the chapter again, then revise from the new review.',
  'error.generationDraftDependencyStale': 'An earlier draft this chapter was written from has changed, so the new prose was not saved. Rewrite or finalize the current draft of the previous chapter, then write this chapter again.',
  'error.generationDraftDependencyInvalid': 'The sources recorded for this chapter could not be read, so the new prose was not saved. Write the chapter again. If it keeps happening, report it.',
  'error.generationSourceChanged': 'The settings, blueprint, or earlier text this generation relied on changed while it ran, so the result was not saved. Generate it again.',
  'error.generationFinalizedSourceNotCurrent': 'A finalized earlier chapter this request relied on was replaced. No model request was sent. Start writing this chapter again.',
  'error.generationDraftIncomplete': 'The model output did not finish or fell short of the target length, so the prose was not saved. Try again.',
  'error.sourceDraftChanged': 'The source draft changed while AI was working on it, so the result was not saved. Reopen the current draft and try again.',
} as const

export type MessageKey = keyof typeof enUS
