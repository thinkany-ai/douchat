import type { LocalProgress, ProgressListener, LocalToolApproval, LocalApprovalHandler } from '../shared/agentExecutor'
export type { LocalProgress, ProgressListener, LocalToolApproval, LocalApprovalHandler } from '../shared/agentExecutor'
import { appendLocalAgentArguments } from '../shared/localAgentArguments'
import { localModelId, withLocalModel } from '../shared/localModels'
import { clampThinking, localThinkingLevels, withLocalThinking, type ThinkingLevel } from '../shared/thinkingLevels'
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process'
import { executableCommand } from './windowsCommand'
import { randomUUID } from 'node:crypto'
import { COMPUTER_USE_SERVERS, codexComputerUseInstructions, codexComputerUseInventory } from './codexComputerUse'
import { timedRemote } from './diagnostics'

/** Process launch description (local executable or the system ssh client). */
export interface LaunchSpec { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }
/** Starts the agent for its protocol arguments on another host; `cwd` is on that host. */
export interface RemoteConnectionLaunch { cwd: string; spawn: (agentArgs: string[]) => Promise<ChildProcessWithoutNullStreams> }

const ownedProcesses = new Set<ChildProcessWithoutNullStreams>()

/** Every CLI Douchat starts runs in its own process group and is tracked until it
 * closes, so quitting can reap whatever a dispose path missed. */
