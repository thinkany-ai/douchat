import { botGreetingPrompt } from '../shared/bot/greeting'
import { localizedBuiltInAgent } from '../shared/builtInAgentLocalization'
import { greetingMessageId, systemAdminWelcome } from '../shared/welcome'
import type { SyncRecord } from '../shared/cloudSync'
import { supportedInterfaceLanguage } from '../shared/language'
import type { AgentConfig, BuiltInAgentManifest, ChatMessage, Conversation, DesktopAuthUser, Topic } from '../shared/types'
import { sha256 } from './insecureContext'
import type { WebSync } from './webSync'
import { addressesEveryone, mentionedMembers } from '../shared/bot/mentions'
import { agentManagementPrompt, agentManagementTools, isSystemAdmin, runAgentManagementTool } from './cloudTools'

/**
 * Cloud agents in the browser. Dr. Dou and other Douchat Cloud agents answer
 * through /v1/chat/completions with the signed-in token, exactly the endpoint
 * (and credit billing) the desktop uses, so the web app can talk to them with
 * no desktop online. Agents that run on a computer still go through a desktop.
 */

const GATEWAY_PROVIDER_ID = 'gateway'
const HISTORY_LIMIT = 40
/** Tool rounds per reply, so a confused model cannot loop forever. */
const TOOL_ROUNDS = 6
type Service = <T>(path: string, init?: RequestInit) => Promise<T>

export function isCloudAgent(agent: AgentConfig | undefined): agent is AgentConfig {
  return Boolean(agent && agent.provider === GATEWAY_PROVIDER_ID && !agent.localAgentId)
}

