import type { LocalAgentImage, LocalAgentReply, LocalRunOptions } from '../shared/agentExecutor'
export type { LocalAgentImage, LocalAgentReply, LocalRunOptions } from '../shared/agentExecutor'
import { appendLocalAgentArguments, customLocalAgentArguments } from '../shared/localAgentArguments'
import { localAgentSettingsVersion } from './localAgentSettingsVersion'
import { LocalProcessBudget } from './localProcessBudget'
import { withLocalModel } from '../shared/localModels'
import { withLocalThinking } from '../shared/thinkingLevels'
import { LocalAgentConnection, killAllLocalProcesses, killLocalProcess, spawnOwnedProcess } from './localAgentConnection'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { executableCommand } from './windowsCommand'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { AgentConfig, LocalAgent, MessageAttachment } from '../shared/types'
import { validateLocalAgent } from './localAgents'
import { spawnEnvironment } from './shellPath'
import { GrokStream } from './grokStream'
import { GeminiStream, geminiImagePolicy } from './geminiStream'
import { localWorkspace, resetLocalWorkspaces, type RemotePlacement } from './localWorkspaces'
import type { RemoteAgentSpec } from '../shared/types'
import { RemoteRun, outboxPrompt } from './remoteFileChannel'
import { assertArgvPrompt, remotePrompt } from './remoteTransport'
import { openSshTransport } from './remote/sshTransport'
import { recordTiming, timedRemote } from './diagnostics'
import { PROMPT_ARG, customRemoteArguments, markPromptArguments, type PromptChannel, type RemoteArg, type RemoteWorkspaceRef } from './remoteScript'
import { ATTACHMENT_LIMITS } from '../shared/attachments'

/** Optional locally built Grok with the macOS socket-denial compatibility patch.
 * Keep the official CLI untouched and retain strict sandbox arguments below. */
export async function localAgentExecutable(id: string, installedPath: string, platform = process.platform, home = homedir()): Promise<string> {
  if (id !== 'grok' || platform !== 'darwin') return installedPath
  const compatible = join(home, '.douchat', 'local-tools', 'grok', process.arch, 'grok')
  try {
    await access(compatible, constants.X_OK)
    return compatible
  } catch { return installedPath }
}

/** FastClaw keeps the conversation itself. Bind one FastClaw session to each
 * Douchat chat (stored like a native thread) so later turns send only the new
 * message; without --resume every turn opened a new session that repeated the
 * whole history and instructions. Clear chat drops the binding. */
export function fastclawTurn(workspace: ReturnType<typeof localWorkspace>, prompt: string, continuation?: string): { session?: string; prompt: string } {
  if (!workspace) return { prompt }
  const resumed = workspace.thread && /^douchat-[0-9a-f-]{36}$/.test(workspace.thread) ? workspace.thread : undefined
  return { session: resumed ?? `douchat-${randomUUID()}`, prompt: resumed ? continuation ?? prompt : prompt }
}

export function localAgentArgs(id: string, prompt: string, output: string, appOwnedWorkspace = false, session?: string): string[] {
  switch (id) {
    case 'codex': return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-c', 'web_search="live"', '--output-last-message', output, '-']
    case 'claude': return ['-p', '--output-format', 'json', '--allowedTools', 'WebSearch,WebFetch', '--', prompt]
    case 'gemini': return ['-p', prompt, '--output-format', 'stream-json']
    // Offer Grok only the tools it may run: in dontAsk mode a denied call (e.g.
    // run_terminal_command for "list my Downloads") ends the whole turn as
    // `cancelled` instead of letting the model try a permitted tool.
    case 'grok': return [
      '--no-auto-update', '-p', prompt, '--output-format', 'streaming-json',
      '--permission-mode', 'dontAsk',
      '--tools', 'read_file,list_dir,grep,web_search,web_fetch,image_gen,image_edit',
      '--disallowed-tools', 'search_tool,use_tool',
      '--allow', 'Read', '--allow', 'Grep', '--allow', 'WebFetch', '--allow', 'WebSearch',
      '--allow', 'image_gen', '--allow', 'image_edit',
      '--sandbox', 'strict'
    ]
    case 'cursor': return [...(appOwnedWorkspace ? ['--trust'] : []), '--print', '--output-format', 'json', '--mode', 'ask', '--', prompt]
    case 'opencode': return ['run', '--format', 'json', '--', prompt]
    case 'kimi': return ['--prompt', prompt, '--output-format', 'stream-json']
    case 'openclaw': return ['agent', 'exec', '--message-file', '-', '--json', '--code-mode', 'direct']
    case 'fastclaw': return ['chat', ...(session ? ['--resume', session] : []), '--query', prompt]
    case 'hermes': return ['--oneshot', prompt]
    case 'omp': return ['--print', '--mode', 'text', '--no-session', '--no-tools', prompt]
    default: throw new Error('This local agent has no chat adapter yet')
  }
}

export function localAgentText(id: string, stdout: string): string {
  if (id === 'gemini' && stdout.trim().split('\n').some(line => /"type"\s*:\s*"(?:init|message|result|tool_use|error)"/.test(line))) {
    const stream = new GeminiStream()
    stream.push(stdout)
    return stream.finish().text
  }
  if (id === 'grok' && stdout.trim().split('\n').some(line => /"type"\s*:\s*"(?:text|end|error|tool_call)"/.test(line))) {
    const stream = new GrokStream()
    stream.push(stdout)
    return stream.finish().text
  }
  if (id === 'kimi') {
    // Text mode adds terminal transcript bullets and indentation. JSONL keeps
    // the original Markdown and separates assistant replies from tool output.
    return stdout.split('\n').filter(line => line.trim()).flatMap(line => {
      const message = JSON.parse(line)
      if (message.role !== 'assistant') return []
      if (typeof message.content === 'string') return [message.content]
      if (Array.isArray(message.content)) return [message.content
        .filter((part: { type?: string; text?: unknown }) => part.type === 'text' && typeof part.text === 'string')
        .map((part: { text: string }) => part.text).join('')]
      return []
    }).filter(Boolean).join('\n\n').trim()
  }
  if (['fastclaw', 'hermes', 'omp'].includes(id)) return stdout.trim()
  if (id === 'opencode') {
    const events = stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
    const error = events.find((event) => event.type === 'error')
    if (error) throw new Error(error.error?.data?.message || error.error?.message || 'OpenCode failed')
    return events.filter((event) => event.type === 'text').map((event) => event.part?.text || '').join('\n').trim()
  }
  const data = JSON.parse(stdout)
  if (data.ok === false || data.status === 'error' || data.status === 'timeout' || data.is_error || data.error) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message
    throw new Error(message || data.result || data.text || 'Local agent failed')
  }
  return String(data.final ?? data.result ?? data.response ?? data.text ?? '').trim()
}

