import { addressesEveryone, hasExplicitMention, mentionedMembers } from './bot/mentions'
import type { SocialAgent } from './social'
import type { ChatMessage, Conversation } from './types'

export const SOCIAL_FOLLOW_UP_WINDOW_MS = 10 * 60 * 1000

/** Continue only the current human's unambiguous, answered turn. Delegations
 * and other agents' public replies must never steal that turn's recipient. */
export function socialFollowUpTarget(
  conversation: Conversation | undefined,
  messages: ChatMessage[],
  content = '',
  now = Date.now()
): SocialAgent | undefined {
  const room = conversation?.socialRoom
  if (!conversation || room?.kind !== 'group' || hasExplicitMention(content)) return undefined
  const history = messages.filter(message => message.conversationId === conversation.id && message.topicId === conversation.activeTopicId).slice(-50)
  const agentIds = new Set(room.agents.map(agent => agent.id))
  const reset = conversation.topics.find(topic => topic.id === conversation.activeTopicId)?.contextReset
  const lastHuman = history.filter(message =>
    message.kind === 'message' && !message.id.includes(':delegate') && !message.id.endsWith(':reply') &&
    !agentIds.has(message.authorId) && message.authorId !== 'system'
  ).sort((a, b) => a.createdAt - b.createdAt).at(-1)
  if (!lastHuman || lastHuman.authorId !== 'user' || lastHuman.deliveryState || lastHuman.socialTasks?.length !== 1) return undefined
  if (reset && lastHuman.contextVersion !== reset.id) return undefined
  if (addressesEveryone(lastHuman.text) || mentionedMembers(lastHuman.text, room.members).length) return undefined
  const task = lastHuman.socialTasks[0]
  if (task.status !== 'succeeded') return undefined
  const reply = history.find(message => message.id === `${conversation.id}:${task.id}:reply` && message.authorId === task.agentId && !message.error)
  if (!reply || (!reply.text && !reply.attachments?.length)) return undefined
  const lastActivity = Math.max(lastHuman.createdAt, reply.createdAt)
  if (now < lastActivity || now - lastActivity > SOCIAL_FOLLOW_UP_WINDOW_MS) return undefined
  const target = room.agents.find(agent => agent.id === task.agentId)
  if (!target || (target.ownerId !== conversation.ownerId && (!target.interactionHumans || target.interactionHumans === 'deny'))) return undefined
  return target
}