async function sha256Hex(value: string): Promise<string> {
  return [...await sha256(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Give an account its built-in Dr. Dou, the way a desktop does at sign-in.
 * The ids match what a desktop derives, so the two copies merge in sync.
 */
export async function ensureBuiltInContact(sync: WebSync, user: DesktopAuthUser, service: Service): Promise<void> {
  const existing = sync.all<AgentConfig>('agent').find((agent) => agent.systemRole === 'admin')
  if (existing) return welcomeToBuiltIn(sync, existing)
  const manifest = await service<BuiltInAgentManifest>('/api/desktop-auth/built-in-agents')
  const template = manifest.agents.find((agent) => agent.systemKey === 'dr-dou') ?? manifest.agents.find((agent) => agent.systemRole === 'admin')
  if (!template) return
  const definition = localizedBuiltInAgent(template, supportedInterfaceLanguage(navigator.language))
  const id = definition.id === 'system-admin-fallback' ? `system-admin-${(await sha256Hex(user.id)).slice(0, 32)}` : definition.id
  const now = Date.now()
  const agent: AgentConfig = {
    ownerId: user.id, id, name: definition.name, systemRole: definition.systemRole, systemKey: definition.systemKey,
    cloudAgentId: definition.id === 'system-admin-fallback' ? undefined : definition.id, templateVersion: definition.templateVersion,
    modelRoute: definition.modelRoute, capabilities: [...definition.capabilities], userOverrides: {}, avatar: '',
    role: definition.role, instructions: definition.instructions, labels: definition.labels ?? '', color: definition.color,
    createdAt: now, provider: GATEWAY_PROVIDER_ID, model: definition.modelRoute === 'default' ? 'douchat-default' : definition.modelRoute
  }
  const topic: Topic = { id: crypto.randomUUID(), title: '', createdAt: now, updatedAt: now }
  const conversation: Conversation = {
    ownerId: user.id, id: `direct-${id}`, type: 'direct', name: agent.name, agentIds: [id], topics: [topic],
    activeTopicId: topic.id, unread: 0, readAt: now, createdAt: now, updatedAt: now
  }
  // Another device may have created it meanwhile: keep theirs.
  await sync.mutate([
    { kind: 'agent', id, apply: (current) => current ?? agent as unknown as SyncRecord },
    { kind: 'conversation', id: conversation.id, apply: (current) => current ?? conversation as unknown as SyncRecord }
  ])
  await welcomeToBuiltIn(sync, sync.get<AgentConfig>('agent', id) ?? agent)
}

/**
 * One built-in Dr. Dou per account. A desktop from before account-derived ids
 * gave it a random id, so an account that first met the web app can end up
 * with two once that desktop syncs. Keep the oldest (the one that desktop
 * already points to), move the other's messages into its chat, repoint groups
 * and routines, and remove the duplicate. Every change syncs to the desktop.
 */
export async function mergeDuplicateBuiltIns(sync: WebSync): Promise<boolean> {
  const admins = sync.all<AgentConfig>('agent').filter((agent) => agent.systemRole === 'admin')
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  if (admins.length < 2) return false
  const [keep, ...duplicates] = admins
  const conversations = sync.all<Conversation>('conversation')
  const directOf = (agentId: string) => conversations.filter((item) => item.type === 'direct' && item.agentIds[0] === agentId && !item.id.startsWith('im-'))
  const target = directOf(keep.id)[0]
  if (!target) return false
  const gone = new Set(duplicates.map((agent) => agent.id))
  const swap = (id: string) => gone.has(id) ? keep.id : id
  const record = (value: unknown) => value as SyncRecord
  const mutations: import('./webSync').Mutation[] = []
  const removedChats = new Set(duplicates.flatMap((agent) => directOf(agent.id).map((item) => item.id)))
  // Messages first: a desktop applies the chat's removal before them, then re-adds them in the kept chat.
  for (const message of sync.all<ChatMessage>('message')) {
    if (!removedChats.has(message.conversationId)) continue
    if (message.id.startsWith('greeting:')) { mutations.push({ kind: 'message', id: message.id, apply: () => null }); continue }
    mutations.push({ kind: 'message', id: message.id, apply: (current) => current ? record({
      ...current, conversationId: target.id, topicId: target.activeTopicId, authorId: swap(String(current.authorId))
    }) : null })
  }
  for (const conversation of conversations) {
    if (removedChats.has(conversation.id) || !conversation.agentIds.some((id) => gone.has(id))) continue
    mutations.push({ kind: 'conversation', id: conversation.id, apply: (current) => {
      if (!current) return null
      const next = structuredClone(current) as unknown as Conversation
      next.agentIds = [...new Set(next.agentIds.map(swap))]
      if (next.leadAgentId) next.leadAgentId = swap(next.leadAgentId)
      return record(next)
    } })
  }
  for (const routine of sync.all<import('../shared/types').Routine>('routine')) {
    if (!gone.has(routine.agentId) && !removedChats.has(routine.conversationId)) continue
    mutations.push({ kind: 'routine', id: routine.id, apply: (current) => current ? record({
      ...current, agentId: swap(routine.agentId), conversationId: removedChats.has(routine.conversationId) ? target.id : routine.conversationId
    }) : null })
  }
  for (const id of removedChats) mutations.push({ kind: 'conversation', id, apply: () => null })
  for (const agent of duplicates) mutations.push({ kind: 'agent', id: agent.id, apply: () => null })
  await sync.mutate(mutations)
  return true
}

export const interfaceLanguage = () => supportedInterfaceLanguage(document.documentElement.lang || navigator.language)
const hasMessages = (sync: WebSync, conversationId: string) => sync.all<ChatMessage>('message').some((message) => message.conversationId === conversationId)

/** Dr. Dou's fixed onboarding message in an empty chat, as a desktop writes it. */
async function welcomeToBuiltIn(sync: WebSync, agent: AgentConfig): Promise<void> {
  const conversation = sync.all<Conversation>('conversation').find((item) => item.type === 'direct' && item.agentIds[0] === agent.id && !item.id.startsWith('im-'))
  if (!conversation || hasMessages(sync, conversation.id) || Object.values(agent.systemFiles ?? {}).some((value) => value?.trim())) return
  const message: ChatMessage = {
    id: greetingMessageId(conversation.id, conversation.activeTopicId), conversationId: conversation.id, topicId: conversation.activeTopicId,
    authorId: agent.id, authorName: agent.name, text: systemAdminWelcome(agent.name, interfaceLanguage()), kind: 'message', createdAt: Date.now()
  }
  // Keep a greeting another client already wrote under the same id.
  await sync.mutate([{ kind: 'message', id: message.id, apply: (current) => current ?? message as unknown as SyncRecord }])
}

/**
 * A new chat opens with one line from its agent (a group's lead), written by
 * the model like a desktop's greeting, or a plain hello if that fails.
 */
export async function greetNewChat(sync: WebSync, token: string, conversationId: string): Promise<void> {
  const conversation = sync.get<Conversation>('conversation', conversationId)
  if (!conversation || hasMessages(sync, conversationId)) return
  const speakerId = conversation.type === 'group' ? conversation.leadAgentId ?? conversation.agentIds[0] : conversation.agentIds[0]
  const speaker = speakerId ? sync.get<AgentConfig>('agent', speakerId) : undefined
  if (!speaker) return
  if (speaker.systemRole === 'admin' && conversation.type === 'direct') return welcomeToBuiltIn(sync, speaker)
  const language = interfaceLanguage()
  let text = ''
  if (isCloudAgent(speaker)) {
    try {
      const members = conversation.agentIds.map((id) => sync.get<AgentConfig>('agent', id)).filter((agent): agent is AgentConfig => Boolean(agent))
      const response = await fetch('/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: await modelFor(speaker, token), messages: [{ role: 'user', content: botGreetingPrompt({
          bot: { id: speaker.id, name: speaker.name, description: [speaker.role, speaker.instructions].filter(Boolean).join(' — '), labels: speaker.labels },
          language,
          group: conversation.type === 'group' ? { name: conversation.name, description: conversation.description, humanName: '',
            members: members.map((member) => ({ id: member.id, name: member.name, description: member.role })) } : undefined
        }) }] })
      })
      const payload = await response.json().catch(() => null) as { choices?: { message?: { content?: string } }[] } | null
      text = payload?.choices?.[0]?.message?.content?.split('\n').find((line) => line.trim())?.trim() ?? ''
    } catch { /* The plain hello below still opens the chat. */ }
  }
  if (hasMessages(sync, conversationId)) return
  const message: ChatMessage = {
    id: greetingMessageId(conversationId, conversation.activeTopicId), conversationId, topicId: conversation.activeTopicId,
    authorId: speaker.id, authorName: speaker.name, kind: 'message', createdAt: Date.now(),
    text: text || (language === 'zh-CN' ? `你好，我是${speaker.name}。` : `Hi, I'm ${speaker.name}.`)
  }
  await sync.mutate([{ kind: 'message', id: message.id, apply: (current) => current ?? message as unknown as SyncRecord }])
}

