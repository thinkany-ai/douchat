import { expect, it, vi } from 'vitest'
import type { AgentInfo } from './aglClient'
import { AglAgentCatalog, localAgentFromAgl } from './aglAgents'

const info = (extra: Partial<AgentInfo> = {}): AgentInfo => ({ id: 'codex', name: 'Codex', protocol: 'codex', available: true, path: '/opt/bin/codex', version: 'codex-cli 0.164.0', features: ['warm', 'models'], status: 'ready', ...extra })

it('maps agl’s detection onto a desktop agent', () => {
  expect(localAgentFromAgl({ id: 'codex', name: 'Codex', command: 'codex' }, info())).toEqual({ id: 'codex', name: 'Codex', command: 'codex', args: undefined, avatar: undefined,
    installed: true, discovered: true, path: '/opt/bin/codex', desktopPath: undefined, version: 'codex-cli 0.164.0', chatSupported: true, status: 'ready', authentication: 'unchecked', custom: undefined })
  expect(localAgentFromAgl({ id: 'cursor', name: 'Cursor', command: 'cursor-agent' }, info({ id: 'cursor', available: false, path: undefined, status: 'desktop-only', desktop_app: '/Applications/Cursor.app' })))
    .toMatchObject({ installed: false, discovered: true, status: 'desktop-only', desktopPath: '/Applications/Cursor.app', path: undefined, version: undefined })
  expect(localAgentFromAgl({ id: 'kimi', name: 'Kimi', command: 'kimi' }, info({ id: 'kimi', available: false, path: undefined, status: 'not-found' })))
    .toMatchObject({ installed: false, discovered: false, status: 'not-found' })
})

it('caches agents.list, answers undefined while agl cannot, and filters model ids', async () => {
  let now = 0
  let client: { call: ReturnType<typeof vi.fn> } | undefined
  const catalog = new AglAgentCatalog(() => client as never, () => now)
  expect(await catalog.agents()).toBeUndefined()
  client = { call: vi.fn(async (method: string, params?: { agent?: string }) => method === 'agents.list'
    ? [info(), info({ id: 'gemini', features: ['warm'] }), 'junk']
    : { agent: params?.agent, models: [{ id: 'gpt-5.5', name: 'GPT-5.5', default: true }, { id: '--yolo' }, { id: 'gpt-5.5' }, { name: 'no id' }] }) }
  expect((await catalog.agents())?.map(item => item.id)).toEqual(['codex', 'gemini'])
  now += 60_000
  await catalog.agents()
  expect(client.call).toHaveBeenCalledTimes(1)
  catalog.invalidate()
  await catalog.agents()
  expect(client.call).toHaveBeenCalledTimes(2)
  expect(await catalog.models('codex')).toEqual([{ id: 'gpt-5.5', name: 'GPT-5.5' }])
  // No `models` feature, not a catalog agent: the desktop discovers them itself.
  expect(await catalog.models('gemini')).toBeUndefined()
  expect(await catalog.models('fastclaw')).toBeUndefined()
  client.call.mockRejectedValue(new Error('connection closed'))
  catalog.invalidate()
  expect(await catalog.agents()).toBeUndefined()
})
