import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionManager, KEEPALIVE_MS, RETRY_DELAYS, parseDiscovery } from './connectionManager'
import { ConnectionStore } from './connectionStore'
import { REMOTE_BOOTSTRAP, discoverScript, encodePayload } from './remoteScript'

vi.mock('./remoteTransport', async (original) => ({ ...await original<object>(), closeRemoteConnections: vi.fn(async () => {}) }))

let directory = ''
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'douchat-manager-')) })
afterEach(() => { vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }) })

describe('connection state machine', () => {
  it('goes connecting → connected, keeps alive, backs off on errors and never checks while disabled', async () => {
    vi.useFakeTimers()
    const store = new ConnectionStore(join(directory, 'connections.json'))
    const check = vi.fn<(connection: unknown) => Promise<number>>()
    const manager = new ConnectionManager(store, async () => ['custom:a'], check)
    const states: string[] = []
    manager.onStatus((_id, status) => states.push(status.state))
    const saved = await store.save({ name: 'Box', ssh: { host: 'box' } })

    check.mockResolvedValueOnce(12)
    await manager.refresh(saved.id)
    expect(manager.status(saved.id)).toEqual({ state: 'connected', latencyMs: 12, agents: 1 })
    expect(states).toEqual(['connecting', 'connected'])

    // Keep-alive every 60s; a failure then retries after 5s, 15s, 60s, 5 min, 5 min.
    check.mockRejectedValue(new Error('Could not connect to box.'))
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS)
    expect(manager.status(saved.id)).toMatchObject({ state: 'error', message: 'Could not connect to box.' })
    for (const delay of [...RETRY_DELAYS, RETRY_DELAYS.at(-1)!]) {
      const calls = check.mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(check.mock.calls.length).toBe(calls)
      await vi.advanceTimersByTimeAsync(1)
      expect(check.mock.calls.length).toBe(calls + 1)
    }

    // A window gaining focus retries at once.
    check.mockResolvedValue(5)
    const calls = check.mock.calls.length
    manager.retryFailed()
    await vi.advanceTimersByTimeAsync(0)
    expect(check.mock.calls.length).toBe(calls + 1)
    expect(manager.status(saved.id).state).toBe('connected')

    // Turning it off stops all checks.
    await manager.setEnabled(saved.id, false)
    const off = check.mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * KEEPALIVE_MS)
    expect(check.mock.calls.length).toBe(off)
    expect(manager.status(saved.id)).toEqual({ state: 'disabled' })
    manager.stop()
  })

  it('discards a result for the old target and checks the edited one right away', async () => {
    const store = new ConnectionStore(join(directory, 'connections.json'))
    const hosts: string[] = []
    let finish!: (value: number) => void
    const manager = new ConnectionManager(store, async () => [], (connection: any) => { hosts.push(connection.ssh.host); return hosts.length === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve(7) })
    const saved = await store.save({ name: 'Box', ssh: { host: 'box' } })
    const pending = manager.refresh(saved.id)
    await vi.waitFor(() => expect(hosts).toEqual(['box']))
    await store.save({ id: saved.id, name: 'Box', ssh: { host: 'other' } })
    const second = manager.refresh(saved.id)
    finish(3)
    await Promise.all([pending, second])
    expect(hosts).toEqual(['box', 'other'])
    expect(manager.status(saved.id)).toMatchObject({ state: 'connected', latencyMs: 7 })
    manager.stop()
  })

  it('does not report an error or retry for a connection removed or turned off during a failing check', async () => {
    vi.useFakeTimers()
    const store = new ConnectionStore(join(directory, 'connections.json'))
    let fail!: (error: Error) => void
    const check = vi.fn(() => new Promise<number>((_resolve, reject) => { fail = reject }))
    const manager = new ConnectionManager(store, async () => [], check)
    const saved = await store.save({ name: 'Box', ssh: { host: 'box' } })
    const pending = manager.refresh(saved.id)
    await vi.advanceTimersByTimeAsync(0)
    await store.setEnabled(saved.id, false)
    fail(new Error('down'))
    await pending
    expect(manager.status(saved.id).state).not.toBe('error')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(check).toHaveBeenCalledTimes(1)
    manager.stop()
  })

  it('lists connections with their agents and status', async () => {
    const store = new ConnectionStore(join(directory, 'connections.json'))
    const manager = new ConnectionManager(store, async id => id ? ['custom:a', 'custom:b'] : [], async () => 1)
    const saved = await store.save({ name: 'Box', ssh: { host: 'box', user: 'me', port: 2200 } })
    await store.setEnabled(saved.id, false)
    expect(await manager.list()).toEqual([expect.objectContaining({ id: saved.id, label: 'me@box:2200', agentIds: ['custom:a', 'custom:b'], status: { state: 'disabled' } })])
  })
})

