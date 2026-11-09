import type { LocalRunOptions } from '../../shared/agentExecutor'
import { REMOTE_AGENT_ADAPTERS, type AgentConfig, type AglDevice, type AglDeviceAgent, type AglDeviceView, type RemoteAgentAdapter, type RemoteConnection } from '../../shared/types'
import type { AglBackend, ConnectionManager } from '../connectionManager'
import { AGL_MACHINE_ID } from '../connectionStore'
import { aglAgentPlacement } from '../localAgents'
import type { AglHub } from './aglHub'
import type { AglTarget } from './aglExecutor'

const DEVICE_LIST_TTL_MS = 5_000

export function validMachineId(value: unknown): string {
  if (typeof value !== 'string' || !AGL_MACHINE_ID.test(value)) throw new Error('Invalid device.')
  return value
}

/** The Douchat adapter an agl agent is filed under; agl itself decides how to run it. */
export function aglAdapter(agentId: string): RemoteAgentAdapter {
  return (REMOTE_AGENT_ADAPTERS as readonly string[]).includes(agentId) && agentId !== 'custom' ? agentId as RemoteAgentAdapter : 'custom'
}

/** Where an agent runs if it is on an agl device (the routing seam of agl/aglExecutor.ts). */
export async function aglTargetOf(config: AgentConfig, options: LocalRunOptions): Promise<AglTarget | undefined> {
  const override = options.agentOverride
  if (override) return override.agl ? { machineId: override.agl.machineId, agent: override.agl.agent, label: override.agl.label } : undefined
  const placement = await aglAgentPlacement(config.localAgentId)
  return placement ? { machineId: placement.agl.machineId, agent: placement.binding.executable, label: placement.connection.name } : undefined
}

/**
 * Devices linked to the account through agl: the service's list joined with
 * the local connections their agents run on. Also the connection manager's
 * backend for `agl` connections (online check and revoke).
 */
export class AglDevices implements AglBackend {
  private cache?: { at: number; ownerId: string; devices: AglDevice[] }
  constructor(
    private readonly hub: Pick<AglHub, 'listDevices' | 'renameDevice' | 'revokeDevice' | 'agents'>,
    private readonly connections: Pick<ConnectionManager, 'store' | 'saveAgl' | 'status'>,
    private readonly ownerId: () => string | undefined,
    private readonly serviceUrl: string,
    private readonly agentsOn: (connectionId: string) => Promise<string[]>
  ) {}

  private owner(): string {
    const owner = this.ownerId()
    if (!owner) throw new Error('Sign in first.')
    return owner
  }

  async devices(fresh = true, signal?: AbortSignal): Promise<AglDevice[]> {
    const ownerId = this.owner()
    if (!fresh && this.cache && this.cache.ownerId === ownerId && Date.now() - this.cache.at < DEVICE_LIST_TTL_MS) return this.cache.devices
    const devices = await this.hub.listDevices(signal)
    this.cache = { at: Date.now(), ownerId, devices }
    return devices
  }

  private async ownConnections(): Promise<RemoteConnection[]> {
    const ownerId = this.owner()
    return (await this.connections.store.list()).filter(item => item.kind === 'agl' && item.agl?.ownerId === ownerId)
  }

  /** Every device of the account, and devices this computer still has agents on after they were unlinked elsewhere. */
  async list(): Promise<AglDeviceView[]> {
    const [devices, connections] = await Promise.all([this.devices(true), this.ownConnections()])
    const views: AglDeviceView[] = await Promise.all(devices.map(async device => {
      const connection = connections.find(item => item.agl?.machineId === device.machineId)
      return { ...device, name: device.name || connection?.name || device.hostname || device.machineId,
        ...(connection ? { connectionId: connection.id, enabled: connection.enabled } : {}), agentIds: connection ? await this.agentsOn(connection.id) : [] }
    }))
    for (const connection of connections) {
      if (devices.some(device => device.machineId === connection.agl!.machineId)) continue
      views.push({ machineId: connection.agl!.machineId, name: connection.name, hostname: '', os: '', arch: '', version: '', online: false, lastSeenAt: null, pairedAt: 0, agents: [],
        connectionId: connection.id, enabled: connection.enabled, agentIds: await this.agentsOn(connection.id) })
    }
    return views
  }

  async check(connection: RemoteConnection): Promise<number> {
    if (connection.kind !== 'agl' || !connection.agl) throw new Error('This is not a device.')
    if (connection.agl.ownerId !== this.owner()) throw new Error('This device was added with another Douchat account. Sign in with that account to use it.')
    const started = Date.now()
    const device = (await this.devices(false)).find(item => item.machineId === connection.agl!.machineId)
    if (!device) throw new Error('This device is no longer linked to your account. Add it again.')
    if (!device.online) throw new Error('Device is offline')
    return Date.now() - started
  }

  async revoke(connection: RemoteConnection): Promise<void> {
    if (connection.kind !== 'agl' || !connection.agl) return
    // Already unlinked (for instance from another computer): nothing left to revoke.
    if (!(await this.devices(true)).some(item => item.machineId === connection.agl!.machineId)) return
    await this.hub.revokeDevice(connection.agl.machineId)
    this.cache = undefined
  }

  /** Unlinks a device that has no local connection. */
  async revokeMachine(machineId: string): Promise<void> {
    await this.hub.revokeDevice(validMachineId(machineId))
    this.cache = undefined
  }

  async rename(machineId: string, name: unknown): Promise<void> {
    const value = typeof name === 'string' ? name.trim() : ''
    if (!value || value.length > 80 || /[\0-\x1f\x7f]/.test(value)) throw new Error('Enter a device name of 80 characters or fewer.')
    await this.hub.renameDevice(validMachineId(machineId), value)
    this.cache = undefined
    const connection = (await this.ownConnections()).find(item => item.agl?.machineId === machineId)
    if (connection) await this.connections.saveAgl({ name: value, agl: connection.agl! })
  }

  /** The connection agents on a device run on, created the first time agents are added. */
  async connection(machineId: string): Promise<RemoteConnection> {
    validMachineId(machineId)
    const existing = (await this.ownConnections()).find(item => item.agl?.machineId === machineId)
    if (existing) return existing
    const device = (await this.devices(true)).find(item => item.machineId === machineId)
    if (!device) throw new Error('This device is no longer linked to your account. Add it again.')
    return this.connections.saveAgl({ name: device.name || device.hostname || 'Device', agl: { machineId, serviceUrl: this.serviceUrl, ownerId: this.owner() } })
  }

  /** The agents agl reports on a device right now. */
  async agents(machineId: string, signal?: AbortSignal): Promise<AglDeviceAgent[]> {
    const id = validMachineId(machineId)
    if (!(await this.devices(false)).some(item => item.machineId === id)) throw new Error('This device is no longer linked to your account. Add it again.')
    return this.hub.agents(id, signal)
  }
}
