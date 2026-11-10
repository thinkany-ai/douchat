import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname, join } from 'node:path'
import { safeStorage, shell } from 'electron'
import type {
  BuiltInAgentCapability,
  BuiltInAgentDefinition,
  BuiltInAgentManifest,
  DesktopAuthState,
  DesktopAuthUser,
  UpdateDesktopProfileInput,
  UsageSummary
} from '../shared/types'
import {
  createDesktopLoginUrl,
  DESKTOP_AUTH_CLIENT_ID,
  DOUCHAT_PRODUCTION_ORIGIN,
  DOUCHAT_WEB_APP_ORIGIN,
  parseDesktopAuthCallback
} from './authProtocol'
import type { DeviceIdentity } from './deviceIdentity'
import { DEVICE_IDENTITY_REQUIRED } from '../shared/ownerSignature'

interface StoredCredential {
  version: 1
  encryptedAccessToken: string
  /** Device the session was issued to; absent for sessions from older builds. */
  deviceId?: string
}

interface PendingFlow {
  state: string
  codeVerifier: string
  redirectUri: string
  createdAt: number
}

interface ApiEnvelope<T> {
  code: number
  message?: string
  data?: T
}

const FLOW_MAX_AGE_MS = 10 * 60 * 1000
const MAX_AVATAR_BYTES = 2 * 1024 * 1024

export function createLoopbackSuccessPage(): string {
  return createLoopbackResultPage()
}

