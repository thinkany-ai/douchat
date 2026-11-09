import { createHash, randomUUID } from 'node:crypto'
import { agentPermissions } from '../../shared/agentPermissions'
import type { AgentExecutor, LocalAgentImage, LocalAgentReply, LocalProgress, LocalRunOptions } from '../../shared/agentExecutor'
import type { AgentConfig } from '../../shared/types'
import { conversationMatcher } from '../sessionKeys'
import type { AglEventEnvelope, AglHub } from './aglHub'

/** agl access levels Douchat asks for (contract §2: the service clamps to these). */
export type AglAccess = 'ask' | 'edit' | 'read_only' | 'full'

/** Where an agent bound to an agl device runs. */
export interface AglTarget {
  machineId: string
  /** agl's agent id on that device, e.g. `claude` or `codex`. */
  agent: string
  /** The device's name, shown in progress and approval requests. */
  label: string
}

export interface AglExecutorOptions {
  hub: Pick<AglHub, 'call' | 'events'>
  /** The device an agent runs on, or undefined for agents that do not run through agl. */
  resolve: (config: AgentConfig, options: LocalRunOptions) => Promise<AglTarget | undefined>
  /** How often progress is reported while a turn runs. */
  progressIntervalMs?: number
}

/**
 * Full access only when Douchat would already allow everything the agent asks
 * for without asking (it has no sensitive capability set to ask or deny that
 * a forwarded request could hit). Otherwise agl forwards each request (`ask`).
 */
export function aglAccess(config: AgentConfig): AglAccess {
  const { sensitive } = agentPermissions(config.permissions)
  return sensitive.otherTools === 'allow' && sensitive.filesWrite === 'allow' && sensitive.localExecution === 'allow' ? 'full' : 'ask'
}

/** One agl session per Douchat session key; the name lets agl reuse it after Douchat restarts. */
export function aglSessionName(config: AgentConfig, sessionKey: string): string {
  return `douchat-${createHash('sha256').update(JSON.stringify([config.ownerId ?? '', config.id, sessionKey])).digest('hex').slice(0, 24)}`
}

interface AglSession {
  sessionId: string
  agentId: string
  machineId: string
  agent: string
  access: AglAccess
  /** The highest event seq this computer has read for the session. */
  lastSeq: number
}

interface ActiveRun { agentId: string; sessionKey?: string; abort: AbortController }

const STOPPED = 'Stopped'
const NO_SESSION = /no session/i
const stopped = (signal: AbortSignal): Error => signal.reason instanceof Error ? signal.reason : new Error(STOPPED)
const field = (value: unknown, max = 200): string => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** A one-line description of a tool call for progress. */
function toolDetail(event: AglEventEnvelope['event']): string {
  const name = field(event.name, 60) || 'tool'
  const input = event.input && typeof event.input === 'object' ? event.input as Record<string, unknown> : {}
  const subject = field(input.command ?? input.cmd ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description, 120)
  return subject ? `${name}: ${subject}` : name
}

/**
 * Runs Douchat turns on an agl device through the Douchat service (contract
 * §3): one agl session per session key, `session.prompt`, then `agl-events`
 * until `turn_ended` for this turn. Never runs anything on this computer.
 */
export class AglExecutor implements AgentExecutor {
  private readonly sessions = new Map<string, AglSession>()
  private readonly creating = new Map<string, Promise<AglSession>>()
  private readonly active = new Set<ActiveRun>()
  constructor(private readonly options: AglExecutorOptions) {}

  /** Whether this agent runs through agl. */
  async handles(config: AgentConfig, options: LocalRunOptions = {}): Promise<boolean> {
    return Boolean(await this.options.resolve(config, options))
  }

