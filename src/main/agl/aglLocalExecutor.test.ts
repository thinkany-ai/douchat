import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentExecutor, LocalProgress } from '../../shared/agentExecutor'
import type { AgentConfig } from '../../shared/types'
import type { AgentEvent, AgentInfo, ConnectionEvent, EventEnvelope, SessionMeta } from './aglClient'
import {
  AglLocalExecutor, AglUnavailable, GeneratedImages, aglLocalAccess, aglLocalRouting, aglLocalSessionName, readCodexGeneratedImage,
  type AglLocalClient, type AglLocalExecutorOptions, type AglWorkspace
} from './aglLocalExecutor'

const config = (extra: Partial<AgentConfig> = {}): AgentConfig => ({ id: 'agent-1', name: 'Coder', localAgentId: 'codex', role: '', instructions: '', color: '', provider: 'local', model: 'gpt-5.5', thinkingLevel: 'high', createdAt: 0, ownerId: 'me', ...extra } as AgentConfig)
const codex: AgentInfo = { id: 'codex', name: 'Codex', protocol: 'codex', available: true, path: '/bin/codex', features: ['warm', 'approvals', 'steer', 'interrupt', 'models', 'effort', 'extra_args', 'instructions', 'ephemeral'] }
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

/** A scripted local daemon: answers calls, and lets the test send events. */
function fakeDaemon(answers: Record<string, (params: Record<string, any>) => unknown> = {}) {
  const calls: Array<{ method: string; params: Record<string, any> }> = []
  const listeners = new Set<(envelope: EventEnvelope) => void>()
  const connection = new Set<(event: ConnectionEvent) => void>()
  let sessions = 0
  const seqs = new Map<string, number>()
  const created = new Map<string, SessionMeta>()
  const client: AglLocalClient = {
    call: vi.fn(async (method: string, params: Record<string, any> = {}) => {
      calls.push({ method, params })
      if (answers[method]) return answers[method](params) as never
      if (method === 'session.create') {
        const meta = { id: `s${++sessions}`, agent: params.agent, cwd: params.cwd, access: params.access, model: params.model, effort: params.effort, visibility: params.visibility, history: params.history,
          extra_args: params.extra_args, instructions: params.instructions, ephemeral: params.ephemeral, turns: 0, native_id: undefined } as unknown as SessionMeta
        created.set(meta.id, meta)
        return meta as never
      }
      if (method === 'session.prompt') return { session_id: params.session_id, turn_id: params.turn_id } as never
      if (method === 'session.get') return { ...created.get(params.session_id), native_id: 'thread-1' } as never
      return {} as never
    }),
    on: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    onConnection: (listener) => { connection.add(listener); return () => connection.delete(listener) },
    subscribe: vi.fn(async () => undefined)
  }
  const emit = (event: AgentEvent, sessionId = 's1'): EventEnvelope => {
    const seq = (seqs.get(sessionId) ?? 0) + 1
    seqs.set(sessionId, seq)
    const envelope = { session_id: sessionId, seq, ts: 0, event }
    for (const listener of [...listeners]) listener(envelope)
    return envelope
  }
  const prompts = () => calls.filter(call => call.method === 'session.prompt')
  const prompted = async (count = 1): Promise<string> => {
    await vi.waitFor(() => expect(prompts()).toHaveLength(count))
    return prompts()[count - 1].params.turn_id
  }
  /** A complete turn: started, the given events, ended. */
  const turn = (turnId: string, events: AgentEvent[], end: Partial<Extract<AgentEvent, { kind: 'turn_ended' }>> = {}, sessionId = 's1'): void => {
    emit({ kind: 'user_message', turn_id: turnId, text: '' }, sessionId)
    emit({ kind: 'turn_started', turn_id: turnId }, sessionId)
    for (const event of events) emit(event, sessionId)
    emit({ kind: 'turn_ended', turn_id: turnId, outcome: 'completed', ...end }, sessionId)
  }
  return { client, calls, emit, prompts, prompted, turn, methods: () => calls.map(call => call.method), reconnect: (event: ConnectionEvent) => { for (const listener of [...connection]) listener(event) } }
}

