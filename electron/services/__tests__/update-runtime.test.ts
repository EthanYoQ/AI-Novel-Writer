import { describe, expect, it } from 'vitest'

import { isWindowsUpdateRuntimeEnabled } from '../update-runtime'

describe('isWindowsUpdateRuntimeEnabled', () => {
  it('enables updater startup only in a packaged Windows app without a development server', () => {
    expect(isWindowsUpdateRuntimeEnabled(true, undefined, 'win32')).toBe(true)
    expect(isWindowsUpdateRuntimeEnabled(false, undefined, 'win32')).toBe(false)
    expect(isWindowsUpdateRuntimeEnabled(true, 'http://127.0.0.1:5173', 'win32')).toBe(false)
    expect(isWindowsUpdateRuntimeEnabled(true, undefined, 'darwin')).toBe(false)
    expect(isWindowsUpdateRuntimeEnabled(true, undefined, 'linux')).toBe(false)
  })
})