function cleanProcessOutput(text: string): string {
  return text
    // Terminal colour/control sequences are useful in a shell, but make the
    // in-app diagnostic unreadable and can interfere with error matching.
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .trim()
}

export function localAgentExitError(
  agent: Pick<LocalAgent, 'id' | 'name'>,
  code: number | null,
  stdout: string,
  stderr: string
): Error {
  let diagnostic = cleanProcessOutput(stderr)
  if (agent.id === 'openclaw' && stdout.trim()) {
    // Exec reserves stdout for its result envelope. Warnings on stderr must
    // not bury the actual failure behind skill/plugin startup diagnostics.
    try {
      const data = JSON.parse(stdout)
      const message = data.error?.message
      if (typeof message === 'string' && message.trim()) {
        return new Error(`${agent.name}: ${cleanProcessOutput(message)}${diagnostic ? `\n${diagnostic.slice(-1200)}` : ''}`)
      }
    } catch { /* Older CLI failures may only contain stderr. */ }
  }
  if (!diagnostic && stdout.trim()) {
    try {
      // Structured CLIs often put their useful authentication/configuration
      // failure in JSON on stdout even though the process exits non-zero.
      diagnostic = localAgentText(agent.id, stdout)
    } catch (cause) {
      diagnostic = cause instanceof Error ? cause.message : cleanProcessOutput(stdout)
    }
  }
  diagnostic = cleanProcessOutput(diagnostic).slice(-1200)
  return new Error(`${agent.name}: ${diagnostic || `Exited with status ${code ?? 'unknown'}`}`)
}

const CLAUDE_ACCOUNT_AUTH_CONFLICTS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL'
] as const

/** Only for the fresh, application-owned temporary workspace created below.
 * Claude account-login fallback is intentionally opt-in: a working API-key
 * setup keeps its normal precedence, while an initial authentication/billing failure
 * can retry against Claude Code's persisted claude.ai login. */
export function localAgentEnvironment(
  id: string,
  env: NodeJS.ProcessEnv,
  useClaudeAccountLogin = false
): NodeJS.ProcessEnv {
  if (id === 'gemini') return { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
  if (id !== 'claude' || !useClaudeAccountLogin) return env
  const accountEnvironment = { ...env }
  for (const name of CLAUDE_ACCOUNT_AUTH_CONFLICTS) delete accountEnvironment[name]
  return accountEnvironment
}

export function shouldRetryClaudeWithAccountLogin(
  id: string,
  cause: unknown,
  env: NodeJS.ProcessEnv
): boolean {
  if (id !== 'claude' || !(cause instanceof Error)) return false
  if (!CLAUDE_ACCOUNT_AUTH_CONFLICTS.some((name) => Boolean(env[name]))) return false
  const connectorConflict = /claude\.ai connectors are disabled because/i.test(cause.message) && /auth source/i.test(cause.message)
  const exhaustedApiKey = Boolean(env.ANTHROPIC_API_KEY)
    && /^(?:Claude Code:\s*)?Credit balance is too low[.!]?$/i.test(cause.message.trim())
  return connectorConflict || exhaustedApiKey
}

export function localAgentReply(agentName: string, text: string, images: LocalAgentImage[]): LocalAgentReply {
  if (!text && !images.length) {
    throw new Error(`${agentName} finished without a text or image response. Check its local login and configuration.`)
  }
  return { text, images }
}

/** Codex JSONL starts with the id whose imagegen output directory it owns. */
export function codexThreadId(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string }
      if (event.type === 'thread.started' && /^[0-9a-f-]{36}$/i.test(event.thread_id ?? '')) return event.thread_id
    } catch { /* A diagnostic line is not an event. */ }
  }
  return undefined
}

function imageMime(data: Uint8Array): MessageAttachment['mimeType'] | undefined {
  if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  const header = Buffer.from(data.subarray(0, 12)).toString('ascii')
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif'
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

async function generatedImages(threadId: string | undefined, env: NodeJS.ProcessEnv, since = 0): Promise<LocalAgentImage[]> {
  if (!threadId || !/^[0-9a-f-]{36}$/i.test(threadId)) return []
  const directory = join(env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images', threadId)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
  const candidates = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => ({
    path: join(directory, entry.name),
    name: entry.name,
    info: await stat(join(directory, entry.name))
  })))
  candidates.sort((left, right) => left.info.mtimeMs - right.info.mtimeMs)
  const images: LocalAgentImage[] = []
  let total = 0
  for (const candidate of candidates) {
    if (candidate.info.mtimeMs < since) continue
    if (images.length >= ATTACHMENT_LIMITS.count || candidate.info.size > ATTACHMENT_LIMITS.imageBytes || total + candidate.info.size > ATTACHMENT_LIMITS.totalBytes) continue
    const data = await readFile(candidate.path)
    const mimeType = imageMime(data)
    if (!mimeType) continue
    images.push({ name: basename(candidate.name), mimeType, data })
    total += data.byteLength
  }
  return images
}

/** Only attach typed image-tool outputs from this run's private Grok session.
 * Never follow a filename written in an assistant reply or read arbitrary paths. */
export async function grokGeneratedImages(
  result: { paths: string[]; sessionId?: string }, env: NodeJS.ProcessEnv, workspace: string
): Promise<LocalAgentImage[]> {
  if (!result.paths.length) return []
  if (!/^[0-9a-f-]{36}$/i.test(result.sessionId ?? '')) throw new Error('Grok: Invalid image session')
  const sessions = join(env.GROK_HOME || join(homedir(), '.grok'), 'sessions')
  const sessionsRoot = await realpath(sessions)
  const workspaces = [workspace, await realpath(workspace)]
  const images: LocalAgentImage[] = []
  let total = 0
  for (const path of result.paths) {
    // Check both lexical and resolved containment: a symlink must not attach a
    // file from another conversation or from elsewhere on the computer.
    const parts = relative(sessions, path).split(sep)
    if (parts.length !== 4 || parts[0] === '..' || parts[1] !== result.sessionId || parts[2] !== 'images') {
      throw new Error('Grok: Image output is outside this session')
    }
    const resolved = await realpath(path)
    if (dirname(resolved) !== join(sessionsRoot, parts[0], result.sessionId!, 'images')) throw new Error('Grok: Image output is outside this session')
    let cwd: string
    try { cwd = decodeURIComponent(parts[0]) } catch { throw new Error('Grok: Invalid image workspace') }
    if (!workspaces.includes(cwd)) {
      // Grok uses a hashed directory plus a .cwd marker for long workspace paths.
      const marker = join(sessionsRoot, parts[0], '.cwd')
      if (await realpath(marker) !== marker || (await stat(marker)).size > 8192) throw new Error('Grok: Invalid image workspace')
      cwd = (await readFile(marker, 'utf8')).trim()
      if (!workspaces.includes(cwd)) throw new Error('Grok: Image output is outside this workspace')
    }
    const info = await stat(resolved)
    if (!info.isFile() || images.length >= ATTACHMENT_LIMITS.count || info.size > ATTACHMENT_LIMITS.imageBytes || total + info.size > ATTACHMENT_LIMITS.totalBytes) {
      throw new Error('Grok: Generated image exceeds attachment limits')
    }
    const data = await readFile(resolved)
    const mimeType = imageMime(data)
    if (!mimeType) throw new Error('Grok: Generated file is not a supported image')
    images.push({ name: basename(path), mimeType, data })
    total += data.byteLength
  }
  return images
}

