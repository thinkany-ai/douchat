import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncChange, SyncOp, SyncPushResult, WebSendRequest } from '../shared/cloudSync'
import type { DesktopRpcCall } from '../shared/desktopRpc'
import { CloudSyncClient } from './cloudSync'
import { DouchatStore } from './store'

const ACCOUNT = 'account-1'
const directories: string[] = []
const running: CloudSyncClient[] = []

afterEach(() => {
  for (const client of running.splice(0)) client.stop()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** The douchat-tanstack /api/sync contract, in memory, for one account. */
function cloud() {
  let seq = 0
  const records = new Map<string, SyncChange & { opId: string }>()
  const handle = (body: { action: string; ops?: SyncOp[]; after?: number }) => {
    if (body.action === 'push') {
      const results: SyncPushResult[] = body.ops!.map((op) => {
        if (op.id.length > 300) return { opId: op.opId, status: 'rejected', error: 'too long' }
        const key = `${op.kind}/${op.id}`
        const current = records.get(key)
        if (current && current.revision !== op.baseRevision) {
          if (current.opId === op.opId) return { opId: op.opId, status: 'applied', revision: current.revision, seq: current.seq }
          const { opId: _, ...change } = current
          return { opId: op.opId, status: 'conflict', current: structuredClone(change) }
        }
        const next = { kind: op.kind, id: op.id, seq: ++seq, revision: (current?.revision ?? 0) + 1, deleted: Boolean(op.deleted),
          data: op.deleted ? null : structuredClone(op.data!), deviceId: null, updatedAt: Date.now(), opId: op.opId }
        records.set(key, next)
        return { opId: op.opId, status: 'applied', revision: next.revision, seq: next.seq }
      })
      return { results }
    }
    if (body.action === 'pull') {
      const changes = [...records.values()].filter((record) => record.seq > body.after!).sort((a, b) => a.seq - b.seq)
        .map(({ opId: _, ...change }) => structuredClone(change))
      return { changes, cursor: changes.at(-1)?.seq ?? body.after, hasMore: false }
    }
    return { changed: seq > body.after!, cursor: seq }
  }
  const request = (async (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (body.action === 'watch' && seq <= body.after) await new Promise((resolve) => setTimeout(resolve, 20))
    return new Response(JSON.stringify({ code: 0, data: handle(body) }))
  }) as unknown as typeof fetch
  return { request, records, reset: () => { records.clear(); seq = 0 } }
}

function device(server: ReturnType<typeof cloud>, runRequest?: (request: WebSendRequest) => Promise<void>, runCall?: (call: DesktopRpcCall) => Promise<unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-sync-'))
  directories.push(directory)
  const store = new DouchatStore(join(directory, 'douchat.db'))
  store.ensureDefaultCloudContact(ACCOUNT, { provider: 'gateway', model: 'default' })
  const client = new CloudSyncClient('https://douchat.test', {
    identity: () => ({ id: ACCOUNT, token: 'dch_test' }),
    invalidateSession: async () => undefined
  }, store.cloudSync, () => undefined, server.request, runRequest, runCall, 'Test Mac')
  client.start()
  running.push(client)
  return { store, sync: () => client.syncNow() }
}

describe('cloud sync between devices', () => {
  it('resumes mobile requests after a service sequence rollback', async () => {
    const server = cloud()
    const ran: string[] = []
    const a = device(server, async request => { ran.push(request.text) })
    await a.sync()
    const chat = a.store.accountConversations[0]
    // Advance the desktop cursor well beyond a restored service's stream.
    for (let i = 0; i < 12; i++) {
      a.store.addMessage({ conversationId: chat.id, topicId: chat.activeTopicId, authorId: 'user', authorName: 'Me', text: `old ${i}`, kind: 'message' })
    }
    await a.sync()
    await a.sync()
    server.reset()
    await server.request(new URL('https://douchat.test/api/sync'), { method: 'POST', body: JSON.stringify({ action: 'push', ops: [{
      opId: 'mobile-after-restore', kind: 'request', id: 'restored-request', baseRevision: 0,
      data: { id: 'restored-request', conversationId: chat.id, text: 'after restore', createdAt: Date.now(), state: 'pending' }
    }] }) })
    await vi.waitFor(() => expect(ran).toEqual(['after restore']), { timeout: 4000 })
    expect(a.store.conversation(chat.id)).toBeDefined()
  })

  it('shares records, merges concurrent edits and propagates deletes', async () => {
    const server = cloud()
    const a = device(server)
    const b = device(server)

    // Both devices made the built-in contact on their own; it is the same record.
    const admin = a.store.accountAgents.find((agent) => agent.systemRole === 'admin')!
    expect(b.store.accountAgents.filter((agent) => agent.systemRole === 'admin').map((agent) => agent.id)).toEqual([admin.id])
    const chat = a.store.accountConversations.find((conversation) => conversation.agentIds.includes(admin.id))!

    const sent = a.store.addMessage({ conversationId: chat.id, topicId: chat.activeTopicId, authorId: 'user', authorName: 'Me', text: 'hello from A', kind: 'message' })
    const member = a.store.createAgent({ name: 'Builder', role: '', instructions: 'Ship it', color: '', provider: 'local', model: 'default', localAgentId: 'codex' })
    const group = a.store.createGroup({ name: 'Crew', agentIds: [member.id] })
    a.store.updateConversation(group.id, { name: 'Crew', description: 'private notes' })
    await a.sync()
    await b.sync()

    expect(b.store.topicMessages(chat.id, chat.activeTopicId).map((message) => message.text)).toContain('hello from A')
    expect(b.store.agent(member.id)?.instructions).toBe('Ship it')
    expect(b.store.conversation(group.id)?.agentIds).toEqual([member.id])
    expect(b.store.accountAgents.filter((agent) => agent.systemRole === 'admin')).toHaveLength(1)

    // Different fields edited on two devices before either syncs: both survive.
    a.store.setConversationPinned(group.id, true)
    b.store.updateConversation(group.id, { muted: true })
    await a.sync()
    await b.sync()
    await a.sync()
    for (const store of [a.store, b.store]) {
      expect(store.conversation(group.id)?.pinned).toBe(true)
      expect(store.conversation(group.id)?.muted).toBe(true)
    }

    // Folders chosen on one computer stay on that computer.
    expect(server.records.get(`conversation/${group.id}`)?.data).not.toHaveProperty('agentWorkspaces')

    const groupLine = b.store.addMessage({ conversationId: group.id, topicId: group.activeTopicId, authorId: 'user', authorName: 'Me', text: 'in the group', kind: 'message' })
    await b.sync()
    a.store.deleteMessage(chat.id, sent.id)
    b.store.deleteConversation(group.id)
    await a.sync()
    await b.sync()
    await a.sync()
    expect(b.store.topicMessages(chat.id, chat.activeTopicId).some((message) => message.id === sent.id)).toBe(false)
    expect(a.store.conversation(group.id)).toBeUndefined()
    // The cascade from the deleted conversation reaches the cloud, so no new device gets orphans.
    expect(server.records.get(`message/${groupLine.id}`)?.deleted).toBe(true)
  })

  it('uploads existing history on first sign-in and gives a new device all of it', async () => {
    const server = cloud()
    const a = device(server)
    const chat = a.store.accountConversations[0]
    for (let index = 0; index < 30; index++) {
      a.store.addMessage({ conversationId: chat.id, topicId: chat.activeTopicId, authorId: 'user', authorName: 'Me', text: `line ${index}`, kind: 'message', createdAt: 1000 + index })
    }
    await a.sync()
    const b = device(server)
    await b.sync()
    expect(b.store.topicMessages(chat.id, chat.activeTopicId).map((message) => message.text))
      .toEqual(Array.from({ length: 30 }, (_, index) => `line ${index}`))
  })

  it('runs a synced routine only on the computer that owns it', async () => {
    const server = cloud()
    const a = device(server)
    const b = device(server)
    const chat = a.store.accountConversations[0]
    const routine = a.store.createRoutine({ name: 'Daily', agentId: chat.agentIds[0], conversationId: chat.id, prompt: 'Report', schedule: { kind: 'interval', minutes: 60 } as never, timezone: 'UTC' }, Date.now())
    await a.sync()
    await b.sync()
    expect(b.store.routines.find((item) => item.id === routine.id)?.deviceId).toBe(a.store.cloudSync.installId)
    expect(a.store.cloudSync.installId).not.toBe(b.store.cloudSync.installId)
  })

  it('runs a message sent from the web app on exactly one desktop', async () => {
    const server = cloud()
    const ran: string[] = []
    const a = device(server, async (request) => { ran.push(`a:${request.text}`) })
    const b = device(server, async (request) => { ran.push(`b:${request.text}`) })
    await a.sync()
    await b.sync()
    const chat = a.store.accountConversations[0]
    // What the web app writes.
    const pushed = await server.request(new URL('https://douchat.test/api/sync'), { method: 'POST', body: JSON.stringify({ action: 'push', ops: [{
      opId: 'web-1', kind: 'request', id: 'req-1', baseRevision: 0,
      data: { id: 'req-1', conversationId: chat.id, text: 'from the browser', createdAt: Date.now(), state: 'pending' }
    }] }) })
    expect((await pushed.json()).data.results[0].status).toBe('applied')
    await Promise.all([a.sync(), b.sync()])
    await vi.waitFor(() => expect(server.records.get('request/req-1')?.deleted).toBe(true))
    expect(ran).toHaveLength(1)
    expect(ran[0]).toMatch(/:from the browser$/)
  })

  it('reports a failed web message back instead of dropping it', async () => {
    const server = cloud()
    const a = device(server, async () => { throw new Error('Codex is not installed on this computer') })
    await a.sync()
    const chat = a.store.accountConversations[0]
    await server.request(new URL('https://douchat.test/api/sync'), { method: 'POST', body: JSON.stringify({ action: 'push', ops: [{
      opId: 'web-2', kind: 'request', id: 'req-2', baseRevision: 0,
      data: { id: 'req-2', conversationId: chat.id, text: 'hi', createdAt: Date.now(), state: 'pending' }
    }] }) })
    await a.sync()
    await vi.waitFor(() => expect(server.records.get('request/req-2')?.data).toMatchObject({ state: 'failed', error: 'Codex is not installed on this computer' }))
  })

  it('shows a desktop reply in progress to other clients, and clears it when done', async () => {
    const server = cloud()
    const a = device(server)
    await a.sync()
    const chat = a.store.accountConversations[0]
    const client = running.at(-1)!
    const activity = { conversationId: chat.id, topicId: chat.activeTopicId, phase: 'replying' as const, agentIds: chat.agentIds, label: 'Replying', startedAt: Date.now() }
    client.publishActivity([activity])
    await vi.waitFor(() => expect(server.records.get(`activity/${chat.id}`)?.data).toMatchObject({ conversationId: chat.id, activity: { phase: 'replying' } }), { timeout: 3000 })
    client.publishActivity([])
    await vi.waitFor(() => expect(server.records.get(`activity/${chat.id}`)?.deleted).toBe(true), { timeout: 3000 })
  })

  it('runs a web app call on the desktop and answers it, after saying it is online', async () => {
    const server = cloud()
    const calls: string[] = []
    const a = device(server, undefined, async (call) => {
      calls.push(call.method)
      if (call.method === 'getCustomModels') return { providers: [], defaultModel: 'x' }
      throw new Error('No such contact')
    })
    await a.sync()
    await vi.waitFor(() => expect(server.records.get(`device/${a.store.cloudSync.installId}`)?.data).toMatchObject({ name: 'Test Mac' }))
    const ask = (id: string, method: string) => server.request(new URL('https://douchat.test/api/sync'), { method: 'POST', body: JSON.stringify({ action: 'push', ops: [{
      opId: id, kind: 'rpc', id, baseRevision: 0, data: { id, method, args: [], createdAt: Date.now(), state: 'pending' }
    }] }) })
    await ask('call-1', 'getCustomModels')
    await ask('call-2', 'deleteAgent')
    await a.sync()
    await vi.waitFor(() => expect(server.records.get('rpc/call-1')?.data).toMatchObject({ state: 'done', result: { defaultModel: 'x' } }))
    await vi.waitFor(() => expect(server.records.get('rpc/call-2')?.data).toMatchObject({ state: 'failed', error: 'No such contact' }))
    expect(calls.sort()).toEqual(['deleteAgent', 'getCustomModels'])
  })

  it('counts a message from another client after a context reset as part of the new context', async () => {
    const server = cloud()
    const a = device(server)
    await a.sync()
    const chat = a.store.accountConversations[0]
    a.store.resetConversationContext(chat.id, chat.activeTopicId)
    await a.sync()
    const later = Date.now() + 1
    await server.request(new URL('https://douchat.test/api/sync'), { method: 'POST', body: JSON.stringify({ action: 'push', ops: [{
      opId: 'web-msg', kind: 'message', id: 'web-msg', baseRevision: 0,
      data: { id: 'web-msg', conversationId: chat.id, topicId: chat.activeTopicId, authorId: 'user', authorName: 'Me', text: 'after the reset', kind: 'message', createdAt: later }
    }] }) })
    await a.sync()
    expect(a.store.contextMessages(chat.id, chat.activeTopicId).map((message) => message.text)).toContain('after the reset')
  })

  it('keeps messages moved out of a chat that is removed in the same pull', async () => {
    const server = cloud()
    const a = device(server)
    const b = device(server)
    const keep = a.store.accountConversations[0]
    const other = a.store.createAgent({ name: 'Extra', role: '', instructions: '', color: '', provider: 'gateway', model: 'default' })
    const dropped = `direct-${other.id}`
    const line = a.store.addMessage({ conversationId: dropped, topicId: a.store.conversation(dropped)!.activeTopicId, authorId: 'user', authorName: 'Me', text: 'keep me', kind: 'message' })
    await a.sync()
    await b.sync()
    // What the web app writes when it merges a duplicate: move the message, then remove the chat.
    const revision = (kind: string, id: string) => server.records.get(`${kind}/${id}`)!.revision
    const moved = { ...server.records.get(`message/${line.id}`)!.data, conversationId: keep.id, topicId: keep.activeTopicId }
    await server.request(new URL('https://douchat.test/api/sync'), { method: 'POST', body: JSON.stringify({ action: 'push', ops: [
      { opId: 'move', kind: 'message', id: line.id, baseRevision: revision('message', line.id), data: moved },
      { opId: 'drop', kind: 'conversation', id: dropped, baseRevision: revision('conversation', dropped), deleted: true }
    ] }) })
    await b.sync()
    expect(b.store.conversation(dropped)).toBeUndefined()
    expect(b.store.topicMessages(keep.id, keep.activeTopicId).map((message) => message.text)).toContain('keep me')
  })

  it('skips a record the cloud refuses and keeps sending the rest', async () => {
    const server = cloud()
    const a = device(server)
    await a.sync()
    const chat = a.store.accountConversations[0]
    const stuck = a.store.addMessage({ id: 'x'.repeat(301), conversationId: chat.id, topicId: chat.activeTopicId, authorId: 'user', authorName: 'Me', text: 'cannot sync', kind: 'message' })
    const later = a.store.addMessage({ conversationId: chat.id, topicId: chat.activeTopicId, authorId: 'user', authorName: 'Me', text: 'after it', kind: 'message' })
    await a.sync()
    expect(server.records.has(`message/${stuck.id}`)).toBe(false)
    expect(server.records.get(`message/${later.id}`)?.data).toMatchObject({ text: 'after it' })
    expect(a.store.cloudSync.hasPending(ACCOUNT)).toBe(false)
  })
})
