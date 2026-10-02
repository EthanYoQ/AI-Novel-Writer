/**
 * 模型在界面上的显示名。
 *
 * `ModelProfile.name` 是作者给这个模型起的**别名**，新建时允许为空
 * （见 `model-profile-draft.ts`：非向量模型的 name 默认为 `''`）。
 * 只显示 name 的话，顶栏的模型胶囊与状态栏的模型段会渲染成一片空白 ——
 * 看上去就像「当前模型不见了」，其实模型是好的，只是没起别名。
 *
 * 所以这里按「别名 → 模型标识 modelName → provider」逐级回退，
 * 保证只要有模型就一定能显示出人能认出来的名字。
 *
 * 参数刻意放宽成可选字符串：调用方手上可能只有其中一两个字段
 * （例如只读到了别名与模型标识），不必为了显示名字去凑齐整个 ModelProfile。
 */
export function modelDisplayName(
  model: {
    name?: string | null
    modelName?: string | null
    provider?: string | null
  } | null | undefined,
): string {
  if (!model) return ''
  for (const candidate of [model.name, model.modelName, model.provider]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return ''
}
