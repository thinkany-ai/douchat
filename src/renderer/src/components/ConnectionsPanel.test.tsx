// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConnectionView, LocalAgent } from '../../../shared/types'
vi.mock('./NativeDialog', () => ({ NativeDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string, values: Record<string, unknown>) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key])) }))
import { ConnectionsPanel } from './ConnectionsPanel'

let container: HTMLDivElement, root: Root
const view = (extra: Partial<ConnectionView> = {}): ConnectionView => ({ id: `conn_${'a'.repeat(32)}`, name: 'Box', kind: 'ssh', enabled: true, targetRevision: 0, ssh: { host: 'box', user: 'me' }, createdAt: 0, label: 'me@box', agentIds: [], status: { state: 'connected', latencyMs: 40, agents: 0 }, ...extra })
let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  api = {
    listConnections: vi.fn(async () => [view()]), onConnectionsChanged: vi.fn(() => () => {}), listSshHosts: vi.fn(async () => ['box', 'gpu']),
    setConnectionEnabled: vi.fn(async () => [view({ enabled: false, status: { state: 'disabled' } })]), saveConnection: vi.fn(async () => [view()]),
    testConnection: vi.fn(async () => ({ ok: false, durationMs: 10, steps: [{ name: 'ssh', passed: true }, { name: 'shell', passed: false, message: 'base64 is missing on the server' }] })),
    removeConnection: vi.fn(async () => []), detectLocalAgents: vi.fn(async () => []), openConnectionTerminal: vi.fn(async () => {}),
    discoverRemoteAgents: vi.fn(async () => [{ adapter: 'codex', executable: '/usr/bin/codex', version: '1.0' }, { adapter: 'claude', executable: '/usr/bin/claude' }]),
    addDiscoveredAgents: vi.fn(async () => []), copyText: vi.fn(async () => {}),
    createDaemonEnrollment: vi.fn(async () => ({ id: 'enroll-test', installCommand: 'curl https://example.com/install.sh | sh', uninstallCommand: 'douchat-host uninstall', fingerprint: 'test-fingerprint' })),
    waitDaemonEnrollment: vi.fn(() => new Promise(() => {})), cancelDaemonEnrollment: vi.fn(async () => {})
  }
  Object.defineProperty(window, 'douchat', { configurable: true, value: api })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
const render = async (onAgentsChange = vi.fn()) => { await act(async () => root.render(<ConnectionsPanel onAgentsChange={onAgentsChange} />)); return onAgentsChange }
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!

it('shows status and toggles a connection off', async () => {
  await render()
  expect(container.querySelector('[role=status]')?.textContent).toBe('Connected · 40 ms')
  expect(container.textContent).toContain('Box')
  expect(container.textContent).not.toContain('me@box')
  await act(async () => button('Enabled Box').click())
  expect(api.setConnectionEnabled).toHaveBeenCalledWith(view().id, false)
  expect(container.querySelector('[role=status]')?.textContent).toBe('Turned off')
})

it('reports each test step with its reason', async () => {
  await render()
  await act(async () => button('More Box').click())
  await act(async () => button('Test connection').click())
  expect(container.querySelector('.connection-step-ok')?.textContent).toContain('SSH login and host key')
  expect(container.querySelector('.connection-step-failed')?.textContent).toContain('base64 is missing on the server')
})

it('adds a connection from the SSH config', async () => {
  await render()
  await act(async () => button('Add').click())
  await act(async () => button('Save').click())
  expect(api.saveConnection).toHaveBeenCalledWith({ name: '', ssh: { host: 'box' } })
})

it('asks before deleting a connection that agents use, and can keep them', async () => {
  api.listConnections.mockResolvedValue([view({ agentIds: ['custom:a'] })])
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
  const changed = await render()
  await act(async () => button('More Box').click())
  await act(async () => button('Delete').click())
  expect(confirm).toHaveBeenCalledTimes(2)
  expect(api.removeConnection).toHaveBeenCalledWith(view().id, 'disable-agents')
  expect(changed).toHaveBeenCalled()
})

it('scans the server and adds only the chosen agents', async () => {
  const changed = await render()
  await act(async () => button('Scan for agents on this server Box').click())
  const boxes = [...container.querySelectorAll<HTMLInputElement>('.discovered-agent input')]
  expect(boxes).toHaveLength(2)
  expect(button('Add 2 agents')).toBeTruthy()
  await act(async () => boxes[1].click())
  await act(async () => button('Add 1 agent').click())
  expect(api.addDiscoveredAgents).toHaveBeenCalledWith(view().id, [{ adapter: 'codex', executable: '/usr/bin/codex', name: 'Codex · Box' }])
  expect(changed).toHaveBeenCalled()
})