  async run(config: AgentConfig, prompt: string, signal?: AbortSignal, _images: LocalAgentImage[] = [], options: LocalRunOptions = {}): Promise<LocalAgentReply> {
    // Images and files are not sent to devices in v1; the Devices page says so.
    const target = await this.options.resolve(config, options)
    if (!target) throw new Error('This agent does not run on a device.')
    const run: ActiveRun = { agentId: config.id, sessionKey: options.sessionKey, abort: new AbortController() }
    this.active.add(run)
    const combined = signal ? AbortSignal.any([signal, run.abort.signal]) : run.abort.signal
    const started = Date.now()
    const state: { phase: LocalProgress['phase']; detail?: string; lastEvent: number; approvals: number } = { phase: 'connecting', lastEvent: started, approvals: 0 }
    const report = (): void => {
      if (combined.aborted) return
      const now = Date.now()
      options.onProgress?.({ phase: state.approvals ? 'approval' : state.phase, elapsedSeconds: Math.floor((now - started) / 1000),
        silentSeconds: Math.floor((now - state.lastEvent) / 1000), ...(state.detail ? { detail: state.detail } : {}) })
    }
    report()
    const timer = setInterval(report, this.options.progressIntervalMs ?? 1_000)
    timer.unref?.()
    // A transient turn (connection test, internal planning) keeps no session behind.
    const sessionKey = options.sessionKey && !options.transient ? options.sessionKey : `transient:${randomUUID()}`
    let session: AglSession | undefined
    let aborted = false
    const onAbort = (): void => {
      if (aborted || !session) return
      aborted = true
      // Not tied to the turn's signal: it has just been aborted.
      void this.options.hub.call(target.machineId, 'session.abort', { session_id: session.sessionId }, AbortSignal.timeout(20_000)).catch(() => undefined)
    }
    combined.addEventListener('abort', onAbort, { once: true })
    try {
      let fresh: boolean
      ;({ session, fresh } = await this.session(config, target, sessionKey, combined))
      combined.throwIfAborted()
      const turnId = `douchat-${randomUUID()}`
      try {
        await this.options.hub.call(target.machineId, 'session.prompt', { session_id: session.sessionId, text: fresh ? prompt : options.continuationPrompt ?? prompt, turn_id: turnId }, combined)
      } catch (error) {
        // The device closed the session (or forgot it): start a new one with the whole context.
        if (fresh || combined.aborted || !NO_SESSION.test(error instanceof Error ? error.message : String(error))) throw error
        this.forget(sessionKey)
        ;({ session } = await this.session(config, target, sessionKey, combined))
        await this.options.hub.call(target.machineId, 'session.prompt', { session_id: session.sessionId, text: prompt, turn_id: turnId }, combined)
      }
      state.phase = 'waiting'; state.lastEvent = Date.now(); report()
      const text = await this.follow(session, target, turnId, combined, state, report, options)
      return { text, images: [] }
    } catch (error) {
      if (combined.aborted) { onAbort(); throw stopped(combined) }
      throw error
    } finally {
      clearInterval(timer)
      combined.removeEventListener('abort', onAbort)
      this.active.delete(run)
      if (sessionKey.startsWith('transient:') && session) {
        this.sessions.delete(sessionKey)
        void this.options.hub.call(target.machineId, 'session.close', { session_id: session.sessionId }, AbortSignal.timeout(20_000)).catch(() => undefined)
      }
    }
  }

