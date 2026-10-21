import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentExecutor, AgentTurn, LocalAgentFile, LocalAgentReply } from '../../shared/agentExecutor'
import { ATTACHMENT_LIMITS } from '../../shared/attachments'
import { packTaskInputs, type HostTaskAttachment, type HostTaskState } from '../../shared/hostTask'
import { agentPermissions, type PermissionApproval, type PermissionRequest } from '../../shared/agentPermissions'
import type { AgentConfig, ConversationActivityState, DaemonEnrollment, DaemonEnrollmentResult, DiscoveredRemoteAgent, LocalAgent, RemoteAgentAdapter, RemoteConnection } from '../../shared/types'
import { recordTiming, timedRemote } from '../diagnostics'
import { hostInstallCommand } from '../../shared/hostInstall'
import type { DesktopAuth } from '../desktopAuth'
import type { DouchatStore } from '../store'
import type { ConnectionManager, DaemonBackend } from '../connectionManager'
import { cachedRemoteAgentLabel, daemonAgentDefinitions, hostExecutedAgent } from '../localAgents'
import { localExecutionTarget } from '../localWorkspaces'
import { canonicalJson, sha256Hex, signCommand, type SignedCommand } from './ownerSigning'
import type { RelayBackend } from './daemonRelay'
import { approvalDecision, RemoteApprovals, REMOTE_APPROVAL_PREFIX, type RemoteApprovalContext } from './remoteApprovals'

const WATCH_BACKOFF = [1_000, 5_000, 15_000, 60_000]
const HOST_LIST_TTL_MS = 5_000
/** Hosts this new run owner tasks (host/src/executor.ts). */
const OWNER_TASK_CAPABILITY = 'owner-tasks'

export interface HostView {
  id: string
  status: 'enrolling' | 'active' | 'revoked' | 'merged'
  trustMode?: 'owner' | 'service'
  name?: string | null
  /** The install command ran on a server already connected to this account. */
  mergedInto?: string
  online: boolean
  lastSeenAt?: number | null
  info: { os?: string; arch?: string; version?: string; capabilities?: string[] }
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

/** Short, comparable fingerprint of the owner device key, also printed by douchat-host setup. */
export function deviceFingerprint(publicKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16)
  return hex.match(/.{4}/g)!.join('-')
}
/** A local service can advertise its production origin via VITE_APP_URL.
 * Keep local enrollment on the service that actually issued the ticket. */
