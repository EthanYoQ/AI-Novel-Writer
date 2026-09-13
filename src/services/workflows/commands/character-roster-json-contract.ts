/**
 * 角色名单模型输出的唯一 JSON 契约。
 *
 * 正常架构生成和旧项目迁移可以使用不同的模型 purpose / system prompt，但
 * 版本化 schema、候选形状和一次受控语法修复必须保持同一套边界。
 */
export { CHARACTER_ROSTER_JSON_CONTRACT, CHARACTER_ROSTER_JSON_REPAIR_SYSTEM } from '../../../shared/legacy-roster-generation-pure'
import { buildCharacterRosterJsonRepairPrompt } from '../../../shared/legacy-roster-generation-pure'

export interface CharacterRosterJsonCandidate {
  schemaVersion: unknown
  entries: unknown
}

export interface CharacterRosterJsonRepairRequest {
  prompt: string
  systemPrompt: string
  purpose: string
}

/**
 * 窄 port：命令保留自己的取消语义、模型调用和 telemetry purpose，契约模块
 * 只编排一次 JSON 语法修复，绝不判断角色身份、关系或业务语义。
 */
export interface CharacterRosterJsonRepairPort {
  parseJson(text: string): unknown
  assertNotCancelled(): void
  log(message: string): void
  repair(request: CharacterRosterJsonRepairRequest): Promise<string>
}

export interface CharacterRosterJsonRepairOptions {
  repairSystemPrompt: string
  repairPurpose: string
}

export function parseCharacterRosterJsonCandidate(candidate: unknown): CharacterRosterJsonCandidate {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('AI 返回的角色名单不是 JSON 对象，未保存任何角色数据')
  }
  const record = candidate as Record<string, unknown>
  return {
    schemaVersion: record.schemaVersion,
    entries: record.entries,
  }
}

/**
 * 只在首次完整响应无法按 JSON 解析时允许一次低温语法修复。修复结果仍然
 * 只抽取候选 shape；所有 schema 与领域校验继续由 CharacterRosterRepository
 * 的原子 commit seam 完成。
 */
export async function parseCharacterRosterJsonResponse(
  rawText: string,
  port: CharacterRosterJsonRepairPort,
  options: CharacterRosterJsonRepairOptions,
): Promise<CharacterRosterJsonCandidate> {
  let parsed: unknown
  try {
    parsed = port.parseJson(rawText)
  } catch {
    port.assertNotCancelled()
    port.log('角色名单 JSON 格式异常，正在执行一次格式修复...')
    const repairedText = await port.repair({
      prompt: buildCharacterRosterJsonRepairPrompt(rawText),
      systemPrompt: options.repairSystemPrompt,
      purpose: options.repairPurpose,
    })
    try {
      parsed = port.parseJson(repairedText)
    } catch {
      throw new Error('AI 返回的角色名单 JSON 格式仍无效，未保存任何角色数据')
    }
  }
  return parseCharacterRosterJsonCandidate(parsed)
}
