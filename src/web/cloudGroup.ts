import { agentIdentityPrompt } from '../shared/agentCustomization'
import { decisionJson } from '../shared/groupDecision'
import { groupNotice } from '../shared/groupText'
import { groupConversationPrompt, groupDecisionPrompt, groupLeadMember, runGroupConversation, validateGroupDecision, type BotGroup, type GroupDecision, type GroupMember, type GroupMessage, type GroupReply } from '../shared/bot/group'
import { botReplyPrompt, splitBotReply } from '../shared/bot/messages'
import { privateReplyDeliveries } from '../shared/bot/privateMessages'
import type { SyncRecord } from '../shared/cloudSync'
import type { AgentConfig, ChatMessage, Conversation, DesktopAuthUser } from '../shared/types'
import { interfaceLanguage, isCloudAgent, modelFor, streamTurn } from './cloudChat'
import type { HostTaskState } from '../shared/hostTask'
import { runHostTurn, type HostAgents, type SocialCall } from './hostChat'
import type { WebSync } from './webSync'

/**
 * Group chats answered in the browser while no desktop is online: the shared
 * desktop scheduler (runGroupConversation, its dispatch policy and transport
 * prompts) with cloud agents answering through /v1 and agents a douchat-host
 * runs itself answering as owner tasks on their server. Members that run on a
 * computer are reported unavailable for the round.
 */
export function canRunCloudGroup(sync: WebSync, conversation: Conversation, hosts?: HostAgents): boolean {
  return conversation.type === 'group' && conversation.agentIds.some((id) => isCloudAgent(sync.get<AgentConfig>('agent', id)) || Boolean(hosts?.host(id)))
}

type Activity = (phase: 'planning' | 'replying', agentIds: string[]) => void
/** Hosts that run group members themselves, and the channel their tasks go through. */
interface GroupHosts {
  agents: HostAgents
  call: SocialCall
  /** A member's task on its host as it progresses, for approval cards and stopping. */
  onState?(conversationId: string, agent: AgentConfig, state: HostTaskState): void
}

/** The human posts in the group, and its cloud agents answer. */
export async function sendToCloudGroup(params: {
  sync: WebSync; token: string; user: DesktopAuthUser; conversation: Conversation; text: string; onActivity: Activity
  /** The human message's id, when it continues a queued request. */
  messageId?: string
  hosts?: GroupHosts
}): Promise<void> {
  const { sync, conversation, user, text } = params
  const message: ChatMessage = { id: params.messageId ?? crypto.randomUUID(), conversationId: conversation.id, topicId: conversation.activeTopicId, authorId: 'user', authorName: user.name, text, kind: 'message', createdAt: Date.now() }
  await sync.mutate([
    { kind: 'message', id: message.id, apply: () => message as unknown as SyncRecord },
    { kind: 'conversation', id: conversation.id, apply: (current) => current ? { ...current, updatedAt: message.createdAt } : null }
  ])
  await runCloudGroupRound({ ...params, trigger: message })
}

/**
 * One round of the group answering an already stored message: the human's, or
 * an agent's public post that mentions members (send_group_message), which on
 * a desktop also runs once its sender finishes.
 */
