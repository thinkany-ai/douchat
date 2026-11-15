import { aglEnabled, type AglSettings, type AglStatusView } from '../../shared/agl'
import type { AgentConfig, LocalAgent } from '../../shared/types'
import type { AgentInfo } from './aglClient'

/**
 * Server-driven execution of local agents through agl (desktop side).
 *
 * Once this computer is linked to the Douchat service through agl, the
 * desktop tells the service which of its agents agl can run here
 * (`agl-bind`). For those agents the service itself takes messages that
 * arrive from other devices (1:1 `request` records and shared-room tasks) and
 * runs them through agl on this machine; the desktop only executes, through
 * the agl daemon, and must then leave those messages alone so nothing runs
 * twice. Messages typed in the desktop app itself still run locally (v1).
 */

/** agl adapter ids the service can start (contract: `aglAgent`). */
export const AGL_ADAPTER_IDS = ['codex', 'claude', 'gemini', 'opencode', 'kimi', 'grok', 'droid', 'openclaw', 'hermes', 'omp', 'cursor', 'pi'] as const
export type AglAdapterId = typeof AGL_ADAPTER_IDS[number]

/**
 * Desktop `localAgentId` → agl adapter id. Every desktop catalog agent agl
 * also runs has the same id there (`cursor` is the catalog id; its command is
 * `cursor-agent`). FastClaw and custom agents (`custom:…`) have none; agl's
 * `droid` and `pi` have no desktop catalog entry yet.
 */
export function aglAdapterFor(localAgentId: string | undefined): AglAdapterId | undefined {
  return localAgentId && (AGL_ADAPTER_IDS as readonly string[]).includes(localAgentId) ? localAgentId as AglAdapterId : undefined
}

export interface AglBindAgent { agentId: string; aglAgent: AglAdapterId }

/** What eligibility looks at of a desktop agent. */
export type BindableAgent = Pick<AgentConfig, 'id' | 'localAgentId' | 'startupArgs' | 'ownerId'>
/** What eligibility looks at of the desktop's entry for a local CLI. */
export type BindableLocalAgent = Pick<LocalAgent, 'id' | 'command' | 'installed' | 'custom' | 'args' | 'remote' | 'remoteAgent' | 'connectionId' | 'daemon' | 'agl'>

/**
 * The agents of `accountId` that agl can run on this computer, as the service
 * should run them: built-in local kinds that map 1:1 to an agl adapter, run
 * with the catalog's own command (no custom command), without launch
 * arguments (no `startupArgs`, no arguments on the CLI entry), installed here,
 * and reported available by agl's `agents.list`. Never on Windows.
 */
export function eligibleAglAgents(input: {
  platform: NodeJS.Platform
  accountId: string
  agents: BindableAgent[]
  localAgents: BindableLocalAgent[]
  /** Catalog id → the command Douchat runs by default (`localAgentCatalog`). */
  catalogCommands: Record<string, string>
  /** agl's `agents.list` on this computer. */
  aglAgents: Pick<AgentInfo, 'id' | 'available'>[]
}): AglBindAgent[] {
  if (input.platform === 'win32') return []
  const local = new Map(input.localAgents.map(agent => [agent.id, agent]))
  const available = new Set(input.aglAgents.filter(agent => agent.available).map(agent => agent.id))
  const result: AglBindAgent[] = []
  for (const agent of input.agents) {
    if (agent.ownerId !== input.accountId) continue
    const adapter = aglAdapterFor(agent.localAgentId)
    if (!adapter || !available.has(adapter)) continue
    if (agent.startupArgs?.length) continue
    const entry = local.get(agent.localAgentId!)
    if (!entry || !entry.installed || entry.custom) continue
    if (entry.remote || entry.remoteAgent || entry.connectionId || entry.daemon || entry.agl) continue
    if (entry.command !== input.catalogCommands[entry.id]) continue
    if (entry.args?.length) continue
    result.push({ agentId: agent.id, aglAgent: adapter })
  }
  return result.sort((a, b) => a.agentId.localeCompare(b.agentId))
}

