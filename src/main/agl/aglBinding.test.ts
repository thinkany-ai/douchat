import { afterEach, expect, it, vi } from 'vitest'
import type { AglSettings, AglStatusView } from '../../shared/agl'
import { AGL_ADAPTER_IDS, AglBinder, aglAdapterFor, aglLinkHealthy, eligibleAglAgents, type AglBindIdentity, type BindableAgent, type BindableLocalAgent } from './aglBinding'

const CATALOG = { claude: 'claude', codex: 'codex', gemini: 'gemini', grok: 'grok', openclaw: 'openclaw', hermes: 'hermes', opencode: 'opencode', cursor: 'cursor-agent', kimi: 'kimi', omp: 'omp', fastclaw: 'fastclaw' }
const local = (id: string, extra: Partial<BindableLocalAgent> = {}): BindableLocalAgent => ({ id, command: CATALOG[id as keyof typeof CATALOG] ?? id, installed: true, ...extra })
const agent = (id: string, localAgentId: string | undefined, extra: Partial<BindableAgent> = {}): BindableAgent => ({ id, localAgentId, ownerId: 'alice', ...extra })
const everyAgl = AGL_ADAPTER_IDS.map(id => ({ id, available: true }))

afterEach(() => { vi.useRealTimers() })

it('maps desktop catalog ids 1:1 to agl adapters; FastClaw and custom agents have none', () => {
  for (const id of ['codex', 'claude', 'gemini', 'opencode', 'kimi', 'grok', 'openclaw', 'hermes', 'omp', 'cursor']) expect(aglAdapterFor(id)).toBe(id)
  expect(aglAdapterFor('fastclaw')).toBeUndefined()
  expect(aglAdapterFor('custom:123')).toBeUndefined()
  expect(aglAdapterFor(undefined)).toBeUndefined()
})

it('binds only built-in local agents agl can run as they are', () => {
  const agents = [
    agent('a-codex', 'codex'), agent('a-cursor', 'cursor'), agent('a-claude', 'claude'),
    agent('a-args', 'gemini', { startupArgs: ['--yolo'] }),
    agent('a-custom-command', 'kimi'),
    agent('a-cli-args', 'opencode'),
    agent('a-not-installed', 'grok'),
    agent('a-fastclaw', 'fastclaw'), agent('a-custom', 'custom:1'), agent('a-cloud', undefined),
    agent('a-other-owner', 'codex', { ownerId: 'bob' }),
    agent('a-agl-missing', 'hermes')
  ]
  const localAgents = [local('codex'), local('cursor'), local('claude'), local('gemini'), local('kimi', { command: '/opt/kimi-fork' }), local('opencode', { args: ['--fast'] }),
    local('grok', { installed: false }), local('fastclaw'), local('custom:1', { custom: true }), local('hermes')]
  const aglAgents = everyAgl.map(item => item.id === 'hermes' ? { ...item, available: false } : item)
  expect(eligibleAglAgents({ platform: 'darwin', accountId: 'alice', agents, localAgents, catalogCommands: CATALOG, aglAgents })).toEqual([
    { agentId: 'a-claude', aglAgent: 'claude' }, { agentId: 'a-codex', aglAgent: 'codex' }, { agentId: 'a-cursor', aglAgent: 'cursor' }
  ])
  // Agents on another machine (SSH, douchat-host, agl device) are never bound to this one.
  for (const extra of [{ connectionId: 'c' }, { daemon: { connectionId: 'c', hostId: 'h', label: 'x' } }, { agl: { connectionId: 'c', machineId: 'm', agent: 'codex', label: 'x' } }])
    expect(eligibleAglAgents({ platform: 'darwin', accountId: 'alice', agents: [agent('a', 'codex')], localAgents: [local('codex', extra)], catalogCommands: CATALOG, aglAgents: everyAgl })).toEqual([])
  expect(eligibleAglAgents({ platform: 'win32', accountId: 'alice', agents, localAgents, catalogCommands: CATALOG, aglAgents })).toEqual([])
})

it('calls the link healthy only while agl runs, knows its machine and its Douchat link is connected', () => {
  const view = { state: 'running' as const, machineId: 'm-1', linked: true, hubStatus: 'connected' }
  expect(aglLinkHealthy(view)).toBe(true)
  expect(aglLinkHealthy({ ...view, hubStatus: 'unauthorized' })).toBe(false)
  expect(aglLinkHealthy({ ...view, linked: false })).toBe(false)
  expect(aglLinkHealthy({ ...view, state: 'stopped' })).toBe(false)
  expect(aglLinkHealthy({ ...view, machineId: undefined })).toBe(false)
})

