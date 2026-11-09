import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AglDevice } from '../../shared/types'
import { ConnectionStore } from '../connectionStore'
import { AglDevices, aglAdapter, withThisComputer } from './aglDevices'

let directory = ''
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'douchat-agl-')) })
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const device = (extra: Partial<AglDevice> = {}): AglDevice => ({ machineId: 'mac-1', name: 'Studio', hostname: 'studio.local', os: 'macos', arch: 'aarch64', version: '0.3.11', online: true, lastSeenAt: 1, pairedAt: 1, agents: [], ...extra })

function setup(owner: string | null = 'alice') {
  const store = new ConnectionStore(join(directory, 'connections.json'))
  const hub = { listDevices: vi.fn(async () => [device()]), renameDevice: vi.fn(async () => undefined), revokeDevice: vi.fn(async () => {}), agents: vi.fn(async () => []) }
  const connections = { store, status: () => ({ state: 'disabled' as const }), saveAgl: (input: Parameters<ConnectionStore['saveAgl']>[0]) => store.saveAgl(input) }
  const devices = new AglDevices(hub, connections, () => owner ?? undefined, 'https://douchat.ai', async id => id ? ['custom:a'] : [])
  return { store, hub, devices }
}

it('joins the service list with this computer’s connections, keeping devices unlinked elsewhere visible', async () => {
  const { store, hub, devices } = setup()
  expect(await devices.list()).toEqual([{ ...device(), agentIds: [] }])
  const connection = await devices.connection('mac-1')
  expect(connection).toMatchObject({ kind: 'agl', name: 'Studio', agl: { machineId: 'mac-1', serviceUrl: 'https://douchat.ai', ownerId: 'alice' } })
  expect(await devices.connection('mac-1')).toEqual(connection)
  expect(await devices.list()).toEqual([{ ...device(), connectionId: connection.id, enabled: true, agentIds: ['custom:a'] }])
  hub.listDevices.mockResolvedValue([])
  expect(await devices.list()).toEqual([expect.objectContaining({ machineId: 'mac-1', name: 'Studio', online: false, connectionId: connection.id })])
  // Another account's devices are not shown.
  await store.saveAgl({ name: 'Bob', agl: { machineId: 'mac-2', serviceUrl: 'https://douchat.ai', ownerId: 'bob' } })
  expect((await devices.list()).map(item => item.machineId)).toEqual(['mac-1'])
})

it('checks devices against the service and revokes only linked ones', async () => {
  const { hub, devices } = setup()
  const connection = await devices.connection('mac-1')
  await expect(devices.check(connection)).resolves.toBeGreaterThanOrEqual(0)
  hub.listDevices.mockResolvedValue([device({ online: false })])
  await new Promise(resolve => setTimeout(resolve, 0))
  await devices.list()
  await expect(devices.check(connection)).rejects.toThrow('Device is offline')
  hub.listDevices.mockResolvedValue([])
  await devices.list()
  await expect(devices.check(connection)).rejects.toThrow('no longer linked')
  await devices.revoke(connection)
  expect(hub.revokeDevice).not.toHaveBeenCalled()
  hub.listDevices.mockResolvedValue([device()])
  await devices.revoke(connection)
  expect(hub.revokeDevice).toHaveBeenCalledWith('mac-1')
})

it('renames the device on the service and its local connection, and validates input', async () => {
  const { store, hub, devices } = setup()
  await devices.connection('mac-1')
  await devices.rename('mac-1', ' Studio Mac ')
  expect(hub.renameDevice).toHaveBeenCalledWith('mac-1', 'Studio Mac')
  expect((await store.list())[0].name).toBe('Studio Mac')
  await expect(devices.rename('mac-1', '')).rejects.toThrow('device name')
  await expect(devices.rename('bad id', 'x')).rejects.toThrow('Invalid device.')
  await expect(setup(null).devices.list()).rejects.toThrow('Sign in first.')
})

it('files agl agents under the matching Douchat adapter', () => {
  expect(aglAdapter('claude')).toBe('claude')
  expect(aglAdapter('codex')).toBe('codex')
  expect(aglAdapter('droid')).toBe('custom')
  expect(aglAdapter('custom')).toBe('custom')
})

it('lists this computer first, marked by its agl machine id', async () => {
  const views = [device({ machineId: 'a' }), device({ machineId: 'b' }), device({ machineId: 'c' })].map(item => ({ ...item, agentIds: [] }))
  expect(withThisComputer(views, 'b').map(item => [item.machineId, item.thisComputer ?? false])).toEqual([['b', true], ['a', false], ['c', false]])
  expect(withThisComputer(views, undefined)).toBe(views)
  expect(withThisComputer(views, 'elsewhere').some(item => item.thisComputer)).toBe(false)
  const store = new ConnectionStore(join(directory, 'connections.json'))
  const hub = { listDevices: vi.fn(async () => [device({ machineId: 'other' }), device({ machineId: 'mine', name: 'MacBook' })]), renameDevice: vi.fn(), revokeDevice: vi.fn(), agents: vi.fn(async () => []) }
  const devices = new AglDevices(hub, { store, status: () => ({ state: 'disabled' as const }), saveAgl: input => store.saveAgl(input) }, () => 'alice', 'https://douchat.ai', async () => [], () => 'mine')
  expect((await devices.list()).map(item => [item.machineId, item.thisComputer])).toEqual([['mine', true], ['other', undefined]])
})