/** This computer's agl link to the Douchat service works right now. */
export function aglLinkHealthy(view: Pick<AglStatusView, 'state' | 'machineId' | 'linked' | 'hubStatus'>): boolean {
  return view.state === 'running' && Boolean(view.machineId) && view.linked === true && view.hubStatus === 'connected'
}

/** A cheap fingerprint of what could change eligibility on the desktop agent side. */
export function agentsFingerprint(agents: BindableAgent[]): string {
  return JSON.stringify(agents.filter(agent => aglAdapterFor(agent.localAgentId)).map(agent => [agent.id, agent.localAgentId, agent.ownerId, agent.startupArgs ?? []])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
}

export type AglBindIdentity = { id: string; token: string }

export interface AglBinderDependencies {
  platform: NodeJS.Platform
  lifecycle: {
    view(): AglStatusView
    onStatus(listener: (view: AglStatusView) => void): () => void
    /** Re-reads `agl status --json` (read-only), so the link's health stays current. */
    readOnlyStatus?(): Promise<unknown>
  }
  settings: () => Pick<AglSettings, 'enabled'>
  /** The signed-in account and its desktop token, if any. */
  identity: () => AglBindIdentity | undefined
  /** `POST /api/desktop-auth/social` as `identity`. */
  post: <T>(identity: AglBindIdentity, body: { action: string; [field: string]: unknown }) => Promise<T>
  /** The signed-in account's agents (`store.accountAgents`). */
  agents: () => BindableAgent[]
  /** The desktop's local CLI entries (`detectLocalAgents`). */
  localAgents: () => Promise<BindableLocalAgent[]>
  catalogCommands: Record<string, string>
  /** agl's `agents.list`; undefined when agl cannot answer now. */
  aglAgents: () => Promise<Pick<AgentInfo, 'id' | 'available'>[] | undefined>
  /** The Douchat workspace root on this computer, created if needed. */
  cwd: () => Promise<string | undefined>
  debounceMs?: number
  /** Full re-check (local CLI changes, agl detection) and link health refresh. */
  intervalMs?: number
  log?: (event: string, detail?: string) => void
}

interface Bound { identity: AglBindIdentity; machineId: string; key: string; agents: Set<string> }

/**
 * Keeps the service's agent → machine bindings for this computer current
 * (`agl-bind` / `agl-unbind`), and tells the desktop which agents the service
 * runs here, so cloud sync and the social task poll leave them alone.
 *
 * Sends `agl-bind` once the link works (after linking, and on start once
 * linked), whenever the eligible agents change (debounced), and on a slow
 * interval as a safety net; an identical payload is not sent again. Sends
 * `agl-unbind` before the link is removed, on sign-out, when another account
 * signs in, and when agl is turned off.
 */
export class AglBinder {
  private bound?: Bound
  private timer?: ReturnType<typeof setTimeout>
  private interval?: ReturnType<typeof setInterval>
  private syncing?: Promise<void>
  private again = false
  private fingerprint?: string
  private statusOff?: () => void
  private disposed = false

  constructor(private readonly deps: AglBinderDependencies) {}

  start(): void {
    if (this.statusOff || this.disposed) return
    this.statusOff = this.deps.lifecycle.onStatus(view => this.statusChanged(view))
    this.interval = setInterval(() => {
      void (async () => {
        await this.deps.lifecycle.readOnlyStatus?.().catch(() => undefined)
        await this.sync()
      })()
    }, this.deps.intervalMs ?? 10 * 60_000)
    this.interval.unref?.()
    this.statusChanged(this.deps.lifecycle.view())
  }

  dispose(): void {
    this.disposed = true
    this.statusOff?.(); this.statusOff = undefined
    clearTimeout(this.timer); clearInterval(this.interval)
  }

  /** Agents the service runs on this computer now: bound for the signed-in account, while the link works. */
  routedAgents(): Set<string> {
    const bound = this.bound
    if (!bound || !aglEnabled(this.deps.settings()) || this.deps.platform === 'win32') return new Set()
    const view = this.deps.lifecycle.view()
    if (!aglLinkHealthy(view) || view.machineId !== bound.machineId) return new Set()
    if (this.deps.identity()?.id !== bound.identity.id) return new Set()
    return new Set(bound.agents)
  }

  /** A 1:1 request for `direct-<agentId>` the service claims and runs (contract: Server routing). */
  routesConversation(conversationId: string): boolean {
    if (!conversationId.startsWith('direct-')) return false
    return this.routedAgents().has(conversationId.slice('direct-'.length))
  }

  /** The agents may have changed (every snapshot broadcast): rebinds, debounced, when what matters changed. */
  agentsChanged(agents: BindableAgent[] = this.deps.agents()): void {
    const fingerprint = agentsFingerprint(agents)
    if (fingerprint === this.fingerprint) return
    this.fingerprint = fingerprint
    this.schedule()
  }

  /** Rebinds after the debounce. */
  schedule(): void {
    if (this.disposed) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; void this.sync() }, this.deps.debounceMs ?? 2_000)
    this.timer.unref?.()
  }

  private statusChanged(view: AglStatusView): void {
    if (view.state === 'off' || !aglEnabled(this.deps.settings())) { void this.unbind('agl-off'); return }
    if (this.bound && this.deps.identity()?.id !== this.bound.identity.id) void this.unbind('account-changed')
    if (aglLinkHealthy(view) && !view.busy) this.schedule()
  }

  /**
   * Sends `agl-bind` with the eligible agents when the link works and the
   * payload differs from what the service last accepted. Never throws.
   */
  sync(): Promise<void> {
    if (this.syncing) { this.again = true; return this.syncing }
    this.syncing = this.attempt().catch(error => this.deps.log?.('agl.bind-failed', error instanceof Error ? error.message : String(error)))
      .finally(() => {
        this.syncing = undefined
        if (this.again) { this.again = false; void this.sync() }
      })
    return this.syncing
  }

  private async attempt(): Promise<void> {
    if (this.disposed) return
    const identity = this.deps.identity()
    if (this.bound && this.bound.identity.id !== identity?.id) await this.unbind('account-changed')
    if (!identity || this.deps.platform === 'win32' || !aglEnabled(this.deps.settings())) return
    const view = this.deps.lifecycle.view()
    if (!aglLinkHealthy(view) || !view.machineId) return
    const machineId = view.machineId
    const accountAgents = this.deps.agents()
    this.fingerprint = agentsFingerprint(accountAgents)
    const aglAgents = await this.deps.aglAgents()
    if (!aglAgents) return
    const agents = eligibleAglAgents({
      platform: this.deps.platform, accountId: identity.id, agents: accountAgents,
      localAgents: await this.deps.localAgents(), catalogCommands: this.deps.catalogCommands, aglAgents
    })
    const cwd = await this.deps.cwd().catch(() => undefined)
    const key = JSON.stringify([identity.id, machineId, cwd ?? null, agents])
    if (this.bound?.key === key) return
    // Another machine id (agl reinstalled with a new one): the old binding goes first.
    if (this.bound && this.bound.machineId !== machineId) await this.unbind('machine-changed')
    await this.deps.post(identity, { action: 'agl-bind', machineId, ...(cwd ? { cwd } : {}), agents })
    this.bound = { identity, machineId, key, agents: new Set(agents.map(agent => agent.agentId)) }
    this.deps.log?.('agl.bind', `${machineId}: ${agents.map(agent => `${agent.agentId}=${agent.aglAgent}`).join(',') || 'none'}`)
  }

  /**
   * `agl-unbind {machineId}` as the account that made the bindings, then
   * forgets them locally (also when the service cannot be reached: it stops
   * routing to a machine that is no longer linked or online). Never throws.
   */
  async unbind(reason = 'unlink'): Promise<void> {
    const bound = this.bound
    if (!bound) return
    this.bound = undefined
    try {
      await this.deps.post(bound.identity, { action: 'agl-unbind', machineId: bound.machineId })
      this.deps.log?.('agl.unbind', `${bound.machineId} (${reason})`)
    } catch (error) {
      this.deps.log?.('agl.unbind-failed', `${reason}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