export async function runCloudGroupRound(params: {
  sync: WebSync; token: string; user: DesktopAuthUser; conversation: Conversation; trigger: ChatMessage; onActivity: Activity
  hosts?: GroupHosts
}): Promise<void> {
  const { sync, token, user, conversation, trigger: message, onActivity, hosts } = params
  const onHost = (id: string) => Boolean(hosts?.agents.host(id))
  const topicId = message.topicId
  const topic = conversation.topics.find((item) => item.id === topicId)
  const language = interfaceLanguage()
  const agents = new Map(conversation.agentIds.flatMap((id) => { const agent = sync.get<AgentConfig>('agent', id); return agent ? [[id, agent] as const] : [] }))
  const group: BotGroup = {
    id: conversation.id, name: conversation.name, description: conversation.description, humanName: user.name,
    leadMemberId: conversation.leadAgentId,
    members: [...agents.values()].map((agent): GroupMember => ({ id: agent.id, name: agent.name, description: [agent.role, agent.instructions].filter(Boolean).join(' — ') }))
  }
  const save = (messages: ChatMessage[]) => sync.mutate([
    ...messages.map((item) => ({ kind: 'message' as const, id: item.id, apply: () => item as unknown as SyncRecord })),
    { kind: 'conversation', id: conversation.id, apply: (current) => {
      if (!current) return null
      const next = structuredClone(current) as unknown as Conversation
      next.updatedAt = Date.now()
      return next as unknown as SyncRecord
    } }
  ])
  const notice = (key: string, values: Record<string, string | number> = {}) => save([{ id: crypto.randomUUID(), conversationId: conversation.id, topicId, authorId: 'system', authorName: 'Douchat', kind: 'system', createdAt: Date.now(), ...groupNotice(language, key, values) }])

  const asGroupMessage = (item: ChatMessage): GroupMessage => item.authorId === 'user'
    ? { id: item.id, role: 'user', content: item.text }
    : { id: item.id, role: 'assistant', sender: { id: item.authorId, name: item.authorName }, content: item.text }
  const history = sync.all<ChatMessage>('message')
    .filter((item) => item.conversationId === conversation.id && item.topicId === topicId && item.kind === 'message' && item.text.trim() && item.createdAt >= (topic?.contextReset?.at ?? 0))
    .sort((a, b) => a.createdAt - b.createdAt).slice(-60).map(asGroupMessage)
  // A host adds the agent's signed identity itself.
  const complete = async (agent: AgentConfig, content: string) => onHost(agent.id)
    ? runHostTurn(hosts!.call, agent, content, state => hosts!.onState?.(conversation.id, agent, state), conversation.hostWorkspaces?.[agent.id]?.path)
    : (await streamTurn(token, { model: await modelFor(agent, token), stream: true, messages: [{ role: 'system', content: agentIdentityPrompt(agent) }, { role: 'user', content }] }, () => undefined)).text
  const answers = (id: string) => isCloudAgent(agents.get(id)) || onHost(id)

  const signal = new AbortController().signal
  const unavailable = conversation.agentIds.filter((id) => !answers(id))
  const result = await runGroupConversation({
    group, user: asGroupMessage(message), history, signal, configuredRouting: true, directMentionRouting: true, initiallyUnavailable: unavailable,
    onUnavailable: (memberId) => { void notice('Scheduling: {member} is not configured to run. Skipping this round.', { member: agents.get(memberId)?.name ?? memberId }) },
    decide: async (context) => {
      const lead = groupLeadMember(group)
      // A cloud member plans fastest; with none, a host-run member plans as the group's leader would.
      const available = [lead, ...group.members].filter((member): member is GroupMember => Boolean(member) && !context.unavailableMemberIds?.includes(member!.id))
      const planner = available.find((member) => isCloudAgent(agents.get(member.id))) ?? available.find((member) => onHost(member.id))
      if (!planner) return { mode: 'none', memberIds: [], triggerMessageIds: [] }
      onActivity('planning', [planner.id])
      let correction = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = decisionJson(await complete(agents.get(planner.id)!, groupDecisionPrompt(group, context, planner) + correction)) as GroupDecision
          return validateGroupDecision({ ...raw, leaderMemberId: raw.leaderMemberId ?? (raw.mode !== 'none' || context.recovery ? planner.id : undefined) }, group, context)
        } catch (error) {
          correction = `\nThe previous response failed validation: ${error instanceof Error ? error.message : 'Invalid plan'}. Return a corrected complete JSON plan using the exact IDs above. Do not execute the task.`
        }
      }
      // An unusable plan still gets the human an answer from the planner.
      return { mode: 'single', memberIds: [planner.id], triggerMessageIds: [message.id], leaderMemberId: planner.id }
    },
    reply: async (member, turn, visible): Promise<GroupReply> => {
      const agent = agents.get(member.id)
      if (!agent || !answers(agent.id)) return { messages: [], failed: true }
      onActivity('replying', [member.id])
      let reply = ''
      try { reply = await complete(agent, botReplyPrompt(groupConversationPrompt(group, member, visible, turn, []))) }
      catch { return { messages: [], failed: true } }
      if (!reply.trim()) return { messages: [], failed: true }
      if (turn.directAddress && reply.trim() === '[[douchat_silent]]') return { messages: [] }
      const delivery = privateReplyDeliveries(reply, member, group.members, `${conversation.id}:${crypto.randomUUID().slice(0, 8)}`, topicId)
      if (delivery.invalid) return { messages: [], failed: true }
      const at = Date.now()
      const blocks = splitBotReply(delivery.publicText)
      const replyGroupId = blocks.length > 1 ? crypto.randomUUID() : undefined
      const saved: ChatMessage[] = blocks.map((block, index) => ({
        id: crypto.randomUUID(), conversationId: conversation.id, topicId, authorId: agent.id, authorName: agent.name, text: block, kind: 'message', createdAt: at + index,
        ...(replyGroupId ? { replyGroupId } : {}),
        ...(index === blocks.length - 1 && delivery.messages.length ? { deliveries: delivery.messages.map((item) => ({ id: item.id, recipientId: item.recipient.id, recipientName: item.recipient.name || 'You', content: '' })) } : {})
      }))
      // Private notes to the human land in that member's own chat, as on a desktop.
      const direct = sync.get<Conversation>('conversation', `direct-${agent.id}`)
      const inbox: ChatMessage[] = direct ? delivery.messages.filter((item) => item.recipient.id === 'human').map((item) => ({
        id: crypto.randomUUID(), conversationId: direct.id, topicId: direct.activeTopicId, authorId: agent.id, authorName: agent.name, text: item.content, kind: 'message', createdAt: at,
        source: { kind: 'group', id: conversation.id, name: conversation.name }
      })) : []
      await save([...saved, ...inbox])
      return { messages: saved.map(asGroupMessage), privateMessages: delivery.messages }
    }
  })
  if (result.limited) await notice('The activity reached its execution limit. Review the results and send a new instruction.')
  if (result.failed) await save([{ id: crypto.randomUUID(), conversationId: conversation.id, topicId, authorId: 'system', authorName: 'Douchat', kind: 'system', createdAt: Date.now(), text: 'No member of this group could complete the request.' }])
}
