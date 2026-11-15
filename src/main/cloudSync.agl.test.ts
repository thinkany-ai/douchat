import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SyncChange, SyncOp, SyncPushResult, WebSendRequest } from '../shared/cloudSync'
import { CloudSyncClient } from './cloudSync'
import { DouchatStore } from './store'

const ACCOUNT = 'account-1'
const cleanup: (() => void)[] = []
afterEach(() => { for (const step of cleanup.splice(0)) step() })

/** The /api/sync push/pull/watch contract, in memory. */
function cloud() {
  let seq = 0
  const records = new Map<string, SyncChange>()
  const handle = (body: { action: string; ops?: SyncOp[]; after?: number }) => {
    if (body.action === 'push') return { results: body.ops!.map((op): SyncPushResult => {
      const key = `${op.kind}/${op.id}`
      const current = records.get(key)
      if (current && current.revision !== op.baseRevision) return { opId: op.opId, status: 'conflict', current: structuredClone(current) }
      const next: SyncChange = { kind: op.kind, id: op.id, seq: ++seq, revision: (current?.revision ?? 0) + 1, deleted: Boolean(op.deleted), data: op.deleted ? null : structuredClone(op.data!), deviceId: null, updatedAt: Date.now() }
      records.set(key, next)
      return { opId: op.opId, status: 'applied', revision: next.revision, seq: next.seq }
    }) }
    if (body.action === 'pull') {
      const changes = [...records.values()].filter(record => record.seq > body.after!).sort((a, b) => a.seq - b.seq).map(change => structuredClone(change))
      return { changes, cursor: changes.at(-1)?.seq ?? body.after, hasMore: false }
    }
    return { changed: seq > body.after!, cursor: seq }
  }
  const request = (async (_url: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (body.action === 'watch' && seq <= body.after) await new Promise(resolve => setTimeout(resolve, 20))
    return new Response(JSON.stringify({ code: 0, data: handle(body) }))
  }) as unknown as typeof fetch
  return { request, records }
}

it('leaves a fresh request for an agent the service runs through agl unclaimed, and still runs the others', async () => {
  const server = cloud()
  const directory = mkdtempSync(join(tmpdir(), 'douchat-sync-agl-'))
  const store = new DouchatStore(join(directory, 'douchat.db'))
  store.ensureDefaultCloudContact(ACCOUNT, { provider: 'gateway', model: 'default' })
  const ran: string[] = []
  const client = new CloudSyncClient('https://douchat.test', { identity: () => ({ id: ACCOUNT, token: 't' }), invalidateSession: async () => undefined },
    store.cloudSync, () => undefined, server.request, async (request: WebSendRequest) => { ran.push(request.text) })
  cleanup.push(() => { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const chat = store.accountConversations[0]
  const routed = new Set<string>()
  client.skipRequest = request => routed.has(request.conversationId)
  client.start()
  await client.syncNow()
  const push = (id: string, text: string, createdAt = Date.now()) => server.request(new URL('https://douchat.test/api/sync'), { method: 'POST', body: JSON.stringify({ action: 'push', ops: [{
    opId: id, kind: 'request', id, baseRevision: 0, data: { id, conversationId: chat.id, text, createdAt, state: 'pending' } }] }) })

  routed.add(chat.id)
  await push('req-agl', 'for the server')
  await client.syncNow()
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(ran).toEqual([])
  // Not claimed: the service claims it (deviceId agl:<machineId>) and runs it.
  expect(server.records.get('request/req-agl')?.data).toMatchObject({ state: 'pending' })
  expect(server.records.get('request/req-agl')?.revision).toBe(1)

  routed.clear()
  await push('req-local', 'for this desktop')
  await client.syncNow()
  await vi.waitFor(() => expect(server.records.get('request/req-local')?.deleted).toBe(true))
  expect(ran).toEqual(['for this desktop'])
})

function setup() {
  const server = cloud()
  const directory = mkdtempSync(join(tmpdir(), 'douchat-sync-agl-'))
  const store = new DouchatStore(join(directory, 'douchat.db'))
  store.ensureDefaultCloudContact(ACCOUNT, { provider: 'gateway', model: 'default' })
  const ran: string[] = []
  const client = new CloudSyncClient('https://douchat.test', { identity: () => ({ id: ACCOUNT, token: 't' }), invalidateSession: async () => undefined },
    store.cloudSync, () => undefined, server.request, async (request: WebSendRequest) => { ran.push(request.text) })
  cleanup.push(() => { client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  const chat = store.accountConversations[0]
  client.skipRequest = request => request.conversationId === chat.id
  const write = (id: string, revision: number, data: Record<string, unknown>) => server.request(new URL('https://douchat.test/api/sync'), { method: 'POST', body: JSON.stringify({ action: 'push', ops: [{
    opId: `${id}-${revision}`, kind: 'request', id, baseRevision: revision, data: { id, conversationId: chat.id, ...data } }] }) })
  return { server, client, ran, write }
}

it('runs a skipped request here once its grace window ends and the service still has not taken it', async () => {
  const { server, client, ran, write } = setup()
  client.start()
  await client.syncNow()
  // 29.85 s old: 150 ms of the 30 s window left.
  await write('req-late', 0, { text: 'nobody took it', createdAt: Date.now() - 29_850, state: 'pending' })
  await client.syncNow()
  expect(ran).toEqual([])
  expect(server.records.get('request/req-late')?.data).toMatchObject({ state: 'pending' })
  await vi.waitFor(() => expect(ran).toEqual(['nobody took it']), { timeout: 2_000 })
  await vi.waitFor(() => expect(server.records.get('request/req-late')?.deleted).toBe(true))
})

it('never runs a skipped request the service claimed within the window, even before this desktop saw the claim', async () => {
  const { server, client, ran, write } = setup()
  client.start()
  await client.syncNow()
  const createdAt = Date.now() - 29_800
  await write('req-taken', 0, { text: 'for the server', createdAt, state: 'pending' })
  await client.syncNow()
  // The service claims it (revision-checked) and runs it.
  await write('req-taken', 1, { text: 'for the server', createdAt, state: 'claimed', deviceId: 'agl:m-1', claimedAt: Date.now() })
  await new Promise(resolve => setTimeout(resolve, 600))
  expect(ran).toEqual([])
  expect(server.records.get('request/req-taken')?.data).toMatchObject({ state: 'claimed', deviceId: 'agl:m-1' })
})
