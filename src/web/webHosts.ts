import { normalizeAgentEmoji } from '../shared/avatar'
import type { SyncRecord } from '../shared/cloudSync'
import { REMOTE_AGENT_ADAPTERS, type AgentConfig, type ConnectionTestReport, type ConnectionView, type Conversation, type DaemonEnrollment, type DaemonEnrollmentResult, type DiscoveredRemoteAgent, type LocalAgent, type RemoteAgentAdapter, type Topic } from '../shared/types'
import { agentId, deleteAgent } from './agents'
import type { SocialCall } from './hostChat'
import { hostInstallCommand } from '../shared/hostInstall'
import { siteOrigin } from './site'
import type { WebSync } from './webSync'

/**
 * douchat-host servers added from the web app. They follow the Douchat
 * service rather than a device key (trust mode 'service'), so nothing here
 * signs: the signed-in session is the authority, as on hosted agent
 * platforms. Each server runs its agents itself (owner tasks), so they answer
 * with no desktop at all. Their agents are synced records plus a binding and
 * a configuration on the service; nothing lives in a desktop's local registry.
 */

/** Connection ids of web-added hosts, so the web app handles them itself. */
export const WEB_HOST_PREFIX = 'svc_'
const ENROLL_PREFIX = 'web-enroll:'
const PRODUCTION_ORIGIN = 'https://douchat.ai'
const UNINSTALL_COMMAND = '"$HOME/.douchat-host/bin/douchat-host" uninstall --purge'
const AGENT_COLORS = ['#14B8A6', '#FF5DA8', '#7C6CF2', '#F59E42', '#3B82F6', '#84A737']
/** Every adapter a host runs, including user-registered commands. */
const ADAPTERS = new Set<RemoteAgentAdapter>(REMOTE_AGENT_ADAPTERS)
const record = (value: unknown) => value as SyncRecord

interface HostConfig { localId: string; configRevision: number; permissionsRevision: number; name: string; role: string; instructions: string; adapter: string; executable: string; args: string[]; model?: string; thinkingLevel?: string }
interface ListedHost {
  id: string; name: string | null; status: string; trustMode: string; online: boolean; lastSeenAt: number | null
  /** Set when the install command ran on a server already connected to this account. */
  mergedInto?: string
  info: { os?: string; arch?: string; version?: string }; createdAt: number; agentsRevision?: number; agents?: HostConfig[]
}
interface Binding { localId: string; executor: string; state: string; ready: boolean }
interface List { bindings: Binding[]; hosts: ListedHost[] }

const hostIdOf = (connectionId: string) => {
  if (!connectionId.startsWith(WEB_HOST_PREFIX)) throw new Error('This connection is managed in the desktop app.')
  return connectionId.slice(WEB_HOST_PREFIX.length)
}

/** Which service a new host connects to; the dev service is reached as localhost (e.g. over an SSH tunnel). */
function serviceUrl(ticketUrl: string): string {
  if (import.meta.env.DEV) return `http://localhost:${new URL(siteOrigin()).port || '3004'}`
  return new URL(ticketUrl || PRODUCTION_ORIGIN).origin
}
export class WebHosts {
  /** `ticketHostId` is what the install command registered; `hostId` the host it ended up as (a reused one). */
  private enrollments = new Map<string, { ticketHostId: string; hostId: string; expiresAt: number; abort: AbortController }>()

  constructor(private readonly call: SocialCall, private readonly sync: () => WebSync | undefined, private readonly ownerId: () => string | undefined) {}

  private load(): Promise<List> { return this.call<List>({ action: 'executor-list' }) }

  private agentsOn(list: List, hostId: string): AgentConfig[] {
    const ids = new Set(list.bindings.filter(binding => binding.executor === `host:${hostId}` && binding.state !== 'revoked').map(binding => binding.localId))
    return (this.sync()?.all<AgentConfig>('agent') ?? []).filter(agent => ids.has(agent.id))
  }

  async list(): Promise<ConnectionView[]> {
    const list = await this.load()
    return list.hosts.filter(host => host.trustMode === 'service' && host.status === 'active').map(host => {
      const agents = this.agentsOn(list, host.id)
      const enabled = !agents.length || list.bindings.some(binding => binding.executor === `host:${host.id}` && binding.state === 'enabled')
      return {
        id: WEB_HOST_PREFIX + host.id, name: host.name || [host.info.os, host.info.arch].filter(Boolean).join(' ') || 'douchat-host', kind: 'daemon', enabled, targetRevision: 0,
        daemon: { hostId: host.id, serviceUrl: '', ownerId: this.ownerId() ?? '', info: host.info, hostExecution: true, trust: 'service' },
        createdAt: host.createdAt,
        status: !enabled ? { state: 'disabled' } : host.online ? { state: 'connected', agents: agents.length } : { state: 'error', message: 'douchat-host is offline. Check that its service is running on the server.' },
        agentIds: agents.map(agent => agent.localAgentId!).filter(Boolean),
        label: host.name || 'douchat-host'
      } satisfies ConnectionView
    })
  }

