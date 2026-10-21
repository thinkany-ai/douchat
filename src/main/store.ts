import { drDouLocalizations, localizedBuiltInAgent, builtInDefaultValues } from '../shared/builtInAgentLocalization'
import { supportedInterfaceLanguage, type InterfaceLanguage } from '../shared/language'
import type { AccountContext } from '../shared/accountData'
import { AgentProfileFiles } from './profileFiles'
import { UserMemoryFiles } from './userMemoryFile'
import { mediaName, MAX_IM_FILE_BYTES, IMMediaError } from './imMedia'
import { pathToFileURL } from 'node:url'
import { thinkingLevel } from '../shared/thinkingLevels'
import { GameRuleError } from '../shared/gameText'
import { agentPermissions } from '../shared/agentPermissions'
import { validateAgentFiles, validateAgentSkills } from '../shared/agentCustomization'
import { validateAgentStartupArgs } from '../shared/localAgentArguments'
import { GroupMemoryStore } from './groupMemoryStore'
import { CloudSyncStore } from './cloudSyncStore'
import { UserMemoryStore } from './userMemoryStore'
import { emptyUserMemory } from '../shared/userMemory'
import { DEFAULT_DECISION_SETTINGS, validateDecisionSettings, type DecisionSettings } from '../shared/groupDecision'
import type { GameState } from '../shared/groupGame'
import type { GroupWorkflow } from '../shared/groupWorkflow'
import type { SocialRoom, SocialMessage } from '../shared/social'
import type { RoomReadMark } from '../shared/cloudSync'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { readFile, unlink, writeFile, realpath, lstat } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type {
  AgentConfig,
  BuiltInAgentDefinition,
  BuiltInAgentManifest,
  BuiltInAgentUserOverrides,
  ChatMessage,
  AgentWorkspaceBinding,
  Conversation,
  CreateGroupInput,
  CreateRoutineInput,
  MessageAttachment,
  MessageDeliveryReply,
  EmailConnectorAccount,
  PrivateMessage,
  ResolvedCreateAgentInput,
  Routine,
  RunEvent,
  RunStatus,
  TaskRun,
  Topic,
  UpdateAgentInput,
  UpdateConversationInput
} from '../shared/types'
import { normalizeAgentEmoji } from '../shared/avatar'
import { ATTACHMENT_LIMITS } from '../shared/attachments'

export const LOCAL_DATA_VERSION = 1
const DEFAULT_TOPIC_ID = 'main'

