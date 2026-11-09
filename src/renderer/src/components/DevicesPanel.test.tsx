// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AglDeviceView, ConnectionView, LocalAgent } from '../../../shared/types'
vi.mock('./NativeDialog', () => ({ NativeDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string, values: Record<string, unknown>) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key])) }))
import { DevicesPanel, PAIRING_POLL_MS } from './DevicesPanel'
import { discoverPages } from './DiscoverView'

let container: HTMLDivElement, root: Root
const device = (extra: Partial<AglDeviceView> = {}): AglDeviceView => ({ machineId: 'mac-1', name: 'Studio', hostname: 'studio.local', os: 'macos', arch: 'aarch64', version: '0.3.11', online: true, lastSeenAt: 1, pairedAt: 100, agents: [], agentIds: [], ...extra })
const ssh = (extra: Partial<ConnectionView> = {}): ConnectionView => ({ id: `conn_${'a'.repeat(32)}`, name: 'Box', kind: 'ssh', enabled: true, targetRevision: 0, ssh: { host: 'box' }, createdAt: 0, label: 'box', agentIds: [], status: { state: 'connected', agents: 0 }, ...extra })
const host = ssh({ id: `conn_${'b'.repeat(32)}`, name: 'Old host', kind: 'daemon', ssh: undefined, daemon: { hostId: `hst_${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, serviceUrl: 'https://douchat.ai', ownerId: 'me' } })
let api: Record<string, any>
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  api = {
    listAglDevices: vi.fn(async () => [device()]), listConnections: vi.fn(async () => [ssh(), host]), onConnectionsChanged: vi.fn(() => () => {}),
    createAglPairing: vi.fn(async () => ({ code: 'c0de', expiresAt: Date.now() + 600_000, hubUrl: 'https://douchat.ai/agl', installCommand: 'curl -fsSL "https://douchat.ai/agl/install.sh?code=c0de" | sh' })),
    renameAglDevice: vi.fn(async (machineId: string, name: string) => [device({ machineId, name })]),
    discoverAglAgents: vi.fn(async () => [{ id: 'claude', name: 'Claude Code', available: true, version: '2.1.0' }, { id: 'codex', name: 'Codex', available: true }, { id: 'cursor', name: 'Cursor', available: false, status: 'desktop-only' }]),
    addAglAgents: vi.fn(async () => [{ id: 'custom:1', name: 'Claude Code · Laptop', agl: { connectionId: `conn_${'c'.repeat(32)}`, machineId: 'mac-2', agent: 'claude', label: 'Laptop' } }]),
    removeAglDevice: vi.fn(async () => []), setConnectionEnabled: vi.fn(async () => []), detectLocalAgents: vi.fn(async () => []), copyText: vi.fn(async () => {}),
    listSshHosts: vi.fn(async () => ['box'])
  }
  Object.defineProperty(window, 'douchat', { configurable: true, value: api })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks() })
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)
const render = async (props: { agents?: LocalAgent[]; onAgentsChange?: (agents: LocalAgent[]) => void; onShowAgents?: (id: string) => void } = {}) => {
  await act(async () => root.render(<DevicesPanel onAgentsChange={props.onAgentsChange ?? vi.fn()} agents={props.agents} onShowAgents={props.onShowAgents} />))
}

it('is a Discover page after the others', () => {
  expect(discoverPages().at(-1)).toBe('devices')
})

it('lists devices with douchat-host servers on Devices, and SSH servers on Environments', async () => {
  await render()
  expect([...container.querySelectorAll('[role=tab]')].map(tab => tab.textContent)).toEqual(['Devices', 'Environments'])
  expect(container.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Devices')
  expect(container.textContent).toContain('Studio')
  expect(container.textContent).toContain('studio.local · macOS arm64 · agl 0.3.11')
  expect(container.textContent).toContain('Old host')
  expect(container.textContent).not.toContain('Box')
  expect(button('Add device')).toBeTruthy()
  // A douchat-host can still be used and removed, but not added.
  expect(button('Add')).toBeUndefined()
  await act(async () => button('Environments')!.click())
  expect(container.textContent).toContain('Box')
  expect(container.textContent).not.toContain('Studio')
  expect(container.textContent).not.toContain('Old host')
  expect(button('Add')).toBeTruthy()
})

it('adds a device: install command, waits for it to come online, names it and adds its agents', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const onAgentsChange = vi.fn(), onShowAgents = vi.fn()
  await render({ onAgentsChange, onShowAgents })
  await act(async () => button('Add device')!.click())
  expect(api.createAglPairing).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('curl -fsSL "https://douchat.ai/agl/install.sh?code=c0de" | sh')
  await act(async () => button('Copy install command')!.click())
  expect(api.copyText).toHaveBeenCalledWith('curl -fsSL "https://douchat.ai/agl/install.sh?code=c0de" | sh')
  await act(async () => button('Copy instructions for an agent')!.click())
  expect(api.copyText).toHaveBeenLastCalledWith(expect.stringContaining('curl -fsSL "https://douchat.ai/agl/install.sh?code=c0de" | sh'))
  expect(container.querySelector('[role=dialog] [role=status]')?.textContent).toContain('Waiting for the device to connect')

  // Still only the device paired before the dialog opened, then the new one while it is offline: keep waiting.
  api.listAglDevices.mockResolvedValueOnce([device()]).mockResolvedValueOnce([device(), device({ machineId: 'mac-2', name: '', hostname: 'laptop', online: false, pairedAt: 200 })])
  await act(async () => { await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS) })
  await act(async () => { await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS) })
  expect(container.querySelector('input[maxlength="80"]')).toBeNull()
  api.listAglDevices.mockResolvedValue([device(), device({ machineId: 'mac-2', name: '', hostname: 'laptop', online: true, pairedAt: 200 })])
  await act(async () => { await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS) })
  const name = container.querySelector<HTMLInputElement>('input[maxlength="80"]')!
  expect(name.value).toBe('laptop')
  expect(container.textContent).toContain('The device is online')

  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Laptop'); name.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => button('Next')!.click())
  expect(api.renameAglDevice).toHaveBeenCalledWith('mac-2', 'Laptop')
  expect(api.discoverAglAgents).toHaveBeenCalledWith('mac-2')
  const boxes = [...container.querySelectorAll<HTMLInputElement>('.discovered-agent input')]
  expect(boxes).toHaveLength(3)
  // An agent with only its desktop app cannot be added.
  expect(boxes[2].disabled).toBe(true)
  expect(button('Add 2 agents')).toBeTruthy()
  await act(async () => boxes[1].click())
  await act(async () => button('Add 1 agent')!.click())
  expect(api.addAglAgents).toHaveBeenCalledWith('mac-2', [{ id: 'claude', name: 'Claude Code · Laptop' }])
  expect(onAgentsChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'custom:1' })])
  expect(onShowAgents).toHaveBeenCalledWith(`conn_${'c'.repeat(32)}`)
})

it('offers a new install command once the old one expires', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  api.createAglPairing.mockResolvedValueOnce({ code: 'old', expiresAt: Date.now() + 1_000, hubUrl: 'https://douchat.ai/agl', installCommand: 'old command' })
  await render()
  await act(async () => button('Add device')!.click())
  await act(async () => { await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS) })
  expect(container.querySelector('[role=alert]')?.textContent).toContain('The install command expired before the device connected.')
  await act(async () => button('Create a new one')!.click())
  expect(api.createAglPairing).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('curl -fsSL')
})

it('marks agents already added from a device when scanning it again', async () => {
  const existing = { id: 'custom:9', name: 'Codex · Studio', agl: { connectionId: `conn_${'d'.repeat(32)}`, machineId: 'mac-1', agent: 'codex', label: 'Studio' } } as LocalAgent
  await render({ agents: [existing] })
  await act(async () => button('Scan for agents on this device Studio')!.click())
  const rows = [...container.querySelectorAll('.discovered-agent')]
  expect(rows[1].textContent).toContain('Added')
  expect(rows[1].querySelector('input')!.disabled).toBe(true)
  expect(button('Add 1 agent')).toBeTruthy()
})

it('removes a device, asking about the agents on it', async () => {
  api.listAglDevices.mockResolvedValue([device({ connectionId: `conn_${'d'.repeat(32)}`, enabled: true, agentIds: ['custom:9'] })])
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
  const onAgentsChange = vi.fn()
  await render({ onAgentsChange })
  await act(async () => button('More Studio')!.click())
  await act(async () => button('Remove device')!.click())
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(api.removeAglDevice).toHaveBeenCalledWith('mac-1', 'delete-agents')
  expect(onAgentsChange).toHaveBeenCalled()
})

it('on the web, lists devices read-only and sends adding and environments to the desktop app', async () => {
  Object.assign(api, { platform: 'web', desktopAvailability: vi.fn(() => 'offline') })
  await render()
  expect(container.textContent).toContain('Studio')
  expect(button('Add device')).toBeUndefined()
  expect(button('More Studio')).toBeUndefined()
  expect(button('Scan for agents on this device Studio')).toBeUndefined()
  // douchat-host servers are listed only in the desktop app.
  expect(api.listConnections).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Devices are added in the desktop app')
  expect([...container.querySelectorAll('a.connection-peer-link')].map(link => link.textContent)).toEqual(['Open desktop app', 'Download desktop app'])
  await act(async () => button('Environments')!.click())
  expect(container.textContent).toContain('Add and manage them in the desktop app')
  expect(button('Add')).toBeUndefined()
})

it('shows this computer first, labelled, without a scan button', async () => {
  // Main lists this computer first (aglDevices.withThisComputer); the panel keeps that order.
  api.listAglDevices.mockResolvedValue([device({ machineId: 'mine', name: 'MacBook', thisComputer: true }), device({ machineId: 'mac-2', name: 'Studio' })])
  await render()
  const rows = [...container.querySelectorAll('article')].filter(row => row.querySelector('strong'))
  expect(rows[0].querySelector('strong')?.textContent).toBe('MacBookThis computer')
  expect(rows[1].querySelector('strong')?.textContent).toBe('Studio')
  expect(button('Scan for agents on this device MacBook')).toBeUndefined()
  expect(button('Scan for agents on this device Studio')).toBeTruthy()
})

it('does not take this computer for the device being added', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  api.listAglDevices.mockResolvedValue([])
  await render()
  await act(async () => button('Add device')!.click())
  // This computer links itself while the dialog is open: it is new, but not the device being added.
  api.listAglDevices.mockResolvedValue([device({ machineId: 'mine', name: 'MacBook', pairedAt: 500, thisComputer: true })])
  await act(async () => { await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS * 2) })
  expect(container.textContent).toContain('Waiting for the device to connect…')
  api.listAglDevices.mockResolvedValue([device({ machineId: 'mine', name: 'MacBook', pairedAt: 500, thisComputer: true }), device({ machineId: 'new', name: 'Box', pairedAt: 900 })])
  await act(async () => { await vi.advanceTimersByTimeAsync(PAIRING_POLL_MS) })
  expect(container.textContent).toContain('The device is online')
  expect((container.querySelector('input:not([type=checkbox])') as HTMLInputElement).value).toBe('Box')
})