let modelIds: Promise<string[]> | undefined
/** The cloud models this account may use; /v1 answers in the OpenAI shape. */
export async function modelFor(agent: AgentConfig, token: string): Promise<string> {
  modelIds ??= fetch('/v1/models', { headers: { Authorization: `Bearer ${token}` } })
    .then((response) => response.json())
    .then((payload: { data?: { id?: string }[] }) => (payload.data ?? []).map((model) => model.id).filter((id): id is string => typeof id === 'string'))
    .catch(() => { modelIds = undefined; return [] })
  const ids = await modelIds
  return ids.includes(agent.model) ? agent.model : ids[0] ?? agent.model
}

export function prompt(agent: AgentConfig, user: DesktopAuthUser): string {
  return [
    `You are ${agent.name}${agent.role ? `, ${agent.role}` : ''}, chatting with ${user.name} in Douchat.`,
    agent.instructions,
    agent.labels ? `Personality: ${agent.labels}` : '',
    // Earlier turns in this chat may come from the desktop app, where agents have tools.
    isSystemAdmin(agent)
      ? `You are answering in the Douchat web app. Here your only tools message other agents, post in group chats you belong to, and manage the user's contacts and groups; you cannot read or write files, run commands, open folders or use connectors, even if earlier messages in this chat did. If a request needs that, say it works when the user asks from the Douchat desktop app. Earlier replies in this chat may have said other agents could not be messaged, groups posted to, or contacts managed here; that is no longer true. To announce, start or post something IN A GROUP, use send_group_message (after list_groups if the target is unclear) and @mention the members who should respond; do not tell the human to post it themselves.\n\n${agentManagementPrompt}`
      : 'You are answering in the Douchat web app. Here your only tools are message_agent, list_groups and send_group_message: you cannot read or write files, run commands, open folders, use connectors or manage agents, even if earlier messages in this chat did. If a request needs that, say it works when the user asks from the Douchat desktop app, and help as far as you can with conversation alone. To announce, start or post something in a group, use send_group_message and @mention the members who should respond.',
    'Reply in the language the user writes in. Keep answers clear and concise; use Markdown when it helps.'
  ].filter(Boolean).join('\n\n')
}

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatTurn =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** One streamed completion: its text as it arrives, then any tool calls it asked for. */
export async function streamTurn(token: string, body: Record<string, unknown>, onText: (delta: string) => void): Promise<{ text: string; toolCalls: ToolCall[] }> {
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(payload?.error?.message || `Douchat Cloud returned ${response.status}. Try again.`)
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const calls: ToolCall[] = []
  let text = ''
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : ''
      if (!data || data === '[DONE]') continue
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] }
      const delta = chunk.choices?.[0]?.delta
      if (delta?.content) { text += delta.content; onText(delta.content) }
      for (const part of delta?.tool_calls ?? []) {
        const call = calls[part.index ?? calls.length] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (part.id) call.id = part.id
        if (part.function?.name) call.function.name += part.function.name
        if (part.function?.arguments) call.function.arguments += part.function.arguments
      }
    }
  }
  const toolCalls = calls.filter(Boolean).map((call, index) => ({ ...call, id: call.id || `call_${index}` }))
  return { text, toolCalls }
}

