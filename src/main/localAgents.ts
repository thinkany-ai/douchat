import { executableCommand } from './windowsCommand'
import { changedLocalAgentSettings } from './localAgentSettingsVersion'
import type { CustomLocalAgentInput, ExecutionTarget, LocalAgent, RemoteAgentBinding, RemoteAgentSpec, RemoteConnection } from '../shared/types'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveExecutable, executableEnvironment } from './shellPath'
import { normalizeRemoteSpec, remoteHostLabel } from './remoteValidate'
import { ConnectionStore, connectionSpec, connectionTargetId, legacyTargetId } from './connectionStore'
import { connectionLabel } from './connectionManager'
import { forgetRemoteProbes, probeRemoteAgent } from './remoteTransport'

const execFileAsync = promisify(execFile)
let customRegistryPath: string | undefined

interface CustomLocalAgentDefinition extends CustomLocalAgentInput {
  id: string
  /** Main-only: the P0 target this migrated agent's folders and threads were saved with. */
  legacyTarget?: { connectionId: string; revision: number }
}

const CUSTOM_ID = /^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let connectionStore: ConnectionStore | undefined
/** The signed-in account. Agents on a douchat-host added by another account are hidden, like the host itself. */
let connectionAccountId = ''
export function setConnectionAccount(accountId: string): void { connectionAccountId = accountId }
const otherAccountHost = (connection: RemoteConnection | undefined): boolean =>
  connection?.kind === 'daemon' && connection.daemon?.ownerId !== connectionAccountId
export function configureLocalAgentRegistry(userDataPath?: string, connections?: ConnectionStore): void {
  customRegistryPath = userDataPath ? join(userDataPath, 'local-agents.json') : undefined
  connectionStore = userDataPath ? connections ?? new ConnectionStore(join(userDataPath, 'connections.json')) : undefined
}
export function connectionRegistry(): ConnectionStore {
  if (!connectionStore) throw new Error('Connections are unavailable')
  return connectionStore
}

function customDefinition(value: unknown): CustomLocalAgentDefinition | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const id = String(input.id ?? '').trim()
  if (!CUSTOM_ID.test(id) && !localAgentCatalog.some(item => item[0] === id)) return undefined
  const legacy = input.legacyTarget as CustomLocalAgentDefinition['legacyTarget']
  try {
    // A not-yet-migrated SSH agent is never run directly: it waits for its connection.
    if (input.remote && !input.remoteAgent) return undefined
    return { id, ...validateLocalAgentInput(input as unknown as CustomLocalAgentInput),
      ...(legacy && typeof legacy.connectionId === 'string' && Number.isSafeInteger(legacy.revision) && legacy.revision >= 0 ? { legacyTarget: { connectionId: legacy.connectionId, revision: legacy.revision } } : {}) }
  } catch { return undefined }
}

/** A remote agent on its connection: the SSH spec it runs with and the target its folders belong to. */
export interface RemotePlacementInfo { spec: RemoteAgentSpec; target: ExecutionTarget; connection: RemoteConnection }

/** The server identity of an agent on a connection. A migrated agent keeps the
 * P0 identity its folders were saved with until the connection is edited. */
function placementTarget(definition: CustomLocalAgentDefinition, connection: RemoteConnection): ExecutionTarget {
  const legacy = definition.legacyTarget
  // A migrated agent keeps its P0 identity while it stays on this, unedited,
  // connection: its saved folders and native threads stay valid. Saved folders
  // are also re-bound to the connection at startup (workspaceMigration).
  if (legacy && connection.ssh && legacy.connectionId === connection.id && connection.targetRevision === 0) {
    return { executionTargetId: legacyTargetId(connection.ssh), targetRevision: legacy.revision }
  }
  return { executionTargetId: connectionTargetId(connection), targetRevision: connection.targetRevision }
}

/** An agent bound to a douchat-host: its tasks are claimed by the host, never run here. */
export interface DaemonPlacementInfo { daemon: { connectionId: string; hostId: string; label: string }; connection: RemoteConnection; binding: RemoteAgentBinding }

