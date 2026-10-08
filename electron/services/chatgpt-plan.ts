import { createHash, createPublicKey, createVerify, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { app, safeStorage, shell } from 'electron'

const RESOURCE = 'https://api.openai.com/v1'
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
const FILE = () => path.join(app.getPath('userData'), 'chatgpt-plan.enc')
const HOST_FILE = () => path.join(app.getPath('userData'), 'chatgpt-host-id')

interface Credentials {
  clientId: string
  subject: string
  email: string
  idToken: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
}

interface TokenReply {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in: number
  scope: string
}

function hostId(): string {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  if (fs.existsSync(HOST_FILE())) return fs.readFileSync(HOST_FILE(), 'utf8').trim()
  const value = `urn:uuid:${randomUUID()}`
  fs.writeFileSync(HOST_FILE(), value, { mode: 0o600, flag: 'wx' })
  return value
}

function readCredentials(): Credentials | null {
  if (!fs.existsSync(FILE()) || !safeStorage.isEncryptionAvailable()) return null
  const value = safeStorage.decryptString(fs.readFileSync(FILE()))
  return JSON.parse(value) as Credentials
}

function saveCredentials(value: Credentials): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
  const target = FILE()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 })
    fs.renameSync(temporary, target)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

async function verifyIdToken(token: string, clientId: string, nonce: string): Promise<{ sub: string; email: string }> {
  const [encodedHeader, encodedPayload, signature] = token.split('.')
  if (!encodedHeader || !encodedPayload || !signature) throw new Error('Invalid ID token')
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString()) as { alg?: string; kid?: string }
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as {
    iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string
  }
  if (header.alg !== 'RS256' || !header.kid || payload.iss !== 'https://auth.openai.com'
    || !(Array.isArray(payload.aud) ? payload.aud.includes(clientId) : payload.aud === clientId)
    || !payload.exp || payload.exp <= Date.now() / 1000 || payload.nonce !== nonce || !payload.sub) {
    throw new Error('ID token claims are invalid')
  }
  const response = await fetch('https://auth.openai.com/.well-known/jwks.json')
  if (!response.ok) throw new Error('Unable to validate ID token')
  const keys = await response.json() as { keys?: Array<JsonWebKey & { kid?: string }> }
  const key = keys.keys?.find(candidate => candidate.kid === header.kid)
  if (!key) throw new Error('ID token signing key was not found')
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${encodedHeader}.${encodedPayload}`)
  if (!verifier.verify(createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
    throw new Error('ID token signature is invalid')
  }
  return { sub: payload.sub, email: payload.email ?? '' }
}

async function exchange(fields: Record<string, string>): Promise<TokenReply> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  })
  if (!response.ok) throw new Error(`ChatGPT authorization failed (HTTP ${response.status})`)
  return await response.json() as TokenReply
}

export function chatgptPlanStatus(): { connected: boolean; email?: string; sharing: boolean } {
  const saved = readCredentials()
  return { connected: !!saved, email: saved?.email, sharing: !!saved?.scopes.includes('chatgpt.tokens.use.direct') }
}

export function disconnectChatgptPlan(): void {
  if (fs.existsSync(FILE())) fs.unlinkSync(FILE())
}

export async function signInChatgptPlan(): Promise<ReturnType<typeof chatgptPlanStatus>> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
  const previous = readCredentials()
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const server = http.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to start callback listener')
  const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
  const url = new URL('https://auth.openai.com/api/accounts/authorize')
  const clientId = previous?.clientId ?? 'dynamic_agent_client'
  for (const [key, value] of Object.entries({
    client_id: clientId, ext_agent_host_id: hostId(), response_type: 'code', redirect_uri: redirectUri,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: challenge,
  })) url.searchParams.set(key, value)
  if (!previous) url.searchParams.set('agent_name_hint', 'AI Novel Writer')
  if (previous?.email) url.searchParams.set('login_hint', previous.email)
  try {
    const callback = new Promise<URL>((resolve, reject) => {
      server.on('request', (request, response) => {
        const received = new URL(request.url ?? '/', redirectUri)
        if (received.pathname !== '/auth/callback') { response.writeHead(404).end(); return }
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('You can return to AI Novel Writer.')
        resolve(received)
      })
      server.once('error', reject)
    })
    await shell.openExternal(url.toString())
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('ChatGPT sign-in timed out')), 180_000)
    })
    const result = await Promise.race([callback, timeout]).finally(() => clearTimeout(timer))
    if (result.searchParams.get('state') !== state) throw new Error('ChatGPT sign-in state mismatch')
    if (result.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined')
    const code = result.searchParams.get('code')
    const issuedId = result.searchParams.get('client_id') ?? previous?.clientId
    if (!code || !issuedId || issuedId === 'dynamic_agent_client' || (previous && issuedId !== previous.clientId)) {
      throw new Error('ChatGPT registration did not return a valid client ID')
    }
    const tokens = await exchange({ grant_type: 'authorization_code', client_id: issuedId,
      code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE })
    if (!tokens.id_token || !tokens.refresh_token || !tokens.access_token) throw new Error('Incomplete ChatGPT token response')
    const identity = await verifyIdToken(tokens.id_token, issuedId, nonce)
    if (previous && identity.sub !== previous.subject) throw new Error('A different ChatGPT account was selected')
    const scopes = tokens.scope.split(/\s+/u)
    if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke')) {
      throw new Error('ChatGPT plan usage was not authorized')
    }
    saveCredentials({ clientId: issuedId, subject: identity.sub, email: identity.email,
      idToken: tokens.id_token, accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000, scopes })
    return chatgptPlanStatus()
  } finally {
    server.close()
  }
}

export async function chatgptPlanAccessToken(): Promise<string> {
  const saved = readCredentials()
  if (!saved?.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('Connect your ChatGPT plan in model settings')
  if (saved.expiresAt > Date.now() + 60_000) return saved.accessToken
  const tokens = await exchange({ grant_type: 'refresh_token', client_id: saved.clientId,
    refresh_token: saved.refreshToken, resource: RESOURCE })
  if (!tokens.access_token || !tokens.refresh_token) throw new Error('Reconnect your ChatGPT plan')
  saveCredentials({ ...saved, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000, scopes: tokens.scope ? tokens.scope.split(/\s+/u) : saved.scopes })
  return tokens.access_token
}

export async function chatgptPlanModels(): Promise<Array<{ slug: string; name: string }>> {
  const response = await fetch(`${RESOURCE}/models`, {
    headers: { Authorization: `Bearer ${await chatgptPlanAccessToken()}` },
  })
  if (!response.ok) throw new Error(`ChatGPT model listing failed (HTTP ${response.status})`)
  const data = await response.json() as { models?: Array<{ slug?: string; display_name?: string; visibility?: string }> }
  return (data.models ?? []).filter(model => model.visibility === 'list' && !!model.slug)
    .map(model => ({ slug: model.slug!, name: model.display_name ?? model.slug! }))
}