describe('connections per account', () => {
  it('shows and checks a douchat-host only while the account that added it is signed in', async () => {
    const store = new ConnectionStore(join(directory, 'connections.json'))
    const check = vi.fn(async () => 1)
    const manager = new ConnectionManager(store, async () => [], async () => 1)
    manager.setDaemonBackend({ check, discover: async () => [], revoke: async () => {} })
    const ssh = await store.save({ name: 'Box', ssh: { host: 'box' } })
    const host = await store.saveDaemon({ name: 'Mac', daemon: { hostId: `hst_${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, serviceUrl: 'https://douchat.ai', ownerId: 'alice' } })
    const ids = async () => (await manager.list()).map(item => item.id)
    expect(await ids()).toEqual([ssh.id])
    await manager.setAccount('bob')
    expect(await ids()).toEqual([ssh.id])
    expect(check).not.toHaveBeenCalled()
    await manager.setAccount('alice')
    expect((await ids()).sort()).toEqual([ssh.id, host.id].sort())
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1))
    manager.stop()
  })
})

describe('agl devices', () => {
  it('shows a device only to its account, checks it through the agl backend and revokes it on removal', async () => {
    const store = new ConnectionStore(join(directory, 'connections.json'))
    const backend = { check: vi.fn(async () => 7), revoke: vi.fn(async () => {}) }
    const manager = new ConnectionManager(store, async () => [], async () => { throw new Error('never over SSH') })
    manager.setAglBackend(backend)
    const device = await store.saveAgl({ name: 'Studio', agl: { machineId: 'mac-1', serviceUrl: 'https://douchat.ai', ownerId: 'alice' } })
    expect(await manager.list()).toEqual([])
    await manager.setAccount('alice')
    expect((await manager.list()).map(item => item.id)).toEqual([device.id])
    await vi.waitFor(() => expect(manager.status(device.id)).toMatchObject({ state: 'connected', latencyMs: 7 }))
    backend.check.mockRejectedValueOnce(new Error('Device is offline'))
    expect(await manager.test(device.id)).toMatchObject({ ok: false, steps: [{ name: 'host', passed: false, message: 'Device is offline' }] })
    await expect(manager.save({ id: device.id, name: 'x', ssh: { host: 'box' } })).rejects.toThrow('Discover → Devices & Environments')
    await expect(manager.discover(device.id)).rejects.toThrow('Discover → Devices & Environments')
    await manager.remove(device.id)
    expect(backend.revoke).toHaveBeenCalledWith(expect.objectContaining({ id: device.id }))
    expect(await store.list()).toEqual([])
    manager.stop()
  })
})

describe('agent discovery', () => {
  it('accepts only known CLIs at absolute, normalized paths and trims hostile versions', () => {
    const output = [
      'codex\t/home/me/.nvm/versions/node/v22/bin/codex\tcodex-cli 0.50.0',
      'claude\t/usr/local/bin/claude\t2.0.1 (Claude Code)\x1b[31m',
      'codex\t/other/codex\tduplicate',
      'gemini\trelative/gemini\t1',
      'grok\t/usr/bin/../bin/grok\t1',
      'cursor-agent\t/usr/bin/not-cursor\t1',
      'rm\t/bin/rm\t1',
      'opencode\t/opt/opencode\t' + 'x'.repeat(500),
      ''
    ].join('\n')
    expect(parseDiscovery(output)).toEqual([
      { adapter: 'codex', executable: '/home/me/.nvm/versions/node/v22/bin/codex', version: 'codex-cli 0.50.0' },
      { adapter: 'claude', executable: '/usr/local/bin/claude', version: '2.0.1 (Claude Code)[31m' },
      { adapter: 'opencode', executable: '/opt/opencode', version: 'x'.repeat(120) }
    ])
  })

  it('finds CLIs through the login PATH with their versions, in a real shell', { timeout: 20_000 }, async () => {
    const home = join(directory, 'home'), bin = join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    for (const [name, version] of [['codex', 'codex-cli 9.9.9'], ['claude', '1.2.3 (Claude Code)']]) {
      await writeFile(join(bin, name), `#!/bin/sh\n[ "$1" = --version ] && echo '${version}'\n`)
      await chmod(join(bin, name), 0o755)
    }
    // A login shell whose PATH puts the user's folder first, as a server's .profile would.
    const shell = join(home, 'login-shell')
    await writeFile(shell, `#!/bin/sh\nPATH=${bin}:/usr/bin:/bin; export PATH\nshift\nexec /bin/sh -c "$1"\n`)
    await chmod(shell, 0o755)
    const result = spawnSync('/bin/sh', ['-c', `${REMOTE_BOOTSTRAP} ${encodePayload(discoverScript())}`], { env: { HOME: home, PATH: '/usr/bin:/bin', SHELL: shell }, cwd: home })
    expect(result.status).toBe(0)
    const found = parseDiscovery(result.stdout.toString())
    expect(found.filter(item => item.executable.startsWith(bin))).toEqual([
      { adapter: 'codex', executable: join(bin, 'codex'), version: 'codex-cli 9.9.9' },
      { adapter: 'claude', executable: join(bin, 'claude'), version: '1.2.3 (Claude Code)' }
    ])
  })
})