async function placementOf(definition: CustomLocalAgentDefinition, connections: RemoteConnection[]): Promise<RemotePlacementInfo | DaemonPlacementInfo | { unavailable: 'disabled' | 'missing'; connectionId: string } | undefined> {
  const binding = definition.remoteAgent
  if (!binding) return undefined
  const connection = connections.find(item => item.id === binding.connectionId)
  if (!connection) return { unavailable: 'missing', connectionId: binding.connectionId }
  if (!connection.enabled) return { unavailable: 'disabled', connectionId: connection.id }
  // A host that runs its agents itself takes owner tasks; nothing is launched from here.
  if (connection.kind === 'daemon' && connection.daemon?.hostExecution)
    return { daemon: { connectionId: connection.id, hostId: connection.daemon.hostId, label: connection.name }, connection, binding }
  // Otherwise a douchat-host connection runs the agent exactly like SSH: this computer
  // orchestrates, and only the transport differs (remote/daemonRelay.ts).
  return { spec: connectionSpec(connection, binding), target: placementTarget(definition, connection), connection }
}

async function customDefinitions(): Promise<CustomLocalAgentDefinition[]> {
  if (!customRegistryPath) return []
  let definitions: CustomLocalAgentDefinition[]
  try {
    const parsed = JSON.parse(await readFile(customRegistryPath, 'utf8')) as unknown
    definitions = Array.isArray(parsed) ? parsed.map(customDefinition).filter((item): item is CustomLocalAgentDefinition => Boolean(item)).slice(0, 75) : []
  } catch { definitions = [] }
  const connections = connectionStore ? await connectionStore.list().catch(() => []) : []
  remoteSpecs.clear(); remoteTargets.clear(); remoteLabels.clear(); daemonAgents.clear()
  for (const item of definitions) {
    const placement = await placementOf(item, connections)
    if (placement && 'spec' in placement) { remoteSpecs.set(item.id, placement.spec); remoteTargets.set(item.id, placement.target) }
    // Remote even while unavailable: earlier replies stay marked as coming from a server.
    if (item.remoteAgent) {
      const connection = connections.find(entry => entry.id === item.remoteAgent!.connectionId)
      remoteLabels.set(item.id, connection ? (connection.kind === 'daemon' ? connection.name : connectionLabel(connection)) : 'a removed server')
      // Only hosts set to run their agents themselves are host-executed; the others
      // run from here like SSH agents. Kept while turned off, so they never fall back here.
      if (connection?.kind === 'daemon' && connection.daemon?.hostExecution)
        daemonAgents.set(item.id, { connectionId: connection.id, hostId: connection.daemon.hostId, label: connection.name, binding: item.remoteAgent, enabled: connection.enabled })
    }
  }
  return definitions
}

/** Last validated remote settings, for synchronous labelling (group context, UI). */
const remoteSpecs = new Map<string, RemoteAgentSpec>()
const remoteTargets = new Map<string, ExecutionTarget>()
const remoteLabels = new Map<string, string>()
const daemonAgents = new Map<string, { connectionId: string; hostId: string; label: string; binding: RemoteAgentBinding; enabled: boolean }>()
/** Daemon placement of a local agent id from the last registry read (synchronous, for routing). */
export function cachedDaemonAgent(id: string | undefined): { connectionId: string; hostId: string; label: string; binding: RemoteAgentBinding; enabled: boolean } | undefined {
  return id ? daemonAgents.get(id) : undefined
}
/** Fresh registry read of every daemon-bound local agent. */
export async function daemonAgentDefinitions(): Promise<Map<string, { connectionId: string; hostId: string; label: string; binding: RemoteAgentBinding; enabled: boolean }>> {
  await customDefinitions()
  return new Map(daemonAgents)
}
/** Hosts that agents are bound to on the service (set by the daemon client), for agents set up elsewhere. */
let hostBindingLookup: (agentId: string) => { hostId: string; label: string } | undefined = () => undefined
export function setHostBindingLookup(lookup: typeof hostBindingLookup): void { hostBindingLookup = lookup }

/** Fresh lookup of an agent that its douchat-host runs itself (owner tasks).
 * Throws while that connection is turned off: it must not run anywhere else. */
export async function hostExecutedAgent(agent: { id: string; localAgentId?: string } | undefined): Promise<{ connectionId?: string; hostId: string; label: string } | undefined> {
  const id = agent?.localAgentId
  if (!id || !CUSTOM_ID.test(id)) return undefined
  await customDefinitions()
  const daemon = daemonAgents.get(id)
  // Not in this computer's registry: an agent added on a host from the web app.
  if (!daemon) return remoteLabels.has(id) ? undefined : hostBindingLookup(agent.id)
  if (!daemon.enabled) throw new Error('This agent\'s server connection is turned off. Turn it on in Settings → Connections.')
  return { connectionId: daemon.connectionId, hostId: daemon.hostId, label: daemon.label }
}
/** Host label of any agent configured to run on a server, available or not. */
export function cachedRemoteAgentLabel(id: string | undefined): string | undefined {
  return id ? remoteLabels.get(id) : undefined
}
export function cachedRemoteAgentTarget(id: string | undefined): ExecutionTarget | undefined {
  return id ? remoteTargets.get(id) : undefined
}
/** Fresh lookup of a remote agent's settings together with its server identity.
 * Throws for an agent whose connection is disabled or removed: it must not run
 * anywhere else, least of all on this computer. */
