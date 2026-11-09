import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addCustomLocalAgent, configureAglDetection, configureLocalAgentRegistry, connectionRegistry, detectLocalAgents, findDesktopApp, remoteAgentPlacement, removeCustomLocalAgent, setConnectionAccount, updateLocalAgent, validateLocalAgent, hasRemoteAgent } from './localAgents'
import { resolveExecutable } from './shellPath'
vi.mock('./shellPath', () => ({ resolveExecutable: vi.fn() }))
let registryDirectory = ''
beforeEach(async () => {
  vi.mocked(resolveExecutable).mockReset()
  registryDirectory = await mkdtemp(join(tmpdir(), 'douchat-local-agents-'))
  configureLocalAgentRegistry(registryDirectory)
})
afterEach(async () => {
  configureLocalAgentRegistry()
  await rm(registryDirectory, { recursive: true, force: true })
})
describe('local agent discovery', () => {
  it('lists the full catalog and supports every detected command', async () => {
    const agents = await detectLocalAgents({
      executable: async (command) => ['codex', 'grok', 'openclaw'].includes(command) ? `/local/bin/${command}` : undefined,
      desktopApp: async () => undefined,
      version: async (path) => path.endsWith('/codex') ? 'codex-cli 1.2.3' : undefined
    })
    expect(agents).toHaveLength(11)
    expect(agents.find((agent) => agent.id === 'codex')).toMatchObject({ installed: true, discovered: true, status: 'ready', chatSupported: true, path: '/local/bin/codex', version: 'codex-cli 1.2.3' })
    expect(agents.find((agent) => agent.id === 'grok')).toMatchObject({ installed: true, chatSupported: true, path: '/local/bin/grok' })
    expect(agents.find((agent) => agent.id === 'openclaw')).toMatchObject({ installed: true, chatSupported: true })
    expect(agents.find((agent) => agent.id === 'claude')?.installed).toBe(false)
    expect(agents.at(-1)?.id).toBe('fastclaw')
  })
  it('reports a desktop app separately instead of pretending it is a compatible CLI', async () => {
    const agents = await detectLocalAgents({
      executable: async () => undefined,
      desktopApp: async (names) => names.includes('Claude.app') ? '/Applications/Claude.app' : undefined
    })
    expect(agents.find((agent) => agent.id === 'claude')).toMatchObject({
      installed: false,
      discovered: true,
      status: 'desktop-only',
      desktopPath: '/Applications/Claude.app',
      authentication: 'unchecked'
    })
  })
  it('looks for macOS apps in each supplied application root', async () => {
    await expect(findDesktopApp(['Definitely Missing Douchat Fixture.app'], ['/missing/one', '/missing/two'])).resolves.toBeUndefined()
  })
  it('persists a custom command and discovers it without a shell', async () => {
    await addCustomLocalAgent({ name: 'My Agent', command: '/opt/tools/my-agent' })
    const agents = await detectLocalAgents({
      executable: async (command) => command === '/opt/tools/my-agent' ? command : undefined,
      desktopApp: async () => undefined
    })
    const custom = agents.find((agent) => agent.custom)
    expect(custom).toMatchObject({
      name: 'My Agent', command: '/opt/tools/my-agent', installed: true,
      status: 'ready', custom: true
    })
    await removeCustomLocalAgent(custom!.id)
    await expect(detectLocalAgents({ executable: async () => undefined, desktopApp: async () => undefined })).resolves.toHaveLength(11)
  })
  it('validates only the requested CLI instead of probing the whole catalog', async () => {
    vi.mocked(resolveExecutable).mockResolvedValue('/local/bin/codex')
    await validateLocalAgent('codex')
    expect(resolveExecutable).toHaveBeenCalledExactlyOnceWith('codex')
  })
  it('persists builtin overrides without duplicating or changing its adapter', async () => {
    await updateLocalAgent('codex', { name: 'Work Codex', command: '/tools/codex', args: ['--profile', 'work'], avatar: 'data:image/png;base64,YQ==' })
    configureLocalAgentRegistry(registryDirectory)
    vi.mocked(resolveExecutable).mockImplementation(async command => command)
    const agent = await validateLocalAgent('codex')
    expect(agent).toMatchObject({ id: 'codex', name: 'Work Codex', path: '/tools/codex', custom: undefined, args: ['--profile', 'work'], avatar: 'data:image/png;base64,YQ==' })
    const all = await detectLocalAgents({ executable: async () => undefined, desktopApp: async () => undefined })
    expect(all).toHaveLength(11)
    await expect(removeCustomLocalAgent('codex')).rejects.toThrow('Invalid custom')
  })
  it('edits a custom command in place and preserves simultaneous registry writes', async () => {
    await Promise.all([
      addCustomLocalAgent({ name: 'First', command: 'first' }),
      addCustomLocalAgent({ name: 'Second', command: 'second' })
    ])
    const scan = () => detectLocalAgents({ executable: async () => undefined, desktopApp: async () => undefined })
    const first = (await scan()).find(item => item.name === 'First')!
    await updateLocalAgent(first.id, { name: 'Renamed', command: '/new/path', args: ['--prompt', '{prompt}'] })
    const all = await scan()
    expect(all.filter(item => item.custom)).toHaveLength(2)
    expect(all.find(item => item.id === first.id)).toMatchObject({ name: 'Renamed', command: '/new/path', args: ['--prompt', '{prompt}'] })
    await expect(updateLocalAgent('unknown', { name: 'Bad', command: 'bad' })).rejects.toThrow('Unknown')
    await expect(updateLocalAgent(first.id, { name: 'Bad', command: 'bad', args: ['bad\0arg'] })).rejects.toThrow('arguments')
    await expect(updateLocalAgent(first.id, { name: 'Bad', command: 'bad', avatar: 'https://example.com/a.png' })).rejects.toThrow('avatar')
  })
  it('rejects stale installation state and unknown commands', async () => {
    await expect(validateLocalAgent('codex')).rejects.toThrow('not installed')
    vi.mocked(resolveExecutable).mockResolvedValue('/local/bin/openclaw')
    await expect(validateLocalAgent('openclaw')).resolves.toMatchObject({ id: 'openclaw', chatSupported: true })
    await expect(validateLocalAgent('arbitrary-shell-command')).rejects.toThrow('Unknown')
  })
})

