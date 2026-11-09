import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentPermissions } from '../../shared/agentPermissions'
import type { AgentExecutor, LocalAgentImage, LocalAgentReply, LocalProgress, LocalRunOptions } from '../../shared/agentExecutor'
import { localModelId } from '../../shared/localModels'
import { clampThinking, localThinkingLevels } from '../../shared/thinkingLevels'
import type { AgentConfig, LocalAgent, MessageAttachment } from '../../shared/types'
import { conversationMatcher } from '../sessionKeys'
import type { Access, AgentEvent, AgentInfo, ConnectionEvent, CreateSession, EventEnvelope, SessionMeta } from './aglClient'

/**
 * Local agents that run through the agl daemon on this computer when the
 * experimental "Use agl for local agents" setting is on. Codex only for now;
 * every other agent keeps the desktop runtime.
 */
export const AGL_LOCAL_AGENTS = ['codex'] as const

/**
 * Launch arguments the desktop gives Codex today besides the ones agl sets
 * itself (workspace-write sandbox with network for `edit`): live web search.
 */
const CODEX_DEFAULT_ARGS = ['-c', 'web_search="live"']

/** What agl must offer for an agent to run through it (agl 0.3.12). */
const REQUIRED_FEATURES = ['approvals', 'extra_args', 'instructions', 'ephemeral'] as const

/** The part of the vendored AglClient this executor uses (a fake in tests). */
export interface AglLocalClient {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(listener: (envelope: EventEnvelope) => void): () => void
  onConnection(listener: (event: ConnectionEvent) => void): () => void
  subscribe(sessionId?: string): Promise<void>
}

/** A session's local workspace record, as `localWorkspace` returns it. */
export interface AglWorkspace {
  directory: string
  custom: boolean
  /** The Codex thread this conversation had, to resume natively. */
  thread?: string
  remember(thread?: string): void
}

export interface AglLocalExecutorOptions {
  platform: NodeJS.Platform
  /** The experimental setting (and consent): agl runs local agents. */
  enabled: () => boolean
  /** The connected local daemon, while agl is turned on, running and recent enough. */
  client: () => AglLocalClient | undefined
  /** agl's `agents.list` (cached), undefined when agl cannot answer. */
  agents: () => Promise<AgentInfo[] | undefined>
  /** Douchat's own entry for a local agent (a command override, launch arguments). */
  localAgent: (id: string) => Promise<Pick<LocalAgent, 'id' | 'name' | 'command' | 'args'> | undefined>
  /** The folder and thread record of a persistent session (the desktop's `localWorkspace`). */
  workspace: (config: AgentConfig, sessionKey: string, directory?: string) => AglWorkspace | undefined
  /** A private scratch folder for a transient turn, removed afterwards. */
  scratch: () => Promise<{ directory: string; remove: () => Promise<void> }>
  /** Writes an input image into `directory`; returns its path. */
  writeImage: (directory: string, image: LocalAgentImage) => Promise<string>
  /** A hidden folder for input images inside a project folder, removed afterwards. */
  inputFolder: (directory: string) => Promise<{ directory: string; remove: () => Promise<void> }>
  /** The bytes of an image Codex saved (for images agl sent without data); undefined when not allowed. */
  generatedImageFile?: (path: string) => Promise<Uint8Array | undefined>
  /** Codex's developer instructions for native Computer Use (sent when approvals are forwarded). */
  computerUseInstructions: string
  progressIntervalMs?: number
  log?: (event: string, detail?: string) => void
}

/**
 * Douchat permissions → agl access for Codex (never omitted: agl's local
 * default is `full`). agl maps `edit` to Codex's workspace-write sandbox with
 * network on and approval policy `on-request`, which is what the desktop runs
 * Codex with today (workspace-write + network), except that Codex may now ask
 * to leave the sandbox; such requests and Computer Use confirmations are
 * forwarded to Douchat's approval flow. `read_only` (Codex read-only
 * sandbox, approvals denied by agl) only when the agent may not modify local
 * files at all. `full` (no sandbox) and `ask` (Codex asks before nearly
 * every command) are never used: the first is more than the desktop ever
 * grants, the second would turn every command into a prompt.
 */
export function aglLocalAccess(config: Pick<AgentConfig, 'permissions'>): Access {
  return agentPermissions(config.permissions).sensitive.filesWrite === 'deny' ? 'read_only' : 'edit'
}

