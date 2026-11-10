import type { AgentConfig, LocalAgent, MessageAttachment } from './types'

export interface LocalProgress {
  phase: 'connecting' | 'ready' | 'working' | 'waiting' | 'approval'
  elapsedSeconds: number
  silentSeconds: number
  detail?: string
}
export type ProgressListener = (progress: LocalProgress) => void
/** Host-generated lifetime, never accepted from model arguments or renderer IPC. */
export interface NativeAppSession {
  id: string
  appId: string
  appName: string
  signal: AbortSignal
}
export interface LocalToolApproval { message: string; details: string; nativeSession?: NativeAppSession }
export type LocalApprovalHandler = (request: LocalToolApproval, signal: AbortSignal) => Promise<void>

export interface LocalAgentImage {
  name: string
  mimeType: MessageAttachment['mimeType']
  data: Uint8Array
}

export interface LocalAgentFile {
  name: string
  data: Uint8Array
}

export interface LocalAgentReply {
  text: string
  images: LocalAgentImage[]
  /** Deliverables fetched from a remote agent's private outbox. */
  files?: LocalAgentFile[]
}

export interface LocalRunOptions {
  /** Validated, unsaved settings used only by the connection test. */
  agentOverride?: LocalAgent
  /** Read-only controllers must not gain image generation through MCP. */
  imageToolsAllowed?: boolean
  /** Validated user-selected folder on this computer. */
  workspaceDirectory?: string
  /** Validated folder on a remote agent's server, bound to that server. */
  remoteWorkspace?: import('./types').AgentWorkspaceBinding
  /** A host-run agent's native session: conversation, topic and context version. */
  hostSession?: string
  sessionKey?: string
  /** Internal planning/probes must not retain workspace or thread history. */
  transient?: boolean
  /** Full transcript is needed only when a connection is cold. */
  continuationPrompt?: string
  onProgress?: ProgressListener
  onApproval?: LocalApprovalHandler
  /** Internal retry for the specific Claude account-login configuration conflict. */
  claudeAccountLogin?: boolean
  /** Retry only a rejected resume, before any model turn can have executed. */
  freshSessionRetry?: boolean
}
/** One agent turn, the same shape wherever it runs: this computer or a douchat-host. */
export interface AgentTurn extends LocalRunOptions {
  prompt: string
  signal?: AbortSignal
  /** Images the human sent; the executor shows them to the agent. */
  images?: LocalAgentImage[]
}

/** Device execution boundary. Implementations own their sessions and lifecycle.
 * Transport, authentication and routing remain responsibilities of the host. */
export interface AgentExecutor {
  run(config: AgentConfig, turn: AgentTurn): Promise<LocalAgentReply>
  releaseIdleConnections?(conversationId: string, directAgentIds?: string[], roomId?: string): void
  /** Start a conversation's long-lived process ahead of its next turn. */
  prepare?(config: AgentConfig, options: LocalRunOptions): Promise<void>
  disposeAgent(agentId: string): void
  /** Close one session's process, for a one-off turn that is done. */
  releaseSession?(sessionKey: string): void
  resetConversation(conversationId: string, topicId?: string, directAgentIds?: string[], ownerId?: string): void
}