export function enrollmentServiceUrl(configuredUrl: string, advertisedUrl?: string): string {
  const configured = new URL(configuredUrl)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname)
  return local ? configured.origin : new URL(advertisedUrl || configuredUrl).origin
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

  private identity() {
    const state = this.auth.getState()
    const token = this.auth.getAccessToken()
    if (state.status !== 'signed-in' || !token) throw new Error('Sign in first.')
    return { id: state.user.id, token }
  }

  private async request<T>(body: object, signal?: AbortSignal, identity = this.identity()): Promise<T> {
    const response = await fetch(new URL('/api/desktop-auth/social', this.url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000)
    })
    const current = this.identity()
    if (current.id !== identity.id || current.token !== identity.token) throw new Error('The account changed. Try again.')
    if (response.status === 401) { await this.auth.invalidateSession(); throw new Error('Your session expired. Sign in again.') }
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.data === undefined) throw new Error(payload?.message || 'The Douchat service could not be reached. Try again later.')
    return payload.data as T
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

  /**
   * A host added here follows the service like one added from the web app, so
   * every signed-in app can use it. Run on a server already connected to this
   * account, the command switches that host over instead of adding another.
   */
  async createEnrollment(): Promise<DaemonEnrollment> {
    const identity = this.identity()
    const ticket = await this.request<{ hostId: string; ticket: string; serviceUrl: string; expiresAt: number; trust?: string }>({ action: 'host-enroll-ticket', trust: 'service' }, undefined, identity)
    if (ticket.trust !== 'service' || !/^hst_[0-9a-f-]{36}$/.test(ticket.hostId)) throw new Error('The Douchat service returned an invalid install ticket.')
    const serviceUrl = enrollmentServiceUrl(this.url, ticket.serviceUrl)
    const enrollment: DaemonEnrollment = { id: ticket.hostId, hostId: ticket.hostId, installCommand: hostInstallCommand(serviceUrl, ticket.ticket), uninstallCommand: UNINSTALL_COMMAND, fingerprint: '', expiresAt: ticket.expiresAt }
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
        // The server was already connected: this enrollment continues as that host.
        if (host?.status === 'merged' && host.mergedInto) {
          const target = (await this.hosts(true)).find(entry => entry.id === host.mergedInto)
          if (target?.status === 'active' && target.online) { item.result = { hostId: target.id, info: target.info ?? {} }; return item.result }
        }
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
    // A host that follows the service runs its agents itself.
    const host = (await this.hosts(true)).find(entry => entry.id === item.result!.hostId)
    const saved = await this.connections.saveDaemon({ name: String(input?.name ?? ''),
      daemon: { hostId: item.result.hostId, serviceUrl: item.serviceUrl, ownerId: item.ownerId, info: item.result.info, ...(host?.trustMode === 'service' ? { hostExecution: true, trust: 'service' as const } : {}) } })
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
    await this.importAccountHosts(identity.id)
    const definitions = await daemonAgentDefinitions()
    const connections = (await this.connections.store.list()).filter(item => item.kind === 'daemon' && item.daemon?.ownerId === identity.id)
    this.rememberHostNames(connections)
    const mine = this.store.accountAgents.filter(agent => (agent.ownerId ?? identity.id) === identity.id)
    const daemonAgents = mine.filter(agent => agent.localAgentId && definitions.has(agent.localAgentId))
    this.daemonAgentIds = new Set(daemonAgents.map(agent => agent.id))
    // Read even without connections here: agents on hosts added from the web app are bound too.
    const { bindings } = await this.request<WatchResult>({ action: 'task-progress-watch' })
    this.bindings = new Map((bindings ?? []).map(item => [item.localId, item]))
    if (!connections.length) return
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
    const managedHere = new Set(connections.map(item => item.daemon!.hostId))
    for (const binding of this.bindings.values()) {
      if (!binding.executor.startsWith('host:') || this.daemonAgentIds.has(binding.localId)) continue
      // A host this computer did not add (one added from the web app) keeps its agents.
      if (!managedHere.has(binding.executor.slice('host:'.length))) continue
      const agent = mine.find(item => item.id === binding.localId)
      if (!agent || !deviceId || agent.ownerId !== identity.id) continue
      // Only agents set up on this computer move back; agents added from the web stay on their host.
      if (!cachedRemoteAgentLabel(agent.localAgentId)) continue
      await this.bind(agent.id, `desktop:${deviceId}`, '', localExecutionTarget().executionTargetId, binding.bindingRevision, agent.revision ?? 0)
    }

    for (const connection of connections) {
      const host = hosts.find(item => item.id === connection.daemon!.hostId)
      if (host?.status !== 'active') continue
      const own = daemonAgents.filter(agent => definitions.get(agent.localAgentId!)?.connectionId === connection.id)
        .map(agent => hostAgentConfig(agent, definitions.get(agent.localAgentId!)!.binding))
      // A host shared with the web app also runs agents added there; their entries stay.
      const shared = host.trustMode === 'service' ? await this.sharedConfig(host.id, own) : undefined
      const agents = [...own, ...shared?.added ?? []]
      const key = sha256Hex(canonicalJson(JSON.parse(JSON.stringify(agents))))
      if (this.syncedConfig.get(host.id) === key) continue
      // Nothing of this computer's to change on it.
      if (shared && sha256Hex(canonicalJson(shared.current)) === key) { this.syncedConfig.set(host.id, key); continue }
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
    // Progress and approvals of tasks hosts run themselves (owner tasks, shared-room tasks).
    let failures = 0
    const loop = async (): Promise<void> => {
      let delay = 0
      try {
        const identity = this.identity()
        const daemons = (await this.connections.store.list()).filter(item => item.kind === 'daemon' && item.daemon?.ownerId === identity.id)
        this.rememberHostNames(daemons)
        // The owner channel also moves when a host is added, renamed or removed in
        // another app, so this watch keeps the connection list the account's.
        const result = await this.request<WatchResult>({ action: 'task-progress-watch', ...(this.cursor ? { cursor: this.cursor } : {}) }, signal, identity)
        if (signal.aborted || generation !== this.generation) return
        this.cursor = result.cursor
        this.tasks = Array.isArray(result.tasks) ? result.tasks : []
        const bindings = new Map((result.bindings ?? []).map(item => [item.localId, item]))
        const hostsChanged = canonicalJson([...bindings.values()].map(item => [item.localId, item.executor, item.state])) !== canonicalJson([...this.bindings.values()].map(item => [item.localId, item.executor, item.state]))
        this.bindings = bindings
        this.publish(identity.id)
        failures = 0
        if (hostsChanged || await this.accountHostsChanged()) this.scheduleSync()
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

  /** Host-run agents answer the owner's own chats through owner tasks driven by
   * this runtime (runOnHost), so no chat is moved into an agent room any more. */
  isDaemonAgent(_agentId: string): boolean {
    return false
  }

  /** This account's signed-in devices, each with whether every douchat-host here trusts it. */
  async listDevices(): Promise<{ id: string; fingerprint: string; createdAt: number; current: boolean; trusted: boolean }[]> {
    const { devices, hosts } = await this.request<{ devices: { id: string; publicKey: string; createdAt: number }[]; hosts: { id: string; devices: { deviceId: string }[] }[] }>({ action: 'device-list' })
    const mine = new Set((await this.connections.store.list()).filter(item => item.kind === 'daemon' && item.daemon?.ownerId === this.identity().id).map(item => item.daemon!.hostId))
    const relevant = hosts.filter(host => mine.has(host.id))
    return devices.map(device => ({ id: device.id, fingerprint: deviceFingerprint(device.publicKey), createdAt: device.createdAt, current: device.id === this.auth.getDeviceId(),
      trusted: relevant.length > 0 && relevant.every(host => host.devices.some(item => item.deviceId === device.id)) }))
  }

  /**
   * Adds one of this account's devices (a browser) to every douchat-host this
   * computer manages. Each host accepts the new list only because a device it
   * already trusts, this one, signed it.
   */
  async trustDevice(deviceId: string, trusted: boolean): Promise<void> {
    if (deviceId === this.auth.getDeviceId() && !trusted) throw new Error('This computer cannot remove itself. Use another trusted device.')
    const { devices, hosts } = await this.request<{ devices: { id: string; publicKey: string }[]; hosts: { id: string; revision: number; devices: { deviceId: string; publicKey: string }[] }[] }>({ action: 'device-list' })
    const device = devices.find(item => item.id === deviceId)
    if (trusted && !device) throw new Error('This device is no longer signed in to your account.')
    const connections = (await this.connections.store.list()).filter(item => item.kind === 'daemon' && item.daemon?.ownerId === this.identity().id)
    for (const connection of connections) {
      const host = hosts.find(item => item.id === connection.daemon!.hostId)
      if (!host || !host.devices.some(item => item.deviceId === this.auth.getDeviceId())) continue
      const listed = host.devices.some(item => item.deviceId === deviceId)
      if (listed === trusted) continue
      const next = trusted ? [...host.devices, { deviceId, publicKey: device!.publicKey }] : host.devices.filter(item => item.deviceId !== deviceId)
      if (next.length > 20) throw new Error('A server can trust up to 20 devices. Remove one first.')
      await this.request({ action: 'host-devices-sync', hostId: host.id,
        signed: this.sign(host.id, 'host.devices', { revision: host.revision + 1, devices: next }, connection.daemon!.serviceUrl) })
    }
  }

  /**
   * Hosts are the account's, not this computer's: one added from the web app
   * shows up here too, as a connection that runs its agents on the server.
   * A host removed here is revoked, so it is not brought back.
   */
  /** Brings in hosts added from other apps, and marks saved ones that now follow the service (an install command was run again on them). */
  private async importAccountHosts(ownerId: string): Promise<void> {
    const saved = new Map((await this.connections.store.list()).flatMap(item => item.kind === 'daemon' && item.daemon ? [[item.daemon.hostId, item] as const] : []))
    let added = false
    const hosts = await this.hosts(true)
    // Removed in another app: a host that follows the account goes from here too (it is already revoked).
    for (const [hostId, connection] of saved) {
      if (connection.daemon?.trust !== 'service' || connection.daemon.ownerId !== ownerId || hosts.some(host => host.id === hostId && host.status === 'active')) continue
      await this.connections.store.remove(connection.id)
      added = true
    }
    for (const host of hosts) {
      if (host.status !== 'active' || host.trustMode !== 'service') continue
      const existing = saved.get(host.id)
      if (existing?.daemon?.trust === 'service') continue
      await this.connections.saveDaemon({ name: existing?.name || host.name || [host.info?.os, host.info?.arch].filter(Boolean).join(' ') || 'douchat-host',
        daemon: { ...existing?.daemon, hostId: host.id, serviceUrl: existing?.daemon?.serviceUrl ?? this.url, ownerId, info: host.info ?? existing?.daemon?.info ?? {}, hostExecution: true, trust: 'service' } })
      added = true
    }
    if (added) this.onConnectionsImported?.()
  }
  /** Whether the account's hosts differ from the connections saved here (added or switched elsewhere). */
  private async accountHostsChanged(): Promise<boolean> {
    const saved = new Map((await this.connections.store.list()).flatMap(item => item.kind === 'daemon' && item.daemon ? [[item.daemon.hostId, item.daemon.trust] as const] : []))
    const hosts = await this.hosts()
    const active = new Set(hosts.filter(host => host.status === 'active').map(host => host.id))
    return hosts.some(host => host.status === 'active' && host.trustMode === 'service' && saved.get(host.id) !== 'service')
      || [...saved].some(([hostId, trust]) => trust === 'service' && !active.has(hostId))
  }
  /** Lets the window reload its connection list after hosts were brought in. */
  onConnectionsImported?: () => void

  /** A shared host's configuration now, and the entries in it the web app added rather than this computer. */
  private async sharedConfig(hostId: string, own: Record<string, unknown>[]): Promise<{ current: Record<string, unknown>[]; added: Record<string, unknown>[] }> {
    const { hosts } = await this.request<{ hosts: { id: string; agents?: Record<string, unknown>[] }[] }>({ action: 'executor-list' })
    const current = hosts.find(item => item.id === hostId)?.agents ?? []
    const ids = new Set(own.map(entry => entry.localId))
    // Only entries this computer manages are replaced. Everything else stays, including
    // agents added in another app whose records have not reached this computer yet.
    return { current, added: current.filter(entry => {
      const agent = typeof entry.localId === 'string' ? this.store.agent(entry.localId) : undefined
      return !ids.has(entry.localId) && !(agent && cachedRemoteAgentLabel(agent.localAgentId))
    }) }
  }

  /** Hosts that follow the account and their agent configuration, as every app sees them. */
  private async serviceHosts(): Promise<{ id: string; name?: string | null; status?: string; trustMode?: string; agentsRevision?: number; agents?: Record<string, unknown>[] }[]> {
    const { hosts } = await this.request<{ hosts: { id: string; name?: string | null; status?: string; trustMode?: string; agentsRevision?: number; agents?: Record<string, unknown>[] }[] }>({ action: 'executor-list' })
    return hosts.filter(host => (host.status === undefined || host.status === 'active') && host.trustMode === 'service')
  }

  /**
   * Agents configured on hosts that follow the account, with their contact's
   * local agent id: the same list the web app shows (webHosts.localAgents).
   * Their ids are not in this computer's registry; they are added, changed and
   * removed through the host configuration and their contact.
   */
  async hostAgents(): Promise<LocalAgent[]> {
    const connections = await this.connections.store.list()
    return (await this.serviceHosts()).flatMap(host => (host.agents ?? []).flatMap(entry => {
      const agent = typeof entry.localId === 'string' ? this.store.agent(entry.localId) : undefined
      if (!agent?.localAgentId || typeof entry.adapter !== 'string' || typeof entry.executable !== 'string') return []
      const connection = connections.find(item => item.kind === 'daemon' && item.daemon?.hostId === host.id)
      const label = connection?.name || host.name || this.executorLabel(host.id)
      const connectionId = connection?.id ?? ''
      const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : []
      return [{ id: agent.localAgentId, name: agent.name, command: entry.executable, args, installed: true, discovered: true, version: label, chatSupported: true,
        status: 'ready', authentication: 'unchecked', custom: true, hosted: true, connectionId, connectionName: label,
        remoteAgent: { connectionId, adapter: entry.adapter as RemoteAgentAdapter, executable: entry.executable, args },
        daemon: { connectionId, hostId: host.id, label } } satisfies LocalAgent]
    }))
  }

  /**
   * Adds agents found on a host that follows the account the way the web app
   * does (webHosts.addAgents): each becomes a contact, bound to the host and
   * entered in its configuration, so every device has the same agents.
   */
  async addHostAgents(connection: RemoteConnection, agents: { adapter: RemoteAgentAdapter; executable: string; name: string }[], create: (input: { name: string; localAgentId: string }) => AgentConfig): Promise<void> {
    const daemon = this.ownDaemon(connection)
    const host = (await this.serviceHosts()).find(item => item.id === daemon.hostId)
    if (!host) throw new Error('This server was removed. Add it again.')
    const configured = host.agents ?? []
    // Already on the host (added here or on another device): keep the one there is.
    const fresh = agents.filter(item => !configured.some(entry => entry.executable === item.executable && this.store.agent(String(entry.localId))))
    if (!fresh.length) return
    const created = fresh.map(item => ({ item, agent: create({ name: item.name, localAgentId: `custom:${randomUUID()}` }) }))
    for (const { agent } of created)
      await this.request({ action: 'executor-bind', payload: { executor: `host:${host.id}`, localId: agent.id, expectedBindingRevision: 0, configRevision: 1, permissionsRevision: 1, executionTargetId: `daemon:${host.id}` } })
    const current = (await this.serviceHosts()).find(item => item.id === host.id) ?? host
    await this.request({ action: 'host-agents-sync', hostId: host.id, payload: { expectedAgentsRevision: current.agentsRevision ?? 0, agents: [
      ...(current.agents ?? []),
      ...created.map(({ item, agent }) => ({ localId: agent.id, configRevision: 1, permissionsRevision: 1, name: agent.name, role: '', instructions: '', adapter: item.adapter, executable: item.executable, args: [] }))
    ] } })
    this.hostCache = undefined
  }

  /** Turning host execution on needs a host that runs owner tasks (douchat-host 0.2.0 or later). */
  async requireHostExecution(connection: RemoteConnection): Promise<void> {
    const daemon = this.ownDaemon(connection)
    const host = (await this.hosts(true)).find(item => item.id === daemon.hostId)
    if (!host || host.status !== 'active') throw new Error('This daemon was uninstalled or revoked. Remove the connection, then add the server again.')
    if (!host.info?.capabilities?.includes(OWNER_TASK_CAPABILITY))
      throw new Error(host.online
        ? 'douchat-host on this server is too old to run agents itself. Run "douchat-host upgrade" on the server, then try again.'
        : 'douchat-host is offline. Start it on the server, then try again.')
  }

  /**
   * The files the message links as Douchat documents, for the host to place
   * next to the agent. Only the current message is read, not the history.
   */
  private async linkedFiles(message: string): Promise<LocalAgentFile[]> {
    const files: LocalAgentFile[] = []
    for (const match of message.matchAll(/\]\(<(douchat-file:[^>]+)>\)/g)) {
      const path = await this.store.ownedDocumentPath(fileURLToPath(match[1].replace(/^douchat-file:/, 'file:'))).catch(() => undefined)
      const data = path ? await readFile(path).catch(() => undefined) : undefined
      // Saved as "<uuid>-<name>"; the host sees the original name.
      if (path && data) files.push({ name: basename(path).slice(37) || 'file', data })
    }
    return files
  }

  /**
   * Runs one turn of a host-run agent: the prompt this runtime assembled becomes
   * an owner task the host claims and runs with its signed configuration.
   * Progress and the result come back through the service; stopping sends the
   * owner-signed cancel.
   */
  async runOnHost(config: AgentConfig, turn: AgentTurn): Promise<LocalAgentReply> {
    const { prompt, signal, ...options } = turn
    // The images and linked files go along, within the message limits.
    const inputs = packTaskInputs(turn.images, await this.linkedFiles(options.continuationPrompt ?? prompt))
    const { taskId } = await timedRemote('host-task.create', { agentId: config.id }, () => this.request<{ taskId: string }>({ action: 'host-task-create', localId: config.id, clientTaskId: `desktop:${randomUUID()}`,
      prompt, origin: 'desktop', target: { kind: 'none' }, ...inputs,
      // The host resumes this conversation's native session and then needs only the new part.
      ...(options.hostSession ? { sessionKey: options.hostSession, ...(options.continuationPrompt ? { continuation: options.continuationPrompt } : {}) } : {}),
      ...(options.remoteWorkspace?.path ? { workspace: options.remoteWorkspace.path } : {}) }, signal))
    const started = Date.now()
    const context = { taskId, agentId: config.id }
    let claimed = false
    let progressed = false
    let cursor: string | undefined
    let state: HostTaskState | undefined
    for (;;) {
      if (signal?.aborted) {
        recordTiming('host-task.complete', started, { ...context, outcome: 'stopped' })
        if (state?.hostId && state.claimHash && state.bindingRevision !== undefined) {
          const serviceUrl = (await this.connections.store.list()).find(item => item.kind === 'daemon' && item.daemon?.hostId === state!.hostId)?.daemon?.serviceUrl
          await this.request({ action: 'task-cancel', hostId: state.hostId,
            signed: this.sign(state.hostId, 'task.cancel', { taskId, bindingRevision: state.bindingRevision, claimHash: state.claimHash }, serviceUrl) }).catch(() => undefined)
        }
        throw new Error('Stopped')
      }
      state = await this.request<HostTaskState>({ action: 'host-task-wait', taskId, ...(cursor ? { cursor } : {}) }, signal).catch(error => {
        if (signal?.aborted) return state!
        throw error
      })
      cursor = state.cursor
      if (!claimed && state.status !== 'pending') { claimed = true; recordTiming('host-task.claimed', started, context) }
      if (!progressed && state.progress?.text) { progressed = true; recordTiming('host-task.first-progress', started, context) }
      if (state.status === 'succeeded' || state.status === 'failed') recordTiming('host-task.complete', started, { ...context, outcome: state.status })
      if (state.status === 'succeeded') return { text: state.reply ?? '', ...await this.taskOutputs(state.attachments ?? [], signal) }
      if (state.status === 'failed') throw new Error(state.reply || 'The server could not complete this request.')
      const elapsedSeconds = Math.floor((Date.now() - started) / 1000)
      const at = Number(state.progress?.at) || 0
      options.onProgress?.({
        phase: state.approvals.length ? 'approval' : state.status === 'pending' ? 'connecting' : progressPhase(state.progress?.phase),
        elapsedSeconds, silentSeconds: at ? Math.max(0, Math.floor((Date.now() - at) / 1000)) : elapsedSeconds,
        ...(state.progress?.detail ? { detail: state.progress.detail } : state.status === 'pending' ? { detail: `Waiting for ${state.hostId ? this.executorLabel(state.hostId) : 'the server'}` } : {})
      })
    }
  }

  /** The images and files a finished host task delivered, as a local turn returns them. */
  private async taskOutputs(attachments: HostTaskAttachment[], signal?: AbortSignal): Promise<Pick<LocalAgentReply, 'images' | 'files'>> {
    const images: LocalAgentReply['images'] = []
    const files: NonNullable<LocalAgentReply['files']> = []
    for (const item of attachments.slice(0, ATTACHMENT_LIMITS.count)) {
      const { attachment } = await this.request<{ attachment: { name: string; mimeType?: string; base64: string } }>({ action: 'host-task-attachment', attachmentId: item.id }, signal)
      const data = Buffer.from(attachment.base64, 'base64')
      if (item.kind === 'image' && attachment.mimeType) images.push({ name: attachment.name, mimeType: attachment.mimeType as LocalAgentReply['images'][number]['mimeType'], data })
      else files.push({ name: attachment.name, data })
    }
    return { images, ...(files.length ? { files } : {}) }
  }

  /** Reads one image or file a host task produced (an attachment id `hosttask:…`). */
  async hostTaskAttachment(attachmentId: string): Promise<{ name: string; mimeType?: string; base64: string }> {
    return (await this.request<{ attachment: { name: string; mimeType?: string; base64: string } }>({ action: 'host-task-attachment', attachmentId })).attachment
  }

  /** The folder picker for an agent its host runs: the host lists and checks its own folders. */
  async hostFolders(hostId: string, method: 'fs.listDirs' | 'fs.resolveDir', params: Record<string, unknown>): Promise<unknown> {
    const result = await this.request<{ ok?: boolean; pending?: boolean; result?: unknown }>({ action: 'host-control', hostId, method, params })
    if (result.pending) throw new Error('douchat-host did not answer in time. Check that it is online, then try again.')
    if (!result.ok) {
      const message = (result.result as { message?: unknown } | null)?.message
      throw new Error(typeof message === 'string' && message ? message.slice(0, 300) : 'douchat-host could not open this folder.')
    }
    return result.result
  }

  /** The host an agent is bound to on the service, for agents not in this computer's registry. */
  hostBinding(agentId: string): { hostId: string; label: string } | undefined {
    const binding = this.bindings.get(agentId)
    if (!binding?.executor.startsWith('host:') || binding.state === 'revoked') return undefined
    const hostId = binding.executor.slice('host:'.length)
    return { hostId, label: this.executorLabel(hostId) }
  }

  /** Synchronous view for social heartbeat/tasks: agents whose tasks a host claims. */
  daemonAgents(): Set<string> {
    return new Set([...this.daemonAgentIds, ...[...this.bindings.values()].filter(item => item.executor.startsWith('host:')).map(item => item.localId)])
  }
}

const progressPhase = (phase: unknown): 'ready' | 'working' | 'waiting' | 'connecting' =>
  phase === 'ready' || phase === 'waiting' || phase === 'connecting' ? phase : 'working'

/**
 * The runtime's executor: agents their douchat-host runs itself go to the host
 * as owner tasks; every other agent runs on this computer as before.
 */
export function hostAwareExecutor(local: AgentExecutor, host: () => DaemonClient | undefined): AgentExecutor {
  return {
    ...local,
    async run(config, turn) {
      if (!(await hostExecutedAgent(config))) return local.run(config, turn)
      const client = host()
      if (!client) throw new Error('douchat-host connections are unavailable. Sign in to Douchat first.')
      return client.runOnHost(config, turn)
    },
    async prepare(config, options) {
      // A host-run agent has nothing to warm up on this computer.
      if (await hostExecutedAgent(config).catch(() => true)) return
      await local.prepare?.(config, options)
    }
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
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
    ...(agent.permissions ? { permissions: agent.permissions } : {}),
    ...(agent.systemFiles ? { systemFiles: agent.systemFiles } : {}),
    ...(agent.skills?.length ? { skills: agent.skills.filter(skill => skill.enabled).map(({ files: _files, directory: _directory, filesOmitted: _omitted, ...skill }) => skill) } : {}),
    // The service still gates shared tasks on this signed flag. It follows the
    // agent's permissions: closed only when neither people nor agents may ask.
    allowSharing: permissions.groupHumans !== 'deny' || permissions.groupAgents !== 'deny'
  }
}