/** A topic's turns between the human and one agent, oldest first, from its last context reset. */
export function chatHistory(sync: WebSync, conversationId: string, topicId: string, agentId: string, reset?: Topic['contextReset']): ChatTurn[] {
  return sync.all<ChatMessage>('message')
    .filter((item) => item.conversationId === conversationId && item.topicId === topicId && item.kind === 'message'
      // A desktop marks messages after a reset with its id; older copies have only their time.
      && (!reset || item.contextVersion === reset.id || (!item.contextVersion && item.createdAt >= reset.at))
      && item.text.trim() && (item.authorId === 'user' || item.authorId === agentId))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-HISTORY_LIMIT)
    .map((item): ChatTurn => ({ role: item.authorId === 'user' ? 'user' : 'assistant', content: item.text }))
}

const messageAgentTool = {
  type: 'function' as const,
  function: {
    name: 'message_agent',
    description: 'Send a real private message to another bot. Its answer is returned to you as working context. Use it to answer the human in your own voice, attributing the findings to the recipient; do not paste its reply verbatim. A copy is kept in that bot’s own chat by default. Use this for requests to greet, contact or send something to the human; do not ask the human to open that chat first. Set replyTo=caller only to consult a specialist privately for your own answer.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'The exact name or id of the target agent' },
        message: { type: 'string', description: 'A self-contained question or task for the target agent' },
        replyTo: { type: 'string', enum: ['human', 'caller'], description: 'Default human: return the recipient reply for you to summarize to the human, and keep a copy in the recipient private chat. Use caller only for internal consultation.' }
      },
      required: ['agent', 'message']
    }
  }
}

