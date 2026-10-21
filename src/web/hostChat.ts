import type { SyncRecord } from '../shared/cloudSync'
import { directSessionKey, hostAgentNote, hostSessionKey, type HostTaskState } from '../shared/hostTask'
import type { AgentConfig, ChatMessage, Conversation, ConversationActivityState, DesktopAuthUser } from '../shared/types'
import { chatHistory, type ChatTurn } from './cloudChat'
import type { WebSync } from './webSync'

/**
 * Agents a douchat-host runs itself, used from the browser while no desktop is
 * online. The tab builds the prompt and queues it as an owner task; the host
 * runs it with its owner-signed configuration and the service passes progress
 * and the result back. A direct chat's reply is also written into the chat by
 * the service, so it arrives even if this tab closes first.
 */

export type SocialCall = <T>(body: Record<string, unknown>) => Promise<T>

interface ExecutorList {
  bindings: { localId: string; executor: string; state: string; ready: boolean }[]
  hosts: { id: string; name?: string | null; online: boolean; capabilities: string[]; trustMode?: string }[]
}

const LIST_TTL_MS = 15_000
const OWNER_TASK_CAPABILITY = 'owner-tasks'

/** Which agents a host runs itself, as the service last reported. */
export class HostAgents {
  private list?: ExecutorList
  private at = 0
  private loading?: Promise<void>
  constructor(private readonly call: SocialCall, private readonly changed: () => void) {}

  /** The host running this agent, when it takes owner tasks. */
  host(agentId: string | undefined): { hostId: string; name: string; online: boolean } | undefined {
    const binding = this.list?.bindings.find(item => item.localId === agentId && item.state === 'enabled' && item.executor.startsWith('host:'))
    if (!binding) return undefined
    const hostId = binding.executor.slice('host:'.length)
    const host = this.list!.hosts.find(item => item.id === hostId)
    if (!host?.capabilities.includes(OWNER_TASK_CAPABILITY)) return undefined
    return { hostId, name: host.name || 'Server', online: host.online }
  }

  /** A host added from the web app: it takes unsigned approvals and cancels from the service. */
  serviceTrusted(hostId: string | undefined): boolean {
    return Boolean(hostId && this.list?.hosts.find(item => item.id === hostId)?.trustMode === 'service')
  }

  refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.at < LIST_TTL_MS) return Promise.resolve()
    this.loading ??= this.call<ExecutorList>({ action: 'executor-list' }).then(list => {
      const before = JSON.stringify(this.list ?? null)
      this.list = { bindings: list.bindings ?? [], hosts: list.hosts ?? [] }
      this.at = Date.now()
      if (JSON.stringify(this.list) !== before) this.changed()
    }).catch(() => undefined).finally(() => { this.loading = undefined })
    return this.loading
  }

  clear(): void { this.list = undefined; this.at = 0 }
}

/** What a waiting host task looks like in the chat: the same fields a desktop's daemon progress uses. */
export function hostActivity(base: ConversationActivityState, state: HostTaskState, startedAt: number): ConversationActivityState {
  const now = Date.now()
  const at = Number(state.progress?.at) || 0
  return {
    ...base,
    localProgress: {
      phase: state.approvals.length ? 'approval' : state.status === 'pending' ? 'connecting' : state.progress?.phase === 'ready' ? 'ready' : 'working',
      elapsedSeconds: Math.floor((now - startedAt) / 1000),
      silentSeconds: at ? Math.max(0, Math.floor((now - at) / 1000)) : 0,
      detail: state.cancelRequested ? 'Stopping…' : state.approvals.length ? 'Waiting for your approval' : state.status === 'pending' ? 'Waiting for the server' : state.progress?.detail || undefined
    },
    ...(state.progress?.text ? { remoteText: String(state.progress.text).slice(0, 32_000) } : {})
  }
}

/** Queues a prompt for an agent's host and waits until it finished. Retrying with the same clientTaskId follows the same task. */
export async function runHostTask(call: SocialCall, input: { localId: string; clientTaskId: string; prompt: string; target: Record<string, unknown>; continuation?: string; sessionKey?: string; workspace?: string },
  onState: (state: HostTaskState) => void): Promise<HostTaskState> {
  const { taskId } = await call<{ taskId: string }>({ action: 'host-task-create', origin: 'web', ...input })
  let cursor: string | undefined
  for (;;) {
    const state = await call<HostTaskState>({ action: 'host-task-wait', taskId, ...(cursor ? { cursor } : {}) })
    cursor = state.cursor
    onState(state)
    if (state.status === 'succeeded' || state.status === 'failed') return state
  }
}

/** A group member's turn on its host: the reply text, or an error when it failed. */
export async function runHostTurn(call: SocialCall, agent: AgentConfig, prompt: string, onState: (state: HostTaskState) => void = () => undefined, workspace?: string): Promise<string> {
  const state = await runHostTask(call, { localId: agent.id, clientTaskId: `web:${crypto.randomUUID()}`, prompt, target: { kind: 'none' }, ...(workspace ? { workspace } : {}) }, onState)
  if (state.status !== 'succeeded') throw new Error(state.reply || `${agent.name} could not answer on its server.`)
  return state.reply ?? ''
}

