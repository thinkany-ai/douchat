import { createHash } from 'node:crypto'
import { agentPermissions, type PermissionApproval, type PermissionRequest } from '../../shared/agentPermissions'
import type { AgentConfig, ConversationActivityState, DaemonEnrollment, DaemonEnrollmentResult, DiscoveredRemoteAgent, RemoteConnection } from '../../shared/types'
import type { DesktopAuth } from '../desktopAuth'
import type { DouchatStore } from '../store'
import type { ConnectionManager, DaemonBackend } from '../connectionManager'
import { daemonAgentDefinitions } from '../localAgents'
import { localExecutionTarget } from '../localWorkspaces'
import { canonicalJson, sha256Hex, signCommand, type SignedCommand } from './ownerSigning'
import type { RelayBackend } from './daemonRelay'
import { socialIdentity, socialRequest } from './socialRequest'
import { approvalDecision, RemoteApprovals, REMOTE_APPROVAL_PREFIX, type RemoteApprovalContext } from './remoteApprovals'

const ENROLLMENT_PREFIX = 'dch1_'
const WATCH_BACKOFF = [1_000, 5_000, 15_000, 60_000]
const HOST_LIST_TTL_MS = 5_000
/** Agents claimed and run by the host itself (the earlier P2 design). Off: douchat-host only relays, like sshd. */
const HOST_EXECUTION = false as boolean

export interface HostView {
  id: string
  status: 'enrolling' | 'active' | 'revoked'
  online: boolean
  lastSeenAt?: number | null
  info: { os?: string; arch?: string; version?: string }
  agentsRevision: number
  createdAt: number
}
export interface BindingView {
  localId: string
  executor: string
  executionTargetId: string
  state: 'enabled' | 'disabled' | 'revoked'
  bindingRevision: number
  configRevision: number
  permissionsRevision: number
  appliedConfigRevision: number
  appliedPermissionsRevision: number
}
interface ProgressTask {
  taskId: string
  roomId: string
  localId: string
  hostId: string
  bindingRevision: number
  claimHash: string
  cancelRequested: boolean
  progress: { seq?: number; phase?: string; detail?: string; text?: string; at?: number } | null
  approvals: ({ id: string } & Record<string, unknown>)[]
}
interface WatchResult { cursor: string; tasks: ProgressTask[]; bindings: BindingView[] }

/** What the runtime reads from the daemon client; nothing here starts a process. */
export interface RemoteExecutionBridge {
  activity(): ConversationActivityState[]
  approvals(): PermissionRequest[]
  resolveApproval(id: string, allow: PermissionApproval): Promise<void>
  /** Signed cancel for every daemon task running in this conversation. Resolves to the number requested. */
  cancelConversation(conversationId: string): Promise<number>
  isDaemonAgent(agentId: string): boolean
}

/** The one-time install payload. The ticket is a credential: never log it. */
export function enrollmentToken(input: { serviceUrl: string; ticket: string; hostId: string; devicePublicKey: string; deviceId: string; ownerId: string; exp: number }): string {
  const body = { v: 1, serviceUrl: input.serviceUrl, ticket: input.ticket, hostId: input.hostId, ownerId: input.ownerId,
    devicePublicKey: input.devicePublicKey, deviceId: input.deviceId, fingerprint: deviceFingerprint(input.devicePublicKey), exp: input.exp }
  return ENROLLMENT_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
}
/** Short, comparable fingerprint of the owner device key, also printed by douchat-host setup. */
export function deviceFingerprint(publicKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16)
  return hex.match(/.{4}/g)!.join('-')
}
/** The install command. The token only contains base64url characters and the base is a validated URL, so single quotes are enough. */
export function installCommand(token: string, downloadBase: string): string {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(downloadBase).hostname)
  const direct = local ? " --noproxy 'localhost,127.0.0.1,::1'" : ''
  return `curl -fsSL${direct} '${downloadBase}/install.sh' | DOUCHAT_HOST_URL='${downloadBase}' DOUCHAT_ENROLL='${token}' sh`
}
/** Production releases are on the CDN; other services (local testing) serve them at <service>/host. */
export const PRODUCTION_HOST_DOWNLOAD = 'https://cdn.douchat.ai/host'
/** A local service can advertise its production origin via VITE_APP_URL.
 * Keep local enrollment on the service that actually issued the ticket. */