function setup(extra: Partial<AglLocalExecutorOptions> & { daemon?: ReturnType<typeof fakeDaemon>; thread?: string } = {}) {
  const daemon = extra.daemon ?? fakeDaemon()
  const remembered: Array<string | undefined> = []
  const workspace = vi.fn((_config: AgentConfig, sessionKey: string, directory?: string): AglWorkspace => ({
    directory: directory ?? `/douchat/workspaces/${sessionKey}`, custom: Boolean(directory), thread: extra.thread, remember: (thread) => { remembered.push(thread) }
  }))
  const scratchRemoved = vi.fn(async () => undefined)
  const inputRemoved = vi.fn(async () => undefined)
  const writeImage = vi.fn(async (directory: string, image: { name: string }) => `${directory}/${image.name}`)
  const log = vi.fn()
  const options: AglLocalExecutorOptions = {
    platform: 'darwin', enabled: () => true, client: () => daemon.client, agents: async () => [codex],
    localAgent: async id => ({ id, name: 'Codex', command: 'codex', args: [] }),
    workspace, scratch: async () => ({ directory: '/tmp/douchat-session-x', remove: scratchRemoved }),
    writeImage, inputFolder: async (directory) => ({ directory: `${directory}/.douchat-input-x`, remove: inputRemoved }),
    computerUseInstructions: 'Use Computer Use.', progressIntervalMs: 60_000, log, ...extra
  }
  return { daemon, executor: new AglLocalExecutor(options), workspace, remembered, scratchRemoved, inputRemoved, writeImage, log }
}

afterEach(() => { vi.useRealTimers() })