function setup(extra: { settings?: Partial<AglSettings>; view?: Partial<AglStatusView> } = {}) {
  let view: AglStatusView = { state: 'running', home: '/h', minimumVersion: '0.3.12', running: true, machineId: 'm-1', linked: true, hubStatus: 'connected', update: {}, ...extra.view }
  let settings: Partial<AglSettings> = extra.settings ?? {}
  let identity: AglBindIdentity | undefined = { id: 'alice', token: 't-alice' }
  let agents: BindableAgent[] = [agent('a-codex', 'codex'), agent('a-claude', 'claude')]
  const listeners = new Set<(view: AglStatusView) => void>()
  const post = vi.fn(async (_identity: AglBindIdentity, body: Record<string, unknown>) => (body.action === 'agl-bind' ? { bound: (body.agents as unknown[]).length } : { ok: true }) as never)
  const localAgents = vi.fn(async () => [local('codex'), local('claude'), local('gemini')])
  const binder = new AglBinder({
    platform: 'darwin',
    lifecycle: { view: () => view, onStatus: listener => { listeners.add(listener); return () => listeners.delete(listener) } },
    settings: () => settings, identity: () => identity, post, agents: () => agents, localAgents, catalogCommands: CATALOG,
    aglAgents: async () => everyAgl, cwd: async () => '/data/local-workspaces/agl', debounceMs: 1_000
  })
  return {
    binder, post, localAgents,
    setView: (next: Partial<AglStatusView>) => { view = { ...view, ...next }; for (const listener of listeners) listener(view) },
    setSettings: (next: Partial<AglSettings>) => { settings = next },
    signIn: (next: AglBindIdentity | undefined) => { identity = next },
    setAgents: (next: BindableAgent[]) => { agents = next }
  }
}
const bindCalls = (post: ReturnType<typeof setup>['post']) => post.mock.calls.filter(call => call[1].action === 'agl-bind')

it('binds once the link works, with the machine, the workspace root and the eligible agents', async () => {
  vi.useFakeTimers()
  const machine = setup()
  machine.binder.start()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(machine.post).toHaveBeenCalledTimes(1)
  expect(machine.post).toHaveBeenCalledWith({ id: 'alice', token: 't-alice' }, {
    action: 'agl-bind', machineId: 'm-1', cwd: '/data/local-workspaces/agl',
    agents: [{ agentId: 'a-claude', aglAgent: 'claude' }, { agentId: 'a-codex', aglAgent: 'codex' }]
  })
  expect(machine.binder.routedAgents()).toEqual(new Set(['a-claude', 'a-codex']))
  expect(machine.binder.routesConversation('direct-a-codex')).toBe(true)
  expect(machine.binder.routesConversation('direct-someone-else')).toBe(false)
  expect(machine.binder.routesConversation('group-1')).toBe(false)
  // Status pushes with nothing new send nothing again.
  machine.setView({ busy: false })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(machine.post).toHaveBeenCalledTimes(1)
  machine.binder.dispose()
})

it('waits for the link: nothing is bound while agl is not linked, then binds when the link appears', async () => {
  vi.useFakeTimers()
  const machine = setup({ view: { linked: false, hubStatus: undefined } })
  machine.binder.start()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(machine.post).not.toHaveBeenCalled()
  expect(machine.binder.routedAgents()).toEqual(new Set())
  machine.setView({ linked: true, hubStatus: 'connected' })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(bindCalls(machine.post)).toHaveLength(1)
  machine.binder.dispose()
})