export function enrollmentServiceUrl(configuredUrl: string, advertisedUrl?: string): string {
  const configured = new URL(configuredUrl)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname)
  return local ? configured.origin : new URL(advertisedUrl || configuredUrl).origin
}

/** Where install.sh and the host bundle are served, unless overridden. */
export function hostDownloadBase(serviceUrl: string, override = process.env.DOUCHAT_HOST_DOWNLOAD_URL): string {
  const fallback = new URL(serviceUrl).origin === 'https://douchat.ai' ? PRODUCTION_HOST_DOWNLOAD : `${serviceUrl.replace(/\/+$/, '')}/host`
  const base = new URL(override?.trim() || fallback)
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
    throw new Error('The douchat-host download address must use HTTPS.')
  if (/['\s\\]/.test(base.href)) throw new Error('Invalid douchat-host download address.')
  return base.href.replace(/\/+$/, '')
}
export const UNINSTALL_COMMAND = '"$HOME/.douchat-host/bin/douchat-host" uninstall --purge'

/**
 * A-side proxy for agents bound to a douchat-host (remote-connections.md 6.5,
 * 8). It owns enrollment, owner-signed binding and configuration sync,
 * progress/approval watching and cancel. It never runs an agent: the host
 * claims those tasks, and they never fall back to this computer.
 */
export class DaemonClient implements DaemonBackend, RemoteExecutionBridge {
  private abort?: AbortController
  private generation = 0
  private cursor?: string
  private tasks: ProgressTask[] = []
  private bindings = new Map<string, BindingView>()
  private readonly remoteApprovals = new RemoteApprovals()
  private hostCache?: { at: number; hosts: HostView[]; ownerId: string }
  private readonly enrollments = new Map<string, { enrollment: DaemonEnrollment; ownerId: string; serviceUrl: string; abort: AbortController; result?: DaemonEnrollmentResult }>()
  private readonly syncedConfig = new Map<string, string>()
  private syncTimer?: ReturnType<typeof setTimeout>
  private syncing?: Promise<void>
  private syncAgain = false
  private daemonAgentIds = new Set<string>()
  /** hostId -> connection name, shown on approval cards. */
  private hostNames = new Map<string, string>()

  constructor(
    private readonly url: string,
    private readonly auth: DesktopAuth,
    private readonly store: DouchatStore,
    private readonly connections: ConnectionManager,
    private readonly onChange: () => void
  ) {}

  // ───────────────────────────── transport ─────────────────────────────

  private identity() { return socialIdentity(this.auth) }

  private request<T>(body: object, signal?: AbortSignal, identity = this.identity()): Promise<T> {
    return socialRequest<T>(this.url, this.auth, body, signal, identity)
  }

  private sign<T extends Record<string, unknown>>(hostId: string, method: string, payload: T, serviceUrl = this.url): SignedCommand<T> {
    return signCommand(this.auth, { serviceUrl, ownerId: this.identity().id, hostId, method, payload })
  }

  /** What the douchat-host relay needs: authenticated requests and owner signatures (remote/daemonRelay.ts). */
  relayBackend(): RelayBackend {
    return {
      request: <T>(body: object, signal?: AbortSignal) => this.request<T>(body, signal),
      sign: (hostId, method, payload, serviceUrl) => this.sign(hostId, method, payload, serviceUrl),
      ownerId: () => { const state = this.auth.getState(); return state.status === 'signed-in' ? state.user.id : undefined }
    }
  }

  private async hosts(fresh = false): Promise<HostView[]> {
    const ownerId = this.identity().id
    if (!fresh && this.hostCache && this.hostCache.ownerId === ownerId && Date.now() - this.hostCache.at < HOST_LIST_TTL_MS) return this.hostCache.hosts
    const { hosts } = await this.request<{ hosts: HostView[] }>({ action: 'host-list' })
    this.hostCache = { at: Date.now(), hosts: Array.isArray(hosts) ? hosts : [], ownerId }
    return this.hostCache.hosts
  }

  private ownDaemon(connection: RemoteConnection): NonNullable<RemoteConnection['daemon']> {
    if (connection.kind !== 'daemon' || !connection.daemon) throw new Error('This is not a daemon connection.')
    if (connection.daemon.ownerId !== this.identity().id) throw new Error('This host was added with another Douchat account. Sign in with that account to use it, or delete it and add it again.')
    return connection.daemon
  }

  // ───────────────────────────── enrollment ─────────────────────────────

  async createEnrollment(): Promise<DaemonEnrollment> {
    const identity = this.identity()
    const deviceId = this.auth.getDeviceId()
    const devicePublicKey = this.auth.getDevicePublicKey()
    if (!deviceId || !devicePublicKey) throw new Error('请重新登录 Douchat 以启用设备身份。')
    const ticket = await this.request<{ hostId: string; ticket: string; serviceUrl: string; expiresAt: number }>({ action: 'host-enroll-ticket' }, undefined, identity)
    if (!/^hst_[0-9a-f-]{36}$/.test(ticket.hostId) || !/^det_[A-Za-z0-9_-]{20,}$/.test(ticket.ticket)) throw new Error('The Douchat service returned an invalid install ticket.')
    const serviceUrl = enrollmentServiceUrl(this.url, ticket.serviceUrl)
    const token = enrollmentToken({ serviceUrl, ticket: ticket.ticket, hostId: ticket.hostId, devicePublicKey, deviceId, ownerId: identity.id, exp: ticket.expiresAt })
    const enrollment: DaemonEnrollment = { id: ticket.hostId, hostId: ticket.hostId, installCommand: installCommand(token, hostDownloadBase(serviceUrl)), uninstallCommand: UNINSTALL_COMMAND, fingerprint: deviceFingerprint(devicePublicKey), expiresAt: ticket.expiresAt }
    for (const [id, item] of this.enrollments) if (item.enrollment.expiresAt <= Date.now()) { item.abort.abort(); this.enrollments.delete(id) }
    this.enrollments.set(enrollment.id, { enrollment, ownerId: identity.id, serviceUrl, abort: new AbortController() })
    return enrollment
  }

  /** Polls until the host enrolled and is online; null when cancelled or expired. */
  async waitEnrollment(id: string): Promise<DaemonEnrollmentResult | null> {
    const item = this.enrollments.get(id)
    if (!item) throw new Error('This install command has expired. Create a new one.')
    if (item.result) return item.result
    const signal = item.abort.signal
    while (!signal.aborted && Date.now() < item.enrollment.expiresAt + 60_000) {
      try {
        if (this.identity().id !== item.ownerId) return null
        const host = (await this.hosts(true)).find(entry => entry.id === item.enrollment.hostId)
        if (host?.status === 'active' && host.online) {
          item.result = { hostId: host.id, info: host.info ?? {} }
          return item.result
        }
        // Once enrolled the ticket no longer counts toward expiry.
        if (host?.status === 'active') item.enrollment.expiresAt = Math.max(item.enrollment.expiresAt, Date.now() + 60_000)
      } catch { /* Keep waiting through transient failures. */ }
      await new Promise(resolve => { const timer = setTimeout(resolve, 2_000); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined) }, { once: true }) })
    }
    return null
  }

  /** Closing the wizard without saving revokes the host, so neither an unused ticket nor an enrolled host is left behind. */
  cancelEnrollment(id: string): void {
    const item = this.enrollments.get(id)
    if (!item) return
    item.abort.abort()
    this.enrollments.delete(id)
    const hostId = item.enrollment.hostId
    void (async () => {
      try {
        if (this.identity().id !== item.ownerId) return
        await this.request({ action: 'host-revoke', hostId, signed: this.sign(hostId, 'host.revoke', { hostId }, item.serviceUrl) })
      } catch { /* Already gone, or offline: the ticket still expires on its own. */ }
      this.hostCache = undefined
    })()
  }

  async completeEnrollment(id: string, input: { name: string }): Promise<RemoteConnection> {
    const item = this.enrollments.get(id)
    if (!item?.result) throw new Error('Wait for the server to connect first.')
    if (this.identity().id !== item.ownerId) throw new Error('The account changed. Try again.')
    const saved = await this.connections.saveDaemon({ name: String(input?.name ?? ''),
      daemon: { hostId: item.result.hostId, serviceUrl: item.serviceUrl, ownerId: item.ownerId, info: item.result.info } })
    this.enrollments.delete(id)
    this.scheduleSync()
    return saved
  }

  // ───────────────────────────── DaemonBackend ─────────────────────────────

  async check(connection: RemoteConnection): Promise<number> {
    const daemon = this.ownDaemon(connection)
    const started = Date.now()
    const host = (await this.hosts(true)).find(item => item.id === daemon.hostId)
    if (!host || host.status === 'revoked') throw new Error('This daemon was uninstalled or revoked. Remove the connection, then add the server again.')
    if (host.status !== 'active') throw new Error('Waiting for douchat-host on the server to finish setup.')
    if (!host.online) throw new Error(host.lastSeenAt ? `douchat-host is offline (last seen ${new Date(host.lastSeenAt).toLocaleString()}). Check that its service is running on the server.` : 'douchat-host is offline. Check that its service is running on the server.')
    return Date.now() - started
  }

  async control(connection: RemoteConnection, method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const daemon = this.ownDaemon(connection)
    const result = await this.request<{ ok?: boolean; pending?: boolean; result?: unknown }>({ action: 'host-control', hostId: daemon.hostId, method, params }, signal)
    if (result.pending) throw new Error('douchat-host did not answer in time. Check that it is online, then try again.')
    if (!result.ok) {
      const message = (result.result as { message?: unknown } | null)?.message
      throw new Error(typeof message === 'string' && message ? message.slice(0, 300) : 'douchat-host could not complete the request.')
    }
    return result.result
  }

  async discover(connection: RemoteConnection, signal?: AbortSignal): Promise<DiscoveredRemoteAgent[]> {
    const result = await this.control(connection, 'host.discover', {}, signal) as { agents?: unknown } | unknown[] | null
    const agents = Array.isArray(result) ? result : Array.isArray((result as { agents?: unknown })?.agents) ? (result as { agents: unknown[] }).agents : []
    return agents.slice(0, 50).flatMap(item => {
      const value = item as Partial<DiscoveredRemoteAgent>
      return typeof value?.adapter === 'string' && typeof value.executable === 'string'
        ? [{ adapter: value.adapter, executable: value.executable, ...(typeof value.version === 'string' ? { version: value.version } : {}) } as DiscoveredRemoteAgent] : []
    })
  }

  async revoke(connection: RemoteConnection): Promise<void> {
    const daemon = this.ownDaemon(connection)
    try {
      await this.request({ action: 'host-revoke', hostId: daemon.hostId, signed: this.sign(daemon.hostId, 'host.revoke', { hostId: daemon.hostId }, daemon.serviceUrl) })
    } catch (error) {
      // Already gone on the service: removing the local entry is all that is left.
      if (!(error instanceof Error && /不存在或已吊销/.test(error.message))) throw error
    }
    this.hostCache = undefined
    this.syncedConfig.delete(daemon.hostId)
  }

  // ───────────────────────────── binding and config sync ─────────────────────────────

  /** Coalesces agent, permission and connection changes into one signed sync. */
  scheduleSync(delay = 500): void {
    clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => void this.syncAgents().catch(() => { /* Retried on the next change or start. */ }), delay)
    this.syncTimer.unref?.()
  }

  syncAgents(): Promise<void> {
    if (this.syncing) { this.syncAgain = true; return this.syncing }
    const work = (async () => {
      do {
        this.syncAgain = false
        await this.syncOnce()
      } while (this.syncAgain)
    })().finally(() => { this.syncing = undefined })
    this.syncing = work
    return work
  }

  private async syncOnce(): Promise<void> {
    const identity = this.identity()
    if (!this.auth.getDeviceId()) return
    const definitions = await daemonAgentDefinitions()
    const connections = (await this.connections.store.list()).filter(item => item.kind === 'daemon' && item.daemon?.ownerId === identity.id)
    this.rememberHostNames(connections)
    const mine = this.store.accountAgents.filter(agent => (agent.ownerId ?? identity.id) === identity.id)
    const daemonAgents = mine.filter(agent => agent.localAgentId && definitions.has(agent.localAgentId))
    this.daemonAgentIds = new Set(daemonAgents.map(agent => agent.id))
    if (!connections.length && !this.bindings.size) return
    const { bindings } = await this.request<WatchResult>({ action: 'task-progress-watch' })
    this.bindings = new Map((bindings ?? []).map(item => [item.localId, item]))
    const hosts = await this.hosts(true)

    for (const agent of daemonAgents) {
      const placement = definitions.get(agent.localAgentId!)!
      const connection = connections.find(item => item.id === placement.connectionId)
      const host = connection && hosts.find(item => item.id === connection.daemon!.hostId)
      if (!connection || host?.status !== 'active') continue
      const owned = this.store.claimSocialAgent(agent.id, identity.id)
      const executor = `host:${host.id}`
      const binding = this.bindings.get(owned.id)
      const revision = owned.revision ?? 0
      if (!binding || binding.executor !== executor || binding.state === 'revoked') {
        await this.bind(owned.id, executor, host.id, `daemon:${host.id}`, binding?.bindingRevision ?? 0, revision, connection.daemon!.serviceUrl)
      } else {
        const desired = connection.enabled ? 'enabled' : 'disabled'
        if (binding.state !== desired) await this.setState(owned.id, host.id, desired, binding.bindingRevision, connection.daemon!.serviceUrl)
      }
    }
    // An agent moved off its daemon is bound back to this desktop explicitly; never implicitly.
    const deviceId = this.auth.getDeviceId()
    for (const binding of this.bindings.values()) {
      if (!binding.executor.startsWith('host:') || this.daemonAgentIds.has(binding.localId)) continue
      const agent = mine.find(item => item.id === binding.localId)
      if (!agent || !deviceId || agent.ownerId !== identity.id) continue
      await this.bind(agent.id, `desktop:${deviceId}`, '', localExecutionTarget().executionTargetId, binding.bindingRevision, agent.revision ?? 0)
    }

    for (const connection of connections) {
      const host = hosts.find(item => item.id === connection.daemon!.hostId)
      if (host?.status !== 'active') continue
      const agents = daemonAgents.filter(agent => definitions.get(agent.localAgentId!)?.connectionId === connection.id)
        .map(agent => hostAgentConfig(agent, definitions.get(agent.localAgentId!)!.binding))
      const key = sha256Hex(canonicalJson(JSON.parse(JSON.stringify(agents))))
      if (this.syncedConfig.get(host.id) === key) continue
      for (let attempt = 0; ; attempt++) {
        const current = attempt ? (await this.hosts(true)).find(item => item.id === host.id) ?? host : host
        try {
          await this.request({ action: 'host-agents-sync', hostId: host.id, signed: this.sign(host.id, 'host.agents', { expectedAgentsRevision: current.agentsRevision, agents }, connection.daemon!.serviceUrl) })
          this.syncedConfig.set(host.id, key)
          this.hostCache = undefined
          break
        } catch (error) {
          if (attempt >= 1 || !(error instanceof Error && /已被修改/.test(error.message))) throw error
        }
      }
    }
  }

  private async bind(localId: string, executor: string, hostId: string, executionTargetId: string, expectedBindingRevision: number, revision: number, serviceUrl = this.url): Promise<void> {
    const payload = { executor, localId, expectedBindingRevision, configRevision: revision, permissionsRevision: revision, executionTargetId }
    const { binding } = await this.request<{ binding: BindingView }>({ action: 'executor-bind', signed: this.sign(hostId, 'executor.bind', payload, serviceUrl) })
    this.bindings.set(localId, binding)
  }

  private async setState(localId: string, hostId: string, state: 'enabled' | 'disabled', expectedBindingRevision: number, serviceUrl: string): Promise<void> {
    const { binding } = await this.request<{ binding: BindingView }>({ action: 'executor-set-state', localId,
      signed: this.sign(hostId, 'executor.state', { localId, state, expectedBindingRevision }, serviceUrl) })
    this.bindings.set(localId, binding)
  }

  // ───────────────────────────── progress, approvals, cancel ─────────────────────────────

  start(): void {
    this.stop()
    const generation = ++this.generation
    this.abort = new AbortController()
    const signal = this.abort.signal
    // The sync also moves bindings left on a host back to this desktop.
    this.scheduleSync(0)
    // Host-side execution is off while douchat-host is a pure relay: no progress/approval watch.
    if (!HOST_EXECUTION) return
    let failures = 0
    const loop = async (): Promise<void> => {
      let delay = 0
      try {
        const identity = this.identity()
        const daemons = (await this.connections.store.list()).filter(item => item.kind === 'daemon' && item.daemon?.ownerId === identity.id)
        this.rememberHostNames(daemons)
        const hasDaemons = daemons.length > 0
        if (!hasDaemons && !this.tasks.length) {
          this.cursor = undefined
          delay = 30_000
        } else {
          const result = await this.request<WatchResult>({ action: 'task-progress-watch', ...(this.cursor ? { cursor: this.cursor } : {}) }, signal, identity)
          if (signal.aborted || generation !== this.generation) return
          this.cursor = result.cursor
          this.tasks = Array.isArray(result.tasks) ? result.tasks : []
          this.bindings = new Map((result.bindings ?? []).map(item => [item.localId, item]))
          this.publish(identity.id)
          failures = 0
        }
      } catch {
        if (signal.aborted || generation !== this.generation) return
        delay = WATCH_BACKOFF[Math.min(failures++, WATCH_BACKOFF.length - 1)]
        // Without a fresh snapshot, approvals cannot be trusted to still be open.
        this.cursor = undefined
      }
      if (!signal.aborted && generation === this.generation) setTimeout(() => void loop(), delay).unref?.()
    }
    void loop()
  }

  stop(): void {
    this.generation++
    this.abort?.abort()
    this.abort = undefined
    clearTimeout(this.syncTimer)
    this.cursor = undefined
    this.tasks = []
    this.bindings.clear()
    this.remoteApprovals.clear()
    this.hostCache = undefined
    this.syncedConfig.clear()
    for (const item of this.enrollments.values()) item.abort.abort()
    this.enrollments.clear()
    this.onChange()
  }

  private rememberHostNames(connections: RemoteConnection[]): void {
    this.hostNames = new Map(connections.filter(item => item.kind === 'daemon' && item.daemon).map(item => [item.daemon!.hostId, item.name]))
  }

  private conversationFor(roomId: string) {
    return this.store.accountConversations.find(item => item.remoteRoomId === roomId)
  }

  private executorLabel(hostId: string): string {
    return this.hostNames.get(hostId) ?? 'douchat-host'
  }

  private publish(ownerId: string): void {
    const approvals: { content: unknown; context: RemoteApprovalContext }[] = []
    for (const task of this.tasks) {
      const conversation = this.conversationFor(task.roomId)
      const agent = this.store.agent(task.localId)
      for (const approval of task.approvals ?? []) approvals.push({ content: approval, context: {
        ownerId, agentId: task.localId, agentName: agent?.name ?? 'Agent', roomName: conversation?.name ?? '',
        context: conversation?.type === 'group' ? 'group' : 'direct', executorLabel: this.executorLabel(task.hostId)
      } })
    }
    this.remoteApprovals.sync(approvals)
    this.onChange()
  }

  activity(): ConversationActivityState[] {
    const now = Date.now()
    const byConversation = new Map<string, ConversationActivityState>()
    for (const task of this.tasks) {
      const conversation = this.conversationFor(task.roomId)
      if (!conversation) continue
      const progress = task.progress
      const startedAt = Number(progress?.at) || now
      const waiting = task.approvals?.length
      const previous = byConversation.get(conversation.id)
      byConversation.set(conversation.id, {
        conversationId: conversation.id, topicId: conversation.activeTopicId, phase: 'replying',
        agentIds: [...new Set([...(previous?.agentIds ?? []), task.localId])], label: 'Replying', startedAt: previous?.startedAt ?? startedAt,
        localProgress: { phase: waiting ? 'approval' : progress ? 'working' : 'ready', elapsedSeconds: 0,
          silentSeconds: progress?.at ? Math.max(0, Math.floor((now - Number(progress.at)) / 1000)) : 0,
          detail: task.cancelRequested ? 'Stopping…' : progress?.detail || undefined },
        ...(progress?.text ? { remoteText: String(progress.text).slice(0, 32_000) } : {})
      })
    }
    return [...byConversation.values()]
  }

  approvals(): PermissionRequest[] { return this.remoteApprovals.snapshot() }

  async resolveApproval(id: string, allow: PermissionApproval): Promise<void> {
    if (!id.startsWith(REMOTE_APPROVAL_PREFIX)) throw new Error('Unknown approval')
    const content = this.remoteApprovals.get(id)
    if (!content) throw new Error('This request was already answered or has expired.')
    const connection = (await this.connections.store.list()).find(item => item.kind === 'daemon' && item.daemon?.hostId === content.hostId)
    const { decision, scope } = approvalDecision(allow)
    const payload = { approvalId: content.id, taskId: content.taskId, requestId: content.requestId, paramsHash: content.paramsHash,
      bindingRevision: content.bindingRevision, claimHash: content.claimHash, decision, scope }
    await this.request({ action: 'task-approval', hostId: content.hostId, signed: this.sign(content.hostId, 'task.approval', payload, connection?.daemon?.serviceUrl) })
    this.remoteApprovals.remove(id)
    this.onChange()
  }

  async cancelConversation(conversationId: string): Promise<number> {
    const conversation = this.store.accountConversations.find(item => item.id === conversationId)
    if (!conversation?.remoteRoomId) return 0
    const running = this.tasks.filter(task => task.roomId === conversation.remoteRoomId && !task.cancelRequested)
    const connections = await this.connections.store.list()
    await Promise.all(running.map(async task => {
      const serviceUrl = connections.find(item => item.kind === 'daemon' && item.daemon?.hostId === task.hostId)?.daemon?.serviceUrl
      await this.request({ action: 'task-cancel', hostId: task.hostId,
        signed: this.sign(task.hostId, 'task.cancel', { taskId: task.taskId, bindingRevision: task.bindingRevision, claimHash: task.claimHash }, serviceUrl) })
      task.cancelRequested = true
    }))
    if (running.length) this.onChange()
    return running.length
  }

  isDaemonAgent(agentId: string): boolean {
    if (this.daemonAgentIds.has(agentId)) return true
    const binding = this.bindings.get(agentId)
    return Boolean(binding?.executor.startsWith('host:'))
  }

  /** Synchronous view for social heartbeat/tasks: agents whose tasks a host claims. */
  daemonAgents(): Set<string> {
    return new Set([...this.daemonAgentIds, ...[...this.bindings.values()].filter(item => item.executor.startsWith('host:')).map(item => item.localId)])
  }
}

/** The configuration a host applies for one agent; signed with the agents list. */
export function hostAgentConfig(agent: AgentConfig, binding: { adapter: string; executable: string; args: string[] }): Record<string, unknown> {
  const revision = agent.revision ?? 0
  const permissions = agentPermissions(agent.permissions)
  return {
    localId: agent.id,
    configRevision: revision,
    permissionsRevision: revision,
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    adapter: binding.adapter,
    executable: binding.executable,
    args: [...binding.args, ...(agent.startupArgs ?? [])],
    ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
    ...(agent.permissions ? { permissions: agent.permissions } : {}),
    ...(agent.systemFiles ? { systemFiles: agent.systemFiles } : {}),
    ...(agent.skills?.length ? { skills: agent.skills.filter(skill => skill.enabled).map(({ files: _files, directory: _directory, filesOmitted: _omitted, ...skill }) => skill) } : {}),
    // The service still gates shared tasks on this signed flag. It follows the
    // agent's permissions: closed only when neither people nor agents may ask.
    allowSharing: permissions.groupHumans !== 'deny' || permissions.groupAgents !== 'deny'
  }
}