it('returns installed agents even when their version command never settles', async () => {
  vi.useFakeTimers()
  try {
    const version = vi.fn(() => new Promise<string | undefined>(() => {}))
    const result = detectLocalAgents({ executable: async () => '/bin/tool', desktopApp: async () => undefined, version }, 'codex')
    await vi.waitFor(() => expect(version).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(8100)
    expect(await result).toMatchObject([{ id: 'codex', installed: true, version: undefined }])
  } finally { vi.useRealTimers() }
})
it('bounds an entire scan when executable discovery never settles', async () => {
  vi.useFakeTimers()
  try {
    const result = detectLocalAgents({ executable: () => new Promise(() => {}), desktopApp: async () => undefined }, 'codex')
    const assertion = expect(result).rejects.toThrow('Local agent detection timed out')
    await vi.advanceTimersByTimeAsync(15001)
    await assertion
  } finally { vi.useRealTimers() }
})

describe('agents on connections', () => {
  const connections = () => connectionRegistry()
  const binding = (connectionId: string) => ({ connectionId, adapter: 'codex' as const, executable: 'codex', args: [] as string[] })
  it('refuses inline SSH settings and unknown connections', async () => {
    await expect(addCustomLocalAgent({ name: 'Remote', command: 'codex', remote: { transport: 'ssh', host: 'box', adapter: 'codex', executable: 'codex', args: [] } })).rejects.toThrow(/connection first/)
    await expect(addCustomLocalAgent({ name: 'Remote', command: 'codex', remoteAgent: binding(`conn_${'0'.repeat(32)}`) })).rejects.toThrow(/connection/)
  })
  it('hides agents on a douchat-host added by another account, with the host', async () => {
    const host = await connections().saveDaemon({ name: 'Mac', daemon: { hostId: `hst_${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, serviceUrl: 'https://douchat.ai', ownerId: 'alice' } })
    const id = await addCustomLocalAgent({ name: 'Codex · Mac', command: 'codex', remoteAgent: binding(host.id) })
    const listed = async () => (await detectLocalAgents({ executable: async () => undefined, desktopApp: async () => undefined })).some(agent => agent.id === id)
    try {
      setConnectionAccount('bob')
      expect(await listed()).toBe(false)
      setConnectionAccount('alice')
      expect(await listed()).toBe(true)
    } finally { setConnectionAccount('') }
  })
  it('runs on the connection and is identified by it, changing identity only when the server changes', async () => {
    const connection = await connections().save({ name: 'Box', ssh: { host: 'box', user: 'me' } })
    const id = await addCustomLocalAgent({ name: 'Remote', command: 'codex', remoteAgent: binding(connection.id) })
    const placement = await remoteAgentPlacement(id)
    expect(placement?.spec).toMatchObject({ host: 'box', user: 'me', adapter: 'codex', executable: 'codex' })
    expect(placement?.target).toEqual({ executionTargetId: `ssh:${connection.id}`, targetRevision: 0 })
    // Renaming the connection is not a new target; editing the user is.
    await connections().save({ id: connection.id, name: 'Renamed', ssh: { host: 'box', user: 'me' } })
    expect((await remoteAgentPlacement(id))?.target.targetRevision).toBe(0)
    await connections().save({ id: connection.id, name: 'Renamed', ssh: { host: 'box', user: 'root' } })
    expect((await remoteAgentPlacement(id))?.target.targetRevision).toBe(1)
    await connections().save({ id: connection.id, name: 'Renamed', ssh: { host: 'box', user: 'me' } })
    expect((await remoteAgentPlacement(id))?.target.targetRevision).toBe(2)
    expect(await remoteAgentPlacement('codex')).toBeUndefined()
  })
  it('never runs while its connection is off or removed, and shows why', async () => {
    const connection = await connections().save({ name: 'Box', ssh: { host: 'box' } })
    const id = await addCustomLocalAgent({ name: 'Remote', command: 'codex', remoteAgent: binding(connection.id) })
    await connections().setEnabled(connection.id, false)
    await expect(remoteAgentPlacement(id)).rejects.toThrow(/turned off/)
    await expect(validateLocalAgent(id)).rejects.toThrow()
    expect((await detectLocalAgents({ desktopApp: async () => undefined })).find(agent => agent.id === id)).toMatchObject({ unavailable: 'disabled', installed: false, connectionName: 'Box', remoteAgent: binding(connection.id) })
    await connections().remove(connection.id)
    await expect(remoteAgentPlacement(id)).rejects.toThrow(/removed/)
    expect((await detectLocalAgents({ desktopApp: async () => undefined })).find(agent => agent.id === id)?.unavailable).toBe('missing')
  })
  it('knows which executables are already added on a connection', async () => {
    const connection = await connections().save({ name: 'Box', ssh: { host: 'box' } })
    const other = await connections().save({ name: 'Other', ssh: { host: 'other' } })
    expect(await hasRemoteAgent(connection.id, 'codex')).toBe(false)
    await addCustomLocalAgent({ name: 'Remote', command: 'codex', remoteAgent: binding(connection.id) })
    expect(await hasRemoteAgent(connection.id, 'codex')).toBe(true)
    expect(await hasRemoteAgent(connection.id, '/usr/bin/codex')).toBe(false)
    expect(await hasRemoteAgent(other.id, 'codex')).toBe(false)
  })
  it('still rejects arguments that disable the sandbox', async () => {
    const connection = await connections().save({ name: 'Box', ssh: { host: 'box' } })
    await expect(addCustomLocalAgent({ name: 'Remote', command: 'codex', remoteAgent: { ...binding(connection.id), args: ['--yolo'] } })).rejects.toThrow(/safety boundary/)
  })
})

describe('detection through agl (experimental setting)', () => {
  const agl = async () => [
    { id: 'codex', name: 'Codex', protocol: 'codex', available: true, path: '/agl/found/codex', version: 'codex-cli 9.9.9', features: [], status: 'ready' as const },
    { id: 'claude', name: 'Claude Code', protocol: 'claude', available: false, features: [], status: 'not-found' as const },
    { id: 'fastclaw', name: 'FastClaw', protocol: 'acp', available: true, path: '/agl/fastclaw', features: [] }
  ]
  const probes = { executable: async (command: string) => `/desktop/bin/${command}`, desktopApp: async () => undefined, version: async () => 'desktop probe' }

  it('takes agents agl supports from agl, and the rest from the desktop’s probes', async () => {
    const agents = await detectLocalAgents({ ...probes, agl })
    expect(agents.find(agent => agent.id === 'codex')).toMatchObject({ installed: true, path: '/agl/found/codex', version: 'codex-cli 9.9.9' })
    // agl's answer stands, even where the desktop would have found something.
    expect(agents.find(agent => agent.id === 'claude')).toMatchObject({ installed: false, status: 'not-found' })
    // Not in agl's list, or not one agl runs: the desktop's probes as before.
    expect(agents.find(agent => agent.id === 'gemini')).toMatchObject({ installed: true, path: '/desktop/bin/gemini', version: 'desktop probe' })
    expect(agents.find(agent => agent.id === 'fastclaw')).toMatchObject({ path: '/desktop/bin/fastclaw' })
  })

  it('is off unless configured, and falls back when agl cannot answer', async () => {
    expect((await detectLocalAgents(probes)).find(agent => agent.id === 'codex')?.path).toBe('/desktop/bin/codex')
    configureAglDetection(agl)
    try {
      expect((await detectLocalAgents(probes)).find(agent => agent.id === 'codex')?.path).toBe('/agl/found/codex')
      expect((await detectLocalAgents({ ...probes, agl: null })).find(agent => agent.id === 'codex')?.path).toBe('/desktop/bin/codex')
    } finally { configureAglDetection(undefined) }
    expect((await detectLocalAgents({ ...probes, agl: async () => undefined })).find(agent => agent.id === 'codex')?.path).toBe('/desktop/bin/codex')
    expect((await detectLocalAgents({ ...probes, agl: async () => { throw new Error('down') } })).find(agent => agent.id === 'codex')?.path).toBe('/desktop/bin/codex')
  })
})
