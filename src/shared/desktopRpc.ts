/**
 * Desktop operations the web app runs on a signed-in desktop, by the same IPC
 * channel the desktop's own window uses (see src/preload/index.ts, whose
 * arguments pass through unchanged). Left out: what acts on that computer's
 * screen, files or terminal (including confirmations shown in its window), and
 * what the web app answers itself. Sending a message uses web send requests
 * (cloudSync.ts) instead, because a reply can outlast any call.
 * webRpc.test.ts keeps this table in step with the preload.
 */
export const DESKTOP_RPC = {
  getGroupMemory: 'douchat:group-memory',
  getUserMemory: 'douchat:user-memory',
  listIMChannels: 'douchat:im-list',
  parseSkillArchive: 'douchat:parse-skill-archive',
  getAttachmentData: 'douchat:attachment-data',
  socialAction: 'douchat:social-action',
  // Opens a file from a chat on that computer, within the chat's allowed folders.
  openLocalFile: 'douchat:open-local-file',
  saveGroupMemory: 'douchat:save-group-memory',
  saveUserMemory: 'douchat:save-user-memory',
  connectIMChannel: 'douchat:im-connect',
  disconnectIMChannel: 'douchat:im-disconnect',
  startIMLogin: 'douchat:im-login',
  cancelIMLogin: 'douchat:im-cancel-login',
  pollIMLogin: 'douchat:im-status',
  listLocalAgentModels: 'douchat:list-local-agent-models',
  listRuntimeModels: 'douchat:list-runtime-models',
  detectLocalAgents: 'douchat:detect-local-agents',
  addCustomLocalAgent: 'douchat:add-custom-local-agent',
  updateLocalAgent: 'douchat:update-local-agent',
  listSshHosts: 'douchat:list-ssh-hosts',
  listConnections: 'douchat:list-connections',
  saveConnection: 'douchat:save-connection',
  removeConnection: 'douchat:remove-connection',
  setConnectionEnabled: 'douchat:set-connection-enabled',
  setConnectionHostExecution: 'douchat:set-connection-host-execution',
  listTrustedDevices: 'douchat:list-trusted-devices',
  setDeviceTrusted: 'douchat:set-device-trusted',
  testConnection: 'douchat:test-connection',
  discoverRemoteAgents: 'douchat:discover-remote-agents',
  addDiscoveredAgents: 'douchat:add-discovered-agents',
  createDaemonEnrollment: 'douchat:create-daemon-enrollment',
  waitDaemonEnrollment: 'douchat:wait-daemon-enrollment',
  cancelDaemonEnrollment: 'douchat:cancel-daemon-enrollment',
  completeDaemonEnrollment: 'douchat:complete-daemon-enrollment',
  removeCustomLocalAgent: 'douchat:remove-custom-local-agent',
  searchMessages: 'douchat:search-messages',
  getMessagePage: 'douchat:message-page',
  getCustomModels: 'douchat:custom-models',
  getDecisionSettings: 'douchat:decision-settings',
  getCloudDecisionModels: 'douchat:cloud-decision-models',
  saveDecisionSettings: 'douchat:save-decision-settings',
  testDecisionSettings: 'douchat:test-decision-settings',
  saveCustomModels: 'douchat:save-custom-models',
  testCustomModel: 'douchat:test-custom-model',
  createAgent: 'douchat:create-agent',
  resolveAgentPermission: 'douchat:resolve-agent-permission',
  parseAgentArchive: 'douchat:parse-agent-archive',
  getAgentSkill: 'douchat:get-agent-skill',
  updateAgent: 'douchat:update-agent',
  deleteAgent: 'douchat:delete-agent',
  startDirectChat: 'douchat:start-direct-chat',
  createGroup: 'douchat:create-group',
  updateConversation: 'douchat:update-conversation',
  conversationWorkspaces: 'douchat:conversation-workspaces',
  listRemoteAgentDirectories: 'douchat:list-remote-agent-directories',
  chooseRemoteAgentWorkspace: 'douchat:choose-remote-agent-workspace',
  clearAgentWorkspace: 'douchat:clear-agent-workspace',
  clearConversationWorkspace: 'douchat:clear-conversation-workspace',
  getCodeArtifact: 'douchat:get-code-artifact',
  connanyCommand: 'douchat:connany',
  connanySelect: 'douchat:connany-select',
  testEmailConnector: 'douchat:test-email-connector',
  saveEmailConnector: 'douchat:save-email-connector',
  disconnectEmailConnector: 'douchat:disconnect-email-connector',
  setConversationPinned: 'douchat:set-conversation-pinned',
  markConversationRead: 'douchat:mark-read',
  markAllConversationsRead: 'douchat:mark-all-read',
  createTopic: 'douchat:create-topic',
  renameTopic: 'douchat:rename-topic',
  deleteTopic: 'douchat:delete-topic',
  setActiveTopic: 'douchat:set-active-topic',
  stopConversation: 'douchat:stop-conversation',
  clearConversation: 'douchat:clear-conversation',
  resetConversationContext: 'douchat:reset-conversation-context',
  setEndpoint: 'douchat:set-endpoint',
  testEndpoint: 'douchat:test-endpoint',
  createRoutine: 'douchat:create-routine',
  deleteRoutine: 'douchat:delete-routine',
  setRoutineEnabled: 'douchat:set-routine-enabled',
  runRoutineNow: 'douchat:run-routine-now',
} as const

