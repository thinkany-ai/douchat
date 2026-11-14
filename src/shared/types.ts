import type { SelectedMention } from './bot/mentions'
import type { DesktopDeviceApi } from './deviceApi'
import type { AccountDataApi } from './accountData'
import type { CustomModelConfig, CustomProviderInput, CustomModelTest } from './customModels'
import type { ThinkingLevel } from './thinkingLevels'
import type { AgentPermissions, PermissionRequest } from './agentPermissions'
import type { SocialAction, SocialResult, SocialSnapshot } from './social'
export type AgentStatus = 'idle' | 'thinking' | 'offline'
export type ComputerStatus = 'stopped' | 'starting' | 'ready' | 'working' | 'error'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type RunTrigger = 'chat' | 'manual' | 'schedule'

export interface LocalAgent {
  id: string
  name: string
  command: string
  /** A launchable CLI with a Douchat conversation adapter is available. */
  installed: boolean
  /** Something belonging to this agent was found, even if it was only a desktop app. */
  discovered: boolean
  path?: string
  desktopPath?: string
  version?: string
  latestVersion?: string
  updateStatus?: 'available' | 'current' | 'unknown'
  chatSupported: boolean
  status: 'ready' | 'desktop-only' | 'not-found'
  /** Authentication is deliberately checked by the CLI when the first chat runs. */
  authentication: 'unchecked'
  /** User-registered commands use the generic prompt-argument/text-output adapter. */
  custom?: boolean
  avatar?: string
  args?: string[]
  /** Present only for user-registered agents that run on a remote server over SSH. */
  remote?: RemoteAgentSpec
}

export const REMOTE_AGENT_ADAPTERS = ['codex', 'claude', 'gemini', 'grok', 'cursor', 'opencode', 'kimi', 'openclaw', 'fastclaw', 'hermes', 'omp', 'custom'] as const
export type RemoteAgentAdapter = typeof REMOTE_AGENT_ADAPTERS[number]

/** Structured SSH launch settings. There is intentionally no free-form shell
 * command and no custom ssh option field: every value is validated in main. */
export interface RemoteAgentSpec {
  transport: 'ssh'
  host: string
  port?: number
  user?: string
  /** Absolute path of a private key on this computer. */
  identityFile?: string
  adapter: RemoteAgentAdapter
  /** Remote command name or absolute POSIX path. */
  executable: string
  /** One argument per entry; only the custom adapter may use {prompt}. */
  args: string[]
  /** Login PATH discovered by the connection probe on this server. */
  remotePath?: string
  /** Remote $HOME discovered by the connection probe. */
  remoteHome?: string
  /** Friends and other owners may call this agent only when enabled. */
  allowSharing: boolean
}

export interface CustomLocalAgentInput {
  name: string
  /** Executable name on PATH or an absolute executable path. Never run through a shell. */
  command: string
  avatar?: string
  /** One argument per entry; custom commands may use {prompt}. */
  args?: string[]
  remote?: RemoteAgentSpec
}

export interface AgentConfig {
  /** Local record version; absent only before migration. Not a sync cursor. */
  revision?: number
  systemFilesDirectory?: string
  systemFiles?: import('./agentCustomization').AgentFiles
  skills?: import('./agentCustomization').AgentSkill[]
  followDefaultModel?: boolean
  permissions?: AgentPermissions
  /** Account ownership used for shared group execution. */
  ownerId?: string
  localAgentId?: string
  /** Snapshot of a custom local runtime's display name for durable contact labels. */
  localAgentName?: string
  /** This agent's own startup arguments, appended after its runtime's arguments. */
  startupArgs?: string[]

  id: string
  name: string
  /** First-party account authority. User-created agents never receive this. */
  systemRole?: 'admin'
  /** Stable identity and policy supplied by the Douchat service. */
  systemKey?: string
  cloudAgentId?: string
  templateVersion?: number
  modelRoute?: string
  capabilities?: BuiltInAgentCapability[]
  /** User-owned presentation/personality fields layered over cloud defaults. */
  userOverrides?: BuiltInAgentUserOverrides
  /** Optional user-selected picture, stored locally as a compact data URL. */
  avatar?: string
  /** Optional single-grapheme emoji avatar; mutually exclusive with avatar. */
  avatarEmoji?: string
  /** Stable random seed for the built-in illustrated human avatar fallback. */
  avatarSeed?: string
  role: string
  instructions: string
  color: string
  provider: string
  model: string
  /** Reasoning depth; unset follows the default for the execution mode. */
  thinkingLevel?: ThinkingLevel
  /** Free-form labels that colour a bot's greeting and personality. */
  labels?: string
  createdAt: number
}