  /** Agents on web-added hosts, shaped like the desktop's Settings → Agents rows. */
  async localAgents(): Promise<LocalAgent[]> {
    const list = await this.load().catch(() => undefined)
    if (!list) return []
    return list.hosts.filter(host => host.trustMode === 'service' && host.status === 'active').flatMap(host => (host.agents ?? []).flatMap(config => {
      const agent = this.sync()?.get<AgentConfig>('agent', config.localId)
      if (!agent?.localAgentId) return []
      const connectionId = WEB_HOST_PREFIX + host.id
      return [{ id: agent.localAgentId, name: agent.name, command: config.adapter, args: config.args, installed: true, discovered: true, version: host.name ?? 'douchat-host',
        chatSupported: true, status: 'ready', authentication: 'unchecked', custom: true, hosted: true, connectionId, connectionName: host.name ?? 'douchat-host',
        remoteAgent: { connectionId, adapter: config.adapter as RemoteAgentAdapter, executable: config.executable, args: config.args },
        daemon: { connectionId, hostId: host.id, label: host.name ?? 'douchat-host' } } satisfies LocalAgent]
    }))
  }

  async createEnrollment(): Promise<DaemonEnrollment> {
    const ticket = await this.call<{ hostId: string; ticket: string; serviceUrl: string; expiresAt: number; trust?: string }>({ action: 'host-enroll-ticket', trust: 'service' })
    if (ticket.trust !== 'service' || !/^hst_[0-9a-f-]{36}$/.test(ticket.hostId)) throw new Error('The Douchat service returned an invalid install ticket.')
    const service = serviceUrl(ticket.serviceUrl)
    const id = ENROLL_PREFIX + ticket.hostId
    this.enrollments.set(id, { ticketHostId: ticket.hostId, hostId: ticket.hostId, expiresAt: ticket.expiresAt, abort: new AbortController() })
    return { id, hostId: ticket.hostId, installCommand: hostInstallCommand(service, ticket.ticket), uninstallCommand: UNINSTALL_COMMAND, expiresAt: ticket.expiresAt, fingerprint: '' }
  }

  isEnrollment(id: string): boolean { return id.startsWith(ENROLL_PREFIX) }