/**
 * The desktop's message_agent for cloud agents: the recipient answers with its
 * own profile and chat history, its reply lands in its private chat (unread,
 * like a desktop handoff), and the caller's chat keeps a delivery receipt.
 * Agents that run on a computer can only be reached while a desktop is online.
 */
async function messageAgent(context: { sync: WebSync; token: string; user: DesktopAuthUser; caller: AgentConfig; conversationId: string; topicId: string }, args: Record<string, unknown>): Promise<string> {
  const { sync, token, user, caller, conversationId, topicId } = context
  const callerReset = sync.get<Conversation>('conversation', conversationId)?.topics.find((item) => item.id === topicId)?.contextReset
  const callerVersion = callerReset ? { contextVersion: callerReset.id } : {}
  const reference = typeof args.agent === 'string' ? args.agent.trim() : ''
  const request = typeof args.message === 'string' ? args.message.trim() : ''
  if (!reference || !request) return 'Error: provide the target agent and a self-contained message.'
  const target = sync.all<AgentConfig>('agent').find((agent) => agent.ownerId === user.id
    && (agent.id === reference || agent.name.trim().toLocaleLowerCase() === reference.toLocaleLowerCase()))
  if (!target) return `No bot named “${reference}” exists.`
  if (target.id === caller.id) return `${target.name} is already working and cannot take this handoff.`
  if (target.provider !== GATEWAY_PROVIDER_ID || target.localAgentId) return `${target.name} runs on the user's computer, so it can only be messaged while the Douchat desktop app is online.`
  const toHuman = args.replyTo !== 'caller'
  const direct = toHuman ? sync.all<Conversation>('conversation').find((item) => item.id === `direct-${target.id}`) : undefined
  const directTopic = direct ? direct.topics.find((item) => item.id === direct.activeTopicId) ?? direct.topics[0] : undefined
  const prompt_ = `[Message from ${caller.name}] ${request}${toHuman
    ? '\nRespond to the human as yourself. The requesting agent will use your answer to summarize the result to the human. A copy is saved in your own private chat.'
    : '\nReply privately to the requesting agent for internal consultation.'}`
  let text = ''
  try {
    const history = direct && directTopic ? chatHistory(sync, direct.id, directTopic.id, target.id, directTopic.contextReset) : []
    const turn = await streamTurn(token, { model: await modelFor(target, token), stream: true,
      messages: [{ role: 'system', content: prompt(target, user) }, ...history, { role: 'user', content: prompt_ }] }, () => undefined)
    text = turn.text.trim()
  } catch (error) {
    return `${target.name} could not reply: ${error instanceof Error ? error.message : String(error)}. The request reached the recipient but no successful reply was produced.`
  }
  if (!text) return `${target.name} could not reply. The request reached the recipient but no successful reply was produced.`
  if (!direct || !directTopic) return `${target.name} replied: ${text}`
  const now = Date.now()
  const saved: ChatMessage = {
    id: crypto.randomUUID(), conversationId: direct.id, topicId: directTopic.id, authorId: target.id, authorName: target.name, text, kind: 'message', createdAt: now,
    source: { kind: 'bot', id: caller.id, name: caller.name, content: request }, ...(directTopic.contextReset ? { contextVersion: directTopic.contextReset.id } : {})
  }
  const receipt: ChatMessage = {
    id: crypto.randomUUID(), conversationId, topicId, authorId: caller.id, authorName: caller.name, text: '', kind: 'message', createdAt: now, ...callerVersion,
    deliveries: [{ id: crypto.randomUUID(), recipientId: target.id, recipientName: target.name, content: request,
      replies: [{ id: saved.id, senderId: target.id, senderName: target.name, content: text, createdAt: now }] }]
  }
  await sync.mutate([
    { kind: 'message', id: saved.id, apply: () => saved as unknown as SyncRecord },
    { kind: 'message', id: receipt.id, apply: () => receipt as unknown as SyncRecord },
    { kind: 'conversation', id: direct.id, apply: (current) => {
      if (!current) return null
      const next = structuredClone(current) as unknown as Conversation
      next.unread = (next.unread ?? 0) + 1
      next.updatedAt = now
      next.topics = next.topics.map((item) => item.id === directTopic.id ? { ...item, updatedAt: now } : item)
      return next as unknown as SyncRecord
    } }
  ])
  return `${target.name} replied (saved in their private chat). Use this as source material to answer the human’s original question in your own voice. Attribute the findings; do not paste the reply verbatim or say you are still waiting.\nRecipient reply:\n${text}`
}