/** Snapshot the extension's isolated output directory before each turn. The
 * model cannot nominate an arbitrary local file as an attachment. */
export async function geminiImageFiles(workspace: string): Promise<Set<string>> {
  const root = join(await realpath(workspace), 'nanobanana-output')
  try {
    if (await realpath(root) !== root) throw new Error('Gemini: Image output is outside this workspace')
    return new Set((await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw cause
  }
}

export async function geminiGeneratedImages(workspace: string, before: Set<string>): Promise<LocalAgentImage[]> {
  const names = [...await geminiImageFiles(workspace)].filter(name => !before.has(name))
  const root = join(await realpath(workspace), 'nanobanana-output')
  const images: LocalAgentImage[] = []
  let total = 0
  for (const name of names) {
    if (!/\.(?:png|jpe?g|webp|gif)$/i.test(name)) continue
    const path = join(root, name)
    if (dirname(await realpath(path)) !== root) throw new Error('Gemini: Image output is outside this workspace')
    const info = await stat(path)
    if (!info.isFile() || images.length >= ATTACHMENT_LIMITS.count || info.size > ATTACHMENT_LIMITS.imageBytes || total + info.size > ATTACHMENT_LIMITS.totalBytes) throw new Error('Gemini: Generated image exceeds attachment limits')
    const data = await readFile(path)
    const mimeType = imageMime(data)
    if (!mimeType) throw new Error('Gemini: Generated file is not a supported image')
    images.push({ name, mimeType, data })
    total += data.byteLength
  }
  if (!images.length) throw new Error('Gemini: Image generation failed. The tool did not produce a new image file.')
  return images
}

const processBudget = new LocalProcessBudget(8)
export function acquireLocalProcessSlot(signal?: AbortSignal): Promise<() => void> {
  return processBudget.acquire(signal, evictIdleConnection)
}
const activeLocalRuns = new Set<{ agentId: string; sessionKey?: string; abort: AbortController }>()

/** An agent's own arguments follow its runtime's. Remote arguments are merged into
 * the SSH spec so the launch-time validation and safety checks cover both. */
export function withStartupArgs(agent: LocalAgent, args: string[]): LocalAgent {
  return agent.remote
    ? { ...agent, args: [...(agent.args ?? []), ...args], remote: { ...agent.remote, args: [...agent.remote.args, ...args] } }
    : { ...agent, args: [...(agent.args ?? []), ...args] }
}

export async function runLocalAgent(
  config: AgentConfig, prompt: string, signal?: AbortSignal,
  inputImages: LocalAgentImage[] = [], options: LocalRunOptions = {}
): Promise<LocalAgentReply> {
  const run = { agentId: config.id, sessionKey: options.sessionKey, abort: new AbortController() }
  activeLocalRuns.add(run)
  const combined = signal ? AbortSignal.any([signal, run.abort.signal]) : run.abort.signal
  let release: (() => void) | undefined
  try {
    options = await withAgentOverride(config, options)
    const kind = connectionKind(config, options)
    const connected = options.sessionKey && kind
    if (!connected) release = await processBudget.acquire(combined, evictIdleConnection)
    combined.throwIfAborted()
    return await executeLocalAgent(config, prompt, combined, inputImages, options)
  } finally { release?.(); activeLocalRuns.delete(run) }
}

/** Codex and Claude keep a protocol connection; remote entries use their adapter. */
function connectionKind(config: AgentConfig, options: LocalRunOptions): 'codex' | 'claude' | undefined {
  const id = options.agentOverride?.remote?.adapter ?? (options.agentOverride?.custom ? undefined : config.localAgentId)
  return id === 'codex' || id === 'claude' ? id : undefined
}

async function executeLocalAgent(
  config: AgentConfig,
  prompt: string,
  signal?: AbortSignal,
  inputImages: LocalAgentImage[] = [],
  options: LocalRunOptions = {}
): Promise<LocalAgentReply> {
  // Long-lived sessions report connecting only when they actually start a process.
  if (options.sessionKey && connectionKind(config, options)) {
    return runConnectedAgent(config, prompt, signal, inputImages, options)
  }
  options.onProgress?.({ phase: 'connecting', elapsedSeconds: 0, silentSeconds: 0 })
  const agent = options.agentOverride ?? await validateLocalAgent(config.localAgentId!)
  if (agent.remote) return executeRemoteAgent(config, agent, agent.remote, prompt, signal, inputImages, options)
  const env = await spawnEnvironment()
  signal?.throwIfAborted()
  const workspace = options.sessionKey && !options.transient ? localWorkspace(config, options.sessionKey, options.workspaceDirectory) : undefined
  const directory = workspace?.directory ?? await mkdtemp(join(tmpdir(), 'douchat-agent-'))
  // Never leave Douchat's scratch files in a user's project folder.
  const scratch = workspace?.custom ? await mkdtemp(join(tmpdir(), 'douchat-scratch-')) : directory
  const inputDirectory = workspace?.custom && inputImages.length ? join(directory, `.douchat-input-${randomUUID()}`) : directory
  let geminiPolicyFile: string | undefined
  const output = join(scratch, `reply-${randomUUID()}.txt`)
  try {
    const extensions: Record<MessageAttachment['mimeType'], string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'
    }
    if (inputDirectory !== directory) await mkdir(inputDirectory, { mode: 0o700 })
    const imagePaths = await Promise.all(inputImages.map(async (image, index) => {
      const path = join(inputDirectory, `input-image-${randomUUID()}.${extensions[image.mimeType]}`)
      await writeFile(path, image.data)
      return path
    }))
    const fastclaw = agent.id === 'fastclaw' && !agent.custom ? fastclawTurn(workspace, prompt, options.continuationPrompt) : undefined
    if (fastclaw) prompt = fastclaw.prompt
    const effectivePrompt = imagePaths.length
      ? `${prompt}\n\nThe human attached ${imagePaths.length === 1 ? 'this image' : 'these images'}. Inspect the image file${imagePaths.length === 1 ? '' : 's'} before answering:\n${imagePaths.join('\n')}`
      : prompt
    const geminiBefore = agent.id === 'gemini' && !agent.custom ? await geminiImageFiles(directory) : new Set<string>()
    if (agent.id === 'gemini' && !agent.custom) {
      geminiPolicyFile = output + '.toml'
      await writeFile(geminiPolicyFile, geminiImagePolicy(options.imageToolsAllowed !== false), { mode: 0o600 })
    }
    const command = await executableCommand(agent.id === 'grok' && agent.command !== 'grok' ? agent.path! : await localAgentExecutable(agent.id, agent.path!))
    const runStarted = Date.now()
    let grokStream: GrokStream | undefined
    let geminiStream: GeminiStream | undefined
    const run = (childEnvironment: NodeJS.ProcessEnv): Promise<string> => new Promise<string>((resolve, reject) => {
      const child = spawnOwnedProcess(command.file, [...command.prefix, ...(agent.custom ? customLocalAgentArguments(agent.args, effectivePrompt) : appendLocalAgentArguments(withLocalModel(agent.id, withLocalThinking(agent.id, localAgentArgs(agent.id, effectivePrompt, output, true, fastclaw?.session), config.thinkingLevel), config.model), agent.args)), ...(geminiPolicyFile ? ['--policy', geminiPolicyFile] : [])], {
        cwd: directory, env: childEnvironment, windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let failure: Error | undefined
      const kill = (): void => killLocalProcess(child)
      const abort = (): void => { failure = new Error('Stopped'); kill() }
      const started = Date.now()
      let lastOutput = started
      grokStream = agent.id === 'grok' && !agent.custom ? new GrokStream(detail => options.onProgress?.({
        phase: 'working', elapsedSeconds: Math.floor((Date.now() - started) / 1000), silentSeconds: 0, detail
      })) : undefined
      geminiStream = agent.id === 'gemini' && !agent.custom ? new GeminiStream(detail => options.onProgress?.({
        phase: 'working', elapsedSeconds: Math.floor((Date.now() - started) / 1000), silentSeconds: 0, detail
      })) : undefined
      const progressStream = grokStream ?? geminiStream
      options.onProgress?.({ phase: 'ready', elapsedSeconds: 0, silentSeconds: 0 })
      const timer = setInterval(() => options.onProgress?.({
        phase: 'waiting', elapsedSeconds: Math.floor((Date.now() - started) / 1000),
        silentSeconds: Math.floor((Date.now() - lastOutput) / 1000), detail: progressStream?.detail
      }), progressStream ? 1000 : 15_000)
      const cleanup = (): void => { clearInterval(timer); signal?.removeEventListener('abort', abort) }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      const collect = (text: string, stream: 'stdout' | 'stderr'): void => {
        lastOutput = Date.now()
        bytes += Buffer.byteLength(text)
        if (bytes > 8 * 1024 * 1024) { failure = new Error(`${agent.name} produced too much output`); kill(); return }
        if (stream === 'stdout') { stdout += text; progressStream?.push(text) }
        else stderr += text
      }
      child.stdout.on('data', (text: string) => collect(text, 'stdout'))
      child.stderr.on('data', (text: string) => collect(text, 'stderr'))
      child.once('error', (error) => { failure = error; kill() })
      child.once('close', (code) => {
        cleanup()
        kill()
        if (failure) reject(failure)
        else if (code !== 0) reject(localAgentExitError(agent, code, stdout, stderr))
        else resolve(stdout)
      })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdin.on('error', () => { /* Process exit is reported by close. */ })
      child.stdin.end(['codex', 'openclaw'].includes(agent.id) ? effectivePrompt : undefined)
    })
    let stdout: string
    let usedClaudeAccountLogin = false
    try {
      stdout = await run(localAgentEnvironment(agent.id, env))
    } catch (cause) {
      if (!shouldRetryClaudeWithAccountLogin(agent.id, cause, env)) throw cause
      usedClaudeAccountLogin = true
      stdout = await run(localAgentEnvironment(agent.id, env, true))
    }
    const grokResult = grokStream?.finish()
    const geminiResult = geminiStream?.finish()
    if (grokResult?.paths.length || geminiResult?.imageToolsSucceeded) options.onProgress?.({ phase: 'working', elapsedSeconds: Math.floor((Date.now() - runStarted) / 1000), silentSeconds: 0, detail: 'Attaching generated images' })
    const images = agent.id === 'codex' ? await generatedImages(codexThreadId(stdout), env)
      : grokResult ? await grokGeneratedImages(grokResult, env, directory)
        : geminiResult?.imageToolsSucceeded ? await geminiGeneratedImages(directory, geminiBefore) : []
    const replyText = async (): Promise<string> => agent.custom
      ? stdout.trim()
      : agent.id === 'codex' ? (await readFile(output, 'utf8')).trim() : grokResult?.text ?? geminiResult?.text ?? localAgentText(agent.id, stdout)
    let text: string
    try {
      text = await replyText()
    } catch (cause) {
      if (usedClaudeAccountLogin || !shouldRetryClaudeWithAccountLogin(agent.id, cause, env)) throw cause
      usedClaudeAccountLogin = true
      stdout = await run(localAgentEnvironment(agent.id, env, true))
      text = await replyText()
    }
    if (fastclaw?.session) workspace?.remember(fastclaw.session)
    return localAgentReply(agent.name, text, images)
  } finally {
    await rm(output, { force: true })
    if (geminiPolicyFile) await rm(geminiPolicyFile, { force: true })
    if (inputDirectory !== directory) await rm(inputDirectory, { recursive: true, force: true })
    if (scratch !== directory) await rm(scratch, { recursive: true, force: true })
    if (!workspace) await rm(directory, { recursive: true, force: true })
  }
}


/** The server's environment is unknown here; retry decisions rely on the error text. */
const REMOTE_AUTH_ENV: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'remote' }
const STDIN_ADAPTERS = new Set(['codex', 'openclaw'])

function remoteImagePrompt(prompt: string, paths: string[]): string {
  return paths.length
    ? `${prompt}\n\nThe human attached ${paths.length === 1 ? 'this image' : 'these images'}. Inspect the image file${paths.length === 1 ? '' : 's'} on this server before answering:\n${paths.join('\n')}`
    : prompt
}

/** One-shot remote run. The prompt only travels on ssh stdin: the agent either
 * inherits stdin or the script reads it into "$p". Nothing is written to disk. */
async function executeRemoteAgent(
  config: AgentConfig, agent: LocalAgent, input: RemoteAgentSpec, prompt: string,
  signal: AbortSignal | undefined, inputImages: LocalAgentImage[], options: LocalRunOptions
): Promise<LocalAgentReply> {
  const totalStarted = Date.now()
  const transport = await openSshTransport(input, signal)
  const spec = transport.spec
  signal?.throwIfAborted()
  const adapter = spec.adapter
  const custom = adapter === 'custom'
  // Same session rule as local agents; the folder lives on the server.
  const placement = remotePlacement(agent, options)
  const workspace = options.sessionKey && !options.transient ? localWorkspace(config, options.sessionKey, undefined, { remote: placement }) : undefined
  const run = new RemoteRun(transport, remoteWorkspaceRef(workspace, placement))
  try {
    await run.prepare(signal)
    const imagePaths = await run.uploadImages(inputImages, signal)
    const channel: PromptChannel = custom || !STDIN_ADAPTERS.has(adapter) ? 'argv' : 'stdin'
    const fastclaw = adapter === 'fastclaw' ? fastclawTurn(workspace, prompt, options.continuationPrompt) : undefined
    const effectivePrompt = remotePrompt(`${remoteImagePrompt(fastclaw?.prompt ?? prompt, imagePaths)}\n\n${outboxPrompt(run)}`)
    if (channel === 'argv') assertArgvPrompt(effectivePrompt)
    let policy: string | undefined
    if (adapter === 'gemini') policy = await run.upload('policy.toml', Buffer.from(geminiImagePolicy(options.imageToolsAllowed !== false)), signal)
    const geminiBefore = adapter === 'gemini' ? await run.geminiSnapshot(signal) : new Set<string>()
    // A unique placeholder marks where "$p" goes; the prompt never enters the script.
    const placeholder = `douchat-prompt-${randomUUID()}`
    const output = `${run.directory}/reply.txt`
    const args: RemoteArg[] = custom
      ? customRemoteArguments(spec.args)
      : [...markPromptArguments(appendLocalAgentArguments(withLocalModel(adapter, withLocalThinking(adapter, localAgentArgs(adapter, placeholder, output, true, fastclaw?.session), config.thinkingLevel), config.model), spec.args), placeholder),
          ...(policy ? ['--policy', policy] : [])]
    if (args.some(arg => typeof arg === 'string' && arg.includes(placeholder))) throw new Error('Invalid remote agent arguments')
    if (channel === 'stdin' && args.includes(PROMPT_ARG)) throw new Error('Invalid remote agent arguments')
    const parser = { id: custom ? 'custom' : adapter, name: agent.name }
    const runStarted = Date.now()
    let grokStream: GrokStream | undefined
    let geminiStream: GeminiStream | undefined
    const execute = async (accountLogin: boolean): Promise<string> => {
      signal?.throwIfAborted()
      const child = await timedRemote('agent.spawn', { runId: run.id, transport: spec.transport }, () => transport.spawn({
        runId: run.id, workspace: run.workspaceRef, executable: spec.executable, args, channel,
        environment: adapter === 'gemini' ? 'gemini' : adapter === 'claude' && accountLogin ? 'claude-account' : undefined
      }))
      if (signal?.aborted) { killLocalProcess(child); signal.throwIfAborted() }
      return new Promise<string>((resolve, reject) => {
        let stdout = ''
        let stderr = ''
        let bytes = 0
        let failure: Error | undefined
        const kill = (): void => killLocalProcess(child)
        const abort = (): void => { failure = new Error('Stopped'); kill(); void run.kill() }
        const started = Date.now()
        let lastOutput = started
        const progress = (detail: string) => options.onProgress?.({ phase: 'working', elapsedSeconds: Math.floor((Date.now() - started) / 1000), silentSeconds: 0, detail })
        grokStream = adapter === 'grok' ? new GrokStream(progress) : undefined
        geminiStream = adapter === 'gemini' ? new GeminiStream(progress) : undefined
        const progressStream = grokStream ?? geminiStream
        options.onProgress?.({ phase: 'ready', elapsedSeconds: 0, silentSeconds: 0 })
        const timer = setInterval(() => options.onProgress?.({
          phase: 'waiting', elapsedSeconds: Math.floor((Date.now() - started) / 1000),
          silentSeconds: Math.floor((Date.now() - lastOutput) / 1000), detail: progressStream?.detail
        }), progressStream ? 1000 : 15_000)
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        const collect = (text: string, stream: 'stdout' | 'stderr'): void => {
          lastOutput = Date.now()
          bytes += Buffer.byteLength(text)
          if (bytes > 8 * 1024 * 1024) { failure = new Error(`${agent.name} produced too much output`); kill(); void run.kill(); return }
          if (stream === 'stdout') { stdout += text; progressStream?.push(text) } else stderr += text
        }
        child.stdout.on('data', (text: string) => collect(text, 'stdout'))
        child.stderr.on('data', (text: string) => collect(text, 'stderr'))
        child.once('error', (error) => { failure = error; kill() })
        child.once('close', (code) => {
          clearInterval(timer)
          signal?.removeEventListener('abort', abort)
          kill()
          if (failure) reject(failure)
          else if (code !== 0) reject(localAgentExitError(parser, code, stdout, stderr))
          else resolve(stdout)
        })
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        child.stdin.on('error', () => { /* Process exit is reported by close. */ })
        // Both channels read the prompt from stdin, then see EOF.
        child.stdin.end(effectivePrompt)
      })
    }
    let usedAccountLogin = false
    let stdout: string
    try { stdout = await execute(false) }
    catch (cause) {
      if (!shouldRetryClaudeWithAccountLogin(adapter, cause, REMOTE_AUTH_ENV)) throw cause
      usedAccountLogin = true
      stdout = await execute(true)
    }
    const grokResult = grokStream?.finish()
    const geminiResult = geminiStream?.finish()
    if (grokResult?.paths.length || geminiResult?.imageToolsSucceeded) options.onProgress?.({ phase: 'working', elapsedSeconds: Math.floor((Date.now() - runStarted) / 1000), silentSeconds: 0, detail: 'Attaching generated images' })
    const images = adapter === 'codex' ? await run.codexImages(codexThreadId(stdout), signal)
      : grokResult ? await run.grokImages(grokResult, signal)
        : geminiResult?.imageToolsSucceeded ? await run.geminiImages(geminiBefore, signal) : []
    const replyText = async (): Promise<string> => custom ? stdout.trim()
      : adapter === 'codex' ? (await run.replyText(signal)).trim() : grokResult?.text ?? geminiResult?.text ?? localAgentText(adapter, stdout)
    let text: string
    try { text = await replyText() }
    catch (cause) {
      if (usedAccountLogin || !shouldRetryClaudeWithAccountLogin(adapter, cause, REMOTE_AUTH_ENV)) throw cause
      stdout = await execute(true)
      text = await replyText()
    }
    if (fastclaw?.session) workspace?.remember(fastclaw.session)
    const files = await run.outboxFiles(signal)
    const reply = files.length && !text && !images.length ? { text: '', images } : localAgentReply(agent.name, text, images)
    return files.length ? { ...reply, files: files.map(file => ({ name: file.name, data: file.data })) } : reply
  } finally {
    recordTiming('execution.one-shot', totalStarted, { runId: run.id, agentId: config.id, transport: spec.transport })
    await run.dispose(true)
  }
}


interface ConnectedSession {
  evicted?: boolean
  persistent?: boolean
  config: AgentConfig
  sessionKey: string
  connection: LocalAgentConnection
  /** Private server directory for a remote connection, removed on eviction. */
  remoteRun?: Promise<RemoteRun | undefined>
  directory: Promise<string>
  ready: Promise<{ agent: LocalAgent; env: NodeJS.ProcessEnv; directory: string; run?: RemoteRun }>
  busy: boolean
  idle?: NodeJS.Timeout
}
const connections = new Map<string, ConnectedSession>()
// Reconnecting costs seconds (launch, MCP servers, session resume); an idle
// process costs only memory. Keep a few for switching between chats.
const IDLE_CONNECTION_MS = 10 * 60_000
const MAX_IDLE_CONNECTIONS = 4

function evictIdleConnection(): void {
  const idle = [...connections].find(([, entry]) => !entry.busy)
  if (idle) evictConnection(...idle)
}

function evictConnection(key: string, entry: ConnectedSession): void {
  if (entry.evicted) return
  entry.evicted = true
  if (connections.get(key) === entry) connections.delete(key)
  clearTimeout(entry.idle)
  entry.connection.close(undefined, true)
  void entry.remoteRun?.then(run => run?.dispose(true)).catch(() => {})
  void entry.directory.then(async (directory) => {
    await entry.connection.disposed()
    if (!entry.persistent) await rm(directory, { recursive: true, force: true })
  }).catch(() => { /* Startup already reports its error. */ })
}

/** Quit: stop every run and process, whichever agent or account owns it. */
export function disposeAllLocalAgentSessions(): void {
  for (const run of activeLocalRuns) run.abort.abort(new Error('Stopped'))
  for (const [key, entry] of connections) { entry.connection.close(); evictConnection(key, entry) }
  killAllLocalProcesses()
}

export function disposeLocalAgentSessions(agentId: string): void {
  for (const run of activeLocalRuns) if (run.agentId === agentId) run.abort.abort(new Error('Stopped'))
  for (const [key, entry] of connections) if (entry.config.id === agentId) evictConnection(key, entry)
}
function conversationMatcher(conversationId: string, topicId?: string, directAgentIds: string[] = []): (sessionKey: string) => boolean {
  const prefixes = [`direct:${conversationId}:`, `group:${encodeURIComponent(conversationId)}:`, `handoff:${conversationId}:`]
  return (sessionKey) => {
    const incoming = sessionKey.startsWith('a2a:') && directAgentIds.some(id => sessionKey.includes(`:bot:${encodeURIComponent(id)}:topic:`))
    return (incoming || prefixes.some(prefix => sessionKey.startsWith(prefix))) && (!topicId || sessionKey.includes(encodeURIComponent(topicId)))
  }
}
/** Close idle processes for this chat after its folder changes. Running turns
 * finish undisturbed; the connection key includes the folder, so later turns
 * never reuse a process started in the old folder. */
export function releaseIdleLocalAgentConnections(conversationId: string, directAgentIds: string[] = [], roomId?: string): void {
  const conversation = conversationMatcher(conversationId, undefined, directAgentIds)
  const room = roomId ? `:room:${encodeURIComponent(roomId)}` : undefined
  const matches = (sessionKey: string): boolean => conversation(sessionKey) || Boolean(room && sessionKey.startsWith('social:') && sessionKey.endsWith(room))
  for (const [key, entry] of connections) if (!entry.busy && matches(entry.sessionKey)) evictConnection(key, entry)
}
/** Closes one session's idle process (a one-off turn that is done). */
export function releaseLocalAgentSession(sessionKey: string): void {
  for (const [key, entry] of connections) if (!entry.busy && entry.sessionKey === sessionKey) evictConnection(key, entry)
}
export function resetLocalAgentConversation(conversationId: string, topicId?: string, directAgentIds: string[] = [], owner = ''): void {
  const matches = conversationMatcher(conversationId, topicId, directAgentIds)
  resetLocalWorkspaces(owner, (sessionKey) => matches(sessionKey))
  for (const run of activeLocalRuns) if (run.sessionKey && matches(run.sessionKey)) run.abort.abort(new Error('Stopped'))
  for (const [key, entry] of connections) if (matches(entry.sessionKey)) evictConnection(key, entry)
}

interface ConnectionPlan {
  key: string
  kind: 'codex' | 'claude'
  options: LocalRunOptions
  remoteSpec?: RemoteAgentSpec
  placement?: RemotePlacement
  workspace?: ReturnType<typeof localWorkspace>
}

/** The server identity of a remote run, and the chosen folder if it belongs to
 * that server at its current revision. A folder from any other target is dropped. */
function remotePlacement(agent: LocalAgent | undefined, options: LocalRunOptions): RemotePlacement | undefined {
  if (!agent?.remote) return undefined
  // Main always resolves the target with the connection; never guess one.
  if (!agent.remoteTarget) throw new Error('This remote agent has no server connection.')
  const target = agent.remoteTarget
  const chosen = options.remoteWorkspace
  return { target, ...(chosen && chosen.executionTargetId === target.executionTargetId && chosen.targetRevision === target.targetRevision ? { workspace: chosen } : {}) }
}
function remoteWorkspaceRef(workspace: ReturnType<typeof localWorkspace> | undefined, placement: RemotePlacement | undefined): RemoteWorkspaceRef {
  return { ...(workspace ? { key: workspace.remoteKey } : {}), ...(placement?.workspace ? { path: placement.workspace.path } : {}) }
}

/** Everything that decides which process may serve a turn. Prewarming uses the
 * same plan, so a warmed process is exactly the one the next turn picks up. */
function connectionPlan(config: AgentConfig, options: LocalRunOptions): ConnectionPlan {
  const remoteSpec = options.agentOverride?.remote
  const kind = connectionKind(config, options)!
  // A remote session never uses a folder on this computer, and a local one never a server folder.
  options = remoteSpec ? { ...options, workspaceDirectory: undefined } : { ...options, remoteWorkspace: undefined }
  const placement = remotePlacement(options.agentOverride, options)
  const workspace = options.sessionKey && !options.transient ? localWorkspace(config, options.sessionKey, options.workspaceDirectory, { remote: placement }) : undefined
  if (kind === 'claude' && workspace?.claudeAccountLogin) options = { ...options, claudeAccountLogin: true }
  const launchSettings = [localAgentSettingsVersion(config.localAgentId!), options.agentOverride?.path, options.agentOverride?.args, remoteSpec ?? null, placement ? [placement.target, placement.workspace?.path ?? null] : null]
  // Include account and complete configuration: edits cannot inherit old persona or login state.
  const keyFor = (accountLogin: boolean | undefined): string => JSON.stringify([launchSettings, config.ownerId, config.id, options.sessionKey, config.localAgentId, config.instructions, config.role, config.name, config.model, config.thinkingLevel, accountLogin, Boolean(options.onApproval), Boolean(options.transient), options.workspaceDirectory ?? null])
  let key = keyFor(options.claudeAccountLogin)
  if (kind === 'claude' && !connections.has(key) && !options.claudeAccountLogin && connections.has(keyFor(true))) {
    key = keyFor(true); options = { ...options, claudeAccountLogin: true }
  }
  return { key, kind, options, remoteSpec, placement, workspace }
}

function createConnection(config: AgentConfig, plan: ConnectionPlan, signal: AbortSignal | undefined, busy: boolean): ConnectedSession {
  const { key, kind, options, remoteSpec, workspace } = plan
  const connection = new LocalAgentConnection(kind)
  const directory = workspace && !remoteSpec ? Promise.resolve(workspace.directory) : mkdtemp(join(tmpdir(), 'douchat-session-'))
  let resolveRun!: (run: RemoteRun | undefined) => void
  const remoteRun = new Promise<RemoteRun | undefined>(resolve => { resolveRun = resolve })
  const accountLogin = Boolean(options.claudeAccountLogin)
  // The same conversation can't keep two processes: an older one (from before a
  // model or persona edit) still owns the Codex thread / Claude session, and a
  // resume beside it fails with "active writer", silently losing the context.
  const superseded = [...connections].filter(([other, candidate]) => other !== key && !candidate.busy
    && candidate.config.id === config.id && candidate.sessionKey === options.sessionKey)
  for (const [other, candidate] of superseded) evictConnection(other, candidate)
  const ready = (async () => {
    const release = await processBudget.acquire(signal, evictIdleConnection)
    void connection.disposed().then(release)
    try {
      await Promise.all(superseded.map(([, candidate]) => candidate.connection.disposed()))
      signal?.throwIfAborted()
      const [agent, env, cwd] = await Promise.all([options.agentOverride ?? validateLocalAgent(config.localAgentId!), spawnEnvironment(), directory])
      signal?.throwIfAborted()
      if (remoteSpec) {
        const transport = await openSshTransport(remoteSpec, signal)
        const spec = transport.spec
        const run = new RemoteRun(transport, remoteWorkspaceRef(workspace, plan.placement))
        resolveRun(run)
        await run.prepare(signal)
        signal?.throwIfAborted()
        await timedRemote('agent.handshake', { runId: run.id, agentId: config.id, transport: spec.transport }, () => connection.connect(spec.executable, run.workspace, {}, config.model, false, workspace, Boolean(options.onApproval), spec.args, config.thinkingLevel, {
          cwd: run.workspace,
          spawn: agentArgs => transport.spawn({
            runId: run.id, workspace: run.workspaceRef, executable: spec.executable, args: agentArgs, channel: 'stdin',
            environment: kind === 'claude' && accountLogin ? 'claude-account' : undefined
          })
        }))
        return { agent, env, directory: cwd, run }
      }
      resolveRun(undefined)
      await connection.connect(agent.path!, cwd, localAgentEnvironment(agent.id, env, options.claudeAccountLogin), config.model, false, workspace, Boolean(options.onApproval), agent.args, config.thinkingLevel)
      return { agent, env, directory: cwd, run: undefined as RemoteRun | undefined }
    } catch (error) { resolveRun(undefined); connection.close(); throw error }
  })()
  const created: ConnectedSession = { config, sessionKey: options.sessionKey!, connection, directory, remoteRun, ready, busy, persistent: Boolean(workspace) }
  connections.set(key, created)
  void connection.disposed().then(() => evictConnection(key, created))
  return created
}

/** Keep an idle process for reuse: most recently used last, trimmed to the limit. */
function retainIdle(key: string, entry: ConnectedSession): void {
  if (connections.get(key) !== entry) return
  clearTimeout(entry.idle)
  connections.delete(key); connections.set(key, entry)
  entry.idle = setTimeout(() => evictConnection(key, entry), IDLE_CONNECTION_MS)
  entry.idle.unref()
  const idle = [...connections].filter(([, candidate]) => !candidate.busy)
  for (const [idleKey, candidate] of idle.slice(0, Math.max(0, idle.length - MAX_IDLE_CONNECTIONS))) evictConnection(idleKey, candidate)
}

async function withAgentOverride(config: AgentConfig, options: LocalRunOptions): Promise<LocalRunOptions> {
  // Custom entries may run on a server; resolve once so the adapter decides the protocol.
  if (!options.agentOverride && (config.localAgentId?.startsWith('custom:') || config.startupArgs?.length)) {
    options = { ...options, agentOverride: await validateLocalAgent(config.localAgentId!) }
  }
  if (options.agentOverride && config.startupArgs?.length) options = { ...options, agentOverride: withStartupArgs(options.agentOverride, config.startupArgs) }
  return options
}

/** Start a conversation's process before its first message (e.g. while the user
 * types) so the turn skips launch, initialization and session resume. Only uses a
 * free process slot: a guess never evicts a session someone is using. */
export async function prepareLocalAgentSession(config: AgentConfig, options: LocalRunOptions): Promise<void> {
  options = await withAgentOverride(config, options)
  if (!options.sessionKey || options.transient || !connectionKind(config, options)) return
  const plan = connectionPlan(config, options)
  const existing = connections.get(plan.key)
  if (existing?.connection.alive) return
  if (existing) evictConnection(plan.key, existing)
  if (processBudget.available < 1) return
  const entry = createConnection(config, plan, undefined, false)
  retainIdle(plan.key, entry)
  // A failed warm-up is not an error: the turn starts its own process.
  await entry.ready.catch(() => { if (!entry.busy) evictConnection(plan.key, entry) })
}

async function runConnectedAgent(config: AgentConfig, prompt: string, signal: AbortSignal | undefined,
  images: LocalAgentImage[], options: LocalRunOptions): Promise<LocalAgentReply> {
  signal?.throwIfAborted()
  const plan = connectionPlan(config, options)
  const { key, kind, remoteSpec, workspace } = plan
  options = plan.options
  let entry = connections.get(key)
  if (entry && !entry.connection.alive) { evictConnection(key, entry); entry = undefined }
  if (entry?.busy) throw new Error('This local agent conversation is already working')
  // A reused session is already connected; don't tell the user it is reconnecting.
  options.onProgress?.({ phase: entry ? 'ready' : 'connecting', elapsedSeconds: 0, silentSeconds: 0 })
  entry ??= createConnection(config, plan, signal, true)
  entry.busy = true
  clearTimeout(entry.idle)
  const current = entry
  const abort = (): void => current.connection.close(new Error('Stopped'))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const connectingAt = Date.now()
  const connectingTimer = setInterval(() => options.onProgress?.({ phase: 'connecting', elapsedSeconds: Math.floor((Date.now() - connectingAt) / 1000), silentSeconds: 0 }), 15_000)
  let inputDirectory: string | undefined
  try {
    const { agent, env, directory, run } = remoteSpec
      ? await timedRemote('session.ready', { agentId: config.id, transport: remoteSpec.transport }, () => current.ready)
      : await current.ready
    clearInterval(connectingTimer)
    signal?.throwIfAborted()
    if (run) {
      const turnStarted = Date.now()
      const context = { runId: run.id, agentId: config.id, turnId: randomUUID() }
      recordTiming('turn.start', connectingAt, context)
      await run.beginTurn(signal)
      const paths = await timedRemote('turn.upload', context, () => run.uploadImages(images, signal))
      const base = current.connection.hasHistory ? options.continuationPrompt ?? prompt : prompt
      const withImages = paths.length ? `${base}\n\nInspect these attached image files on this server before answering:\n${paths.join('\n')}` : base
      let firstProgress = false
      const modelStarted = Date.now()
      const reply = await timedRemote('turn.model', context, () => current.connection.turn(remotePrompt(`${withImages}\n\n${outboxPrompt(run)}`), signal, progress => {
        if (!firstProgress && progress.phase === 'working') {
          firstProgress = true
          recordTiming('turn.first-progress', modelStarted, context)
        }
        options.onProgress?.(progress)
      }, options.onApproval))
      if (kind === 'claude' && options.claudeAccountLogin) workspace?.rememberAccountLogin()
      const [imageResult, fileResult] = await timedRemote('turn.attachments', context, () => Promise.allSettled([
        kind === 'codex' ? timedRemote('turn.images', context, () => run.codexImages(current.connection.thread, signal)) : Promise.resolve([]),
        timedRemote('turn.outbox', context, () => run.outboxFiles(signal))
      ]))
      // Both reads must finish before failure handling can tear down the session.
      if (imageResult.status === 'rejected') throw imageResult.reason
      if (fileResult.status === 'rejected') throw fileResult.reason
      const outputImages = imageResult.value
      const files = fileResult.value
      const result = files.length && !reply && !outputImages.length ? { text: '', images: outputImages } : localAgentReply(agent.name, reply, outputImages)
      recordTiming('turn.complete', turnStarted, context)
      recordTiming('execution.complete', connectingAt, context)
      return files.length ? { ...result, files: files.map(file => ({ name: file.name, data: file.data })) } : result
    }
    // In a user's project folder, keep inputs in a removable hidden folder.
    if (options.workspaceDirectory && images.length) {
      inputDirectory = join(directory, `.douchat-input-${randomUUID()}`)
      await mkdir(inputDirectory, { mode: 0o700 })
    }
    const paths = await Promise.all(images.map(async (image) => {
      const path = join(inputDirectory ?? directory, `input-${randomUUID()}.${image.mimeType.split('/')[1]}`)
      await writeFile(path, image.data)
      return path
    }))
    const text = current.connection.hasHistory ? options.continuationPrompt ?? prompt : prompt
    const effective = paths.length ? `${text}\n\nInspect these attached image files before answering:\n${paths.join('\n')}` : text
    const started = Date.now()
    const reply = await current.connection.turn(effective, signal, options.onProgress, options.onApproval)
    if (kind === 'claude' && options.claudeAccountLogin) workspace?.rememberAccountLogin()
    const outputImages = agent.id === 'codex' ? await generatedImages(current.connection.thread, env, started) : []
    return localAgentReply(agent.name, reply, outputImages)
  } catch (error) {
    // Authentication-only failures can retry once before any model work in this turn.
    // Existing conversation history is not evidence of side effects in the current turn.
    evictConnection(key, current)
    if (kind === 'claude' && current.persistent && !options.freshSessionRetry
      && /No conversation found with session ID/i.test(String(error))) {
      localWorkspace(config, options.sessionKey, options.workspaceDirectory, { remote: plan.placement })?.remember(undefined)
      return runConnectedAgent(config, prompt, signal, images, { ...options, freshSessionRetry: true })
    }
    if (kind === 'claude' && !options.claudeAccountLogin && !signal?.aborted && current.connection.canRetryAuthentication
      && shouldRetryClaudeWithAccountLogin('claude', error, remoteSpec ? REMOTE_AUTH_ENV : await spawnEnvironment())) {
      return runConnectedAgent(config, prompt, signal, images, { ...options, claudeAccountLogin: true })
    }
    throw error
  } finally {
    clearInterval(connectingTimer)
    if (inputDirectory) await rm(inputDirectory, { recursive: true, force: true }).catch(() => {})
    signal?.removeEventListener('abort', abort)
    current.busy = false
    if (connections.get(key) === current && (options.transient || processBudget.hasWaiters)) evictConnection(key, current)
    retainIdle(key, current)
  }
}
