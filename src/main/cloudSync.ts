import { randomUUID } from 'node:crypto'
import { DESKTOP_PRESENCE_MS, DESKTOP_RPC_TIMEOUT_MS, type DesktopPresence, type DesktopRpcCall } from '../shared/desktopRpc'
import { ACTIVITY_REFRESH_MS, SYNC_PUSH_ACCEPTS, WEB_REQUEST_TTL_MS, type RoomReadMark, type SupportShare, type SyncedActivity, type SyncChange, type SyncOp, type SyncPushResult, type SyncRecord, type WebSendRequest } from '../shared/cloudSync'
import type { CloudSyncStore } from './cloudSyncStore'
import { AGL_GRACE_MS, AglGraceWindows } from './agl/aglGrace'

/** What the sync client needs from the signed-in session. */
export interface CloudSyncAuth {
  identity(): { id: string; token: string } | undefined
  invalidateSession(): Promise<unknown>
}

const PUSH_INTERVAL_MS = 1000
const PROFILE_CHECK_MS = 60_000
const RETRY_MS = 5000

class AccountChanged extends Error {}

/**
 * Keeps this computer's records and the cloud in step for the signed-in
 * account: pushes the outbox every second, and long-polls the service so
 * writes from other devices arrive within moments. Push and pull never
 * overlap; both go through one queue.
 */
export class CloudSyncClient {
  private running?: { ownerId: string; abort: AbortController }
  private queue: Promise<unknown> = Promise.resolve()
  private pushTimer?: ReturnType<typeof setInterval>
  private profileTimer?: ReturnType<typeof setInterval>
  private pushing = false

  constructor(
    private readonly url: string,
    private readonly auth: CloudSyncAuth,
    private readonly store: CloudSyncStore,
    private readonly onChanged: () => void,
    private readonly request: typeof fetch = fetch,
    /** Sends a web app message through this computer's chat pipeline. */
    private readonly runRequest?: (request: WebSendRequest) => Promise<void>,
    /** Runs a web app call through this desktop's own handlers; see desktopRpc.ts. */
    private readonly runCall?: (call: DesktopRpcCall) => Promise<unknown>,
    private readonly deviceName = 'Douchat desktop'
  ) {}
  private presenceTimer?: ReturnType<typeof setInterval>
  private presenceRevision = 0
  private readonly handling = new Set<string>()
  /** What this desktop last published per conversation, and its cloud revision. */
  private readonly published = new Map<string, { json: string; revision: number; at: number }>()
  private latestActivity: import('../shared/types').ConversationActivityState[] = []
  /** Read marks per shared room as the cloud last had them, and their revision. */
  private readonly roomReads = new Map<string, { readAt: number; revision: number }>()
  private roomReadTimer?: ReturnType<typeof setTimeout>
  private latestRoomReads: RoomReadMark[] = []
  /** Another client read a shared room further than this desktop has. */
  onRoomRead?: (mark: RoomReadMark) => boolean
  /**
   * A request the service runs itself (an agent bound to agl on this computer):
   * left to it for {@link AGL_GRACE_MS}, then claimed and run here if still pending.
   */
  skipRequest?: (request: WebSendRequest) => boolean
  private readonly aglGrace = new AglGraceWindows()
  /** Skipped requests: the latest change seen for each, and the re-check at the end of its window. */
  private readonly deferred = new Map<string, { change: SyncChange; timer: ReturnType<typeof setTimeout> }>()
  private activityTimer?: ReturnType<typeof setTimeout>
  private publishing = false

  start(): void {
    const identity = this.auth.identity()
    if (!identity) return this.stop()
    if (this.running?.ownerId === identity.id) return
    this.stop()
    const running = { ownerId: identity.id, abort: new AbortController() }
    this.running = running
    this.store.enqueueUnsynced(running.ownerId)
    this.pushTimer = setInterval(() => void this.pushSoon(running), PUSH_INTERVAL_MS)
    this.profileTimer = setInterval(() => this.store.enqueueChangedAgents(running.ownerId), PROFILE_CHECK_MS)
    if (this.runCall) {
      void this.announce(running).catch(() => undefined)
      this.presenceTimer = setInterval(() => void this.announce(running).catch(() => undefined), DESKTOP_PRESENCE_MS)
    }
    void this.watchLoop(running)
  }

