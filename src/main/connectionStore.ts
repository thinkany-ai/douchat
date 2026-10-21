import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RemoteAgentSpec, RemoteConnection, RemoteConnectionInput } from '../shared/types'
import { normalizeRemoteSpec, remoteHostLabel } from './remoteValidate'

const CONNECTION_ID = /^conn_[0-9a-f]{32}$/

/** Stable identity of an SSH target, with defaults normalized so `host` and `host:22` match. */
type SshTarget = NonNullable<RemoteConnection['ssh']>
const HOST_ID = /^hst_[0-9a-f-]{36}$/
const OWNER_ID = /^[A-Za-z0-9_-]{1,100}$/

export function sshTargetKey(ssh: SshTarget): string {
  return JSON.stringify([ssh.host.toLowerCase(), ssh.port ?? 22, ssh.user ?? '', ssh.identityFile ?? ''])
}
/** The id P0 used for an agent's SSH target. Kept, so folders chosen then still match. */
export function legacyTargetId(ssh: SshTarget): string {
  return `ssh-legacy:${createHash('sha256').update(sshTargetKey(ssh)).digest('hex').slice(0, 32)}`
}
export function connectionTargetId(connection: Pick<RemoteConnection, 'id'> & { kind?: RemoteConnection['kind']; daemon?: RemoteConnection['daemon'] }): string {
  // A daemon's folders live on the host and are versioned by its binding (6.5).
  return connection.kind === 'daemon' && connection.daemon ? `daemon:${connection.daemon.hostId}` : `ssh:${connection.id}`
}

/** The SSH settings of an SSH connection; daemon connections have none. */
export function sshOfConnection(connection: RemoteConnection): SshTarget {
  if (connection.kind !== 'ssh' || !connection.ssh) throw new Error('This connection runs agents through a daemon, not SSH.')
  return connection.ssh
}

function validDaemon(value: unknown): RemoteConnection['daemon'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as NonNullable<RemoteConnection['daemon']>
  if (typeof item.hostId !== 'string' || !HOST_ID.test(item.hostId) || typeof item.ownerId !== 'string' || !OWNER_ID.test(item.ownerId)) return undefined
  let serviceUrl: string
  try {
    const url = new URL(String(item.serviceUrl))
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return undefined
    serviceUrl = url.origin
  } catch { return undefined }
  const text = (field: unknown) => typeof field === 'string' ? field.replace(/[\0-\x1f\x7f]/g, '').slice(0, 40) : undefined
  const info = item.info && typeof item.info === 'object' ? { os: text(item.info.os), arch: text(item.info.arch), version: text(item.info.version) } : undefined
  const service = item.trust === 'service'
  return { hostId: item.hostId, serviceUrl, ownerId: item.ownerId, ...(info ? { info } : {}), ...(item.hostExecution === true || service ? { hostExecution: true } : {}), ...(service ? { trust: 'service' as const } : {}) }
}

/** Structural validation; the identity file is resolved separately in main. */
export function validateConnectionInput(input: unknown): RemoteConnectionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid connection settings.')
  const value = input as Record<string, unknown>
  const ssh = (value.ssh && typeof value.ssh === 'object' ? value.ssh : {}) as Record<string, unknown>
  // Reuse the agent validator for host, port, user and key so the rules stay identical.
  const spec = normalizeRemoteSpec({ transport: 'ssh', host: ssh.host, port: ssh.port, user: ssh.user, identityFile: ssh.identityFile, adapter: 'codex', executable: 'codex', args: [] })
  const name = String(value.name ?? '').trim() || remoteHostLabel(spec)
  if (name.length > 80 || /[\0-\x1f\x7f]/.test(name)) throw new Error('Enter a connection name of 80 characters or fewer.')
  if (value.id !== undefined && (typeof value.id !== 'string' || !CONNECTION_ID.test(value.id))) throw new Error('Invalid connection.')
  return {
    ...(value.id ? { id: value.id as string } : {}), name,
    ssh: { host: spec.host, ...(spec.port ? { port: spec.port } : {}), ...(spec.user ? { user: spec.user } : {}), ...(spec.identityFile ? { identityFile: spec.identityFile } : {}) }
  }
}

