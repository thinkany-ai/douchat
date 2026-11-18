import { describe, expect, it, vi } from 'vitest'
import type { SyncChange, SyncOp } from '../shared/cloudSync'
import type { AppSnapshot } from '../shared/types'
import { createWebApi, dataUrlBlob } from './webApi'

describe('dataUrlBlob', () => {
  it('decodes a base64 image without fetching it', async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]
    const blob = dataUrlBlob(`data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`)
    expect(blob.type).toBe('image/png')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(bytes)
  })

  it('rejects anything that is not a base64 data URL', () => {
    expect(() => dataUrlBlob('https://example.com/a.png')).toThrow('This image could not be read')
  })
})

it('shows a relayed direct message and its agent before the sync write returns', async () => {
  const conversationId = 'direct-helper'
  const user = { id: 'me', name: 'Me', email: 'me@example.com' }
  const agent = { id: 'helper', name: 'Helper', localAgentId: 'codex' }
  const changes: SyncChange[] = [
    { kind: 'agent', id: agent.id, data: agent },
    { kind: 'conversation', id: conversationId, data: { id: conversationId, type: 'direct', agentIds: [agent.id], activeTopicId: 'main', topics: [] } }
  ].map((record, index) => ({
    ...record, kind: record.kind as SyncChange['kind'], seq: index + 1, revision: 1, deleted: false, deviceId: 'desktop', updatedAt: Date.now()
  }))
  const storage = new Map([['douchat.web.token', 'token'], ['douchat.web.user', JSON.stringify(user)]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), removeItem: (key: string) => storage.delete(key), setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('document', { hidden: false, addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('location', { search: '', pathname: '/chat' })
  let finishWrite!: (response: Response) => void
  const write = new Promise<Response>((resolve) => { finishWrite = resolve })
  const answer = (data: unknown) => Response.json({ data })
  let requestId: string | undefined
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path === '/api/desktop-auth/me') return answer({ user })
    if (path === '/api/desktop-auth/social') return answer({ userId: user.id, friendships: [], rooms: [] })
    if (path === '/api/desktop-auth/revoke') return answer({})
    const body = JSON.parse(String(init?.body)) as { action: string; ops?: SyncOp[] }
    if (body.action === 'pull') return answer({ changes, cursor: changes.length, hasMore: false })
    if (body.action === 'watch') return new Promise<Response>(() => {})
    if (body.action === 'push' && body.ops?.[0]?.kind === 'request') {
      requestId = body.ops[0].id
      return write
    }
    return answer([])
  })
  const api = createWebApi()
  try {
    let snapshot: AppSnapshot = await api.getSnapshot()
    api.onSnapshot((next) => { snapshot = next })
    const sending = api.sendMessage(conversationId, 'Hello')
    await vi.waitFor(() => expect(requestId).toBeDefined())
    expect(snapshot.messages).toMatchObject([{ id: requestId, topicId: 'main', text: 'Hello', deliveryState: 'sending' }])
    expect(snapshot.activity).toMatchObject([{ conversationId, topicId: 'main', agentIds: [agent.id], label: agent.name }])

    finishWrite(Response.json({ message: 'Try again' }, { status: 503 }))
    await expect(sending).rejects.toThrow('Try again')
    expect(snapshot.messages).toEqual([])
    expect(snapshot.activity).toEqual([])
  } finally {
    await api.signOut()
    vi.unstubAllGlobals()
  }
})