/** The direct-chat prompt: the topic so far, newest message last. The host adds the agent's signed identity. */
function directPrompt(agent: AgentConfig, user: DesktopAuthUser, host: string, turns: ChatTurn[]): string {
  const transcript = turns.map(turn => `${turn.role === 'user' ? user.name : agent.name}: ${turn.content ?? ''}`).join('\n').slice(-24_000)
  return [hostAgentNote(host), `Conversation so far:\n${transcript}`, `Reply to ${user.name}'s latest message as ${agent.name}.`].join('\n\n')
}

/**
 * Store the human message, have the agent's host answer it, then make sure
 * the answer is in the chat. The service writes the same reply record when the
 * task finishes; whichever write lands first stands.
 */
export async function sendToHostAgent(params: {
  sync: WebSync
  call: SocialCall
  user: DesktopAuthUser
  agent: AgentConfig
  /** The server the agent runs on, as the owner named it. */
  host: string
  conversation: Conversation
  text: string
  /** The human message's id, when it continues a queued request. */
  messageId?: string
  onState: (state: HostTaskState) => void
}): Promise<void> {
  const { sync, call, user, agent, host, conversation, text, messageId, onState } = params
  const topic = conversation.topics.find((item) => item.id === conversation.activeTopicId) ?? conversation.topics[0]
  const topicId = topic?.id ?? conversation.activeTopicId
  const now = Date.now()
  const version = topic?.contextReset ? { contextVersion: topic.contextReset.id } : {}
  const message: ChatMessage = { id: messageId ?? crypto.randomUUID(), conversationId: conversation.id, topicId, authorId: 'user', authorName: user.name, text, kind: 'message', createdAt: now, ...version }
  const touch = (at: number, title?: string) => ({
    kind: 'conversation' as const,
    id: conversation.id,
    apply: (current: SyncRecord | undefined) => {
      if (!current) throw new Error('Chat not found')
      const next = structuredClone(current) as unknown as Conversation
      next.updatedAt = at
      next.topics = next.topics.map((item) => item.id === topicId ? { ...item, updatedAt: at, title: item.title || title || '' } : item)
      return next as unknown as SyncRecord
    }
  })
  // A retried request already stored its message.
  await sync.mutate([{ kind: 'message', id: message.id, apply: (current) => current ?? message as unknown as SyncRecord }, touch(now, text.slice(0, 40))])

  // One reply per human message, so a retry after a closed tab follows the same task.
  const replyId = `${message.id}:host-reply`
  let state: HostTaskState
  try {
    const workspace = conversation.hostWorkspaces?.[agent.id]?.path
    state = await runHostTask(call, {
      localId: agent.id, clientTaskId: message.id,
      prompt: directPrompt(agent, user, host, chatHistory(sync, conversation.id, topicId, agent.id, topic?.contextReset)),
      // The host keeps this chat's native session; a reset starts a new one.
      sessionKey: hostSessionKey(directSessionKey(conversation.id, topicId), topic?.contextReset?.id),
      continuation: [hostAgentNote(host), `${user.name}: ${text}`, `Reply to ${user.name}'s latest message as ${agent.name}.`].join('\n\n'),
      ...(workspace ? { workspace } : {}),
      target: { kind: 'direct', conversationId: conversation.id, topicId, replyMessageId: replyId, ...(messageId ? { requestId: messageId } : {}), authorName: agent.name, ...version }
    }, onState)
  } catch (error) {
    state = { cursor: '', taskId: '', status: 'failed', reply: error instanceof Error ? error.message : 'The server could not be reached. Try again.', progress: null, approvals: [] }
  }
  const at = Date.now()
  // The same record the service writes, so whichever lands first is complete.
  const images = (state.attachments ?? []).filter(item => item.kind === 'image' && item.mimeType)
  const files = (state.attachments ?? []).filter(item => item.kind === 'file')
  const answer: ChatMessage = state.status === 'succeeded'
    ? { id: replyId, conversationId: conversation.id, topicId, authorId: agent.id, authorName: agent.name, kind: 'message', createdAt: at, ...version,
      text: (state.reply ?? '') + (files.length ? `\n\n${files.map(file => `📎 ${file.name}`).join('\n')}` : ''),
      ...(images.length ? { attachments: images.map(item => ({ id: item.id, kind: 'image' as const, name: item.name, mimeType: item.mimeType as NonNullable<ChatMessage['attachments']>[number]['mimeType'], size: item.size })) } : {}) }
    : { id: replyId, conversationId: conversation.id, topicId, authorId: 'system', authorName: 'Douchat', kind: 'system', text: state.reply || 'The server could not complete this request.', createdAt: at, ...version }
  await sync.mutate([{ kind: 'message', id: replyId, apply: (current) => current ?? answer as unknown as SyncRecord }, touch(at)])
}
