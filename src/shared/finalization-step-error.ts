/**
 * 定稿后处理步骤的错误码。步骤记录里存错误码本身，界面展示时再按当前界面语言换成作者可读说明。
 * retry 表示再点一次「重试」有意义。
 */
const FINALIZATION_STEP_ERRORS: { code: RegExp; zh: string; en: string; retry: boolean }[] = [
  { code: /^FINALIZATION_GENERATION_INCOMPLETE$/, retry: true,
    zh: '模型这次没有返回完整结果（连接中断或输出被截断）。', en: 'The model did not return a complete result (the connection dropped or the output was cut off).' },
  { code: /^FINALIZATION_GENERATION_(ARTIFACT_REQUIRED|OUTCOME_UNKNOWN)$/, retry: true,
    zh: '上一次生成没有完成，本次没有发出新的模型请求。', en: 'The previous generation did not finish, and no new model request was sent.' },
  { code: /^FINALIZATION_GENERATION_RESULT_UNUSABLE$/, retry: true,
    zh: '模型返回了内容，但结果不可用（例如为空）。', en: 'The model returned a response, but the result was unusable (for example, empty).' },
  { code: /^GENERATION_FINALIZATION_RECOVERY_UNAVAILABLE$/, retry: true,
    zh: '这一步的生成记录已变化，本次没有重新生成。', en: "This step's generation record changed, so it was not generated again." },
  { code: /^GENERATION_DISPATCH_BLOCKED$/, retry: true,
    zh: '这一步还有模型请求未结束，本次没有重新生成。', en: 'A model request for this step is still unfinished, so it was not generated again.' },
  { code: /^(ROOT_BUDGET_EXHAUSTED|USAGE_EXCEEDED_RESERVATION)$/, retry: false,
    zh: '这次后处理的模型调用额度已用完（请求超时或用量超出预留），再点「重试」也不会重新生成。',
    en: 'The model-call budget for this post-processing run is used up (a request timed out or exceeded its reserved usage). Retrying will not generate this step again.' },
  { code: /^(FINALIZATION_GENERATION_SOURCE_CHANGED|GENERATION_FINALIZATION_SOURCE_CHANGED|GENERATION_SOURCE_CHANGED|GENERATION_SOURCE_CHANGED_MODEL|GENERATION_MODEL_CHANGED)$/, retry: false,
    zh: '定稿正文或模型设置已变化，这一步不能沿用原记录。请重新定稿本章后再处理。', en: 'The finalized manuscript or model settings changed, so this step cannot reuse its record. Finalize this chapter again, then retry.' },
  // 写生成记录失败时主进程把整个 root 阻断，重试同样被拦下。
  { code: /^GENERATION_STORAGE_FAILED$/, retry: false,
    zh: '保存这次后处理的生成记录时写入失败，后处理已停止，再点「重试」也不会重新生成。请检查磁盘空间后重新定稿本章。',
    en: 'Saving the generation record for this post-processing run failed, so it stopped. Retrying will not generate this step again. Check disk space, then finalize this chapter again.' },
  // 生成记录缺了没写进去的尾部、已被丢弃或校验不符，不能拿来提交或修正。
  { code: /^GENERATION_FINALIZATION_ARTIFACT_INVALID$/, retry: false,
    zh: '这一步的生成记录不完整或已失效，不能沿用。请重新定稿本章后再处理。', en: "This step's generation record is incomplete or no longer valid, so it cannot be reused. Finalize this chapter again, then retry." },
  // 角色状态字段已由更晚章节写过或来源对不上（#491），提交拒写；正文定稿不受影响。
  { code: /^FINALIZED_CHARACTER_SOURCE_CONFLICT$/, retry: false,
    zh: '正文定稿已保存，但角色卡没有自动更新：这个角色的当前状态里有字段已由后面章节的定稿更新过，或它记录的来源与现在的定稿对不上，为免旧内容覆盖较新的状态，本次没有写入。可以先点「重试」；仍然失败时，请到角色页的「当前状态」查看这些字段，需要时直接手动修改。',
    en: "The finalized chapter text is saved, but the character card was not updated: some of this character's current state was already updated by a later finalized chapter, or its recorded source no longer matches the current finalized text, so nothing was written to avoid overwriting newer state. Try Retry first. If it fails again, open the character's Current state view, check those fields, and edit them by hand if needed." },
  { code: /^GENERATION_FINALIZATION_PREDECESSOR_REQUIRED$/, retry: false,
    zh: '需要先完成「章节剧情要点」。', en: 'Chapter plot notes must finish first.' },
]

const IPC_PREFIX = /^Error invoking remote method '[^']+': Error: /u

/** 本流程认识的错误码（去掉 IPC 包装）；不认识时返回 undefined，原错误照常保留。 */
export function finalizationStepErrorCode(message: string): string | undefined {
  const code = message.replace(IPC_PREFIX, '')
  return FINALIZATION_STEP_ERRORS.some(item => item.code.test(code)) ? code : undefined
}

/** 步骤记录里的错误码换成作者可读说明；其他错误原样返回。 */
export function describeFinalizationStepError(error: string, text: (zhCNText: string, enUSText: string) => string): string {
  // 旧版本存下的步骤错误带 IPC 包装，先去掉再查表。
  const code = error.replace(IPC_PREFIX, '')
  const entry = FINALIZATION_STEP_ERRORS.find(item => item.code.test(code))
  if (!entry) return error
  return text(
    entry.zh + (entry.retry ? '请点「重试」重新生成这一步。' : ''),
    entry.en + (entry.retry ? ' Select Retry to generate this step again.' : ''),
  )
}
