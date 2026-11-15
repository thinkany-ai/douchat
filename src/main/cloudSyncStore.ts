import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  cloudRecord,
  isSocialConversation,
  localRecord,
  mergeRecords,
  sameRecord,
  SYNC_KINDS,
  type SyncChange,
  type SyncKind,
  type SyncOp,
  type SyncPushResult,
  type SyncRecord
} from '../shared/cloudSync'
import type { AgentConfig } from '../shared/types'

/**
 * The desktop half of cloud sync, inside the local SQLite database.
 *
 * Triggers put every local write to a synced table into `syncOutbox`, so no
 * store method has to remember to. Writes that come from the cloud run with a
 * row in `syncApplying`, which the triggers skip. `syncShadow` keeps the last
 * cloud copy of each record: its revision is the base of the next push, and
 * its data is the base of a three-way merge when another device got there first.
 */

const TABLES: Record<SyncKind, string> = {
  agent: 'agents',
  conversation: 'conversations',
  routine: 'routines',
  message: 'messages',
  privateMessage: 'privateMessages'
}

const PUSH_BATCH_BYTES = 4_000_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS syncOutbox (
  kind    TEXT NOT NULL,
  id      TEXT NOT NULL,
  ownerId TEXT,
  opId    TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS syncShadow (
  kind     TEXT NOT NULL,
  id       TEXT NOT NULL,
  ownerId  TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data     TEXT,
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS syncInbox (
  ownerId TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  id      TEXT NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (ownerId, seq)
);
CREATE TABLE IF NOT EXISTS syncApplying (flag INTEGER PRIMARY KEY);
`

function triggers(): string {
  const owner: Record<SyncKind, (row: 'NEW' | 'OLD') => string> = {
    agent: (row) => `json_extract(${row}.data, '$.ownerId')`,
    conversation: (row) => `json_extract(${row}.data, '$.ownerId')`,
    routine: (row) => `json_extract(${row}.data, '$.ownerId')`,
    message: (row) => `(SELECT json_extract(data, '$.ownerId') FROM conversations WHERE id = ${row}.conversationId)`,
    privateMessage: (row) => `(SELECT json_extract(data, '$.ownerId') FROM conversations WHERE id = ${row}.conversationId)`
  }
  return SYNC_KINDS.flatMap((kind) => (['INSERT', 'UPDATE', 'DELETE'] as const).map((event) => {
    const row = event === 'DELETE' ? 'OLD' : 'NEW'
    // A new opId per local change: a retried push reuses it, a later edit does not.
    // An explicit upsert, because the writing statement's conflict policy would
    // override an INSERT OR REPLACE here.
    return `DROP TRIGGER IF EXISTS sync_${TABLES[kind]}_${event.toLowerCase()};
    CREATE TRIGGER sync_${TABLES[kind]}_${event.toLowerCase()} AFTER ${event} ON ${TABLES[kind]}
      WHEN NOT EXISTS (SELECT 1 FROM syncApplying)
      BEGIN
        INSERT INTO syncOutbox (kind, id, ownerId, opId)
        VALUES ('${kind}', ${row}.id, ${owner[kind](row)}, lower(hex(randomblob(12))))
        ON CONFLICT(kind, id) DO UPDATE SET ownerId = COALESCE(excluded.ownerId, ownerId), opId = excluded.opId;
      END;`
  })).join('\n')
}

/** A write of a stored record; web requests never go through the outbox. */
export interface PendingSyncOp { op: SyncOp & { kind: SyncKind }; outboxOpId: string }

export interface CloudSyncHost {
  /** The agent as the app sees it, with Markdown profile files loaded. */
  loadAgent(agent: AgentConfig): AgentConfig
  /** Persist profile files that arrived from the cloud. */
  saveAgentFiles(agent: AgentConfig, files: NonNullable<AgentConfig['systemFiles']>): void
  /** A record the cloud refused; it remains local only. */
  onRejected?(kind: SyncKind, id: string, error: string): void
}

export class CloudSyncStore {
  readonly installId: string

  constructor(private readonly db: DatabaseSync, private readonly host: CloudSyncHost) {
    db.exec(SCHEMA)
    db.exec(triggers())
    db.exec('DELETE FROM syncApplying')
    const row = db.prepare("SELECT value FROM meta WHERE key = 'cloudSync:installId'").get() as { value: string } | undefined
    this.installId = row?.value ?? randomUUID()
    if (!row) db.prepare("INSERT INTO meta (key, value) VALUES ('cloudSync:installId', ?)").run(this.installId)
  }

  // ─────────────────────────── cursor and backfill ───────────────────────────

  cursor(ownerId: string): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`cloudSync:cursor:${ownerId}`) as { value: string } | undefined
    return Number(row?.value ?? 0) || 0
  }

  private setCursor(ownerId: string, cursor: number): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(`cloudSync:cursor:${ownerId}`, String(cursor))
  }

  /** A restored development service can have a lower sequence. Re-read its
   * stream without deleting local records or their pending edits. */
  rewindCursor(ownerId: string): void {
    this.setCursor(ownerId, 0)
  }

  /** Queue every record this account has that the cloud has never seen. */
  enqueueUnsynced(ownerId: string): void {
    const ownerOf: Record<SyncKind, string> = {
      agent: "json_extract(t.data, '$.ownerId')",
      conversation: "json_extract(t.data, '$.ownerId')",
      routine: "json_extract(t.data, '$.ownerId')",
      message: "(SELECT json_extract(c.data, '$.ownerId') FROM conversations c WHERE c.id = t.conversationId)",
      privateMessage: "(SELECT json_extract(c.data, '$.ownerId') FROM conversations c WHERE c.id = t.conversationId)"
    }
    for (const kind of SYNC_KINDS) {
      this.db.prepare(`INSERT OR IGNORE INTO syncOutbox (kind, id, ownerId, opId)
        SELECT ?, t.id, ${ownerOf[kind]}, lower(hex(randomblob(12))) FROM ${TABLES[kind]} t
        WHERE ${ownerOf[kind]} = ? AND NOT EXISTS (SELECT 1 FROM syncShadow s WHERE s.kind = ? AND s.id = t.id)
        ORDER BY t.rowid`).run(kind, ownerId, kind)
    }
  }

  /** Profile Markdown can change outside Douchat; compare it with the cloud copy. */
  enqueueChangedAgents(ownerId: string): void {
    for (const { data } of this.db.prepare("SELECT data FROM agents WHERE json_extract(data, '$.ownerId') = ?").all(ownerId) as { data: string }[]) {
      const agent = JSON.parse(data) as AgentConfig
      const shadow = this.shadow('agent', agent.id)
      if (shadow?.data && !sameRecord(cloudRecord('agent', this.host.loadAgent(agent) as unknown as SyncRecord), shadow.data)) {
        this.db.prepare("INSERT OR IGNORE INTO syncOutbox (kind, id, ownerId, opId) VALUES ('agent', ?, ?, lower(hex(randomblob(12))))").run(agent.id, ownerId)
      }
    }
  }

  hasPending(ownerId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM syncOutbox WHERE ownerId = ? OR ownerId IS NULL LIMIT 1').get(ownerId))
  }

  // ───────────────────────────────── push ─────────────────────────────────

  /** The next writes to send, parents first. Entries with nothing to send are dropped. */
  pending(ownerId: string, limit = 100): PendingSyncOp[] {
    const rank = `CASE kind ${SYNC_KINDS.map((kind, index) => `WHEN '${kind}' THEN ${index}`).join(' ')} END`
    const rows = this.db.prepare(`SELECT kind, id, opId FROM syncOutbox WHERE ownerId = ? OR ownerId IS NULL ORDER BY ${rank}, rowid LIMIT ?`)
      .all(ownerId, limit * 4) as { kind: SyncKind; id: string; opId: string }[]
    const result: PendingSyncOp[] = []
    let bytes = 0
    for (const row of rows) {
      // Stay well under the service's request limit; avatars alone can be 1.5 MB.
      if (result.length >= limit || bytes > PUSH_BATCH_BYTES) break
      const shadow = this.shadow(row.kind, row.id)
      const record = this.record(row.kind, row.id)
      if (!record) {
        // Never synced: nothing to delete in the cloud.
        if (!shadow || shadow.data === null) { this.dropOutbox(row.kind, row.id, row.opId); continue }
        if (shadow.ownerId !== ownerId) continue
        result.push({ outboxOpId: row.opId, op: { opId: row.opId, kind: row.kind, id: row.id, baseRevision: shadow.revision, deleted: true } })
        continue
      }
      const owner = this.ownerOf(row.kind, record)
      if (owner && owner !== ownerId) continue
      if (!owner || this.excluded(row.kind, record)) { this.dropOutbox(row.kind, row.id, row.opId); continue }
      const data = this.cloudData(row.kind, record)
      if (shadow?.data && sameRecord(shadow.data, data)) { this.dropOutbox(row.kind, row.id, row.opId); continue }
      bytes += JSON.stringify(data).length
      result.push({ outboxOpId: row.opId, op: { opId: row.opId, kind: row.kind, id: row.id, baseRevision: shadow?.revision ?? 0, data } })
    }
    return result
  }

  /** Record what the cloud said about each write. Returns true when local data changed. */
  acknowledge(ownerId: string, sent: PendingSyncOp[], results: SyncPushResult[]): boolean {
    let changed = false
    this.applying(() => {
      for (const result of results) {
        const entry = sent.find((item) => item.op.opId === result.opId)
        if (!entry) continue
        const { op } = entry
        if (result.status === 'applied') {
          this.setShadow(op.kind, op.id, ownerId, result.revision, op.deleted ? null : op.data!)
          this.dropOutbox(op.kind, op.id, entry.outboxOpId)
          continue
        }
        if (result.status === 'rejected') {
          // The cloud cannot hold this record; it stays on this computer and stops blocking the queue.
          this.host.onRejected?.(op.kind, op.id, result.error)
          this.dropOutbox(op.kind, op.id, entry.outboxOpId)
          continue
        }
        const current = result.current
        if (current.deleted || !current.data) {
          // Another device deleted it; the deletion wins over local edits.
          changed = this.deleteLocal(op.kind, op.id) || changed
          this.setShadow(op.kind, op.id, ownerId, current.revision, null)
          this.dropOutbox(op.kind, op.id, entry.outboxOpId)
          continue
        }
        const base = this.shadow(op.kind, op.id)?.data ?? undefined
        const merged = op.data ? mergeRecords(base, op.data, current.data) : current.data
        changed = this.writeLocal(ownerId, op.kind, op.id, merged) || changed
        this.setShadow(op.kind, op.id, ownerId, current.revision, current.data)
        // Still pending when the merge kept local edits: the next push carries them.
        if (sameRecord(merged, current.data)) this.dropOutbox(op.kind, op.id, entry.outboxOpId)
      }
    })
    return changed
  }

  // ───────────────────────────────── pull ─────────────────────────────────

  /** Stage a pulled page; nothing is applied until the backlog is complete. */
  stage(ownerId: string, changes: SyncChange[]): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO syncInbox (ownerId, seq, kind, id, data) VALUES (?, ?, ?, ?, ?)')
    this.transaction(() => { for (const change of changes) insert.run(ownerId, change.seq, change.kind, change.id, JSON.stringify(change)) })
  }

  /**
   * Apply every staged change, parents first and messages in time order, then
   * advance the cursor. Web send requests are not stored; the latest state of
   * each one in the batch is returned for the sync client to act on.
   */
  applyStaged(ownerId: string, cursor: number): { changed: boolean; requests: SyncChange[]; calls: SyncChange[]; roomReads: SyncChange[] } {
    const rank = `CASE kind ${SYNC_KINDS.map((kind, index) => `WHEN '${kind}' THEN ${index}`).join(' ')} END`
    const rows = this.db.prepare(`SELECT data FROM syncInbox WHERE ownerId = ?
      ORDER BY ${rank}, COALESCE(json_extract(data, '$.data.createdAt'), 0), seq`).all(ownerId) as { data: string }[]
    let changed = false
    const requests = new Map<string, SyncChange>()
    const calls = new Map<string, SyncChange>()
    const roomReads = new Map<string, SyncChange>()
    this.applying(() => {
      for (const row of rows) {
        const change = JSON.parse(row.data) as SyncChange
        if (change.kind === 'request') { requests.set(change.id, change); continue }
        if (change.kind === 'rpc') { calls.set(change.id, change); continue }
        if (change.kind === 'roomRead') { roomReads.set(change.id, change); continue }
        changed = this.applyChange(ownerId, change) || changed
      }
      this.db.prepare('DELETE FROM syncInbox WHERE ownerId = ?').run(ownerId)
      this.setCursor(ownerId, cursor)
    })
    return { changed, requests: [...requests.values()], calls: [...calls.values()], roomReads: [...roomReads.values()] }
  }

  /** Whether a web request's conversation can run here. */
  hasConversation(ownerId: string, conversationId: string): boolean {
    const conversation = this.conversation(conversationId)
    return Boolean(conversation && conversation.ownerId === ownerId && !isSocialConversation(conversation))
  }

  private applyChange(ownerId: string, change: SyncChange): boolean {
    if (!(SYNC_KINDS as readonly string[]).includes(change.kind)) return false
    const kind = change.kind as SyncKind
    const shadow = this.shadow(kind, change.id)
    // Our own write coming back, or something older than what we already have.
    if (shadow && shadow.revision >= change.revision) return false
    if (change.deleted || !change.data) {
      const changed = this.deleteLocal(kind, change.id)
      this.setShadow(kind, change.id, ownerId, change.revision, null)
      this.db.prepare('DELETE FROM syncOutbox WHERE kind = ? AND id = ?').run(kind, change.id)
      return changed
    }
    const pending = this.db.prepare('SELECT 1 FROM syncOutbox WHERE kind = ? AND id = ?').get(kind, change.id)
    const local = pending ? this.record(kind, change.id) : undefined
    const next = local ? mergeRecords(shadow?.data ?? undefined, this.cloudData(kind, local), change.data) : change.data
    const changed = this.writeLocal(ownerId, kind, change.id, next)
    this.setShadow(kind, change.id, ownerId, change.revision, change.data)
    return changed
  }

  // ─────────────────────────────── records ───────────────────────────────

  private record(kind: SyncKind, id: string): SyncRecord | undefined {
    const row = this.db.prepare(`SELECT data FROM ${TABLES[kind]} WHERE id = ?`).get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) as SyncRecord : undefined
  }

  private conversation(id: unknown): SyncRecord | undefined {
    return typeof id === 'string' ? this.record('conversation', id) : undefined
  }

  private ownerOf(kind: SyncKind, record: SyncRecord): string | undefined {
    const owner = kind === 'message' || kind === 'privateMessage' ? this.conversation(record.conversationId)?.ownerId : record.ownerId
    return typeof owner === 'string' && owner ? owner : undefined
  }

  private excluded(kind: SyncKind, record: SyncRecord): boolean {
    if (kind === 'conversation') return isSocialConversation(record)
    if (kind === 'message' || kind === 'privateMessage') return isSocialConversation(this.conversation(record.conversationId))
    return false
  }

  private cloudData(kind: SyncKind, record: SyncRecord): SyncRecord {
    if (kind === 'agent') return cloudRecord(kind, this.host.loadAgent(record as unknown as AgentConfig) as unknown as SyncRecord)
    // An unbound routine belongs to the computer that created it.
    if (kind === 'routine' && !record.deviceId) return { ...record, deviceId: this.installId }
    return cloudRecord(kind, record)
  }

  /** Write a cloud copy locally. Returns false when it cannot be stored here. */
  private writeLocal(ownerId: string, kind: SyncKind, id: string, cloud: SyncRecord): boolean {
    const existing = this.record(kind, id)
    if (kind === 'conversation' && isSocialConversation(cloud)) return false
    const data: SyncRecord = { ...localRecord(kind, cloud, existing), id }
    if (kind === 'agent' || kind === 'conversation' || kind === 'routine') {
      data.ownerId = ownerId
      const previous = Number(existing?.revision ?? 0)
      if (kind !== 'routine') data.revision = previous + 1
    }
    const conversationId = data.conversationId
    if ((kind === 'message' || kind === 'privateMessage' || kind === 'routine') && !this.conversation(conversationId)) return false
    const number = (value: unknown, fallback = Date.now()) => typeof value === 'number' && Number.isFinite(value) ? value : fallback
    const text = (value: unknown) => typeof value === 'string' ? value : ''
    if ((kind === 'message' || kind === 'privateMessage') && !data.contextVersion) {
      // Like a message written here: one after the topic's context reset belongs to the new context.
      const topics = (this.conversation(conversationId)?.topics ?? []) as { id?: string; contextReset?: { id: string; at: number } }[]
      const reset = topics.find((topic) => topic.id === data.topicId)?.contextReset
      if (reset && number(data.createdAt) >= reset.at) data.contextVersion = reset.id
    }
    const json = JSON.stringify(data)
    switch (kind) {
      case 'agent': {
        this.db.prepare('INSERT INTO agents (id, createdAt, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET createdAt = excluded.createdAt, data = excluded.data')
          .run(id, number(data.createdAt), json)
        const agent = data as unknown as AgentConfig
        if (agent.systemFiles) {
          const loaded = this.host.loadAgent(agent)
          const changes = Object.fromEntries(Object.entries(agent.systemFiles).filter(([name, content]) => loaded.systemFiles?.[name as keyof typeof loaded.systemFiles] !== content))
          if (Object.keys(changes).length) this.host.saveAgentFiles(agent, changes)
        }
        break
      }
      case 'conversation':
        this.db.prepare('INSERT INTO conversations (id, type, updatedAt, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, updatedAt = excluded.updatedAt, data = excluded.data')
          .run(id, data.type === 'group' ? 'group' : 'direct', number(data.updatedAt), json)
        break
      case 'routine':
        this.db.prepare(`INSERT INTO routines (id, agentId, conversationId, nextRunAt, data) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET agentId = excluded.agentId, conversationId = excluded.conversationId, nextRunAt = excluded.nextRunAt, data = excluded.data`)
          .run(id, text(data.agentId), text(conversationId), number(data.nextRunAt), json)
        break
      case 'message':
        this.db.prepare(`INSERT INTO messages (id, conversationId, topicId, createdAt, data) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET conversationId = excluded.conversationId, topicId = excluded.topicId, data = excluded.data`)
          .run(id, text(conversationId), text(data.topicId), number(data.createdAt), json)
        break
      case 'privateMessage': {
        const party = (value: unknown) => text((value as { id?: unknown } | undefined)?.id)
        this.db.prepare(`INSERT INTO privateMessages (id, conversationId, topicId, senderId, recipientId, createdAt, data) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
          .run(id, text(conversationId), text(data.topicId), party(data.sender), party(data.recipient), number(data.createdAt), json)
        break
      }
    }
    return true
  }

  private deleteLocal(kind: SyncKind, id: string): boolean {
    return Number(this.db.prepare(`DELETE FROM ${TABLES[kind]} WHERE id = ?`).run(id).changes) > 0
  }

  private shadow(kind: SyncKind, id: string): { ownerId: string; revision: number; data: SyncRecord | null } | undefined {
    const row = this.db.prepare('SELECT ownerId, revision, data FROM syncShadow WHERE kind = ? AND id = ?').get(kind, id) as { ownerId: string; revision: number; data: string | null } | undefined
    return row ? { ownerId: row.ownerId, revision: row.revision, data: row.data ? JSON.parse(row.data) as SyncRecord : null } : undefined
  }

  private setShadow(kind: SyncKind, id: string, ownerId: string, revision: number, data: SyncRecord | null): void {
    this.db.prepare(`INSERT INTO syncShadow (kind, id, ownerId, revision, data) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET ownerId = excluded.ownerId, revision = excluded.revision, data = excluded.data`)
      .run(kind, id, ownerId, revision, data ? JSON.stringify(data) : null)
  }

  /** Only the entry that was sent: a newer local edit keeps its own opId and stays queued. */
  private dropOutbox(kind: SyncKind, id: string, opId: string): void {
    this.db.prepare('DELETE FROM syncOutbox WHERE kind = ? AND id = ? AND opId = ?').run(kind, id, opId)
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN')
    try { work(); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /** Cloud writes must not queue themselves to be pushed back. */
  private applying(work: () => void): void {
    this.transaction(() => {
      this.db.exec('INSERT INTO syncApplying (flag) VALUES (1)')
      try { work() } finally { this.db.exec('DELETE FROM syncApplying') }
    })
  }
}
