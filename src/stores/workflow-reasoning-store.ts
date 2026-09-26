import { create } from 'zustand'

/** Volatile display state. Hidden reasoning never joins workflow history or generation artifacts. */
export const useWorkflowReasoningStore = create<{
  entries: Record<string, { attemptId: string; text: string }>
  append: (workflowRunId: string, attemptId: string, chunk: string) => void
  clear: (workflowRunId: string) => void
}>(set => ({
  entries: {},
  append: (workflowRunId, attemptId, chunk) => set(state => {
    const previous = state.entries[workflowRunId]
    return { entries: { ...state.entries, [workflowRunId]: {
      attemptId,
      text: (previous?.attemptId === attemptId ? previous.text : '') + chunk,
    } } }
  }),
  clear: workflowRunId => set(state => {
    if (!(workflowRunId in state.entries)) return state
    const entries = { ...state.entries }
    delete entries[workflowRunId]
    return { entries }
  }),
}))