function validConnection(value: unknown): RemoteConnection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as RemoteConnection
  if (item.kind === 'daemon') {
    const daemon = validDaemon(item.daemon)
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    if (!daemon || typeof item.id !== 'string' || !CONNECTION_ID.test(item.id) || !name || name.length > 80 || /[\0-\x1f\x7f]/.test(name)) return undefined
    return { id: item.id, name, kind: 'daemon', enabled: item.enabled !== false, targetRevision: 0, daemon,
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0 }
  }
  try {
    const input = validateConnectionInput({ id: item.id, name: item.name, ssh: item.ssh })
    if (!input.id || !Number.isSafeInteger(item.targetRevision) || item.targetRevision < 0) return undefined
    const probe = item.probe && typeof item.probe.home === 'string' && typeof item.probe.path === 'string' && Number.isFinite(item.probe.checkedAt) ? item.probe : undefined
    return { id: input.id, name: input.name, kind: 'ssh', enabled: item.enabled !== false, targetRevision: item.targetRevision, ssh: input.ssh,
      ...(probe ? { probe } : {}), createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0 }
  } catch { return undefined }
}

/** Same-directory temporary file, flushed and renamed: a reader sees the old or the new file, never half of one. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text, { mode: 0o600 })
  const fd = openSync(temporary, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  await rename(temporary, path)
}

export class ConnectionStore {
  private cache?: RemoteConnection[]
  private writing: Promise<unknown> = Promise.resolve()
  constructor(readonly path: string) {}

  async list(): Promise<RemoteConnection[]> {
    if (this.cache) return this.cache.map(item => ({ ...item, ...(item.ssh ? { ssh: { ...item.ssh } } : {}), ...(item.daemon ? { daemon: { ...item.daemon, ...(item.daemon.info ? { info: { ...item.daemon.info } } : {}) } } : {}) }))
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(this.path, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('connections.json could not be read. Restore it or remove it to start over.')
      parsed = { version: 1, connections: [] }
    }
    const items = (parsed as { connections?: unknown[] })?.connections
    this.cache = Array.isArray(items) ? items.map(validConnection).filter((item): item is RemoteConnection => Boolean(item)).slice(0, 64) : []
    return this.list()
  }

  async get(id: string): Promise<RemoteConnection | undefined> { return (await this.list()).find(item => item.id === id) }

  /** Read, change and write as one step; concurrent callers queue. */
  mutate<T>(action: (connections: RemoteConnection[]) => T, write: typeof writeAtomic = writeAtomic): Promise<T> {
    const work = this.writing.catch(() => {}).then(async () => {
      const connections = await this.list()
      const result = action(connections)
      await write(this.path, `${JSON.stringify({ version: 1, connections }, null, 2)}\n`)
      this.cache = connections
      return result
    })
    this.writing = work
    return work
  }

  /** Create or update. Editing host, port, user or key raises the target revision. */
  save(input: RemoteConnectionInput): Promise<RemoteConnection> {
    return this.mutate(connections => {
      if (!input.id) {
        if (connections.length >= 64) throw new Error('Up to 64 connections can be saved.')
        const created: RemoteConnection = { id: `conn_${randomUUID().replaceAll('-', '')}`, name: input.name, kind: 'ssh', enabled: true, targetRevision: 0, ssh: input.ssh, createdAt: Date.now() }
        connections.push(created)
        return created
      }
      const index = connections.findIndex(item => item.id === input.id)
      if (index < 0) throw new Error('Connection not found')
      const previous = connections[index]
      if (previous.kind !== 'ssh' || !previous.ssh) throw new Error('A daemon connection cannot be changed into an SSH connection.')
      const moved = sshTargetKey(previous.ssh) !== sshTargetKey(input.ssh)
      connections[index] = { ...previous, name: input.name, ssh: input.ssh,
        targetRevision: previous.targetRevision + (moved ? 1 : 0), ...(moved ? { probe: undefined } : {}) }
      if (moved) delete connections[index].probe
      return connections[index]
    })
  }

  /** Saves an enrolled douchat-host, or renames it when the host is already saved. */
  saveDaemon(input: { name: string; daemon: NonNullable<RemoteConnection['daemon']> }): Promise<RemoteConnection> {
    const daemon = validDaemon(input.daemon)
    const name = input.name.trim()
    if (!daemon) throw new Error('Invalid daemon connection.')
    if (!name || name.length > 80 || /[\0-\x1f\x7f]/.test(name)) throw new Error('Enter a connection name of 80 characters or fewer.')
    return this.mutate(connections => {
      const existing = connections.find(item => item.kind === 'daemon' && item.daemon?.hostId === daemon.hostId)
      if (existing) {
        existing.name = name
        // Re-enrolling or renaming keeps where its agents run, and a host never goes back to trusting one device.
        existing.daemon = { ...daemon, ...(existing.daemon?.hostExecution ? { hostExecution: true } : {}), ...(existing.daemon?.trust === 'service' ? { trust: 'service' as const } : {}) }
        return existing
      }
      if (connections.length >= 64) throw new Error('Up to 64 connections can be saved.')
      const created: RemoteConnection = { id: `conn_${randomUUID().replaceAll('-', '')}`, name, kind: 'daemon', enabled: true, targetRevision: 0, daemon, createdAt: Date.now() }
      connections.push(created)
      return created
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<RemoteConnection> {
    return this.mutate(connections => {
      const connection = connections.find(item => item.id === id)
      if (!connection) throw new Error('Connection not found')
      connection.enabled = enabled
      return connection
    })
  }

  /** Whether a douchat-host runs its agents itself rather than this computer driving them. */
  setHostExecution(id: string, hostExecution: boolean): Promise<RemoteConnection> {
    return this.mutate(connections => {
      const connection = connections.find(item => item.id === id)
      if (connection?.kind !== 'daemon' || !connection.daemon) throw new Error('Only douchat-host connections can run agents on the server.')
      if (!hostExecution && connection.daemon.trust === 'service') throw new Error('This server is available on all your devices, so it always runs its agents itself.')
      if (hostExecution) connection.daemon.hostExecution = true
      else delete connection.daemon.hostExecution
      return connection
    })
  }

  remove(id: string): Promise<void> {
    return this.mutate(connections => {
      const index = connections.findIndex(item => item.id === id)
      if (index < 0) throw new Error('Connection not found')
      connections.splice(index, 1)
    })
  }

  /** Probe results never change the target revision. Ignored if the target moved meanwhile. */
  recordProbe(id: string, revision: number, probe: RemoteConnection['probe']): Promise<void> {
    return this.mutate(connections => {
      const connection = connections.find(item => item.id === id)
      if (connection && connection.targetRevision === revision) connection.probe = probe
    })
  }
}

/** The SSH spec a connection and an agent binding make together. Probe
 * results are not included: launches always re-validate them. */
export function connectionSpec(connection: RemoteConnection, agent: { adapter: RemoteAgentSpec['adapter']; executable: string; args: string[] }): RemoteAgentSpec {
  // Who may call the agent is decided by its permissions, as for agents on this computer.
  const fields = { adapter: agent.adapter, executable: agent.executable, args: [...agent.args] }
  if (connection.kind === 'daemon') {
    if (!connection.daemon) throw new Error('This douchat-host connection is incomplete. Remove it and add the server again.')
    const { hostId, serviceUrl, ownerId } = connection.daemon
    return { transport: 'daemon', host: connection.name, daemon: { hostId, serviceUrl, ownerId }, ...fields }
  }
  return { transport: 'ssh', ...sshOfConnection(connection), ...fields }
}

// ─── Migration from per-agent SSH settings ───────────────────────────────────

/** What a migrated agent was before: lets saved folders and threads carry over. */
export interface MigratedAgent { connectionId: string; legacyTargetId: string; legacyRevision: number }
interface LegacyDefinition { id: string; remote?: Record<string, unknown>; remoteTargetRevision?: number; remoteAgent?: unknown; [key: string]: unknown }
interface MigrationPlan {
  version: 1
  sourceHash: string
  /** Ids derive from the target, so a resumed plan never invents new ones. */
  connections: RemoteConnection[]
  agents: Record<string, MigratedAgent>
  /** Agents whose old settings no longer validate; left untouched. */
  skipped?: string[]
  phase: 'planned' | 'connections-written' | 'agents-written'
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const sshOf = (spec: RemoteAgentSpec): SshTarget =>
  ({ host: spec.host, ...(spec.port ? { port: spec.port } : {}), ...(spec.user ? { user: spec.user } : {}), ...(spec.identityFile ? { identityFile: spec.identityFile } : {}) })

/**
 * One-time, resumable move of SSH settings from local-agents.json into
 * connections.json: backup, plan, connections, agents, done marker. A crash at
 * any step resumes from the plan without new ids; agents are rewritten only
 * after every connection they will refer to exists. If local-agents.json was
 * changed by someone else meanwhile, it stops and leaves the old file alone.
 */
export async function migrateConnections(userData: string, store: ConnectionStore, write: typeof writeAtomic = writeAtomic): Promise<Record<string, MigratedAgent>> {
  const registry = join(userData, 'local-agents.json')
  const planFile = join(userData, 'connections-migration.json')
  const done = join(userData, 'connections-migration.done')
  const finished = async (): Promise<Record<string, MigratedAgent>> => {
    try { return (JSON.parse(await readFile(planFile, 'utf8')) as MigrationPlan).agents ?? {} } catch { return {} }
  }
  try { await readFile(done); return finished() } catch { /* Not finished yet. */ }

  let text: string
  try { text = await readFile(registry, 'utf8') } catch { await write(done, 'no registry\n'); return {} }
  let plan: MigrationPlan | undefined
  try { plan = JSON.parse(await readFile(planFile, 'utf8')) } catch { plan = undefined }

  if (!plan) {
    let definitions: LegacyDefinition[]
    try { definitions = JSON.parse(text) } catch { throw new Error('local-agents.json could not be read, so connections were not set up.') }
    const legacy = Array.isArray(definitions) ? definitions.filter(item => item?.remote && !item.remoteAgent) : []
    if (!legacy.length) { await write(done, 'nothing to migrate\n'); return {} }
    await copyFile(registry, join(userData, 'local-agents.json.bak-before-connections'))
    const byTarget = new Map<string, RemoteConnection>()
    const agents: Record<string, MigratedAgent> = {}
    const skipped: string[] = []
    for (const item of legacy) {
      let spec: RemoteAgentSpec
      // Kept in local-agents.json as it is (registry writes preserve it) and reported to the user.
      try { spec = normalizeRemoteSpec(item.remote) } catch { skipped.push(String(item.name ?? item.id)); continue }
      const ssh = sshOf(spec)
      const key = sshTargetKey(ssh)
      let connection = byTarget.get(key)
      if (!connection) {
        connection = { id: `conn_${sha(`migrated:${key}`).slice(0, 32)}`, name: remoteHostLabel(spec), kind: 'ssh', enabled: true, targetRevision: 0, ssh, createdAt: Date.now() }
        byTarget.set(key, connection)
      }
      agents[item.id] = { connectionId: connection.id, legacyTargetId: legacyTargetId(ssh), legacyRevision: Number.isSafeInteger(item.remoteTargetRevision) ? item.remoteTargetRevision as number : 0 }
    }
    plan = { version: 1, sourceHash: sha(text), connections: [...byTarget.values()], agents, skipped, phase: 'planned' }
    await write(planFile, JSON.stringify(plan, null, 2))
  }

  if (plan.phase === 'planned') {
    await store.mutate(connections => {
      for (const planned of plan!.connections) if (!connections.some(item => item.id === planned.id)) connections.push({ ...planned, ssh: { ...planned.ssh! } })
    }, write)
    plan.phase = 'connections-written'
    await write(planFile, JSON.stringify(plan, null, 2))
  }

  if (plan.phase === 'connections-written') {
    const current = await readFile(registry, 'utf8')
    const parsed = JSON.parse(current) as LegacyDefinition[]
    const alreadyWritten = Array.isArray(parsed) && Object.keys(plan.agents).every(id => parsed.some(item => item?.id === id && item.remoteAgent && !item.remote))
    if (!alreadyWritten && sha(current) !== plan.sourceHash) {
      // The registry changed since the plan was made. Plan again from what is on
      // disk now: connection ids derive from the SSH target, so nothing new is invented.
      await rm(planFile, { force: true })
      return migrateConnections(userData, store, write)
    }
    if (!alreadyWritten) {
      const known = new Map((await store.list()).map(item => [item.id, item]))
      const rewritten = parsed.map(item => {
        const migrated = item?.id ? plan!.agents[item.id] : undefined
        if (!migrated || !item.remote) return item
        const spec = normalizeRemoteSpec(item.remote)
        const connection = known.get(migrated.connectionId)
        if (!connection) throw new Error('A connection is missing; stopped before changing any agent.')
        const { remote: _remote, remoteTargetRevision: _revision, ...rest } = item
        return { ...rest, command: spec.executable, args: [],
          // Folders and threads saved for the agent's earlier target stay valid while it
          // stays on this connection and the connection is not edited.
          legacyTarget: { connectionId: connection.id, revision: migrated.legacyRevision },
          // Sharing was moved to the agent's permissions before this step (sharingMigration.ts).
          remoteAgent: { connectionId: connection.id, adapter: spec.adapter, executable: spec.executable, args: spec.args } }
      })
      await write(registry, `${JSON.stringify(rewritten, null, 2)}\n`)
    }
    plan.phase = 'agents-written'
    await write(planFile, JSON.stringify(plan, null, 2))
  }

  await write(done, `${new Date().toISOString()}\n`)
  return plan.agents
}

/** Agents the migration left alone because their old SSH settings no longer validate. */
export async function skippedMigrationAgents(userData: string): Promise<string[]> {
  try { return (JSON.parse(await readFile(join(userData, 'connections-migration.json'), 'utf8')) as MigrationPlan).skipped ?? [] } catch { return [] }
}