  stop(): void {
    clearInterval(this.presenceTimer)
    const leaving = this.running
    // Best effort: the web app also stops trusting a presence that goes stale.
    if (leaving && this.runCall) void this.call(leaving, { action: 'push', ops: [{ opId: randomUUID(), kind: 'device', id: this.store.installId, baseRevision: this.presenceRevision, deleted: true }] }).catch(() => undefined)
    this.presenceRevision = 0
    clearTimeout(this.activityTimer)
    this.activityTimer = undefined
    this.published.clear()
    clearTimeout(this.roomReadTimer)
    this.roomReadTimer = undefined
    this.roomReads.clear()
    for (const entry of this.deferred.values()) clearTimeout(entry.timer)
    this.deferred.clear()
    this.aglGrace.clear()
    this.running?.abort.abort()
    this.running = undefined
    clearInterval(this.pushTimer)
    clearInterval(this.profileTimer)
  }

  /** Pull everything new, then push everything pending. Exposed for tests and manual refresh. */
  syncNow(): Promise<void> {
    const running = this.running
    if (!running) return Promise.resolve()
    return this.serial(async () => { await this.pull(running); await this.push(running) })
  }

  /** Support shares for this account; a new share first makes sure the conversation is in the cloud. */
  async supportShares(conversationId: string): Promise<SupportShare[]> {
    return this.call(this.requireRunning(), { action: 'support-share-list', conversationId })
  }

  async createSupportShare(conversationId: string, hours: number, note: string): Promise<SupportShare> {
    const running = this.requireRunning()
    await this.syncNow()
    return this.call(running, { action: 'support-share-create', conversationId, hours, note })
  }

  async revokeSupportShare(id: string): Promise<void> {
    await this.call(this.requireRunning(), { action: 'support-share-revoke', id })
  }

  private requireRunning(): { ownerId: string; abort: AbortController } {
    if (!this.running) throw new Error('Sign in to Douchat first.')
    return this.running
  }

  /**
   * Mirror this desktop's in-progress replies to the cloud so the web app shows
   * them too. Called with every snapshot; writes at most once a second, and
   * otherwise only to keep a long reply from looking abandoned.
   */
  publishActivity(activity: import('../shared/types').ConversationActivityState[]): void {
    this.latestActivity = activity
    if (!this.running || this.activityTimer) return
    this.activityTimer = setTimeout(() => {
      this.activityTimer = undefined
      void this.flushActivity().catch(() => undefined)
    }, 1000)
  }