const groupMessagingTools = [
  { type: 'function' as const, function: { name: 'list_groups', description: 'Find local group chats you belong to, including their exact IDs, names and members. Use before posting to an uncertain group target.', parameters: { type: 'object', properties: {} } } },
  { type: 'function' as const, function: {
    name: 'send_group_message',
    description: 'Post a real public message in a local group as yourself. This is group delivery, not a private message to an individual member. All group members can see the message. @mention members you want to answer; they reply in the group after you finish.',
    parameters: { type: 'object', properties: {
      group: { type: 'string', description: 'Exact group ID from list_groups or create_group, or an unambiguous exact group name.' },
      message: { type: 'string', description: 'Public message to post to the group as yourself.' }
    }, required: ['group', 'message'] }
  } }
]

/** The desktop's list_groups and send_group_message, over synced records. */
async function groupMessaging(sync: WebSync, agent: AgentConfig, name: string, args: Record<string, unknown>, callId: string, onPost?: (message: ChatMessage) => void): Promise<string> {
  const groups = sync.all<Conversation>('conversation').filter((item) => item.type === 'group' && !item.remoteRoomId && item.agentIds.includes(agent.id))
  const memberOf = (group: Conversation) => group.agentIds.flatMap((id) => { const member = sync.get<AgentConfig>('agent', id); return member ? [{ id, name: member.name }] : [] })
  if (name === 'list_groups') return JSON.stringify(groups.map((group) => ({ id: group.id, name: group.name, createdAt: group.createdAt, members: memberOf(group) })))
  const text = typeof args.message === 'string' ? args.message.trim() : ''
  const matches = groups.filter((group) => group.id === args.group || group.name === args.group)
  const group = matches.length === 1 ? matches[0] : undefined
  if (!group || !text || text.length > 16000) return 'Message not sent. Choose one exact group you belong to using list_groups and provide a nonempty message up to 16000 characters.'
  const members = memberOf(group)
  const recipients = (addressesEveryone(text) ? members : mentionedMembers(text, members)).filter((member) => member.id !== agent.id)
  const message: ChatMessage = {
    id: `${group.id}:${agent.id}:tool:${callId}`, conversationId: group.id, topicId: group.activeTopicId, authorId: agent.id, authorName: agent.name,
    text, kind: 'message', createdAt: Date.now(), ...(recipients.length ? { recipients } : {})
  }
  await sync.mutate([
    { kind: 'message', id: message.id, apply: (current) => current ?? message as unknown as SyncRecord },
    { kind: 'conversation', id: group.id, apply: (current) => {
      if (!current) return null
      const next = structuredClone(current) as unknown as Conversation
      next.unread = (next.unread ?? 0) + 1
      next.hidden = false
      next.updatedAt = message.createdAt
      return next as unknown as SyncRecord
    } }
  ])
  if (recipients.length) onPost?.(message)
  return `Posted your message publicly in “${group.name}”.${recipients.length ? ` ${recipients.map((member) => member.name).join(', ')} will answer there after you finish.` : ''}`
}

export interface CloudReplyHooks {
  /** Reply text so far, for the "typing" bubble. */
  onText: (text: string) => void
  /** Called just before the final reply (or failure notice) is stored. */
  onFinish: () => void
  /** A public group post that mentions members, for the group to answer once this reply ends. */
  onGroupPost?: (message: ChatMessage) => void
}