  /** The session for a key: reused while it is on the same device and agent, created otherwise. */
  private async session(config: AgentConfig, target: AglTarget, sessionKey: string, signal: AbortSignal): Promise<{ session: AglSession; fresh: boolean }> {
    const access = aglAccess(config)
    const existing = this.sessions.get(sessionKey)
    if (existing && existing.agentId === config.id && existing.machineId === target.machineId && existing.agent === target.agent) {
      if (existing.access !== access) {
        // Permissions changed: agl restarts the agent with the new access and keeps the conversation.
        await this.options.hub.call(target.machineId, 'session.configure', { session_id: existing.sessionId, access }, signal)
        existing.access = access
      }
      return { session: existing, fresh: false }
    }
    if (existing) this.sessions.delete(sessionKey)
    const pending = this.creating.get(sessionKey)
    if (pending) return { session: await pending, fresh: false }
    const work = (async () => {
      const meta = await this.options.hub.call<{ id?: unknown; turns?: unknown }>(target.machineId, 'session.create', {
        agent: target.agent, access, name: aglSessionName(config, sessionKey)
      }, signal)
      if (!meta || typeof meta.id !== 'string' || !meta.id) throw new Error('The device did not start a session.')
      const created: AglSession = { sessionId: meta.id, agentId: config.id, machineId: target.machineId, agent: target.agent, access, lastSeq: 0 }
      this.sessions.set(sessionKey, created)
      return { session: created, resumed: typeof meta.turns === 'number' && meta.turns > 0 }
    })()
    const shared = work.then(result => result.session)
    shared.catch(() => undefined)
    this.creating.set(sessionKey, shared)
    try {
      const { session, resumed } = await work
      // A session agl kept under the same name (after Douchat restarted) already has the conversation.
      return { session, fresh: !resumed }
    } finally { if (this.creating.get(sessionKey) === shared) this.creating.delete(sessionKey) }
  }

  /** Reads the session's events until this turn ends. */
  private async follow(session: AglSession, target: AglTarget, turnId: string, signal: AbortSignal,
    state: { phase: LocalProgress['phase']; detail?: string; lastEvent: number; approvals: number }, report: () => void, options: LocalRunOptions): Promise<string> {
    const parts: string[] = []
    let commentary = ''
    let inTurn = false
    let cursor = session.lastSeq
    const approvals = new Map<string, AbortController>()
    try {
      for (;;) {
        signal.throwIfAborted()
        const { events, lastSeq } = await this.options.hub.events(target.machineId, session.sessionId, cursor, signal)
        for (const envelope of [...events].sort((a, b) => a.seq - b.seq)) {
          // The service may redeliver; a seq already read is never applied twice.
          if (envelope.seq <= cursor) continue
          cursor = envelope.seq
          const event = envelope.event
          if (event.kind !== 'heartbeat') state.lastEvent = Date.now()
          const ours = event.turn_id === turnId
          switch (event.kind) {
            case 'queued':
              if (ours) { state.phase = 'waiting'; state.detail = `Queued on ${target.label}` }
              break
            case 'turn_started':
              inTurn = ours
              if (ours) { state.phase = 'working'; state.detail = undefined }
              break
            case 'text_delta': {
              if (!inTurn || typeof event.text !== 'string') break
              if (event.phase === 'commentary') {
                // An interim update while the agent keeps working: progress, not the answer.
                commentary = (commentary + event.text).slice(-2_000)
                const line = commentary.split(/\n+/).map(item => item.trim()).filter(Boolean).pop()
                if (line) state.detail = line.slice(0, 200)
              } else parts.push(event.text)
              break
            }
            case 'reasoning':
              if (inTurn && !state.detail) state.detail = 'Thinking'
              break
            case 'tool_start':
              if (inTurn) state.detail = toolDetail(event)
              break
            case 'retrying':
              if (inTurn) state.detail = field(event.message) || 'Retrying'
              break
            case 'permission_request': {
              const requestId = typeof event.request_id === 'string' ? event.request_id : ''
              // decided_by: agl answered it itself (policy or allow_session); only a log line.
              if (!requestId || event.decided_by || approvals.has(requestId)) break
              void this.approve(session, target, event, requestId, approvals, signal, state, report, options)
              break
            }
            case 'permission_resolved': {
              const requestId = typeof event.request_id === 'string' ? event.request_id : ''
              // Answered elsewhere, timed out or cancelled: stop asking here.
              if (event.by !== 'client') approvals.get(requestId)?.abort()
              break
            }
            case 'turn_ended': {
              if (!ours) { inTurn = false; break }
              session.lastSeq = Math.max(session.lastSeq, cursor)
              if (event.outcome === 'completed') return parts.join('').trim()
              if (event.outcome === 'aborted') {
                signal.throwIfAborted()
                throw new Error(`The turn was stopped on ${target.label}.`)
              }
              throw new Error(field(event.error, 600) || `The agent on ${target.label} could not finish this turn.`)
            }
          }
        }
        cursor = Math.max(cursor, lastSeq)
        session.lastSeq = Math.max(session.lastSeq, cursor)
        report()
      }
    } finally {
      for (const controller of approvals.values()) controller.abort()
    }
  }

