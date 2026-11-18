import { SYNC_PUSH_ACCEPTS, type SyncChange, type SyncOp, type SyncPushResult, type SyncRecord, type SyncWireKind } from '../shared/cloudSync'

/**
 * The web app's copy of the account, kept in memory and in step with the
 * cloud through the same /api/sync protocol the desktop uses: pull every
 * change after a cursor, long-poll for new ones, and push writes based on the
 * revision last seen (merging field by field when another device was first).
 */

interface Entry { revision: number; data: SyncRecord }
export class UnauthorizedError extends Error {}

export interface Mutation {
  kind: SyncWireKind
  id: string
  /** Remove an unconfirmed new record if the write fails. */
  rollbackOnFailure?: boolean
  /** Returns the new record, or null to delete it. Re-run on the latest copy after a conflict. */
  apply: (current: SyncRecord | undefined) => SyncRecord | null
}

export class WebSync {
  private readonly records = new Map<SyncWireKind, Map<string, Entry>>()
  private cursor = 0
  private stopped = false
  private ready?: Promise<void>
  private readonly listeners = new Set<() => void>()

  constructor(private readonly token: () => string | undefined, private readonly onUnauthorized: () => void) {}

  start(): Promise<void> {
    this.ready ??= this.pull().then(() => { void this.watch() })
    return this.ready
  }

  stop(): void { this.stopped = true }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  all<T>(kind: SyncWireKind): T[] {
    return [...(this.records.get(kind)?.values() ?? [])].map((entry) => entry.data as T)
  }

  get<T>(kind: SyncWireKind, id: string): T | undefined {
    return this.records.get(kind)?.get(id)?.data as T | undefined
  }

  isConfirmed(kind: SyncWireKind, id: string): boolean {
    return (this.records.get(kind)?.get(id)?.revision ?? 0) > 0
  }

  /**
   * Change records. Each write is based on the revision this page last saw;
   * when another device got there first, the change is re-applied to the
   * cloud's latest copy, so only the fields this page meant to change change.
   */
  async mutate(mutations: Mutation[], attempt = 0): Promise<void> {
    const ops: SyncOp[] = []
    const sent: Mutation[] = []
    for (const mutation of mutations) {
      const next = mutation.apply(this.get<SyncRecord>(mutation.kind, mutation.id))
      ops.push({
        opId: crypto.randomUUID(),
        kind: mutation.kind,
        id: mutation.id,
        baseRevision: this.records.get(mutation.kind)?.get(mutation.id)?.revision ?? 0,
        ...(next ? { data: next } : { deleted: true })
      })
      sent.push(mutation)
    }
    if (!ops.length) return
    // Show the change right away; the cloud's answer settles it.
    const rollback = (index: number) => {
      const { kind, id, data, baseRevision } = ops[index]
      const entry = this.records.get(kind)?.get(id)
      if (sent[index].rollbackOnFailure && !baseRevision && entry?.revision === 0 && entry.data === data) this.records.get(kind)?.delete(id)
    }
    for (const op of ops) this.setLocal(op.kind, op.id, op.data, undefined)
    this.emit()
    const { results } = await this.call<{ results: SyncPushResult[] }>({ action: 'push', accepts: SYNC_PUSH_ACCEPTS, ops }).catch((error: unknown) => {
      ops.forEach((_, index) => rollback(index))
      this.emit()
      throw error
    })
    const retry: Mutation[] = []
    let failure: Error | undefined
    for (const [index, result] of results.entries()) {
      const op = ops[index]
      if (result.status === 'applied') { this.setLocal(op.kind, op.id, op.data, result.revision); continue }
      if (result.status === 'rejected') { rollback(index); failure ??= new Error(result.error); continue }
      const current = result.current
      this.setLocal(op.kind, op.id, current.deleted ? undefined : current.data ?? undefined, current.revision)
      if (!current.deleted) retry.push(sent[index])
    }
    this.emit()
    if (retry.length && attempt < 3) await this.mutate(retry, attempt + 1)
    if (failure) throw failure
  }

  private setLocal(kind: SyncWireKind, id: string, data: SyncRecord | undefined, revision: number | undefined): void {
    let table = this.records.get(kind)
    if (!table) this.records.set(kind, table = new Map())
    const previous = table.get(id)
    // A late answer to this page's own write must not undo a newer copy already pulled.
    if (revision !== undefined && previous && previous.revision > revision) return
    if (!data) { table.delete(id); return }
    table.set(id, { revision: revision ?? previous?.revision ?? 0, data })
  }

  private async pull(): Promise<void> {
    let changed = false
    for (;;) {
      const page = await this.call<{ changes: SyncChange[]; cursor: number; hasMore: boolean }>({ action: 'pull', after: this.cursor })
      for (const change of page.changes) {
        const previous = this.records.get(change.kind)?.get(change.id)
        if (previous && previous.revision >= change.revision) continue
        this.setLocal(change.kind, change.id, change.deleted ? undefined : change.data ?? undefined, change.revision)
        changed = true
      }
      this.cursor = page.cursor
      if (!page.hasMore) break
    }
    if (changed) this.emit()
  }

  private async watch(): Promise<void> {
    while (!this.stopped) {
      try {
        const { changed } = await this.call<{ changed: boolean }>({ action: 'watch', after: this.cursor }, 40_000)
        if (changed) await this.pull()
      } catch (error) {
        if (error instanceof UnauthorizedError || this.stopped) return
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
  }

  private emit(): void { for (const listener of this.listeners) listener() }

  async call<T>(body: object, timeout = 30_000): Promise<T> {
    const token = this.token()
    if (!token) throw new UnauthorizedError('Sign in first.')
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    })
    if (response.status === 401) { this.onUnauthorized(); throw new UnauthorizedError('Your session expired. Sign in again.') }
    const payload = await response.json().catch(() => null) as { data?: T; message?: string } | null
    if (!response.ok || payload?.data === undefined) throw new Error(payload?.message || 'Could not reach Douchat. Try again.')
    return payload.data
  }
}
