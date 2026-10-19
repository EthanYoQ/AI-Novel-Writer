import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ directory: '', secure: true, openExternal: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => runtime.directory },
  safeStorage: {
    isEncryptionAvailable: () => runtime.secure,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  shell: { openExternal: runtime.openExternal },
}))

import { chatgptPlanAccessToken, chatgptPlanModels, chatgptPlanStatus, disconnectChatgptPlan, signInChatgptPlan } from '../chatgpt-plan'

const credentials = () => ({ clientId: 'issued-client', subject: 'account', email: 'test@example.invalid',
  idToken: 'test-id', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 0,
  scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] })
const save = (value = credentials()) => fs.writeFileSync(path.join(runtime.directory, 'chatgpt-plan.enc'), JSON.stringify(value))
const actualFetch = globalThis.fetch

describe('ChatGPT plan credentials', () => {
  beforeEach(() => {
    runtime.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-chatgpt-'))
    runtime.secure = true
    runtime.openExternal.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    disconnectChatgptPlan()
    fs.rmSync(runtime.directory, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('returns account status without exposing credentials', () => {
    save()
    expect(chatgptPlanStatus()).toEqual({ connected: true, sharing: true, email: 'test@example.invalid' })
    disconnectChatgptPlan()
    expect(chatgptPlanStatus().connected).toBe(false)
  })

  it('shares one rotating refresh across concurrent generations', async () => {
    save()
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'resource.invoke chatgpt.tokens.use.direct' })))
    expect(await Promise.all([chatgptPlanAccessToken(), chatgptPlanAccessToken()])).toEqual(['new-access', 'new-access'])
    expect(fetch).toHaveBeenCalledTimes(1)
    const saved = JSON.parse(fs.readFileSync(path.join(runtime.directory, 'chatgpt-plan.enc'), 'utf8'))
    expect(saved.refreshToken).toBe('new-refresh')
  })

  it('does not restore credentials when disconnected during refresh', async () => {
    save()
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = chatgptPlanAccessToken()
    disconnectChatgptPlan()
    finish(new Response(JSON.stringify({ access_token: 'new', refresh_token: 'new', expires_in: 3600 })))
    await expect(pending).rejects.toThrow('connection changed')
    expect(chatgptPlanStatus().connected).toBe(false)
  })

  it('requires secure storage before launching the browser', async () => {
    runtime.secure = false
    await expect(signInChatgptPlan()).rejects.toThrow('Secure credential storage')
    expect(runtime.openExternal).not.toHaveBeenCalled()
  })

  it('starts dynamic registration with PKCE and ignores a callback with the wrong state', async () => {
    runtime.openExternal.mockImplementation(async (address: string) => {
      const authorization = new URL(address)
      expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client')
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorization.searchParams.get('nonce')).toBeTruthy()
      const callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', 'wrong')
      expect((await globalThis.fetch(callback)).status).toBe(400)
      throw new Error('browser closed')
    })
    vi.unstubAllGlobals()
    await expect(signInChatgptPlan()).rejects.toThrow('browser closed')
    expect(chatgptPlanStatus().connected).toBe(false)
  })

  it('lists only account-visible slugs using the OAuth token', async () => {
    save({ ...credentials(), expiresAt: Date.now() + 3600_000 })
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ models: [
      { slug: 'available', display_name: 'Available model', visibility: 'list' },
      { slug: 'hidden', visibility: 'hidden' },
    ] })))
    expect(await chatgptPlanModels()).toEqual([{ slug: 'available', name: 'Available model' }])
    expect(fetch).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ headers: { Authorization: 'Bearer old-access' } }))
  })

  it.each([true, false])('validates the signed identity and nonce before saving (valid=%s)', async valid => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    let idToken = ''
    runtime.openExternal.mockImplementation(async (address: string) => {
      const authorization = new URL(address)
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'issued-client',
        sub: 'account', email: 'test@example.invalid', exp: Date.now() / 1000 + 3600,
        nonce: valid ? authorization.searchParams.get('nonce') : 'incorrect',
      })).toString('base64url')
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
      idToken = `${header}.${payload}.${signature}`
      const callback = new URL(authorization.searchParams.get('redirect_uri')!)
      callback.searchParams.set('state', authorization.searchParams.get('state')!)
      callback.searchParams.set('code', 'test-code')
      callback.searchParams.set('client_id', 'issued-client')
      await actualFetch(callback)
    })
    vi.mocked(fetch).mockImplementation(async address => String(address).endsWith('jwks.json')
      ? new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key' }] }))
      : new Response(JSON.stringify({ access_token: 'access', refresh_token: 'refresh', id_token: idToken,
        expires_in: 3600, scope: 'resource.invoke chatgpt.tokens.use.direct',
      })))
    if (valid) {
      expect(await signInChatgptPlan()).toEqual({ connected: true, sharing: true, email: 'test@example.invalid' })
    } else {
      await expect(signInChatgptPlan()).rejects.toThrow('claims are invalid')
      expect(chatgptPlanStatus().connected).toBe(false)
    }
  })
})
