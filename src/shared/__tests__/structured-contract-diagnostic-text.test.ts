import { expect, it } from 'vitest'
import { StructuredContractDiagnostic, structuredContractDiagnosticText } from '../structured-contract-diagnostic'

it('names the whole content instead of the "$" root path for authors (#474)', () => {
  const root = new StructuredContractDiagnostic('invalid_json', '$')
  expect(structuredContractDiagnosticText('en-US', root)).toBe('The content does not match the expected format: the whole content is not complete JSON.')
  expect(structuredContractDiagnosticText('zh-CN', root)).toBe('内容格式不对：整体内容不是完整的 JSON。')
  const field = new StructuredContractDiagnostic('missing_field', 'blueprints[0].characters')
  expect(structuredContractDiagnosticText('en-US', field)).toBe('The content does not match the expected format: blueprints[0].characters is missing.')
})
