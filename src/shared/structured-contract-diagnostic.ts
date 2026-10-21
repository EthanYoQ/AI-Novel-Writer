import type { Locale } from '../i18n/types'

export type StructuredContractDiagnosticCode =
  | 'invalid_json'
  | 'invalid_envelope'
  | 'missing_field'
  | 'invalid_type'
  | 'invalid_value'
  | 'empty_value'
  | 'value_too_long'
  | 'duplicate_item'
  | 'unexpected_item'
  | 'missing_item'
  | 'relationship_self_reference'
  | 'relationship_endpoint_not_in_characters'

function fieldFromPath(path: string): string {
  const match = /([A-Za-z_][A-Za-z0-9_]*)(?:\[\d+\])*$/u.exec(path)
  return match?.[1] ?? '$'
}

/**
 * Provider-safe structured output failure. It deliberately carries only a
 * stable code and schema path; candidate values and parser messages never
 * cross this boundary.
 */
export class StructuredContractDiagnostic extends Error {
  readonly field: string

  constructor(
    readonly code: StructuredContractDiagnosticCode,
    readonly path: string,
    readonly actualCharacters?: number,
    readonly maxCharacters?: number,
  ) {
    const field = fieldFromPath(path)
    const characterCounts = actualCharacters !== undefined && maxCharacters !== undefined
      ? ` actualCharacters=${actualCharacters} maxCharacters=${maxCharacters}`
      : ''
    super(`结构化合同诊断 code=${code} path=${path} field=${field}${characterCounts}`)
    this.name = 'StructuredContractDiagnostic'
    this.field = field
  }
}

export function structuredContractDiagnostic(
  error: unknown,
): StructuredContractDiagnostic | null {
  return error instanceof StructuredContractDiagnostic ? error : null
}

const DIAGNOSTIC_TEXT: Record<StructuredContractDiagnosticCode, readonly [zhCN: string, enUS: string]> = {
  invalid_json: ['不是完整的 JSON', 'is not complete JSON'],
  invalid_envelope: ['外层结构不对', 'has the wrong outer structure'],
  missing_field: ['缺少这个字段', 'is missing'],
  invalid_type: ['类型不对', 'has the wrong type'],
  invalid_value: ['取值不合要求', 'has a value that is not allowed'],
  empty_value: ['是空的', 'is empty'],
  value_too_long: ['太长', 'is too long'],
  duplicate_item: ['有重复项', 'has a duplicate entry'],
  unexpected_item: ['有多余的项', 'has an unexpected entry'],
  missing_item: ['缺少应有的项', 'is missing an expected entry'],
  relationship_self_reference: ['关系指向了角色自己', 'has a relationship that points to the character itself'],
  relationship_endpoint_not_in_characters: ['关系指向的角色不在本章角色里', "has a relationship with someone who is not among the chapter's characters"],
}

/** 作者手写的结构化内容（如蓝图恢复稿）不合契约时，给作者看的说明：哪个位置出了什么问题。 */
export function structuredContractDiagnosticText(
  locale: Locale,
  diagnostic: Pick<StructuredContractDiagnostic, 'code' | 'path'>,
): string {
  const [zhCN, enUS] = DIAGNOSTIC_TEXT[diagnostic.code]
  // 根路径 `$` 对作者是暗号，说成「整体内容」。
  const root = diagnostic.path === '$'
  return locale === 'en-US'
    ? `The content does not match the expected format: ${root ? 'the whole content' : diagnostic.path} ${enUS}.`
    : `内容格式不对：${root ? '整体内容' : `${diagnostic.path} `}${zhCN}。`
}