function createLoopbackResultPage(error?: string): string {
  const title = error ? '登录未完成' : '登录成功'
  const description = error
    ? `请回到桌面客户端重新开始登录。${error}`
    : '账号已连接到 Douchat。你可以回到桌面客户端继续使用，也可以在浏览器中打开网页版。'
  // Signed in: the web app is the useful next stop in this browser. After a
  // failed sign-in it would only ask to sign in again, so link the website.
  const action = error
    ? { href: DOUCHAT_PRODUCTION_ORIGIN, label: '返回 Douchat 官网' }
    : { href: DOUCHAT_WEB_APP_ORIGIN, label: '打开 Douchat 网页版' }
  const escapedDescription = description.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!)
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · Douchat</title>
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      color: #111827;
      background: #f7f7fa;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f7f7fa;
    }
    main {
      width: min(100%, 420px);
      padding: 32px;
      text-align: center;
      background: #fff;
      border: 1px solid #dfe5f2;
      border-radius: 24px;
      box-shadow: 0 12px 40px -20px rgba(25, 35, 55, .18);
    }
    .status {
      width: 56px;
      height: 56px;
      margin: 0 auto 20px;
      display: grid;
      place-items: center;
      color: white;
      background: #1f63ff;
      border: 6px solid #e6edff;
      border-radius: 18px;
    }
    .status svg { width: 24px; height: 24px; }
    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      line-height: 1.3;
      letter-spacing: -.035em;
    }
    p {
      margin: 12px auto 0;
      max-width: 390px;
      color: #667085;
      font-size: 14px;
      line-height: 1.7;
    }
    .button {
      width: 100%;
      min-height: 44px;
      padding: 10px 24px;
      margin-top: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: white;
      background: #1f63ff;
      border-radius: 999px;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      box-shadow: 0 1px 2px rgba(25, 35, 55, .08);
      transition: transform .18s ease, background .18s ease, box-shadow .18s ease;
    }
    .button:hover {
      background: #1555e8;
      box-shadow: 0 3px 8px rgba(25, 35, 55, .12);
      transform: translateY(-1px);
    }
    .button:focus-visible {
      outline: 3px solid rgba(31, 99, 255, .28);
      outline-offset: 4px;
    }
    .button svg { width: 16px; height: 16px; }
    .hint {
      margin-top: 16px;
      color: #667085;
      font-size: 12px;
      line-height: 1.5;
    }
    @media (max-width: 520px) {
      body { padding: 16px; }
      main { padding: 28px 24px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .button { transition: none; }
    }
  </style>
</head>
<body>
  <main>
    <div class="status" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="${error ? 'M6 6l12 12M6 18L18 6' : 'm5 12 4.2 4.2L19 6.8'}" />
      </svg>
    </div>
    <h1>${title}</h1>
    <p>${escapedDescription}</p>
    <a class="button" href="${action.href}">
      ${action.label}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </a>
    <div class="hint">也可以直接关闭此页面</div>
  </main>
</body>
</html>`
}

export class DesktopAuth {
  private readonly credentialPath: string
  private readonly pendingPath: string
  private state: DesktopAuthState = { status: 'checking' }
  private accessToken = ''
  private deviceId = ''
  private callbackServer: Server | null = null

  constructor(
    private readonly webAppUrl: string,
    private readonly scheme: string,
    private readonly useLoopbackCallback: boolean,
    userDataPath: string,
    private readonly onChange: (state: DesktopAuthState, reason?: 'login-completed') => void,
    private readonly device?: DeviceIdentity
  ) {
    this.credentialPath = join(userDataPath, 'auth.json')
    this.pendingPath = join(userDataPath, 'auth-flow.json')
  }

  getState(): DesktopAuthState {
    return this.state
  }

  /** The model transport may read the current token in the main process only.
   * It is intentionally absent from DesktopAuthState and every IPC contract. */
  getAccessToken(): string | undefined {
    return this.state.status === 'signed-in' && this.accessToken ? this.accessToken : undefined
  }

  /** The owner device this session is bound to, when its key is available here.
   * Sessions from older builds have none and must sign in again to use daemons. */
  getDeviceId(): string | undefined {
    if (this.state.status !== 'signed-in' || !this.deviceId || this.device?.id !== this.deviceId) return undefined
    return this.deviceId
  }

  /** Public half of the device key, for host enrollment trust anchors. */
  getDevicePublicKey(): string | undefined {
    return this.getDeviceId() ? this.device?.publicKey : undefined
  }

  /** Signs owner commands with this session's device key (main process only). */
  signAsDevice(message: string): string {
    if (!this.getDeviceId()) throw new Error(DEVICE_IDENTITY_REQUIRED)
    return this.device!.sign(message)
  }

  async initialize(): Promise<DesktopAuthState> {
    this.setState({ status: 'checking' })
    const stored = await this.readCredential()
    if (!stored) {
      const pending = await this.readPendingFlow()
      if (pending?.redirectUri.startsWith('http://')) {
        await this.removeFile(this.pendingPath)
        return this.setState({ status: 'signed-out' })
      }
      return this.setState(pending ? { status: 'waiting' } : { status: 'signed-out' })
    }

    this.accessToken = stored.accessToken
    this.deviceId = stored.deviceId ?? ''
    if (this.deviceId) await this.device?.use(this.deviceId).catch(() => false)
    try {
      const user = await this.fetchUser(this.accessToken)
      return this.setState({ status: 'signed-in', user })
    } catch (error) {
      if (error instanceof InvalidSessionError) {
        await this.clearCredential()
        return this.setState({ status: 'signed-out' })
      }
      return this.setState({
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not reach the login service.'
      })
    }
  }

  async startLogin(): Promise<DesktopAuthState> {
    try {
      const codeVerifier = randomBytes(32).toString('base64url')
      const state = randomBytes(32).toString('base64url')
      const redirectUri = this.useLoopbackCallback
        ? await this.startLoopbackCallback(state)
        : `${this.scheme}://auth/callback`
      const flow: PendingFlow = { state, codeVerifier, redirectUri, createdAt: Date.now() }
      const codeChallenge = createHash('sha256').update(codeVerifier, 'utf8').digest('base64url')
      await this.writeJson(this.pendingPath, flow)
      this.setState({ status: 'waiting' })
      await shell.openExternal(createDesktopLoginUrl(this.webAppUrl, flow.state, codeChallenge, redirectUri))
      return this.state
    } catch (error) {
      this.stopLoopbackCallback()
      this.accessToken = ''
      await this.removeFile(this.pendingPath)
      return this.setState({
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not open the browser.'
      })
    }
  }

  /** Abandon a browser login that has not returned yet. A late callback then
   * finds no pending flow and is rejected as expired. */
  async cancelLogin(): Promise<DesktopAuthState> {
    if (this.state.status !== 'waiting') return this.state
    this.stopLoopbackCallback()
    await this.removeFile(this.pendingPath)
    return this.setState({ status: 'signed-out' })
  }

  /** End the desktop session without touching the user's local conversations. */
  async signOut(): Promise<DesktopAuthState> {
    this.stopLoopbackCallback()
    const accessToken = this.accessToken
    if (accessToken) {
      // Revocation is best-effort: signing out locally must still work when the
      // service is temporarily unreachable.
      try {
        await fetch(new URL('/api/desktop-auth/revoke', this.webAppUrl), {
          method: 'POST',
          headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
        })
      } catch {}
    }
    await this.clearCredential()
    await this.removeFile(this.pendingPath)
    return this.setState({ status: 'signed-out' })
  }

  /** A 401 from the first-party Chat API invalidates the same desktop session. */
  async invalidateSession(): Promise<DesktopAuthState> {
    this.stopLoopbackCallback()
    await this.clearCredential()
    await this.removeFile(this.pendingPath)
    return this.setState({ status: 'signed-out' })
  }

  async refreshProfile(): Promise<DesktopAuthState> {
    if (!this.accessToken) return this.setState({ status: 'signed-out' })
    try {
      return this.setState({ status: 'signed-in', user: await this.fetchUser(this.accessToken) })
    } catch (error) {
      if (error instanceof InvalidSessionError) {
        await this.clearCredential()
        return this.setState({ status: 'signed-out' })
      }
      throw error
    }
  }

  async updateProfile(input: UpdateDesktopProfileInput): Promise<DesktopAuthState> {
    if (!this.accessToken) return this.setState({ status: 'signed-out' })
    const changes: UpdateDesktopProfileInput = {}
    if (typeof input.name === 'string') {
      changes.name = input.name.trim()
      if (!changes.name) throw new Error('Name cannot be empty.')
    }
    if (typeof input.image === 'string') {
      const image = input.image.trim()
      try {
        changes.image = image.startsWith('data:image/')
          ? await this.uploadAvatarDataUrl(image)
          : image
      } catch (error) {
        if (error instanceof InvalidSessionError) {
          await this.clearCredential()
          return this.setState({ status: 'signed-out' })
        }
        throw error
      }
    }
    let response: Response
    try {
      response = await fetch(new URL('/api/desktop-auth/me', this.webAppUrl), {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(changes)
      })
    } catch {
      throw new Error('Could not reach the login service. Check your connection and try again.')
    }

    if (response.status === 401 || response.status === 403) {
      await this.clearCredential()
      return this.setState({ status: 'signed-out' })
    }
    const payload = await response.json().catch(() => null) as ApiEnvelope<{
      user?: Partial<DesktopAuthUser>
    }> | null
    if (!response.ok || !payload?.data?.user) {
      throw new Error(payload?.message || `Login service returned ${response.status}. Try again.`)
    }
    return this.setState({ status: 'signed-in', user: this.requireUser(payload.data.user) })
  }

  /** Upload a prepared avatar from the main process, where the desktop token
   * remains private, and return the public CDN URL saved on the account. */
  private async uploadAvatarDataUrl(dataUrl: string): Promise<string> {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!match) throw new Error('This picture could not be prepared for upload.')
    const bytes = Buffer.from(match[2], 'base64')
    if (!bytes.length || bytes.length > MAX_AVATAR_BYTES) {
      throw new Error('This picture is too large. Choose an image under 2 MB.')
    }

    const mimeType = match[1]
    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length)
    const formData = new FormData()
    formData.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), `avatar.${extension}`)

    let response: Response
    try {
      response = await fetch(new URL('/api/desktop-auth/avatar', this.webAppUrl), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`
        },
        body: formData
      })
    } catch {
      throw new Error('Could not upload your picture. Check your connection and try again.')
    }

    if (response.status === 401 || response.status === 403) throw new InvalidSessionError()
    const payload = await response.json().catch(() => null) as ApiEnvelope<{ url?: string }> | null
    if (!response.ok || !payload?.data?.url) {
      throw new Error(payload?.message || `Picture upload returned ${response.status}. Try again.`)
    }
    try {
      const uploaded = new URL(payload.data.url)
      if (uploaded.protocol !== 'https:') throw new Error('Avatar URL is not HTTPS')
      return uploaded.toString()
    } catch {
      throw new Error('Picture upload returned an invalid URL.')
    }
  }

  async getUsageSummary(): Promise<UsageSummary> {
    if (!this.accessToken) throw new Error('Sign in to view credits.')
    let response: Response
    try {
      response = await fetch(new URL('/api/desktop-auth/usage', this.webAppUrl), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.accessToken}` }
      })
    } catch {
      throw new Error('Could not load credits. Check your connection and try again.')
    }
    if (response.status === 401 || response.status === 403) {
      await this.clearCredential()
      this.setState({ status: 'signed-out' })
      throw new Error('Your session has expired. Sign in again.')
    }
    const payload = await response.json().catch(() => null) as ApiEnvelope<Partial<UsageSummary>> | null
    const credits = Number(payload?.data?.credits)
    if (!response.ok || !payload?.data || !Number.isFinite(credits) || credits < 0) {
      throw new Error(payload?.message || `Credits service returned ${response.status}. Try again.`)
    }
    return {
      planName: typeof payload.data.planName === 'string' && payload.data.planName.trim()
        ? payload.data.planName.trim()
        : 'Free',
      status: typeof payload.data.status === 'string' && payload.data.status.trim()
        ? payload.data.status.trim()
        : 'free',
      credits
    }
  }

  async getBuiltInAgentManifest(): Promise<BuiltInAgentManifest> {
    if (!this.accessToken) throw new Error('Sign in to load built-in agents.')
    let response: Response
    try {
      response = await fetch(new URL('/api/desktop-auth/built-in-agents', this.webAppUrl), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.accessToken}` }
      })
    } catch {
      throw new Error('Could not refresh built-in agents. The cached copy will remain available.')
    }
    if (response.status === 401 || response.status === 403) {
      await this.clearCredential()
      this.setState({ status: 'signed-out' })
      throw new Error('Your session has expired. Sign in again.')
    }
    const payload = await response.json().catch(() => null) as ApiEnvelope<unknown> | null
    if (!response.ok || !payload?.data) {
      throw new Error(payload?.message || `Built-in agent service returned ${response.status}.`)
    }
    return this.requireBuiltInManifest(payload.data)
  }

  async openBillingPortal(): Promise<void> {
    await shell.openExternal(new URL('/settings/billing', this.webAppUrl).toString())
  }

  async openSubscriptionPlans(): Promise<void> {
    await shell.openExternal(new URL('/desktop-credits', this.webAppUrl).toString())
  }

  async handleCallback(input: string): Promise<DesktopAuthState> {
    const flow = await this.readPendingFlow()
    if (!flow) return this.setState({ status: 'error', error: 'This login request has expired. Start again.' })

    this.setState({ status: 'checking' })
    try {
      const { code } = parseDesktopAuthCallback(input, flow.redirectUri, flow.state)
      const exchanged = await this.exchangeCode(code, flow.codeVerifier)
      this.accessToken = exchanged.accessToken
      this.deviceId = exchanged.deviceId ?? ''
      try {
        await this.saveCredential(exchanged.accessToken, exchanged.deviceId)
      } catch (error) {
        // Keychain access is optional for the current process. If the user
        // declines it, keep the authenticated session in memory and leave no
        // unreadable credential behind to trigger another prompt at startup.
        await this.removeFile(this.credentialPath)
        console.warn(
          '[douchat] secure session persistence unavailable; using an in-memory session:',
          error instanceof Error ? error.message : error
        )
      }
      await this.removeFile(this.pendingPath)
      return this.setState({ status: 'signed-in', user: exchanged.user }, 'login-completed')
    } catch (error) {
      this.accessToken = ''
      await this.removeFile(this.pendingPath)
      return this.setState({
        status: 'error',
        error: error instanceof Error ? error.message : 'Login could not be completed.'
      })
    } finally {
      this.stopLoopbackCallback()
    }
  }

  private startLoopbackCallback(expectedState: string): Promise<string> {
    this.stopLoopbackCallback()
    return new Promise((resolve, reject) => {
      let callbackInProgress = false
      const server = createServer(async (request, response) => {
        const address = server.address()
        if (!request.url || !address || typeof address === 'string') {
          response.writeHead(400).end('Invalid callback')
          return
        }
        const callbackUrl = new URL(request.url, `http://127.0.0.1:${address.port}`)
        if (
          request.method !== 'GET'
          || callbackUrl.pathname !== '/auth/callback'
          || callbackUrl.searchParams.get('state') !== expectedState
          || !/^[A-Za-z0-9_-]{43}$/.test(callbackUrl.searchParams.get('code') || '')
        ) {
          response.writeHead(404).end('Not found')
          return
        }
        // A refresh must not exchange the same one-time code a second time.
        if (callbackInProgress) {
          response.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
          response.end('正在完成登录，请返回客户端查看结果。')
          return
        }
        callbackInProgress = true
        let result: DesktopAuthState
        try {
          result = await this.handleCallback(callbackUrl.toString())
        } catch {
          result = this.setState({ status: 'error', error: 'Login could not be completed.' })
        }
        const error = result.status === 'signed-in' ? undefined : result.status === 'error' ? result.error : 'Login could not be completed.'
        response.writeHead(error ? 502 : 200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff'
        })
        response.end(createLoopbackResultPage(error))
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          reject(new Error('Could not start the desktop login callback.'))
          return
        }
        this.callbackServer = server
        resolve(`http://127.0.0.1:${address.port}/auth/callback`)
      })
    })
  }

  private stopLoopbackCallback(): void {
    this.callbackServer?.close()
    this.callbackServer = null
  }

  private setState(state: DesktopAuthState, reason?: 'login-completed'): DesktopAuthState {
    this.state = state
    this.onChange(state, reason)
    return state
  }

  private async fetchUser(accessToken: string): Promise<DesktopAuthUser> {
    let response: Response
    try {
      response = await fetch(new URL('/api/desktop-auth/me', this.webAppUrl), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` }
      })
    } catch {
      throw new Error('Could not reach the login service. Check your connection and try again.')
    }

    if (response.status === 401 || response.status === 403) throw new InvalidSessionError()
    if (!response.ok) throw new Error(`Login service returned ${response.status}. Try again.`)
    const payload = await response.json() as ApiEnvelope<{ user?: Partial<DesktopAuthUser> }>
    return this.requireUser(payload.data?.user)
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<{ accessToken: string; user: DesktopAuthUser; deviceId?: string }> {
    // Without secure storage the session simply has no device identity.
    // `device` alone is what services before per-account keys read.
    const devices = await this.device?.loginProofs(code).catch(() => []) ?? []
    const device = devices[0]
    let response: Response
    try {
      response = await fetch(new URL('/api/desktop-auth/token', this.webAppUrl), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, codeVerifier, clientId: DESKTOP_AUTH_CLIENT_ID, ...(device ? { device, devices } : {}) }),
        signal: AbortSignal.timeout(30_000)
      })
    } catch {
      throw new Error('Could not reach the login service. Check your connection and try again.')
    }

    const payload = await response.json().catch(() => null) as ApiEnvelope<{
      accessToken?: string
      deviceId?: string
      user?: Partial<DesktopAuthUser>
    }> | null
    if (!response.ok || !payload?.data) {
      const message = typeof payload?.message === 'string' ? payload.message.trim() : ''
      if (message && message !== 'HTTPError') throw new Error(message)
      throw new Error(`Could not complete desktop login (HTTP ${response.status}). Return to the app and try again.`)
    }
    const accessToken = payload.data.accessToken || ''
    if (!accessToken.startsWith('dch_')) throw new Error('Login service returned an invalid session.')
    // Only a device this computer proved can be adopted.
    const offered = devices.find(item => item.id === payload.data!.deviceId)
    const deviceId = offered && await this.device!.adopt(offered.id).catch(() => false) ? offered.id : undefined
    return { accessToken, user: this.requireUser(payload.data.user), ...(deviceId ? { deviceId } : {}) }
  }

  private requireUser(user: Partial<DesktopAuthUser> | null | undefined): DesktopAuthUser {
    if (!user?.id || !user.email) throw new Error('Login service returned an invalid user.')
    return {
      id: user.id,
      name: user.name || user.email,
      email: user.email,
      image: this.normalizedImage(user.image)
    }
  }

  private requireBuiltInManifest(value: unknown): BuiltInAgentManifest {
    if (!value || typeof value !== 'object') throw new Error('Built-in agent service returned invalid data.')
    const candidate = value as { version?: unknown; agents?: unknown }
    if (!Number.isInteger(candidate.version) || Number(candidate.version) < 1 || !Array.isArray(candidate.agents)) {
      throw new Error('Built-in agent service returned invalid data.')
    }
    const agents = candidate.agents.slice(0, 20).map((item): BuiltInAgentDefinition => {
      if (!item || typeof item !== 'object') throw new Error('Built-in agent service returned invalid data.')
      const agent = item as Record<string, unknown>
      const text = (key: string, max: number): string => {
        const result = typeof agent[key] === 'string' ? agent[key].trim() : ''
        if (!result || result.length > max) throw new Error('Built-in agent service returned invalid data.')
        return result
      }
      const identifier = (key: string, max: number): string => {
        const result = text(key, max)
        if (!/^[A-Za-z0-9:_-]+$/.test(result)) throw new Error('Built-in agent service returned invalid data.')
        return result
      }
      const systemRole = agent.systemRole === 'admin' ? 'admin' : undefined
      const capabilities = Array.isArray(agent.capabilities)
        ? agent.capabilities.filter((entry): entry is BuiltInAgentCapability => entry === 'manage_agents')
        : []
      const templateVersion = Number(agent.templateVersion)
      if (!systemRole || !Number.isInteger(templateVersion) || templateVersion < 1) {
        throw new Error('Built-in agent service returned invalid data.')
      }
      const localizations: BuiltInAgentDefinition['localizations'] = {}
      if (agent.localizations !== undefined) {
        if (!agent.localizations || typeof agent.localizations !== 'object' || Array.isArray(agent.localizations)) throw new Error('Invalid built-in agent translations.')
        for (const locale of ['en', 'zh-CN'] as const) {
          const value = (agent.localizations as Record<string, unknown>)[locale]
          if (value === undefined) continue
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid built-in agent translation.')
          const fields = value as Record<string, unknown>
          const translated = (key: string, max: number) => {
            if (typeof fields[key] !== 'string' || !fields[key].trim() || fields[key].length > max) throw new Error('Invalid built-in agent translation.')
            return fields[key].trim()
          }
          localizations[locale] = { role: translated('role', 100), instructions: translated('instructions', 12000), labels: translated('labels', 1000) }
        }
      }
      return {
        ...(Object.keys(localizations).length ? { localizations } : {}),
        id: identifier('id', 160),
        systemKey: identifier('systemKey', 80),
        systemRole,
        capabilities,
        templateVersion,
        name: text('name', 100),
        role: text('role', 100),
        instructions: text('instructions', 12_000),
        labels: typeof agent.labels === 'string' ? agent.labels.trim().slice(0, 1_000) : '',
        color: text('color', 32),
        modelRoute: identifier('modelRoute', 100)
      }
    })
    if (!agents.some((agent) => agent.systemKey === 'dr-dou' && agent.systemRole === 'admin')) {
      throw new Error('Built-in agent service did not return the system administrator.')
    }
    return { version: Number(candidate.version), agents }
  }

  private normalizedImage(value: string | undefined): string | undefined {
    if (!value) return undefined
    if (value.startsWith('data:image/')) return value
    try { return new URL(value, this.webAppUrl).toString() }
    catch { return undefined }
  }

  private async saveCredential(accessToken: string, deviceId?: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this computer.')
    }
    const stored: StoredCredential = {
      version: 1,
      encryptedAccessToken: safeStorage.encryptString(accessToken).toString('base64'),
      ...(deviceId ? { deviceId } : {})
    }
    await this.writeJson(this.credentialPath, stored)
  }

  private async readCredential(): Promise<{ accessToken: string; deviceId?: string } | null> {
    try {
      const stored = JSON.parse(await readFile(this.credentialPath, 'utf8')) as StoredCredential
      if (stored.version !== 1 || !safeStorage.isEncryptionAvailable()) {
        await this.removeFile(this.credentialPath)
        return null
      }
      const accessToken = safeStorage.decryptString(Buffer.from(stored.encryptedAccessToken, 'base64'))
      if (!accessToken.startsWith('dch_')) {
        await this.removeFile(this.credentialPath)
        return null
      }
      return { accessToken, ...(typeof stored.deviceId === 'string' && /^dev_[0-9a-f-]{36}$/.test(stored.deviceId) ? { deviceId: stored.deviceId } : {}) }
    } catch {
      await this.removeFile(this.credentialPath)
      return null
    }
  }

  private async readPendingFlow(): Promise<PendingFlow | null> {
    try {
      const flow = JSON.parse(await readFile(this.pendingPath, 'utf8')) as PendingFlow
      const valid = /^[A-Za-z0-9_-]{43}$/.test(flow.state)
        && /^[A-Za-z0-9_-]{43,128}$/.test(flow.codeVerifier)
        && this.validRedirectUri(flow.redirectUri)
        && Number.isFinite(flow.createdAt)
        && Date.now() - flow.createdAt <= FLOW_MAX_AGE_MS
      if (!valid) {
        await this.removeFile(this.pendingPath)
        return null
      }
      return flow
    } catch {
      return null
    }
  }

  private validRedirectUri(value: string): boolean {
    if (value === `${this.scheme}://auth/callback`) return true
    try {
      const url = new URL(value)
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port) && url.pathname === '/auth/callback'
    } catch {
      return false
    }
  }

  private async clearCredential(): Promise<void> {
    this.accessToken = ''
    this.deviceId = ''
    await this.removeFile(this.credentialPath)
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${process.pid}.tmp`
    await writeFile(temporaryPath, JSON.stringify(value), { mode: 0o600 })
    await rename(temporaryPath, path)
  }

  private async removeFile(path: string): Promise<void> {
    try { await unlink(path) } catch {}
  }
}

class InvalidSessionError extends Error {}