it('marks agents already added from the server, adds only new ones, then shows them in Agents', async () => {
  const showAgents = vi.fn()
  const existing = { id: 'custom:1', name: 'Codex · Box', command: '/usr/bin/codex', installed: true, discovered: true, custom: true, status: 'ready', chatSupported: true, authentication: 'unchecked',
    remoteAgent: { connectionId: view().id, adapter: 'codex', executable: '/usr/bin/codex', args: [] } } as LocalAgent
  await act(async () => root.render(<ConnectionsPanel agents={[existing]} onAgentsChange={vi.fn()} onShowAgents={showAgents} />))
  await act(async () => button('Scan for agents on this server Box').click())
  const rows = [...container.querySelectorAll('.discovered-agent')]
  expect(rows[0].classList.contains('added')).toBe(true)
  expect(rows[0].textContent).toContain('Added')
  expect(rows[0].querySelector('input')!.disabled).toBe(true)
  await act(async () => button('Add 1 agent').click())
  expect(api.addDiscoveredAgents).toHaveBeenCalledWith(view().id, [{ adapter: 'claude', executable: '/usr/bin/claude', name: 'Claude Code · Box' }])
  expect(showAgents).toHaveBeenCalledWith(view().id)
})

it('copies enrollment commands through the desktop bridge and reports success and failure', async () => {
  await render()
  await act(async () => button('Host').click())
  await act(async () => button('Add').click())
  await act(async () => button('Copy install command').click())
  expect(api.copyText).toHaveBeenCalledWith('curl https://example.com/install.sh | sh')
  expect(button('Copy install command').textContent).toBe('Copied')
  api.copyText.mockRejectedValueOnce(new Error('Clipboard unavailable'))
  await act(async () => button('Copy install command').click())
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Could not copy command. Try again.')
  expect(button('Copy install command').textContent).toBe('Copy')
  const uninstall = container.querySelector<HTMLButtonElement>('details .daemon-command button')!
  await act(async () => uninstall.click())
  expect(api.copyText).toHaveBeenLastCalledWith('douchat-host uninstall')
  expect(uninstall.textContent).toBe('Copied')
  expect(container.querySelector('[role=alert]')).toBeNull()
})

it('switches a server that trusts only this computer over to the account, keeping its agents', async () => {
  const daemon = { hostId: 'hst_00000000-0000-4000-8000-000000000001', serviceUrl: 'https://douchat.ai', ownerId: 'u1' }
  const box = view({ kind: 'daemon', ssh: undefined, daemon, agentIds: ['custom:a'] })
  api.listConnections.mockResolvedValue([box])
  api.waitDaemonEnrollment.mockResolvedValueOnce({ hostId: daemon.hostId, info: { os: 'linux' } })
  api.completeDaemonEnrollment = vi.fn(async () => [{ ...box, daemon: { ...daemon, hostExecution: true, trust: 'service' } }])
  await render()
  await act(async () => button('Host').click())
  await act(async () => button('More Box').click())
  await act(async () => button('Use on all devices…').click())
  expect(container.textContent).toContain('Use {name} on all devices'.replace('{name}', 'Box'))
  expect(container.textContent).toContain('douchat-host now follows your Douchat account')
  // Same server: no new name to choose, and its agents are kept rather than scanned again.
  expect(container.querySelector('input[placeholder="dev-box"]')).toBeNull()
  await act(async () => button('Save').click())
  expect(api.completeDaemonEnrollment).toHaveBeenCalledWith('enroll-test', { name: 'Box' })
  expect(api.discoverRemoteAgents).not.toHaveBeenCalled()
  // Once it follows the account it cannot go back to being driven from this computer.
  await act(async () => button('More Box').click())
  expect([...container.querySelectorAll<HTMLButtonElement>('[role=menuitemcheckbox]')].find(item => item.textContent?.trim() === 'Run agents on the server')?.disabled).toBe(true)
  expect(button('Use on all devices…')).toBeUndefined()
})

it('opens on how to reach agents when there are no connections, per platform', async () => {
  api.listConnections.mockResolvedValue([])
  await render()
  expect(container.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('Web app')
  expect(container.querySelector<HTMLAnchorElement>('a.connection-peer-link')?.href).toBe('http://app.localhost:5276/')
  expect(button('Add')).toBeUndefined()
})

it('on the web, offers the desktop app and douchat-host servers while the desktop is offline', async () => {
  api.listConnections.mockResolvedValue([])
  Object.assign(api, { platform: 'web', desktopAvailability: vi.fn(() => 'offline') })
  await render()
  expect(container.querySelector('[role=status]')?.textContent).toContain('The desktop app is offline')
  expect([...container.querySelectorAll<HTMLAnchorElement>('a.connection-peer-link')].map(link => link.textContent)).toEqual(['Open desktop app', 'Download desktop app'])
  // SSH needs the desktop's keys; a douchat-host can be added here.
  expect([...container.querySelectorAll('[role=tab]')].map(tab => tab.textContent)).toEqual(['Desktop app', 'Host'])
  expect(button('Add')).toBeUndefined()
  await act(async () => { button('Host')!.click() })
  expect(button('Add')).toBeDefined()
})

it('on the web, offers only to open the desktop app while it is online', async () => {
  api.listConnections.mockResolvedValue([])
  Object.assign(api, { platform: 'web', desktopAvailability: vi.fn(() => 'online') })
  await render()
  const links = [...container.querySelectorAll<HTMLAnchorElement>('a.connection-peer-link')]
  expect(links.map(link => link.textContent)).toEqual(['Open desktop app'])
  expect(links[0].getAttribute('href')).toBe('douchat-dev://open')
  expect([...container.querySelectorAll('[role=tab]')].map(tab => tab.textContent)).toEqual(['Desktop app', 'Host'])
})
