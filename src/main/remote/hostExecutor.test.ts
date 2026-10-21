import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { checkWorkspace, collectOutbox, Executor, listFolders, OWNER_TASK_CAPABILITY, parseAgentConfig, resolveProgram, type HostAgentExecutor } from '../../../host/src/executor'
import type { HostClient } from '../../../host/src/client'
import type { SeenRequests, TrustState } from '../../../host/src/state'
import { signCommand } from './ownerSigning'

const ORIGIN = 'https://douchat.test'
const OWNER = 'owner-1'
const HOST = 'hst_00000000-0000-4000-8000-000000000000'

function device() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const id = `dev_${crypto.randomUUID()}`
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x
  const signer = {
    getDeviceId: () => id,
    getDevicePublicKey: () => x,
    signAsDevice: (message: string) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url')
  }
  return {
    id, publicKey: x,
    sign: <T extends Record<string, unknown>>(method: string, payload: T) =>
      signCommand(signer as never, { serviceUrl: ORIGIN, ownerId: OWNER, hostId: HOST, method, payload })
  }
}

function program(): string {
  const dir = mkdtempSync(join(tmpdir(), 'douchat-exec-'))
  const path = join(dir, 'claude')
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
  return path
}

const memorySeen = (): SeenRequests => {
  const seen = new Set<string>()
  return { has: (id: string) => seen.has(id), add: (id: string) => { seen.add(id) } } as unknown as SeenRequests
}
const claimHash = (claim: string) => createHash('sha256').update(`claim:${claim}`).digest('hex')

/** A scripted host channel: what the service would answer, recording every call. */
function fakeService(agentsSigned: unknown, permissions?: Record<string, unknown>) {
  const calls: Record<string, any>[] = []
  let pending = [{ id: 'ot:task-1', kind: 'owner', localId: 'agent-1' }]
  const approvals: { id: string; status: string; signed: unknown }[] = []
  const client = {
    call: vi.fn(async (body: Record<string, any>) => {
      calls.push(body)
      switch (body.action) {
        case 'agents':
          return { agents: agentsSigned, agentsRevision: 1, bindings: [{ localId: 'agent-1', executor: `host:${HOST}`, state: 'enabled', configRevision: 3, permissionsRevision: 3, appliedConfigRevision: 0, appliedPermissionsRevision: 0 }] }
        case 'tasks': { const tasks = pending; pending = []; return { tasks } }
        case 'claim': return { task: { id: body.id, claim: 'claim-1', localId: 'agent-1', prompt: 'hello', bindingRevision: 2 } }
        case 'approval-request': return { approvalId: `${body.taskId}:approval:${body.requestId}`, status: 'x-approval' }
        case 'watch': return { cursor: '1', approvals: approvals.splice(0) }
        default: return {}
      }
    })
  } as unknown as HostClient
  return { client, calls, approvals, permissions }
}

