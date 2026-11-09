import { afterEach, expect, it, vi } from 'vitest'
import type { LocalAgent } from '../shared/types'
vi.mock('./localAgents', () => ({ validateLocalAgent: vi.fn() }))
vi.mock('./localAgentRuntime', () => ({ acquireLocalProcessSlot: vi.fn(async () => () => undefined), localAgentExecutable: vi.fn() }))
vi.mock('./shellPath', () => ({ spawnEnvironment: vi.fn(async () => { throw new Error('the desktop probe ran') }) }))
import { validateLocalAgent } from './localAgents'
import { configureAglModels, listLocalAgentModels } from './localAgentModels'

const agent = (extra: Partial<LocalAgent> = {}): LocalAgent => ({ id: 'codex', name: 'Codex', command: 'codex', installed: true, discovered: true, path: '/bin/codex', chatSupported: true, status: 'ready', authentication: 'unchecked', ...extra })
afterEach(() => configureAglModels(undefined))

it('lists models through agl only while the setting is on, for catalog agents without custom arguments', async () => {
  vi.mocked(validateLocalAgent).mockResolvedValue(agent())
  await expect(listLocalAgentModels('codex')).rejects.toThrow('the desktop probe ran')
  const models = vi.fn(async () => [{ id: 'gpt-5.5', name: 'GPT-5.5' }])
  configureAglModels(models)
  expect(await listLocalAgentModels('codex')).toEqual({ models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }], source: 'agent', configurable: true })
  expect(models).toHaveBeenCalledWith('codex')
  // Custom launch arguments, or nothing from agl: the desktop's own discovery.
  vi.mocked(validateLocalAgent).mockResolvedValue(agent({ args: ['--profile', 'work'] }))
  await expect(listLocalAgentModels('codex')).rejects.toThrow('the desktop probe ran')
  vi.mocked(validateLocalAgent).mockResolvedValue(agent())
  models.mockResolvedValue(undefined as never)
  await expect(listLocalAgentModels('codex')).rejects.toThrow('the desktop probe ran')
  // Agents on devices never come here.
  vi.mocked(validateLocalAgent).mockResolvedValue(agent({ agl: { connectionId: 'c', machineId: 'm', agent: 'codex', label: 'Box' } }))
  expect(await listLocalAgentModels('codex')).toEqual({ models: [], source: 'manual', configurable: false })
})