export function spawnOwnedProcess(file: string, args: string[], options: Omit<SpawnOptions, 'detached' | 'stdio'>): ChildProcessWithoutNullStreams {
  const child = spawn(file, args, { ...options, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
  ownedProcesses.add(child)
  child.once('close', () => ownedProcesses.delete(child))
  child.once('error', () => { if (!child.pid) ownedProcesses.delete(child) })
  return child
}

/** Last line of defense on quit: kill every owned process group still alive. */
export function killAllLocalProcesses(): void {
  for (const child of ownedProcesses) killLocalProcess(child)
}

/** Marks a stand-in for a process (a douchat-host relay stream): no pid, killed through kill(). */
export const VIRTUAL_PROCESS = Symbol.for('douchat.virtualProcess')
const isVirtual = (child: ChildProcessWithoutNullStreams): boolean => Boolean((child as unknown as Record<symbol, unknown>)[VIRTUAL_PROCESS])

/** Kill the owned process group, including CLI tools and MCP children. */
export function killLocalProcess(child: ChildProcessWithoutNullStreams): void {
  if (isVirtual(child)) { child.kill('SIGKILL'); return }
  if (!child.pid) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
    else {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('error', () => { child.kill('SIGKILL') })
      killer.once('exit', (code) => { if (code) child.kill('SIGKILL') })
    }
  } catch { /* Already exited. */ }
}

/** Let an idle CLI shut down its MCP servers (browsers, file locks) itself:
 * closing stdin ends Codex and Claude cleanly. Escalate if it doesn't exit, and
 * sweep the group afterwards for children that outlived the CLI. */
export function stopLocalProcess(child: ChildProcessWithoutNullStreams, graceMs = 2_000): void {
  if (isVirtual(child)) {
    if (child.exitCode !== null || child.signalCode !== null) return
    const force = setTimeout(() => killLocalProcess(child), graceMs * 2)
    child.once('exit', () => clearTimeout(force))
    try { child.stdin.end() } catch { killLocalProcess(child) }
    return
  }
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) { killLocalProcess(child); return }
  const terminate = setTimeout(() => {
    try { if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGTERM') } catch { /* Already exited. */ }
  }, graceMs)
  const force = setTimeout(() => killLocalProcess(child), graceMs * 2)
  child.once('exit', () => { clearTimeout(terminate); clearTimeout(force); killLocalProcess(child) })
  try { child.stdin.end() } catch { killLocalProcess(child) }
}

type Packet = Record<string, any>
const UNVERIFIED_COMPUTER_USE = 'Douchat could not verify the native Computer Use inventory for this session. This does not prove the tools are absent. Inspect your exposed tools and report any actual tool failure precisely.'
/** After the CLI reports it is retrying the model, this long without any new
 * model output is treated as a dead model provider. Plain silence (no retry
 * reported) stays alive: long tasks may legitimately say nothing for minutes. */
export const MODEL_STALL_MS = 120_000
export const MODEL_RETRY_DETAIL = 'Model service is not responding; retrying'
export const MODEL_STALL_LOCAL = 'The model service did not respond. Check the CLI model provider and network on this computer, then try again.'
export const MODEL_STALL_REMOTE = 'The model service did not respond. Check the CLI model provider and network on the remote server, then try again.'
/** Codex notifications that mean the model itself produced output. */
function codexModelOutput(packet: Packet): boolean {
  const method = String(packet.method ?? '')
  if (method === 'item/started' || method === 'item/completed') return packet.params?.item?.type !== 'userMessage'
  return /delta$/i.test(method) || method === 'thread/tokenUsage/updated' || method === 'turn/plan/updated'
}
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

/** One private stdio connection per Douchat conversation/topic/agent. No TCP listener. */
export class LocalAgentConnection {
  private child!: ChildProcessWithoutNullStreams
  private pending = new Map<number, Pending>()
  private sequence = 0
  private buffer = ''
  private stderr = ''
  private threadId?: string
  private listener?: (packet: Packet) => void
  private failTurn?: (error: Error) => void
  private failure?: Error
  private turnCount = 0
  private computerInventory?: { at: number; context: Promise<string> }
  private turnActivity = false
  private turnInProgress = false
  private readonly nativeSessionId = randomUUID()
  private readonly nativeSessionLifetime = new AbortController()
  private lastEvent = Date.now()
  private approvalHandler?: LocalApprovalHandler
  private activeTurnId?: string
  private approvals = new Map<string | number, AbortController>()
  private readonly closedPromise: Promise<void>
  private resolveClosed!: () => void

  constructor(private readonly kind: 'codex' | 'claude') {
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve })
  }
  get alive(): boolean { return !this.failure }
  get canRetryAuthentication(): boolean { return !this.turnActivity }
  get hasHistory(): boolean { return this.turnCount > 0 }
  get thread(): string | undefined { return this.threadId }

  /** Remote launches reuse the exact protocol; only process placement differs. */
  private remote = false

  async connect(path: string, cwd: string, env: NodeJS.ProcessEnv, model?: string, discoveryOnly = false, resume?: { thread?: string; remember: (thread?: string) => void }, toolApprovals = false, extraArgs: string[] = [], thinking?: ThinkingLevel, remote?: RemoteConnectionLaunch): Promise<void> {
    const command = remote ? undefined : await executableCommand(path)
    if (this.failure) throw this.failure
    const args = this.kind === 'codex'
      ? ['app-server']
      : ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...(resume ? resume.thread ? ['--resume', resume.thread] : [] : ['--no-session-persistence']), '--allowedTools', 'WebSearch,WebFetch', ...(toolApprovals ? ['--permission-prompt-tool', 'stdio'] : ['--permission-mode', 'dontAsk'])]
    this.rememberThread = resume?.remember
    if (this.kind === 'claude' && resume?.thread) { this.threadId = resume.thread; this.turnCount = 1 }
    const agentArgs = appendLocalAgentArguments(this.kind === 'claude' ? withLocalModel('claude', withLocalThinking('claude', args, thinking), model) : args, extraArgs)
    this.remote = Boolean(remote)
    // Local: this process spawns the CLI. Remote: the transport's factory does, and owns its ssh process.
    if (this.failure) throw this.failure
    const child = remote ? await timedRemote('protocol.spawn', { adapter: this.kind }, () => remote.spawn(agentArgs)) : spawnOwnedProcess(command!.file, [...command!.prefix, ...agentArgs], { cwd, env, windowsHide: true, shell: false })
    if (this.failure) { killLocalProcess(child); throw this.failure }
    if (remote) cwd = remote.cwd
    this.child = child
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.read(chunk))
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-1600) })
    this.child.stdin.on('error', (error) => this.close(error))
    this.child.once('error', (error) => this.close(error))
    this.child.once('exit', (code) => this.close(new Error(`Local agent disconnected (${code ?? 'signal'}). ${this.stderr}`)))
    this.child.once('close', (code) => {
      this.close(new Error(`Local agent disconnected (${code ?? 'signal'}). ${this.stderr}`))
      this.resolveClosed()
    })
    if (this.kind === 'claude' && toolApprovals) await this.request('initialize', { hooks: null }, true)
    if (this.kind === 'codex') {
      const initialize = () => this.request('initialize', { clientInfo: { name: 'douchat', version: '1.0.0' }, capabilities: { experimentalApi: true } })
      if (remote) await timedRemote('protocol.initialize', { adapter: this.kind }, initialize)
      else await initialize()
      this.write({ method: 'initialized' })
      if (discoveryOnly) return
      const params = {
        ...(localModelId(model) ? { model: localModelId(model) } : {}),
        cwd, approvalPolicy: toolApprovals
          ? { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: true } }
          : 'never', sandbox: 'workspace-write',
        config: { 'sandbox_workspace_write.network_access': true, web_search: 'live',
          ...(thinking ? { model_reasoning_effort: clampThinking(thinking, localThinkingLevels('codex')) } : {}) },
        ...(toolApprovals && !this.remote ? { developerInstructions: codexComputerUseInstructions } : {})
      }
      let response: any
      if (resume?.thread) {
        try {
          const resumeThread = () => this.request('thread/resume', { ...params, threadId: resume.thread })
          response = remote ? await timedRemote('protocol.thread-resume', { adapter: this.kind }, resumeThread) : await resumeThread()
          this.turnCount = response.thread?.turns?.length ? 1 : 0
        } catch (error) {
          if (!/not found|no rollout|does not exist|already has an active writer/i.test(String(error))) throw error
          resume.remember(undefined)
        }
      }
      if (!response) {
        const startThread = () => this.request('thread/start', { ...params, ephemeral: !resume })
        response = remote ? await timedRemote('protocol.thread-start', { adapter: this.kind }, startThread) : await startThread()
      }
      if (typeof response.thread?.id !== 'string') throw new Error('Codex did not return a thread ID')
      this.threadId = response.thread.id
      resume?.remember(this.threadId)
      if (toolApprovals && !this.remote) void this.computerUseContext()
    }
  }

  private rememberThread?: (thread?: string) => void

  private async approveComputerUse(packet: Packet): Promise<void> {
    if (this.approvals.has(packet.id)) { this.close(new Error('Duplicate local agent approval request')); return }
    const p = packet.params ?? {}
    const schema = p.requestedSchema
    // Only the observed native Computer Use confirmation contract is supported.
    // Forms requiring input, URL flows and verification challenges need their own UI.
    const supported = ['cua_repl', 'computer-use', 'computer_use'].includes(p.serverName)
      && ['form', 'openai/form', 'openaiForm'].includes(p.mode)
      && p._meta?.connector_id === 'computer-use' && p._meta?.codex_approval_kind === 'mcp_tool_call'
      && schema?.type === 'object' && schema.properties && typeof schema.properties === 'object'
      && !Array.isArray(schema.properties) && Object.keys(schema.properties).length === 0
      && (!schema.required || (Array.isArray(schema.required) && schema.required.length === 0))
      && typeof p.message === 'string' && p.message.trim() && p.message.length <= 4000
      && p.threadId === this.threadId && p.turnId === this.activeTurnId && this.activeTurnId
    const handler = this.approvalHandler
    if (!supported || !handler) {
      this.write({ id: packet.id, result: { action: 'decline', content: null, _meta: null } })
      return
    }
    const abort = new AbortController()
    this.approvals.set(packet.id, abort)
    let allowed = false
    try {
      const meta = p._meta
      const appId = meta.tool_params?.app
      const reusable = Array.isArray(meta.persist) && meta.persist.includes('session')
        // The native plugin asks for app access before each GUI action (including click/type).
        // Reuse the app grant, not a particular tool name. Explicit action confirmations stay separate.
        && meta.riskLevel === 'low' && !meta.codex_request_type
        && typeof meta.tool_name === 'string' && meta.tool_name.length > 0
        && meta.tool_params && Object.keys(meta.tool_params).length === 1
        && typeof appId === 'string' && /^[\w.-]{1,255}$/.test(appId)
      const display = Array.isArray(meta.tool_params_display) ? meta.tool_params_display.find((v: any) => v?.name === 'app')?.value : undefined
      const appName = typeof display === 'string' && display.length <= 200 ? display : appId
      await handler({ message: p.message, details: JSON.stringify({ tool: meta.tool_name, arguments: meta.tool_params ?? {} }, null, 2),
        ...(reusable ? { nativeSession: { id: this.nativeSessionId, appId, appName, signal: this.nativeSessionLifetime.signal } } : {})
      }, abort.signal)
      allowed = true
    } catch { /* Denial, expiry and cancellation never grant access. */ }
    if (!abort.signal.aborted && !this.failure) {
      this.write({ id: packet.id, result: { action: allowed ? 'accept' : 'decline', content: allowed ? {} : null, _meta: null } })
    }
    if (this.approvals.get(packet.id) === abort) this.approvals.delete(packet.id)
  }

  private async approveClaudeTool(packet: Packet): Promise<void> {
    this.turnActivity = true
    const id = packet.request_id
    const request = packet.request
    if (typeof id !== 'string' || !id || this.approvals.has(id)) {
      this.close(new Error('Invalid or duplicate Claude approval request')); return
    }
    const respond = (response: Packet) => this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
    const handler = this.approvalHandler
    if (!this.listener || !handler || request?.subtype !== 'can_use_tool'
      || typeof request.tool_name !== 'string' || !request.tool_name.trim()
      || !request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
      respond({ behavior: 'deny', message: 'No active owner approval handler for this request.' }); return
    }
    const abort = new AbortController()
    this.approvals.set(id, abort)
    let allowed = false
    try {
      await handler({ message: `Claude: ${request.tool_name}`, details: JSON.stringify({
        tool: request.tool_name, input: request.input,
        ...(typeof request.blocked_path === 'string' ? { blockedPath: request.blocked_path } : {})
      }, null, 2) }, abort.signal)
      allowed = true
    } catch { /* Denial, expiry and cancellation do not grant access. */ }
    if (!abort.signal.aborted && !this.failure) respond(allowed
      ? { behavior: 'allow', updatedInput: request.input }
      : { behavior: 'deny', message: 'The owner denied or cancelled this operation.' })
    if (this.approvals.get(id) === abort) this.approvals.delete(id)
  }

  private cancelApprovals(): void {
    for (const abort of this.approvals.values()) abort.abort()
    this.approvals.clear()
  }

  async models(): Promise<Array<{ id: string; name: string }>> {
    if (this.kind === 'claude') {
      const result = await this.request('initialize', {}, true)
      return (result.models ?? []).filter((item: any) => typeof item.value === 'string' && item.value !== 'default').map((item: any) => ({ id: item.value, name: item.displayName || item.value }))
    }
    const models: Array<{ id: string; name: string }> = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await this.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) })
      for (const item of result.data ?? []) {
        const id = item.model ?? item.id
        if (typeof id === 'string') models.push({ id, name: item.displayName || id })
      }
      if (!result.nextCursor || result.nextCursor === cursor) break
      cursor = result.nextCursor
    }
    return models
  }

  private write(packet: Packet): void {
    if (this.failure) throw this.failure
    this.child.stdin.write(`${JSON.stringify(packet)}\n`)
  }
  private request(method: string, params: Packet, control = false, softTimeoutMs?: number): Promise<any> {
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        if (softTimeoutMs) { this.pending.delete(id); reject(new Error('Native tool discovery timed out')) }
        else this.close(new Error(`Local agent did not acknowledge ${method} within 60 seconds`))
      }, softTimeoutMs ?? 60_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write(control ? { type: 'control_request', request_id: String(id), request: { subtype: method, ...params } } : { id, method, params }) } catch (error) { this.close(error as Error) }
    })
  }
  private read(chunk: string): void {
    if (this.failure) return
    this.buffer += chunk
    // Image tool results can contain multiple base64 images (about 4/3 of
    // their binary size). Bound each JSON frame, not a batch of stdout frames.
    const maxFrameBytes = 64 * 1024 * 1024
    let newline: number
    while (!this.failure && (newline = this.buffer.indexOf('\n')) >= 0) {
      if (Buffer.byteLength(this.buffer.slice(0, newline), 'utf8') > maxFrameBytes) { this.close(new Error('Local agent protocol frame exceeds 64 MB')); return }
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let packet: Packet
      try { packet = JSON.parse(line) } catch { this.close(new Error('Invalid local agent protocol response')); return }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) { this.close(new Error('Invalid local agent protocol packet')); return }
      this.lastEvent = Date.now()
      if (packet.type === 'control_response') {
        const id = Number(packet.response?.request_id)
        const pending = this.pending.get(id)
        if (pending) {
          clearTimeout(pending.timer); this.pending.delete(id)
          if (packet.response.subtype === 'error') pending.reject(new Error(packet.response.error || 'Model discovery failed'))
          else pending.resolve(packet.response.response)
        }
      } else if (packet.id !== undefined && !packet.method) {
        const pending = this.pending.get(packet.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(packet.id)
          if (packet.error) pending.reject(new Error(packet.error.message || 'Local agent request failed'))
          else pending.resolve(packet.result)
        }
      } else if (packet.id !== undefined && packet.method) {
        if (packet.method === 'mcpServer/elicitation/request') void this.approveComputerUse(packet).catch(error => this.close(error))
        else this.write({ id: packet.id, error: { code: -32601, message: 'Interactive requests are not supported in Douchat.' } })
      } else if (packet.type === 'control_cancel_request') {
        this.approvals.get(packet.request_id)?.abort()
        this.approvals.delete(packet.request_id)
      } else if (packet.type === 'control_request' && this.kind === 'claude' && packet.request?.subtype === 'can_use_tool') {
        void this.approveClaudeTool(packet).catch(error => this.close(error))
      } else if (packet.type === 'control_request') {
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: packet.request_id, error: 'Interactive requests are not supported in Douchat' } })
      } else {
        if (packet.method === 'serverRequest/resolved') {
          const id = packet.params?.requestId
          this.approvals.get(id)?.abort()
          this.approvals.delete(id)
        }
        if (packet.params?.threadId === this.threadId) {
          if (packet.method === 'turn/started') this.activeTurnId = packet.params.turn?.id
          if (packet.method === 'turn/completed') { this.activeTurnId = undefined; this.cancelApprovals() }
        }
        this.listener?.(packet)
      }
    }
    if (!this.failure && Buffer.byteLength(this.buffer, 'utf8') > maxFrameBytes) this.close(new Error('Local agent protocol frame exceeds 64 MB'))
  }

  /** What the model should know about native Computer Use, checked once per
   * session (re-checked after 5 minutes, or next turn if it couldn't be verified).
   * Started when the session connects, so a warmed session already has it. */
  private computerUseContext(): Promise<string> {
    if (this.computerInventory && Date.now() - this.computerInventory.at < 5 * 60_000) return this.computerInventory.context
    const entry = { at: Date.now(), context: this.loadComputerUseInventory().catch(() => UNVERIFIED_COMPUTER_USE) }
    this.computerInventory = entry
    void entry.context.then(text => { if (text === UNVERIFIED_COMPUTER_USE && this.computerInventory === entry) this.computerInventory = undefined })
    return entry.context
  }

  /** Ask only for the Computer Use servers, tools and auth only: the full
   * inventory lists every app connector (hundreds of tools) and took 5-9 s,
   * longer than the timeout, so each turn waited and then gave up. */
  private async loadComputerUseInventory(): Promise<string> {
    const query = async (serverName: string): Promise<unknown[]> => {
      const result = await this.request('mcpServerStatus/list', { threadId: this.threadId, limit: 100, serverName, detail: 'toolsAndAuthOnly' }, false, 5_000)
      if (!Array.isArray(result?.data)) throw new Error('Invalid native tool inventory')
      return result.data
    }
    const [primary, ...legacy] = COMPUTER_USE_SERVERS
    const first = await query(primary)
    // An older Codex ignores the filter and already returned every server.
    if (first.some(server => !COMPUTER_USE_SERVERS.includes(String((server as Packet)?.name)))) return codexComputerUseInventory(first)
    return codexComputerUseInventory([...first, ...(await Promise.all(legacy.map(query))).flat()])
  }

  async turn(prompt: string, signal: AbortSignal | undefined, progress?: ProgressListener, onApproval?: LocalApprovalHandler): Promise<string> {
    signal?.throwIfAborted()
    if (this.failure) throw this.failure
    if (this.turnInProgress) throw new Error('This local agent session is already working')
    this.turnInProgress = true
    this.turnActivity = false
    const started = Date.now()
    this.lastEvent = started
    let detail: string | undefined
    let waitingApproval = false
    let lastReport = 0
    let modelSeenAt = started
    let retrying = false
    const report = (): void => {
      if (Date.now() - lastReport < 1_000) return
      lastReport = Date.now()
      progress?.({ phase: waitingApproval ? 'approval' : retrying ? 'waiting' : detail ? 'working' : 'waiting', elapsedSeconds: Math.floor((Date.now() - started) / 1000), silentSeconds: Math.floor((Date.now() - (retrying ? modelSeenAt : this.lastEvent)) / 1000), detail: retrying ? MODEL_RETRY_DETAIL : detail })
    }
    const modelOutput = (): void => {
      modelSeenAt = Date.now()
      if (retrying) { retrying = false; lastReport = 0 }
    }
    const modelRetry = (): void => {
      if (!retrying) { retrying = true; lastReport = 0 }
      report()
    }
    this.approvalHandler = onApproval ? async (request, approvalSignal) => {
      waitingApproval = true; lastReport = 0; report()
      try { await onApproval(request, approvalSignal) }
      finally { waitingApproval = false; modelSeenAt = Date.now(); lastReport = 0; report() }
    } : undefined
    const watchdog = (): void => {
      if (!waitingApproval && retrying && Date.now() - modelSeenAt >= MODEL_STALL_MS) {
        this.close(new Error(this.remote ? MODEL_STALL_REMOTE : MODEL_STALL_LOCAL))
        return
      }
      report()
    }
    const heartbeat = setInterval(watchdog, 15_000)
    const abort = (): void => this.close(new Error('Stopped'))
    signal?.addEventListener('abort', abort, { once: true })
    try {
      let computerContext = ''
      if (this.kind === 'codex' && onApproval && !this.remote) {
        computerContext = await this.computerUseContext()
        signal?.throwIfAborted()
      }
      return await new Promise<string>((resolve, reject) => {
        let finalText = ''
        let commentary = ''
        this.failTurn = reject
        this.listener = (packet) => {
          if (this.kind === 'claude') {
            if (packet.type === 'system' && packet.subtype === 'api_retry') modelRetry()
            if (packet.type === 'stream_event' || packet.type === 'user' || (packet.type === 'assistant' && !packet.error && !packet.message?.error)) modelOutput()
            if (packet.type === 'system' && packet.subtype === 'init' && typeof packet.session_id === 'string') { this.threadId = packet.session_id; this.rememberThread?.(this.threadId) }
            if (packet.type === 'system' && packet.subtype === 'init') progress?.({ phase: 'ready', elapsedSeconds: 0, silentSeconds: 0 })
            if (packet.type === 'stream_event' && ['content_block_start', 'content_block_delta'].includes(packet.event?.type)) {
              this.turnActivity = true
              const block = packet.event.content_block
              if (block?.type === 'tool_use') detail = `Tool: ${block.name}`
              else if (block?.type === 'text' || packet.event.delta?.type === 'text_delta') detail = 'Generating response content'
              // Do not expose partial tool arguments, credentials, or reasoning text.
              report()
            }
            if (packet.type === 'assistant') {
              // API errors can be represented as assistant text; they are not model work.
              if (!packet.error && !packet.message?.error) this.turnActivity = true
              for (const item of packet.message?.content ?? []) {
                if (item.type === 'text') detail = String(item.text).slice(-500)
                if (item.type === 'tool_use') detail = `Tool: ${item.name}`
              }
              report()
            }
            if (packet.type === 'result') {
              if (packet.is_error) reject(new Error(packet.result || packet.errors?.join('\n') || 'Claude failed'))
              else { this.turnCount++; resolve(String(packet.result ?? '')) }
            }
            return
          }
          const params = packet.params ?? {}
          if (params.threadId && params.threadId !== this.threadId) return
          if (packet.method === 'error' && params.willRetry) modelRetry()
          if (codexModelOutput(packet)) modelOutput()
          if (packet.method === 'item/completed' || packet.method === 'item/started') {
            const item = params.item ?? {}
            if (item.type === 'agentMessage' && packet.method === 'item/completed') {
              if (item.phase === 'commentary') commentary = String(item.text ?? '')
              else finalText = String(item.text ?? '')
              detail = String(item.text ?? '').slice(-500)
            } else if (item.type !== 'reasoning' && item.type !== 'userMessage') {
              const labels: Record<string, string> = {
                commandExecution: 'Running a command', fileChange: 'Updating files',
                webSearch: 'Searching the web', mcpToolCall: 'Using a connected tool',
                imageGeneration: 'Generating an image', plan: 'Planning the next steps',
                contextCompaction: 'Compacting conversation context'
              }
              detail = labels[item.type] || 'Working on the task'
            }
            report()
          }
          if (packet.method === 'turn/completed') {
            if (params.turn?.status !== 'completed') reject(new Error(params.turn?.error?.message || `Local agent ${params.turn?.status || 'failed'}`))
            else { this.turnCount++; resolve(finalText || commentary) }
          }
        }
        if (signal?.aborted) { abort(); return }
        progress?.({ phase: 'ready', elapsedSeconds: 0, silentSeconds: 0 })
        if (this.kind === 'codex') {
          void this.request('turn/start', { threadId: this.threadId, input: [
            { type: 'text', text: prompt, text_elements: [] },
            ...(computerContext ? [{ type: 'text', text: `Douchat native capability check:\n${computerContext}`, text_elements: [] }] : [])
          ] }).catch(reject)
        } else {
          try { this.write({ type: 'user', message: { role: 'user', content: prompt } }) } catch (error) { reject(error) }
        }
      })
    } finally {
      this.turnInProgress = false
      this.cancelApprovals()
      this.approvalHandler = undefined
      this.activeTurnId = undefined
      clearInterval(heartbeat)
      signal?.removeEventListener('abort', abort)
      this.listener = undefined
      this.failTurn = undefined
    }
  }

  /** `graceful` is for idle sessions being released; errors and Stop kill at once. */
  close(error = new Error('Local agent session closed'), graceful = false): void {
    if (this.failure) return
    this.failure = error
    this.nativeSessionLifetime.abort()
    this.cancelApprovals()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.failTurn?.(error)
    this.buffer = ''
    if (this.child) (graceful && !this.turnInProgress ? stopLocalProcess : killLocalProcess)(this.child)
    else this.resolveClosed()
  }
  async disposed(): Promise<void> { await this.closedPromise }
}