  private async flushActivity(): Promise<void> {
    const running = this.running
    if (!running || this.publishing) return
    this.publishing = true
    try {
      const now = Date.now()
      const current = new Map(this.latestActivity
        .filter((item) => this.store.hasConversation(running.ownerId, item.conversationId))
        // Streamed text can be long; the latest part is what a viewer needs.
        .map((item) => [item.conversationId, item.remoteText && item.remoteText.length > 4000 ? { ...item, remoteText: `…${item.remoteText.slice(-4000)}` } : item]))
      const ops: SyncOp[] = []
      for (const [conversationId, activity] of current) {
        const json = JSON.stringify(activity)
        const previous = this.published.get(conversationId)
        if (previous?.json === json && now - previous.at < ACTIVITY_REFRESH_MS) continue
        const data: SyncedActivity = { conversationId, activity, deviceId: this.store.installId, updatedAt: now }
        ops.push({ opId: randomUUID(), kind: 'activity', id: conversationId, baseRevision: previous?.revision ?? 0, data: data as unknown as SyncRecord })
      }
      for (const [conversationId, previous] of this.published) {
        if (!current.has(conversationId)) ops.push({ opId: randomUUID(), kind: 'activity', id: conversationId, baseRevision: previous.revision, deleted: true })
      }
      if (!ops.length) return
      const { results } = await this.call<{ results: SyncPushResult[] }>(running, { action: 'push', ops })
      for (const [index, result] of results.entries()) {
        const op = ops[index]
        // Another device's copy, or one left behind: take its revision and write again next time.
        if (result.status === 'rejected') { if (op.deleted) this.published.delete(op.id); continue }
        const revision = result.status === 'applied' ? result.revision : result.current.revision
        if (op.deleted) {
          if (result.status === 'applied') this.published.delete(op.id)
          else this.published.set(op.id, { json: '', revision, at: 0 })
        } else this.published.set(op.id, { json: result.status === 'applied' ? JSON.stringify(current.get(op.id)) : '', revision, at: result.status === 'applied' ? now : 0 })
      }
    } finally {
      this.publishing = false
    }
    // Keep refreshing while anything is in progress, and retry conflicts promptly.
    if (this.latestActivity.length || [...this.published.values()].some((item) => !item.json)) this.publishActivity(this.latestActivity)
  }

  /**
   * Share how far each shared room has been read here, so the web app does not
   * count messages already read on this computer. Called with every snapshot;
   * writes only marks that moved forward, at most once a second.
   */
  publishRoomReads(marks: RoomReadMark[]): void {
    this.latestRoomReads = marks
    if (!this.running || this.roomReadTimer) return
    this.roomReadTimer = setTimeout(() => {
      this.roomReadTimer = undefined
      void this.flushRoomReads().catch(() => undefined)
    }, 1000)
  }