export type BuiltInAgentCapability = 'manage_agents'

export interface BuiltInAgentUserOverrides {
  /** Explicit model selection, validated and resolved by the main process. */
  modelBinding?: Pick<AgentConfig, 'provider' | 'model'>
  role?: string
  thinkingLevel?: ThinkingLevel
  name?: string
  avatar?: string
  avatarEmoji?: string
  instructions?: string
  labels?: string
}

export type BuiltInAgentLocalization = Pick<BuiltInAgentDefinition, 'role' | 'instructions' | 'labels'>

export interface BuiltInAgentDefinition {
  localizations?: Partial<Record<'en' | 'zh-CN', BuiltInAgentLocalization>>
  id: string
  systemKey: string
  systemRole: 'admin'
  capabilities: BuiltInAgentCapability[]
  templateVersion: number
  name: string
  role: string
  instructions: string
  labels?: string
  color: string
  modelRoute: string
}

export interface BuiltInAgentManifest {
  version: number
  agents: BuiltInAgentDefinition[]
}

export interface Topic {
  contextReset?: { id: string; at: number }
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface Conversation {
  /** Local record version; absent only before migration. Not a sync cursor. */
  revision?: number
  /** Only unnamed groups follow member names; legacy and explicitly named groups keep their names. */
  autoNamed?: boolean
  avatar?: string
  avatarEmoji?: string
  /** Human direct conversations use the same local inbox, with a remote delivery address. */
  person?: import('./social').SocialPerson
  remoteRoomId?: string
  socialRoom?: import('./social').SocialRoom
  /** Account that owns this local conversation. Missing only on legacy data awaiting migration. */
  ownerId?: string
  id: string
  type: 'group' | 'direct'
  name: string
  description?: string
  agentIds: string[]
  /** The visible member that opens and consolidates a group conversation. */
  leadAgentId?: string
  /** Agents the group owner set to reply only when @mentioned. The others
   *  join in on their own when a message is about them. */
  mentionOnlyAgentIds?: string[]
  topics: Topic[]
  activeTopicId: string
  /** User-selected folder for local CLI agents. Used only while every member is the owner's local agent. */
  workspacePath?: string
  allowedFolders?: string[]
  savedToContacts?: boolean
  muted?: boolean
  hidden?: boolean
  manuallyUnread?: boolean
  pinned?: boolean
  sortOrder?: number
  unread: number
  readAt: number
  createdAt: number
  updatedAt: number
}

export interface MessageSource {
  kind: 'group' | 'bot'
  id: string
  name: string
  /** The private message that led to this reply. Older stored messages may
   *  only have the sender metadata. */
  content?: string
}

export interface MessageDeliveryReply {
  id: string
  senderId: string
  senderName: string
  content: string
  createdAt: number
  /** Bubbles split from the same recipient turn share this id. */
  replyGroupId?: string
  attachments?: MessageAttachment[]
  error?: string
}

export interface MessageDelivery {
  kind?: 'group-invitation'
  status?: string
  id: string
  recipientId: string
  recipientName: string
  content: string
  replies?: MessageDeliveryReply[]
}

/** A binary asset owned by Douchat. The renderer receives the bytes lazily
 * through IPC instead of exposing arbitrary local file paths. */
export interface MessageAttachment {
  quoted?: boolean
  id: string
  kind: 'image'
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  size: number
}

export interface MessageFileInput {
  name: string
  data: Uint8Array
}

/** An image crossing the isolated renderer/main boundary before Douchat owns it. */
export interface MessageImageInput {
  quoted?: boolean
  name: string
  mimeType: MessageAttachment['mimeType']
  data: Uint8Array
}

/** A code file handed to a short-lived, isolated preview window. */
export interface CodeArtifactInput {
  title: string
  language: string
  code: string
}

export interface EmailConnectorAccount {
  id: string
  kind: 'email'
  name: string
  email: string
  username: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  agentIds: string[]
  status: 'connected' | 'error'
  error?: string
  updatedAt: number
}

export interface EmailConnectorInput {
  id?: string
  name: string
  email: string
  username: string
  password?: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  agentIds: string[]
}

export interface EmailConnectionTestResult {
  ok: boolean
  imap: { ok: boolean; error?: string }
  smtp: { ok: boolean; error?: string }
}

export interface ChatMessage {
  /** Incoming transport; absent for desktop and older messages without provenance. */
  sourceChannel?: import('./imChannels').IMProvider
  contextVersion?: string
  /** Localizable application notice; user and agent text never carry this. */
  localization?: import('./groupText').GroupNotice
  socialTasks?: { id: string; agentId: string; agentName: string; status: string }[]
  deliveryState?: 'sending' | 'confirming' | 'failed'
  id: string
  conversationId: string
  topicId: string
  authorId: 'user' | 'system' | string
  authorName: string
  text: string
  kind: 'message' | 'handoff' | 'system'
  createdAt: number
  /** @mention targets resolved when the message was written. */
  recipients?: { id: string; name: string }[]
  /** Bubbles split out of one model turn share this id. */
  replyGroupId?: string
  /** A private delivery that arrived here from a group or another bot. */
  source?: MessageSource
  /** Private or agent-to-agent envelopes this message sent out. */
  deliveries?: MessageDelivery[]
  /** Files produced by this model turn and copied into Douchat storage. */
  attachments?: MessageAttachment[]
  /** Human-readable receipts for tools that performed this reply's work. */
  actions?: MessageAction[]
  error?: string
  /** The raw failure a system message was summarised from, kept for details. */
  detail?: string
}

export interface MessageAction {
  /** The provider's tool-call id; unique within the model turn. */
  id: string
  /** Stable internal tool name. The renderer turns this into product copy. */
  tool: string
  status: 'running' | 'succeeded' | 'failed'
  /** A safe display target such as a filename, never the full argument payload. */
  target?: string
}

export interface PrivateMessage {
  contextVersion?: string
  intent?: 'inform' | 'request'
  id: string
  conversationId: string
  topicId: string
  sender: { id: string; name: string }
  recipient: { id: string; name: string }
  content: string
  createdAt: number
}

export interface RuntimeStatus {
  mode: 'live' | 'offline'
  label: string
  /** The OpenAI-compatible endpoint backing live models, when configured. */
  endpoint?: string
  error?: string
}

export interface EndpointSettings {
  baseUrl: string
  /** The key itself never leaves the main process. */
  hasApiKey: boolean
  source: 'account' | 'settings' | 'env' | 'none'
}

export interface EndpointInput {
  baseUrl: string
  /** Omit to keep the saved key. */
  apiKey?: string
}

export interface EndpointTestResult {
  ok: boolean
  models: number
  error?: string
}

export interface ModelOption {
  provider: string
  model: string
  label: string
}

export type ConversationPhase = 'planning' | 'replying' | 'greeting' | 'delivering'

export interface ConversationActivityState {
  planningStage?: 'health' | 'decision' | 'plan' | 'recovery'
  serviceName?: string
  localProgress?: {
    phase: 'connecting' | 'ready' | 'working' | 'waiting' | 'approval'
    elapsedSeconds: number
    silentSeconds: number
    detail?: string
  }
  conversationId: string
  topicId: string
  phase: ConversationPhase
  agentIds: string[]
  label: string
  startedAt: number
  /** The concrete tool action currently visible to the human. */
  action?: MessageAction
  /** A failed lead handed the conversation to this member. */
  takeover?: { unavailableName: string; replacementName: string }
  limited?: boolean
  failed?: boolean
}

export interface ComputerSession {
  id: string
  agentId: string
  status: ComputerStatus
  url: string
  title: string
  previewDataUrl?: string
  lastAction?: string
  error?: string
  updatedAt: number
}

export type RoutineSchedule =
  | {
      kind: 'once'
      runAt: number
    }
  | {
      kind: 'interval'
      intervalMinutes: number
    }
  | {
      kind: 'weekly'
      days: number[]
      time: string
    }

export interface Routine {
  /** Account that created and is allowed to execute this local automation. */
  ownerId?: string
  id: string
  name: string
  agentId: string
  conversationId: string
  prompt: string
  target: 'local'
  schedule: RoutineSchedule
  timezone: string
  enabled: boolean
  nextRunAt: number
  lastRunAt?: number
  createdAt: number
  updatedAt: number
}

export interface CreateRoutineInput {
  name: string
  agentId: string
  conversationId: string
  prompt: string
  schedule: RoutineSchedule
  timezone: string
}

export interface TaskRun {
  /** Account that owns the conversation/task which produced this run. */
  ownerId?: string
  id: string
  agentId: string
  conversationId: string
  routineId?: string
  title: string
  prompt: string
  target: 'local'
  trigger: RunTrigger
  status: RunStatus
  latestActivity?: string
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export interface RunEvent {
  id: string
  runId: string
  type: 'status' | 'tool'
  label: string
  detail?: string
  status?: RunStatus
  createdAt: number
}

export interface AppSnapshot {
  groupMemberHealth?: Record<string, Record<string, { status: 'healthy' | 'unknown' | 'unavailable'; checkedAt: number }>>
  groupGames?: import('./groupGame').GameView[]
  groupWorkflows?: import('./groupWorkflow').GroupWorkflowView[]
  permissionRequests?: PermissionRequest[]
  agents: AgentConfig[]
  agentStatuses: Record<string, AgentStatus>
  conversations: Conversation[]
  messages: ChatMessage[]
  privateMessages: PrivateMessage[]
  activity: ConversationActivityState[]
  computers: ComputerSession[]
  routines: Routine[]
  runs: TaskRun[]
  runEvents: RunEvent[]
  runtime: RuntimeStatus
  endpoint: EndpointSettings
  models: ModelOption[]
  connectors: EmailConnectorAccount[]
  /** The signed-in account's system-admin chat, when it currently exists. */
  defaultConversationId?: string
  userName: string
  /** The picture the user chose, already downscaled, as a data URL. */
  userAvatar: string
}

export interface CreateAgentInput {
  systemFiles?: import('./agentCustomization').AgentFiles
  thinkingLevel?: ThinkingLevel | 'default'
  customModel?: { providerId: string; model: string }
  cloudModel?: { model: string }
  localAgentId?: string
  localAgentName?: string
  startupArgs?: string[]

