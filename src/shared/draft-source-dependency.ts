interface DraftSourceDependencyBase {
  draftId: number
  contentHash: string
}

/** Old rows omit `kind`; they are exact candidate-draft dependencies. */
export type DraftSourceDependency =
  | (DraftSourceDependencyBase & { kind?: 'candidate' })
  | (DraftSourceDependencyBase & {
      kind: 'finalized'
      chapterNumber: number
      finalizationId: string
    })
  | (DraftSourceDependencyBase & {
      kind: 'legacy-finalized'
      chapterNumber: number
    })
