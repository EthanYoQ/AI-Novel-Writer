/**
 * 失败后再点「重试」有没有用，决定界面摆不摆重试、说明末尾补不补「请点『重试』」：
 * prompt 有用，说明末尾补提示；described 可能有用，说明里已写明前提，不再补；never 结果也一样，不摆重试；
 * after 要等那一步成功后才有用，整卡重试会把它排在那一步之后一起重跑。
 */
type StepRetry = 'prompt' | 'described' | 'never' | { after: string }

/** 定稿后处理步骤的错误码。步骤记录里存错误码本身，界面展示时再按当前界面语言换成作者可读说明。 */
const FINALIZATION_STEP_ERRORS: { code: RegExp; zh: string; en: string; retry: StepRetry }[] = [
  { code: /^FINALIZATION_GENERATION_INCOMPLETE$/, retry: 'prompt',
    zh: '模型这次没有返回完整结果（连接中断或输出被截断）。', en: 'The model did not return a complete result (the connection dropped or the output was cut off).' },
  { code: /^FINALIZATION_GENERATION_(ARTIFACT_REQUIRED|OUTCOME_UNKNOWN)$/, retry: 'prompt',
    zh: '上一次生成没有完成，本次没有发出新的模型请求。', en: 'The previous generation did not finish, and no new model request was sent.' },
  { code: /^FINALIZATION_GENERATION_RESULT_UNUSABLE$/, retry: 'prompt',
    zh: '模型返回了内容，但结果不可用（例如为空）。', en: 'The model returned a response, but the result was unusable (for example, empty).' },
  { code: /^GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE$/, retry: 'prompt',
    zh: '这一步的生成记录已变化，本次没有重新生成。', en: "This step's generation record changed, so it was not generated again." },
  { code: /^GENERATION_DISPATCH_BLOCKED$/, retry: 'prompt',
    zh: '这一步还有模型请求未结束，本次没有重新生成。', en: 'A model request for this step is still unfinished, so it was not generated again.' },
  { code: /^GENERATION_CONTEXT_LENGTH_EXCEEDED$/, retry: 'never',
    zh: '提示词超出了模型能接受的长度，服务商拒绝了这次请求，再点「重试」结果也一样。请换用上下文更长的模型或调低最大输出 Tokens 后，重新定稿本章。',
    en: 'The prompt is longer than the model accepts, so the provider rejected this request; retrying gives the same result. Switch to a model with a longer context or lower Max output tokens, then finalize this chapter again.' },
  { code: /^(ROOT_BUDGET_EXHAUSTED|USAGE_EXCEEDED_RESERVATION)$/, retry: 'never',
    zh: '这次后处理的模型调用额度已用完（请求超时或用量超出预留），再点「重试」也不会重新生成。',
    en: 'The model-call budget for this post-processing run is used up (a request timed out or exceeded its reserved usage). Retrying will not generate this step again.' },
  { code: /^(FINALIZATION_GENERATION_SOURCE_CHANGED|GENERATION_FINALIZATION_SOURCE_CHANGED|GENERATION_SOURCE_CHANGED|GENERATION_SOURCE_CHANGED_MODEL|GENERATION_MODEL_CHANGED)$/, retry: 'never',
    zh: '定稿正文或模型设置已变化，这一步不能沿用原记录。请重新定稿本章后再处理。', en: 'The finalized manuscript or model settings changed, so this step cannot reuse its record. Finalize this chapter again, then retry.' },
  // 写生成记录失败时主进程把整个 root 阻断，重试同样被拦下。
  { code: /^GENERATION_STORAGE_FAILED$/, retry: 'never',
    zh: '保存这次后处理的生成记录时写入失败，后处理已停止，再点「重试」也不会重新生成。请检查磁盘空间后重新定稿本章。',
    en: 'Saving the generation record for this post-processing run failed, so it stopped. Retrying will not generate this step again. Check disk space, then finalize this chapter again.' },
  // 生成记录缺了没写进去的尾部、已被丢弃或校验不符，不能拿来提交或修正。
  { code: /^GENERATION_FINALIZATION_ARTIFACT_INVALID$/, retry: 'never',
    zh: '这一步的生成记录不完整或已失效，不能沿用。请重新定稿本章后再处理。', en: "This step's generation record is incomplete or no longer valid, so it cannot be reused. Finalize this chapter again, then retry." },
  // 角色状态字段已由更晚章节写过或来源对不上（#491），提交拒写；正文定稿不受影响。
  { code: /^FINALIZED_CHARACTER_SOURCE_CONFLICT$/, retry: 'described',
    zh: '正文定稿已保存，但角色卡没有自动更新：这个角色的当前状态里有字段已由后面章节的定稿更新过，或它记录的来源与现在的定稿对不上，为免旧内容覆盖较新的状态，本次没有写入。如果这个项目是从备份恢复的、失败发生在升级前，新版本打开项目时已修复来源记录，可以点「重试」；重试仍失败，或不属于这种情况时，请到角色页的「当前状态」查看这些字段，需要时直接手动修改。',
    en: "The finalized chapter text is saved, but the character card was not updated: some of this character's current state was already updated by a later finalized chapter, or its recorded source no longer matches the current finalized text, so nothing was written to avoid overwriting newer state. If this project was restored from a backup and the failure happened before you updated the app, opening the project in this version already repaired its source records, so you can select Retry. If Retry still fails, or this is not your case, open the character's Current state view, check those fields, and edit them by hand if needed." },
  // 生成期间字段被作者或其他提交改过（#484）。重试沿用生成开始时冻结的角色状态，仍会拒写。
  { code: /^FINALIZED_CHARACTER_FIELD_CONFLICT$/, retry: 'never',
    zh: '正文定稿已保存，但角色卡没有自动更新：生成期间这个角色的当前状态被改动过（例如在角色页手动修改，或采纳了角色状态建议），为免覆盖这次改动，本次没有写入，再点「重试」结果也一样。这次改动已保留，请到角色页的「当前状态」查看这个角色，需要本章带来的变化时直接手动修改。',
    en: "The finalized chapter text is saved, but the character card was not updated: this character's current state changed while this step was running (for example, it was edited on the Characters page or a character state suggestion was accepted), so nothing was written to avoid overwriting that change. Retrying gives the same result. The change is kept. Open the character's Current state view, check it, and edit it by hand if this chapter should change it." },
  // 生成开始后正文依据的连续性记录变了（#512）：运行冻结的上下文不会变，重试先按来源已变拒绝。
  // CONTEXT_CHANGED 比对的字段提交前的来源校验已整组比过，按同一情形说明。
  { code: /^(GENERATION_FINALIZATION_IDENTITY_CHANGED|FINALIZED_CHARACTER_CONTEXT_CHANGED)$/, retry: 'never',
    zh: '正文定稿已保存，但这一步没有写入：生成期间有其他章节重新定稿或被删除，本章依据的前文记录变了，再点「重试」结果也一样。请重新定稿本章后再处理。',
    en: 'The finalized chapter text is saved, but this step was not saved: another chapter was finalized again or deleted while it was running, so the earlier-chapter records this chapter relies on changed. Retrying gives the same result. Finalize this chapter again to run this step.' },
  // 定稿时在场的角色后来被删除（#512），重试同样先按来源已变拒绝。
  { code: /^FINALIZED_CHARACTER_ID_RETIRED$/, retry: 'never',
    zh: '正文定稿已保存，但这一步没有写入：本章定稿时角色名单里的角色，有的后来被删除了，再点「重试」结果也一样。请重新定稿本章后再处理。',
    en: 'The finalized chapter text is saved, but this step was not saved: a character who was in the cast when this chapter was finalized has since been deleted. Retrying gives the same result. Finalize this chapter again to run this step.' },
  // 作者在生成期间改了本章「章节要点」（#512）。重试另开一次运行按现在的要点重新生成，写入时会替换作者的改动。
  { code: /^GENERATION_FINALIZATION_NOTES_CHANGED$/, retry: 'described',
    zh: '生成期间本章的「章节要点」被改动过（例如在章节蓝图里手动修改），为免覆盖这次改动，本次没有写入，角色状态更新也还没有进行。点「重试」会重新生成，并用新结果替换现在的章节要点；想保留这次改动就不要重试。',
    en: "This chapter's Chapter notes changed while this step was running (for example, they were edited on the chapter blueprint), so nothing was written to avoid overwriting that change, and the character state update has not run yet. Retry generates the notes again and replaces the current Chapter notes. To keep your change, don't retry." },
  { code: /^GENERATION_FINALIZATION_PREDECESSOR_REQUIRED$/, retry: { after: 'chapter_notes' },
    zh: '需要先完成「章节剧情要点」。', en: 'Chapter plot notes must finish first.' },
]