  name: string
  avatar?: string
  avatarEmoji?: string
  role: string
  instructions: string
  color: string
  labels?: string
}

/** Provider/model bindings are resolved by the main process. Built-in cloud contacts
 * remain service-owned; custom selections are validated against saved providers. */
export type ResolvedCreateAgentInput = Omit<CreateAgentInput, 'thinkingLevel'> & Pick<AgentConfig, 'provider' | 'model' | 'followDefaultModel' | 'thinkingLevel'>

export interface UpdateAgentInput {
  /** Reject a stale edit when a caller supplies its last observed version. */
  expectedRevision?: number
  /** Replaces the agent's own startup arguments; an empty list clears them. */
  startupArgs?: string[]
  expectedSystemFiles?: import('./agentCustomization').AgentFiles
  /** 'default' clears the override. */
  thinkingLevel?: ThinkingLevel | 'default'
  systemFiles?: import('./agentCustomization').AgentFiles
  skills?: import('./agentCustomization').AgentSkill[]
  followDefaultModel?: boolean
  customModel?: { providerId: string; model: string }
  cloudModel?: { model: string }
  permissions?: AgentPermissions
  localAgentId?: string
  localAgentName?: string

  name?: string
  avatar?: string
  avatarEmoji?: string
  role?: string
  instructions?: string
  color?: string
  provider?: string
  model?: string
  labels?: string
}

export interface CreateGroupInput {
  name: string
  description?: string
  agentIds: string[]
  leadAgentId?: string
}

export interface UpdateConversationInput {
  /** Reject a stale edit when a caller supplies its last observed version. */
  expectedRevision?: number
  avatar?: string
  avatarEmoji?: string
  savedToContacts?: boolean
  muted?: boolean
  hidden?: boolean
  manuallyUnread?: boolean
  name?: string
  description?: string
  agentIds?: string[]
  leadAgentId?: string
}

export interface DesktopAuthUser {
  id: string
  name: string
  email: string
  image?: string
}

export interface UpdateDesktopProfileInput {
  name?: string
  image?: string
}

export interface UsageSummary {
  planName: string
  status: string
  credits: number
}

export type DesktopAuthState =
  | { status: 'checking' }
  | { status: 'signed-out' }
  | { status: 'waiting' }
  | { status: 'error'; error: string }
  | { status: 'signed-in'; user: DesktopAuthUser }

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion?: string
  releaseNotes?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  busyTasks?: number
  error?: string
}

export interface DouchatApi extends AccountDataApi, DesktopDeviceApi {
  listIMChannels(agentId: string): Promise<import('./imChannels').IMChannel[]>
  connectIMChannel(agentId: string, input: import('./imChannels').IMConnectInput): Promise<void>
  disconnectIMChannel(agentId: string, provider: import('./imChannels').IMProvider): Promise<void>
  startIMLogin(agentId: string): Promise<import('./imChannels').IMLogin>
  cancelIMLogin(agentId: string, sessionId: string): Promise<void>
  pollIMLogin(agentId: string, sessionId: string): Promise<import('./imChannels').IMLoginStatus>