/** Roughly 1.5 MB of base64 — far above a 256px avatar, far below bloat. */
const AVATAR_LIMIT = 1_500_000
const PRIVATE_MESSAGE_LIMIT = 400
const RUN_LIMIT = 120
const RUN_EVENT_LIMIT = 600
const ACCOUNT_DEFAULT_CONTACTS_META = 'accountDefaultContacts:v1'
const BUILT_IN_MANIFEST_META_PREFIX = 'builtInAgentManifest:v1:'
const CURRENT_ACCOUNT_META = 'currentAccountId'
const DEMO_ACCOUNT_ID = 'local-demo-account'
const LEGACY_CONNECTORS_META = 'connectors:v1'
const ACCOUNT_META_PREFIX = 'account:v1:'
const LEGACY_DEMO_REMOVED_META = 'legacyDemoRemoved:v1'
const ATTACHMENT_ID = /^[0-9a-f-]{36}$/i
const MAX_IMAGE_BYTES = ATTACHMENT_LIMITS.imageBytes
const IMAGE_EXTENSION: Record<MessageAttachment['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

function validAvatar(dataUrl: string): boolean {
  return !dataUrl || (/^data:image\/(png|jpeg|webp);base64,/.test(dataUrl) && dataUrl.length <= AVATAR_LIMIT)
}

interface AccountDefaultContact {
  accountId: string
  agentId: string
  conversationId: string
  systemKey?: string
  cloudAgentId?: string
}

export interface DefaultCloudContactResult {
  agent?: AgentConfig
  conversation?: Conversation
  created: boolean
}

export const EMBEDDED_BUILT_IN_AGENT_MANIFEST: BuiltInAgentManifest = {
  version: 1,
  agents: [{
    id: 'system-admin-fallback',
    systemKey: 'dr-dou',
    systemRole: 'admin',
    capabilities: ['manage_agents'],
    templateVersion: 2,
    name: 'Dr. Dou',
    ...drDouLocalizations.en,
    localizations: drDouLocalizations,
    color: '#14B8A6',
    modelRoute: 'default'
  }]
}

function defaultBuiltInAgent(manifest: BuiltInAgentManifest): BuiltInAgentDefinition {
  return manifest.agents.find((agent) => agent.systemKey === 'dr-dou')
    ?? manifest.agents.find((agent) => agent.systemRole === 'admin')
    ?? EMBEDDED_BUILT_IN_AGENT_MANIFEST.agents[0]
}

function inferredBuiltInOverrides(agent: AgentConfig): BuiltInAgentUserOverrides {
  if (agent.userOverrides) return { ...agent.userOverrides }
  const fallback = defaultBuiltInAgent(EMBEDDED_BUILT_IN_AGENT_MANIFEST)
  const overrides: BuiltInAgentUserOverrides = {}
  if (agent.role !== fallback.role) overrides.role = agent.role
  if (agent.name !== fallback.name) overrides.name = agent.name
  if (agent.instructions !== fallback.instructions) overrides.instructions = agent.instructions
  if ((agent.labels ?? '') !== (fallback.labels ?? '')) overrides.labels = agent.labels ?? ''
  if (agent.avatar) overrides.avatar = agent.avatar
  if (agent.avatarEmoji) overrides.avatarEmoji = agent.avatarEmoji
  return overrides
}

interface DouchatStoreOptions {
  /** Retained only for orchestration fixtures that need the original demo crew. */
  seedDemo?: boolean
}

/**
 * Each table keeps the columns it is queried or ordered by, and the whole
 * record as JSON alongside them. The shared TypeScript types stay the single
 * description of a record's shape — adding an optional field never needs a
 * column or a migration — while the columns that routing and cascades depend
 * on are real, indexed, and enforced by the database.
 *
 * Insertion order is `rowid`, not `createdAt`: two messages written in the
 * same millisecond still have to come back in the order they were written.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id        TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  data      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id        TEXT PRIMARY KEY,
  type      TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  data      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  topicId        TEXT NOT NULL,
  createdAt      INTEGER NOT NULL,
  data           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_topic ON messages (conversationId, topicId);

CREATE TABLE IF NOT EXISTS groupGames (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  topicId TEXT NOT NULL,
  ownerId TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS groupGames_owner ON groupGames(ownerId, conversationId, topicId);

CREATE TABLE IF NOT EXISTS groupWorkflows (
  id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  topicId TEXT NOT NULL,
  ownerId TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS privateMessages (
  id             TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  topicId        TEXT NOT NULL,
  senderId       TEXT NOT NULL,
  recipientId    TEXT NOT NULL,
  createdAt      INTEGER NOT NULL,
  data           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS private_topic ON privateMessages (conversationId, topicId);

CREATE TABLE IF NOT EXISTS routines (
  id             TEXT PRIMARY KEY,
  agentId        TEXT NOT NULL,
  conversationId TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  nextRunAt      INTEGER NOT NULL,
  data           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id        TEXT PRIMARY KEY,
  agentId   TEXT NOT NULL,
  routineId TEXT,
  createdAt INTEGER NOT NULL,
  data      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runEvents (
  id        TEXT PRIMARY KEY,
  runId     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  createdAt INTEGER NOT NULL,
  data      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON runEvents (runId);

CREATE TABLE IF NOT EXISTS attachmentOwners (
  id      TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL
);
`

function newTopic(title = '', at = Date.now()): Topic {
  return { id: randomUUID(), title, createdAt: at, updatedAt: at }
}

const defaultAgents = (): AgentConfig[] => {
  const now = Date.now()
  return [
    {
      id: 'dobi',
      name: 'Dobi',
      role: 'Product lead',
      instructions:
        'Turn ambiguous requests into a crisp plan. Be direct, practical, and concise. Delegate implementation detail to the right teammate instead of writing it yourself.',
      labels: 'planning, product, coordination',
      color: '#14B8A6',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      createdAt: now
    },
    {
      id: 'lin',
      name: 'Lin',
      role: 'Maker',
      instructions:
        'You are a pragmatic builder. Convert plans into concrete deliverables, call out tradeoffs, and answer with the next useful action. Keep responses compact.',
      labels: 'building, engineering, delivery',
      color: '#FF5DA8',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      createdAt: now + 1
    }
  ]
}

export class DouchatStore {
  private interfaceLanguage: InterfaceLanguage = 'en'
  setInterfaceLanguage(language: string): void {
    this.interfaceLanguage = supportedInterfaceLanguage(language)
    const record = this.accountDefaultContacts().find(item => item.accountId === this.currentAccountId)
    const agent = record && this.agent(record.agentId)
    if (agent) this.ensureDefaultCloudContact(this.currentAccountId, { provider: agent.provider, model: agent.model })
  }

  readonly userMemories: UserMemoryStore
  readonly groupMemories: GroupMemoryStore
  readonly cloudSync: CloudSyncStore
  private readonly db: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private readonly attachmentDirectory: string
  private readonly skillDirectory: string
  private profileFiles?: AgentProfileFiles
  private accountSessionId = randomUUID()

  constructor(filePath: string, options: DouchatStoreOptions = {}) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.skillDirectory = join(dirname(filePath), 'skills')
    this.attachmentDirectory = join(dirname(filePath), 'attachments')
    mkdirSync(this.attachmentDirectory, { recursive: true })
    this.db = new DatabaseSync(filePath)
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > LOCAL_DATA_VERSION) {
      this.db.close()
      throw new Error('This data was created by a newer Douchat version. Upgrade Douchat before opening it.')
    }
    // WAL is what makes a half-written turn survive a crash: the old JSON file
    // was rewritten whole on every message, so losing power mid-write took the
    // entire transcript with it.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    this.seed(Boolean(options.seedDemo))
    if (!options.seedDemo) this.removeUnusedLegacyDemo()
    this.backfillSystemAdminRoles()
    this.backfillAgentAvatarSeeds()
    this.backfillAccountOwnership()
    this.groupMemories = new GroupMemoryStore(this.db, () => this.currentAccountId, id => this.conversation(id), id => this.agent(id)?.ownerId)
    this.userMemories = new UserMemoryStore(this.db, () => this.currentAccountId, id => this.agent(id)?.ownerId)
    this.migrateLegacyUserMemories(filePath)
    this.userMemories = new UserMemoryStore(this.db, () => this.currentAccountId, id => this.agent(id)?.ownerId, join(dirname(filePath), 'accounts'), join(dirname(filePath), 'memories'))
    this.profileFiles = new AgentProfileFiles(join(dirname(filePath), 'accounts'))
    for (const agent of this.agents) this.profileFiles.load(agent)
    this.cloudSync = new CloudSyncStore(this.db, {
      loadAgent: (agent) => this.profileFiles?.load(agent) ?? agent,
      saveAgentFiles: (agent, files) => this.profileFiles?.save(agent, files),
      onRejected: (kind, id, error) => console.warn(`[douchat] Cloud sync skipped ${kind} ${id}: ${error}`)
    })
    this.migrateAccountSensitiveMeta()
    this.backfillAttachmentOwnership()
    this.backfillMessageSourceContent()
    this.backfillDeliveryReplies()
    this.recoverInterruptedRuns()
    this.mergeLegacyIMConversations()
    this.tx(() => {
      // Existing IDs and references stay intact. Only add missing versions.
      for (const table of ['agents', 'conversations']) {
        this.db.exec(`UPDATE ${table} SET data = json_set(data, '$.revision', 1) WHERE json_extract(data, '$.revision') IS NULL`)
      }
      this.db.exec(`PRAGMA user_version = ${LOCAL_DATA_VERSION}`)
    })
  }

  static atUserData(userDataPath: string): DouchatStore {
    return new DouchatStore(join(userDataPath, 'douchat.db'))
  }

  private migrateLegacyUserMemories(filePath: string): void {
    const files = new UserMemoryFiles(join(dirname(filePath), 'accounts'))
    const legacy = new UserMemoryFiles(join(dirname(filePath), 'memories'))
    this.tx(() => {
      for (const agent of this.agents) {
        if (!agent.ownerId || !agent.systemFiles) continue
        const notes = ['USER.md', 'MEMORY.md'].flatMap(name => {
          const content = agent.systemFiles?.[name as 'USER.md' | 'MEMORY.md']
          return content?.trim() ? [`# ${name}\n${content}`] : []
        }).join('\n\n')
        if (!notes) continue
        const row = this.stmt('SELECT data FROM agent_user_memories WHERE userId = ? AND agentId = ?').get(agent.ownerId, agent.id) as { data: string } | undefined
        const current = files.read(agent.ownerId, agent.id) ?? legacy.read(agent.ownerId, agent.id)
          ?? (row ? JSON.parse(row.data) : emptyUserMemory(agent.ownerId, agent.id))
        const next = { ...current, notes: [current.notes, notes].filter(Boolean).join('\n\n'), revision: current.revision + 1, updatedAt: Date.now() }
        files.write(next)
        this.write('INSERT INTO agent_user_memories (userId, agentId, data) VALUES (?, ?, ?) ON CONFLICT(userId, agentId) DO UPDATE SET data = excluded.data', agent.ownerId, agent.id, JSON.stringify(next))
        delete agent.systemFiles['USER.md']
        delete agent.systemFiles['MEMORY.md']
        this.putAgent(agent)
      }
    })
  }

  close(): void {
    this.db.close()
  }

  decisionSettings(): DecisionSettings {
    const saved = this.accountMeta('groupDecision:v1')
    return saved ? validateDecisionSettings(JSON.parse(saved)) : { ...DEFAULT_DECISION_SETTINGS }
  }

  groupHealth(conversationId: string): import('./groupHealth').GroupHealth {
    try { return JSON.parse(this.accountMeta(`groupHealth:${conversationId}`) || '{}') } catch { return {} }
  }

  saveGroupHealth(conversationId: string, health: import('./groupHealth').GroupHealth): void {
    if (this.conversation(conversationId)?.ownerId !== this.currentAccountId) return
    this.setAccountMeta(`groupHealth:${conversationId}`, JSON.stringify(health))
  }

  saveDecisionSettings(settings: DecisionSettings): DecisionSettings {
    if (!this.currentAccountId) throw new Error("Sign in first.")
    const validated = validateDecisionSettings(settings)
    this.setAccountMeta('groupDecision:v1', JSON.stringify(validated))
    return validated
  }

  groupGames(): GameState[] {
    return this.all<GameState>('SELECT data FROM groupGames WHERE ownerId = ? ORDER BY rowid', this.currentAccountId)
      .filter(game => this.conversation(game.conversationId)?.topics.some(topic => topic.id === game.topicId))
  }

  groupWorkflows(): GroupWorkflow[] {
    return this.all<GroupWorkflow>('SELECT data FROM groupWorkflows WHERE ownerId = ? ORDER BY rowid', this.currentAccountId)
      .filter(workflow => {
        const topic = this.conversation(workflow.conversationId)?.topics.find(topic => topic.id === workflow.topicId)
        return topic && (!topic.contextReset || this.contextMessages(workflow.conversationId, workflow.topicId).some(message => message.id === workflow.user.id))
      })
  }

  saveGroupWorkflow(workflow: GroupWorkflow): void {
    if (!this.currentAccountId || this.currentAccountId !== workflow.ownerId || this.conversation(workflow.conversationId)?.ownerId !== workflow.ownerId) throw new Error("This group task does not belong to the current account.")
    if (!this.topicMessages(workflow.conversationId, workflow.topicId).some(message => message.id === workflow.user.id)) throw new Error("The original group task message was deleted.")
    if (!this.contextMessages(workflow.conversationId, workflow.topicId).some(message => message.id === workflow.user.id)) return
    workflow.updatedAt = Date.now()
    this.write('INSERT INTO groupWorkflows (id, conversationId, topicId, ownerId, data) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
      workflow.id, workflow.conversationId, workflow.topicId, workflow.ownerId, JSON.stringify(workflow))
  }

  groupGame(id: string): GameState | undefined {
    return this.groupGames().find(game => game.id === id)
  }

  /** State and visible messages commit together. Stale slots cannot publish twice. */
  commitGame(game: GameState, expectedRevision?: number): void {
    if (!this.currentAccountId || game.ownerId !== this.currentAccountId
      || this.conversation(game.conversationId)?.ownerId !== game.ownerId) throw new GameRuleError("The game does not belong to the current account.", game.language ?? 'zh-CN')
    this.tx(() => {
      const previous = this.one<GameState>('SELECT data FROM groupGames WHERE id = ?', game.id)
      if (!['paused', 'cancelled'].includes(game.status) && game.players.some(player => !player.human && !this.conversation(game.conversationId)?.agentIds.includes(player.id))) throw new GameRuleError("A player left the group. End this game and select players again.", game.language ?? 'zh-CN')
      if (previous ? previous.revision !== expectedRevision || game.revision !== previous.revision + 1 : expectedRevision !== undefined) throw new GameRuleError("Game state has changed.", game.language ?? 'zh-CN')
      if (previous && (previous.ownerId !== game.ownerId || previous.conversationId !== game.conversationId || previous.topicId !== game.topicId)) throw new GameRuleError("Game identity cannot be changed.", game.language ?? 'zh-CN')
      this.write('INSERT INTO groupGames (id, conversationId, topicId, ownerId, revision, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data', game.id, game.conversationId, game.topicId, game.ownerId, game.revision, JSON.stringify(game))
      const now = Date.now()
      for (const event of game.events.slice(previous?.events.length ?? 0).filter(event => event.audience === 'group')) {
        this.insertMessage({ id: event.id, conversationId: game.conversationId, topicId: game.topicId,
          authorId: event.authorId === 'human' ? 'user' : event.authorId, authorName: event.authorName,
          text: event.text, kind: event.authorId === 'system' ? 'system' : 'message', createdAt: now })
      }
      const conversation = this.conversation(game.conversationId)!
      conversation.updatedAt = now
      this.putConversation(conversation)
    })
  }

  /** A process exit cannot leave work permanently looking active. Scheduled
   * one-time work is made eligible for one delayed retry on the next launch. */
  private recoverInterruptedRuns(): void {
    const interrupted = this.runs.filter((run) => run.status === 'queued' || run.status === 'running')
    if (!interrupted.length) return
    const now = Date.now()
    for (const run of interrupted) {
      const title = 'Douchat restarted before this task finished'
      this.updateRun(run.id, {
        status: 'failed',
        latestActivity: 'Interrupted',
        error: title,
        finishedAt: now
      })
      this.addRunEvent({ runId: run.id, type: 'status', label: title, status: 'failed', createdAt: now })
      if (!run.routineId) continue
      const routine = this.routine(run.routineId)
      if (routine?.schedule.kind === 'once' && !routine.enabled) {
        this.setRoutineEnabled(routine.id, true, now + 60_000)
      }
    }
  }

  /** Received documents remain local files, exposed by the same file chips as tool results. */
  async saveIMFile(input: { name: string; data: Uint8Array }, expectedOwnerId: string): Promise<string> {
    if (!expectedOwnerId || expectedOwnerId !== this.currentAccountId) throw new Error('Account changed')
    if (!input.data.byteLength || input.data.byteLength > MAX_IM_FILE_BYTES) throw new IMMediaError('文件须为 1 字节至 20 MB，请调整后重发。')
    const name = mediaName(input.name)
    const id = randomUUID()
    const path = join(this.attachmentDirectory, `${id}-${name}`)
    await writeFile(path, input.data, { flag: 'wx', mode: 0o600 })
    if (expectedOwnerId !== this.currentAccountId) {
      await unlink(path).catch(() => undefined)
      throw new Error('Account changed')
    }
    try { this.write('INSERT INTO attachmentOwners (id, ownerId) VALUES (?, ?)', id, expectedOwnerId) }
    catch (error) { await unlink(path).catch(() => undefined); throw error }
    const label = name.replace(/[\\[\]`]/g, character => '\\' + character)
    return `[${label}](<${pathToFileURL(path).href.replace(/^file:/, 'douchat-file:')}>)`
  }

  /** Only explicitly registered documents of the signed-in account bypass normal user-folder roots. */
  async ownedDocumentPath(input: string): Promise<string | undefined> {
    const path = resolve(input)
    if (dirname(path) !== resolve(this.attachmentDirectory)) return undefined
    const id = basename(path).slice(0, 36)
    const owner = this.stmt('SELECT ownerId FROM attachmentOwners WHERE id = ?').get(id) as { ownerId: string } | undefined
    const account = this.currentAccountId
    if (!account || owner?.ownerId !== account || basename(path)[36] !== '-') throw new Error('Document not found')
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || dirname(await realpath(path)) !== await realpath(this.attachmentDirectory) || this.currentAccountId !== account) throw new Error('Document not found')
    return path
  }

  async saveImageAttachment(input: {
    quoted?: boolean
    name: string
    mimeType: MessageAttachment['mimeType']
    data: Uint8Array
  }, expectedOwnerId?: string): Promise<MessageAttachment> {
    const ownerId = expectedOwnerId ?? this.currentAccountId
    if (!ownerId || ownerId !== this.currentAccountId) throw new Error('Account changed while saving the attachment')
    if (!IMAGE_EXTENSION[input.mimeType]) throw new Error('Unsupported image format')
    if (!input.data.byteLength || input.data.byteLength > MAX_IMAGE_BYTES) throw new Error('Each image must be 8 MB or smaller.')
    const id = randomUUID()
    const extension = IMAGE_EXTENSION[input.mimeType]
    const path = join(this.attachmentDirectory, `${id}.${extension}`)
    await writeFile(path, input.data, { flag: 'wx' })
    try {
      if (ownerId !== this.currentAccountId) throw new Error('Account changed while saving the attachment')
      this.write('INSERT INTO attachmentOwners (id, ownerId) VALUES (?, ?)', id, ownerId)
    } catch (cause) {
      await unlink(path).catch(() => undefined)
      throw cause
    }
    return { id, kind: 'image', name: input.name, mimeType: input.mimeType, size: input.data.byteLength, ...(typeof input.quoted === 'boolean' ? { quoted: input.quoted } : {}) }
  }

  async attachmentDataUrl(id: string): Promise<string> {
    if (!ATTACHMENT_ID.test(id)) throw new Error('Invalid attachment id')
    const owner = this.stmt('SELECT ownerId FROM attachmentOwners WHERE id = ?').get(id) as { ownerId: string } | undefined
    const accountId = this.currentAccountId
    if (!accountId || owner?.ownerId !== accountId) throw new Error('Attachment not found')
    for (const [mimeType, extension] of Object.entries(IMAGE_EXTENSION) as [MessageAttachment['mimeType'], string][]) {
      try {
        const data = await readFile(join(this.attachmentDirectory, `${id}.${extension}`))
        if (this.currentAccountId !== accountId) throw new Error('Attachment not found')
        return `data:${mimeType};base64,${data.toString('base64')}`
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
    }
    throw new Error('Attachment not found')
  }

  // ───────────────────────────── plumbing ─────────────────────────────

  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql)
    if (cached) return cached
    const prepared = this.db.prepare(sql)
    this.statements.set(sql, prepared)
    return prepared
  }

  private all<T>(sql: string, ...parameters: (string | number | null)[]): T[] {
    return this.stmt(sql)
      .all(...parameters)
      .map((row) => JSON.parse((row as { data: string }).data) as T)
  }

  private one<T>(sql: string, ...parameters: (string | number | null)[]): T | undefined {
    const row = this.stmt(sql).get(...parameters) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as T) : undefined
  }

  private write(sql: string, ...parameters: (string | number | null)[]): void {
    this.stmt(sql).run(...parameters)
  }

  /** Every multi-statement change lands whole or not at all. */
  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (cause) {
      this.db.exec('ROLLBACK')
      throw cause
    }
  }

  private meta(key: string): string {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? ''
  }

  private setMeta(key: string, value: string): void {
    this.write('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }

  private accountDefaultContacts(): AccountDefaultContact[] {
    try {
      const records = JSON.parse(this.meta(ACCOUNT_DEFAULT_CONTACTS_META)) as unknown
      if (!Array.isArray(records)) return []
      return records.filter((record): record is AccountDefaultContact => {
        if (!record || typeof record !== 'object') return false
        const candidate = record as Partial<AccountDefaultContact>
        return typeof candidate.accountId === 'string'
          && typeof candidate.agentId === 'string'
          && typeof candidate.conversationId === 'string'
      })
    } catch {
      return []
    }
  }

  private builtInManifest(accountId: string): BuiltInAgentManifest {
    try {
      const manifest = JSON.parse(this.meta(`${BUILT_IN_MANIFEST_META_PREFIX}${accountId}`)) as BuiltInAgentManifest
      if (
        Number.isInteger(manifest?.version)
        && manifest.version > 0
        && Array.isArray(manifest.agents)
        && manifest.agents.some((agent) => agent?.systemRole === 'admin' && agent.systemKey === 'dr-dou')
      ) return manifest
    } catch {}
    return EMBEDDED_BUILT_IN_AGENT_MANIFEST
  }

  private putConversation(conversation: Conversation): void {
    const previous = this.one<Conversation>('SELECT data FROM conversations WHERE id = ?', conversation.id)
    conversation.revision = (previous?.revision ?? 0) + 1
    this.write(
      `INSERT INTO conversations (id, type, updatedAt, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, updatedAt = excluded.updatedAt, data = excluded.data`,
      conversation.id,
      conversation.type,
      conversation.updatedAt,
      JSON.stringify(conversation)
    )
  }

  private putAgent(agent: AgentConfig): void {
    const previous = this.one<AgentConfig>('SELECT data FROM agents WHERE id = ?', agent.id)
    agent.revision = (previous?.revision ?? 0) + 1
    this.write(
      `INSERT INTO agents (id, createdAt, data) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET createdAt = excluded.createdAt, data = excluded.data`,
      agent.id,
      agent.createdAt,
      JSON.stringify(agent)
    )
  }

  private putRoutine(routine: Routine): void {
    this.write(
      `INSERT INTO routines (id, agentId, conversationId, nextRunAt, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET agentId = excluded.agentId, conversationId = excluded.conversationId,
         nextRunAt = excluded.nextRunAt, data = excluded.data`,
      routine.id,
      routine.agentId,
      routine.conversationId,
      routine.nextRunAt,
      JSON.stringify(routine)
    )
  }

  private putRun(run: TaskRun): void {
    this.write(
      `INSERT INTO runs (id, agentId, routineId, createdAt, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET agentId = excluded.agentId, routineId = excluded.routineId,
         createdAt = excluded.createdAt, data = excluded.data`,
      run.id,
      run.agentId,
      run.routineId ?? null,
      run.createdAt,
      JSON.stringify(run)
    )
  }

  /** Replies created before source content was stored still have a matching
   * outbound delivery. Recover the closest one so existing transcripts gain
   * the same expandable private-message detail as new replies. */
  private backfillMessageSourceContent(): void {
    this.db.exec(`
      UPDATE messages AS received
      SET data = json_set(received.data, '$.source.content', (
        SELECT json_extract(delivery.value, '$.content')
        FROM messages AS sent, json_each(sent.data, '$.deliveries') AS delivery
        WHERE sent.rowid < received.rowid
          AND json_extract(sent.data, '$.authorId') = json_extract(received.data, '$.source.id')
          AND json_extract(delivery.value, '$.recipientId') = json_extract(received.data, '$.authorId')
        ORDER BY sent.rowid DESC, CAST(delivery.key AS INTEGER) DESC
        LIMIT 1
      ))
      WHERE json_extract(received.data, '$.source.kind') = 'bot'
        AND json_extract(received.data, '$.source.content') IS NULL
        AND EXISTS (
          SELECT 1
          FROM messages AS sent, json_each(sent.data, '$.deliveries') AS delivery
          WHERE sent.rowid < received.rowid
            AND json_extract(sent.data, '$.authorId') = json_extract(received.data, '$.source.id')
            AND json_extract(delivery.value, '$.recipientId') = json_extract(received.data, '$.authorId')
        )
    `)
  }

  /** Older A2A replies lived only in the recipient's direct transcript.
   * Reconnect them to the outbound delivery so the sender can read the thread
   * as a parent message followed by its replies. */
  private backfillDeliveryReplies(): void {
    const messages = this.all<ChatMessage>('SELECT data FROM messages ORDER BY rowid')
    const messagesById = new Map(messages.map((message) => [message.id, message]))
    const latestDelivery = new Map<string, { message: ChatMessage; deliveryId: string }>()
    const changed = new Map<string, ChatMessage>()
    const key = (senderId: string, recipientId: string, content: string): string =>
      `${senderId}\u0000${recipientId}\u0000${content}`

    for (const message of messages) {
      for (const delivery of message.deliveries ?? []) {
        for (const reply of delivery.replies ?? []) {
          const replyMessage = messagesById.get(reply.id)
          if (!reply.replyGroupId && replyMessage?.replyGroupId) {
            reply.replyGroupId = replyMessage.replyGroupId
            changed.set(message.id, message)
          }
        }
        latestDelivery.set(key(message.authorId, delivery.recipientId, delivery.content), {
          message,
          deliveryId: delivery.id
        })
      }
      if (message.source?.kind !== 'bot' || !message.source.content) continue
      const parent = latestDelivery.get(key(message.source.id, message.authorId, message.source.content))
      const delivery = parent?.message.deliveries?.find((candidate) => candidate.id === parent.deliveryId)
      if (!parent || !delivery || delivery.replies?.some((reply) => reply.id === message.id)) continue
      delivery.replies = [
        ...(delivery.replies ?? []),
        {
          id: message.id,
          senderId: message.authorId,
          senderName: message.authorName,
          content: message.text,
          createdAt: message.createdAt,
          replyGroupId: message.replyGroupId,
          attachments: message.attachments,
          error: message.error
        }
      ]
      changed.set(parent.message.id, parent.message)
    }

    if (!changed.size) return
    this.tx(() => {
      for (const message of changed.values()) {
        this.write('UPDATE messages SET data = ? WHERE id = ?', JSON.stringify(message), message.id)
      }
    })
  }

  /** Initialize profile metadata once. Production profiles intentionally start
   * empty; the optional demo crew exists only for focused orchestration tests. */
  private seed(includeDemo: boolean): void {
    if (this.meta('seeded') === '1') return
    this.tx(() => {
      if (!includeDemo) {
        this.setMeta('seeded', '1')
        this.setMeta('userName', 'You')
        this.setMeta(LEGACY_DEMO_REMOVED_META, '1')
        return
      }
      const agents = defaultAgents().map((agent) => ({ ...agent, ownerId: DEMO_ACCOUNT_ID }))
      const now = Date.now()
      const groupTopic = newTopic('', now)
      const dobiTopic = newTopic('', now)
      const linTopic = newTopic('', now)
      for (const agent of agents) this.putAgent(agent)

      this.putConversation({
        ownerId: DEMO_ACCOUNT_ID,
        id: 'crew',
        type: 'group',
        name: 'Dobi, Lin',
        description: 'The default crew: shape a goal together and hand the work to the right bot.',
        agentIds: agents.map((agent) => agent.id),
        leadAgentId: agents[0].id,
        topics: [groupTopic],
        activeTopicId: groupTopic.id,
        unread: 0,
        readAt: now,
        createdAt: now,
        updatedAt: now
      })
      this.putConversation({
        ownerId: DEMO_ACCOUNT_ID,
        id: 'direct-dobi',
        type: 'direct',
        name: 'Dobi',
        agentIds: ['dobi'],
        topics: [dobiTopic],
        activeTopicId: dobiTopic.id,
        unread: 0,
        readAt: now,
        createdAt: now - 120_000,
        updatedAt: now - 120_000
      })
      this.putConversation({
        ownerId: DEMO_ACCOUNT_ID,
        id: 'direct-lin',
        type: 'direct',
        name: 'Lin',
        agentIds: ['lin'],
        topics: [linTopic],
        activeTopicId: linTopic.id,
        unread: 0,
        readAt: now,
        createdAt: now - 240_000,
        updatedAt: now - 240_000
      })

      this.insertMessage({
        id: randomUUID(),
        conversationId: 'crew',
        topicId: groupTopic.id,
        authorId: 'dobi',
        authorName: 'Dobi',
        text: 'Drop a goal here. I’ll shape the plan and pull in the right bot.',
        kind: 'message',
        createdAt: now - 75_000
      })
      this.insertMessage({
        id: randomUUID(),
        conversationId: 'crew',
        topicId: groupTopic.id,
        authorId: 'lin',
        authorName: 'Lin',
        text: 'I’m ready to turn it into something you can ship.',
        kind: 'message',
        createdAt: now - 55_000
      })

      this.setMeta('seeded', '1')
      this.setMeta('userName', 'You')
      this.setMeta(CURRENT_ACCOUNT_META, DEMO_ACCOUNT_ID)
    })
  }

  /** Remove the old Dobi/Lin starter workspace only when it is still pristine.
   * Any user message, renamed contact, new group membership or automation makes
   * the migration leave it alone, so existing work is never discarded. */
  private removeUnusedLegacyDemo(): void {
    if (this.meta(LEGACY_DEMO_REMOVED_META) === '1') return
    const legacyAgentIds = new Set(['dobi', 'lin'])
    const legacyConversationIds = new Set(['crew', 'direct-dobi', 'direct-lin'])
    const expectedAgents = new Map(defaultAgents().map((agent) => [agent.id, agent]))
    const legacyAgents = this.agents.filter((agent) => legacyAgentIds.has(agent.id))
    const agentsArePristine = legacyAgents.length === 2 && legacyAgents.every((agent) => {
      const expected = expectedAgents.get(agent.id)
      return Boolean(
        expected
        && agent.name === expected.name
        && agent.role === expected.role
        && agent.instructions === expected.instructions
        && agent.labels === expected.labels
        && agent.color === expected.color
        && agent.provider === expected.provider
        && agent.model === expected.model
        && !agent.avatar
        && !agent.avatarEmoji
        && !agent.localAgentId
      )
    })
    const involvedConversations = this.conversations.filter((conversation) =>
      conversation.agentIds.some((agentId) => legacyAgentIds.has(agentId))
    )
    const conversationsArePristine = involvedConversations.every((conversation) => {
      if (
        !legacyConversationIds.has(conversation.id)
        || conversation.pinned
        || conversation.muted
        || conversation.hidden
        || conversation.manuallyUnread
        || conversation.topics.length !== 1
        || Boolean(conversation.topics[0]?.title)
      ) return false
      if (conversation.id === 'crew') {
        return conversation.type === 'group'
          && conversation.name === 'Dobi, Lin'
          && conversation.description === 'The default crew: shape a goal together and hand the work to the right bot.'
          && conversation.leadAgentId === 'dobi'
          && conversation.agentIds.join(',') === 'dobi,lin'
      }
      const agentId = conversation.id === 'direct-dobi' ? 'dobi' : 'lin'
      const expectedName = agentId === 'dobi' ? 'Dobi' : 'Lin'
      return conversation.type === 'direct'
        && conversation.name === expectedName
        && conversation.agentIds.length === 1
        && conversation.agentIds[0] === agentId
    })
    const starterTexts = new Set([
      'Drop a goal here. I’ll shape the plan and pull in the right bot.',
      'I’m ready to turn it into something you can ship.'
    ])
    const messagesArePristine = this.messages
      .filter((message) => legacyConversationIds.has(message.conversationId))
      .every((message) =>
        message.conversationId === 'crew'
        && legacyAgentIds.has(message.authorId)
        && starterTexts.has(message.text)
    )
    const hasRelatedPrivateMessages = this.privateMessages.some((message) =>
      legacyAgentIds.has(message.sender.id)
      || legacyAgentIds.has(message.recipient.id)
      || legacyConversationIds.has(message.conversationId)
    )
    const hasRelatedAutomation = this.routines.some((routine) =>
      legacyAgentIds.has(routine.agentId) || legacyConversationIds.has(routine.conversationId)
    ) || this.runs.some((run) =>
      legacyAgentIds.has(run.agentId) || legacyConversationIds.has(run.conversationId)
    )

    if (!agentsArePristine || !conversationsArePristine || !messagesArePristine || hasRelatedPrivateMessages || hasRelatedAutomation) return
    this.tx(() => {
      for (const conversationId of legacyConversationIds) {
        this.write('DELETE FROM conversations WHERE id = ?', conversationId)
      }
      for (const agentId of legacyAgentIds) this.write('DELETE FROM agents WHERE id = ?', agentId)
      this.setMeta(LEGACY_DEMO_REMOVED_META, '1')
    })
  }

  /** Assign each cloud contact one random, durable illustrated identity. This
   * also migrates contacts created before generated avatars were introduced.
   * Local agents keep their product logos and Dr. Dou keeps the built-in art. */
  private backfillAgentAvatarSeeds(): void {
    const contacts = this.agents.filter((agent) =>
      !agent.avatarSeed
      && !agent.localAgentId
      && agent.provider !== 'local'
      && agent.systemRole !== 'admin'
      && !agent.id.startsWith('dr-dou-')
    )
    if (!contacts.length) return
    this.tx(() => {
      for (const agent of contacts) {
        agent.avatarSeed = randomUUID()
        this.putAgent(agent)
      }
    })
  }

  /** Account-default contacts predate explicit capability roles. Mark every
   * surviving recorded contact at database open so migration does not depend
   * on another login event firing in the current desktop session. */
  private backfillSystemAdminRoles(): void {
    const fallback = defaultBuiltInAgent(EMBEDDED_BUILT_IN_AGENT_MANIFEST)
    const contacts = this.accountDefaultContacts()
      .map((record) => this.agent(record.agentId))
      .filter((agent): agent is AgentConfig => Boolean(agent && (
        agent.systemRole !== 'admin'
        || agent.systemKey !== fallback.systemKey
        || !agent.capabilities?.includes('manage_agents')
      )))
    if (!contacts.length) return
    this.tx(() => {
      for (const agent of contacts) {
        agent.systemRole = 'admin'
        agent.systemKey = fallback.systemKey
        agent.capabilities = [...fallback.capabilities]
        agent.templateVersion ??= fallback.templateVersion
        agent.modelRoute ??= fallback.modelRoute
        this.putAgent(agent)
      }
    })
  }

  /** Older releases stored every account in one device-wide workspace without
   * ownership fields. Recover deterministic ownership from the account's
   * system contact first, then from group membership and creation order. Data
   * that still cannot be attributed stays unowned and is hidden from every
   * signed-in account instead of leaking to whichever account logs in next. */
  private backfillAccountOwnership(): void {
    const agents = this.agents
    const conversations = this.conversations
    const routines = this.routines
    const runs = this.runs
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]))
    const changedAgents = new Set<AgentConfig>()
    const accountAnchors = this.accountDefaultContacts().flatMap((record) => {
      const agent = agentsById.get(record.agentId)
      if (!agent) return []
      if (agent.ownerId !== record.accountId) {
        agent.ownerId = record.accountId
        changedAgents.add(agent)
      }
      return [{ accountId: record.accountId, createdAt: agent.createdAt, agentId: agent.id }]
    }).sort((left, right) => left.createdAt - right.createdAt)

    for (const agent of agents) {
      if (agent.ownerId) continue
      const groupOwners = new Set(conversations
        .filter((conversation) => conversation.type === 'group' && conversation.agentIds.includes(agent.id))
        .flatMap((conversation) => conversation.agentIds)
        .map((agentId) => agentsById.get(agentId)?.ownerId)
        .filter((ownerId): ownerId is string => Boolean(ownerId)))
      const groupedOwner = groupOwners.size === 1 ? [...groupOwners][0] : undefined
      const temporalOwner = [...accountAnchors]
        .reverse()
        .find((anchor) => anchor.createdAt <= agent.createdAt)?.accountId
        ?? (accountAnchors.length === 1 ? accountAnchors[0].accountId : undefined)
      const ownerId = groupedOwner ?? temporalOwner
      if (!ownerId) continue
      agent.ownerId = ownerId
      changedAgents.add(agent)
    }

    const changedConversations: Conversation[] = []
    for (const conversation of conversations) {
      if (conversation.ownerId) continue
      const owners = new Set(conversation.agentIds
        .map((agentId) => agentsById.get(agentId)?.ownerId)
        .filter((ownerId): ownerId is string => Boolean(ownerId)))
      if (owners.size !== 1) continue
      conversation.ownerId = [...owners][0]
      changedConversations.push(conversation)
    }

    const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]))
    const changedRoutines: Routine[] = []
    for (const routine of routines) {
      if (routine.ownerId) continue
      const ownerId = agentsById.get(routine.agentId)?.ownerId
        ?? conversationsById.get(routine.conversationId)?.ownerId
      if (!ownerId) continue
      routine.ownerId = ownerId
      changedRoutines.push(routine)
    }

    const routinesById = new Map(routines.map((routine) => [routine.id, routine]))
    const changedRuns: TaskRun[] = []
    for (const run of runs) {
      if (run.ownerId) continue
      const ownerId = (run.routineId ? routinesById.get(run.routineId)?.ownerId : undefined)
        ?? agentsById.get(run.agentId)?.ownerId
        ?? conversationsById.get(run.conversationId)?.ownerId
      if (!ownerId) continue
      run.ownerId = ownerId
      changedRuns.push(run)
    }

    if (!changedAgents.size && !changedConversations.length && !changedRoutines.length && !changedRuns.length) return
    this.tx(() => {
      for (const agent of changedAgents) this.putAgent(agent)
      for (const conversation of changedConversations) this.putConversation(conversation)
      for (const routine of changedRoutines) this.putRoutine(routine)
      for (const run of changedRuns) this.putRun(run)
    })
  }

  private accountMetaKey(key: string, accountId = this.currentAccountId): string {
    return accountId ? `${ACCOUNT_META_PREFIX}${accountId}:${key}` : ''
  }

  private accountMeta(key: string, accountId = this.currentAccountId): string {
    const scopedKey = this.accountMetaKey(key, accountId)
    return scopedKey ? this.meta(scopedKey) : ''
  }

  private setAccountMeta(key: string, value: string, accountId = this.currentAccountId): void {
    const scopedKey = this.accountMetaKey(key, accountId)
    if (!scopedKey) throw new Error('Sign in before changing account data')
    this.setMeta(scopedKey, value)
  }

  /** Move settings written by pre-isolation releases into account namespaces.
   * Connector ownership can usually be recovered from its authorized agents.
   * Ambiguous profile/endpoint values migrate only when exactly one account is
   * known; with multiple accounts they remain quarantined and unreadable. */
  private migrateAccountSensitiveMeta(fallbackAccountId = this.meta(CURRENT_ACCOUNT_META)): void {
    const knownAccountIds = [...new Set(this.accountDefaultContacts().map((record) => record.accountId))]
    const unambiguousFallback = knownAccountIds.length <= 1 ? fallbackAccountId : ''
    const migrateValue = (legacyKey: string, accountKey: string): void => {
      const value = this.meta(legacyKey)
      if (!value || !unambiguousFallback) return
      if (!this.accountMeta(accountKey, unambiguousFallback)) this.setAccountMeta(accountKey, value, unambiguousFallback)
      this.setMeta(legacyKey, '')
    }
    migrateValue('userName', 'userName')
    migrateValue('userAvatar', 'userAvatar')
    migrateValue('endpoint', 'endpoint')

    let legacyConnectors: EmailConnectorAccount[] = []
    try {
      const value = JSON.parse(this.meta(LEGACY_CONNECTORS_META) || '[]') as unknown
      if (Array.isArray(value)) {
        legacyConnectors = value.filter((item): item is EmailConnectorAccount => Boolean(
          item && typeof item === 'object' && (item as EmailConnectorAccount).kind === 'email'
        ))
      }
    } catch { /* Malformed legacy connector metadata remains quarantined. */ }
    if (legacyConnectors.length) {
      const agentsById = new Map(this.agents.map((agent) => [agent.id, agent]))
      const grouped = new Map<string, EmailConnectorAccount[]>()
      for (const connector of legacyConnectors) {
        const owners = new Set(connector.agentIds
          .map((agentId) => agentsById.get(agentId)?.ownerId)
          .filter((ownerId): ownerId is string => Boolean(ownerId)))
        const ownerId = owners.size === 1 ? [...owners][0] : unambiguousFallback
        if (!ownerId) continue
        grouped.set(ownerId, [...(grouped.get(ownerId) ?? []), connector])
      }
      if (grouped.size) {
        for (const [ownerId, connectors] of grouped) {
          let existing: EmailConnectorAccount[] = []
          try {
            const value = JSON.parse(this.accountMeta('connectors', ownerId) || '[]') as unknown
            if (Array.isArray(value)) existing = value as EmailConnectorAccount[]
          } catch { /* Replace malformed account metadata with the recoverable legacy value. */ }
          const merged = new Map(existing.map((connector) => [connector.id, connector]))
          for (const connector of connectors) if (!merged.has(connector.id)) merged.set(connector.id, connector)
          this.setAccountMeta('connectors', JSON.stringify([...merged.values()]), ownerId)
        }
        this.setMeta(LEGACY_CONNECTORS_META, '')
      }
    }

    try {
      const outbox = JSON.parse(this.meta('socialTaskOutbox') || '[]') as Array<{
        id: string; ownerId: string; claim: string; reply: string; failed: boolean
      }>
      if (Array.isArray(outbox) && outbox.length) {
        const byOwner = new Map<string, typeof outbox>()
        for (const item of outbox) {
          if (!item?.ownerId) continue
          byOwner.set(item.ownerId, [...(byOwner.get(item.ownerId) ?? []), item])
        }
        for (const [ownerId, items] of byOwner) {
          if (!this.accountMeta('socialTaskOutbox', ownerId)) {
            this.setAccountMeta('socialTaskOutbox', JSON.stringify(items), ownerId)
          }
        }
        this.setMeta('socialTaskOutbox', '')
      }
    } catch { /* Malformed legacy outbox data is not exposed to any account. */ }

    for (const conversation of this.conversations) {
      if (!conversation.ownerId) continue
      const legacyKey = `socialClearedMessages:${conversation.id}`
      const value = this.meta(legacyKey)
      if (!value) continue
      const accountKey = `socialClearedMessages:${conversation.id}`
      if (!this.accountMeta(accountKey, conversation.ownerId)) {
        this.setAccountMeta(accountKey, value, conversation.ownerId)
      }
      this.setMeta(legacyKey, '')
    }
  }

  /** Older attachment files had no owner table. Their containing conversation
   * is authoritative, including attachments nested in delivery replies. */
  private backfillAttachmentOwnership(): void {
    const conversations = new Map(this.conversations.map((conversation) => [conversation.id, conversation]))
    for (const message of this.messages) {
      const ownerId = conversations.get(message.conversationId)?.ownerId
      if (!ownerId) continue
      const attachments = [
        ...(message.attachments ?? []),
        ...(message.deliveries ?? []).flatMap((delivery) =>
          (delivery.replies ?? []).flatMap((reply) => reply.attachments ?? [])
        )
      ]
      for (const attachment of attachments) {
        this.write('INSERT OR IGNORE INTO attachmentOwners (id, ownerId) VALUES (?, ?)', attachment.id, ownerId)
      }
    }
  }

  private insertMessage(message: ChatMessage): void {
    const reset = this.conversation(message.conversationId)?.topics.find(topic => topic.id === message.topicId)?.contextReset
    if (reset && message.createdAt >= reset.at) message.contextVersion = reset.id
    this.write(
      'INSERT INTO messages (id, conversationId, topicId, createdAt, data) VALUES (?, ?, ?, ?, ?)',
      message.id,
      message.conversationId,
      message.topicId,
      message.createdAt,
      JSON.stringify(message)
    )
  }

  // ───────────────────────────── collections ─────────────────────────────

  get agents(): AgentConfig[] {
    return this.all<AgentConfig>('SELECT data FROM agents ORDER BY rowid').map(agent => this.profileFiles?.load(agent) ?? agent)
  }

  get conversations(): Conversation[] {
    return this.all<Conversation>('SELECT data FROM conversations ORDER BY rowid')
  }

  get messages(): ChatMessage[] {
    return this.all<ChatMessage>('SELECT data FROM messages ORDER BY rowid')
  }

  get privateMessages(): PrivateMessage[] {
    return this.all<PrivateMessage>('SELECT data FROM privateMessages ORDER BY rowid')
  }

  get routines(): Routine[] {
    return this.all<Routine>('SELECT data FROM routines ORDER BY rowid')
  }

  get runs(): TaskRun[] {
    return this.all<TaskRun>('SELECT data FROM runs ORDER BY rowid')
  }

  get runEvents(): RunEvent[] {
    return this.all<RunEvent>('SELECT data FROM runEvents ORDER BY rowid')
  }

  get currentAccountId(): string {
    return this.meta(CURRENT_ACCOUNT_META)
  }

  captureAccountContext(): AccountContext {
    if (!this.currentAccountId) throw new Error('Sign in first.')
    return Object.freeze({ ownerId: this.currentAccountId, sessionId: this.accountSessionId })
  }

  assertAccountContext(context: AccountContext): void {
    if (!context.ownerId || context.ownerId !== this.currentAccountId || context.sessionId !== this.accountSessionId) {
      throw new Error('Account changed. Retry from the current session.')
    }
  }

  setCurrentAccountId(accountId: string): void {
    const normalized = accountId.trim()
    if (normalized !== this.currentAccountId) this.accountSessionId = randomUUID()
    this.setMeta(CURRENT_ACCOUNT_META, normalized)
    if (normalized) this.migrateAccountSensitiveMeta(normalized)
  }

  /** Account-scoped views are the only collections exposed to the renderer or
   * scheduler. Raw getters remain available for migrations and cascading
   * database maintenance inside the main process. */
  get accountAgents(): AgentConfig[] {
    const accountId = this.currentAccountId
    return accountId ? this.agents.filter((agent) => agent.ownerId === accountId) : []
  }

  get accountConversations(): Conversation[] {
    const accountId = this.currentAccountId
    return accountId ? this.conversations.filter((conversation) => conversation.ownerId === accountId) : []
  }

  get accountRoutines(): Routine[] {
    const accountId = this.currentAccountId
    return accountId ? this.routines.filter((routine) => routine.ownerId === accountId) : []
  }

  get accountRuns(): TaskRun[] {
    const accountId = this.currentAccountId
    return accountId ? this.runs.filter((run) => run.ownerId === accountId) : []
  }

  getConnanyNames(origin: string): Record<string, string> {
    try {
      const value: unknown = JSON.parse(this.accountMeta(`connany:names:${origin}`) || '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
      return Object.fromEntries(Object.entries(value).filter(([, name]) => typeof name === 'string'))
    } catch { return {} }
  }

  setConnanyName(origin: string, connectionId: string, name: string): void {
    const names = this.getConnanyNames(origin)
    this.setAccountMeta(`connany:names:${origin}`, JSON.stringify({ ...names, [connectionId]: name }))
  }

  getConnanySelections(origin: string): import('../shared/connany').ConnectorSelection[] {
    try {
      const value: unknown = JSON.parse(this.accountMeta(`connany:selections:${origin}`) || '[]')
      return Array.isArray(value) ? value.filter(item => item && typeof item.connectionId === 'string' && ['notion', 'github', 'linear'].includes(item.provider)) : []
    } catch { return [] }
  }

  setConnanySelections(origin: string, selections: import('../shared/connany').ConnectorSelection[]): void {
    this.setAccountMeta(`connany:selections:${origin}`, JSON.stringify(selections))
  }

  getConnanyBindings(origin: string): import('../shared/connany').ConnectorBinding[] {
    try {
      const value: unknown = JSON.parse(this.accountMeta(`connany:${origin}`) || '[]')
      return Array.isArray(value) ? value.filter(item => item && typeof item.agentId === 'string' && typeof item.connectionId === 'string' && ['notion', 'github', 'linear'].includes(item.provider)) : []
    } catch { return [] }
  }

  setConnanyBindings(origin: string, bindings: import('../shared/connany').ConnectorBinding[]): void {
    this.setAccountMeta(`connany:${origin}`, JSON.stringify(bindings))
  }

  get connectors(): EmailConnectorAccount[] {
    try {
      const value = JSON.parse(this.accountMeta('connectors') || '[]') as unknown
      return Array.isArray(value) ? value.filter((item): item is EmailConnectorAccount => Boolean(
        item && typeof item === 'object' && (item as EmailConnectorAccount).kind === 'email'
      )) : []
    } catch {
      return []
    }
  }

  setConnectors(connectors: EmailConnectorAccount[]): void {
    this.setAccountMeta('connectors', JSON.stringify(connectors))
  }

  // ───────────────────────────── profile & endpoint ─────────────────────────────

  get userName(): string {
    return this.accountMeta('userName') || 'You'
  }

  get userAvatar(): string {
    return this.accountMeta('userAvatar')
  }

  /** The account administrator survives independently from its deletable chat. */
  get systemAdminAgentId(): string | undefined {
    const accountId = this.meta(CURRENT_ACCOUNT_META)
    const record = this.accountDefaultContacts().find((item) => item.accountId === accountId)
    const agent = record ? this.agent(record.agentId) : undefined
    return agent?.systemRole === 'admin' ? agent.id : undefined
  }

  /** The welcome chat is account-specific, but may be deleted while its
   * system-administrator contact remains available in the contacts list. */
  get defaultConversationId(): string | undefined {
    const accountId = this.meta(CURRENT_ACCOUNT_META)
    const record = this.accountDefaultContacts().find((item) => item.accountId === accountId)
    return record && this.conversation(record.conversationId) ? record.conversationId : undefined
  }

  /** The OpenAI-compatible endpoint saved from the app's own settings. */
  get endpoint(): { baseUrl: string; apiKey: string } | undefined {
    const raw = this.accountMeta('endpoint')
    if (!raw) return undefined
    try {
      const value = JSON.parse(raw) as { baseUrl: string; apiKey: string }
      return value.baseUrl ? value : undefined
    } catch {
      return undefined
    }
  }

  setEndpoint(endpoint: { baseUrl: string; apiKey: string } | undefined): void {
    this.setAccountMeta('endpoint', endpoint?.baseUrl ? JSON.stringify(endpoint) : '')
  }

  setUserName(name: string): void {
    this.setAccountMeta('userName', name.trim() || 'You')
  }

  /**
   * The renderer downscales before sending; the checks here are the backstop.
   * A remote URL is refused outright — the state must never make the app fetch
   * an image at render time — and the cap keeps the row small.
   */
  setUserAvatar(dataUrl: string): void {
    const value = dataUrl.trim()
    if (!validAvatar(value)) return
    this.setAccountMeta('userAvatar', value)
  }

  // ───────────────────────────── agents ─────────────────────────────

  /** Create one system administrator for each Douchat account seen on this
   * local profile. Existing contacts are migrated; legacy deletions recover
   * the contact once without recreating a deliberately deleted chat later. */
  ensureDefaultCloudContact(
    accountId: string,
    binding: Pick<AgentConfig, 'provider' | 'model'>,
    remoteManifest?: BuiltInAgentManifest
  ): DefaultCloudContactResult {
    const normalizedAccountId = accountId.trim()
    if (!normalizedAccountId) return { created: false }
    const previousDefinition = defaultBuiltInAgent(this.builtInManifest(normalizedAccountId))
    if (remoteManifest) {
      this.setMeta(`${BUILT_IN_MANIFEST_META_PREFIX}${normalizedAccountId}`, JSON.stringify(remoteManifest))
    }
    const definition = localizedBuiltInAgent(defaultBuiltInAgent(remoteManifest ?? this.builtInManifest(normalizedAccountId)), this.interfaceLanguage)
    const records = this.accountDefaultContacts()
    const existingIndex = records.findIndex((record) => record.accountId === normalizedAccountId)
    const existing = records[existingIndex]
    if (existing) {
      const agent = this.agent(existing.agentId)
      if (agent) {
        const overrides = inferredBuiltInOverrides(agent)
        // Older profile forms submitted untouched defaults as user overrides.
        // Empty values are deliberate clears and must survive template refreshes.
        for (const key of ['role', 'instructions', 'labels'] as const) {
          if (overrides[key] && [...builtInDefaultValues(definition, key), ...builtInDefaultValues(previousDefinition, key)].includes(overrides[key])) delete overrides[key]
        }
        const model = definition.modelRoute === 'default' ? binding.model : definition.modelRoute
        const cloudAgentId = definition.id === 'system-admin-fallback' ? agent.cloudAgentId : definition.id
        Object.assign(agent, {
          ownerId: normalizedAccountId,
          name: overrides.name ?? definition.name,
          role: overrides.role ?? definition.role,
          instructions: overrides.instructions ?? definition.instructions,
          labels: overrides.labels ?? definition.labels ?? '',
          color: definition.color,
          provider: overrides.modelBinding?.provider ?? binding.provider,
          model: overrides.modelBinding?.model ?? model,
          thinkingLevel: overrides.thinkingLevel,
          systemRole: definition.systemRole,
          systemKey: definition.systemKey,
          cloudAgentId,
          templateVersion: definition.templateVersion,
          modelRoute: definition.modelRoute,
          capabilities: [...definition.capabilities],
          userOverrides: overrides,
          avatar: overrides.avatar ?? agent.avatar ?? '',
          avatarEmoji: overrides.avatarEmoji ?? agent.avatarEmoji ?? ''
        })
        this.putAgent(agent)
        const conversation = this.conversation(existing.conversationId)
        if (conversation && (conversation.name !== agent.name || conversation.ownerId !== normalizedAccountId)) {
          conversation.name = agent.name
          conversation.ownerId = normalizedAccountId
          this.putConversation(conversation)
        }
        records[existingIndex] = {
          ...existing,
          systemKey: definition.systemKey,
          cloudAgentId
        }
        this.setMeta(ACCOUNT_DEFAULT_CONTACTS_META, JSON.stringify(records))
        this.setCurrentAccountId(normalizedAccountId)
        return {
          agent,
          conversation,
          created: false
        }
      }
    }

    // Derived from the account, so every device creates the same contact and
    // cloud sync merges them instead of listing two.
    const accountScopedId = `system-admin-${createHash('sha256').update(normalizedAccountId).digest('hex').slice(0, 32)}`
    const preferredId = definition.id === 'system-admin-fallback' ? accountScopedId : definition.id
    const taken = (candidate: string) => this.agent(candidate) && this.agent(candidate)?.ownerId !== normalizedAccountId
    const id = !taken(preferredId) ? preferredId : !taken(accountScopedId) ? accountScopedId : `system-admin-${randomUUID()}`
    if (this.agent(id) && this.conversation(`direct-${id}`)) {
      // Already here, e.g. synced from another device: adopt it rather than reset its topics.
      const record = { accountId: normalizedAccountId, agentId: id, conversationId: `direct-${id}`, systemKey: definition.systemKey }
      if (existingIndex >= 0) records[existingIndex] = record
      else records.push(record)
      this.setMeta(ACCOUNT_DEFAULT_CONTACTS_META, JSON.stringify(records))
      return this.ensureDefaultCloudContact(normalizedAccountId, binding)
    }
    const now = Date.now()
    const model = definition.modelRoute === 'default' ? binding.model : definition.modelRoute
    const agent: AgentConfig = {
      ownerId: normalizedAccountId,
      id,
      name: definition.name,
      systemRole: definition.systemRole,
      systemKey: definition.systemKey,
      cloudAgentId: definition.id === 'system-admin-fallback' ? undefined : definition.id,
      templateVersion: definition.templateVersion,
      modelRoute: definition.modelRoute,
      capabilities: [...definition.capabilities],
      userOverrides: {},
      avatar: '',
      role: definition.role,
      instructions: definition.instructions,
      labels: definition.labels ?? '',
      color: definition.color,
      createdAt: now,
      provider: binding.provider,
      model
    }
    const topic = newTopic('', now)
    const conversation: Conversation = {
      ownerId: normalizedAccountId,
      id: `direct-${id}`,
      type: 'direct',
      name: agent.name,
      agentIds: [agent.id],
      topics: [topic],
      activeTopicId: topic.id,
      unread: 0,
      readAt: now,
      createdAt: now,
      updatedAt: now
    }
    return this.tx(() => {
      this.putAgent(agent)
      this.putConversation(conversation)
      const record = {
        accountId: normalizedAccountId,
        agentId: agent.id,
        conversationId: conversation.id,
        systemKey: definition.systemKey,
        cloudAgentId: agent.cloudAgentId
      }
      if (existingIndex >= 0) records[existingIndex] = record
      else records.push(record)
      this.setMeta(ACCOUNT_DEFAULT_CONTACTS_META, JSON.stringify(records))
      this.setCurrentAccountId(normalizedAccountId)
      return { agent, conversation, created: true }
    })
  }

  agent(agentId: string): AgentConfig | undefined {
    const agent = this.one<AgentConfig>('SELECT data FROM agents WHERE id = ?', agentId)
    return agent ? this.profileFiles?.load(agent) ?? agent : undefined
  }

  conversation(conversationId: string): Conversation | undefined {
    return this.one<Conversation>('SELECT data FROM conversations WHERE id = ?', conversationId)
  }

  socialClearedMessageIds(conversationId: string): string[] {
    try { return JSON.parse(this.accountMeta(`socialClearedMessages:${conversationId}`) || '[]') } catch { return [] }
  }

  linkSharedGroup(conversationId: string, roomId: string): void {
    const conversation = this.accountConversations.find((item) => item.id === conversationId)
    if (!conversation || conversation.type !== 'group') throw new Error('Chat not found')
    if (conversation.remoteRoomId && conversation.remoteRoomId !== roomId) throw new Error('Chat already shared')
    conversation.remoteRoomId = roomId
    this.putConversation(conversation)
  }

  /**
   * The local direct chat an agent room (kind 'agent') belongs to. Its replies
   * come from a douchat-host, but the chat stays the ordinary agent chat.
   */
  agentRoomConversation(ownerId: string, room: SocialRoom): Conversation | undefined {
    const remote = room.kind === 'agent' && room.agents.length === 1 ? room.agents[0] : undefined
    if (!remote || remote.ownerId !== ownerId) return undefined
    const linked = this.accountConversations.find((item) => item.remoteRoomId === room.id)
    if (linked) return linked.type === 'direct' && linked.agentIds[0] === remote.localId ? linked : undefined
    const agent = this.agent(remote.localId)
    if (!agent || (agent.ownerId ?? ownerId) !== ownerId) return undefined
    return this.accountConversations.find((item) => item.type === 'direct' && !item.id.startsWith('im-') && item.agentIds[0] === remote.localId && !item.remoteRoomId)
  }

  linkAgentRoom(conversationId: string, roomId: string): void {
    const conversation = this.accountConversations.find((item) => item.id === conversationId)
    if (!conversation || conversation.type !== 'direct' || conversation.id.startsWith('im-')) throw new Error('Chat not found')
    if (conversation.remoteRoomId && conversation.remoteRoomId !== roomId) throw new Error('Chat already linked')
    conversation.remoteRoomId = roomId
    this.putConversation(conversation)
  }

  syncFriendConversation(ownerId: string, room: SocialRoom, incoming: SocialMessage[], attachments = new Map<string, MessageAttachment[]>(), fileLinks = new Map<string, string[]>()): Conversation {
    if (ownerId !== this.currentAccountId || !room.members.some((member) => member.id === ownerId)) throw new Error('Chat account mismatch')
    const person = room.members.find((member) => member.id !== ownerId)
    if (room.kind === 'direct' && !person) throw new Error('Contact not found')
    const agentChat = room.kind === 'agent' ? this.agentRoomConversation(ownerId, room) : undefined
    if (room.kind === 'agent' && !agentChat) throw new Error('Contact not found')
    // Agent rooms report the room-scoped agent id; the local chat knows the agent by its local id.
    const authorOf = (agentId: string) => room.kind === 'agent' ? room.agents.find((agent) => agent.id === agentId)?.localId ?? agentId : agentId
    const id = agentChat?.id ?? this.accountConversations.find((item) => item.remoteRoomId === room.id)?.id ?? `${room.kind === 'direct' ? 'friend' : 'shared'}:${ownerId}:${room.id}`
    return this.tx(() => {
      const previous = this.conversation(id)
      const createdAt = Date.parse(room.createdAt)
      const conversation: Conversation = previous ?? {
        id, ownerId, type: room.kind === 'agent' ? 'direct' : room.kind, name: room.kind === 'direct' ? person!.name : room.name, agentIds: [], remoteRoomId: room.id,
        topics: [{ id: DEFAULT_TOPIC_ID, title: '', createdAt, updatedAt: createdAt }], activeTopicId: DEFAULT_TOPIC_ID,
        unread: 0, readAt: 0, createdAt, updatedAt: createdAt
      }
      if (room.kind === 'agent') {
        conversation.remoteRoomId = room.id
      } else {
        conversation.person = room.kind === 'direct' ? person : undefined
        conversation.name = room.kind === 'direct' ? person!.name : room.name
      }
      if (room.kind === 'group') {
        conversation.socialRoom = room
        conversation.agentIds = room.agents.map((agent) => agent.id)
      }
      this.putConversation(conversation)
      let unread = 0
      const cleared = new Set(this.socialClearedMessageIds(id))
      for (const message of [...incoming].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(Boolean(a.parentMessageId)) - Number(Boolean(b.parentMessageId)) || a.id.localeCompare(b.id))) {
        const messageId = `${id}:${message.id}`
        if (message.roomId !== room.id || cleared.has(messageId) || (message.parentMessageId && cleared.has(`${id}:${message.parentMessageId}`))) continue
        if (!message.parentMessageId) this.setMessageDeliveryState(messageId)
        const existingMessage = this.one<ChatMessage>('SELECT data FROM messages WHERE id = ?', messageId)
        if (!message.parentMessageId && existingMessage && message.id.includes(':delegate')) {
          existingMessage.authorId = message.authorId === ownerId ? 'user' : message.authorId
          existingMessage.authorName = message.authorName
          this.write('UPDATE messages SET data = ? WHERE id = ?', JSON.stringify(existingMessage), messageId)
        }
        if (!message.parentMessageId && !existingMessage) {
        this.insertMessage({ id: messageId, conversationId: id, topicId: conversation.activeTopicId,
          authorId: message.authorId === ownerId ? 'user' : message.authorId, authorName: message.authorName,
          text: [message.content, ...(fileLinks.get(message.id) ?? [])].filter(Boolean).join('\n\n'), attachments: attachments.get(message.id), kind: 'message', createdAt: Date.parse(message.createdAt) })
        conversation.updatedAt = Math.max(conversation.updatedAt, Date.parse(message.createdAt))
        if (message.authorId !== ownerId) unread++
        }
        if (message.agentId) {
          const parentId = `${id}:${message.parentMessageId || message.id}`
          const parent = this.one<ChatMessage>('SELECT data FROM messages WHERE id = ?', parentId)
          if (parent) {
            parent.socialTasks = [...(parent.socialTasks ?? []).filter((task) => task.id !== message.id), { id: message.id, agentId: authorOf(message.agentId), agentName: message.agentName || '', status: message.status }]
            this.write('UPDATE messages SET data = ? WHERE id = ?', JSON.stringify(parent), parentId)
          }
        }
        if (message.reply || message.replyImages?.length || message.replyFiles?.length) {
          const replyId = `${messageId}:reply`
          if (!cleared.has(replyId)) {
            const existingReply = this.one<ChatMessage>('SELECT data FROM messages WHERE id = ?', replyId)
            const reply: ChatMessage = { id: replyId, conversationId: id, topicId: conversation.activeTopicId,
              authorId: message.agentId ? authorOf(message.agentId) : 'system', authorName: message.agentName || '', text: fileLinks.has(`${message.id}:reply`) ? [message.reply, ...fileLinks.get(`${message.id}:reply`)!].filter(Boolean).join('\n\n') : message.replyFiles?.length && existingReply ? existingReply.text : message.reply ?? '',
              attachments: attachments.get(`${message.id}:reply`) ?? existingReply?.attachments,
              kind: 'message', createdAt: Date.parse(message.createdAt), ...(message.status === 'failed' ? { error: message.reply } : {}) }
            if (existingReply) this.write('UPDATE messages SET data = ? WHERE id = ?', JSON.stringify(reply), replyId)
            else { this.insertMessage(reply); unread++ }
          }
        }
      }
      // Older syncs stored delegation requests under the human owner's avatar.
      // Recover the actual caller from its parent task, even when that task was
      // hidden under a multi-agent human message or is outside the current page.
      for (const delegated of this.all<ChatMessage>("SELECT data FROM messages WHERE conversationId = ? AND id LIKE '%:delegate'", id)) {
        const parentTaskId = delegated.id.slice(`${id}:`.length, -':delegate'.length)
        const parentId = parentTaskId.includes(':delegate') ? parentTaskId : parentTaskId.split(':task:')[0]
        const parent = this.one<ChatMessage>('SELECT data FROM messages WHERE id = ?', `${id}:${parentId}`)
        const task = parent?.socialTasks?.find(task => task.id === parentTaskId)
        if (!task || delegated.authorId === task.agentId) continue
        delegated.authorId = task.agentId
        delegated.authorName = task.agentName
        this.write('UPDATE messages SET data = ? WHERE id = ?', JSON.stringify(delegated), delegated.id)
      }
      this.putConversation(conversation)
      if (unread) this.addUnread(id, unread)
      return this.conversation(id)!
    })
  }

  socialTaskOutbox(accountId = this.currentAccountId): { id: string; ownerId: string; claim: string; reply: string; images?: import('../shared/social').SocialImage[]; files?: import('../shared/social').SocialFile[]; failed: boolean }[] {
    try { return JSON.parse(this.accountMeta('socialTaskOutbox', accountId) || '[]') } catch { return [] }
  }

  saveSocialTaskResult(result: { id: string; ownerId: string; claim: string; reply: string; images?: import('../shared/social').SocialImage[]; files?: import('../shared/social').SocialFile[]; failed: boolean }): void {
    this.setAccountMeta('socialTaskOutbox', JSON.stringify([
      ...this.socialTaskOutbox(result.ownerId).filter((item) => item.id !== result.id),
      result
    ]), result.ownerId)
  }

  removeSocialTaskResult(id: string, accountId = this.currentAccountId): void {
    this.setAccountMeta('socialTaskOutbox', JSON.stringify(
      this.socialTaskOutbox(accountId).filter((item) => item.id !== id)
    ), accountId)
  }

  claimSocialAgent(agentId: string, ownerId: string): AgentConfig {
    const agent = this.agent(agentId)
    if (!agent || this.currentAccountId !== ownerId || (agent.ownerId && agent.ownerId !== ownerId)) {
      throw new Error("You may only add and run your own agents.")
    }
    if (!agent.ownerId) {
      agent.ownerId = ownerId
      this.putAgent(agent)
    }
    return agent
  }

  createAgent(input: ResolvedCreateAgentInput): AgentConfig {
    const ownerId = this.currentAccountId
    if (!ownerId) throw new Error('Sign in before creating a contact')
    const id = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot'}-${randomUUID()}`
    const now = Date.now()
    const {
      systemFilesDirectory: _ignoredSystemFilesDirectory,
      ownerId: _ignoredOwnerId,
      systemRole: _ignoredSystemRole,
      systemKey: _ignoredSystemKey,
      cloudAgentId: _ignoredCloudAgentId,
      templateVersion: _ignoredTemplateVersion,
      modelRoute: _ignoredModelRoute,
      capabilities: _ignoredCapabilities,
      userOverrides: _ignoredUserOverrides,
      ...safeInput
    } = input as ResolvedCreateAgentInput & Partial<AgentConfig>
    const avatar = validAvatar(input.avatar?.trim() ?? '') ? input.avatar?.trim() : ''
    const thinking = thinkingLevel(safeInput.thinkingLevel)
    delete safeInput.thinkingLevel
    const startupArgs = safeInput.localAgentId ? validateAgentStartupArgs(safeInput.startupArgs) : undefined
    delete safeInput.startupArgs
    const agent: AgentConfig = {
      ...safeInput,
      ...(startupArgs ? { startupArgs } : {}),
      ...(safeInput.systemFiles ? { systemFiles: validateAgentFiles(safeInput.systemFiles) } : {}),
      ...(thinking ? { thinkingLevel: thinking } : {}),
      ownerId,
      avatar,
      avatarEmoji: avatar ? '' : normalizeAgentEmoji(input.avatarEmoji),
      avatarSeed: !input.localAgentId && input.provider !== 'local' ? randomUUID() : undefined,
      id,
      createdAt: now
    }
    const topic = newTopic('', now)
    if (agent.systemFiles) this.profileFiles?.save(agent, agent.systemFiles)
    return this.tx(() => {
      this.putAgent(agent)
      this.putConversation({
        ownerId: agent.ownerId,
        id: `direct-${id}`,
        type: 'direct',
        name: agent.name,
        agentIds: [agent.id],
        topics: [topic],
        activeTopicId: topic.id,
        unread: 0,
        readAt: now,
        createdAt: now,
        updatedAt: now
      })
      return agent
    })
  }

  updateAgent(agentId: string, input: UpdateAgentInput, modelSelection?: {
    binding: Pick<AgentConfig, 'provider' | 'model'>
    followDefault: boolean
  }): AgentConfig | undefined {
    const agent = this.agent(agentId)
    if (!agent) return undefined
    if (input.expectedRevision !== undefined && input.expectedRevision !== agent.revision) throw new Error('Agent changed. Reload before saving.')
    const {
      expectedSystemFiles,
      expectedRevision: _expectedRevision,
      revision: _ignoredRevision,
      systemFilesDirectory: _ignoredSystemFilesDirectory,
      ownerId: _ignoredOwnerId,
      systemRole: _ignoredSystemRole,
      systemKey: _ignoredSystemKey,
      cloudAgentId: _ignoredCloudAgentId,
      templateVersion: _ignoredTemplateVersion,
      modelRoute: _ignoredModelRoute,
      capabilities: _ignoredCapabilities,
      userOverrides: _ignoredUserOverrides,
      ...next
    } = input as UpdateAgentInput & Partial<AgentConfig>
    if (agent.systemRole === 'admin') {
      // Raw renderer fields cannot override system identity or model routing.
      // Model changes use the separately validated selection below.
      delete next.color
      delete next.provider
      delete next.model
      delete next.localAgentId
    }
    if (expectedSystemFiles && next.systemFiles) {
      for (const name of Object.keys(next.systemFiles) as (keyof typeof next.systemFiles)[]) {
        if ((agent.systemFiles?.[name] ?? '') !== (expectedSystemFiles[name] ?? '')) throw new Error(`${name} changed. Reload before saving.`)
      }
    }
    const fileChanges = next.systemFiles ? validateAgentFiles(next.systemFiles) : undefined
    if (next.permissions !== undefined) next.permissions = agentPermissions(next.permissions)
    if ('startupArgs' in next) next.startupArgs = agent.localAgentId ? validateAgentStartupArgs(next.startupArgs) : undefined
    const thinkingChanged = 'thinkingLevel' in next
    const nextThinking = thinkingChanged ? thinkingLevel(next.thinkingLevel) : undefined
    if (thinkingChanged) next.thinkingLevel = nextThinking
    if (next.systemFiles !== undefined) next.systemFiles = { ...agent.systemFiles, ...validateAgentFiles(next.systemFiles) }
    if (next.skills !== undefined) {
      next.skills = validateAgentSkills(next.skills.map(skill => {
        if (!skill?.filesOmitted) return skill
        const previous = agent.skills?.find(item => item.id === skill.id)
        if (!previous) throw new Error('Skill files are unavailable. Reload and try again.')
        return { ...skill, files: previous.files }
      }))
      // Fresh directories prevent stale resources and never follow existing file symlinks.
      // Retain prior directories for replies already using the previous skill version.
      const created: string[] = []
      try {
        for (const skill of next.skills) {
          if (!skill.files) continue
          const previous = agent.skills?.find(item => item.id === skill.id)
          if (previous?.directory && previous.content === skill.content && JSON.stringify(previous.files) === JSON.stringify(skill.files)) {
            skill.directory = previous.directory
            continue
          }
          mkdirSync(this.skillDirectory, { recursive: true })
          const directory = mkdtempSync(join(this.skillDirectory, 'skill-'))
          created.push(directory)
          writeFileSync(join(directory, 'SKILL.md'), skill.content)
          for (const file of skill.files) {
            const target = join(directory, file.path)
            mkdirSync(dirname(target), { recursive: true })
            writeFileSync(target, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o700 })
          }
          skill.directory = directory
        }
      } catch (error) {
        for (const directory of created) rmSync(directory, { recursive: true, force: true })
        throw error
      }
    }
    if (next.avatar !== undefined) {
      next.avatar = next.avatar.trim()
      if (!validAvatar(next.avatar)) delete next.avatar
    }
    if (next.avatarEmoji !== undefined) {
      const original = next.avatarEmoji.trim()
      next.avatarEmoji = normalizeAgentEmoji(next.avatarEmoji)
      if (original && !next.avatarEmoji) delete next.avatarEmoji
    }
    if (next.avatar) next.avatarEmoji = ''
    if (next.avatarEmoji) next.avatar = ''
    if (agent.systemRole === 'admin') {
      const overrides = { ...agent.userOverrides }
      if (modelSelection) {
        if (modelSelection.followDefault) delete overrides.modelBinding
        else overrides.modelBinding = { ...modelSelection.binding }
        next.provider = modelSelection.binding.provider
        next.model = modelSelection.followDefault && agent.modelRoute && agent.modelRoute !== 'default'
          ? agent.modelRoute : modelSelection.binding.model
      }
      for (const key of ['name', 'role', 'avatar', 'avatarEmoji', 'instructions', 'labels'] as const) {
        if (next[key] !== undefined) {
          // Saving an avatar/name also submits untouched profile fields.
          if (['name', 'role', 'instructions', 'labels'].includes(key)
            && next[key] !== '' && next[key] === agent[key] && overrides[key] === undefined) continue
          overrides[key] = next[key]
        }
      }
      if (thinkingChanged) {
        if (nextThinking) overrides.thinkingLevel = nextThinking
        else delete overrides.thinkingLevel
      }
      agent.userOverrides = overrides
    }
    if (fileChanges) this.profileFiles?.save(agent, fileChanges)
    Object.assign(agent, next)
    return this.tx(() => {
      this.putAgent(agent)
      for (const conversation of this.conversations) {
        if (conversation.type === 'direct' && conversation.agentIds[0] === agentId) {
          conversation.name = conversation.id.startsWith('im-') ? `${agent.name} · ${conversation.name.split(' · ').at(-1) || 'IM'}` : agent.name
          this.putConversation(conversation)
        } else if (conversation.type === 'group' && !conversation.description) {
          conversation.name = this.groupName(conversation)
          this.putConversation(conversation)
        }
      }
      return agent
    })
  }

  private groupName(conversation: Conversation): string {
    if (!conversation.autoNamed) return conversation.name
    const names = conversation.agentIds.map((agentId) => this.agent(agentId)?.name).filter(Boolean)
    return names.join(', ') || conversation.name
  }

  deleteAgent(agentId: string): void {
    if (this.agent(agentId)?.systemRole === 'admin') {
      throw new Error('The system administrator cannot be deleted')
    }
    const deletedAgent = this.agent(agentId)
    if (deletedAgent) {
      this.userMemories.removeAgent(agentId)
      this.profileFiles?.remove(deletedAgent)
    }
    this.tx(() => {
      this.write('DELETE FROM agents WHERE id = ?', agentId)
      // Its own direct chats go with it, and the cascade takes their messages,
      // private deliveries and routines.
      for (const conversation of this.conversations) {
        if (conversation.type === 'direct' && conversation.agentIds.includes(agentId)) {
          this.write('DELETE FROM conversations WHERE id = ?', conversation.id)
          continue
        }
        const hadWorkspace = Boolean(conversation.agentWorkspaces?.[agentId] || conversation.hostWorkspaces?.[agentId])
        for (const field of ['agentWorkspaces', 'hostWorkspaces'] as const) {
          if (!conversation[field]?.[agentId]) continue
          delete conversation[field]![agentId]
          if (!Object.keys(conversation[field]!).length) delete conversation[field]
        }
        if (!conversation.agentIds.includes(agentId)) { if (hadWorkspace) this.putConversation(conversation); continue }
        conversation.agentIds = conversation.agentIds.filter((id) => id !== agentId)
        if (conversation.leadAgentId === agentId) conversation.leadAgentId = conversation.agentIds[0]
        conversation.name = this.groupName(conversation)
        this.putConversation(conversation)
      }
      this.write('DELETE FROM privateMessages WHERE senderId = ? OR recipientId = ?', agentId, agentId)
      // Runs first: the routines they point at have to still exist here.
      this.write('DELETE FROM runs WHERE agentId = ? OR routineId IN (SELECT id FROM routines WHERE agentId = ?)', agentId, agentId)
      this.write('DELETE FROM routines WHERE agentId = ?', agentId)
    })
  }

  // ───────────────────────────── conversations ─────────────────────────────

  /** Restore an existing private thread, or recreate it after the user deleted
   * it while keeping the contact. The stable id prevents duplicate directs. */
  ensureDirectConversation(agentId: string): { conversation: Conversation; created: boolean } {
    const agent = this.agent(agentId)
    if (!agent) throw new Error('Contact not found')
    const existing = this.conversations.find(
      (conversation) => conversation.type === 'direct' && !conversation.id.startsWith('im-') && conversation.agentIds[0] === agentId
    )
    if (existing) {
      existing.hidden = undefined
      this.putConversation(existing)
      return { conversation: existing, created: false }
    }
    const now = Date.now()
    const topic = newTopic('', now)
    const conversation: Conversation = {
      ownerId: (agent.ownerId ?? this.currentAccountId) || undefined,
      id: `direct-${agentId}`,
      type: 'direct',
      name: agent.name,
      agentIds: [agentId],
      topics: [topic],
      activeTopicId: topic.id,
      unread: 0,
      readAt: now,
      createdAt: now,
      updatedAt: now
    }
    this.putConversation(conversation)
    return { conversation, created: true }
  }

  /** Channels are transports for the contact's existing direct conversation. */
  ensureIMConversation(agentId: string, _channelId?: string, _provider?: string): Conversation {
    if (!this.accountAgents.some(item => item.id === agentId)) throw new Error('Contact not found')
    return this.ensureDirectConversation(agentId).conversation
  }

  /** Move legacy channel transcripts in place, preserving message ids, order and attachments. */
  private mergeLegacyIMConversations(): void {
    const legacy = this.conversations.filter(item => item.type === 'direct' && item.id.startsWith('im-'))
    if (!legacy.length) return
    this.tx(() => {
      for (const source of legacy) {
        const agent = this.agent(source.agentIds[0])
        if (!agent || agent.ownerId !== source.ownerId) continue
        let target = this.conversations.find(item => item.type === 'direct' && !item.id.startsWith('im-')
          && item.ownerId === source.ownerId && item.agentIds[0] === agent.id)
        if (!target) {
          const topic = newTopic('', source.createdAt)
          target = { id: `direct-${agent.id}`, ownerId: source.ownerId, type: 'direct', name: agent.name,
            agentIds: [agent.id], topics: [topic], activeTopicId: topic.id, unread: 0, readAt: source.readAt,
            createdAt: source.createdAt, updatedAt: source.updatedAt }
        }
        if (!target.topics.length) {
          const topic = newTopic('', target.createdAt)
          target.topics.push(topic); target.activeTopicId = topic.id
        }
        const active = target.topics.find(topic => topic.id === target!.activeTopicId) ?? target.topics[0]
        this.putConversation(target)
        const provider = source.name.split(' · ').at(-1)?.toLowerCase()
        if (provider && ['wechat', 'feishu', 'wecom', 'telegram'].includes(provider)) {
          this.write("UPDATE messages SET data = json_set(data, '$.sourceChannel', ?) WHERE conversationId = ? AND json_extract(data, '$.authorId') = 'user' AND json_extract(data, '$.sourceChannel') IS NULL", provider, source.id)
        }
        // Keep archived topics (and their reset boundaries); merge the current transcript.
        const topicIds = new Set([...source.topics.map(topic => topic.id),
          ...['messages', 'privateMessages', 'groupGames', 'groupWorkflows'].flatMap(table =>
            this.all<{ topicId: string }>(`SELECT data FROM ${table} WHERE conversationId = ?`, source.id).map(item => item.topicId))])
        for (const topicId of topicIds) {
          const oldTopic = source.topics.find(topic => topic.id === topicId)
          let nextTopicId = active.id
          if (topicId !== source.activeTopicId) {
            nextTopicId = target.topics.some(topic => topic.id === topicId) ? randomUUID() : topicId
            target.topics.push({ ...(oldTopic ?? newTopic('', source.createdAt)), id: nextTopicId })
          } else {
            active.updatedAt = Math.max(active.updatedAt, oldTopic?.updatedAt ?? source.updatedAt)
          }
          this.putConversation(target)
          for (const table of ['messages', 'privateMessages', 'groupGames', 'groupWorkflows']) {
            this.write(`UPDATE ${table} SET conversationId = ?, topicId = ?,
              data = json_set(data, '$.conversationId', ?, '$.topicId', ?)
              WHERE conversationId = ? AND topicId = ?`, target.id, nextTopicId, target.id, nextTopicId, source.id, topicId)
          }
        }
        this.write("UPDATE routines SET conversationId = ?, data = json_set(data, '$.conversationId', ?) WHERE conversationId = ?", target.id, target.id, source.id)
        this.write("UPDATE runs SET data = json_set(data, '$.conversationId', ?) WHERE json_extract(data, '$.conversationId') = ?", target.id, source.id)
        target.unread += source.unread
        target.updatedAt = Math.max(target.updatedAt, source.updatedAt)
        if (source.pinned) target.pinned = true
        if (!source.hidden) target.hidden = undefined
        this.putConversation(target)
        this.write('DELETE FROM conversations WHERE id = ?', source.id)
      }
    })
  }

  createGroup(input: CreateGroupInput): Conversation {
    const ownerId = this.currentAccountId
    if (!ownerId) throw new Error('Sign in before creating a group')
    const now = Date.now()
    const known = new Set(this.accountAgents.map((agent) => agent.id))
    const agentIds = [...new Set(input.agentIds)].filter((agentId) => known.has(agentId))
    const topic = newTopic('', now)
    const conversation: Conversation = {
      ownerId,
      id: `group-${randomUUID()}`,
      type: 'group',
      autoNamed: !input.name.trim(),
      name:
        input.name.trim() ||
        agentIds.map((agentId) => this.agent(agentId)?.name).filter(Boolean).join(', ') ||
        'New group',
      description: input.description?.trim() || undefined,
      agentIds,
      leadAgentId: agentIds.includes(input.leadAgentId ?? '') ? input.leadAgentId : agentIds[0],
      topics: [topic],
      activeTopicId: topic.id,
      unread: 0,
      readAt: now,
      createdAt: now,
      updatedAt: now
    }
    this.putConversation(conversation)
    return conversation
  }

  /** Callers must validate the folder and eligibility first. */
  setConversationAllowedFolders(conversationId: string, folders: string[]): void {
    const conversation = this.conversation(conversationId)
    if (!conversation) throw new Error('Chat not found')
    conversation.allowedFolders = [...new Set(folders)]
    this.putConversation(conversation)
  }

  /** Callers must validate the folder on its target and check the agent's owner first. */
  setAgentWorkspace(conversationId: string, agentId: string, binding: AgentWorkspaceBinding | undefined): Conversation | undefined {
    const conversation = this.conversation(conversationId)
    if (!conversation) return undefined
    // A folder on a douchat-host's server syncs; one on this computer or an SSH server stays here.
    for (const field of ['agentWorkspaces', 'hostWorkspaces'] as const) {
      const workspaces = { ...conversation[field] }
      if (binding && (field === 'hostWorkspaces') === binding.executionTargetId.startsWith('daemon:'))
        workspaces[agentId] = { path: binding.path, executionTargetId: binding.executionTargetId, targetRevision: binding.targetRevision }
      else delete workspaces[agentId]
      if (Object.keys(workspaces).length) conversation[field] = workspaces
      else delete conversation[field]
    }
    this.putConversation(conversation)
    return conversation
  }

  setConversationWorkspace(conversationId: string, workspacePath: string | undefined): Conversation | undefined {
    const conversation = this.conversation(conversationId)
    if (!conversation) return undefined
    if (workspacePath) conversation.workspacePath = workspacePath
    else delete conversation.workspacePath
    this.putConversation(conversation)
    return conversation
  }

  updateConversation(conversationId: string, input: UpdateConversationInput): Conversation | undefined {
    const conversation = this.conversation(conversationId)
    if (!conversation) return undefined
    if (input.expectedRevision !== undefined && input.expectedRevision !== conversation.revision) throw new Error('Conversation changed. Reload before saving.')
    if (conversation.type === 'group') {
      if (input.avatar !== undefined) {
        if (!validAvatar(input.avatar)) throw new Error('Invalid group avatar')
        conversation.avatar = input.avatar || undefined
        if (input.avatar) conversation.avatarEmoji = undefined
      }
      if (input.avatarEmoji !== undefined) {
        const emoji = normalizeAgentEmoji(input.avatarEmoji)
        if (input.avatarEmoji && !emoji) throw new Error('Invalid group emoji')
        conversation.avatarEmoji = emoji || undefined
        if (emoji) conversation.avatar = undefined
      }
    }
    if (input.savedToContacts !== undefined) conversation.savedToContacts = input.savedToContacts
    if (input.muted !== undefined) conversation.muted = input.muted
    if (input.hidden !== undefined) conversation.hidden = input.hidden
    if (input.manuallyUnread !== undefined) {
      conversation.manuallyUnread = input.manuallyUnread
      conversation.unread = input.manuallyUnread ? Math.max(1, conversation.unread) : 0
    }
    if (input.name?.trim()) {
      conversation.name = input.name.trim()
      if (conversation.type === 'group') conversation.autoNamed = false
    }
    if (input.description !== undefined) conversation.description = input.description.trim() || undefined
    if (input.agentIds && conversation.type === 'group') {
      const known = new Set(this.accountAgents.map((agent) => agent.id))
      conversation.agentIds = [...new Set(input.agentIds)].filter((agentId) => known.has(agentId))
      for (const field of ['agentWorkspaces', 'hostWorkspaces'] as const) {
        const saved = conversation[field]
        if (!saved) continue
        for (const agentId of Object.keys(saved)) if (!conversation.agentIds.includes(agentId)) delete saved[agentId]
        if (!Object.keys(saved).length) delete conversation[field]
      }
      if (!conversation.agentIds.includes(conversation.leadAgentId ?? '')) {
        conversation.leadAgentId = conversation.agentIds[0]
      }
    }
    if (input.leadAgentId && conversation.agentIds.includes(input.leadAgentId)) {
      conversation.leadAgentId = input.leadAgentId
    }
    conversation.updatedAt = Date.now()
    this.putConversation(conversation)
    return conversation
  }

  deleteConversation(conversationId: string): void {
    const target = this.conversation(conversationId)
    if (target?.remoteRoomId || target?.savedToContacts) {
      this.clearConversation(conversationId)
      this.updateConversation(conversationId, { hidden: true })
      return
    }
    // Messages, private deliveries and routines cascade from the row.
    this.write('DELETE FROM conversations WHERE id = ?', conversationId)
  }

  setConversationPinned(conversationId: string, pinned: boolean): void {
    const conversation = this.conversation(conversationId)
    if (!conversation) return
    conversation.pinned = pinned || undefined
    this.putConversation(conversation)
  }

  markConversationRead(conversationId: string): void {
    const conversation = this.conversation(conversationId)
    if (!conversation) return
    conversation.manuallyUnread = false
    conversation.unread = 0
    conversation.readAt = Date.now()
    this.putConversation(conversation)
  }

  markAllConversationsRead(): void {
    const now = Date.now()
    this.tx(() => {
      for (const conversation of this.accountConversations) {
        conversation.manuallyUnread = false
        conversation.unread = 0
        conversation.readAt = now
        this.putConversation(conversation)
      }
    })
  }

  /** How far each shared room has been read here, for other clients to match.
   * A room with nothing unread counts as read through its latest activity. */
  roomReadMarks(): RoomReadMark[] {
    return this.accountConversations.flatMap((conversation) => {
      if (!conversation.remoteRoomId) return []
      const caughtUp = !conversation.unread && !conversation.manuallyUnread
      const readAt = Math.max(conversation.readAt ?? 0, caughtUp ? conversation.updatedAt ?? 0 : 0)
      return readAt ? [{ roomId: conversation.remoteRoomId, readAt }] : []
    })
  }

  /** Another client read a shared room up to `readAt`: drop the unread it covers. */
  applyRoomRead(mark: RoomReadMark): boolean {
    const conversation = this.accountConversations.find((item) => item.remoteRoomId === mark.roomId)
    if (!conversation || mark.readAt <= (conversation.readAt ?? 0)) return false
    const later = this.all<ChatMessage>('SELECT data FROM messages WHERE conversationId = ?', conversation.id)
      .filter((message) => message.authorId !== 'user' && message.kind === 'message' && message.createdAt > mark.readAt).length
    conversation.readAt = mark.readAt
    conversation.unread = Math.min(conversation.unread, later)
    if (!later) conversation.manuallyUnread = false
    this.putConversation(conversation)
    return true
  }

  addUnread(conversationId: string, count: number): void {
    const conversation = this.conversation(conversationId)
    if (!conversation || count <= 0) return
    conversation.hidden = false
    conversation.unread += count
    this.putConversation(conversation)
  }

  // ───────────────────────────── topics ─────────────────────────────

  createTopic(conversationId: string): Topic | undefined {
    const conversation = this.conversation(conversationId)
    if (!conversation) return undefined
    const topic = newTopic('', Date.now())
    conversation.topics.push(topic)
    conversation.activeTopicId = topic.id
    conversation.updatedAt = topic.createdAt
    this.putConversation(conversation)
    return topic
  }

  renameTopic(conversationId: string, topicId: string, title: string): void {
    const conversation = this.conversation(conversationId)
    const topic = conversation?.topics.find((item) => item.id === topicId)
    if (!conversation || !topic) return
    topic.title = title.trim().slice(0, 80)
    topic.updatedAt = Date.now()
    this.putConversation(conversation)
  }

  deleteTopic(conversationId: string, topicId: string): void {
    const conversation = this.conversation(conversationId)
    if (!conversation || conversation.topics.length <= 1) return
    this.tx(() => {
      conversation.topics = conversation.topics.filter((topic) => topic.id !== topicId)
      if (conversation.activeTopicId === topicId) conversation.activeTopicId = conversation.topics[0].id
      conversation.updatedAt = Date.now()
      this.putConversation(conversation)
      this.write('DELETE FROM messages WHERE conversationId = ? AND topicId = ?', conversationId, topicId)
      this.write('DELETE FROM privateMessages WHERE conversationId = ? AND topicId = ?', conversationId, topicId)
      this.write('DELETE FROM groupGames WHERE conversationId = ? AND topicId = ?', conversationId, topicId)
      this.write('DELETE FROM groupWorkflows WHERE conversationId = ? AND topicId = ?', conversationId, topicId)
    })
  }

  setActiveTopic(conversationId: string, topicId: string): void {
    const conversation = this.conversation(conversationId)
    if (!conversation || !conversation.topics.some((topic) => topic.id === topicId)) return
    conversation.activeTopicId = topicId
    this.putConversation(conversation)
  }

  activeTopicId(conversationId: string): string {
    const conversation = this.conversation(conversationId)
    if (!conversation) return DEFAULT_TOPIC_ID
    return conversation.topics.some((topic) => topic.id === conversation.activeTopicId)
      ? conversation.activeTopicId
      : conversation.topics[0]?.id ?? DEFAULT_TOPIC_ID
  }

  // ───────────────────────────── messages ─────────────────────────────

  recentMessages(): ChatMessage[] {
    return this.all<ChatMessage>(`SELECT data FROM (
      SELECT data, rowid AS sequence, ROW_NUMBER() OVER (
        PARTITION BY conversationId, topicId ORDER BY rowid DESC
      ) AS position FROM messages
    ) WHERE position <= 51 ORDER BY sequence`)
  }

  searchMessages(conversationId: string, query: string): ChatMessage[] {
    if (!query.trim()) return []
    return this.all<ChatMessage>(`SELECT data FROM messages WHERE conversationId = ?
      AND instr(lower(json_extract(data, '$.text')), lower(?)) > 0 ORDER BY rowid DESC LIMIT 100`, conversationId, query.trim())
  }

  messagePage(conversationId: string, topicId: string, before?: string): { messages: ChatMessage[]; hasMore: boolean } {
    const rows = this.all<ChatMessage>(`SELECT data FROM messages
      WHERE conversationId = ? AND topicId = ?
      AND rowid < COALESCE((SELECT rowid FROM messages WHERE id = ? AND conversationId = ? AND topicId = ?), 9223372036854775807)
      ORDER BY rowid DESC LIMIT 51`, conversationId, topicId, before ?? '', conversationId, topicId)
    return { messages: rows.slice(0, 50).reverse(), hasMore: rows.length > 50 }
  }

  topicMessages(conversationId: string, topicId: string): ChatMessage[] {
    return this.all<ChatMessage>(
      'SELECT data FROM messages WHERE conversationId = ? AND topicId = ? ORDER BY rowid',
      conversationId,
      topicId
    )
  }

  contextMessages(conversationId: string, topicId: string): ChatMessage[] {
    const reset = this.conversation(conversationId)?.topics.find(topic => topic.id === topicId)?.contextReset
    return this.topicMessages(conversationId, topicId).filter(message => !reset || message.contextVersion === reset.id)
  }

  contextPrivateMessages(conversationId: string, topicId: string): PrivateMessage[] {
    const reset = this.conversation(conversationId)?.topics.find(topic => topic.id === topicId)?.contextReset
    return this.topicPrivateMessages(conversationId, topicId).filter(message => !reset || message.contextVersion === reset.id)
  }

  resetConversationContext(conversationId: string, topicId: string): void {
    const conversation = this.accountConversations.find(item => item.id === conversationId)
    const topic = conversation?.topics.find(item => item.id === topicId)
    if (!conversation || !topic) throw new Error('Chat not found')
    this.tx(() => {
      const reset = { id: randomUUID(), at: Date.now() }
      // Keep the visible boundary outside the new model context, including on
      // repeated resets. This local notice is never sent to shared rooms.
      this.insertMessage({ id: `context-reset:${reset.id}`, conversationId, topicId,
        authorId: 'system', authorName: 'Douchat', kind: 'system', text: 'Context reset', createdAt: reset.at })
      topic.contextReset = reset
      if (conversation.type === 'group') this.saveGroupHealth(conversationId, {})
      this.write('DELETE FROM groupGames WHERE conversationId = ? AND topicId = ?', conversationId, topicId)
      this.putConversation(conversation)
    })
  }

  topicPrivateMessages(conversationId: string, topicId: string): PrivateMessage[] {
    return this.all<PrivateMessage>(
      'SELECT data FROM privateMessages WHERE conversationId = ? AND topicId = ? ORDER BY rowid',
      conversationId,
      topicId
    )
  }

  setMessageDeliveryState(id: string, deliveryState?: ChatMessage['deliveryState']): void {
    const message = this.one<ChatMessage>('SELECT data FROM messages WHERE id = ?', id)
    if (!message || this.conversation(message.conversationId)?.ownerId !== this.currentAccountId) return
    message.deliveryState = deliveryState
    this.write('UPDATE messages SET data = ? WHERE id = ?', JSON.stringify(message), id)
  }

  addMessage(message: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): ChatMessage {
    const result: ChatMessage = {
      ...message,
      id: message.id ?? randomUUID(),
      createdAt: message.createdAt ?? Date.now()
    }
    return this.tx(() => {
      this.insertMessage(result)
      const conversation = this.conversation(message.conversationId)
      if (conversation) {
        conversation.updatedAt = result.createdAt
        const topic = conversation.topics.find((item) => item.id === result.topicId)
        if (topic) {
          topic.updatedAt = result.createdAt
          // The first human line names the topic, the way a chat thread is titled.
          if (!topic.title && result.authorId === 'user') {
            topic.title = (result.text || result.attachments?.map((attachment) => attachment.name).join(', ') || 'Image').slice(0, 80)
          }
        }
        this.putConversation(conversation)
      }
      return result
    })
  }

  imReceipt(id: string, conversationId: string): ChatMessage | undefined {
    if (this.conversation(conversationId)?.ownerId !== this.currentAccountId) return undefined
    return this.one<ChatMessage>("SELECT data FROM messages WHERE id = ? AND conversationId = ? AND json_extract(data, '$.authorId') = 'user'", id, conversationId)
  }

  completeIMReceipt(id: string, text: string, attachments: ChatMessage['attachments']): ChatMessage {
    const message = this.one<ChatMessage>('SELECT data FROM messages WHERE id = ?', id)
    if (!message || message.authorId !== 'user' || this.conversation(message.conversationId)?.ownerId !== this.currentAccountId) throw new Error('IM receipt not found')
    const updated = { ...message, text, ...(attachments?.length ? { attachments } : {}) }
    this.db.prepare('UPDATE messages SET data = ? WHERE id = ?').run(JSON.stringify(updated), id)
    return updated
  }

  addDeliveryReplies(deliveryId: string, replies: MessageDeliveryReply[]): void {
    if (!replies.length) return
    this.tx(() => {
      const message = this.one<ChatMessage>(
        `SELECT messages.data AS data
         FROM messages, json_each(messages.data, '$.deliveries') AS delivery
         WHERE json_extract(delivery.value, '$.id') = ?
         ORDER BY messages.rowid DESC LIMIT 1`,
        deliveryId
      )
      const delivery = message?.deliveries?.find((candidate) => candidate.id === deliveryId)
      if (!message || !delivery) return
      const known = new Set(delivery.replies?.map((reply) => reply.id) ?? [])
      delivery.replies = [...(delivery.replies ?? []), ...replies.filter((reply) => !known.has(reply.id))]
      this.write('UPDATE messages SET data = ? WHERE id = ?', JSON.stringify(message), message.id)
    })
  }

  addPrivateMessages(messages: PrivateMessage[]): void {
    if (!messages.length) return
    this.tx(() => {
      for (const message of messages) {
        const reset = this.conversation(message.conversationId)?.topics.find(topic => topic.id === message.topicId)?.contextReset
        if (reset && message.createdAt >= reset.at) message.contextVersion = reset.id
        this.write(
          `INSERT INTO privateMessages (id, conversationId, topicId, senderId, recipientId, createdAt, data)
           VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          message.id,
          message.conversationId,
          message.topicId,
          message.sender.id,
          message.recipient.id,
          message.createdAt,
          JSON.stringify(message)
        )
      }
      this.write(
        'DELETE FROM privateMessages WHERE rowid NOT IN (SELECT rowid FROM privateMessages ORDER BY rowid DESC LIMIT ?)',
        PRIVATE_MESSAGE_LIMIT
      )
    })
  }

  deleteMessage(conversationId: string, messageId: string): void {
    this.tx(() => {
      const conversation = this.conversation(conversationId)
      if (conversation?.remoteRoomId) {
        const cleared = new Set(this.socialClearedMessageIds(conversationId))
        cleared.add(messageId)
        this.setAccountMeta(`socialClearedMessages:${conversationId}`, JSON.stringify([...cleared]), conversation.ownerId)
      }
      this.write('DELETE FROM messages WHERE conversationId = ? AND id = ?', conversationId, messageId)
    })
  }

  clearConversation(conversationId: string, topicId?: string): void {
    this.tx(() => {
      const remote = this.conversation(conversationId)
      if (remote?.remoteRoomId) {
        const cleared = new Set(this.socialClearedMessageIds(conversationId))
        for (const message of this.topicMessages(conversationId, DEFAULT_TOPIC_ID)) cleared.add(message.id)
        this.setAccountMeta(`socialClearedMessages:${conversationId}`, JSON.stringify([...cleared]), remote.ownerId)
        remote.unread = 0
        remote.manuallyUnread = false
        this.putConversation(remote)
      }
      if (topicId === undefined) {
        this.write('DELETE FROM groupGames WHERE conversationId = ?', conversationId)
        this.write('DELETE FROM groupWorkflows WHERE conversationId = ?', conversationId)
        this.write('DELETE FROM messages WHERE conversationId = ?', conversationId)
        this.write('DELETE FROM privateMessages WHERE conversationId = ?', conversationId)
        return
      }
      this.write('DELETE FROM messages WHERE conversationId = ? AND topicId = ?', conversationId, topicId)
      this.write('DELETE FROM privateMessages WHERE conversationId = ? AND topicId = ?', conversationId, topicId)
      this.write('DELETE FROM groupGames WHERE conversationId = ? AND topicId = ?', conversationId, topicId)
      this.write('DELETE FROM groupWorkflows WHERE conversationId = ? AND topicId = ?', conversationId, topicId)
      const conversation = this.conversation(conversationId)
      const topic = conversation?.topics.find((item) => item.id === topicId)
      if (conversation && topic) {
        topic.title = ''
        delete topic.contextReset
        this.putConversation(conversation)
      }
    })
  }

  // ───────────────────────────── routines & runs ─────────────────────────────

  createRoutine(input: CreateRoutineInput, nextRunAt: number): Routine {
    const now = Date.now()
    const ownerId = this.currentAccountId
    if (!ownerId) throw new Error('Sign in before creating a scheduled task')
    const routine: Routine = {
      ...input,
      ownerId,
      id: randomUUID(),
      target: 'local',
      enabled: true,
      nextRunAt,
      createdAt: now,
      updatedAt: now
    }
    this.putRoutine(routine)
    return routine
  }

  deleteRoutine(routineId: string): void {
    this.write('DELETE FROM routines WHERE id = ?', routineId)
  }

  private routine(routineId: string): Routine | undefined {
    return this.one<Routine>('SELECT data FROM routines WHERE id = ?', routineId)
  }

  setRoutineEnabled(routineId: string, enabled: boolean, nextRunAt?: number): Routine | undefined {
    const routine = this.routine(routineId)
    if (!routine) return undefined
    routine.enabled = enabled
    if (nextRunAt !== undefined) routine.nextRunAt = nextRunAt
    routine.updatedAt = Date.now()
    this.putRoutine(routine)
    return routine
  }

  markRoutineTriggered(routineId: string, triggeredAt: number, nextRunAt: number): Routine | undefined {
    const routine = this.routine(routineId)
    if (!routine) return undefined
    routine.lastRunAt = triggeredAt
    routine.nextRunAt = nextRunAt
    routine.updatedAt = triggeredAt
    this.putRoutine(routine)
    return routine
  }

  createRun(
    input: Omit<TaskRun, 'id' | 'status' | 'createdAt' | 'target'> & { status?: RunStatus; createdAt?: number }
  ): TaskRun {
    const routineOwnerId = input.routineId ? this.routine(input.routineId)?.ownerId : undefined
    const agentOwnerId = this.agent(input.agentId)?.ownerId
    const run: TaskRun = {
      ...input,
      ownerId: (input.ownerId ?? routineOwnerId ?? agentOwnerId ?? this.currentAccountId) || undefined,
      id: randomUUID(),
      target: 'local',
      status: input.status ?? 'queued',
      createdAt: input.createdAt ?? Date.now()
    }
    return this.tx(() => {
      this.putRun(run)
      // Oldest runs fall off the back; their events cascade with them.
      this.write('DELETE FROM runs WHERE rowid NOT IN (SELECT rowid FROM runs ORDER BY rowid DESC LIMIT ?)', RUN_LIMIT)
      return run
    })
  }

  updateRun(
    runId: string,
    patch: Partial<Pick<TaskRun, 'status' | 'latestActivity' | 'error' | 'startedAt' | 'finishedAt'>>
  ): TaskRun | undefined {
    const run = this.one<TaskRun>('SELECT data FROM runs WHERE id = ?', runId)
    if (!run) return undefined
    Object.assign(run, patch)
    this.putRun(run)
    return run
  }

  addRunEvent(input: Omit<RunEvent, 'id' | 'createdAt'> & { createdAt?: number }): RunEvent {
    const event: RunEvent = {
      ...input,
      id: randomUUID(),
      createdAt: input.createdAt ?? Date.now()
    }
    return this.tx(() => {
      const parent = this.stmt('SELECT 1 FROM runs WHERE id = ?').get(event.runId)
      if (!parent) return event
      this.write(
        'INSERT INTO runEvents (id, runId, createdAt, data) VALUES (?, ?, ?, ?)',
        event.id,
        event.runId,
        event.createdAt,
        JSON.stringify(event)
      )
      this.write(
        'DELETE FROM runEvents WHERE rowid NOT IN (SELECT rowid FROM runEvents ORDER BY rowid DESC LIMIT ?)',
        RUN_EVENT_LIMIT
      )
      return event
    })
  }
}