/** `douchat:` plus a stable hash of the owner, agent and session key; the prefix keeps clear of terminal sessions. */
export function aglLocalSessionName(config: Pick<AgentConfig, 'ownerId' | 'id'>, sessionKey: string): string {
  return `douchat:${createHash('sha256').update(JSON.stringify([config.ownerId ?? '', config.id, sessionKey])).digest('hex').slice(0, 24)}`
}

/**
 * What a session keeps for its lifetime: agl's launch settings, which
 * `session.configure` cannot change, and the agent's persona and model. Like
 * the desktop runtime (whose workspace record drops the Codex thread when
 * they change), an edited agent starts a new conversation.
 */
interface FixedSettings { cwd: string; instructions?: string; extra_args: string[]; ephemeral: boolean; identity: string }
/** The agent settings the desktop runtime starts a new Codex thread for. */
const identity = (config: AgentConfig): string => JSON.stringify([config.instructions, config.role, config.name, config.model, config.thinkingLevel ?? null])
/** Settings `session.configure` changes in place, keeping the conversation. */
interface LiveSettings { model?: string; effort?: string; access: Access }

/** Model, effort and access from the agent's settings (the same values the desktop runtime passes Codex). */
export function aglLiveSettings(config: AgentConfig, agent: string): LiveSettings {
  const model = localModelId(config.model)
  const effort = config.thinkingLevel ? clampThinking(config.thinkingLevel, localThinkingLevels(agent)) : undefined
  return { access: aglLocalAccess(config), ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** `session.create` for a Douchat turn: always local-only, never in agl's history, access always set. */
export function aglLocalSessionParams(input: {
  config: AgentConfig; agent: string; name: string; cwd: string; extraArgs: string[]; instructions?: string; ephemeral: boolean; resume?: string; warm?: boolean
}): CreateSession {
  const { model, effort, access } = aglLiveSettings(input.config, input.agent)
  return {
    agent: input.agent, name: input.name, cwd: input.cwd, access,
    visibility: 'local', history: false,
    ...(model ? { model } : {}), ...(effort ? { effort } : {}),
    extra_args: input.extraArgs,
    ...(input.instructions?.trim() ? { instructions: input.instructions } : {}),
    ephemeral: input.ephemeral,
    ...(input.resume && !input.ephemeral ? { resume: input.resume } : {}),
    ...(input.warm ? { warm: true } : {})
  }
}

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 20 * 1024 * 1024
const EXTENSIONS: Record<MessageAttachment['mimeType'], string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/** The image type from its first bytes (the same check the desktop runtime uses). */
export function sniffImage(data: Uint8Array): MessageAttachment['mimeType'] | undefined {
  if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  const header = Buffer.from(data.subarray(0, 12)).toString('ascii')
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif'
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

/**
 * Images Codex generated in a turn (its `image_generation` tool), as the
 * desktop runtime returns them today from CODEX_HOME/generated_images: at
 * most 4, 8 MB each, 20 MB in all, and only real PNG/JPEG/GIF/WebP data.
 * Screenshots and viewed images (Computer Use, `view_image`) are not replies.
 */
export class GeneratedImages {
  /** In the order Codex made them; an image agl sent without data is read from disk in its place. */
  private readonly found: Array<Promise<{ data: Uint8Array; saved: string } | undefined>> = []
  constructor(private readonly readFile?: (path: string) => Promise<Uint8Array | undefined>) {}

  add(event: Extract<AgentEvent, { kind: 'tool_end' }>): void {
    if (!event.ok) return
    const saved = typeof event.output === 'string' ? event.output.trim() : ''
    for (const image of event.images ?? []) {
      if (!image.omitted && image.data) this.found.push(Promise.resolve({ data: Buffer.from(image.data, 'base64'), saved }))
      // Too large for agl to send inline: the file Codex saved, if it is one of Codex's.
      else if (saved && this.readFile) this.found.push(this.readFile(saved).then(data => data ? { data, saved } : undefined, () => undefined))
    }
  }

  async done(): Promise<LocalAgentImage[]> {
    const images: LocalAgentImage[] = []
    let total = 0
    for (const item of await Promise.all(this.found)) {
      if (!item) continue
      const mimeType = sniffImage(item.data)
      if (!mimeType || images.length >= MAX_IMAGES || item.data.byteLength > MAX_IMAGE_BYTES || total + item.data.byteLength > MAX_TOTAL_BYTES) continue
      const base = item.saved.split(/[\\/]/).pop() ?? ''
      const name = /^[\w.-]{1,120}\.(png|jpe?g|gif|webp)$/i.test(base) && !images.some(image => image.name === base) ? base : `image-${images.length + 1}.${EXTENSIONS[mimeType]}`
      images.push({ name, mimeType, data: item.data })
      total += item.data.byteLength
    }
    return images
  }
}

interface Session {
  id: string; name: string; agentId: string; sessionKey: string; fixed: FixedSettings; live: LiveSettings; lastSeq: number
  /** The Codex thread (agl's `native_id`). */
  thread?: string
  /** The thread it was created to resume, until a turn completes on it. */
  resuming?: string
  /** Records the Codex thread in the desktop's workspace record. */
  remember?: (thread?: string) => void
  /** Removes a transient session's scratch folder. */
  remove?: () => Promise<void>
}
interface ActiveRun { agentId: string; sessionKey?: string; abort: AbortController }

/** Why a turn does not run through agl; the desktop runtime takes it instead. Nothing ran in agl. */
export class AglUnavailable extends Error {}
/** A turn agl accepted and that then failed: never run again elsewhere. */
class AglTurnError extends Error {}

function sameDirectory(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true
  try { return realpathSync.native(left) === realpathSync.native(right) } catch { return false }
}

/**
 * A session agl returned (perhaps one it kept under that name since before
 * Douchat restarted) has the launch settings asked for, and no conversation
 * other than the one this chat remembers.
 */
function matches(meta: SessionMeta, fixed: FixedSettings, agent: string, thread: string | undefined): boolean {
  return meta.agent === agent && meta.visibility === 'local' && meta.history === false && sameDirectory(meta.cwd, fixed.cwd)
    && (meta.instructions || undefined) === fixed.instructions && Boolean(meta.ephemeral) === fixed.ephemeral && sameList(meta.extra_args ?? [], fixed.extra_args)
    && (!(meta.turns > 0) || (Boolean(thread) && meta.native_id === thread))
}

const STOPPED = 'Stopped'
const RESTARTED = 'agl restarted while this turn was running (for example, to update itself), so the turn was lost. Send your message again.'
const RESUME_FAILED = /resume codex thread|no rollout|thread not found|does not exist/i
/** Why a turn stopped: the reason given, or "Stopped" (as the desktop runtime says) for a plain abort. */
const stopped = (signal: AbortSignal): Error => signal.reason instanceof Error && signal.reason.name !== 'AbortError' ? signal.reason : new Error(STOPPED)
const field = (value: unknown, max = 200): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
const sameList = (left: readonly string[] = [], right: readonly string[] = []): boolean => left.length === right.length && left.every((item, index) => item === right[index])

/** A one-line description of a tool call for progress. */
function toolDetail(event: Extract<AgentEvent, { kind: 'tool_start' }>): string {
  const labels: Record<string, string> = { shell: 'Running a command', edit: 'Updating files', web_search: 'Searching the web', image_generation: 'Generating an image' }
  const name = field(event.name, 60) || 'tool'
  if (labels[name]) {
    const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {}
    const command = Array.isArray(input.command) ? input.command.join(' ') : input.command
    const subject = name === 'shell' ? field(command, 120) : ''
    return subject ? `${labels[name]}: ${subject}` : labels[name]
  }
  return name.includes('.') || name.startsWith('mcp') ? 'Using a connected tool' : 'Working on the task'
}

/**
 * Runs Codex turns through the shared agl daemon on this computer instead of
 * the desktop's own `codex app-server` process (phase 3, behind the
 * experimental setting). One agl session per Douchat session key, created
 * local-only and without agl history, in the folder the desktop runtime uses;
 * `session.prompt`, then events until this turn's `turn_ended`.
 *
 * Whenever agl cannot take a turn (off, not running, too old, Codex not
 * available there, a launch the desktop customizes), {@link handles} says
 * so and the desktop runtime runs it, as before.
 */
export class AglLocalExecutor implements AgentExecutor {
  private readonly sessions = new Map<string, Session>()
  private readonly creating = new Map<string, Promise<{ session: Session; fresh: boolean }>>()
  private readonly active = new Set<ActiveRun>()
  private readonly logged = new Set<string>()
  constructor(private readonly options: AglLocalExecutorOptions) {}

  private fallback(reason: string, detail?: string): undefined {
    // Once per reason until agl takes a turn again.
    if (!this.logged.has(reason)) { this.logged.add(reason); this.options.log?.('agl.local-fallback', detail ? `${reason}: ${detail}` : reason) }
    return undefined
  }

  /** Whether this turn runs through agl; the reason it does not is logged once. */
  async handles(config: AgentConfig, options: LocalRunOptions = {}): Promise<boolean> {
    return Boolean(await this.plan(config, options))
  }

  private async plan(config: AgentConfig, options: LocalRunOptions): Promise<{ client: AglLocalClient; agent: string; extraArgs: string[] } | undefined> {
    const agent = config.localAgentId
    if (!agent || !(AGL_LOCAL_AGENTS as readonly string[]).includes(agent)) return undefined
    if (this.options.platform === 'win32' || !this.options.enabled()) return undefined
    // A launch the desktop customizes per agent or test stays on the desktop runtime.
    if (options.agentOverride) return undefined
    if (config.startupArgs?.length) return this.fallback('startup-args')
    const client = this.options.client()
    if (!client) return this.fallback('agl-not-running')
    const info = (await this.options.agents().catch(() => undefined))?.find(item => item.id === agent)
    if (!info) return this.fallback('agl-not-answering')
    if (!info.available) return this.fallback(`${agent}-not-in-agl`)
    const missing = REQUIRED_FEATURES.filter(feature => !info.features?.includes(feature))
    if (missing.length) return this.fallback('agl-too-old', missing.join(','))
    const local = await this.options.localAgent(agent).catch(() => undefined)
    if (!local) return this.fallback(`${agent}-unknown`)
    // The user pointed Douchat at another command: agl would run its own.
    if (local.command !== agent) return this.fallback('custom-command')
    const extraArgs = [...CODEX_DEFAULT_ARGS, ...(local.args ?? [])]
    if (extraArgs.length > 64 || extraArgs.some(arg => Buffer.byteLength(arg) > 4096)) return this.fallback('launch-args')
    this.logged.clear()
    return { client, agent, extraArgs }
  }

  async prepare(config: AgentConfig, options: LocalRunOptions): Promise<void> {
    if (!options.sessionKey || options.transient) return
    const plan = await this.plan(config, options)
    if (!plan) return
    await this.session(plan.client, config, plan, options, options.sessionKey, true).catch(() => undefined)
  }

  async run(config: AgentConfig, prompt: string, signal?: AbortSignal, images: LocalAgentImage[] = [], options: LocalRunOptions = {}): Promise<LocalAgentReply> {
    const plan = await this.plan(config, options)
    if (!plan) throw new AglUnavailable('agl cannot run this agent now.')
    const run: ActiveRun = { agentId: config.id, sessionKey: options.sessionKey, abort: new AbortController() }
    this.active.add(run)
    const combined = signal ? AbortSignal.any([signal, run.abort.signal]) : run.abort.signal
    const transient = !options.sessionKey || Boolean(options.transient)
    const sessionKey = transient ? `transient:${randomUUID()}` : options.sessionKey!
    let input: { directory: string; remove: () => Promise<void> } | undefined
    let session: Session | undefined
    let accepted = false
    const accept = (): void => { accepted = true }
    try {
      combined.throwIfAborted()
      let fresh: boolean
      try {
        ;({ session, fresh } = await this.session(plan.client, config, plan, options, sessionKey))
      } catch (error) {
        if (combined.aborted) throw error
        // Nothing ran yet: the desktop runtime takes the turn.
        throw new AglUnavailable(`agl could not start a session: ${error instanceof Error ? error.message : String(error)}`)
      }
      const attach = async (text: string, cwd: string): Promise<string> => {
        if (!images.length) return text
        // In a user's project folder, inputs go in a removable hidden folder, as on the desktop runtime.
        input ??= options.workspaceDirectory ? await this.options.inputFolder(cwd) : undefined
        const paths = await Promise.all(images.map(image => this.options.writeImage(input?.directory ?? cwd, image)))
        return `${text}\n\nInspect these attached image files before answering:\n${paths.join('\n')}`
      }
      try {
        return await this.turn(plan.client, session, await attach(fresh ? prompt : options.continuationPrompt ?? prompt, session.fixed.cwd), combined, options, accept)
      } catch (error) {
        // The Codex thread this conversation had cannot be resumed: start a new one with the whole context, once.
        const resumed = session.resuming
        if (combined.aborted || !resumed || !(error instanceof AglTurnError) || !RESUME_FAILED.test(error.message)) throw error
        this.options.log?.('agl.local-resume-failed', error.message)
        session.remember?.(undefined)
        this.sessions.delete(sessionKey)
        await this.close(plan.client, session)
        ;({ session } = await this.session(plan.client, config, plan, options, sessionKey, false, true))
        return await this.turn(plan.client, session, await attach(prompt, session.fixed.cwd), combined, options, accept)
      }
    } catch (error) {
      if (error instanceof AglUnavailable) throw error
      if (combined.aborted) throw stopped(combined)
      // agl refused the prompt before the turn started: the desktop runtime can still take it.
      if (!accepted && !(error instanceof AglTurnError)) throw new AglUnavailable(`agl did not accept the prompt: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      this.active.delete(run)
      await input?.remove().catch(() => undefined)
      if (transient && session) {
        this.sessions.delete(sessionKey)
        await this.close(plan.client, session)
      }
    }
  }

  /** The agl session for a key: reused while its launch settings still apply, otherwise (re)created. */
  private async session(client: AglLocalClient, config: AgentConfig, plan: { agent: string; extraArgs: string[] }, options: LocalRunOptions, sessionKey: string, warm = false, noResume = false): Promise<{ session: Session; fresh: boolean }> {
    const pending = this.creating.get(sessionKey)
    if (pending) await pending.catch(() => undefined)
    const work = this.ensure(client, config, plan, options, sessionKey, warm, noResume)
    this.creating.set(sessionKey, work)
    try { return await work } finally { if (this.creating.get(sessionKey) === work) this.creating.delete(sessionKey) }
  }

  private async ensure(client: AglLocalClient, config: AgentConfig, plan: { agent: string; extraArgs: string[] }, options: LocalRunOptions, sessionKey: string, warm: boolean, noResume: boolean): Promise<{ session: Session; fresh: boolean }> {
    const transient = sessionKey.startsWith('transient:')
    const workspace = transient ? undefined : this.options.workspace(config, sessionKey, options.workspaceDirectory)
    const live = aglLiveSettings(config, plan.agent)
    const instructions = options.onApproval ? this.options.computerUseInstructions : undefined
    const existing = this.sessions.get(sessionKey)
    if (existing && existing.agentId === config.id && (!workspace || existing.fixed.cwd === workspace.directory)
      && existing.fixed.instructions === instructions && sameList(existing.fixed.extra_args, plan.extraArgs) && existing.fixed.ephemeral === !workspace
      && existing.fixed.identity === identity(config)) {
      await this.configure(client, existing, live)
      return { session: existing, fresh: false }
    }
    if (existing) { this.sessions.delete(sessionKey); await this.close(client, existing) }
    let scratch: Awaited<ReturnType<AglLocalExecutorOptions['scratch']>> | undefined
    const cwd = workspace?.directory ?? (scratch = await this.options.scratch()).directory
    const fixed: FixedSettings = { cwd, ...(instructions ? { instructions } : {}), extra_args: plan.extraArgs, ephemeral: !workspace, identity: identity(config) }
    const name = aglLocalSessionName(config, sessionKey)
    const resume = noResume ? undefined : workspace?.thread
    const create = (): Promise<SessionMeta> => client.call<SessionMeta>('session.create', aglLocalSessionParams({ config, agent: plan.agent, name, cwd, extraArgs: plan.extraArgs, instructions, ephemeral: fixed.ephemeral, resume, warm }) as unknown as Record<string, unknown>)
    let meta = await create()
    if (!meta || typeof meta.id !== 'string' || !meta.id) throw new Error('agl did not start a session.')
    // agl reuses a session by name (one Douchat started before a restart) with the settings it was created with.
    if (!matches(meta, fixed, plan.agent, workspace?.thread)) {
      await client.call('session.close', { session_id: meta.id }).catch(() => undefined)
      meta = await create()
      if (!meta?.id) throw new Error('agl did not start a session.')
    }
    const session: Session = { id: meta.id, name, agentId: config.id, sessionKey, fixed, live: { access: meta.access, model: meta.model, effort: meta.effort },
      lastSeq: meta.last_seq ?? 0, thread: meta.native_id, ...(resume ? { resuming: resume } : {}),
      ...(workspace ? { remember: (thread?: string) => workspace.remember(thread) } : {}), ...(scratch ? { remove: scratch.remove } : {}) }
    await this.configure(client, session, live)
    this.sessions.set(sessionKey, session)
    // A session agl kept, or a resumed Codex thread, already has the conversation.
    return { session, fresh: !resume && !(meta.turns > 0) }
  }

  /** Access (permissions) changed, or a kept session runs another model: agl restarts Codex with them and resumes the conversation. */
  private async configure(client: AglLocalClient, session: Session, live: LiveSettings): Promise<void> {
    const change: Partial<LiveSettings> = {}
    if (live.access !== session.live.access) change.access = live.access
    if (live.model && live.model !== session.live.model) change.model = live.model
    if (live.effort && live.effort !== session.live.effort) change.effort = live.effort
    if (!Object.keys(change).length) return
    await client.call('session.configure', { session_id: session.id, ...change })
    session.live = { ...session.live, ...change }
  }

  private async close(client: AglLocalClient, session: Session): Promise<void> {
    await client.call('session.close', { session_id: session.id }).catch(() => undefined)
    await session.remove?.().catch(() => undefined)
  }

  /** Sends one prompt and follows the session's events until this turn ends. */
  private turn(client: AglLocalClient, session: Session, text: string, signal: AbortSignal, options: LocalRunOptions, onAccepted: () => void): Promise<LocalAgentReply> {
    const turnId = `douchat-${randomUUID()}`
    const started = Date.now()
    const state: { phase: LocalProgress['phase']; detail?: string; lastEvent: number; silentMs?: number; approvals: number } = { phase: 'connecting', lastEvent: started, approvals: 0 }
    const report = (): void => {
      if (signal.aborted) return
      const now = Date.now()
      options.onProgress?.({ phase: state.approvals ? 'approval' : state.phase, elapsedSeconds: Math.floor((now - started) / 1000),
        silentSeconds: Math.floor((state.silentMs ?? now - state.lastEvent) / 1000), ...(state.detail ? { detail: state.detail } : {}) })
    }
    const images = new GeneratedImages(this.options.generatedImageFile)
    const tools = new Map<string, string>()
    const approvals = new Map<string, AbortController>()
    let inTurn = false
    let answer = ''
    let commentary = ''
    let lastSeq = session.lastSeq
    const offs: Array<() => void> = []
    let timer: ReturnType<typeof setInterval> | undefined
    return new Promise<LocalAgentReply>((resolve, reject) => {
      let finished = false
      const finish = (error?: Error, reply?: LocalAgentReply): void => {
        if (finished) return
        finished = true
        clearInterval(timer)
        for (const off of offs) off()
        for (const controller of approvals.values()) controller.abort()
        session.lastSeq = Math.max(session.lastSeq, lastSeq)
        if (error) reject(error)
        else resolve(reply!)
      }
      const handle = (envelope: EventEnvelope): void => {
        if (finished || envelope.session_id !== session.id || envelope.seq <= lastSeq) return
        lastSeq = envelope.seq
        const event = envelope.event
        if (event.kind !== 'heartbeat') { state.lastEvent = Date.now(); state.silentMs = undefined }
        // The turn is agl's now: whatever happens, it is not run again elsewhere.
        if ((event.kind === 'user_message' || event.kind === 'turn_started' || event.kind === 'queued') && event.turn_id === turnId) onAccepted()
        switch (event.kind) {
          case 'info':
            if (event.native_id) session.thread = event.native_id
            return
          case 'queued':
            if (event.turn_id === turnId) { state.phase = 'waiting'; state.detail = 'Waiting for the previous turn to finish' }
            return
          case 'status':
            if (event.status === 'starting' && !inTurn) state.phase = 'connecting'
            return
          case 'turn_started':
            inTurn = event.turn_id === turnId
            if (inTurn) { state.phase = 'working'; state.detail = undefined; report() }
            return
          case 'heartbeat':
            if (event.turn_id === turnId) state.silentMs = event.idle_ms
            return
          case 'turn_ended': {
            if (event.turn_id !== turnId) { inTurn = false; return }
            if (event.outcome === 'completed') {
              const text = (typeof event.text === 'string' ? event.text : answer || commentary).trim()
              void images.done().then(generated => {
                if (!text && !generated.length) finish(new AglTurnError('Codex finished without a text or image response. Check its local login and configuration.'))
                else finish(undefined, { text, images: generated })
              })
              return
            }
            if (event.outcome === 'aborted' && signal.aborted) return finish(stopped(signal))
            return finish(new AglTurnError(field(event.error, 600) || (event.outcome === 'aborted' ? 'The turn was stopped in agl.' : 'Codex could not finish this turn.')))
          }
        }
        if (!inTurn) return
        switch (event.kind) {
          case 'text_delta':
            if (event.phase === 'commentary') {
              // An interim update while Codex keeps working: progress, and the reply only if nothing else comes.
              commentary = event.text
              const line = event.text.split(/\n+/).map(item => item.trim()).filter(Boolean).pop()
              if (line) state.detail = line.slice(0, 200)
            } else {
              answer += event.text
              state.detail = 'Generating response content'
            }
            break
          case 'reasoning':
            if (!state.detail) state.detail = 'Thinking'
            break
          case 'tool_start':
            tools.set(event.call_id, event.name)
            // The fallback reply is the text after the last tool call, as Codex's last message.
            answer = ''
            state.detail = toolDetail(event)
            break
          case 'tool_end':
            if (tools.get(event.call_id) === 'image_generation') images.add(event)
            break
          case 'retrying':
            state.detail = 'Model service is not responding; retrying'
            break
          case 'permission_request':
            if (event.decided_by || approvals.has(event.request_id)) break
            void this.approve(client, session, event, approvals, signal, state, report, options)
            break
          case 'permission_resolved':
            // Answered elsewhere, timed out or cancelled: stop asking here.
            if (event.by !== 'client') approvals.get(event.request_id)?.abort()
            break
        }
        report()
      }
      const onAbort = (): void => {
        void client.call('session.abort', { session_id: session.id }).catch(() => undefined)
        finish(stopped(signal))
      }
      if (signal.aborted) return finish(stopped(signal))
      signal.addEventListener('abort', onAbort, { once: true })
      offs.push(() => signal.removeEventListener('abort', onAbort))
      offs.push(client.on(handle))
      offs.push(client.onConnection((event) => {
        if (event.state !== 'reconnected' || finished) return
        if (event.restarted) {
          // Every turn and every session of the old daemon is gone (they keep no history).
          this.forgetAll()
          return finish(new AglTurnError(RESTARTED))
        }
        // Same daemon, only the socket dropped: read what was missed.
        void client.call<EventEnvelope[]>('session.history', { session_id: session.id, after_seq: lastSeq }).then(
          envelopes => { for (const envelope of envelopes ?? []) handle(envelope) },
          error => finish(new AglTurnError(`agl lost this turn: ${error instanceof Error ? error.message : String(error)}`)))
      }))
      report()
      timer = setInterval(report, this.options.progressIntervalMs ?? 1_000)
      timer.unref?.()
      void (async () => {
        await client.subscribe(session.id)
        await client.call('session.prompt', { session_id: session.id, text, mode: 'queue', turn_id: turnId })
        onAccepted()
        if (state.phase === 'connecting') { state.phase = 'waiting'; report() }
      })().catch(error => finish(error instanceof Error ? error : new Error(String(error))))
    }).then(async (reply) => {
      session.resuming = undefined
      // Remember the Codex thread so a later session (after agl or Douchat restarted) resumes it.
      if (session.remember) {
        if (!session.thread) session.thread = (await client.call<SessionMeta>('session.get', { session_id: session.id }).catch(() => undefined))?.native_id
        if (session.thread) session.remember(session.thread)
      }
      return reply
    })
  }

  /** Asks Douchat about a request agl forwards (sandbox escalation, Computer Use), then answers agl. */
  private async approve(client: AglLocalClient, session: Session, event: Extract<AgentEvent, { kind: 'permission_request' }>, approvals: Map<string, AbortController>,
    signal: AbortSignal, state: { approvals: number }, report: () => void, options: LocalRunOptions): Promise<void> {
    const controller = new AbortController()
    approvals.set(event.request_id, controller)
    state.approvals++; report()
    let decision: 'allow' | 'deny' = 'deny'
    try {
      // Turns without an approval handler (internal or tool-less) never grant anything.
      if (options.onApproval) {
        const title = field(event.title) || field(event.tool, 80) || 'Permission request'
        await options.onApproval({ message: `Codex: ${title}`, details: JSON.stringify({ tool: event.tool, title: event.title, input: event.input }, null, 2) },
          AbortSignal.any([controller.signal, signal]))
        decision = 'allow'
      }
    } catch { /* Denied, expired or cancelled: never grants access. */ }
    finally { state.approvals--; approvals.delete(event.request_id); report() }
    if (controller.signal.aborted || signal.aborted) return
    await client.call('session.approve', { session_id: session.id, request_id: event.request_id, decision }).catch(() => undefined)
  }

  /** The daemon restarted: its sessions are gone. The next turn creates one and resumes the Codex thread. */
  forgetAll(): void { this.sessions.clear() }

  /** agl was turned off or the setting changed: stop every running turn and let go of every session. */
  stopAll(reason = 'agl was turned off.'): void {
    for (const run of this.active) run.abort.abort(new Error(reason))
    const client = this.options.client()
    for (const session of this.sessions.values()) if (client) void this.close(client, session)
    this.sessions.clear()
  }

  releaseIdleConnections(): void { /* agl suspends idle sessions itself (idle_timeout_secs). */ }

  disposeAgent(agentId: string): void {
    for (const run of this.active) if (run.agentId === agentId) run.abort.abort(new Error(STOPPED))
    // Settings changed: close the session so Codex lets go of its thread; the next turn resumes it with the new ones.
    const client = this.options.client()
    for (const [key, session] of this.sessions) {
      if (session.agentId !== agentId) continue
      this.sessions.delete(key)
      if (client) void this.close(client, session)
    }
  }

  resetConversation(conversationId: string, topicId?: string, directAgentIds: string[] = []): void {
    const matches = conversationMatcher(conversationId, topicId, directAgentIds)
    for (const run of this.active) if (run.sessionKey && matches(run.sessionKey)) run.abort.abort(new Error(STOPPED))
    const client = this.options.client()
    for (const [key, session] of this.sessions) {
      if (!matches(key)) continue
      this.sessions.delete(key)
      if (client) void this.close(client, session)
    }
  }
}

/**
 * Reads an image Codex saved, for an image agl sent without its data (over
 * 4 MB): only a file inside CODEX_HOME/generated_images, as the desktop
 * runtime reads them today, and only up to 8 MB.
 */
export async function readCodexGeneratedImage(path: string, codexHome: string): Promise<Uint8Array | undefined> {
  const { readFile, realpath, stat } = await import('node:fs/promises')
  const { sep } = await import('node:path')
  const root = await realpath(resolve(codexHome, 'generated_images')).catch(() => undefined)
  const file = await realpath(path).catch(() => undefined)
  if (!root || !file || !file.startsWith(root + sep)) return undefined
  const info = await stat(file)
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return undefined
  return readFile(file)
}

/**
 * Local agents agl can run (Codex, with the experimental setting on) go
 * through agl; everything else, and any turn agl cannot take before it
 * starts, through the desktop runtime as before.
 */
export function aglLocalRouting(local: AgentExecutor, agl: AglLocalExecutor, log?: (event: string, detail?: string) => void): AgentExecutor {
  const handles = (config: AgentConfig, options: LocalRunOptions = {}): Promise<boolean> => agl.handles(config, options).catch(() => false)
  return {
    run: async (config, prompt, signal, images, options = {}) => {
      if (await handles(config, options)) {
        try { return await agl.run(config, prompt, signal, images, options) } catch (error) {
          if (!(error instanceof AglUnavailable)) throw error
          log?.('agl.local-fallback', error.message)
        }
      }
      return local.run(config, prompt, signal, images, options)
    },
    prepare: async (config, options) => {
      if (await handles(config, options)) await agl.prepare(config, options)
      else await local.prepare?.(config, options)
    },
    releaseIdleConnections: (...args) => { local.releaseIdleConnections?.(...args); agl.releaseIdleConnections() },
    disposeAgent: (agentId) => { local.disposeAgent(agentId); agl.disposeAgent(agentId) },
    resetConversation: (conversationId, topicId, directAgentIds, ownerId) => {
      local.resetConversation(conversationId, topicId, directAgentIds, ownerId)
      agl.resetConversation(conversationId, topicId, directAgentIds)
    }
  }
}