export async function remoteAgentPlacement(id: string | undefined): Promise<RemotePlacementInfo | undefined> {
  if (!id || !CUSTOM_ID.test(id)) return undefined
  const definition = (await customDefinitions()).find(item => item.id === id)
  if (!definition) return undefined
  const placement = await placementOf(definition, connectionStore ? await connectionStore.list() : [])
  if (placement && 'daemon' in placement) throw new Error(`This agent runs on the daemon connection "${placement.daemon.label}" and cannot run on this computer.`)
  if (definition.remoteAgent && daemonAgents.has(definition.id)) throw new Error('This agent\'s daemon connection is turned off. Turn it on in Settings → Connections.')
  if (placement && 'unavailable' in placement) throw new Error(placement.unavailable === 'disabled' ? 'This agent\'s server connection is turned off. Turn it on in Settings → Connections.' : 'This agent\'s server connection was removed. Choose another connection for it in Settings → Agents.')
  return placement
}
export function cachedRemoteAgentSpec(id: string | undefined): RemoteAgentSpec | undefined {
  return id ? remoteSpecs.get(id) : undefined
}
/** Fresh lookup from the registry; undefined for agents running on this computer. */
export async function remoteAgentSpec(id: string | undefined): Promise<RemoteAgentSpec | undefined> {
  return (await remoteAgentPlacement(id))?.spec
}
/** Agent ids on a connection, whatever the connection's state. */
export async function agentsOnConnection(connectionId: string): Promise<string[]> {
  return (await customDefinitions()).filter(item => item.remoteAgent?.connectionId === connectionId).map(item => item.id)
}

