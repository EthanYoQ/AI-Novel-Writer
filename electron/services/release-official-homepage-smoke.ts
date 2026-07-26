import {
  getOfficialHomepageOpenError,
  OFFICIAL_HOMEPAGE_URL,
} from '../../src/shared/official-homepage'
import type { OfficialHomepageControllerOptions } from '../controllers/official-homepage-controller'

const RELEASE_HOMEPAGE_SMOKE_ARGUMENT_PREFIX = '--ai-novel-release-homepage-smoke='
const OFFICIAL_HOMEPAGE_CHANNEL = 'official-homepage:open'

export interface ReleaseOfficialHomepageSmokeInvocation {
  token: string
}

export interface ReleaseOfficialHomepageSmokeEvidence {
  schemaVersion: 1
  kind: 'packaged-official-homepage-smoke'
  trustedIntent: {
    channel: 'official-homepage:open'
    requestArgumentCount: 0
    url: typeof OFFICIAL_HOMEPAGE_URL
    success: true
    shellOpenExternalCalls: 1
  }
  failedOpenExternal: {
    success: false
    controllerError: string
    shellOpenExternalCalls: 1
    rendererError: {
      zhCN: string
      enUS: string
    }
  }
}

interface OfficialHomepageSmokeWindow {
  webContents: {
    executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>
  }
  loadFile: (filePath: string) => Promise<void>
  isDestroyed: () => boolean
  destroy: () => void
}

export interface ReleaseOfficialHomepageSmokeDependencies {
  createWindow: () => OfficialHomepageSmokeWindow
  loadProbeDocument: (window: OfficialHomepageSmokeWindow) => Promise<void>
  removeHandler: (channel: string) => void
  registerController: (options: OfficialHomepageControllerOptions) => void
}

let claimedToken: string | undefined

export function releaseOfficialHomepageSmokeWasRequested(args: readonly string[] = process.argv): boolean {
  return args.some(argument => argument.startsWith(RELEASE_HOMEPAGE_SMOKE_ARGUMENT_PREFIX))
}

export function parseReleaseOfficialHomepageSmokeInvocation(
  args: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ReleaseOfficialHomepageSmokeInvocation | undefined {
  const matches = args.filter(argument => argument.startsWith(RELEASE_HOMEPAGE_SMOKE_ARGUMENT_PREFIX))
  if (matches.length !== 1 || env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE !== '1') return undefined
  const token = matches[0].slice(RELEASE_HOMEPAGE_SMOKE_ARGUMENT_PREFIX.length)
  if (!/^[a-f0-9]{32,128}$/i.test(token) || env.AI_NOVEL_RELEASE_HOMEPAGE_SMOKE_TOKEN !== token) return undefined
  return { token }
}

export function claimReleaseOfficialHomepageSmokeInvocation(
  args: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): ReleaseOfficialHomepageSmokeInvocation | undefined {
  const invocation = parseReleaseOfficialHomepageSmokeInvocation(args, env)
  if (!invocation || claimedToken !== undefined) return undefined
  claimedToken = invocation.token
  return invocation
}

function assertSmokeResult(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Packaged official homepage smoke failed: ${detail}`)
}

function isHomepageResponse(value: unknown): value is { success: boolean; error?: string } {
  return value != null
    && typeof value === 'object'
    && typeof (value as { success?: unknown }).success === 'boolean'
}

async function invokeOfficialHomepageFromRenderer(window: OfficialHomepageSmokeWindow): Promise<{ success: boolean; error?: string }> {
  // The string contains only the fixed no-argument trusted intent. The token,
  // URL, and any arbitrary renderer data never cross this renderer boundary.
  const response = await window.webContents.executeJavaScript(
    "window.velaAPI.invoke('official-homepage:open')",
    true,
  )
  assertSmokeResult(isHomepageResponse(response), 'preload renderer IPC did not return an official-homepage response')
  return response
}

/**
 * Runs from the packaged Electron main entry. It opens only a hidden local
 * document with the packaged preload bridge; `openExternal` is substituted at
 * the controller seam so this qualification cannot launch a browser or use a
 * network connection.
 */
export async function runReleaseOfficialHomepageSmoke(
  token: string,
  dependencies: ReleaseOfficialHomepageSmokeDependencies,
): Promise<ReleaseOfficialHomepageSmokeEvidence> {
  const invocation = parseReleaseOfficialHomepageSmokeInvocation(
    [`${RELEASE_HOMEPAGE_SMOKE_ARGUMENT_PREFIX}${token}`],
    process.env,
  )
  if (!invocation || invocation.token !== token) {
    throw new Error('Packaged official homepage smoke requires its environment and one-time CLI token')
  }

  const window = dependencies.createWindow()
  const successfulShellCalls: string[] = []
  const failedShellCalls: string[] = []
  try {
    await dependencies.loadProbeDocument(window)

    dependencies.removeHandler(OFFICIAL_HOMEPAGE_CHANNEL)
    dependencies.registerController({
      openExternal: async url => {
        successfulShellCalls.push(url)
        assertSmokeResult(url === OFFICIAL_HOMEPAGE_URL, 'trusted intent attempted an unexpected external URL')
      },
    })
    const successfulResult = await invokeOfficialHomepageFromRenderer(window)
    assertSmokeResult(successfulResult.success === true, 'trusted intent did not return success:true')
    assertSmokeResult(
      successfulShellCalls.length === 1 && successfulShellCalls[0] === OFFICIAL_HOMEPAGE_URL,
      'trusted intent did not call shell.openExternal exactly once with the fixed homepage URL',
    )

    dependencies.removeHandler(OFFICIAL_HOMEPAGE_CHANNEL)
    dependencies.registerController({
      openExternal: async url => {
        failedShellCalls.push(url)
        assertSmokeResult(url === OFFICIAL_HOMEPAGE_URL, 'failed intent attempted an unexpected external URL')
        throw new Error('offline shell.openExternal probe rejection')
      },
    })
    const failedResult = await invokeOfficialHomepageFromRenderer(window)
    assertSmokeResult(failedResult.success === false, 'shell.openExternal rejection did not return success:false')
    assertSmokeResult(
      failedShellCalls.length === 1 && failedShellCalls[0] === OFFICIAL_HOMEPAGE_URL,
      'failing shell.openExternal probe did not receive the fixed homepage URL exactly once',
    )
    assertSmokeResult(
      typeof failedResult.error === 'string' && failedResult.error.length > 0,
      'shell.openExternal rejection did not provide a controlled controller error',
    )

    return {
      schemaVersion: 1,
      kind: 'packaged-official-homepage-smoke',
      trustedIntent: {
        channel: OFFICIAL_HOMEPAGE_CHANNEL,
        requestArgumentCount: 0,
        url: OFFICIAL_HOMEPAGE_URL,
        success: true,
        shellOpenExternalCalls: 1,
      },
      failedOpenExternal: {
        success: false,
        controllerError: failedResult.error,
        shellOpenExternalCalls: 1,
        rendererError: {
          zhCN: getOfficialHomepageOpenError('zh-CN'),
          enUS: getOfficialHomepageOpenError('en-US'),
        },
      },
    }
  } finally {
    dependencies.removeHandler(OFFICIAL_HOMEPAGE_CHANNEL)
    if (!window.isDestroyed()) window.destroy()
  }
}
