import { describe, expect, it } from 'vitest'
import { appErrorMessage } from '../app-errors'

describe('localized application errors', () => {
  it('maps stable error codes to localized messages', () => {
    expect(appErrorMessage('en-US', { code: 'KNOWLEDGE_BASE_NATIVE_UNAVAILABLE' }))
      .toContain('Windows native component')
    expect(appErrorMessage('zh-CN', { code: 'PROJECT_NOT_OPEN' }))
      .toBe('请先打开项目。')
    expect(appErrorMessage('en-US', { errorCode: 'PROJECT_NOT_OPEN' }))
      .toBe('Open a project first.')
    expect(appErrorMessage('zh-CN', { errorCode: 'PROJECT_ROOT_REQUIRED' }))
      .toContain('请选择项目根目录')
    expect(appErrorMessage('en-US', { errorCode: 'PROJECT_ROOT_REQUIRED' }))
      .toContain('Select the project root folder')
  })

  it('preserves an unknown error as localized diagnostic text', () => {
    expect(appErrorMessage('en-US', new Error('disk full'))).toBe('Something went wrong: disk full')
  })
})

it.each(['KNOWLEDGE_BASE_NATIVE_UNAVAILABLE','LEGACY_VECTOR_MIGRATION_BLOCKED'])('maps knowledge preparation IPC error %s without exposing internal details', code => {
 expect(appErrorMessage('en-US',new Error(`Error invoking remote method 'generation:prepare-draft-context': Error: ${code}`)))
   .toBe(appErrorMessage('en-US',{errorCode:code}))
})