const IPC_PREFIX = /^Error invoking remote method '[^']+': Error: /u

/** 旧版本存下的步骤错误带 IPC 包装，先去掉再查表。 */
const entryOf = (error: string) => FINALIZATION_STEP_ERRORS.find(item => item.code.test(error.replace(IPC_PREFIX, '')))
const retryOf = (error: string | undefined): StepRetry => (error && entryOf(error)?.retry) || 'prompt'

/** 本流程认识的错误码（去掉 IPC 包装）；不认识时返回 undefined，原错误照常保留。 */
export function finalizationStepErrorCode(message: string): string | undefined {
  return entryOf(message) ? message.replace(IPC_PREFIX, '') : undefined
}

/** 步骤记录里的错误码换成作者可读说明；其他错误原样返回。 */
export function describeFinalizationStepError(error: string, text: (zhCNText: string, enUSText: string) => string): string {
  const entry = entryOf(error)
  if (!entry) return error
  const prompt = entry.retry === 'prompt'
  return text(
    entry.zh + (prompt ? '请点「重试」重新生成这一步。' : ''),
    entry.en + (prompt ? ' Select Retry to generate this step again.' : ''),
  )
}

/** 定稿后处理现在会跑的步骤，按运行顺序。旧版本的跑批里可能还留着别的步骤（如 style_analysis）。 */
const FINALIZE_POST_PROCESS_STEP_KEYS = ['kb_import', 'chapter_notes', 'character_cards'] as const
export type FinalizePostProcessStepKey = typeof FINALIZE_POST_PROCESS_STEP_KEYS[number]
const CURRENT_STEPS: ReadonlySet<string> = new Set(FINALIZE_POST_PROCESS_STEP_KEYS)

