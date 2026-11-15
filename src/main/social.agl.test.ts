import { afterEach, expect, it, vi } from 'vitest'
import { SocialClient } from './social'
import type { DesktopAuth } from './desktopAuth'
import type { DouchatStore } from './store'
import type { DouchatRuntime } from './runtime'

afterEach(() => { vi.unstubAllGlobals() })

function setup() {
  const auth = { getState: () => ({ status: 'signed-in', user: { id: 'alice' } }), getAccessToken: () => 'token-alice', invalidateSession: vi.fn() } as unknown as DesktopAuth
  const store = { agents: [{ id: 'codex-agent', ownerId: 'alice' }, { id: 'local', ownerId: 'alice' }], socialTaskOutbox: () => [], saveSocialTaskResult: vi.fn(), removeSocialTaskResult: vi.fn(),
    agent: vi.fn(() => ({ ownerId: 'alice' })) } as unknown as DouchatStore
  const runtime = { snapshot: () => ({ permissionRequests: [] }), executeSocialTask: vi.fn(async () => ({ text: 'Done' })) } as unknown as DouchatRuntime
  return { client: new SocialClient('https://example.com', auth, store, runtime), runtime }
}

it('never claims room tasks of agents the service runs through agl here, but keeps them online and runs the rest', async () => {
  const { client, runtime } = setup()
  let routed = new Set(['codex-agent'])
  client.setAglAgents(() => routed)
  const bodies: Record<string, any>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (!options?.body) return new Response(JSON.stringify({ data: { userId: 'alice', rooms: [], friendships: [] } }))
    const body = JSON.parse(options.body); bodies.push(body)
    const data = body.action === 'tasks' ? { tasks: [{ id: 'agl-task', localId: 'codex-agent' }, { id: 'own-task', localId: 'local' }] }
      : body.action === 'claim' ? { task: { id: body.id, claim: 'c', ownerId: 'alice', authorId: 'bob', agent: { localId: 'local', ownerId: 'alice' }, content: 'run' } } : {}
    return new Response(JSON.stringify({ data }))
  }))
  client.start()
  await vi.waitFor(() => expect(runtime.executeSocialTask).toHaveBeenCalledTimes(1))
  client.stop()
  expect(bodies.filter(body => body.action === 'claim').map(body => body.id)).toEqual(['own-task'])
  // Still advertised: presence in rooms stays as it was.
  expect(bodies.find(body => body.action === 'tasks')!.localIds).toContain('codex-agent')
  expect(bodies.find(body => body.action === 'heartbeat')?.localIds ?? ['codex-agent']).toContain('codex-agent')

  // The link stopped working: the desktop picks them up again, as before.
  routed = new Set()
  bodies.length = 0
  client.start()
  await vi.waitFor(() => expect(bodies.filter(body => body.action === 'claim').map(body => body.id)).toEqual(['agl-task', 'own-task']))
  client.stop()
})
