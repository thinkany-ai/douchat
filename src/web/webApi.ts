import { DEFAULT_DECISION_SETTINGS } from '../shared/groupDecision'
import { ACTIVITY_STALE_MS, type SupportShare, type RoomReadMark, type SyncedActivity, type SyncRecord, type WebSendRequest } from '../shared/cloudSync'
import type { SocialAction, SocialResult } from '../shared/social'
import type {
  AgentConfig,
  AppSnapshot,
  ChatMessage,
  Conversation,
  ConversationActivityState,
  DesktopAuthState,
  DesktopAuthUser,
  DouchatApi,
  PrivateMessage,
  Routine,
  Topic,
  UpdateConversationInput
} from '../shared/types'
import type { UserMemoryDocument } from '../shared/userMemory'
import { ensureBuiltInContact, greetNewChat, isCloudAgent, mergeDuplicateBuiltIns, sendToCloudAgent } from './cloudChat'
import { DESKTOP_PRESENCE_STALE_MS, DESKTOP_RPC, DESKTOP_RPC_TIMEOUT_MS, decodeRpcValue, encodeRpcValue, type DesktopPresence, type DesktopRpcCall, type DesktopRpcMethod } from '../shared/desktopRpc'
import { createCloudAgent, createGroup, deleteAgent as deleteCloudAgent, updateAgent as updateCloudAgent } from './agents'
import { sha256 } from './insecureContext'
import { siteOrigin } from './site'
import { WebSocial } from './webSocial'
import { BUILT_IN_PRODUCTS, parseProducts } from '../shared/products'
import { canRunCloudGroup, runCloudGroupRound, sendToCloudGroup } from './cloudGroup'
import type { HostTaskState } from '../shared/hostTask'
import { HostAgents, hostActivity, sendToHostAgent, type SocialCall } from './hostChat'
import { forgetActiveDevice, loginProofs, signOwnerCommand } from './webDevice'
import { WEB_HOST_PREFIX, WebHosts } from './webHosts'
import type { PermissionApproval, PermissionRequest } from '../shared/agentPermissions'
import { WebSync, type Mutation } from './webSync'

/**
 * `window.douchat` for the browser. The desktop UI runs unchanged on top of it.
 *
 * Account data comes from cloud sync. While a desktop on the same account is
 * online, everything the desktop window can do is done by that desktop, through
 * the same handlers (desktopRpc.ts), and messages are sent by it, so the web
 * app matches the desktop app. Without one, the web app does what needs no
 * computer itself: browse and organize chats, manage cloud agents, and talk to
 * cloud agents directly.
 */

const TOKEN_KEY = 'douchat.web.token'
const USER_KEY = 'douchat.web.user'
const LOGIN_KEY = 'douchat.web.login'
/** Set once a tab has asked the main site whether it is signed in, so that happens at most once. */
const SILENT_KEY = 'douchat.web.silentLogin'
/** The page to come back to after signing in. */
const RETURN_KEY = 'douchat.web.loginReturn'
const CLIENT_ID = 'douchat-desktop'
const PAGE_SIZE = 60
export const DESKTOP_ONLY = 'This is only available in the Douchat desktop app.'
export const DESKTOP_OFFLINE = 'Open the Douchat desktop app on this account to do this from the web.'
/** Calls that may legitimately answer null; any other null stood for an app snapshot. */
const NULL_ANSWERS = new Set<DesktopRpcMethod>(['getCodeArtifact', 'waitDaemonEnrollment'])
/** Calls a person waits on while something happens elsewhere (enrolling a server). */
const LONG_CALLS = new Set<DesktopRpcMethod>(['waitDaemonEnrollment', 'testConnection', 'discoverRemoteAgents'])

const desktopOnly = (): Promise<never> => Promise.reject(new Error(DESKTOP_ONLY))
const read = (key: string) => { try { return localStorage.getItem(key) ?? undefined } catch { return undefined } }
const write = (key: string, value?: string) => { try { value === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, value) } catch { /* Private mode: this tab only. */ } }

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const randomToken = (size: number) => base64Url(crypto.getRandomValues(new Uint8Array(size)))
/** The page Douchat serves the web app from; the login service only returns codes here. */
/** The sign-in return: a page of this build on this host, which the login service allows. */
const callbackUrl = () => `${location.origin}/app/index.html`

/**
 * The file in a base64 data: URL. Decoded here rather than with fetch(), which
 * the page's Content-Security-Policy (connect-src 'self') refuses for data: URLs.
 */
export function dataUrlBlob(url: string): Blob {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) throw new Error('This image could not be read. Choose it again.')
  const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0))
  return new Blob([bytes], { type: match[1] })
}