it('rebinds, debounced, when the eligible agents change', async () => {
  vi.useFakeTimers()
  const machine = setup()
  machine.binder.start()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(bindCalls(machine.post)).toHaveLength(1)
  // Bursts of snapshot broadcasts collapse into one bind.
  const next = [agent('a-codex', 'codex'), agent('a-claude', 'claude'), agent('a-gemini', 'gemini')]
  machine.setAgents(next)
  for (let index = 0; index < 5; index++) { machine.binder.agentsChanged(next); await vi.advanceTimersByTimeAsync(200) }
  await vi.advanceTimersByTimeAsync(1_000)
  expect(bindCalls(machine.post)).toHaveLength(2)
  expect(bindCalls(machine.post)[1][1].agents).toEqual([{ agentId: 'a-claude', aglAgent: 'claude' }, { agentId: 'a-codex', aglAgent: 'codex' }, { agentId: 'a-gemini', aglAgent: 'gemini' }])
  // Launch arguments make an agent ineligible: it is dropped from the set.
  const withArgs = [agent('a-codex', 'codex', { startupArgs: ['--x'] }), agent('a-claude', 'claude'), agent('a-gemini', 'gemini')]
  machine.setAgents(withArgs)
  machine.binder.agentsChanged(withArgs)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(bindCalls(machine.post)).toHaveLength(3)
  expect(bindCalls(machine.post)[2][1].agents).toEqual([{ agentId: 'a-claude', aglAgent: 'claude' }, { agentId: 'a-gemini', aglAgent: 'gemini' }])
  expect(machine.binder.routedAgents().has('a-codex')).toBe(false)
  // Unrelated changes (a cloud agent) do not even look at the local CLIs again.
  const calls = machine.localAgents.mock.calls.length
  machine.binder.agentsChanged([...withArgs, agent('cloud', undefined)])
  await vi.advanceTimersByTimeAsync(2_000)
  expect(machine.localAgents.mock.calls.length).toBe(calls)
  machine.binder.dispose()
})

it('unbinds as the previous account when another account signs in, then binds for the new one', async () => {
  vi.useFakeTimers()
  const machine = setup()
  machine.binder.start()
  await vi.advanceTimersByTimeAsync(1_000)
  machine.signIn({ id: 'bob', token: 't-bob' })
  machine.setAgents([agent('b-codex', 'codex', { ownerId: 'bob' })])
  // Bindings made for alice are not honoured for bob.
  expect(machine.binder.routedAgents()).toEqual(new Set())
  await machine.binder.sync()
  const calls = machine.post.mock.calls
  expect(calls[1]).toEqual([{ id: 'alice', token: 't-alice' }, { action: 'agl-unbind', machineId: 'm-1' }])
  expect(calls[2]).toEqual([{ id: 'bob', token: 't-bob' }, { action: 'agl-bind', machineId: 'm-1', cwd: '/data/local-workspaces/agl', agents: [{ agentId: 'b-codex', aglAgent: 'codex' }] }])
  expect(machine.binder.routedAgents()).toEqual(new Set(['b-codex']))
  machine.binder.dispose()
})

it('unbinds before sign-out or unlink and when agl is turned off, and stops routing while the link is broken', async () => {
  vi.useFakeTimers()
  const machine = setup()
  machine.binder.start()
  await vi.advanceTimersByTimeAsync(1_000)
  machine.setView({ hubStatus: 'unauthorized' })
  expect(machine.binder.routedAgents()).toEqual(new Set())
  machine.setView({ hubStatus: 'connected' })
  expect(machine.binder.routedAgents().size).toBe(2)

  await machine.binder.unbind('sign-out')
  expect(machine.post).toHaveBeenLastCalledWith({ id: 'alice', token: 't-alice' }, { action: 'agl-unbind', machineId: 'm-1' })
  expect(machine.binder.routedAgents()).toEqual(new Set())
  // Nothing bound: a second unbind sends nothing.
  const count = machine.post.mock.calls.length
  await machine.binder.unbind('unlink')
  expect(machine.post.mock.calls.length).toBe(count)

  await machine.binder.sync()
  expect(machine.binder.routedAgents().size).toBe(2)
  machine.setSettings({ enabled: false })
  machine.setView({ state: 'off' })
  await vi.advanceTimersByTimeAsync(0)
  expect(machine.post).toHaveBeenLastCalledWith({ id: 'alice', token: 't-alice' }, { action: 'agl-unbind', machineId: 'm-1' })
  expect(machine.binder.routedAgents()).toEqual(new Set())
  machine.binder.dispose()
})

it('forgets the bindings even when the service cannot be reached, and retries a failed bind later', async () => {
  vi.useFakeTimers()
  const machine = setup()
  machine.post.mockRejectedValueOnce(new Error('offline'))
  machine.binder.start()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(machine.binder.routedAgents()).toEqual(new Set())
  await machine.binder.sync()
  expect(machine.binder.routedAgents().size).toBe(2)
  machine.post.mockRejectedValueOnce(new Error('offline'))
  await machine.binder.unbind()
  expect(machine.binder.routedAgents()).toEqual(new Set())
  machine.binder.dispose()
})