/**
 * 一张定稿后处理卡（步骤名到结果）的重试安排。rows：可以单独重试的未成功步骤；card：「重试失败步骤」要重跑的步骤，按卡上顺序；
 * retired：现在流程已没有的步骤，不重试。
 * 现有步骤没有错误或错误没登记的照常可以重试。
 */
export function planFinalizationRetry(steps: Readonly<Record<string, { ok: boolean; error?: string }>>): { rows: ReadonlySet<string>; card: readonly string[]; retired: ReadonlySet<string> } {
  const entries = Object.entries(steps)
  const retired = new Set(entries.map(([key]) => key).filter(key => !CURRENT_STEPS.has(key)))
  const succeeded = new Set(entries.filter(([, step]) => step.ok).map(([key]) => key))
  const unfinished = entries.filter(([key, step]) => !step.ok && !retired.has(key)).map(([key, step]) => ({ key, retry: retryOf(step.error) }))
  const direct = new Set(unfinished.filter(step => step.retry === 'prompt' || step.retry === 'described').map(step => step.key))
  const pick = (ready: (key: string) => boolean) => unfinished
    .filter(step => direct.has(step.key) || typeof step.retry === 'object' && ready(step.retry.after))
    .map(step => step.key)
  return { rows: new Set(pick(key => succeeded.has(key))), card: pick(key => succeeded.has(key) || direct.has(key)), retired }
}
