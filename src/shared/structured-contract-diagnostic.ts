export type StructuredContractDiagnosticCode =
  | 'invalid_json'
  | 'invalid_envelope'
  | 'missing_field'
  | 'invalid_type'
  | 'invalid_value'
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
  ) {
    const field = fieldFromPath(path)
    super(`结构化合同诊断 code=${code} path=${path} field=${field}`)
    this.name = 'StructuredContractDiagnostic'
    this.field = field
  }
}

export function structuredContractDiagnostic(
  error: unknown,
): StructuredContractDiagnostic | null {
  return error instanceof StructuredContractDiagnostic ? error : null
}