describe('session parameters', () => {
  it('creates a local, history-free, named session in the runtime’s folder, with access, model, effort, instructions and launch args', async () => {
    const { daemon, executor } = setup({ localAgent: async () => ({ id: 'codex', name: 'Codex', command: 'codex', args: ['-c', 'model_verbosity="low"'] }) })
    const reply = executor.run(config(), 'Full transcript', undefined, [], { sessionKey: 'direct:c1:t1', workspaceDirectory: '/Users/me/project', continuationPrompt: 'New message', onApproval: async () => undefined })
    const turn = await daemon.prompted()
    expect(daemon.calls[0]).toEqual({ method: 'session.create', params: {
      agent: 'codex', name: aglLocalSessionName(config(), 'direct:c1:t1'), cwd: '/Users/me/project', access: 'edit', visibility: 'local', history: false,
      model: 'gpt-5.5', effort: 'high', extra_args: ['-c', 'web_search="live"', '-c', 'model_verbosity="low"'], instructions: 'Use Computer Use.', ephemeral: false
    } })
    expect(aglLocalSessionName(config(), 'direct:c1:t1')).toMatch(/^douchat:[0-9a-f]{24}$/)
    expect(daemon.prompts()[0].params).toMatchObject({ session_id: 's1', text: 'Full transcript', mode: 'queue' })
    daemon.turn(turn, [], { text: 'Done.' })
    await expect(reply).resolves.toEqual({ text: 'Done.', images: [] })
  })

  it('maps Douchat permissions to agl access, never leaving it to agl’s default', () => {
    expect(aglLocalAccess({})).toBe('edit')
    expect(aglLocalAccess({ permissions: { groupHumans: 'allow', groupAgents: 'allow', sensitive: { filesWrite: 'allow', localExecution: 'allow', otherTools: 'allow' } } as never })).toBe('edit')
    expect(aglLocalAccess({ permissions: { sensitive: { filesWrite: 'deny' } } as never })).toBe('read_only')
  })

  it('runs transient turns ephemeral in a scratch folder, without instructions, and closes them afterwards', async () => {
    const { daemon, executor, scratchRemoved, workspace } = setup()
    const reply = executor.run(config({ model: 'default', thinkingLevel: undefined }), 'Plan this', undefined, [], { sessionKey: 'handoff-summary:x', transient: true })
    const turn = await daemon.prompted()
    const params = daemon.calls[0].params
    expect(params).toMatchObject({ cwd: '/tmp/douchat-session-x', ephemeral: true, visibility: 'local', history: false, access: 'edit' })
    expect(params).not.toHaveProperty('instructions')
    expect(params).not.toHaveProperty('model')
    expect(params).not.toHaveProperty('resume')
    expect(workspace).not.toHaveBeenCalled()
    daemon.turn(turn, [{ kind: 'text_delta', text: 'ok' }])
    await expect(reply).resolves.toMatchObject({ text: 'ok' })
    expect(daemon.methods().at(-1)).toBe('session.close')
    expect(scratchRemoved).toHaveBeenCalled()
  })

  it('resumes the conversation’s Codex thread and remembers the thread it runs', async () => {
    const { daemon, executor, remembered } = setup({ thread: 'thread-0' })
    const reply = executor.run(config(), 'Full transcript', undefined, [], { sessionKey: 'direct:c1:t1', continuationPrompt: 'New message' })
    const turn = await daemon.prompted()
    expect(daemon.calls[0].params).toMatchObject({ resume: 'thread-0', ephemeral: false })
    // A resumed thread already has the conversation: only the new message.
    expect(daemon.prompts()[0].params.text).toBe('New message')
    daemon.emit({ kind: 'info', native_id: 'thread-0' })
    daemon.turn(turn, [], { text: 'Hi' })
    await reply
    expect(remembered).toEqual(['thread-0'])
  })

  it('reuses the session for the same key, and reconfigures or recreates it when settings change', async () => {
    const { daemon, executor } = setup()
    const run = async (agent: AgentConfig, options: Record<string, unknown> = {}) => {
      const reply = executor.run(agent, 'Full', undefined, [], { sessionKey: 'direct:c1:t1', continuationPrompt: 'Next', ...options })
      const turn = await daemon.prompted(daemon.prompts().length + 1)
      daemon.turn(turn, [], { text: 'ok' }, daemon.prompts().at(-1)!.params.session_id)
      return reply
    }
    await run(config())
    await run(config())
    expect(daemon.methods().filter(method => method === 'session.create')).toHaveLength(1)
    expect(daemon.prompts()[1].params.text).toBe('Next')
    // Permissions: agl restarts Codex with the new access and keeps the conversation.
    await run(config({ permissions: { sensitive: { filesWrite: 'deny' } } as never }))
    expect(daemon.calls.find(call => call.method === 'session.configure')!.params).toEqual({ session_id: 's1', access: 'read_only' })
    expect(daemon.methods().filter(method => method === 'session.create')).toHaveLength(1)
    // Instructions are a launch setting: a new session.
    await run(config(), { onApproval: async () => undefined })
    expect(daemon.methods().filter(method => method === 'session.close')).toHaveLength(1)
    expect(daemon.calls.filter(call => call.method === 'session.create').at(-1)!.params).toMatchObject({ instructions: 'Use Computer Use.' })
    // An edited agent (model, persona) starts a new conversation, as on the desktop runtime.
    await run(config({ model: 'gpt-5.5-mini' }), { onApproval: async () => undefined })
    expect(daemon.methods().filter(method => method === 'session.close')).toHaveLength(2)
    expect(daemon.calls.filter(call => call.method === 'session.create').at(-1)!.params).toMatchObject({ model: 'gpt-5.5-mini' })
    expect(daemon.prompts().at(-1)!.params.text).toBe('Full')
  })

  it('keeps a session agl kept by name when it holds this chat’s conversation', async () => {
    const daemon = fakeDaemon({ 'session.create': (params) => ({ id: 's1', agent: 'codex', cwd: params.cwd, access: params.access, model: params.model, effort: params.effort, visibility: 'local', history: false,
      extra_args: params.extra_args, ephemeral: false, turns: 3, native_id: 'thread-0', last_seq: 40 }) })
    const { executor } = setup({ daemon, thread: 'thread-0' })
    const reply = executor.run(config(), 'Full', undefined, [], { sessionKey: 'direct:c1:t1', continuationPrompt: 'Next' })
    const turn = await daemon.prompted()
    expect(daemon.methods()).not.toContain('session.close')
    expect(daemon.prompts()[0].params.text).toBe('Next')
    // Events up to seq 40 are earlier turns'.
    daemon.emit({ kind: 'turn_ended', turn_id: turn, outcome: 'completed', text: 'stale' })
    for (let seq = 2; seq <= 40; seq++) daemon.emit({ kind: 'heartbeat', turn_id: 'x', elapsed_ms: 0, idle_ms: 0, stalled: false })
    daemon.turn(turn, [], { text: 'fresh' })
    await expect(reply).resolves.toMatchObject({ text: 'fresh' })
  })

  it('replaces a session agl reused by name when it was made with other settings', async () => {
    let creates = 0
    const daemon = fakeDaemon({
      'session.create': (params) => ++creates === 1
        ? { id: 'old', agent: 'codex', cwd: params.cwd, access: 'full', visibility: 'shared', history: true, turns: 4 }
        : { id: 's1', agent: 'codex', cwd: params.cwd, access: params.access, visibility: 'local', history: false, extra_args: params.extra_args, ephemeral: false, turns: 0 }
    })
    const { executor } = setup({ daemon })
    const reply = executor.run(config(), 'Full', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await daemon.prompted()
    expect(daemon.methods().slice(0, 3)).toEqual(['session.create', 'session.close', 'session.create'])
    expect(daemon.calls[1].params).toEqual({ session_id: 'old' })
    daemon.turn(turn, [], { text: 'ok' })
    await reply
  })
})

describe('turn events', () => {
  it('reports progress from status, tools, commentary and heartbeats, and answers with turn_ended.text', async () => {
    const { daemon, executor } = setup({ progressIntervalMs: 5 })
    const progress: LocalProgress[] = []
    const reply = executor.run(config(), 'Fix it', undefined, [], { sessionKey: 'direct:c1:t1', onProgress: item => progress.push(item) })
    const turn = await daemon.prompted()
    daemon.emit({ kind: 'status', status: 'starting' })
    daemon.emit({ kind: 'turn_started', turn_id: turn })
    daemon.emit({ kind: 'text_delta', text: 'I will run the tests first.', phase: 'commentary' })
    expect(progress.at(-1)).toMatchObject({ phase: 'working', detail: 'I will run the tests first.' })
    daemon.emit({ kind: 'tool_start', call_id: 'c1', name: 'shell', input: { command: 'npm test' } })
    expect(progress.at(-1)!.detail).toBe('Running a command: npm test')
    daemon.emit({ kind: 'heartbeat', turn_id: turn, elapsed_ms: 30_000, idle_ms: 20_000, stalled: false })
    await vi.waitFor(() => expect(progress.at(-1)!.silentSeconds).toBe(20))
    daemon.emit({ kind: 'tool_end', call_id: 'c1', ok: true, output: 'ok' })
    daemon.emit({ kind: 'text_delta', text: 'Tests pass.' })
    daemon.emit({ kind: 'turn_ended', turn_id: turn, outcome: 'completed', text: 'All tests pass now.' })
    await expect(reply).resolves.toEqual({ text: 'All tests pass now.', images: [] })
  })

  it('without turn_ended.text, answers with the text after the last tool call, else the last commentary', async () => {
    const { daemon, executor } = setup()
    const first = executor.run(config(), 'A', undefined, [], { sessionKey: 'direct:c1:t1' })
    const one = await daemon.prompted()
    daemon.turn(one, [{ kind: 'text_delta', text: 'Looking.' }, { kind: 'tool_start', call_id: 'c', name: 'shell', input: {} }, { kind: 'tool_end', call_id: 'c', ok: true, output: '' },
      { kind: 'text_delta', text: 'Found ' }, { kind: 'text_delta', text: 'it.' }])
    await expect(first).resolves.toMatchObject({ text: 'Found it.' })
    const second = executor.run(config(), 'B', undefined, [], { sessionKey: 'direct:c1:t1' })
    const two = await daemon.prompted(2)
    daemon.turn(two, [{ kind: 'text_delta', text: 'Only an update.', phase: 'commentary' }])
    await expect(second).resolves.toMatchObject({ text: 'Only an update.' })
  })

  it('ignores other turns’ events and fails a turn that failed, or ended empty', async () => {
    const { daemon, executor } = setup()
    const reply = executor.run(config(), 'A', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await daemon.prompted()
    daemon.turn('someone-else', [{ kind: 'text_delta', text: 'not ours' }], { text: 'not ours' })
    daemon.turn(turn, [], { outcome: 'failed', error: 'You have hit your usage limit.' })
    await expect(reply).rejects.toThrow('You have hit your usage limit.')
    const empty = executor.run(config(), 'B', undefined, [], { sessionKey: 'direct:c1:t1' })
    daemon.turn(await daemon.prompted(2), [])
    await expect(empty).rejects.toThrow('Codex finished without a text or image response.')
  })
})

describe('approvals', () => {
  it('forwards requests to Douchat’s approval and answers agl; policy decisions are not asked', async () => {
    const { daemon, executor } = setup()
    const onApproval = vi.fn(async () => undefined)
    const reply = executor.run(config(), 'A', undefined, [], { sessionKey: 'direct:c1:t1', onApproval })
    const turn = await daemon.prompted()
    daemon.emit({ kind: 'turn_started', turn_id: turn })
    daemon.emit({ kind: 'permission_request', request_id: 'r0', tool: 'shell', title: 'ls', input: {}, options: ['allow', 'deny'], expires_at: 0, decided_by: 'policy' })
    daemon.emit({ kind: 'permission_request', request_id: 'r1', tool: 'mcp:computer-use', title: 'Allow Codex to use Safari?', input: { app: 'Safari' }, options: ['allow', 'allow_session', 'deny'], expires_at: 0 })
    await vi.waitFor(() => expect(daemon.calls.some(call => call.method === 'session.approve')).toBe(true))
    expect(onApproval).toHaveBeenCalledTimes(1)
    expect((onApproval.mock.calls[0] as unknown[])[0]).toEqual({ message: 'Codex: Allow Codex to use Safari?', details: JSON.stringify({ tool: 'mcp:computer-use', title: 'Allow Codex to use Safari?', input: { app: 'Safari' } }, null, 2) })
    expect(daemon.calls.find(call => call.method === 'session.approve')!.params).toEqual({ session_id: 's1', request_id: 'r1', decision: 'allow' })
    daemon.emit({ kind: 'turn_ended', turn_id: turn, outcome: 'completed', text: 'ok' })
    await reply
  })

  it('denies when Douchat denies or there is no approval handler, and stops asking once agl resolved it', async () => {
    const { daemon, executor } = setup()
    const denied = executor.run(config(), 'A', undefined, [], { sessionKey: 'direct:c1:t1', onApproval: async () => { throw new Error('Denied') } })
    const turn = await daemon.prompted()
    daemon.emit({ kind: 'turn_started', turn_id: turn })
    daemon.emit({ kind: 'permission_request', request_id: 'r1', tool: 'shell', title: 'rm -rf build', input: {}, options: ['allow', 'deny'], expires_at: 0 })
    await vi.waitFor(() => expect(daemon.calls.find(call => call.method === 'session.approve')?.params.decision).toBe('deny'))
    daemon.emit({ kind: 'turn_ended', turn_id: turn, outcome: 'completed', text: 'ok' })
    await denied

    const none = executor.run(config(), 'B', undefined, [], { sessionKey: 'direct:c2:t1' })
    const second = await daemon.prompted(2)
    daemon.emit({ kind: 'turn_started', turn_id: second }, 's2')
    daemon.emit({ kind: 'permission_request', request_id: 'r2', tool: 'edit', title: 'edit', input: {}, options: ['allow', 'deny'], expires_at: 0 }, 's2')
    await vi.waitFor(() => expect(daemon.calls.filter(call => call.method === 'session.approve').at(-1)!.params).toEqual({ session_id: 's2', request_id: 'r2', decision: 'deny' }))
    daemon.emit({ kind: 'turn_ended', turn_id: second, outcome: 'completed', text: 'ok' }, 's2')
    await none

    let approvalSignal: AbortSignal | undefined
    const waiting = executor.run(config(), 'C', undefined, [], { sessionKey: 'direct:c1:t1', onApproval: (_request, signal) => { approvalSignal = signal; return new Promise(() => undefined) } })
    const third = await daemon.prompted(3)
    daemon.emit({ kind: 'turn_started', turn_id: third })
    daemon.emit({ kind: 'permission_request', request_id: 'r3', tool: 'shell', title: 'x', input: {}, options: ['allow', 'deny'], expires_at: 0 })
    await vi.waitFor(() => expect(approvalSignal).toBeDefined())
    daemon.emit({ kind: 'permission_resolved', request_id: 'r3', decision: 'deny', by: 'timeout' })
    expect(approvalSignal!.aborted).toBe(true)
    daemon.emit({ kind: 'turn_ended', turn_id: third, outcome: 'completed', text: 'ok' })
    await waiting
    expect(daemon.calls.filter(call => call.method === 'session.approve' && call.params.request_id === 'r3')).toHaveLength(0)
  })
})

describe('abort and restarts', () => {
  it('aborts the agl session when the turn is stopped', async () => {
    const { daemon, executor } = setup()
    const controller = new AbortController()
    const reply = executor.run(config(), 'A', controller.signal, [], { sessionKey: 'direct:c1:t1' })
    const turn = await daemon.prompted()
    daemon.emit({ kind: 'turn_started', turn_id: turn })
    controller.abort()
    await expect(reply).rejects.toThrow('Stopped')
    expect(daemon.calls.at(-1)).toEqual({ method: 'session.abort', params: { session_id: 's1' } })
    // stopAll / disposeAgent / resetConversation stop running turns too.
    const next = executor.run(config(), 'B', undefined, [], { sessionKey: 'direct:c1:t1' })
    await daemon.prompted(2)
    executor.resetConversation('c1')
    await expect(next).rejects.toThrow('Stopped')
    expect(daemon.methods()).toContain('session.close')
  })

  it('fails the turn when the daemon restarted, and starts a new session next time', async () => {
    const { daemon, executor } = setup()
    const reply = executor.run(config(), 'A', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await daemon.prompted()
    daemon.emit({ kind: 'turn_started', turn_id: turn })
    daemon.reconnect({ state: 'disconnected' })
    daemon.reconnect({ state: 'reconnected', restarted: true })
    await expect(reply).rejects.toThrow('agl restarted while this turn was running')
    const again = executor.run(config(), 'B', undefined, [], { sessionKey: 'direct:c1:t1' })
    await daemon.prompted(2)
    expect(daemon.methods().filter(method => method === 'session.create')).toHaveLength(2)
    daemon.turn(daemon.prompts()[1].params.turn_id, [], { text: 'ok' }, 's2')
    await again
  })

  it('catches up from the session history when only the socket dropped', async () => {
    let missed: EventEnvelope[] = []
    const daemon = fakeDaemon({ 'session.history': () => missed })
    const { executor } = setup({ daemon })
    const reply = executor.run(config(), 'A', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await daemon.prompted()
    daemon.emit({ kind: 'turn_started', turn_id: turn })
    missed = [{ session_id: 's1', seq: 2, ts: 0, event: { kind: 'turn_started', turn_id: turn } }, { session_id: 's1', seq: 3, ts: 0, event: { kind: 'turn_ended', turn_id: turn, outcome: 'completed', text: 'Caught up' } }]
    daemon.reconnect({ state: 'reconnected', restarted: false })
    await expect(reply).resolves.toMatchObject({ text: 'Caught up' })
    expect(daemon.calls.find(call => call.method === 'session.history')!.params).toEqual({ session_id: 's1', after_seq: 1 })
  })

  it('starts a new Codex thread with the whole context when the old one cannot be resumed', async () => {
    const { daemon, executor, remembered } = setup({ thread: 'gone' })
    const reply = executor.run(config(), 'Full transcript', undefined, [], { sessionKey: 'direct:c1:t1', continuationPrompt: 'New message' })
    const turn = await daemon.prompted()
    daemon.turn(turn, [], { outcome: 'failed', error: 'resume codex thread gone: no rollout found' })
    const retry = await daemon.prompted(2)
    expect(remembered[0]).toBeUndefined()
    const create = daemon.calls.filter(call => call.method === 'session.create')
    expect(create).toHaveLength(2)
    expect(create[1].params).not.toHaveProperty('resume')
    expect(daemon.prompts()[1].params.text).toBe('Full transcript')
    daemon.turn(retry, [], { text: 'Fresh' }, 's2')
    await expect(reply).resolves.toMatchObject({ text: 'Fresh' })
  })
})

describe('images', () => {
  it('returns images Codex generated in the turn, not screenshots', async () => {
    const { daemon, executor } = setup()
    const reply = executor.run(config(), 'Draw a cat', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await daemon.prompted()
    daemon.turn(turn, [
      { kind: 'tool_start', call_id: 'shot', name: 'computer-use.screenshot', input: {} },
      { kind: 'tool_end', call_id: 'shot', ok: true, output: '', images: [{ mime_type: 'image/png', data: PNG.toString('base64') }] },
      { kind: 'tool_start', call_id: 'ig', name: 'image_generation', input: { prompt: 'a cat' } },
      { kind: 'tool_end', call_id: 'ig', ok: true, output: '/Users/me/.codex/generated_images/t/ig_1.png', images: [{ mime_type: 'image/png', data: PNG.toString('base64') }] }
    ], { text: 'Here is the cat.' })
    const result = await reply
    expect(result.images).toEqual([{ name: 'ig_1.png', mimeType: 'image/png', data: Buffer.from(PNG) }])
  })

  it('keeps the desktop runtime’s limits and reads images agl sent without data from Codex’s folder', async () => {
    const read = vi.fn(async () => Buffer.from(PNG))
    const images = new GeneratedImages(read)
    images.add({ kind: 'tool_end', call_id: 'a', ok: true, output: 'not-an-image', images: [{ mime_type: 'image/png', data: Buffer.from('<html>').toString('base64') }] })
    images.add({ kind: 'tool_end', call_id: 'b', ok: false, output: '', images: [{ mime_type: 'image/png', data: PNG.toString('base64') }] })
    images.add({ kind: 'tool_end', call_id: 'c', ok: true, output: '/Users/me/.codex/generated_images/t/big.png', images: [{ mime_type: 'image/png', data: '', omitted: true }] })
    for (let index = 0; index < 5; index++) images.add({ kind: 'tool_end', call_id: `d${index}`, ok: true, output: 'a cat', images: [{ mime_type: 'image/png', data: PNG.toString('base64') }] })
    const result = await images.done()
    expect(read).toHaveBeenCalledWith('/Users/me/.codex/generated_images/t/big.png')
    expect(result).toHaveLength(4)
    expect(result.map(image => image.name)).toContain('big.png')
    expect(result.map(image => image.name)).toEqual(['big.png', 'image-2.png', 'image-3.png', 'image-4.png'])
  })

  it('passes input images as files in the session folder, like the desktop runtime', async () => {
    const { daemon, executor, inputRemoved } = setup()
    const image = { name: 'input-image-1', mimeType: 'image/png' as const, data: PNG }
    const reply = executor.run(config(), 'What is this?', undefined, [image], { sessionKey: 'direct:c1:t1', workspaceDirectory: '/Users/me/project' })
    const turn = await daemon.prompted()
    expect(daemon.prompts()[0].params.text).toBe('What is this?\n\nInspect these attached image files before answering:\n/Users/me/project/.douchat-input-x/input-image-1')
    daemon.turn(turn, [], { text: 'A cat.' })
    await reply
    expect(inputRemoved).toHaveBeenCalled()
  })

  it('reads a saved image only from CODEX_HOME/generated_images', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'))
    try {
      await mkdir(join(home, 'generated_images', 't'), { recursive: true })
      await writeFile(join(home, 'generated_images', 't', 'a.png'), PNG)
      await writeFile(join(home, 'secret.png'), PNG)
      await symlink(join(home, 'secret.png'), join(home, 'generated_images', 't', 'link.png'))
      expect(await readCodexGeneratedImage(join(home, 'generated_images', 't', 'a.png'), home)).toEqual(PNG)
      expect(await readCodexGeneratedImage(join(home, 'secret.png'), home)).toBeUndefined()
      expect(await readCodexGeneratedImage(join(home, 'generated_images', 't', 'link.png'), home)).toBeUndefined()
      expect(await readCodexGeneratedImage(join(home, 'generated_images', '..', 'secret.png'), home)).toBeUndefined()
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})

describe('routing', () => {
  const local = (): AgentExecutor & { run: ReturnType<typeof vi.fn> } => ({
    run: vi.fn(async () => ({ text: 'desktop runtime', images: [] })), disposeAgent: vi.fn(), resetConversation: vi.fn(), prepare: vi.fn(async () => undefined)
  })

  it('keeps everything agl cannot take on the desktop runtime, logging why once', async () => {
    const cases: Array<[string, Partial<AglLocalExecutorOptions>, Partial<AgentConfig>, Record<string, unknown>]> = [
      ['windows', { platform: 'win32' }, {}, {}],
      ['setting off', { enabled: () => false }, {}, {}],
      ['other agents', {}, { localAgentId: 'claude' }, {}],
      ['a connection test override', {}, {}, { agentOverride: { id: 'codex' } }],
      ['startup args', {}, { startupArgs: ['--x'] }, {}],
      ['agl not running', { client: () => undefined }, {}, {}],
      ['agl not answering', { agents: async () => undefined }, {}, {}],
      ['Codex not in agl', { agents: async () => [{ ...codex, available: false }] }, {}, {}],
      ['agl too old', { agents: async () => [{ ...codex, features: ['warm', 'approvals'] }] }, {}, {}],
      ['a custom Codex command', { localAgent: async () => ({ id: 'codex', name: 'Codex', command: '/opt/codex-beta', args: [] }) }, {}, {}]
    ]
    for (const [name, options, agent, runOptions] of cases) {
      const { executor, daemon, log } = setup(options)
      const desktop = local()
      const routed = aglLocalRouting(desktop, executor)
      await expect(routed.run(config(agent), 'Hi', undefined, [], { sessionKey: 'direct:c1:t1', ...runOptions }), name).resolves.toMatchObject({ text: 'desktop runtime' })
      await routed.run(config(agent), 'Hi', undefined, [], { sessionKey: 'direct:c1:t1', ...runOptions })
      expect(daemon.calls, name).toEqual([])
      expect(log.mock.calls.length, name).toBeLessThanOrEqual(1)
    }
  })

  it('falls back when agl fails before the turn starts, never after', async () => {
    const failing = fakeDaemon({ 'session.create': () => { throw new Error('agent `codex` is not available') } })
    const desktop = local()
    const log = vi.fn()
    const routed = aglLocalRouting(desktop, setup({ daemon: failing }).executor, log)
    await expect(routed.run(config(), 'Hi', undefined, [], { sessionKey: 'direct:c1:t1' })).resolves.toMatchObject({ text: 'desktop runtime' })
    expect(log).toHaveBeenCalledWith('agl.local-fallback', expect.stringContaining('agent `codex` is not available'))

    const refusing = fakeDaemon({ 'session.prompt': () => { throw new Error('session closed') } })
    await expect(aglLocalRouting(local(), setup({ daemon: refusing }).executor).run(config(), 'Hi', undefined, [], { sessionKey: 'direct:c1:t1' })).resolves.toMatchObject({ text: 'desktop runtime' })

    const daemon = fakeDaemon()
    const after = local()
    const reply = aglLocalRouting(after, setup({ daemon }).executor).run(config(), 'Hi', undefined, [], { sessionKey: 'direct:c1:t1' })
    daemon.turn(await daemon.prompted(), [], { outcome: 'failed', error: 'model overloaded' })
    await expect(reply).rejects.toThrow('model overloaded')
    expect(after.run).not.toHaveBeenCalled()
  })

  it('runs Codex through agl, and prepares its session there', async () => {
    const { daemon, executor } = setup()
    const desktop = local()
    const routed = aglLocalRouting(desktop, executor)
    await routed.prepare!(config(), { sessionKey: 'direct:c1:t1' })
    expect(daemon.calls[0].params).toMatchObject({ warm: true, visibility: 'local', history: false })
    expect(desktop.prepare).not.toHaveBeenCalled()
    const reply = routed.run(config(), 'Hi', undefined, [], { sessionKey: 'direct:c1:t1' })
    daemon.turn(await daemon.prompted(), [], { text: 'from agl' })
    await expect(reply).resolves.toMatchObject({ text: 'from agl' })
    expect(desktop.run).not.toHaveBeenCalled()
    expect(daemon.methods().filter(method => method === 'session.create')).toHaveLength(1)
  })
})

it('rejects AglUnavailable for a turn it cannot plan', async () => {
  const { executor } = setup({ enabled: () => false })
  await expect(executor.run(config(), 'Hi')).rejects.toBeInstanceOf(AglUnavailable)
})