  async waitEnrollment(id: string): Promise<DaemonEnrollmentResult | null> {
    const item = this.enrollments.get(id)
    if (!item) throw new Error('This install command has expired. Create a new one.')
    while (!item.abort.signal.aborted && Date.now() < item.expiresAt + 60_000) {
      const host = (await this.load().catch(() => undefined))?.hosts.find(entry => entry.id === item.hostId)
      // The server was already connected: this enrollment continues as that host.
      if (host?.status === 'merged' && host.mergedInto) { item.hostId = host.mergedInto; continue }
      if (host?.status === 'active' && host.online) return { hostId: host.id, info: host.info ?? {} }
      if (host?.status === 'active') item.expiresAt = Math.max(item.expiresAt, Date.now() + 60_000)
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    return null
  }

  /** Closing the dialog without saving removes the host, so no ticket or stray host is left behind. */
  cancelEnrollment(id: string): void {
    const item = this.enrollments.get(id)
    if (!item) return
    item.abort.abort()
    this.enrollments.delete(id)
    // Only the unused ticket goes: a reused host keeps working.
    void this.call({ action: 'host-revoke', hostId: item.ticketHostId, payload: { hostId: item.ticketHostId } }).catch(() => undefined)
  }

  async completeEnrollment(id: string, name: string): Promise<void> {
    const item = this.enrollments.get(id)
    if (!item) throw new Error('Wait for the server to connect first.')
    await this.call({ action: 'host-rename', hostId: item.hostId, name: name.trim() || 'douchat-host' })
    this.enrollments.delete(id)
  }

  async discover(connectionId: string): Promise<DiscoveredRemoteAgent[]> {
    const result = await this.call<{ ok?: boolean; pending?: boolean; result?: { agents?: unknown; message?: string } }>({ action: 'host-control', hostId: hostIdOf(connectionId), method: 'host.discover', params: {} })
    if (result.pending) throw new Error('douchat-host did not answer in time. Check that it is online, then try again.')
    if (!result.ok) throw new Error(result.result?.message || 'douchat-host could not scan the server. Upgrade it with "douchat-host upgrade".')
    const agents = Array.isArray(result.result?.agents) ? result.result!.agents as DiscoveredRemoteAgent[] : []
    return agents.filter(item => ADAPTERS.has(item.adapter) && typeof item.executable === 'string')
  }

  /**
   * Adds agents found on a host: each is a synced agent with its own chat, a
   * binding to the host and an entry in the host's configuration, which the
   * host applies before it takes that agent's tasks.
   */
  async addAgents(connectionId: string, agents: { adapter: RemoteAgentAdapter; executable: string; name: string; args?: string[] }[]): Promise<LocalAgent[]> {
    const sync = this.sync()
    const ownerId = this.ownerId()
    if (!sync || !ownerId) throw new Error('Sign in first.')
    const hostId = hostIdOf(connectionId)
    const list = await this.load()
    const host = list.hosts.find(item => item.id === hostId)
    if (!host) throw new Error('This server was removed. Add it again.')
    const now = Date.now()
    const existing = sync.all<AgentConfig>('agent')
    // Already on the host (added here or on another device): keep the one there is.
    const configured = new Set((host.agents ?? []).filter(entry => sync.get<AgentConfig>('agent', entry.localId)).map(entry => entry.executable))
    agents = agents.filter(item => !configured.has(item.executable))
    const created = agents.filter(item => ADAPTERS.has(item.adapter)).map((item, index): AgentConfig => ({
      id: agentId(item.name), ownerId, name: item.name.trim().slice(0, 80) || item.adapter, role: '', instructions: '', labels: '',
      color: AGENT_COLORS[(existing.length + index) % AGENT_COLORS.length], avatar: '', avatarEmoji: normalizeAgentEmoji(''), avatarSeed: crypto.randomUUID(),
      provider: 'local', model: 'default', localAgentId: `custom:${crypto.randomUUID()}`, localAgentName: item.name, createdAt: now
    }))
    for (const agent of created) {
      const topic: Topic = { id: crypto.randomUUID(), title: '', createdAt: now, updatedAt: now }
      const conversation: Conversation = { ownerId, id: `direct-${agent.id}`, type: 'direct', name: agent.name, agentIds: [agent.id], topics: [topic],
        activeTopicId: topic.id, unread: 0, readAt: now, createdAt: now, updatedAt: now }
      await sync.mutate([{ kind: 'agent', id: agent.id, apply: () => record(agent) }, { kind: 'conversation', id: conversation.id, apply: () => record(conversation) }])
      await this.call({ action: 'executor-bind', payload: { executor: `host:${hostId}`, localId: agent.id, expectedBindingRevision: 0, configRevision: 1, permissionsRevision: 1, executionTargetId: `daemon:${hostId}` } })
    }
    const configs: HostConfig[] = [...(host.agents ?? []), ...created.map((agent, index) => ({
      localId: agent.id, configRevision: 1, permissionsRevision: 1, name: agent.name, role: '', instructions: '',
      adapter: agents[index].adapter, executable: agents[index].executable, args: (agents[index].args ?? []).slice(0, 50)
    }))]
    await this.call({ action: 'host-agents-sync', hostId, payload: { expectedAgentsRevision: host.agentsRevision ?? 0, agents: configs } })
    return this.localAgents()
  }

  /** An agent's profile edited here reaches the host it runs on (name, role, instructions, model). */
  async agentChanged(agent: AgentConfig): Promise<void> {
    const list = await this.load()
    for (const host of list.hosts) {
      const entry = host.trustMode === 'service' && host.status === 'active' ? host.agents?.find(item => item.localId === agent.id) : undefined
      if (!entry) continue
      const next = { ...entry, name: agent.name, role: agent.role, instructions: agent.instructions, configRevision: entry.configRevision + 1,
        ...(agent.model && agent.model !== 'default' ? { model: agent.model } : {}), ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}) }
      if (agent.model === 'default') delete (next as { model?: string }).model
      await this.call({ action: 'host-agents-sync', hostId: host.id, payload: { expectedAgentsRevision: host.agentsRevision ?? 0,
        agents: (host.agents ?? []).map(item => item.localId === agent.id ? next : item) } })
    }
  }

  async setEnabled(connectionId: string, enabled: boolean): Promise<void> {
    const hostId = hostIdOf(connectionId)
    // Without a cursor the watch answers at once with the current bindings and their revisions.
    const { bindings } = await this.call<{ bindings: { localId: string; bindingRevision: number; state: string; executor: string }[] }>({ action: 'task-progress-watch' })
    const state = enabled ? 'enabled' : 'disabled'
    for (const binding of bindings.filter(item => item.executor === `host:${hostId}` && item.state !== 'revoked' && item.state !== state))
      await this.call({ action: 'executor-set-state', localId: binding.localId, payload: { localId: binding.localId, state, expectedBindingRevision: binding.bindingRevision } })
  }

  async remove(connectionId: string, mode: 'disable-agents' | 'delete-agents'): Promise<void> {
    const hostId = hostIdOf(connectionId)
    const list = await this.load()
    const agents = this.agentsOn(list, hostId)
    await this.call({ action: 'host-revoke', hostId, payload: { hostId } })
    const sync = this.sync()
    if (mode === 'delete-agents' && sync) for (const agent of agents) await deleteAgent(sync, agent.id)
  }

  async test(connectionId: string): Promise<ConnectionTestReport> {
    const started = Date.now()
    const host = (await this.load()).hosts.find(item => item.id === hostIdOf(connectionId))
    const online = Boolean(host?.online)
    return { ok: online, durationMs: Date.now() - started, steps: [{ name: 'host', passed: online, ...(online ? {} : { message: 'douchat-host is offline. Check that its service is running on the server.' }) }] }
  }
}