  private async flushRoomReads(): Promise<void> {
    const running = this.running
    if (!running) return
    const ahead = this.latestRoomReads.filter((mark) => mark.readAt > (this.roomReads.get(mark.roomId)?.readAt ?? 0))
    if (!ahead.length) return
    const ops: SyncOp[] = ahead.slice(0, 100).map((mark) => ({ opId: randomUUID(), kind: 'roomRead', id: mark.roomId,
      baseRevision: this.roomReads.get(mark.roomId)?.revision ?? 0, data: mark as unknown as SyncRecord }))
    const { results } = await this.call<{ results: SyncPushResult[] }>(running, { action: 'push', ops })
    let retry = ahead.length > ops.length
    for (const [index, result] of results.entries()) {
      const mark = ahead[index]
      if (result.status === 'applied') { this.roomReads.set(mark.roomId, { readAt: mark.readAt, revision: result.revision }); continue }
      if (result.status === 'rejected') continue
      // Someone else wrote first: keep theirs if it is later, otherwise write ours on top.
      const current = result.current.data as unknown as RoomReadMark | undefined
      this.roomReads.set(mark.roomId, { readAt: current?.readAt ?? 0, revision: result.current.revision })
      if ((current?.readAt ?? 0) < mark.readAt) retry = true
    }
    if (retry) this.publishRoomReads(this.latestRoomReads)
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async pushSoon(running: { ownerId: string; abort: AbortController }): Promise<void> {
    if (this.pushing || this.running !== running || !this.store.hasPending(running.ownerId)) return
    this.pushing = true
    try { await this.serial(() => this.push(running)) } catch { /* Retried on the next tick. */ } finally { this.pushing = false }
  }

  private async watchLoop(running: { ownerId: string; abort: AbortController }): Promise<void> {
    while (this.running === running) {
      try {
        // Pull before the first push, so a new device merges into the cloud copy.
        await this.serial(() => this.pull(running))
        await this.serial(() => this.push(running))
        for (;;) {
          const watched = await this.call<{ changed: boolean }>(running, { action: 'watch', after: this.store.cursor(running.ownerId) }, 40_000)
          if (watched.changed) await this.serial(() => this.pull(running))
        }
      } catch {
        if (this.running !== running) return
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
      }
    }
  }

  private async pull(running: { ownerId: string; abort: AbortController }): Promise<void> {
    let cursor = this.store.cursor(running.ownerId)
    let staged = false
    for (;;) {
      const page = await this.call<{ changes: SyncChange[]; cursor: number; hasMore: boolean }>(running, { action: 'pull', after: cursor })
      if (page.changes.length) { this.store.stage(running.ownerId, page.changes); staged = true }
      cursor = page.cursor
      if (!page.hasMore) break
    }
    if (!staged) return
    const { changed, requests, calls, roomReads } = this.store.applyStaged(running.ownerId, cursor)
    let read = false
    for (const change of roomReads) {
      const mark = change.deleted ? undefined : change.data as unknown as RoomReadMark | undefined
      const known = this.roomReads.get(change.id)
      if (!known || known.revision < change.revision) this.roomReads.set(change.id, { readAt: Math.max(mark?.readAt ?? 0, known?.readAt ?? 0), revision: change.revision })
      if (mark && this.onRoomRead?.(mark)) read = true
    }
    if (changed || read) this.onChanged()
    // Not awaited: a reply can take minutes and must not hold up syncing.
    for (const request of requests) void this.handleRequest(running, request).catch(() => undefined)
    for (const call of calls) void this.handleCall(running, call).catch(() => undefined)
  }

  /** Tell web app tabs this desktop can take their calls. */
  private async announce(running: { ownerId: string; abort: AbortController }): Promise<void> {
    const data: DesktopPresence = { id: this.store.installId, name: this.deviceName, platform: process.platform, updatedAt: Date.now() }
    const [result] = (await this.call<{ results: SyncPushResult[] }>(running, {
      action: 'push', ops: [{ opId: randomUUID(), kind: 'device', id: data.id, baseRevision: this.presenceRevision, data: data as unknown as SyncRecord }]
    })).results
    if (result.status === 'rejected') return
    this.presenceRevision = result.status === 'applied' ? result.revision : result.current.revision
    if (result.status === 'conflict') await this.announce(running)
  }

  /**
   * Claim a web app call with a revision-checked write, so one desktop runs it,
   * run it, push what it changed, and only then answer: the caller then pulls
   * the changes no later than the answer.
   */
  private async handleCall(running: { ownerId: string; abort: AbortController }, change: SyncChange): Promise<void> {
    const call = change.data as unknown as DesktopRpcCall | null
    if (!this.runCall || change.deleted || !call || call.state !== 'pending' || this.handling.has(change.id)) return
    // The page gave up on it already.
    if (Date.now() - call.createdAt > DESKTOP_RPC_TIMEOUT_MS) return
    const write = async (baseRevision: number, data: DesktopRpcCall) => (await this.call<{ results: SyncPushResult[] }>(running, {
      action: 'push', ops: [{ opId: randomUUID(), kind: 'rpc', id: change.id, baseRevision, data: data as unknown as SyncRecord }]
    })).results[0]
    this.handling.add(change.id)
    try {
      const claimed = await write(change.revision, { ...call, state: 'claimed', deviceId: this.store.installId })
      if (claimed?.status !== 'applied') return
      let answer: DesktopRpcCall
      try {
        const result = await this.runCall(call)
        await this.serial(() => this.push(running))
        answer = { ...call, state: 'done', deviceId: this.store.installId, result }
        if (JSON.stringify(answer).length > 1_500_000) answer = { ...call, state: 'failed', deviceId: this.store.installId, error: 'The answer is too large for the web app.' }
      } catch (error) {
        answer = { ...call, state: 'failed', deviceId: this.store.installId, error: error instanceof Error ? error.message : 'The desktop could not do that.' }
      }
      await write(claimed.revision, answer)
    } finally {
      this.handling.delete(change.id)
    }
  }

  /**
   * Claim a pending web request with a revision-checked write, so exactly one
   * desktop runs it, then send it like a message typed here. The request is
   * deleted once sent, or kept as failed with the reason for the web app.
   */
  private async handleRequest(running: { ownerId: string; abort: AbortController }, change: SyncChange, recheck = false): Promise<void> {
    const request = change.data as unknown as WebSendRequest | null
    const deferred = this.deferred.get(change.id)
    if (deferred && !recheck) {
      // Still waiting for the service: keep the newest state for the re-check; done once it is no longer pending.
      if (change.revision >= deferred.change.revision) deferred.change = change
      if (change.deleted || request?.state !== 'pending') { clearTimeout(deferred.timer); this.deferred.delete(change.id); this.aglGrace.forget(change.id) }
      return
    }
    if (!this.runRequest || change.deleted || !request || request.state !== 'pending' || this.handling.has(change.id)) { this.aglGrace.forget(change.id); return }
    if (!this.store.hasConversation(running.ownerId, request.conversationId)) return
    if (!recheck && this.skipRequest?.(request) && this.aglGrace.waiting(change.id, request.createdAt)) {
      const timer = setTimeout(() => {
        const entry = this.deferred.get(change.id)
        this.deferred.delete(change.id)
        this.aglGrace.forget(change.id)
        // The service did not take it in time: claim it here as before (revision-checked, so never twice).
        if (entry && this.running === running) void this.handleRequest(running, entry.change, true).catch(() => undefined)
      }, this.aglGrace.remaining(change.id))
      timer.unref?.()
      this.deferred.set(change.id, { change, timer })
      return
    }
    this.aglGrace.forget(change.id)
    const write = async (baseRevision: number, data?: WebSendRequest) => (await this.call<{ results: SyncPushResult[] }>(running, {
      action: 'push',
      ops: [{ opId: randomUUID(), kind: 'request', id: change.id, baseRevision, ...(data ? { data: data as unknown as SyncRecord } : { deleted: true }) } satisfies SyncOp]
    })).results[0]
    this.handling.add(change.id)
    try {
      if (Date.now() - request.createdAt > WEB_REQUEST_TTL_MS) {
        await write(change.revision, { ...request, state: 'failed', error: 'No desktop was online to send this message. Send it again.' })
        return
      }
      const claimed = await write(change.revision, { ...request, state: 'claimed', deviceId: this.store.installId, claimedAt: Date.now() })
      if (claimed?.status !== 'applied') return
      try {
        await this.runRequest(request)
        await write(claimed.revision)
      } catch (error) {
        await write(claimed.revision, { ...request, state: 'failed', error: error instanceof Error ? error.message : 'The message could not be sent.' })
      }
    } finally {
      this.handling.delete(change.id)
    }
  }

  private async push(running: { ownerId: string; abort: AbortController }): Promise<void> {
    for (let rounds = 0; rounds < 20; rounds++) {
      const pending = this.store.pending(running.ownerId)
      if (!pending.length) return
      const { results } = await this.call<{ results: SyncPushResult[] }>(running, { action: 'push', accepts: SYNC_PUSH_ACCEPTS, ops: pending.map((entry): SyncOp => entry.op) })
      if (this.store.acknowledge(running.ownerId, pending, results)) this.onChanged()
    }
  }

  private async call<T>(running: { ownerId: string; abort: AbortController }, body: object, timeout = 30_000): Promise<T> {
    const identity = this.auth.identity()
    if (!identity || identity.id !== running.ownerId || this.running !== running) throw new AccountChanged()
    const response = await this.request(new URL('/api/sync', this.url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([running.abort.signal, AbortSignal.timeout(timeout)])
    })
    if (this.running !== running || this.auth.identity()?.id !== running.ownerId) throw new AccountChanged()
    if (response.status === 401) { await this.auth.invalidateSession(); throw new Error('Your session expired. Sign in again.') }
    const payload = await response.json().catch(() => null) as { data?: T; message?: string } | null
    if (!response.ok || payload?.data === undefined) throw new Error(payload?.message || 'Cloud sync failed. Retrying.')
    return payload.data
  }
}
