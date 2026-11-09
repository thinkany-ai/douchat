import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionEvent } from './aglClient'
import { AglLifecycle, canApplyUpdates, planDaemon, type AglDaemonConnection, type AglLifecycleOptions } from './aglLifecycle'
import type { AglStatusJson } from './aglStatus'

const status = (extra: Partial<AglStatusJson> = {}): AglStatusJson => ({ running: true, service: true, hubs: [], busy: 0, daemonVersion: '0.3.12', ...extra })

it('plans the daemon: the service for the default home, `agl start` for any other', () => {
  expect(planDaemon(status({ running: false, service: false }), '0.3.12', true)).toBe('service-install')
  expect(planDaemon(status({ running: false, service: true }), '0.3.12', true)).toBe('service-start')
  // The per-user service would be repointed at another home: never touched for one.
  expect(planDaemon(status({ running: false, service: true }), '0.3.12', false)).toBe('start')
  expect(planDaemon(status({ running: false, service: false }), '0.3.12', false)).toBe('start')
  expect(planDaemon(status(), '0.3.12', true)).toBe('none')
  expect(planDaemon(status({ service: false }), '0.3.12', false)).toBe('none')
})

it('restarts a daemon older than its binary only while idle', () => {
  expect(planDaemon(status({ daemonVersion: '0.3.11' }), '0.3.12', true)).toBe('service-install')
  expect(planDaemon(status({ daemonVersion: '0.3.11' }), '0.3.12', false)).toBe('restart')
  expect(planDaemon(status({ daemonVersion: '0.3.11', busy: 1 }), '0.3.12', true)).toBe('defer')
  expect(planDaemon(status({ service: false, busy: 3 }), '0.3.12', true)).toBe('defer')
  // A daemon newer than the binary (unusual, but the user's choice) stays.
  expect(planDaemon(status({ daemonVersion: '0.4.0' }), '0.3.12', true)).toBe('none')
  expect(planDaemon(status({ daemonVersion: '0.3.11' }), undefined, true)).toBe('none')
})

it('applies updates only where agl’s restart cannot repoint the user’s service', () => {
  expect(canApplyUpdates(true, { service: true })).toBe(true)
  expect(canApplyUpdates(false, { service: false })).toBe(true)
  expect(canApplyUpdates(false, { service: true })).toBe(false)
})