describe('douchat-host executor', () => {
  it('runs absolute paths or command names found on the login PATH, nothing else', async () => {
    const executable = program()
    expect(await resolveProgram(executable, async () => undefined)).toBe(executable)
    expect(await resolveProgram('claude', async () => executable)).toBe(executable)
    await expect(resolveProgram('claude', async () => undefined)).rejects.toThrow(/not installed/)
    await expect(resolveProgram('../bin/claude', async () => executable)).rejects.toThrow(/not installed/)
  })

  it('rejects configurations without the required fields', () => {
    expect(() => parseAgentConfig({ localId: 'a' })).toThrow()
    expect(parseAgentConfig({ localId: 'a', configRevision: 1, permissionsRevision: 1, adapter: 'codex', executable: '/bin/codex', args: [] }).adapter).toBe('codex')
  })

  it('runs only owner-signed configurations and reports results', async () => {
    const owner = device()
    const trust: TrustState = { revision: 1, devices: [{ deviceId: owner.id, publicKey: owner.publicKey }] }
    const executable = program()
    const config = { localId: 'agent-1', configRevision: 3, permissionsRevision: 3, name: 'Builder', role: 'dev', instructions: '', adapter: 'claude', executable, args: ['--x'] }
    const service = fakeService(owner.sign('host.agents', { expectedAgentsRevision: 0, agents: [config] }))
    const run = vi.fn<HostAgentExecutor['run']>(async () => ({ text: 'done', images: [] }))
    const executor = new Executor({ client: service.client, origin: ORIGIN, ownerId: OWNER, hostId: HOST, trust: () => trust, seen: memorySeen(), executor: { run }, workRoot: mkdtempSync(join(tmpdir(), 'douchat-work-')), version: '0.2.0', resolveCommand: async () => undefined, log: () => undefined })
    await executor.refreshAgents()
    expect(service.calls.find(call => call.action === 'config-applied')).toMatchObject({ localId: 'agent-1', configRevision: 3 })
    await executor.claimPending()
    await vi.waitFor(() => expect(service.calls.some(call => call.action === 'complete')).toBe(true))
    const [agent, options] = run.mock.calls[0]
    const { prompt } = options
    expect(agent.localAgentId).toBe('claude')
    expect(prompt).toContain('hello')
    expect(prompt).toContain('To deliver files to the human')
    expect(options.agentOverride).toMatchObject({ id: 'claude', path: executable, args: ['--x'] })
    expect(options.agentOverride?.remote).toBeUndefined()
    expect(service.calls.find(call => call.action === 'complete')).toMatchObject({ id: 'ot:task-1', claim: 'claim-1', reply: 'done' })
  })

  it('refuses a configuration signed by an untrusted device', async () => {
    const owner = device()
    const stranger = device()
    const trust: TrustState = { revision: 1, devices: [{ deviceId: owner.id, publicKey: owner.publicKey }] }
    const service = fakeService(stranger.sign('host.agents', { expectedAgentsRevision: 0, agents: [] }))
    const executor = new Executor({ client: service.client, origin: ORIGIN, ownerId: OWNER, hostId: HOST, trust: () => trust, seen: memorySeen(), executor: { run: vi.fn() }, workRoot: tmpdir(), version: '0.2.0', resolveCommand: async () => undefined, log: () => undefined })
    await expect(executor.refreshAgents()).rejects.toThrow(/does not trust/)
  })

  it('fails the task when the signed program is missing on the server', async () => {
    const owner = device()
    const trust: TrustState = { revision: 1, devices: [{ deviceId: owner.id, publicKey: owner.publicKey }] }
    const config = { localId: 'agent-1', configRevision: 3, permissionsRevision: 3, name: 'Builder', role: '', instructions: '', adapter: 'codex', executable: '/nonexistent/codex', args: [] }
    const service = fakeService(owner.sign('host.agents', { expectedAgentsRevision: 0, agents: [config] }))
    const run = vi.fn<HostAgentExecutor['run']>()
    const executor = new Executor({ client: service.client, origin: ORIGIN, ownerId: OWNER, hostId: HOST, trust: () => trust, seen: memorySeen(), executor: { run }, workRoot: tmpdir(), version: '0.2.0', resolveCommand: async () => undefined, log: () => undefined })
    await executor.refreshAgents()
    await executor.claimPending()
    await vi.waitFor(() => expect(service.calls.some(call => call.action === 'complete')).toBe(true))
    expect(run).not.toHaveBeenCalled()
    expect(service.calls.find(call => call.action === 'complete')).toMatchObject({ failed: true })
  })

  it('asks the owner and accepts only a matching signed approval', async () => {
    const owner = device()
    const trust: TrustState = { revision: 1, devices: [{ deviceId: owner.id, publicKey: owner.publicKey }] }
    const config = { localId: 'agent-1', configRevision: 3, permissionsRevision: 3, name: 'Builder', role: '', instructions: '', adapter: 'claude', executable: program(), args: [] }
    const service = fakeService(owner.sign('host.agents', { expectedAgentsRevision: 0, agents: [config] }))
    let approved: Promise<void> | undefined
    const run = vi.fn<HostAgentExecutor['run']>(async (_config, { signal, onApproval }) => {
      approved = onApproval!({ message: 'Run rm -rf build', details: '{}' }, signal!)
      await approved
      return { text: 'ran', images: [] }
    })
    const executor = new Executor({ client: service.client, origin: ORIGIN, ownerId: OWNER, hostId: HOST, trust: () => trust, seen: memorySeen(), executor: { run }, workRoot: tmpdir(), version: '0.2.0', resolveCommand: async () => undefined, log: () => undefined })
    await executor.refreshAgents()
    await executor.claimPending()
    await vi.waitFor(() => expect(service.calls.some(call => call.action === 'approval-request')).toBe(true))
    const request = service.calls.find(call => call.action === 'approval-request')!
    const approvalId = `${request.taskId}:approval:${request.requestId}`
    const answer = (signer: ReturnType<typeof device>, paramsHash = request.paramsHash) => ({
      id: approvalId, status: 'x-allowed',
      signed: signer.sign('task.approval', { approvalId, taskId: request.taskId, requestId: request.requestId, paramsHash, bindingRevision: 2, claimHash: claimHash('claim-1'), decision: 'allow', scope: 'once' })
    })
    // Neither a stranger's signature nor an answer for other parameters counts.
    service.approvals.push(answer(device()), answer(owner, 'f'.repeat(64)))
    ;(executor as unknown as { decide(item: unknown): void }).decide(service.approvals[0])
    ;(executor as unknown as { decide(item: unknown): void }).decide(service.approvals[1])
    expect(service.calls.some(call => call.action === 'complete')).toBe(false)
    ;(executor as unknown as { decide(item: unknown): void }).decide(answer(owner))
    await vi.waitFor(() => expect(service.calls.find(call => call.action === 'complete')).toMatchObject({ reply: 'ran' }))
  })

  it('follows the service on a web-added host and answers discovery', async () => {
    const config = { localId: 'agent-1', configRevision: 3, permissionsRevision: 3, name: 'Builder', role: '', instructions: '', adapter: 'claude', executable: program(), args: [] }
    // Unsigned: a payload exactly as the service stores it for a web-added host.
    const service = fakeService({ payload: { expectedAgentsRevision: 0, agents: [config] } })
    const run = vi.fn<HostAgentExecutor['run']>(async (_config, { signal, onApproval }) => { await onApproval!({ message: 'Run ls', details: '{}' }, signal!); return { text: 'ok', images: [] } })
    const executor = new Executor({ client: service.client, origin: ORIGIN, ownerId: OWNER, hostId: HOST, trust: () => ({ revision: 0, devices: [] }), seen: memorySeen(), executor: { run }, workRoot: tmpdir(), version: '0.2.0',
      resolveCommand: async (command) => command === 'claude' ? config.executable : undefined, readVersion: async () => '2.1.0', log: () => undefined, serviceTrusted: true })
    await executor.refreshAgents()
    expect(service.calls.find(call => call.action === 'config-applied')).toMatchObject({ localId: 'agent-1' })
    await executor.claimPending()
    await vi.waitFor(() => expect(service.calls.some(call => call.action === 'approval-request')).toBe(true))
    const request = service.calls.find(call => call.action === 'approval-request')!
    const approvalId = `${request.taskId}:approval:${request.requestId}`
    ;(executor as unknown as { decide(item: unknown): void }).decide({ id: approvalId, status: 'x-allowed', signed: { payload: { approvalId, taskId: request.taskId, requestId: request.requestId, paramsHash: request.paramsHash, bindingRevision: 2, claimHash: claimHash('claim-1'), decision: 'allow' } } })
    await vi.waitFor(() => expect(service.calls.find(call => call.action === 'complete')).toMatchObject({ reply: 'ok' }))
    expect(await executor.discover()).toEqual([{ adapter: 'claude', executable: config.executable, version: '2.1.0' }])
  })

  it('advertises owner tasks in its heartbeat', async () => {
    const service = fakeService(null)
    const stop = new AbortController()
    const executor = new Executor({ client: service.client, origin: ORIGIN, ownerId: OWNER, hostId: HOST, trust: () => ({ revision: 1, devices: [] }), seen: memorySeen(), executor: { run: vi.fn() }, workRoot: tmpdir(), version: '0.2.0', resolveCommand: async () => undefined, log: () => undefined,
      sleep: async () => { stop.abort() } })
    await executor.run(stop.signal)
    expect(service.calls.find(call => call.action === 'heartbeat')).toMatchObject({ capabilities: [OWNER_TASK_CAPABILITY], version: '0.2.0' })
  })

  it('runs any adapter and custom commands, with the model and a conversation session', async () => {
    const executable = program()
    const config = { localId: 'agent-1', configRevision: 3, permissionsRevision: 3, name: 'Tool', role: '', instructions: '', adapter: 'custom', executable, args: ['--ask', '{prompt}'], model: 'gpt-x' }
    const service = fakeService({ payload: { agents: [config] } })
    // The claimed task carries a session key and a short follow-up prompt.
    const call = service.client.call as ReturnType<typeof vi.fn>
    const original = call.getMockImplementation()!
    call.mockImplementation(async (body: Record<string, any>) => body.action === 'claim'
      ? { task: { id: body.id, claim: 'claim-1', localId: 'agent-1', prompt: 'full history', continuation: 'just the new message', sessionKey: 'direct:c1:t1:', bindingRevision: 2 } }
      : original(body))
    const run = vi.fn<HostAgentExecutor['run']>(async () => ({ text: 'ok', images: [] }))
    const executor = new Executor({ client: service.client, origin: ORIGIN, ownerId: OWNER, hostId: HOST, trust: () => ({ revision: 0, devices: [] }), seen: memorySeen(), executor: { run }, workRoot: mkdtempSync(join(tmpdir(), 'douchat-work-')), version: '0.2.0', resolveCommand: async () => undefined, log: () => undefined, serviceTrusted: true })
    await executor.refreshAgents()
    expect(service.calls.find(item => item.action === 'config-applied')).toBeTruthy()
    await executor.claimPending()
    await vi.waitFor(() => expect(service.calls.some(item => item.action === 'complete')).toBe(true))
    const [agent, options] = run.mock.calls[0]
    expect(agent.model).toBe('gpt-x')
    expect(options.agentOverride).toMatchObject({ id: 'custom', custom: true, args: ['--ask', '{prompt}'] })
    expect(options.transient).toBeUndefined()
    expect(options.workspaceDirectory).toBeTruthy()
    expect(options.sessionKey).toMatch(/^host:[0-9a-f]{32}$/)
    expect(options.continuationPrompt).toContain('just the new message')
  })

  it('collects images and outbox files within the delivery limits', () => {
    const outbox = mkdtempSync(join(tmpdir(), 'douchat-outbox-'))
    writeFileSync(join(outbox, 'report.md'), '# done')
    writeFileSync(join(outbox, 'chart.png'), Buffer.from([1, 2, 3]))
    writeFileSync(join(outbox, 'huge.bin'), Buffer.alloc(9 * 1024 * 1024))
    mkdirSync(join(outbox, 'folder'))
    const result = collectOutbox(outbox, [{ name: 'gen.png', mimeType: 'image/png', data: new Uint8Array([9]) }])
    expect(result.images.map(item => item.name)).toEqual(['gen.png', 'chart.png'])
    expect(result.files.map(item => item.name)).toEqual(['report.md'])
    expect(result.skipped).toEqual(['huge.bin'])
  })

  it('remembers "Allow for this task" for the same tool', async () => {
    const config = { localId: 'agent-1', configRevision: 3, permissionsRevision: 3, name: 'Builder', role: '', instructions: '', adapter: 'claude', executable: program(), args: [] }
    const service = fakeService({ payload: { agents: [config] } })
    const run = vi.fn<HostAgentExecutor['run']>(async (_config, { signal, onApproval }) => {
      await onApproval!({ message: 'Claude: Bash', details: '{"a":1}' }, signal!)
      await onApproval!({ message: 'Claude: Bash', details: '{"a":2}' }, signal!)
      return { text: 'ran twice', images: [] }
    })
    const executor = new Executor({ client: service.client, origin: ORIGIN, ownerId: OWNER, hostId: HOST, trust: () => ({ revision: 0, devices: [] }), seen: memorySeen(), executor: { run }, workRoot: tmpdir(), version: '0.2.0', resolveCommand: async () => undefined, log: () => undefined, serviceTrusted: true })
    await executor.refreshAgents()
    await executor.claimPending()
    await vi.waitFor(() => expect(service.calls.some(item => item.action === 'approval-request')).toBe(true))
    const request = service.calls.find(item => item.action === 'approval-request')!
    expect(request.taskScope).toBe('Claude: Bash')
    const approvalId = `${request.taskId}:approval:${request.requestId}`
    ;(executor as unknown as { decide(item: unknown): void }).decide({ id: approvalId, status: 'x-allowed', signed: { payload: { approvalId, taskId: request.taskId, requestId: request.requestId, paramsHash: request.paramsHash, bindingRevision: 2, claimHash: claimHash('claim-1'), decision: 'allow', scope: 'task' } } })
    await vi.waitFor(() => expect(service.calls.find(item => item.action === 'complete')).toMatchObject({ reply: 'ran twice' }))
    expect(service.calls.filter(item => item.action === 'approval-request')).toHaveLength(1)
  })

  it('accepts only real project folders inside the home folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'douchat-home-'))
    mkdirSync(join(home, 'projects', 'app'), { recursive: true })
    mkdirSync(join(home, '.ssh'))
    expect(listFolders(undefined, undefined, home).directories).toEqual(['projects'])
    expect(checkWorkspace(join(home, 'projects', 'app'), home)).toMatch(/projects\/app$/)
    expect(() => checkWorkspace(home, home)).toThrow(/home folder/)
    expect(() => checkWorkspace(join(home, '.ssh'), home)).toThrow(/SSH or Douchat data/)
    expect(() => checkWorkspace(join(home, 'missing'), home)).toThrow(/missing/)
  })

  it('hands the human\'s images and files to the agent', async () => {
    const config = { localId: 'agent-1', configRevision: 3, permissionsRevision: 3, name: 'Reader', role: '', instructions: '', adapter: 'claude', executable: program(), args: [] }
    const service = fakeService({ payload: { agents: [config] } })
    const call = service.client.call as ReturnType<typeof vi.fn>
    const original = call.getMockImplementation()!
    call.mockImplementation(async (body: Record<string, any>) => body.action === 'claim'
      ? { task: { id: body.id, claim: 'claim-1', localId: 'agent-1', prompt: 'look', bindingRevision: 2,
        images: [{ name: 'id.jpg', mimeType: 'image/jpeg', base64: Buffer.from([1, 2]).toString('base64') }],
        files: [{ name: 'notes.txt', base64: Buffer.from('hello').toString('base64') }] } }
      : original(body))
    let seenFile = ''
    const run = vi.fn<HostAgentExecutor['run']>(async (_config, { prompt }) => {
      const path = /\n(\/[^\n]+notes\.txt)/.exec(prompt)?.[1]
      seenFile = path ? (await import('node:fs')).readFileSync(path, 'utf8') : ''
      return { text: 'seen', images: [] }
    })
    const executor = new Executor({ client: service.client, origin: ORIGIN, ownerId: OWNER, hostId: HOST, trust: () => ({ revision: 0, devices: [] }), seen: memorySeen(), executor: { run }, workRoot: mkdtempSync(join(tmpdir(), 'douchat-work-')), version: '0.2.0', resolveCommand: async () => undefined, log: () => undefined, serviceTrusted: true })
    await executor.refreshAgents()
    await executor.claimPending()
    await vi.waitFor(() => expect(service.calls.some(item => item.action === 'complete')).toBe(true))
    const images = run.mock.calls[0][1].images
    expect(images?.map(image => [image.name, image.mimeType, image.data.length])).toEqual([['id.jpg', 'image/jpeg', 2]])
    expect(seenFile).toBe('hello')
  })
})