/**
 * Store the user's message, stream the agent's answer, then store the answer.
 * Both messages sync to every device like ones written on a desktop.
 */
export async function sendToCloudAgent(params: {
  sync: WebSync
  token: string
  user: DesktopAuthUser
  agent: AgentConfig
  conversation: Conversation
  text: string
  /** The stored reply takes this id, so it replaces the streamed draft in place. */
  replyId: string
  /** The human message's id, when it continues a queued request. */
  messageId?: string
  hooks: CloudReplyHooks
}): Promise<void> {
  const { sync, token, user, agent, conversation, text, replyId, messageId, hooks } = params
  const topic = conversation.topics.find((item) => item.id === conversation.activeTopicId) ?? conversation.topics[0]
  const topicId = topic?.id ?? conversation.activeTopicId
  const now = Date.now()
  // Messages after a context reset carry its id, as a desktop's do.
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
  await sync.mutate([{ kind: 'message', id: message.id, apply: () => message as unknown as SyncRecord }, touch(now, text.slice(0, 40))])

  const history = chatHistory(sync, conversation.id, topicId, agent.id, topic?.contextReset)

  let reply = ''
  try {
    const tools = [messageAgentTool, ...groupMessagingTools, ...(isSystemAdmin(agent) ? agentManagementTools : [])]
    const context = { sync, ownerId: user.id, self: agent, onCreated: (id: string) => { void greetNewChat(sync, token, id).catch(() => undefined) } }
    const messages: ChatTurn[] = [{ role: 'system', content: prompt(agent, user) }, ...history]
    const model = await modelFor(agent, token)
    for (let round = 0; ; round++) {
      // The last round offers no tools, so the model has to answer in words.
      const offered = tools && round < TOOL_ROUNDS ? tools : undefined
      const turn = await streamTurn(token, { model, stream: true, messages, ...(offered ? { tools: offered } : {}) }, (delta) => { reply += delta; hooks.onText(reply) })
      if (!turn.toolCalls.length) break
      messages.push({ role: 'assistant', content: turn.text || null, tool_calls: turn.toolCalls })
      for (const call of turn.toolCalls) {
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown> } catch { /* reported below as missing fields */ }
        const result = call.function.name === 'message_agent'
          ? await messageAgent({ sync, token, user, caller: agent, conversationId: conversation.id, topicId }, args)
          : call.function.name === 'list_groups' || call.function.name === 'send_group_message'
            ? await groupMessaging(sync, agent, call.function.name, args, call.id, hooks.onGroupPost)
            : await runAgentManagementTool(context, call.function.name, args)
        messages.push({ role: 'tool', tool_call_id: call.id, content: result })
      }
      // Text before a tool call is a preamble; keep it and separate the follow-up.
      if (reply && !reply.endsWith('\n')) { reply += '\n\n'; hooks.onText(reply) }
    }
    if (!reply.trim()) throw new Error(`${agent.name} finished without a text response.`)
  } catch (error) {
    hooks.onFinish()
    const notice: ChatMessage = {
      id: crypto.randomUUID(), conversationId: conversation.id, topicId, authorId: 'system', authorName: 'Douchat', kind: 'system',
      text: error instanceof Error ? error.message : 'The reply failed. Try again.', createdAt: Date.now(), ...version
    }
    await sync.mutate([{ kind: 'message', id: notice.id, apply: () => notice as unknown as SyncRecord }])
    return
  }
  hooks.onFinish()
  const answer: ChatMessage = { id: replyId, conversationId: conversation.id, topicId, authorId: agent.id, authorName: agent.name, text: reply, kind: 'message', createdAt: Date.now(), ...version }
  await sync.mutate([{ kind: 'message', id: answer.id, apply: () => answer as unknown as SyncRecord }, touch(answer.createdAt)])
}

