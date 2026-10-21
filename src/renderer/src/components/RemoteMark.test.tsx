import { expect, it, vi } from 'vitest'
vi.mock('../preferences', () => ({ t: (text: string) => text }))
import { isDaemonAgent, remoteAdapter, remoteHost, setRemoteAgents } from './RemoteMark'

const base = { installed: true, discovered: true, chatSupported: true, status: 'ready', authentication: 'unchecked' } as const

it('treats agents configured on a host as remote, though this computer does not register them', () => {
  setRemoteAgents([
    { ...base, id: 'codex', name: 'Codex', command: 'codex' },
    { ...base, id: 'custom:from-web', name: 'Claude Code · txy-sg', command: '/usr/bin/claude', custom: true, hosted: true, connectionName: 'txy-sg',
      remoteAgent: { connectionId: 'conn_1', adapter: 'claude', executable: '/usr/bin/claude', args: [] }, daemon: { connectionId: 'conn_1', hostId: 'hst_1', label: 'txy-sg' } }
  ])
  expect(remoteHost('custom:from-web')).toBe('txy-sg')
  expect(remoteAdapter('custom:from-web')).toBe('claude')
  expect(isDaemonAgent('custom:from-web')).toBe(true)
  // An agent on this computer stays local.
  expect(remoteHost('codex')).toBeUndefined()
  expect(isDaemonAgent('codex')).toBe(false)
})