  private async approve(session: AglSession, target: AglTarget, event: AglEventEnvelope['event'], requestId: string, approvals: Map<string, AbortController>,
    signal: AbortSignal, state: { approvals: number }, report: () => void, options: LocalRunOptions): Promise<void> {
    const controller = new AbortController()
    approvals.set(requestId, controller)
    state.approvals++; report()
    let decision: 'allow' | 'deny' = 'deny'
    try {
      if (options.onApproval) {
        const title = field(event.title) || field(event.tool, 80) || 'Permission request'
        await options.onApproval({ message: `${target.agent}: ${title}`, details: JSON.stringify({ tool: event.tool, title: event.title, input: event.input }, null, 2) },
          AbortSignal.any([controller.signal, signal]))
        decision = 'allow'
      }
    } catch { /* Denied, expired or cancelled: never grants access. */ }
    finally { state.approvals--; approvals.delete(requestId); report() }
    if (controller.signal.aborted || signal.aborted) return
    await this.options.hub.call(target.machineId, 'session.approve', { session_id: session.sessionId, request_id: requestId, decision }, signal).catch(() => undefined)
  }

  private forget(sessionKey: string): void { this.sessions.delete(sessionKey) }

  releaseIdleConnections(): void { /* Device sessions hold no process on this computer. */ }

  disposeAgent(agentId: string): void {
    for (const run of this.active) if (run.agentId === agentId) run.abort.abort(new Error(STOPPED))
    // Settings changed: the next turn starts a session with the new ones.
    for (const [key, session] of this.sessions) if (session.agentId === agentId) this.sessions.delete(key)
  }

  resetConversation(conversationId: string, topicId?: string, directAgentIds: string[] = []): void {
    const matches = conversationMatcher(conversationId, topicId, directAgentIds)
    for (const run of this.active) if (run.sessionKey && matches(run.sessionKey)) run.abort.abort(new Error(STOPPED))
    for (const [key, session] of this.sessions) {
      if (!matches(key)) continue
      this.sessions.delete(key)
      void this.options.hub.call(session.machineId, 'session.close', { session_id: session.sessionId }, AbortSignal.timeout(20_000)).catch(() => undefined)
    }
  }
}

/**
 * Sends agents bound to an agl device to the agl executor, and everything else
 * to the local desktop executor, unchanged.
 */
export function routingExecutor(local: AgentExecutor, agl: AglExecutor): AgentExecutor {
  return {
    run: async (config, prompt, signal, images, options = {}) => await agl.handles(config, options)
      ? agl.run(config, prompt, signal, images, options)
      : local.run(config, prompt, signal, images, options),
    prepare: local.prepare ? async (config, options) => { if (!await agl.handles(config, options).catch(() => false)) await local.prepare!(config, options) } : undefined,
    releaseIdleConnections: (...args) => { local.releaseIdleConnections?.(...args); agl.releaseIdleConnections() },
    disposeAgent: (agentId) => { local.disposeAgent(agentId); agl.disposeAgent(agentId) },
    resetConversation: (conversationId, topicId, directAgentIds, ownerId) => {
      local.resetConversation(conversationId, topicId, directAgentIds, ownerId)
      agl.resetConversation(conversationId, topicId, directAgentIds)
    }
  }
}