export function createWebApi(): DouchatApi {
  let token = read(TOKEN_KEY)
  let user = (() => { try { return JSON.parse(read(USER_KEY) ?? '') as DesktopAuthUser } catch { return undefined } })()
  let auth: DesktopAuthState = token && user ? { status: 'checking' } : { status: 'signed-out' }
  const authListeners = new Set<(state: DesktopAuthState) => void>()
  const snapshotListeners = new Set<(snapshot: AppSnapshot) => void>()
  let sync: WebSync | undefined
  /** Friends' chats and shared groups, which live on the social service. */
  let social: WebSocial | undefined
  let snapshot: AppSnapshot | undefined
  /** Cloud agent replies streaming in this tab, by conversation: a status until
   * the first words arrive, then the reply so far as an ordinary message. */
  const replying = new Map<string, { activity: ConversationActivityState; draft?: ChatMessage }>()
  /** Owner-task calls on the social channel (host-task-*, executor-list). */
  const socialCall: SocialCall = (body) => service('/api/desktop-auth/social', { method: 'POST', body: JSON.stringify(body) })
  /** Agents a douchat-host runs itself; they answer here while no desktop is online. */
  const hostAgents = new HostAgents(socialCall, () => { refresh(); adoptStrandedRequests() })
  /** douchat-host servers added here; they follow the service and need no desktop. */
  const webHosts = new WebHosts(socialCall, () => sync, () => user?.id)
  const connectionListeners = new Set<() => void>()
  /** After a change to web-added hosts: the panel reloads and chats see new agents. */
  const hostsChanged = () => { void hostAgents.refresh(true); for (const listener of connectionListeners) listener() }
  /** The desktop's connections when it is online, plus the hosts that follow the account. A host
   * the desktop also lists is shown once, as the account's: it works here without the desktop. */
  async function connections() {
    const [desktopList, own] = await Promise.all([desktopOnline() ? desktop<import('../shared/types').ConnectionView[]>('listConnections', []).catch(() => []) : [], webHosts.list()])
    const shared = new Set(own.map(item => item.daemon?.hostId))
    return [...desktopList.filter(item => !(item.kind === 'daemon' && shared.has(item.daemon?.hostId))), ...own]
  }
  /** The desktop's agents (when online) and those configured on hosts, each once. An agent the
   * desktop registered for a host that already has the same CLI is the same agent twice. */
  async function localAgents() {
    const [desktopAgents, desktopConnections, hosted] = await Promise.all([
      desktopOnline() ? desktop<import('../shared/types').LocalAgent[]>('detectLocalAgents', []).catch(() => []) : [],
      desktopOnline() ? desktop<import('../shared/types').ConnectionView[]>('listConnections', []).catch(() => []) : [],
      webHosts.localAgents()
    ])
    const hostOf = new Map(desktopConnections.flatMap(item => item.daemon ? [[item.id, item.daemon.hostId] as const] : []))
    return [...desktopAgents.filter(agent => !hosted.some(item => item.id === agent.id
      || (agent.remoteAgent && item.daemon?.hostId === hostOf.get(agent.remoteAgent.connectionId) && item.command === agent.remoteAgent.executable))), ...hosted]
  }
  /** Web-added hosts are handled here; everything else by the desktop that added it. */
  const onConnection = <T>(id: string, local: () => Promise<T>, method: DesktopRpcMethod, args: unknown[]): Promise<T> =>
    id.startsWith(WEB_HOST_PREFIX) ? local() : desktop<T>(method, args)
  /** Host tasks this tab waits on, by conversation and agent: for approval cards and stopping. */
  const hostTasks = new Map<string, HostTaskState & { conversationId: string; agentId: string; agentName: string }>()
  const trackHostTask = (conversationId: string, agent: AgentConfig, state: HostTaskState | undefined) => {
    const key = `${conversationId}\n${agent.id}`
    if (!state || state.status === 'succeeded' || state.status === 'failed') hostTasks.delete(key)
    else hostTasks.set(key, { ...state, conversationId, agentId: agent.id, agentName: agent.name })
    refresh()
  }
  /** A host's waiting approvals, shown with the desktop's approval card. */
  const hostApprovals = (): PermissionRequest[] => [...hostTasks.values()].flatMap(task => task.approvals.map((approval): PermissionRequest => {
    const item = approval as { id: string; capability?: string; taskScope?: string; operation?: string; details?: string; requester?: string; createdAt?: number; expiresAt?: number }
    const chat = conversation(task.conversationId)
    return { id: `remote:${item.id}`, ownerId: user?.id ?? '', agentId: task.agentId, agentName: task.agentName, requester: item.requester || task.agentName,
      roomName: chat?.name ?? '', context: chat?.type === 'group' ? 'group' : 'direct', capability: (item.capability || 'otherTools') as PermissionRequest['capability'],
      operation: item.operation ?? '', details: item.details ?? '', createdAt: item.createdAt ?? Date.now(), executorLabel: 'Server', ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}), ...(item.taskScope ? { taskScope: item.taskScope } : {}) }
  }))
  /** An owner-signed answer from this browser; the host checks it against its own device list. */
  async function resolveHostApproval(id: string, allow: PermissionApproval): Promise<void> {
    const approvalId = id.slice('remote:'.length)
    const task = [...hostTasks.values()].find(item => item.approvals.some(approval => approval.id === approvalId))
    const content = task?.approvals.find(approval => approval.id === approvalId) as Record<string, unknown> | undefined
    if (!task || !content || !user) throw new Error('This request was already answered or has expired.')
    const decision = allow === true || allow === 'task' || allow === 'session' ? 'allow' : 'deny'
    const scope = allow === 'task' ? 'task' : allow === 'session' ? 'session' : 'once'
    const hostId = String(content.hostId)
    const payload = { approvalId, taskId: content.taskId, requestId: content.requestId, paramsHash: content.paramsHash,
      bindingRevision: content.bindingRevision, claimHash: content.claimHash, decision, scope }
    // A host added here follows the service; one added on a desktop needs this browser's signature.
    await socialCall(hostAgents.serviceTrusted(hostId) ? { action: 'task-approval', hostId, payload }
      : { action: 'task-approval', hostId, signed: await signOwnerCommand({ origin: siteOrigin(), ownerId: user.id, hostId, method: 'task.approval', payload }) })
    task.approvals = task.approvals.filter(approval => approval.id !== approvalId)
    refresh()
  }
  /** This chat's agents that a douchat-host runs, with the folder chosen for each on its server. */
  async function hostWorkspaceView(conversationId: string): Promise<import('../shared/types').ConversationWorkspaceView> {
    await hostAgents.refresh()
    const chat = conversation(conversationId)
    const members = (chat?.agentIds ?? []).flatMap((agentId): import('../shared/types').MemberWorkspaceView[] => {
      const agent = sync?.get<AgentConfig>('agent', agentId)
      const host = hostAgents.host(agentId)
      if (!agent || !host || agent.ownerId !== user?.id) return []
      const saved = chat?.hostWorkspaces?.[agentId]
      const path = saved?.executionTargetId === `daemon:${host.hostId}` ? saved.path : undefined
      return [{ agentId, location: 'remote', host: host.name, noTerminal: true, ...(path ? { path, source: 'custom' as const } : { source: 'default' as const }) }]
    })
    return { eligible: members.length > 0, members }
  }
  async function hostFolderCall(agentId: string, method: 'fs.listDirs' | 'fs.resolveDir', params: Record<string, unknown>): Promise<unknown> {
    const host = hostAgents.host(agentId)
    if (!host) throw new Error(DESKTOP_OFFLINE)
    const result = await socialCall<{ ok?: boolean; pending?: boolean; result?: unknown }>({ action: 'host-control', hostId: host.hostId, method, params })
    if (result.pending) throw new Error('douchat-host did not answer in time. Check that it is online, then try again.')
    if (!result.ok) throw new Error((result.result as { message?: string } | null)?.message || 'douchat-host could not open this folder.')
    return result.result
  }
  async function setHostWorkspace(conversationId: string, agentId: string, binding: import('../shared/types').AgentWorkspaceBinding | undefined): Promise<void> {
    if (!sync) throw new Error('Sign in first.')
    await sync.mutate([{ kind: 'conversation', id: conversationId, apply: (current) => {
      if (!current) throw new Error('Chat not found')
      const next = structuredClone(current) as unknown as Conversation
      const saved = { ...next.hostWorkspaces }
      if (binding) saved[agentId] = binding
      else delete saved[agentId]
      if (Object.keys(saved).length) next.hostWorkspaces = saved
      else delete next.hostWorkspaces
      return next as unknown as SyncRecord
    } }])
  }
  /** Stops this chat's host tasks with an owner-signed cancel. */
  async function cancelHostTasks(conversationId: string): Promise<void> {
    if (!user) return
    for (const task of hostTasks.values()) {
      if (task.conversationId !== conversationId || !task.hostId || !task.claimHash || task.bindingRevision === undefined) continue
      const payload = { taskId: task.taskId, bindingRevision: task.bindingRevision, claimHash: task.claimHash }
      await socialCall(hostAgents.serviceTrusted(task.hostId) ? { action: 'task-cancel', hostId: task.hostId, payload }
        : { action: 'task-cancel', hostId: task.hostId, signed: await signOwnerCommand({ origin: siteOrigin(), ownerId: user.id, hostId: task.hostId, method: 'task.cancel', payload }) })
    }
  }

  const setAuth = (state: DesktopAuthState) => { auth = state; for (const listener of authListeners) listener(state) }
  const signOutLocally = () => {
    sync?.stop(); sync = undefined; snapshot = undefined
    social?.stop(); social = undefined
    hostAgents.clear()
    hostTasks.clear()
    forgetActiveDevice()
    token = undefined; user = undefined
    write(TOKEN_KEY); write(USER_KEY)
    setAuth({ status: 'signed-out' })
  }

  async function service<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!token) throw new Error('Sign in first.')
    const response = await fetch(path, { ...init, headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
    if (response.status === 401) { signOutLocally(); throw new Error('Your session expired. Sign in again.') }
    const payload = await response.json().catch(() => null) as { data?: T; message?: string } | null
    if (!response.ok || payload?.data === undefined) throw new Error(payload?.message || 'Could not reach Douchat. Try again.')
    return payload.data
  }

  function startSync(): Promise<void> {
    if (!social) {
      social = new WebSocial(service, () => user?.id, () => refresh())
      social.sharedReads = {
        get: (roomId) => sync?.get<RoomReadMark>('roomRead', roomId)?.readAt,
        mark: (roomId, readAt) => {
          if (!sync || (sync.get<RoomReadMark>('roomRead', roomId)?.readAt ?? 0) >= readAt) return
          // The later mark wins, whichever client wrote it.
          void sync.mutate([{ kind: 'roomRead', id: roomId, apply: (current) => (current?.readAt as number ?? 0) >= readAt ? current! : { roomId, readAt } }]).catch(() => undefined)
        }
      }
      social.start()
      void hostAgents.refresh(true)
    }
    if (!sync) {
      sync = new WebSync(() => token, signOutLocally)
      sync.subscribe(() => { snapshot = undefined; const next = currentSnapshot(); for (const listener of snapshotListeners) listener(next); adoptStrandedRequests() })
      // A desktop that syncs later can bring a second built-in Dr. Dou; fold it in when it shows up.
      let merging = false
      sync.subscribe(() => {
        if (merging || !sync || sync.all<AgentConfig>('agent').filter((agent) => agent.systemRole === 'admin').length < 2) return
        merging = true
        void mergeDuplicateBuiltIns(sync).catch(() => undefined).finally(() => { merging = false })
      })
    }
    return sync.start().then(() => {
      // An account that never used the desktop still gets Dr. Dou.
      if (sync && user) void mergeDuplicateBuiltIns(sync).then(() => ensureBuiltInContact(sync!, user!, service)).catch(() => undefined)
    })
  }
  const refresh = () => { snapshot = undefined; const next = currentSnapshot(); for (const listener of snapshotListeners) listener(next) }

  /**
   * Sign in on the main site, where an existing site session is reused. A
   * silent attempt never shows a form: the site answers with a code when it is
   * signed in and with login_required when it is not.
   */
  async function beginLogin(silent: boolean): Promise<void> {
    const verifier = randomToken(48)
    const state = randomToken(32)
    const challenge = base64Url(await sha256(verifier))
    sessionStorage.setItem(LOGIN_KEY, JSON.stringify({ state, verifier }))
    sessionStorage.setItem(RETURN_KEY, `${location.pathname}${location.hash}`)
    const login = new URL('/desktop-auth', siteOrigin())
    login.searchParams.set('client_id', CLIENT_ID)
    login.searchParams.set('state', state)
    login.searchParams.set('code_challenge', challenge)
    login.searchParams.set('redirect_uri', callbackUrl())
    if (silent) login.searchParams.set('prompt', 'none')
    location.replace(login.toString())
  }

  /** Finish a login the service redirected back here, then confirm the saved session. */
  async function boot(): Promise<void> {
    const params = new URLSearchParams(location.search)
    if (params.has('code') || params.has('error')) {
      // Back from the site: return to the page the person had opened.
      const back = sessionStorage.getItem(RETURN_KEY)
      sessionStorage.removeItem(RETURN_KEY)
      if (back && back.startsWith('/') && !back.startsWith('//')) history.replaceState(null, '', `${back}${location.search}`)
    }
    if (params.get('error') === 'login_required') {
      // The site is not signed in either: show the sign-in screen.
      history.replaceState(null, '', location.pathname)
      sessionStorage.removeItem(LOGIN_KEY)
      setAuth({ status: 'signed-out' })
      return
    }
    // The login callback and the bare entry page both open the chat list.
    const base = location.pathname === '/app' || location.pathname.startsWith('/app/') ? '/app' : ''
    if ([`${base}/index.html`, `${base}/`, base].includes(location.pathname)) history.replaceState(null, '', `${base}/chat${location.search}`)
    const code = params.get('code')
    const state = params.get('state')
    if (code && state) {
      history.replaceState(null, '', location.pathname)
      const pending = (() => { try { return JSON.parse(sessionStorage.getItem(LOGIN_KEY) ?? '') as { state: string; verifier: string } } catch { return undefined } })()
      sessionStorage.removeItem(LOGIN_KEY)
      if (!pending || pending.state !== state) { setAuth({ status: 'error', error: 'Login could not be verified. Try again.' }); return }
      try {
        // A device key lets this browser approve what agents on its servers ask for.
        const device = await loginProofs(code)
        const response = await fetch('/api/desktop-auth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, codeVerifier: pending.verifier, clientId: CLIENT_ID, ...(device ? { devices: device.proofs } : {}) }) })
        const payload = await response.json().catch(() => null) as { data?: { accessToken?: string; user?: DesktopAuthUser; deviceId?: string }; message?: string } | null
        if (!response.ok || !payload?.data?.accessToken || !payload.data.user) throw new Error(payload?.message || 'Login failed. Try again.')
        await device?.adopt(payload.data.deviceId).catch(() => undefined)
        token = payload.data.accessToken
        user = payload.data.user
        write(TOKEN_KEY, token); write(USER_KEY, JSON.stringify(user))
      } catch (error) { setAuth({ status: 'error', error: error instanceof Error ? error.message : 'Login failed. Try again.' }); return }
    }
    if (!token) {
      // Signed in on douchat.ai already? Then this signs in without a click.
      if (!sessionStorage.getItem(SILENT_KEY)) {
        sessionStorage.setItem(SILENT_KEY, '1')
        await beginLogin(true)
        return
      }
      setAuth({ status: 'signed-out' })
      return
    }
    try {
      const me = await service<{ user: DesktopAuthUser }>('/api/desktop-auth/me')
      user = me.user
      write(USER_KEY, JSON.stringify(user))
    } catch { if (!token) return }
    setAuth({ status: 'signed-in', user: user! })
    await startSync().catch(() => undefined)
  }
  const booted = boot()

  // ───────────────────────────── snapshot ─────────────────────────────

  function currentSnapshot(): AppSnapshot {
    if (snapshot) return snapshot
    const agents = sync?.all<AgentConfig>('agent') ?? []
    const rooms = social?.view() ?? { conversations: [], messages: [] }
    const conversations = [...(sync?.all<Conversation>('conversation') ?? []), ...rooms.conversations].filter((conversation) => !conversation.hidden || conversation.savedToContacts)
    const ids = new Set(conversations.map((conversation) => conversation.id))
    // A desktop sends the request as a message with the same id; until that arrives, show the request.
    const sent = new Set((sync?.all<ChatMessage>('message') ?? []).map((message) => message.id))
    const requests = (sync?.all<WebSendRequest>('request') ?? []).filter((request) => !sent.has(request.id) && ids.has(request.conversationId))
    const pending: ChatMessage[] = requests.map((request) => ({
      id: request.id,
      conversationId: request.conversationId,
      topicId: conversations.find((conversation) => conversation.id === request.conversationId)?.activeTopicId ?? '',
      authorId: 'user',
      authorName: user?.name ?? 'You',
      text: request.text,
      kind: 'message',
      createdAt: request.createdAt,
      deliveryState: request.state === 'failed' ? 'failed' : 'sending',
      ...(request.error ? { error: request.error } : {})
    }))
    const drafts = [...replying.values()].flatMap((reply) => reply.draft ? [reply.draft] : [])
    const messages = [...(sync?.all<ChatMessage>('message') ?? []).filter((message) => ids.has(message.conversationId)), ...rooms.messages, ...pending, ...drafts]
      .sort((a, b) => a.createdAt - b.createdAt)
    const admin = agents.find((agent) => agent.systemRole === 'admin')
    snapshot = {
      agents,
      agentStatuses: Object.fromEntries(agents.map((agent) => [agent.id, 'idle'])),
      conversations,
      messages,
      privateMessages: (sync?.all<PrivateMessage>('privateMessage') ?? []).filter((message) => ids.has(message.conversationId)),
      activity: [
        ...replying.values().filter((reply) => !reply.draft && ids.has(reply.activity.conversationId)).map((reply) => reply.activity),
        // A desktop's replies in progress; a copy it stopped refreshing is from a desktop that went away.
        ...(sync?.all<SyncedActivity>('activity') ?? []).filter((item) => ids.has(item.conversationId) && !replying.has(item.conversationId) && Date.now() - item.updatedAt < ACTIVITY_STALE_MS).map((item) => item.activity)
      ],
      computers: [],
      routines: (sync?.all<Routine>('routine') ?? []).sort((a, b) => a.nextRunAt - b.nextRunAt),
      runs: [],
      runEvents: [],
      permissionRequests: hostApprovals(),
      runtime: { mode: 'live', label: 'Douchat Web' },
      endpoint: { baseUrl: '', hasApiKey: false, source: 'account' },
      models: [],
      connectors: [],
      defaultConversationId: admin ? conversations.find((conversation) => conversation.type === 'direct' && conversation.agentIds[0] === admin.id)?.id : undefined,
      userName: user?.name ?? '',
      userAvatar: user?.image ?? ''
    }
    return snapshot
  }

  const conversation = (id: string) => sync?.get<Conversation>('conversation', id)
  async function mutate(mutations: Mutation[]): Promise<AppSnapshot> {
    if (!sync) throw new Error('Sign in first.')
    await sync.mutate(mutations)
    return currentSnapshot()
  }
  /** A desktop on this account that is online to take calls. */
  const desktopOnline = () => (sync?.all<DesktopPresence>('device') ?? []).some((device) => Date.now() - device.updatedAt < DESKTOP_PRESENCE_STALE_MS)

  /**
   * Run a desktop window operation on an online desktop and wait for its
   * answer. The desktop pushes what the call changed before answering, so the
   * account here is already up to date when this resolves.
   */
  async function desktop<T>(method: DesktopRpcMethod, args: unknown[]): Promise<T> {
    if (!sync) throw new Error('Sign in first.')
    if (!desktopOnline()) throw new Error(DESKTOP_OFFLINE)
    const call: DesktopRpcCall = { id: crypto.randomUUID(), method, args: encodeRpcValue(args) as unknown[], createdAt: Date.now(), state: 'pending' }
    const tracked = sync
    await tracked.mutate([{ kind: 'rpc', id: call.id, apply: () => call as unknown as SyncRecord }])
    const answer = await new Promise<DesktopRpcCall>((resolve, reject) => {
      let claimDeadline = setTimeout(() => finish(new Error(DESKTOP_OFFLINE)), DESKTOP_RPC_TIMEOUT_MS)
      let claimed = false
      const finish = (result: DesktopRpcCall | Error) => {
        clearTimeout(claimDeadline)
        unsubscribe()
        if (result instanceof Error) reject(result); else resolve(result)
      }
      const check = () => {
        const current = tracked.get<DesktopRpcCall>('rpc', call.id)
        if (!current) return
        if (current.state === 'done' || current.state === 'failed') { finish(current); return }
        if (current.state === 'claimed' && !claimed) {
          claimed = true
          clearTimeout(claimDeadline)
          claimDeadline = setTimeout(() => finish(new Error('The desktop did not finish in time. Try again.')), LONG_CALLS.has(method) ? 15 * 60_000 : 5 * 60_000)
        }
      }
      const unsubscribe = tracked.subscribe(check)
      check()
    })
    // The answer is read; the record has served its purpose.
    void tracked.mutate([{ kind: 'rpc', id: call.id, apply: () => null }]).catch(() => undefined)
    if (answer.state === 'failed') throw new Error(answer.error || 'The desktop could not do that.')
    const result = decodeRpcValue(answer.result)
    if (result === null && !NULL_ANSWERS.has(method)) return currentSnapshot() as T
    if (result && typeof result === 'object' && 'conversationId' in result && !('snapshot' in result) && method === 'startDirectChat') return { ...result, snapshot: currentSnapshot() } as T
    return result as T
  }
  /** On the desktop when one is online; otherwise what the web app can do itself. */
  const viaDesktop = <M extends DesktopRpcMethod>(method: M, local?: (...args: Parameters<DouchatApi[M]>) => ReturnType<DouchatApi[M]>) =>
    ((...args: Parameters<DouchatApi[M]>) => desktopOnline() || !local ? desktop(method, args) : local(...args)) as DouchatApi[M]

  /**
   * Answer a message in this tab when no desktop is online: a Douchat Cloud
   * agent's direct chat, or a group with cloud members. False when a desktop
   * has to send it. `messageId` keeps a queued request's id, so its "sending"
   * bubble becomes the sent message in place.
   */
  async function answerHere(conversationId: string, text: string, messageId?: string): Promise<boolean> {
    const target = conversation(conversationId)
    const [syncNow, tokenNow, userNow] = [sync, token, user]
    if (!target || desktopOnline() || !syncNow || !tokenNow || !userNow) return false
    await hostAgents.refresh()
    const agent = target.type === 'direct' && !target.id.startsWith('im-') ? syncNow.get<AgentConfig>('agent', target.agentIds[0]) : undefined
    const host = agent && hostAgents.host(agent.id)
    if (agent && host) {
      if (replying.has(conversationId)) throw new Error('This conversation is still replying')
      const startedAt = Date.now()
      const base: ConversationActivityState = { conversationId, topicId: target.activeTopicId, phase: 'replying', agentIds: [agent.id], label: agent.name, startedAt }
      replying.set(conversationId, { activity: base })
      refresh()
      try {
        await sendToHostAgent({ sync: syncNow, call: socialCall, user: userNow, agent, host: host.name, conversation: target, text, messageId,
          onState: (state) => { replying.set(conversationId, { activity: hostActivity(base, state, startedAt) }); trackHostTask(conversationId, agent, state) } })
      } finally {
        replying.delete(conversationId)
        trackHostTask(conversationId, agent, undefined)
      }
      return true
    }
    if (isCloudAgent(agent)) {
      if (replying.has(conversationId)) throw new Error('This conversation is still replying')
      const activity: ConversationActivityState = { conversationId, topicId: target.activeTopicId, phase: 'replying', agentIds: [agent.id], label: agent.name, startedAt: Date.now() }
      replying.set(conversationId, { activity })
      refresh()
      const draftId = crypto.randomUUID()
      const posts: ChatMessage[] = []
      try {
        await sendToCloudAgent({ sync: syncNow, token: tokenNow, user: userNow, agent, conversation: target, text, messageId, replyId: draftId, hooks: { onText: (reply) => {
          replying.set(conversationId, { activity, draft: { id: draftId, conversationId, topicId: activity.topicId, authorId: agent.id, authorName: agent.name, text: reply, kind: 'message', createdAt: Date.now() } })
          refresh()
        }, onFinish: () => { replying.delete(conversationId) }, onGroupPost: (post) => posts.push(post) } })
      } finally {
        replying.delete(conversationId)
        refresh()
      }
      // Like a desktop, a group post that mentions members runs once its sender is done.
      for (const post of posts) {
        const group = conversation(post.conversationId)
        if (!group || replying.has(group.id)) continue
        await answerInGroup(group, (onActivity) => runCloudGroupRound({ sync: syncNow, token: tokenNow, user: userNow, conversation: group, trigger: post, onActivity, hosts: { agents: hostAgents, call: socialCall, onState: trackHostTask } })).catch(() => undefined)
      }
      return true
    }
    if (canRunCloudGroup(syncNow, target, hostAgents)) {
      if (replying.has(conversationId)) throw new Error('This conversation is still replying')
      await answerInGroup(target, (onActivity) => sendToCloudGroup({ sync: syncNow, token: tokenNow, user: userNow, conversation: target, text, messageId, onActivity, hosts: { agents: hostAgents, call: socialCall, onState: trackHostTask } }))
      return true
    }
    return false
  }

  /** This tab, so a request it claims is recognizably its own. */
  const tabId = `web:${crypto.randomUUID()}`
  const adopting = new Set<string>()
  /** A tab that claimed a request and then closed leaves it claimed; another tab takes it over after this. */
  const ABANDONED_CLAIM_MS = 10 * 60_000
  const adoptable = (request: WebSendRequest | undefined) => request?.state === 'pending'
    || request?.state === 'claimed' && Boolean(request.deviceId?.startsWith('web:')) && Date.now() - (request.claimedAt ?? 0) > ABANDONED_CLAIM_MS
  /**
   * A message queued for a desktop that is no longer online would show
   * "sending" forever. When the chat can be answered here, claim the request
   * the way a desktop does (a revision-checked write, so only one client wins),
   * answer it, then remove it.
   */
  function adoptStrandedRequests(): void {
    if (!sync || desktopOnline()) return
    for (const request of sync.all<WebSendRequest>('request')) {
      if (!adoptable(request) || adopting.has(request.id) || replying.has(request.conversationId)) continue
      const target = conversation(request.conversationId)
      const direct = target?.type === 'direct' ? sync.get<AgentConfig>('agent', target.agentIds[0]) : undefined
      if (!target || target.type === 'direct' && !(Boolean(direct && hostAgents.host(direct.id)) || isCloudAgent(direct)) || target.type === 'group' && !canRunCloudGroup(sync, target, hostAgents)) continue
      adopting.add(request.id)
      const tracked = sync
      void (async () => {
        await tracked.mutate([{ kind: 'request', id: request.id, apply: (current) => adoptable(current as unknown as WebSendRequest | undefined)
          ? { ...current, state: 'claimed', deviceId: tabId, claimedAt: Date.now() } : current ?? null }])
        if (tracked.get<WebSendRequest>('request', request.id)?.deviceId !== tabId) return
        try {
          await answerHere(request.conversationId, request.text, request.id)
          await tracked.mutate([{ kind: 'request', id: request.id, apply: () => null }])
        } catch (error) {
          await tracked.mutate([{ kind: 'request', id: request.id, apply: (current) => current
            ? { ...current, state: 'failed', error: error instanceof Error ? error.message : 'The message could not be sent.' } : null }])
        }
      })().catch(() => undefined).finally(() => adopting.delete(request.id))
    }
  }

  /** Show a group's planning and replying state while its cloud agents answer in this tab. */
  async function answerInGroup(group: Conversation, run: (onActivity: (phase: 'planning' | 'replying', agentIds: string[]) => void) => Promise<void>): Promise<void> {
    const show = (phase: 'planning' | 'replying', agentIds: string[]) => {
      replying.set(group.id, { activity: { conversationId: group.id, topicId: group.activeTopicId, phase, agentIds, label: agentIds.map((id) => sync?.get<AgentConfig>('agent', id)?.name ?? '').join(', '), startedAt: Date.now() } })
      refresh()
    }
    show('planning', [])
    try { await run(show) }
    finally { replying.delete(group.id); refresh() }
  }

  /**
   * For changes a person expects to see at once (read, pinned, muted, shown):
   * the page applies them before any request leaves, so answer now and let
   * the cloud write finish in the background.
   */
  function applyNow(mutations: Mutation[]): Promise<AppSnapshot> {
    if (!sync) return Promise.reject(new Error('Sign in first.'))
    void sync.mutate(mutations).catch((error) => window.douchat?.reportDiagnostic?.('web.sync-write-failed', String(error)))
    return Promise.resolve(currentSnapshot())
  }

  const editConversation = (id: string, edit: (conversation: Conversation) => void): Mutation => ({
    kind: 'conversation',
    id,
    apply: (current) => {
      if (!current) throw new Error('Chat not found')
      const next = structuredClone(current) as unknown as Conversation
      edit(next)
      return next as unknown as SyncRecord
    }
  })
  const deleteMessages = (filter: (message: ChatMessage) => boolean): Mutation[] =>
    (sync?.all<ChatMessage>('message') ?? []).filter(filter).map((message) => ({ kind: 'message', id: message.id, apply: () => null }))

  /** Friend and group actions the web app can do; adding agents needs their owner's desktop. */
  async function socialAction(input: SocialAction): Promise<SocialResult> {
    if (!social) throw new Error('Sign in first.')
    const room = (conversationId: string) => {
      const found = social!.roomOf(conversationId)
      if (!found) throw new Error(DESKTOP_ONLY)
      return found
    }
    let result: SocialResult
    switch (input.action) {
      case 'group-invite': {
        // A group not shared yet becomes a shared room on the desktop that runs its agents.
        if (!social.roomOf(input.conversationId)) {
          if (desktopOnline()) return desktop('socialAction', [input])
          throw new Error('Open the Douchat desktop app once to share this group, then invite from here.')
        }
        const target = room(input.conversationId)
        result = await social.action({ action: 'group-invite', roomId: target.id, regenerate: Boolean(input.regenerate) } as Record<string, unknown>)
        if (!result.invite) throw new Error('Invitation could not be created')
        const url = new URL('/join-group', siteOrigin())
        url.searchParams.set('room', target.id)
        url.searchParams.set('token', result.invite.token)
        return { ...result, invite: { ...result.invite, url: url.toString() } }
      }
      case 'invite-members':
        if (input.agentIds.length) return desktop('socialAction', [input])
        result = await social.action({ action: 'add-members', roomId: room(input.conversationId).id, friendIds: input.friendIds })
        break
      case 'create-room':
        if (input.kind === 'agent' || input.agentIds?.length) return desktop('socialAction', [input])
        result = await social.action(input)
        break
      // Adding one's own agent to a group needs the desktop that runs it.
      case 'add-agent':
        return desktop('socialAction', [input])
      case 'send':
        throw new Error(DESKTOP_ONLY)
      default:
        result = await social.action(input)
    }
    await social.refresh().catch(() => undefined)
    if (result.roomId && !result.conversationId && user) {
      const created = social.getSnapshot().rooms.find((item) => item.id === result.roomId)
      if (created) result = { ...result, conversationId: `${created.kind === 'direct' ? 'friend' : 'shared'}:${user.id}:${created.id}` }
    }
    return { ...result, snapshot: social.getSnapshot() }
  }

  // ───────────────────────────── the API ─────────────────────────────

  const api: Partial<DouchatApi> = {
    platform: 'web',
    microphonePermissionOwner: 'Douchat',
    desktopAvailability: () => desktopOnline() ? 'online' : 'offline',

    // Account and session.
    getAuthState: async () => { await booted; return auth },
    onAuthState: (listener) => { authListeners.add(listener); return () => authListeners.delete(listener) },
    startLogin: async () => {
      await beginLogin(false)
      setAuth({ status: 'waiting' })
      return auth
    },
    cancelLogin: async () => { sessionStorage.removeItem(LOGIN_KEY); setAuth({ status: 'signed-out' }); return auth },
    retryAuth: async () => { await boot(); return auth },
    signOut: async () => {
      if (token) await fetch('/api/desktop-auth/revoke', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
      signOutLocally()
      return auth
    },
    refreshProfile: async () => {
      const me = await service<{ user: DesktopAuthUser }>('/api/desktop-auth/me')
      user = me.user
      write(USER_KEY, JSON.stringify(user))
      setAuth({ status: 'signed-in', user })
      return auth
    },
    /** The account itself lives on the service, so the web app edits it directly. */
    updateProfile: async (input) => {
      const changes: { name?: string; image?: string } = {}
      if (typeof input.name === 'string') {
        changes.name = input.name.trim()
        if (!changes.name) throw new Error('Name cannot be empty.')
      }
      if (typeof input.image === 'string') {
        let image = input.image.trim()
        if (image.startsWith('data:image/')) {
          const blob = dataUrlBlob(image)
          const form = new FormData()
          form.append('file', blob, `avatar.${blob.type === 'image/jpeg' ? 'jpg' : blob.type.slice('image/'.length) || 'png'}`)
          image = (await service<{ url: string }>('/api/desktop-auth/avatar', { method: 'POST', body: form })).url
        }
        changes.image = image
      }
      const me = await service<{ user: DesktopAuthUser }>('/api/desktop-auth/me', { method: 'PATCH', body: JSON.stringify(changes) })
      user = me.user
      write(USER_KEY, JSON.stringify(user))
      setAuth({ status: 'signed-in', user })
      refresh()
      return auth
    },
    getUsageSummary: () => service('/api/desktop-auth/usage'),
    consumeCreditsReturn: async () => false,
    // Top up in this tab; the credits page brings the person back to Settings → Credits.
    openSubscriptionPlans: async () => {
      // Back to the chat (or page) this started from once paid. The credits page lives on the site, under /app's sibling.
      const here = new URL(location.pathname.replace(/\/settings\/[^/]*$/, '/chat'), location.origin).toString()
      location.assign(`${siteOrigin()}/desktop-credits?client=web&return=${encodeURIComponent(here)}`)
    },
    openBillingPortal: async () => { window.open(`${siteOrigin()}/settings/billing`, '_blank', 'noopener') },
    setInterfaceLanguage: async () => undefined,

    // Synced account data.
    getSnapshot: async () => { await booted; return currentSnapshot() },
    onSnapshot: (listener) => { snapshotListeners.add(listener); return () => snapshotListeners.delete(listener) },
    searchMessages: async (conversationId, query) => {
      const needle = query.trim().toLocaleLowerCase()
      return currentSnapshot().messages.filter((message) => message.conversationId === conversationId && message.text.toLocaleLowerCase().includes(needle))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 100)
    },
    getMessagePage: async (conversationId, topicId, before) => {
      const topic = currentSnapshot().messages.filter((message) => message.conversationId === conversationId && message.topicId === topicId)
      const end = before ? topic.findIndex((message) => message.id === before) : topic.length
      const stop = end < 0 ? topic.length : end
      return { messages: topic.slice(Math.max(0, stop - PAGE_SIZE), stop), hasMore: stop > PAGE_SIZE }
    },
    sendMessage: async (conversationId, text, images, files, mentions) => {
      if (images?.length || files?.length) throw new Error('Attachments can only be sent from the desktop app for now.')
      if (!text.trim()) return
      if (social?.roomOf(conversationId)) {
        await social.send(conversationId, text.trim(), currentSnapshot().messages.filter((message) => message.conversationId === conversationId), mentions)
        return
      }
      if (await answerHere(conversationId, text.trim())) return
      const request: WebSendRequest = { id: crypto.randomUUID(), conversationId, text: text.trim(), createdAt: Date.now(), state: 'pending' }
      await mutate([{ kind: 'request', id: request.id, apply: () => request as unknown as SyncRecord }])
    },
    updateConversation: async (id, input: UpdateConversationInput) => {
      if (social?.roomOf(id)) {
        const room = social.roomOf(id)!
        if (input.name?.trim() && room.kind === 'group' && input.name.trim() !== room.name) {
          await social.action({ action: 'rename-room', roomId: room.id, name: input.name.trim() })
          void social.refresh().catch(() => undefined)
        }
        const prefs = Object.fromEntries(Object.entries({ muted: input.muted, hidden: input.hidden, savedToContacts: input.savedToContacts }).filter(([, value]) => value !== undefined))
        if (Object.keys(prefs).length) social.setPrefs(id, prefs)
        if (input.manuallyUnread === false) social.markRead(id)
        return currentSnapshot()
      }
      const current = conversation(id)
      // Opening a chat asks to show it; nothing to write when it is already shown.
      const flags = { savedToContacts: input.savedToContacts, muted: input.muted, hidden: input.hidden } as const
      const onlyFlags = Object.keys(input).every((key) => key in flags || key === 'expectedRevision')
      if (current && onlyFlags && Object.entries(flags).every(([key, value]) => value === undefined || Boolean(current[key as keyof typeof flags]) === value)) return currentSnapshot()
      return (onlyFlags ? applyNow : mutate)([editConversation(id, (next) => {
      if (input.savedToContacts !== undefined) next.savedToContacts = input.savedToContacts
      if (input.muted !== undefined) next.muted = input.muted
      if (input.hidden !== undefined) next.hidden = input.hidden
      if (input.manuallyUnread !== undefined) { next.manuallyUnread = input.manuallyUnread; next.unread = input.manuallyUnread ? Math.max(1, next.unread) : 0 }
      if (input.name?.trim()) { next.name = input.name.trim(); if (next.type === 'group') next.autoNamed = false }
      if (input.description !== undefined) next.description = input.description.trim() || undefined
      if (input.agentIds && next.type === 'group') next.agentIds = [...new Set(input.agentIds)]
      if (input.leadAgentId && next.agentIds.includes(input.leadAgentId)) next.leadAgentId = input.leadAgentId
      next.updatedAt = Date.now()
    })])
    },
    setConversationPinned: async (id, pinned) => {
      if (social?.roomOf(id)) { social.setPrefs(id, { pinned: pinned || undefined }); return currentSnapshot() }
      return applyNow([editConversation(id, (next) => { next.pinned = pinned || undefined })])
    },
    markConversationRead: (id) => {
      if (social?.roomOf(id)) { social.markRead(id); return Promise.resolve(currentSnapshot()) }
      const current = conversation(id)
      if (!current || (!current.unread && !current.manuallyUnread)) return Promise.resolve(currentSnapshot())
      return applyNow([editConversation(id, (next) => { next.unread = 0; next.manuallyUnread = false; next.readAt = Date.now() })])
    },
    markAllConversationsRead: () => applyNow(currentSnapshot().conversations.filter((item) => {
      if (social?.roomOf(item.id)) { social.markRead(item.id); return false }
      return item.unread || item.manuallyUnread
    })
      .map((item) => editConversation(item.id, (next) => { next.unread = 0; next.manuallyUnread = false; next.readAt = Date.now() }))),
    deleteMessage: async (conversationId, messageId) => {
      if (social?.roomOf(conversationId)) throw new Error(DESKTOP_ONLY)
      await mutate([{ kind: sync?.get('request', messageId) ? 'request' : 'message', id: messageId, apply: () => null }])
      return true
    },
    // A desktop also stops a reply in progress; without one, the reset itself is a synced change.
    resetConversationContext: viaDesktop('resetConversationContext', async (id) => {
      const room = social?.roomOf(id)
      if (room) {
        await social!.action({ action: 'reset-context', roomId: room.id } as Record<string, unknown>)
        return currentSnapshot()
      }
      const current = conversation(id)
      if (!current) throw new Error('Chat not found')
      const reset = { id: crypto.randomUUID(), at: Date.now() }
      // The visible boundary sits just outside the new context, as on a desktop.
      const notice: ChatMessage = { id: `context-reset:${reset.id}`, conversationId: id, topicId: current.activeTopicId, authorId: 'system', authorName: 'Douchat', kind: 'system', text: 'Context reset', createdAt: reset.at }
      return mutate([
        { kind: 'message', id: notice.id, apply: () => notice as unknown as SyncRecord },
        editConversation(id, (next) => { next.topics = next.topics.map((topic) => topic.id === next.activeTopicId ? { ...topic, contextReset: reset } : topic) })
      ])
    }),
    clearConversation: (id) => social?.roomOf(id) ? Promise.reject(new Error(DESKTOP_ONLY)) : mutate(deleteMessages((message) => message.conversationId === id)),
    deleteConversation: (id) => social?.roomOf(id) ? (social.setPrefs(id, { hidden: true, savedToContacts: false }), Promise.resolve(currentSnapshot())) : mutate([...deleteMessages((message) => message.conversationId === id), { kind: 'conversation', id, apply: () => null }]),
    setActiveTopic: (id, topicId) => mutate([editConversation(id, (next) => { if (next.topics.some((topic) => topic.id === topicId)) next.activeTopicId = topicId })]),
    createTopic: (id) => mutate([editConversation(id, (next) => {
      const now = Date.now()
      const topic: Topic = { id: crypto.randomUUID(), title: '', createdAt: now, updatedAt: now }
      next.topics = [...next.topics, topic]
      next.activeTopicId = topic.id
    })]),
    renameTopic: (id, topicId, title) => mutate([editConversation(id, (next) => {
      next.topics = next.topics.map((topic) => topic.id === topicId ? { ...topic, title: title.trim(), updatedAt: Date.now() } : topic)
    })]),
    deleteTopic: (id, topicId) => mutate([
      ...deleteMessages((message) => message.conversationId === id && message.topicId === topicId),
      editConversation(id, (next) => {
        if (next.topics.length <= 1) throw new Error('A chat needs at least one topic.')
        next.topics = next.topics.filter((topic) => topic.id !== topicId)
        if (next.activeTopicId === topicId) next.activeTopicId = next.topics[next.topics.length - 1].id
      })
    ]),
    startDirectChat: async (agentId) => {
      const existing = currentSnapshot().conversations.find((item) => item.type === 'direct' && !item.id.startsWith('im-') && item.agentIds[0] === agentId)
        ?? sync?.all<Conversation>('conversation').find((item) => item.type === 'direct' && !item.id.startsWith('im-') && item.agentIds[0] === agentId)
      if (existing) {
        const snapshot = existing.hidden ? await mutate([editConversation(existing.id, (next) => { next.hidden = undefined })]) : currentSnapshot()
        return { snapshot, conversationId: existing.id }
      }
      const agent = sync?.get<AgentConfig>('agent', agentId)
      if (!agent) throw new Error('Contact not found')
      const now = Date.now()
      const topic: Topic = { id: crypto.randomUUID(), title: '', createdAt: now, updatedAt: now }
      const created: Conversation = { ownerId: user?.id, id: `direct-${agentId}`, type: 'direct', name: agent.name, agentIds: [agentId], topics: [topic], activeTopicId: topic.id, unread: 0, readAt: now, createdAt: now, updatedAt: now }
      const snapshot = await mutate([{ kind: 'conversation', id: created.id, apply: () => created as unknown as SyncRecord }])
      // A desktop greets the chats it opens; here the web app does.
      void greetNewChat(sync!, token!, created.id).catch(() => undefined)
      return { snapshot, conversationId: created.id }
    },
    prewarmConversation: async () => undefined,
    stopConversation: viaDesktop('stopConversation', (conversationId) => cancelHostTasks(conversationId)),
    resolveAgentPermission: (id, allow) => id.startsWith('remote:') && !desktopOnline()
      ? resolveHostApproval(id, allow).then(() => currentSnapshot())
      : desktop('resolveAgentPermission', [id, allow]),

    // Contacts: a desktop manages every kind; without one, cloud agents are managed here.
    createAgent: viaDesktop('createAgent', async (input) => {
      const agent = await createCloudAgent(sync!, user!.id, input)
      void greetNewChat(sync!, token!, `direct-${agent.id}`).catch(() => undefined)
      return currentSnapshot()
    }),
    updateAgent: viaDesktop('updateAgent', async (id, input) => {
      await updateCloudAgent(sync!, id, input)
      // An agent on a host added here runs with the profile the host was given.
      const agent = sync!.get<AgentConfig>('agent', id)
      if (agent && hostAgents.host(agent.id)) await webHosts.agentChanged(agent).catch(() => undefined)
      return currentSnapshot()
    }),
    deleteAgent: viaDesktop('deleteAgent', async (id) => { await deleteCloudAgent(sync!, id); return currentSnapshot() }),
    createGroup: viaDesktop('createGroup', async (input) => {
      const group = await createGroup(sync!, user!.id, input)
      void greetNewChat(sync!, token!, group.id).catch(() => undefined)
      return currentSnapshot()
    }),

    // Support access to one conversation.
    supportShares: (conversationId) => sync!.call<SupportShare[]>({ action: 'support-share-list', conversationId }),
    createSupportShare: (conversationId, hours, note) => sync!.call<SupportShare>({ action: 'support-share-create', conversationId, hours, note }),
    revokeSupportShare: async (id) => { await sync!.call({ action: 'support-share-revoke', id }) },

    // Settings the web app shows read-only or empty.
    getSocialSnapshot: async () => social?.getSnapshot() ?? { userId: user?.id ?? '', friendships: [], rooms: [] },
    socialAction: (input) => socialAction(input),
    getAttachmentData: async (id) => {
      const data = social?.attachmentData(id)
      if (data) return data
      // An image a douchat-host task delivered: the service keeps it with the task.
      if (id.startsWith('hosttask:')) {
        const { attachment } = await socialCall<{ attachment: { mimeType?: string; base64: string } }>({ action: 'host-task-attachment', attachmentId: id })
        return `data:${attachment.mimeType ?? 'application/octet-stream'};base64,${attachment.base64}`
      }
      // Images live on the desktop that saved them.
      if (desktopOnline()) return desktop('getAttachmentData', [id])
      throw new Error('Open the Douchat desktop app to see this image.')
    },
    getUpdateState: async () => ({ status: 'disabled', currentVersion: 'web' }),
    getProducts: async () => {
      const response = await fetch('/api/products').catch(() => undefined)
      return parseProducts(await response?.json().catch(() => undefined)) ?? BUILT_IN_PRODUCTS
    },
    checkForUpdates: async () => ({ status: 'disabled', currentVersion: 'web' }),
    onUpdateState: () => () => undefined,
    onCreditsUpdated: () => () => undefined,
    onConnectionsChanged: (listener) => { connectionListeners.add(listener); return () => { connectionListeners.delete(listener) } },
    onConnanyChanged: () => () => undefined,
    // The desktop's settings and memory when it is online; empty but usable otherwise.
    detectLocalAgents: () => localAgents(),
    listSshHosts: viaDesktop('listSshHosts', async () => []),
    listConnections: () => connections(),
    // Adding a server from the web makes one that follows the service and runs its agents itself.
    createDaemonEnrollment: () => webHosts.createEnrollment(),
    waitDaemonEnrollment: (id) => webHosts.isEnrollment(id) ? webHosts.waitEnrollment(id) : desktop('waitDaemonEnrollment', [id]),
    cancelDaemonEnrollment: async (id) => { if (webHosts.isEnrollment(id)) webHosts.cancelEnrollment(id); else await desktop('cancelDaemonEnrollment', [id]) },
    completeDaemonEnrollment: async (id, input) => {
      if (!webHosts.isEnrollment(id)) return desktop('completeDaemonEnrollment', [id, input])
      await webHosts.completeEnrollment(id, input.name)
      hostsChanged()
      return connections()
    },
    discoverRemoteAgents: (id) => onConnection(id, () => webHosts.discover(id), 'discoverRemoteAgents', [id]),
    addDiscoveredAgents: (id, agents) => onConnection(id, async () => { const added = await webHosts.addAgents(id, agents); hostsChanged(); return added }, 'addDiscoveredAgents', [id, agents]),
    setConnectionEnabled: (id, enabled) => onConnection(id, async () => { await webHosts.setEnabled(id, enabled); hostsChanged(); return connections() }, 'setConnectionEnabled', [id, enabled]),
    removeConnection: (id, mode) => onConnection(id, async () => { await webHosts.remove(id, mode); hostsChanged(); return connections() }, 'removeConnection', [id, mode]),
    testConnection: (id) => onConnection(id, () => webHosts.test(id), 'testConnection', [id]),
    listRuntimeModels: viaDesktop('listRuntimeModels', async () => ({ models: [], source: 'manual' as const, configurable: false })),
    listIMChannels: viaDesktop('listIMChannels', async () => []),
    getCustomModels: viaDesktop('getCustomModels', async () => ({ providers: [], defaultModel: '' })),
    getDecisionSettings: viaDesktop('getDecisionSettings', async () => DEFAULT_DECISION_SETTINGS),
    getCloudDecisionModels: viaDesktop('getCloudDecisionModels', async () => []),
    // Folders for agents a host runs are on that server and sync, so the web app can set them too.
    conversationWorkspaces: viaDesktop('conversationWorkspaces', async (conversationId) => hostWorkspaceView(conversationId)),
    listRemoteAgentDirectories: viaDesktop('listRemoteAgentDirectories', async (_conversationId, agentId, parent, name) =>
      hostFolderCall(agentId, 'fs.listDirs', { ...(parent !== undefined ? { parent } : {}), ...(name !== undefined ? { name } : {}) }) as Promise<import('../shared/types').RemoteDirectoryListing>),
    chooseRemoteAgentWorkspace: viaDesktop('chooseRemoteAgentWorkspace', async (conversationId, agentId, parent, name) => {
      const host = hostAgents.host(agentId)
      const { path } = await hostFolderCall(agentId, 'fs.resolveDir', { parent, ...(name !== undefined ? { name } : {}) }) as { path: string }
      await setHostWorkspace(conversationId, agentId, { path, executionTargetId: `daemon:${host!.hostId}`, targetRevision: 0 })
      return hostWorkspaceView(conversationId)
    }),
    clearAgentWorkspace: viaDesktop('clearAgentWorkspace', async (conversationId, agentId) => {
      await setHostWorkspace(conversationId, agentId, undefined)
      return hostWorkspaceView(conversationId)
    }),
    getCodeArtifact: viaDesktop('getCodeArtifact', async () => null),
    getUserMemory: viaDesktop('getUserMemory', async (agentId) => emptyMemory(user?.id ?? '', agentId ? { agentId } : {})),
    getGroupMemory: viaDesktop('getGroupMemory', async (groupId) => emptyMemory(user?.id ?? '', { groupId })),

    // Browser stand-ins for desktop conveniences.
    copyText: (text) => navigator.clipboard.writeText(text),
    // The browser clipboard takes PNG. Handing it the blob as a promise keeps the
    // click's user activation, which Safari requires, while the data is decoded.
    copyInvitationImage: (dataUrl) => navigator.clipboard.write([new ClipboardItem({ 'image/png': fetch(dataUrl).then((response) => response.blob()) })]),
    // A download stands in for the desktop's save dialog.
    saveInvitationImage: async (dataUrl) => {
      const link = document.createElement('a')
      link.href = dataUrl
      link.download = 'douchat-invitation.png'
      link.click()
      return true
    },
    copyImageData: (dataUrl) => navigator.clipboard.write([new ClipboardItem({ 'image/png': fetch(dataUrl).then((response) => response.blob()) })]),
    resizeDialog: async () => true,
    reportDiagnostic: () => undefined,
    windowAction: () => undefined,
    requestMicrophoneAccess: async () => 'unsupported',
    openMicrophoneSettings: async () => undefined,
    openConversationWindow: async () => undefined
  }

  // Everything else the desktop window can do runs on an online desktop.
  return new Proxy(api, {
    get(target, key: string) {
      if (key in target) return target[key as keyof DouchatApi]
      if (key.startsWith('on')) return () => () => undefined
      if (key in DESKTOP_RPC) return (...args: unknown[]) => desktop(key as DesktopRpcMethod, args)
      return desktopOnly
    }
  }) as DouchatApi
}

function emptyMemory(userId: string, scope: { agentId?: string; groupId?: string }): UserMemoryDocument {
  return { userId, ...scope, notes: '', facts: [], autoRemember: false, revision: 0, updatedAt: 0 }
}