/** A fake `agl` with the state a real one keeps. */
function fakeAgl(initial: { binary?: string; bundled?: string; running?: boolean; daemon?: string; service?: boolean; busy?: number; hubs?: AglStatusJson['hubs']; latest?: string } = {}) {
  const machine = { binary: initial.binary as string | undefined, binaryExists: initial.binary !== undefined, bundled: initial.bundled, running: initial.running ?? false,
    daemon: initial.daemon ?? initial.binary, service: initial.service ?? false, busy: initial.busy ?? 0, hubs: initial.hubs ?? [], latest: initial.latest ?? initial.binary }
  const commands: string[] = []
  const listeners = new Set<(event: ConnectionEvent) => void>()
  const calls: string[] = []
  const connection: AglDaemonConnection = {
    call: vi.fn(async (method: string) => { calls.push(method); return (method === 'ping' ? { pong: true, version: machine.daemon, protocol: 1 } : { ok: true }) as never }),
    onConnection: (listener: (event: ConnectionEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    close: vi.fn()
  }
  const run: AglLifecycleOptions['run'] = vi.fn(async (file, args, options) => {
    const who = file === '/app/bin/agl' ? 'bundled' : file === '/home/.agl/bin/agl' ? 'agl' : file
    commands.push(`${who} ${args.join(' ')}`.trim())
    expect(options.env.AGL_HOME).toBe('/home/.agl')
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    if (args[0] === '--version') return ok(`agl ${who === 'bundled' ? machine.bundled : machine.binary}\n`)
    if (who !== 'agl') return ok()
    switch (args.join(' ')) {
      case 'status --json': return ok(JSON.stringify({ version: machine.binary, running: machine.running, daemon_version: machine.running ? machine.daemon : null, busy: machine.running ? machine.busy : null,
        machine_id: 'machine-1', service: machine.service, hubs: machine.hubs }))
      case 'service install': machine.service = true; machine.running = true; machine.daemon = machine.binary; return ok()
      case 'start': machine.running = true; machine.daemon = machine.binary; return ok()
      case 'stop': machine.running = false; return ok()
      case 'update --check --json': return ok(JSON.stringify({ current: machine.binary, latest: machine.latest, update_available: machine.latest !== machine.binary, updated: false }))
      case 'update --if-idle --json': {
        if (machine.busy) return ok(JSON.stringify({ current: machine.binary, latest: machine.latest, update_available: true, updated: false, busy: machine.busy }))
        machine.binary = machine.latest; machine.daemon = machine.latest
        return ok(JSON.stringify({ current: machine.binary, latest: machine.latest, update_available: true, updated: true }))
      }
    }
    if (args[0] === 'connect') { machine.hubs = [{ url: args[1], status: 'connected' }]; return ok() }
    return { code: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
  })
  const ensureExtraPaths = vi.fn(async () => ({ changed: true, extraPaths: ['/douchat/local-tools/agents/bin'] }))
  const options = (extra: Partial<AglLifecycleOptions> = {}): AglLifecycleOptions => ({
    platform: 'darwin', enabled: true, home: '/home/.agl', defaultHome: true, bundledBin: '/app/bin/agl', run,
    fileExists: async (path) => path === '/app/bin/agl' ? Boolean(machine.bundled) : path === '/home/.agl/bin/agl' ? machine.binaryExists : false,
    installBinary: vi.fn(async () => { machine.binary = machine.bundled; machine.binaryExists = true }),
    environment: async () => ({ PATH: '/usr/bin' }), connect: vi.fn(async () => connection),
    extraPaths: () => ['/douchat/local-tools/agents/bin'], ownedRoot: '/douchat/local-tools', ensureExtraPaths,
    serviceStartCommand: () => ({ file: 'launchctl', args: ['kickstart', 'gui/501/cc.agl.daemon'] }),
    startWaitMs: 0, sleep: async () => undefined, firstUpdateCheckMs: 60_000, updateIntervalMs: 12 * 3_600_000, ...extra
  })
  const emit = (event: ConnectionEvent) => { for (const listener of listeners) listener(event) }
  return { machine, commands, calls, connection, run, ensureExtraPaths, options, emit }
}

let lifecycle: AglLifecycle | undefined
afterEach(() => { lifecycle?.dispose(); lifecycle = undefined; vi.useRealTimers() })

it('first launch: installs the bundled agl and the service, connects, and adds Douchat’s CLI folders', async () => {
  const agl = fakeAgl({ bundled: '0.3.12' })
  lifecycle = new AglLifecycle(agl.options())
  const view = await lifecycle.refresh()
  expect(agl.commands).toEqual(['bundled --version', 'agl --version', 'agl status --json', 'agl service install', 'agl status --json'])
  expect(view).toMatchObject({ state: 'running', version: '0.3.12', bundledVersion: '0.3.12', running: true, service: true, machineId: 'machine-1', linked: false })
  expect(view.busy).toBeUndefined()
  expect(agl.ensureExtraPaths).toHaveBeenCalledWith('/home/.agl', ['/douchat/local-tools/agents/bin'], '/douchat/local-tools')
  expect(agl.calls).toEqual(['ping', 'env.reload'])
  expect(lifecycle.client()).toBe(agl.connection)
})

it('never downgrades a newer agl, and uses a running daemon as it is', async () => {
  const agl = fakeAgl({ binary: '0.4.1', bundled: '0.3.12', running: true, service: true })
  lifecycle = new AglLifecycle(agl.options())
  expect(await lifecycle.refresh()).toMatchObject({ state: 'running', version: '0.4.1', bundledVersion: '0.3.12' })
  expect(agl.options().installBinary).not.toHaveBeenCalled()
  expect(agl.commands).toEqual(['bundled --version', 'agl --version', 'agl status --json'])
})

it('upgrades an older agl and restarts its daemon onto it once idle', async () => {
  const agl = fakeAgl({ binary: '0.3.11', bundled: '0.3.12', running: true, service: true, busy: 1 })
  const options = agl.options()
  lifecycle = new AglLifecycle(options)
  // Busy: the binary is replaced (the running daemon keeps its copy), the restart waits.
  expect(await lifecycle.refresh()).toMatchObject({ state: 'needs-update', version: '0.3.12', daemonVersion: '0.3.11' })
  expect(options.installBinary).toHaveBeenCalledWith('/app/bin/agl', '/home/.agl/bin/agl')
  expect(agl.commands).not.toContain('agl service install')
  agl.machine.busy = 0
  expect(await lifecycle.refresh()).toMatchObject({ state: 'running', version: '0.3.12' })
  expect(agl.commands.filter(command => command === 'agl service install')).toHaveLength(1)
})

it('starts the service’s daemon when it is down, falling back to agl start', async () => {
  const agl = fakeAgl({ binary: '0.3.12', bundled: '0.3.12', running: false, service: true })
  lifecycle = new AglLifecycle(agl.options())
  expect(await lifecycle.refresh()).toMatchObject({ state: 'running' })
  expect(agl.commands).toContain('launchctl kickstart gui/501/cc.agl.daemon')
  expect(agl.commands).toContain('agl start')
  expect(agl.commands).not.toContain('agl service install')
})

it('with a custom agl home, never installs or uses the per-user service', async () => {
  const agl = fakeAgl({ bundled: '0.3.12', running: false, service: true })
  lifecycle = new AglLifecycle(agl.options({ defaultHome: false }))
  expect(await lifecycle.refresh()).toMatchObject({ state: 'running' })
  expect(lifecycle.view().service).toBeUndefined()
  expect(agl.commands.filter(command => /service|launchctl/.test(command))).toEqual([])
  expect(agl.commands).toContain('agl start')
  // Nor does it let `agl update` restart through that service.
  agl.machine.latest = '0.3.13'
  await lifecycle.checkForUpdates(true)
  expect(agl.commands).toContain('agl update --check --json')
  expect(agl.commands).not.toContain('agl update --if-idle --json')
  expect(lifecycle.view().update).toMatchObject({ latest: '0.3.13', available: true })
})

it('reports needs-update for an agl older than 0.3.12 it cannot replace, and asks agl to update', async () => {
  vi.useFakeTimers()
  const agl = fakeAgl({ binary: '0.3.11', running: true, service: true, latest: '0.3.12' })
  lifecycle = new AglLifecycle(agl.options({ bundledBin: undefined }))
  const view = await lifecycle.refresh()
  expect(view).toMatchObject({ state: 'needs-update', version: '0.3.11' })
  expect(view.error).toContain('older than 0.3.12')
  expect(lifecycle.client()).toBeUndefined()
  await vi.advanceTimersByTimeAsync(0)
  await vi.waitFor(() => expect(lifecycle!.view().state).toBe('running'))
  expect(agl.commands).toContain('agl update --if-idle --json')
  expect(lifecycle.view()).toMatchObject({ version: '0.3.12', update: { appliedVersion: '0.3.12', available: false } })
})

it('reports a missing agl, and errors without throwing', async () => {
  const agl = fakeAgl({})
  lifecycle = new AglLifecycle(agl.options({ bundledBin: undefined }))
  expect(await lifecycle.refresh()).toMatchObject({ state: 'not-installed', running: false })
  const broken = fakeAgl({ binary: '0.3.12' })
  broken.machine.binaryExists = true
  const failing = new AglLifecycle(broken.options({ run: async (_file, args) => args[0] === '--version' ? { code: 0, stdout: 'agl 0.3.12', stderr: '' } : { code: 2, stdout: '', stderr: 'boom' } }))
  expect(await failing.refresh()).toMatchObject({ state: 'error', error: expect.stringContaining('boom') })
  failing.dispose()
})

it('waits while sessions are busy, and checks for updates on a schedule', async () => {
  vi.useFakeTimers()
  const agl = fakeAgl({ binary: '0.3.12', running: true, service: true, busy: 2, latest: '0.3.13' })
  lifecycle = new AglLifecycle(agl.options())
  lifecycle.start()
  await vi.waitFor(() => expect(lifecycle!.view().state).toBe('running'))
  expect(agl.commands).not.toContain('agl update --check --json')
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(lifecycle!.view().update.busy).toBe(2))
  expect(lifecycle.view().update).toMatchObject({ latest: '0.3.13', available: true })
  agl.machine.busy = 0
  await vi.advanceTimersByTimeAsync(12 * 3_600_000)
  await vi.waitFor(() => expect(lifecycle!.view().update.appliedVersion).toBe('0.3.13'))
  expect(agl.commands.filter(command => command === 'agl update --if-idle --json')).toHaveLength(2)
})

it('tells listeners about a daemon restart and recovers a daemon that went away', async () => {
  vi.useFakeTimers()
  const agl = fakeAgl({ binary: '0.3.12', running: true, service: false })
  lifecycle = new AglLifecycle(agl.options({ defaultHome: false }))
  await lifecycle.refresh()
  const restarted = vi.fn()
  lifecycle.onRestart(restarted)
  agl.emit({ state: 'reconnected', restarted: false })
  expect(restarted).not.toHaveBeenCalled()
  agl.emit({ state: 'reconnected', restarted: true })
  expect(restarted).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(lifecycle!.view().busy).toBeUndefined())
  agl.machine.running = false
  agl.emit({ state: 'disconnected' })
  expect(lifecycle.view().state).toBe('stopped')
  await vi.advanceTimersByTimeAsync(5_000)
  await vi.waitFor(() => expect(lifecycle!.view().state).toBe('running'))
  expect(agl.commands.at(-2)).toBe('agl start')
})

it('links to a hub without logging the code, and leaves Windows and disabled runs alone', async () => {
  const agl = fakeAgl({ binary: '0.3.12', running: true, service: true })
  const log = vi.fn()
  lifecycle = new AglLifecycle(agl.options({ log }))
  lifecycle.setHubUrls(['https://douchat.ai/agl'])
  await lifecycle.refresh()
  await lifecycle.connectHub('https://douchat.ai/agl', 'secret-code')
  expect(agl.commands).toContain('agl connect https://douchat.ai/agl --code secret-code --transport http')
  expect(lifecycle.view()).toMatchObject({ linked: true, hubStatus: 'connected' })
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret-code')

  for (const extra of [{ platform: 'win32' as const }, { enabled: false }]) {
    const other = fakeAgl({ bundled: '0.3.12' })
    const idle = new AglLifecycle(other.options(extra))
    idle.start()
    expect(await idle.refresh()).toMatchObject({ state: extra.enabled === false ? 'disabled' : 'unsupported' })
    expect(await idle.checkForUpdates()).toMatchObject({ update: {} })
    expect(other.commands).toEqual([])
    idle.dispose()
  }
})

it('without consent only reads `--version` and `status --json`, and starts managing once the user agrees', async () => {
  vi.useFakeTimers()
  let consent = false
  const agl = fakeAgl({ binary: '0.3.11', bundled: '0.3.12', running: true, service: false, hubs: [{ url: 'https://douchat.ai/agl', status: 'connected' }] })
  const options = agl.options({ consented: () => consent })
  lifecycle = new AglLifecycle(options)
  lifecycle.setHubUrls(['https://douchat.ai/agl'])
  expect(lifecycle.view().state).toBe('off')
  lifecycle.start()
  const view = await lifecycle.refresh()
  // What agl there is, shown as it is: nothing installed, started, updated or connected.
  expect(view).toMatchObject({ state: 'off', version: '0.3.11', bundledVersion: '0.3.12', running: true, linked: true })
  expect(new Set(agl.commands)).toEqual(new Set(['bundled --version', 'agl --version', 'agl status --json']))
  expect(options.installBinary).not.toHaveBeenCalled()
  expect(options.connect).not.toHaveBeenCalled()
  expect(lifecycle.client()).toBeUndefined()
  await vi.advanceTimersByTimeAsync(13 * 3_600_000)
  expect(agl.commands.some(command => command.startsWith('agl update'))).toBe(false)
  expect(await lifecycle.checkForUpdates()).toMatchObject({ state: 'off' })
  await expect(lifecycle.connectHub('https://douchat.ai/agl', 'c0de')).rejects.toThrow('turned off')
  await expect(lifecycle.disconnectHub('https://douchat.ai/agl')).rejects.toThrow('turned off')
  expect(agl.commands.some(command => /^agl (connect|disconnect|service|start|stop|update)/.test(command))).toBe(false)

  consent = true
  lifecycle.consentChanged()
  await vi.waitFor(() => expect(lifecycle!.view().state).toBe('running'))
  expect(options.installBinary).toHaveBeenCalled()
  expect(agl.commands).toContain('agl service install')
  expect(lifecycle.client()).toBe(agl.connection)
})

it('turning agl off stops what Douchat does, uninstalls nothing, and ignores the daemon from then on', async () => {
  vi.useFakeTimers()
  let consent = true
  const agl = fakeAgl({ binary: '0.3.12', running: true, service: true })
  const options = agl.options({ consented: () => consent })
  lifecycle = new AglLifecycle(options)
  lifecycle.start()
  await lifecycle.refresh()
  expect(lifecycle.client()).toBe(agl.connection)
  agl.commands.length = 0

  consent = false
  lifecycle.consentChanged()
  expect(lifecycle.view().state).toBe('off')
  expect(lifecycle.client()).toBeUndefined()
  expect(agl.connection.close).toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(13 * 3_600_000)
  // A restart reported by the old connection changes nothing either.
  agl.emit({ state: 'reconnected', restarted: true })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(agl.commands.every(command => command === 'agl --version' || command === 'bundled --version' || command === 'agl status --json')).toBe(true)
  expect(agl.commands.some(command => /stop|uninstall|service/.test(command))).toBe(false)
})