async function writeCustomDefinitions(definitions: unknown[]): Promise<void> {
  if (!customRegistryPath) throw new Error('Local agent registry is unavailable')
  await mkdir(dirname(customRegistryPath), { recursive: true })
  const temporary = `${customRegistryPath}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(definitions, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, customRegistryPath)
}

/** Structural check of a remote agent's settings on a connection. */
export function validateRemoteAgentBinding(input: unknown): RemoteAgentBinding {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid remote agent settings.')
  const value = input as Record<string, unknown>
  const connectionId = String(value.connectionId ?? '')
  if (!/^conn_[0-9a-f]{32}$/.test(connectionId)) throw new Error('Choose a server connection.')
  // Adapter, executable, arguments and the dangerous-argument table are the same rules as before.
  const spec = normalizeRemoteSpec({ transport: 'ssh', host: 'placeholder', adapter: value.adapter, executable: value.executable, args: value.args ?? [] })
  return { connectionId, adapter: spec.adapter, executable: spec.executable, args: spec.args }
}

export function validateLocalAgentInput(input: CustomLocalAgentInput): CustomLocalAgentInput {
  const name = String(input?.name ?? '').trim()
  if (!name || name.length > 80) throw new Error('Enter a local agent name of 80 characters or fewer.')
  const avatar = input?.avatar || undefined
  if (avatar && (typeof avatar !== 'string' || avatar.length > 512_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar))) throw new Error('Choose a PNG, JPEG or WebP avatar.')
  if (input?.remote !== undefined && input.remote !== null) throw new Error('Add the server as a connection first, then choose it for this agent.')
  if (input?.remoteAgent !== undefined && input.remoteAgent !== null) {
    // Remote agents use structured fields only; `command` mirrors the remote executable.
    const remoteAgent = validateRemoteAgentBinding(input.remoteAgent)
    return { name, command: remoteAgent.executable, args: [], avatar, remoteAgent }
  }
  const command = String(input?.command ?? '').trim()
  if (!command || command.length > 2_048 || /[\0\r\n]/.test(command)) throw new Error('Enter a valid executable command or absolute path.')
  if (!/[\\/]/.test(command) && /\s/.test(command)) throw new Error('A command name cannot contain spaces. Use an absolute path instead.')
  const args = input.args ?? []
  if (!Array.isArray(args) || args.length > 128 || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || JSON.stringify(args).length > 16384) throw new Error('Enter valid startup arguments.')
  return { name, command, args, avatar }
}

// Serialize read/modify/write operations so simultaneous settings windows cannot lose edits.
let registryWrite: Promise<unknown> = Promise.resolve()
function mutateRegistry(action: (definitions: CustomLocalAgentDefinition[]) => void): Promise<void> {
  const work = registryWrite.catch(() => {}).then(async () => {
    const definitions = await customDefinitions()
    action(definitions)
    // Entries this build cannot use (an SSH agent awaiting migration, or one
    // that no longer validates) are written back untouched, never dropped.
    await writeCustomDefinitions([...definitions, ...await unusableEntries(new Set(definitions.map(item => item.id)))])
  })
  registryWrite = work
  return work
}
async function unusableEntries(kept: Set<string>): Promise<unknown[]> {
  if (!customRegistryPath) return []
  try {
    const parsed = JSON.parse(await readFile(customRegistryPath, 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object' && !kept.has(String((item as { id?: unknown }).id ?? '')) && (item as { id?: unknown }).id !== undefined && !customDefinition(item)) : []
  } catch { return [] }
}
async function validatedInput(input: CustomLocalAgentInput): Promise<CustomLocalAgentInput> {
  const value = validateLocalAgentInput(input)
  // The connection must exist; host, port, user and key live there, never on the agent.
  if (value.remoteAgent && !(await connectionStore?.get(value.remoteAgent.connectionId))) throw new Error('Choose a server connection.')
  return value
}
/** Whether an agent already runs this executable on this connection, so a scan never adds it twice. */
export async function hasRemoteAgent(connectionId: string, executable: string): Promise<boolean> {
  return (await customDefinitions()).some(item => item.remoteAgent?.connectionId === connectionId && item.remoteAgent.executable === executable)
}
export async function addCustomLocalAgent(input: CustomLocalAgentInput): Promise<string> {
  const value = await validatedInput(input)
  const id = `custom:${randomUUID()}`
  await mutateRegistry(definitions => {
    if (definitions.filter(item => CUSTOM_ID.test(item.id)).length >= 64) throw new Error('Up to 64 custom local agents can be registered.')
    definitions.push({ id, ...value })
  })
  return id
}
export async function updateLocalAgent(id: string, input: CustomLocalAgentInput): Promise<void> {
  const value = await validatedInput(input)
  await mutateRegistry(definitions => {
    const index = definitions.findIndex(item => item.id === id)
    if (index < 0 && !localAgentCatalog.some(item => item[0] === id)) throw new Error('Unknown local agent')
    // Built-in entries describe CLIs on this computer; a remote agent is always a custom entry.
    if (value.remoteAgent && !CUSTOM_ID.test(id)) throw new Error('Add a remote agent as a new custom agent.')
    if (index >= 0 && Boolean(definitions[index].remoteAgent) !== Boolean(value.remoteAgent)) throw new Error('The run location of an existing agent cannot be changed. Add a new agent instead.')
    if (index < 0) definitions.push({ id, ...value })
    else {
      // Moving to another connection drops the earlier identity: its folders become stale.
      const previous = definitions[index]
      const keep = previous.legacyTarget && previous.legacyTarget.connectionId === value.remoteAgent?.connectionId
      definitions[index] = { id, ...value, ...(keep ? { legacyTarget: previous.legacyTarget } : {}) }
    }
  })
  forgetRemoteProbes()
  changedLocalAgentSettings(id)
}
/** Detach agents from a removed connection: they stay listed but cannot run. */
export async function removeAgentsOnConnection(connectionId: string, mode: 'disable-agents' | 'delete-agents', inUse: (id: string) => boolean): Promise<string[]> {
  const affected: string[] = []
  await mutateRegistry(definitions => {
    for (let index = definitions.length - 1; index >= 0; index--) {
      const item = definitions[index]
      if (item.remoteAgent?.connectionId !== connectionId) continue
      affected.push(item.id)
      if (mode === 'delete-agents' && !inUse(item.id)) definitions.splice(index, 1)
    }
  })
  return affected
}
export async function removeCustomLocalAgent(id: string): Promise<void> {
  if (!CUSTOM_ID.test(id)) throw new Error('Invalid custom local agent')
  await mutateRegistry(definitions => {
    const index = definitions.findIndex(item => item.id === id)
    if (index < 0) throw new Error('Custom local agent not found')
    definitions.splice(index, 1)
  })
}

/** Resolve a draft without changing the registry or any existing conversation. */
export async function resolveLocalAgentDraft(id: string | undefined, input: CustomLocalAgentInput, signal?: AbortSignal): Promise<LocalAgent> {
  const value = await validatedInput(input)
  const existing = id ? (await detectLocalAgents({ version: async () => undefined }, id))[0] : undefined
  if (id && !existing) throw new Error('Unknown local agent')
  if (value.remoteAgent) {
    if (id && !existing?.remote && !existing?.connectionId) throw new Error('The run location of an existing agent cannot be changed. Add a new agent instead.')
    const connection = await connectionRegistry().get(value.remoteAgent.connectionId)
    if (!connection) throw new Error('Choose a server connection.')
    if (!connection.enabled) throw new Error('This server connection is turned off. Turn it on in Settings → Connections.')
    const remote = await probeRemoteAgent(connectionSpec(connection, value.remoteAgent), signal, true)
    // A draft is tested on the connection as it is now; it has no folders yet.
    return remoteLocalAgent(id ?? `custom:${randomUUID()}`, value.name, value.avatar, remote, { executionTargetId: connectionTargetId(connection), targetRevision: connection.targetRevision }, connection.id)
  }
  const path = await resolveExecutable(value.command)
  if (!path) throw new Error('Executable not found. Check the path and executable permissions.')
  return { id: id ?? `custom:${randomUUID()}`, ...value, path, installed: true, discovered: true,
    chatSupported: true, status: 'ready', authentication: 'unchecked', custom: existing?.custom ?? !id }
}

// Keep the local CLI catalog aligned with Termany. Every catalog entry has a
// one-shot chat adapter in localAgentRuntime, so any detected executable can
// be selected when creating an agent.
export const localAgentCatalog = [
  ['claude', 'Claude Code', 'claude', ['Claude.app']],
  ['codex', 'Codex', 'codex', []],
  ['gemini', 'Gemini', 'gemini', []],
  ['grok', 'Grok Build', 'grok', ['Grok Bot.app']],
  ['openclaw', 'OpenClaw', 'openclaw', ['OpenClaw.app']],
  ['hermes', 'Hermes', 'hermes', ['Hermes.app']],
  ['opencode', 'OpenCode', 'opencode', ['OpenCode.app']],
  ['cursor', 'Cursor', 'cursor-agent', ['Cursor.app']],
  ['kimi', 'Kimi', 'kimi', ['Kimi.app']],
  ['omp', 'OMP', 'omp', []],
  ['fastclaw', 'FastClaw', 'fastclaw', []]
] as const

export async function findDesktopApp(names: readonly string[], roots = [
  '/Applications',
  '/System/Applications',
  join(homedir(), 'Applications')
]): Promise<string | undefined> {
  if (process.platform !== 'darwin' || !names.length) return undefined
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name)
      try {
        await access(candidate, constants.F_OK)
        return candidate
      } catch { /* Try the next conventional application location. */ }
    }
  }
  return undefined
}

export async function executableVersion(path: string): Promise<string | undefined> {
  try {
    const command = await executableCommand(path)
    const { stdout, stderr } = await execFileAsync(command.file, [...command.prefix, '--version'], {
      env: await executableEnvironment(),
      // Node-based CLIs can take several seconds to load even for --version.
      timeout: 6_000,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
      windowsHide: true
    })
    const line = `${stdout}\n${stderr}`.split(/\r?\n/).map((item) => item.trim()).find(Boolean)
    return line?.slice(0, 160)
  } catch {
    // A runnable CLI may not implement --version. Launch compatibility is
    // still established by its known adapter and executable bit.
    return undefined
  }
}

interface DetectionDependencies {
  executable?: (command: string) => Promise<string | undefined>
  desktopApp?: (names: readonly string[]) => Promise<string | undefined>
  version?: (path: string) => Promise<string | undefined>
}

async function detectionDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local agent detection timed out. Check your shell startup configuration and try again.')), ms)
    })])
  } finally { clearTimeout(timer) }
}

export function detectLocalAgents(dependencies: DetectionDependencies = {}, onlyId?: string): Promise<LocalAgent[]> {
  return detectionDeadline(detectLocalAgentsInternal(dependencies, onlyId), 15000)
}

async function detectLocalAgentsInternal(dependencies: DetectionDependencies = {}, onlyId?: string): Promise<LocalAgent[]> {
  const resolveCommand = dependencies.executable ?? resolveExecutable
  const resolveApp = dependencies.desktopApp ?? findDesktopApp
  const readVersion = dependencies.version ?? executableVersion
  const custom = await customDefinitions()
  const connections = connectionStore ? await connectionStore.list().catch(() => []) : []
  const definitions: ReadonlyArray<readonly [string, string, string, readonly string[], boolean]> = [
    ...localAgentCatalog.map(([id, name, command, appNames]) => [id, name, command, appNames, false] as const),
    ...custom.filter(item => CUSTOM_ID.test(item.id)).map(({ id, name, command }) => [id, name, command, [], true] as const)
  ]
  const hidden = new Set(custom.filter(item => item.remoteAgent && otherAccountHost(connections.find(entry => entry.id === item.remoteAgent!.connectionId))).map(item => item.id))
  return Promise.all(definitions.filter(([id]) => (!onlyId || id === onlyId) && !hidden.has(id)).map(async ([id, name, command, appNames, isCustom]) => {
    const override = custom.find(item => item.id === id)
    // Remote agents are not resolved through this computer's PATH; the server is probed at launch.
    if (override?.remoteAgent && isCustom) {
      const placement = await placementOf(override, connections)
      // Shown wherever the agent's server is named; the address stays in Settings → Connections.
      const connectionName = connections.find(item => item.id === override.remoteAgent!.connectionId)?.name
      if (placement && 'daemon' in placement) return { id, name: override.name, command: override.remoteAgent.executable, args: override.remoteAgent.args, avatar: override.avatar,
        installed: true, discovered: true, version: placement.daemon.label, chatSupported: true, status: 'ready', authentication: 'unchecked', custom: true,
        connectionId: placement.connection.id, connectionName, remoteAgent: override.remoteAgent, daemon: placement.daemon } satisfies LocalAgent
      const daemon = daemonAgents.get(id)
      if (placement && 'spec' in placement) return { ...remoteLocalAgent(id, override.name, override.avatar, placement.spec, placement.target, placement.connection.id), connectionName, remoteAgent: override.remoteAgent }
      // Kept in the list so the owner can see and fix it; never launched.
      return { id, name: override.name, command: override.remoteAgent.executable, args: override.remoteAgent.args, avatar: override.avatar, installed: false, discovered: true,
        chatSupported: true, status: 'not-found', authentication: 'unchecked', custom: true, connectionId: override.remoteAgent.connectionId, connectionName,
        remoteAgent: override.remoteAgent, unavailable: placement?.unavailable ?? 'missing', ...(daemon ? { daemon: { connectionId: daemon.connectionId, hostId: daemon.hostId, label: daemon.label } } : {}) }
    }
    name = override?.name ?? name
    command = override?.command ?? command
    const [path, desktopPath] = await Promise.all([resolveCommand(command), resolveApp(appNames)])
    const version = path ? await detectionDeadline(readVersion(path), 8000).catch(() => undefined) : undefined
    const status = path ? 'ready' : desktopPath ? 'desktop-only' : 'not-found'
    return {
      id,
      name,
      command,
      args: override?.args,
      avatar: override?.avatar,
      installed: Boolean(path),
      discovered: Boolean(path || desktopPath),
      path,
      desktopPath,
      version,
      chatSupported: true,
      status,
      authentication: 'unchecked',
      custom: isCustom || undefined
    }
  }))
}

function remoteLocalAgent(id: string, name: string, avatar: string | undefined, remote: RemoteAgentSpec, target: ExecutionTarget, connectionId: string): LocalAgent {
  return {
    id, name, command: remote.executable, args: remote.args, avatar, installed: true, discovered: true,
    version: remoteHostLabel(remote), chatSupported: true, status: 'ready', authentication: 'unchecked', custom: true, remote,
    remoteTarget: target, connectionId
  }
}

/** A runnable local agent. Daemon agents are refused unless `allowDaemon`: they must never start here. */
export async function validateLocalAgent(id: string, options: { allowDaemon?: boolean } = {}): Promise<LocalAgent> {
  const agent = (await detectLocalAgents({ version: async () => undefined }, id)).find((item) => item.id === id)
  if (!agent) throw new Error('Unknown local agent')
  if (agent.daemon && !options.allowDaemon) throw new Error(`${agent.name} runs on the daemon connection "${agent.daemon.label}" and cannot run on this computer.`)
  if (!agent.installed) throw new Error(`${agent.name} is not installed. Refresh Agents in Settings after installing it.`)
  return agent
}
