import { describe, expect, it } from 'vitest'
import type { ChatMessage, Conversation } from './types'
import { socialFollowUpTarget, SOCIAL_FOLLOW_UP_WINDOW_MS } from './socialFollowUp'

const now = 1_000_000
const conversation: Conversation = {
  id: 'friend-group', ownerId: 'alice', type: 'group', name: 'Group', agentIds: ['dr', 'grok'],
  topics: [], activeTopicId: 'main', unread: 0, readAt: 0, createdAt: 0, updatedAt: 0,
  socialRoom: { id: 'group', kind: 'group', name: 'Group', createdAt: '',
    members: [{ id: 'alice', name: 'Alice', email: '' }, { id: 'bob', name: 'Bob', email: '' }],
    agents: [{ id: 'dr', name: 'Dr. Dou', ownerId: 'bob', localId: 'dr', interactionHumans: 'allow' },
      { id: 'grok', name: 'Grok', ownerId: 'alice', localId: 'grok' }] }
}
const request: ChatMessage = { id: 'friend-group:request', conversationId: conversation.id, topicId: 'main',
  authorId: 'user', authorName: 'Alice', text: '@Dr. Dou 报数', kind: 'message', createdAt: now - 1000,
  socialTasks: [{ id: 'request', agentId: 'dr', agentName: 'Dr. Dou', status: 'succeeded' }] }
const reply: ChatMessage = { ...request, id: 'friend-group:request:reply', authorId: 'dr', authorName: 'Dr. Dou',
  text: '要邀请其他人吗？', socialTasks: undefined }
const history = [request, reply]
const target = (messages = history, content = '要啊', room = conversation, time = now) => socialFollowUpTarget(room, messages, content, time)?.id

describe('shared group follow-up routing', () => {
  it('continues the answered request and ignores delegated/public replies from other agents', () => {
    expect(target()).toBe('dr')
    expect(target([...history,
      { ...reply, id: 'friend-group:request:delegate', authorId: 'user' },
      { ...reply, id: 'friend-group:request:delegate:reply', authorId: 'grok' }
    ])).toBe('dr')
  })
  it.each(['@Bob 好的', '@all 都看看', '@Grok 帮忙', '@Unknown 你好', '👍 @Bob 好的', '＠Bob 好的'])(
    'does not inherit a target for an explicit address: %s', content => expect(target(history, content)).toBeUndefined()
  )
  it('lets the service route a message that names another agent without @', () => {
    for (const content of ['is Grok here?', 'grok, can I talk with you', '叫 Grok 来']) expect(target(history, content)).toBeUndefined()
    expect(target(history, 'Dr. Dou 你再想想')).toBe('dr')
    const named = { ...conversation, socialRoom: { ...conversation.socialRoom!, agents: [...conversation.socialRoom!.agents, { id: 'dou', name: 'Dou', ownerId: 'alice', localId: 'dou' }] } }
    expect(target(history, 'Dr. Dou 继续', named)).toBe('dr')
  })
  it('lets the service pick someone else when the message asks for another responder', () => {
    for (const content of ['any one else?', 'can another agent answer me', 'anyone?', '换个人回答', '还有谁在', '其他 agent 呢'])
      expect(target(history, content)).toBeUndefined()
    for (const content of ['要啊，继续', '换个话题聊聊', 'lets talk another topic', 'what else can you do'])
      expect(target(history, content)).toBe('dr')
  })
  it('does not interpret quoted mentions, code or email as a new address', () => {
    expect(target(history, '> @Bob 的建议\n帮我解释一下')).toBe('dr')
    expect(target(history, '解释 `@Bob`，发到 hello@example.com')).toBe('dr')
  })
  it('stops at intervening human messages, a new unaddressed turn, or another account', () => {
    expect(target([...history, { ...request, id: 'other', authorId: 'bob', socialTasks: undefined }])).toBeUndefined()
    expect(target([...history, { ...request, id: 'new', socialTasks: undefined }])).toBeUndefined()
    expect(target([{ ...request, authorId: 'alice' }, reply])).toBeUndefined()
  })
  it('requires one successful, delivered task with an actual reply', () => {
    expect(target([request])).toBeUndefined()
    for (const status of ['pending', 'running', 'failed']) {
      expect(target([{ ...request, socialTasks: [{ ...request.socialTasks![0], status }] }, reply])).toBeUndefined()
    }
    expect(target([{ ...request, deliveryState: 'failed' }, reply])).toBeUndefined()
    expect(target([{ ...request, socialTasks: [...request.socialTasks!, { id: 'second', agentId: 'grok', agentName: 'Grok', status: 'succeeded' }] }, reply])).toBeUndefined()
    expect(target([request, { ...reply, error: 'Failed' }])).toBeUndefined()
    expect(target([request, { ...reply, text: '' }])).toBeUndefined()
    expect(target([{ ...request, text: '@Bob @Dr. Dou help' }, reply])).toBeUndefined()
    expect(target([{ ...request, text: '@all @Dr. Dou help' }, reply])).toBeUndefined()
  })
  it('expires and does not cross rooms, topics, membership or permissions', () => {
    expect(target(history, '', conversation, now + SOCIAL_FOLLOW_UP_WINDOW_MS)).toBeUndefined()
    expect(target(history, '', { ...conversation, id: 'another-room' })).toBeUndefined()
    expect(target(history, '', { ...conversation, activeTopicId: 'another-topic' })).toBeUndefined()
    expect(target(history, '', { ...conversation, socialRoom: undefined })).toBeUndefined()
    const resetRoom = { ...conversation, topics: [{ id: 'main', title: '', createdAt: 0, updatedAt: 0, contextReset: { id: 'new-context', at: now } }] }
    expect(target(history, '', resetRoom)).toBeUndefined()
    expect(target([{ ...request, contextVersion: 'new-context' }, reply], '', resetRoom)).toBe('dr')
    for (const agents of [[], [{ ...conversation.socialRoom!.agents[0], interactionHumans: 'deny' as const }]]) {
      expect(target(history, '', { ...conversation, socialRoom: { ...conversation.socialRoom!, agents } })).toBeUndefined()
    }
  })
})
