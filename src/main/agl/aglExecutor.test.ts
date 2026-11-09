import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentExecutor, LocalProgress } from '../../shared/agentExecutor'
import type { AgentConfig } from '../../shared/types'
import { AglExecutor, aglAccess, routingExecutor, type AglTarget } from './aglExecutor'
import { AglHub, type AglEventEnvelope, type AglTransport } from './aglHub'

const config = (extra: Partial<AgentConfig> = {}): AgentConfig => ({ id: 'agent-1', name: 'Coder', localAgentId: 'custom:x', role: '', instructions: '', color: '', provider: 'local', model: 'default', createdAt: 0, ownerId: 'me', ...extra } as AgentConfig)
const target: AglTarget = { machineId: 'mac-1', agent: 'claude', label: 'Studio' }
const envelope = (seq: number, event: AglEventEnvelope['event']): AglEventEnvelope => ({ session_id: 's1', seq, event })

/** A scripted service: methods answer from `answers`, event polls take the next batch (or wait until aborted). */
function fakeHub(answers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const batches: AglEventEnvelope[][] = []
  const waiting: Array<() => void> = []
  const polls: Array<{ sessionId: string; afterSeq: number }> = []
  let sessions = 0
  const hub = {
    call: vi.fn(async (_machine: string, method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (answers[method]) return answers[method](params)
      if (method === 'session.create') return { id: `s${++sessions}`, turns: 0 }
      if (method === 'session.prompt') return { session_id: params.session_id, turn_id: params.turn_id }
      return {}
    }),
    events: vi.fn(async (_machine: string, sessionId: string, afterSeq: number, signal?: AbortSignal) => {
      polls.push({ sessionId, afterSeq })
      while (!batches.length) {
        await new Promise<void>((resolve, reject) => {
          waiting.push(resolve)
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      const events = batches.shift()!
      return { events, lastSeq: events.reduce((max, item) => Math.max(max, item.seq), afterSeq) }
    })
  }
  const push = (...events: AglEventEnvelope[]): void => { batches.push(events); waiting.splice(0).forEach(resolve => resolve()) }
  const turnId = (index = 0): string => calls.filter(call => call.method === 'session.prompt')[index]?.params.turn_id as string
  return { hub: hub as unknown as Pick<AglHub, 'call' | 'events'>, calls, push, polls, turnId, methods: () => calls.map(call => call.method) }
}

const flush = async (): Promise<void> => { for (let index = 0; index < 10; index++) await Promise.resolve() }
/** Waits until the executor has sent its n-th prompt. */
async function prompted(fake: ReturnType<typeof fakeHub>, count = 1): Promise<string> {
  await vi.waitFor(() => expect(fake.calls.filter(call => call.method === 'session.prompt')).toHaveLength(count))
  return fake.turnId(count - 1)
}

afterEach(() => { vi.useRealTimers() })

describe('AglExecutor', () => {
  it('creates one session per session key, prompts it and returns the final text from events', async () => {
    const fake = fakeHub()
    const executor = new AglExecutor({ hub: fake.hub, resolve: async () => target })
    const reply = executor.run(config(), 'Full transcript', undefined, [], { sessionKey: 'direct:c1:t1', continuationPrompt: 'Only the new message' })
    const turn = await prompted(fake)
    expect(fake.calls[0]).toEqual({ method: 'session.create', params: { agent: 'claude', access: 'ask', name: expect.stringMatching(/^douchat-[0-9a-f]{24}$/) } })
    expect(fake.calls[1].params).toMatchObject({ session_id: 's1', text: 'Full transcript', turn_id: turn })
    fake.push(envelope(1, { kind: 'user_message', turn_id: turn, text: 'Full transcript' }), envelope(2, { kind: 'turn_started', turn_id: turn }),
      envelope(3, { kind: 'text_delta', text: 'Hello' }), envelope(4, { kind: 'text_delta', text: ' world' }), envelope(5, { kind: 'turn_ended', turn_id: turn, outcome: 'completed' }))
    await expect(reply).resolves.toEqual({ text: 'Hello world', images: [] })

    // The same key reuses the session, sends only the continuation, and reads events after the last seq.
    const second = executor.run(config(), 'Full transcript 2', undefined, [], { sessionKey: 'direct:c1:t1', continuationPrompt: 'Second message' })
    const next = await prompted(fake, 2)
    expect(fake.methods().filter(method => method === 'session.create')).toHaveLength(1)
    expect(fake.calls.at(-1)!.params).toMatchObject({ session_id: 's1', text: 'Second message' })
    fake.push(envelope(6, { kind: 'turn_started', turn_id: next }), envelope(7, { kind: 'text_delta', text: 'Again' }), envelope(8, { kind: 'turn_ended', turn_id: next, outcome: 'completed' }))
    await expect(second).resolves.toMatchObject({ text: 'Again' })
    expect(fake.polls.at(-1)!.afterSeq).toBe(5)

    // Another session key gets its own session.
    const other = executor.run(config(), 'Other chat', undefined, [], { sessionKey: 'direct:c2:t1' })
    const third = await prompted(fake, 3)
    expect(fake.calls.at(-1)!.params.session_id).toBe('s2')
    fake.push(envelope(1, { kind: 'turn_started', turn_id: third }), envelope(2, { kind: 'turn_ended', turn_id: third, outcome: 'completed' }))
    await expect(other).resolves.toMatchObject({ text: '' })
  })

  it('ignores events of other turns and redelivered seqs', async () => {
    const fake = fakeHub()
    const executor = new AglExecutor({ hub: fake.hub, resolve: async () => target })
    const reply = executor.run(config(), 'Hi', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await prompted(fake)
    fake.push(envelope(1, { kind: 'turn_started', turn_id: 'local-turn' }), envelope(2, { kind: 'text_delta', text: 'not mine' }), envelope(3, { kind: 'turn_ended', turn_id: 'local-turn', outcome: 'completed' }),
      envelope(4, { kind: 'turn_started', turn_id: turn }), envelope(5, { kind: 'text_delta', text: 'mine' }))
    fake.push(envelope(5, { kind: 'text_delta', text: 'mine' }), envelope(6, { kind: 'turn_ended', turn_id: turn, outcome: 'completed' }))
    await expect(reply).resolves.toMatchObject({ text: 'mine' })
  })

  it('shows commentary and tool calls as progress, never as part of the answer, and reports once a second', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fake = fakeHub()
    const progress: LocalProgress[] = []
    const executor = new AglExecutor({ hub: fake.hub, resolve: async () => target, progressIntervalMs: 1_000 })
    const reply = executor.run(config(), 'Fix it', undefined, [], { sessionKey: 'direct:c1:t1', onProgress: item => progress.push(item) })
    const turn = await prompted(fake)
    expect(progress[0]).toMatchObject({ phase: 'connecting', elapsedSeconds: 0 })
    fake.push(envelope(1, { kind: 'turn_started', turn_id: turn }), envelope(2, { kind: 'text_delta', phase: 'commentary', text: 'I will read the tests first.' }))
    await vi.waitFor(() => expect(progress.at(-1)).toMatchObject({ phase: 'working', detail: 'I will read the tests first.' }))
    fake.push(envelope(3, { kind: 'tool_start', call_id: 'c1', name: 'Bash', input: { command: 'npm test' } }))
    await vi.waitFor(() => expect(progress.at(-1)?.detail).toBe('Bash: npm test'))
    const reports = progress.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(progress.length).toBeGreaterThanOrEqual(reports + 3)
    expect(progress.at(-1)!.silentSeconds).toBeGreaterThanOrEqual(2)
    fake.push(envelope(4, { kind: 'text_delta', text: 'All tests pass.' }), envelope(5, { kind: 'turn_ended', turn_id: turn, outcome: 'completed' }))
    await expect(reply).resolves.toMatchObject({ text: 'All tests pass.' })
    const count = progress.length
    await vi.advanceTimersByTimeAsync(3_000)
    expect(progress).toHaveLength(count)
  })

  it('asks the owner for a forwarded permission request and answers agl with the decision', async () => {
    const fake = fakeHub()
    const approvals: Array<{ message: string; details: string }> = []
    let decide!: (allowed: boolean) => void
    const onApproval = vi.fn((request: { message: string; details: string }) => {
      approvals.push(request)
      return new Promise<void>((resolve, reject) => { decide = allowed => allowed ? resolve() : reject(new Error('Denied')) })
    })
    const progress: LocalProgress[] = []
    const executor = new AglExecutor({ hub: fake.hub, resolve: async () => target, progressIntervalMs: 10 })
    const reply = executor.run(config(), 'Deploy', undefined, [], { sessionKey: 'direct:c1:t1', onApproval, onProgress: item => progress.push(item) })
    const turn = await prompted(fake)
    fake.push(envelope(1, { kind: 'turn_started', turn_id: turn }),
      envelope(2, { kind: 'permission_request', request_id: 'auto', tool: 'Read', title: 'Read a file', input: {}, options: [], decided_by: 'policy' }),
      envelope(3, { kind: 'permission_request', request_id: 'r1', tool: 'Bash', title: 'Run rm -rf build', input: { command: 'rm -rf build' }, options: [] }))
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalledTimes(1))
    // Requests agl decided itself are not asked again.
    expect(approvals[0].message).toBe('claude: Run rm -rf build')
    expect(JSON.parse(approvals[0].details)).toEqual({ tool: 'Bash', title: 'Run rm -rf build', input: { command: 'rm -rf build' } })
    await vi.waitFor(() => expect(progress.at(-1)?.phase).toBe('approval'))
    decide(true)
    await vi.waitFor(() => expect(fake.calls.find(call => call.method === 'session.approve')?.params).toEqual({ session_id: 's1', request_id: 'r1', decision: 'allow' }))
    fake.push(envelope(4, { kind: 'permission_resolved', request_id: 'r1', decision: 'allow', by: 'client' }),
      envelope(5, { kind: 'permission_request', request_id: 'r2', tool: 'Bash', title: 'Push', input: {}, options: [] }))
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalledTimes(2))
    decide(false)
    await vi.waitFor(() => expect(fake.calls.filter(call => call.method === 'session.approve').at(-1)?.params).toEqual({ session_id: 's1', request_id: 'r2', decision: 'deny' }))
    fake.push(envelope(6, { kind: 'turn_ended', turn_id: turn, outcome: 'completed' }))
    await reply
    expect(fake.methods().filter(method => method === 'session.approve')).toHaveLength(2)
  })

  it('denies forwarded requests when the turn has no approval handler, and stops asking once agl resolved one', async () => {
    const fake = fakeHub()
    const executor = new AglExecutor({ hub: fake.hub, resolve: async () => target })
    const reply = executor.run(config(), 'Go', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await prompted(fake)
    fake.push(envelope(1, { kind: 'turn_started', turn_id: turn }), envelope(2, { kind: 'permission_request', request_id: 'r1', tool: 'Bash', title: 'x', input: {}, options: [] }))
    await vi.waitFor(() => expect(fake.calls.find(call => call.method === 'session.approve')?.params).toMatchObject({ request_id: 'r1', decision: 'deny' }))
    fake.push(envelope(3, { kind: 'turn_ended', turn_id: turn, outcome: 'completed' }))
    await reply

    let signal: AbortSignal | undefined
    const pending = new AglExecutor({ hub: fake.hub, resolve: async () => target })
    const onApproval = vi.fn((_request: unknown, approvalSignal: AbortSignal) => { signal = approvalSignal; return new Promise<void>(() => {}) })
    const second = pending.run(config(), 'Go', undefined, [], { sessionKey: 'direct:c9:t1', onApproval })
    const next = await prompted(fake, 2)
    fake.push(envelope(1, { kind: 'turn_started', turn_id: next }), envelope(2, { kind: 'permission_request', request_id: 'r9', tool: 'Bash', title: 'x', input: {}, options: [] }))
    await vi.waitFor(() => expect(onApproval).toHaveBeenCalled())
    fake.push(envelope(3, { kind: 'permission_resolved', request_id: 'r9', decision: 'deny', by: 'timeout' }))
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    fake.push(envelope(4, { kind: 'turn_ended', turn_id: next, outcome: 'completed' }))
    await second
    expect(fake.calls.filter(call => call.method === 'session.approve').map(call => call.params.request_id)).toEqual(['r1'])
  })

  it('aborts the agl session when the turn is stopped', async () => {
    const fake = fakeHub()
    const executor = new AglExecutor({ hub: fake.hub, resolve: async () => target })
    const abort = new AbortController()
    const reply = executor.run(config(), 'Long task', abort.signal, [], { sessionKey: 'direct:c1:t1' })
    const turn = await prompted(fake)
    fake.push(envelope(1, { kind: 'turn_started', turn_id: turn }))
    await vi.waitFor(() => expect(fake.polls.length).toBeGreaterThanOrEqual(2))
    abort.abort(new Error('Stopped'))
    await expect(reply).rejects.toThrow('Stopped')
    await vi.waitFor(() => expect(fake.calls.find(call => call.method === 'session.abort')?.params).toEqual({ session_id: 's1' }))
  })

  it('fails the turn when agl reports it failed or was aborted on the device', async () => {
    const fake = fakeHub()
    const executor = new AglExecutor({ hub: fake.hub, resolve: async () => target })
    const failed = executor.run(config(), 'Go', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await prompted(fake)
    fake.push(envelope(1, { kind: 'turn_started', turn_id: turn }), envelope(2, { kind: 'text_delta', text: 'partial' }), envelope(3, { kind: 'turn_ended', turn_id: turn, outcome: 'failed', error: 'claude exited with code 1' }))
    await expect(failed).rejects.toThrow('claude exited with code 1')
    const aborted = executor.run(config(), 'Go', undefined, [], { sessionKey: 'direct:c1:t1' })
    const next = await prompted(fake, 2)
    fake.push(envelope(4, { kind: 'turn_started', turn_id: next }), envelope(5, { kind: 'turn_ended', turn_id: next, outcome: 'aborted' }))
    await expect(aborted).rejects.toThrow('The turn was stopped on Studio.')
  })

  it('starts a new session with the whole context when the device no longer has the old one', async () => {
    let prompts = 0
    const fake = fakeHub({ 'session.prompt': params => { if (prompts++ === 1) throw new Error('no session'); return { session_id: params.session_id, turn_id: params.turn_id } } })
    const executor = new AglExecutor({ hub: fake.hub, resolve: async () => target })
    const first = executor.run(config(), 'one', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await prompted(fake)
    fake.push(envelope(1, { kind: 'turn_started', turn_id: turn }), envelope(2, { kind: 'turn_ended', turn_id: turn, outcome: 'completed' }))
    await first
    const second = executor.run(config(), 'whole transcript', undefined, [], { sessionKey: 'direct:c1:t1', continuationPrompt: 'two' })
    await vi.waitFor(() => expect(fake.calls.filter(call => call.method === 'session.prompt')).toHaveLength(3))
    const retried = fake.calls.filter(call => call.method === 'session.prompt')[2].params
    expect(retried).toMatchObject({ session_id: 's2', text: 'whole transcript' })
    fake.push(envelope(1, { kind: 'turn_started', turn_id: retried.turn_id }), envelope(2, { kind: 'turn_ended', turn_id: retried.turn_id, outcome: 'completed' }))
    await second
  })

  it('closes the sessions of a conversation when its context is reset, and maps permissions to access', async () => {
    const fake = fakeHub()
    const executor = new AglExecutor({ hub: fake.hub, resolve: async () => target })
    const reply = executor.run(config(), 'Hi', undefined, [], { sessionKey: 'direct:c1:t1' })
    const turn = await prompted(fake)
    fake.push(envelope(1, { kind: 'turn_started', turn_id: turn }), envelope(2, { kind: 'turn_ended', turn_id: turn, outcome: 'completed' }))
    await reply
    executor.resetConversation('other')
    expect(fake.methods()).not.toContain('session.close')
    executor.resetConversation('c1')
    await flush()
    expect(fake.calls.find(call => call.method === 'session.close')?.params).toEqual({ session_id: 's1' })

    expect(aglAccess(config())).toBe('ask')
    expect(aglAccess(config({ permissions: { groupHumans: 'allow', groupAgents: 'allow', sensitive: { filesRead: 'allow', filesWrite: 'allow', network: 'allow', browserControl: 'ask', accountRead: 'ask', accountWrite: 'ask', automation: 'ask', localExecution: 'allow', otherTools: 'allow' } } }))).toBe('full')
  })
})

describe('AglHub', () => {
  it('follows a pending agl-request with agl-response until the device answers', async () => {
    const replies: unknown[] = [{ id: 'q1', pending: true }, { id: 'q1', pending: true }, { id: 'q1', result: [{ id: 'codex', name: 'Codex', available: true }] }]
    const send = vi.fn(async () => replies.shift()) as unknown as AglTransport
    const hub = new AglHub(send)
    await expect(hub.agents('mac-1')).resolves.toEqual([{ id: 'codex', name: 'Codex', available: true }])
    expect((send as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([body]) => body)).toEqual([
      { action: 'agl-request', machineId: 'mac-1', method: 'agents.list', params: {}, waitMs: 15_000 },
      { action: 'agl-response', machineId: 'mac-1', id: 'q1', waitMs: 15_000 },
      { action: 'agl-response', machineId: 'mac-1', id: 'q1', waitMs: 15_000 }
    ])
    const failing = new AglHub((async () => ({ id: 'q2', error: 'unknown agent' })) as unknown as AglTransport)
    await expect(failing.call('mac-1', 'session.create', { agent: 'nope' })).rejects.toThrow('unknown agent')
  })
})

describe('routingExecutor', () => {
  it('sends agents on an agl device to agl and every other agent to the local executor', async () => {
    const local: AgentExecutor = { run: vi.fn(async () => ({ text: 'local', images: [] })), prepare: vi.fn(async () => {}), disposeAgent: vi.fn(), resetConversation: vi.fn(), releaseIdleConnections: vi.fn() }
    const fake = fakeHub()
    const agl = new AglExecutor({ hub: fake.hub, resolve: async item => item.localAgentId === 'custom:device' ? target : undefined })
    const executor = routingExecutor(local, agl)
    await expect(executor.run(config({ localAgentId: 'codex' }), 'hi')).resolves.toMatchObject({ text: 'local' })
    await executor.prepare!(config({ localAgentId: 'codex' }), { sessionKey: 'direct:c:t' })
    await executor.prepare!(config({ localAgentId: 'custom:device' }), { sessionKey: 'direct:c:t' })
    expect(local.prepare).toHaveBeenCalledTimes(1)
    const remote = executor.run(config({ localAgentId: 'custom:device' }), 'hi', undefined, [], { sessionKey: 'direct:c:t' })
    const turn = await prompted(fake)
    fake.push(envelope(1, { kind: 'turn_started', turn_id: turn }), envelope(2, { kind: 'text_delta', text: 'from the device' }), envelope(3, { kind: 'turn_ended', turn_id: turn, outcome: 'completed' }))
    await expect(remote).resolves.toMatchObject({ text: 'from the device' })
    expect(local.run).toHaveBeenCalledTimes(1)
    executor.resetConversation('c', undefined, [], 'me')
    executor.disposeAgent('agent-1')
    expect(local.resetConversation).toHaveBeenCalledWith('c', undefined, [], 'me')
    expect(local.disposeAgent).toHaveBeenCalledWith('agent-1')
  })
})
