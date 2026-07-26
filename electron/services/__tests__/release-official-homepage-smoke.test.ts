import { afterEach, describe, expect, it, vi } from 'vitest'

import { OFFICIAL_HOMEPAGE_URL } from '../../../src/shared/official-homepage'
import {
  parseReleaseOfficialHomepageSmokeInvocation,
  runReleaseOfficialHomepageSmoke,
  type ReleaseOfficialHomepageSmokeDependencies,
} from '../release-official-homepage-smoke'

const previousFlag = process.env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE
const previousToken = process.env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN

function releaseHomepageSmokeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  delete environment.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE
  delete environment.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN
  Object.assign(environment, overrides)
  return environment
}

afterEach(() => {
  if (previousFlag === undefined) delete process.env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE
  else process.env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE = previousFlag
  if (previousToken === undefined) delete process.env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN
  else process.env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN = previousToken
})

describe('packaged official homepage smoke', () => {
  it('requires both the explicit environment opt-in and one-time command token', () => {
    const token = 'a'.repeat(32)
    const args = ['AI小说作家.exe', `--ai-novel-release-homepage-smoke=${token}`]

    expect(parseReleaseOfficialHomepageSmokeInvocation(args, releaseHomepageSmokeEnv())).toBeUndefined()
    expect(parseReleaseOfficialHomepageSmokeInvocation(args, releaseHomepageSmokeEnv({
      AI_NOVEL_RELEASE_HOMEPAGE_SMOKE: '1',
    }))).toBeUndefined()
    expect(parseReleaseOfficialHomepageSmokeInvocation(args, releaseHomepageSmokeEnv({
      AI_NOVEL_RELEASE_HOMEPAGE_SMOKE: '1',
      AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN: 'b'.repeat(32),
    }))).toBeUndefined()
    expect(parseReleaseOfficialHomepageSmokeInvocation(args, releaseHomepageSmokeEnv({
      AI_NOVEL_RELEASE_HOMEPAGE_SMOKE: '1',
      AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN: token,
    }))).toEqual({ token })
  })

  it('uses the packaged preload bridge to invoke only the fixed no-argument intent and records both shell outcomes', async () => {
    const token = 'a'.repeat(32)
    process.env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE = '1'
    process.env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN = token

    let currentHandler: (() => Promise<unknown>) | undefined
    const destroy = vi.fn()
    const executeJavaScript = vi.fn(async (source: string, userGesture?: boolean) => {
      expect(source).toContain("window.velaAPI.invoke('official-homepage:open')")
      expect(source).not.toContain(OFFICIAL_HOMEPAGE_URL)
      expect(userGesture).toBe(true)
      return currentHandler?.()
    })
    const probeWindow = {
      webContents: { executeJavaScript },
      loadFile: vi.fn(async () => {}),
      isDestroyed: () => false,
      destroy,
    }
    const removeHandler = vi.fn(() => { currentHandler = undefined })
    const registerController: ReleaseOfficialHomepageSmokeDependencies['registerController'] = vi.fn((options) => {
      if (!options.openExternal) throw new Error('Expected offline shell.openExternal probe')
      const openExternal = options.openExternal
      currentHandler = async () => {
        try {
          await openExternal(OFFICIAL_HOMEPAGE_URL)
          return { success: true }
        } catch {
          return { success: false, error: 'Unable to open the official homepage.' }
        }
      }
    })
    const dependencies: ReleaseOfficialHomepageSmokeDependencies = {
      createWindow: () => probeWindow,
      loadProbeDocument: vi.fn(async () => {}),
      removeHandler,
      registerController,
    }

    await expect(runReleaseOfficialHomepageSmoke(token, dependencies)).resolves.toEqual({
      schemaVersion: 1,
      kind: 'packaged-official-homepage-smoke',
      trustedIntent: {
        channel: 'official-homepage:open',
        requestArgumentCount: 0,
        url: OFFICIAL_HOMEPAGE_URL,
        success: true,
        shellOpenExternalCalls: 1,
      },
      failedOpenExternal: {
        success: false,
        controllerError: 'Unable to open the official homepage.',
        shellOpenExternalCalls: 1,
        rendererError: {
          zhCN: '无法打开官方主页，请稍后重试。',
          enUS: 'Unable to open the official homepage. Please try again later.',
        },
      },
    })

    expect(registerController).toHaveBeenCalledTimes(2)
    expect(removeHandler).toHaveBeenCalledWith('official-homepage:open')
    expect(executeJavaScript).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledOnce()
  })
})