  getSocialSnapshot: () => Promise<SocialSnapshot>
  socialAction: (input: SocialAction) => Promise<SocialResult>
  setInterfaceLanguage: (language: string) => Promise<void>
  getAuthState: () => Promise<DesktopAuthState>
  startLogin: () => Promise<DesktopAuthState>
  cancelLogin: () => Promise<DesktopAuthState>
  retryAuth: () => Promise<DesktopAuthState>
  signOut: () => Promise<DesktopAuthState>
  refreshProfile: () => Promise<DesktopAuthState>
  updateProfile: (input: UpdateDesktopProfileInput) => Promise<DesktopAuthState>
  getUsageSummary: () => Promise<UsageSummary>
  consumeCreditsReturn: () => Promise<boolean>
  openSubscriptionPlans: () => Promise<void>
  openBillingPortal: () => Promise<void>
  getUpdateState: () => Promise<UpdateState>
  checkForUpdates: () => Promise<UpdateState>
  installUpdate: () => Promise<UpdateState>
  listLocalAgentModels: (agentId: string) => Promise<import('./localModels').LocalModelList>
  detectLocalAgents: () => Promise<LocalAgent[]>
  maintainLocalAgent: (id: string) => Promise<boolean>
  openLocalAgentTerminal: (id: 'claude') => Promise<{ terminal: 'termany' | 'system' }>
  addCustomLocalAgent: (input: CustomLocalAgentInput) => Promise<LocalAgent[]>
  updateLocalAgent: (id: string, input: CustomLocalAgentInput) => Promise<LocalAgent[]>
  testLocalAgent: (id: string | undefined, input: CustomLocalAgentInput) => Promise<{ reply: string; durationMs: number; version?: string }>
  cancelLocalAgentTest: () => Promise<void>
  listSshHosts: () => Promise<string[]>
  removeCustomLocalAgent: (id: string) => Promise<LocalAgent[]>
  getAttachmentData: (attachmentId: string) => Promise<string>
  getSnapshot: () => Promise<AppSnapshot>
  authorizeTokenDance: () => Promise<string>
  cancelTokenDanceAuthorization: () => Promise<void>
  getCustomModels: () => Promise<CustomModelConfig>
  getDecisionSettings: () => Promise<import('./groupDecision').DecisionSettings>
  getCloudDecisionModels: () => Promise<import('./groupDecision').CloudDecisionModel[]>
  saveDecisionSettings: (settings: import('./groupDecision').DecisionSettings) => Promise<import('./groupDecision').DecisionSettings>
  testDecisionSettings: (settings: import('./groupDecision').DecisionSettings) => Promise<{ ok: boolean; error?: string }>
  saveCustomModels: (providers: CustomProviderInput[], defaultModel: string) => Promise<CustomModelConfig>
  testCustomModel: (input: CustomModelTest) => Promise<{ ok: boolean; error?: string; model?: string }>
  createAgent: (input: CreateAgentInput) => Promise<AppSnapshot>
  resolveAgentPermission: (id: string, allow: import('./agentPermissions').PermissionApproval) => Promise<AppSnapshot>
  exportAgentArchive: (agentId: string) => Promise<boolean>
  parseAgentArchive: (data: Uint8Array, root?: string) => Promise<import('./agentArchive').AgentArchivePreview>
  parseSkillArchive: (data: Uint8Array) => Promise<import('./agentCustomization').AgentSkill[]>
  /** The full skill, including the resource files snapshots leave out. */
  getAgentSkill: (agentId: string, skillId: string) => Promise<import('./agentCustomization').AgentSkill>
  updateAgent: (agentId: string, input: UpdateAgentInput) => Promise<AppSnapshot>
  deleteAgent: (agentId: string) => Promise<AppSnapshot>
  startDirectChat: (agentId: string) => Promise<{ snapshot: AppSnapshot; conversationId: string }>
  createGroup: (input: CreateGroupInput) => Promise<AppSnapshot>
  updateConversation: (conversationId: string, input: UpdateConversationInput) => Promise<AppSnapshot>
  /** Opens a folder picker; resolves unchanged if cancelled. */
  openConversationWorkspace: (conversationId: string) => Promise<void>
  chooseConversationWorkspace: (conversationId: string) => Promise<AppSnapshot>
  clearConversationWorkspace: (conversationId: string) => Promise<AppSnapshot>
  openCodeArtifact: (input: CodeArtifactInput) => Promise<void>
  getCodeArtifact: (artifactId: string) => Promise<CodeArtifactInput | null>
  connanyCommand: (command: import('./connany').ConnectorCommand) => Promise<unknown>
  connanySelect: (selection: import('./connany').ConnectorSelection) => Promise<void>
  testEmailConnector: (input: EmailConnectorInput) => Promise<EmailConnectionTestResult>
  saveEmailConnector: (input: EmailConnectorInput) => Promise<AppSnapshot>
  disconnectEmailConnector: (connectorId: string) => Promise<AppSnapshot>
  deleteMessage: (conversationId: string, messageId: string) => Promise<boolean>
  deleteConversation: (conversationId: string) => Promise<AppSnapshot>
  setConversationPinned: (conversationId: string, pinned: boolean) => Promise<AppSnapshot>
  markConversationRead: (conversationId: string) => Promise<AppSnapshot>
  markAllConversationsRead: () => Promise<AppSnapshot>
  createTopic: (conversationId: string) => Promise<AppSnapshot>
  renameTopic: (conversationId: string, topicId: string, title: string) => Promise<AppSnapshot>
  deleteTopic: (conversationId: string, topicId: string) => Promise<AppSnapshot>
  setActiveTopic: (conversationId: string, topicId: string) => Promise<AppSnapshot>
  sendMessage: (conversationId: string, text: string, images?: MessageImageInput[], files?: MessageFileInput[], mentions?: SelectedMention[]) => Promise<void>
  stopConversation: (conversationId: string) => Promise<void>
  clearConversation: (conversationId: string) => Promise<AppSnapshot>
  resetConversationContext: (conversationId: string) => Promise<AppSnapshot>
  setEndpoint: (input: EndpointInput) => Promise<AppSnapshot>
  testEndpoint: (input: EndpointInput) => Promise<EndpointTestResult>
  createRoutine: (input: CreateRoutineInput) => Promise<AppSnapshot>
  deleteRoutine: (routineId: string) => Promise<AppSnapshot>
  setRoutineEnabled: (routineId: string, enabled: boolean) => Promise<AppSnapshot>
  runRoutineNow: (routineId: string) => Promise<void>
  startComputer: (agentId: string) => Promise<AppSnapshot>
  stopComputer: (agentId: string) => Promise<AppSnapshot>
  showComputer: (agentId: string) => Promise<void>
  onAuthState: (listener: (state: DesktopAuthState) => void) => () => void
  onCreditsUpdated: (listener: () => void) => () => void
  onUpdateState: (listener: (state: UpdateState) => void) => () => void
  onConnanyChanged: (listener: () => void) => () => void
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => () => void
}