export type DesktopRpcMethod = keyof typeof DESKTOP_RPC
export const DESKTOP_RPC_CHANNELS: ReadonlySet<string> = new Set(Object.values(DESKTOP_RPC))

/** One call from the web app, carried as a synced record. */
export interface DesktopRpcCall {
  id: string
  method: DesktopRpcMethod
  args: unknown[]
  createdAt: number
  state: 'pending' | 'claimed' | 'done' | 'failed'
  deviceId?: string
  result?: unknown
  error?: string
}
/** A desktop that has not said it is online within this long is treated as away. */
export const DESKTOP_PRESENCE_MS = 30_000
export const DESKTOP_PRESENCE_STALE_MS = 75_000
/** Calls nobody claimed this quickly fail, so the page never hangs on an offline desktop. */
export const DESKTOP_RPC_TIMEOUT_MS = 30_000

/** A desktop that is signed in and able to run calls, refreshed while it runs. */
export interface DesktopPresence {
  id: string
  name: string
  platform: string
  updatedAt: number
}

/** Calls carry JSON; bytes (archives, images) travel as base64. */
export function encodeRpcValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    let binary = ''
    for (let index = 0; index < value.length; index += 0x8000) binary += String.fromCharCode(...value.subarray(index, index + 0x8000))
    return { $bytes: btoa(binary) }
  }
  if (Array.isArray(value)) return value.map(encodeRpcValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeRpcValue(item)]))
  return value
}

export function decodeRpcValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeRpcValue)
  if (value && typeof value === 'object') {
    const bytes = (value as { $bytes?: unknown }).$bytes
    if (typeof bytes === 'string' && Object.keys(value).length === 1) return Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeRpcValue(item)]))
  }
  return value
}

/**
 * Many calls answer with a whole app snapshot. The caller already has the
 * account through sync, so a snapshot (alone or in `{ snapshot, … }`) is
 * dropped from the answer rather than sent as megabytes of messages.
 */
export function withoutSnapshots(value: unknown): unknown {
  const isSnapshot = (item: unknown) => Boolean(item && typeof item === 'object' && 'agents' in item && 'conversations' in item && 'messages' in item)
  if (isSnapshot(value)) return null
  if (value && typeof value === 'object' && !Array.isArray(value) && isSnapshot((value as { snapshot?: unknown }).snapshot)) {
    const { snapshot: _snapshot, ...rest } = value as Record<string, unknown>
    return rest
  }
  return value
}
