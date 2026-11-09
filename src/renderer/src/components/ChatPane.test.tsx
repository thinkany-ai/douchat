// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, ChatMessage, Conversation, ConversationActivityState } from '../../../shared/types'

vi.mock('../preferences', () => ({
  t: (text: string) => text,
  tr: (text: string, values: Record<string, string | number>) => Object.entries(values).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
    text
  )
}))

const markdownRenders = vi.hoisted(() => ({ count: 0 }))

vi.mock('./MessageMarkdown', async () => ({
  FileConversationContext: (await import('react')).createContext<string | undefined>(undefined),
  QuoteMarkdown: ({ text }: { text: string }) => <span>{text}</span>,
  MessageMarkdown: ({ text }: { text: string }) => {
    markdownRenders.count += 1
    return <div data-testid="private-message-content">{text}</div>
  }
}))

vi.mock('./common', () => ({
  mentionableAgents: (_conversation: unknown, members: AgentConfig[]) => members,
  AgentAvatar: ({ agent }: { agent: { name: string } }) => <span data-testid="agent-avatar" data-agent-name={agent.name} />,
  EmptyAvatar: () => <span data-testid="empty-avatar" />,
  UserAvatar: ({ name }: { name: string }) => <span data-testid="user-avatar" data-user-name={name} />,
  agentDisplayName: (agent: { name: string }) => agent.name,
  conversationDisplayName: (conversation: { name: string }) => conversation.name,
  dayLabel: () => '',
  formatTime: () => '',
  isDifferentDay: () => false
}))

import { setRemoteAgents } from "./RemoteMark"
import {
  groupConversationMessages,
  groupDeliveryReplies,
  MessageDeliveries,
  MessageActions,
  ChatActivity,
  ChatPane,
  MessageGroupRow,
  MessageRow,
  MessageSourceCard,
  SystemMessage,
  visibleConversationMessages,
  hideStaleErrors
} from './ChatPane'

const deliveries = [
  {
    id: 'private-1',
    recipientId: 'agent-1',
    recipientName: '拽姐',
    content: '先确认她有没有空。',
    replies: [
      { id: 'reply-1', senderId: 'agent-1', senderName: '拽姐', content: '我有空，七点见。', createdAt: 1, replyGroupId: 'reply-group-1' },
      { id: 'reply-2', senderId: 'agent-1', senderName: '拽姐', content: '规则先说好。', createdAt: 1, replyGroupId: 'reply-group-1' }
    ]
  },
  { id: 'private-2', recipientId: 'agent-2', recipientName: '小微', content: '准备一副牌。' }
]

const agents: AgentConfig[] = [
  { id: 'agent-1', name: '拽姐', role: '', instructions: '', color: '#ff5da8', provider: '', model: '', createdAt: 0 },
  { id: 'agent-2', name: '小微', role: '', instructions: '', color: '#7c6cf2', provider: '', model: '', createdAt: 0 }
]

const outbound: ChatMessage = {
  id: 'outbound-1',
  conversationId: 'direct-sender',
  topicId: 'topic-1',
  authorId: 'sender-1',
  authorName: '豆博士',
  text: '我发出了邀请。',
  kind: 'message',
  createdAt: 10,
  deliveries: [{ id: 'delivery-1', recipientId: 'agent-1', recipientName: '拽姐', content: '今晚七点半，老地方见。' }]
}

const incomingReply: ChatMessage = {
  id: 'incoming-1',
  conversationId: 'direct-agent-1',
  topicId: 'topic-2',
  authorId: 'agent-1',
  authorName: '拽姐',
  text: '好，我会准时到。',
  kind: 'message',
  createdAt: 20,
  source: { kind: 'bot', id: 'sender-1', name: '豆博士' }
}

const directConversation: Conversation = {
  id: 'direct-agent-1',
  type: 'direct',
  name: 'agent-1',
  agentIds: ['agent-1'],
  topics: [],
  activeTopicId: 'topic-2',
  unread: 0,
  readAt: 0,
  createdAt: 0,
  updatedAt: 0
}

describe('private delivery disclosure', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  it('folds delivery-only receipts above the next answer, collapsed by default', async () => {
    const receipt: ChatMessage = { ...incomingReply, id: 'receipt', source: undefined, text: '', deliveries }
    const answer: ChatMessage = { ...receipt, id: 'answer', text: 'Switched the song.', deliveries: undefined }
    const visible = visibleConversationMessages(directConversation, [receipt, answer])
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({ id: 'answer', text: answer.text, deliveries })
    expect(answer.deliveries).toBeUndefined()
    await act(async () => root.render(<MessageGroupRow messages={visible} agents={agents} relatedMessages={[receipt, answer]} userName="Dobi" userAvatar="" showAuthor={false} />))
    expect(container.querySelectorAll('.agent-bubble')).toHaveLength(1)
    const toggle = container.querySelector('.bubble-deliveries')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain(deliveries[0].content)
    expect(toggle.compareDocumentPosition(container.querySelector('.bubble-primary-content')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => (toggle as HTMLButtonElement).click())
    expect(container.textContent).toContain(deliveries[0].content)
  })

  it('shows only the failure from the latest turn and hides earlier ones', () => {
    const user = (id: string): ChatMessage => ({ ...incomingReply, id, authorId: 'user', kind: 'message', text: 'hi', source: undefined })
    const failure = (id: string): ChatMessage => ({ ...incomingReply, id, authorId: 'system', kind: 'system', source: undefined,
      text: 'The custom model was removed or is unavailable', detail: 'Error: The custom model was removed or is unavailable.' })
    const notice: ChatMessage = { ...failure('notice'), text: 'Task cancelled.', detail: undefined }
    const history = [user('u1'), failure('e1'), notice, user('u2'), failure('e2')]
    expect(hideStaleErrors(history).map(message => message.id)).toEqual(['u1', 'notice', 'u2', 'e2'])
    expect(hideStaleErrors([...history, user('u3')]).map(message => message.id)).toEqual(['u1', 'notice', 'u2', 'u3'])
    const clean = [user('u1'), notice]
    expect(hideStaleErrors(clean)).toBe(clean)
  })

  it('keeps pending receipts and does not fold across user messages or topics', () => {
    const receipt: ChatMessage = { ...incomingReply, source: undefined, text: '', deliveries }
    const answer: ChatMessage = { ...receipt, id: 'answer', text: 'Done', deliveries: undefined }
    expect(visibleConversationMessages(directConversation, [receipt])).toEqual([receipt])
    const user = { ...answer, id: 'user', authorId: 'user' }
    expect(visibleConversationMessages(directConversation, [receipt, user, answer])).toHaveLength(3)
    expect(visibleConversationMessages(directConversation, [receipt, { ...answer, topicId: 'other' }])).toHaveLength(2)
    const second = { ...receipt, id: 'second', deliveries: [deliveries[1]] }
    expect(visibleConversationMessages(directConversation, [receipt, second, answer])[0].deliveries).toHaveLength(3)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('shows offline and approval waits and clears them after completion', async () => {
    const task = { id: 'task', agentId: 'peer', agentName: 'Peer', status: 'pending' }
    const peer = { id: 'peer', localId: 'local', ownerId: 'bob', name: 'Peer', onlineUntil: 0, approvalTaskId: 'task' }
    const render = async () => act(async () => root.render(<MessageRow messages={[{ ...incomingReply, authorId: 'user', socialTasks: [task] }]} socialAgents={[peer]} agents={[]} relatedMessages={[]} userName="You" userAvatar="" showAuthor={false} />))
    await render()
    expect(container.textContent).toContain('等待主人设备上线')
    peer.onlineUntil = Date.now() + 45000
    task.status = 'running'
    await render()
    expect(container.textContent).toContain('等待主人确认')
    task.status = 'succeeded'
    await render()
    expect(container.querySelector('.social-task-status')).toBeNull()
  })

  it('renders received IM file links through the file-chip renderer', async () => {
    const message: ChatMessage = { ...outbound, authorId: 'user', sourceChannel: 'telegram', text: '[report.txt](<douchat-file:///tmp/report.txt>)' }
    await act(async () => { root.render(<MessageRow messages={[message]} agents={[]} relatedMessages={[]} userName="You" userAvatar="" showAuthor={false} />) })
    expect(container.querySelector('.user-bubble [data-testid="private-message-content"]')?.textContent).toBe(message.text)
  })

  it.each(['wechat', 'feishu', 'telegram', undefined] as const)('shows message provenance for %s without changing bubble text', async sourceChannel => {
    const message: ChatMessage = { ...outbound, authorId: 'user', text: 'hello', sourceChannel }
    await act(async () => root.render(<MessageRow messages={[message]} agents={[]} relatedMessages={[]} userName="You" userAvatar="" showAuthor={false} />))
    const badge = container.querySelector('.message-channel-badge')
    if (sourceChannel) {
      const names = { wechat: 'WeChat', feishu: 'Feishu', telegram: 'Telegram' }
      expect(badge?.getAttribute('title')).toBe(`Sent via ${names[sourceChannel]}`)
      expect(badge?.getAttribute('aria-label')).toBe(`Sent via ${names[sourceChannel]}`)
      expect(badge?.querySelector('img')?.getAttribute('src')).toContain(sourceChannel)
    } else expect(badge).toBeNull()
    expect(container.querySelector('.user-bubble')?.textContent).toBe('hello')
  })

  it('folds external group invitations into the sender reply without hiding public replies', async () => {
    const conversation: Conversation = { ...directConversation, id: 'friend-room', type: 'group',
      socialRoom: { id: 'room', name: 'Group', kind: 'group', members: [], agents: [], createdAt: '' } }
    const sender: ChatMessage = { ...outbound, id: 'friend-room:root:task:grok:reply', conversationId: conversation.id,
      authorId: 'grok', authorName: 'Grok', text: 'Grok reported in.', deliveries: undefined }
    const request: ChatMessage = { ...sender, id: 'friend-room:root:task:grok:delegate', text: 'Hermes, please report number 3.',
      socialTasks: [{ id: 'root:task:grok:delegate', agentId: 'hermes', agentName: 'Hermes', status: 'succeeded' }] }
    const reply: ChatMessage = { ...sender, id: `${request.id}:reply`, authorId: 'hermes', authorName: 'Hermes', text: '3. Hermes here.' }
    const raw = [request, sender, reply]
    const visible = visibleConversationMessages(conversation, raw)
    expect(visible.map((message) => message.id)).toEqual([sender.id, reply.id])
    expect(sender.deliveries).toBeUndefined()
    expect(request.text).toBe('Hermes, please report number 3.')
    await act(async () => root.render(<MessageRow messages={[visible[0]]} agents={[]} relatedMessages={raw} userName="You" userAvatar="" showAuthor />))
    expect(container.textContent).toContain('Grok reported in.')
    expect(container.textContent).toContain('Invited Hermes to participate')
    expect(container.textContent).not.toContain(request.text)
    expect(container.textContent).not.toContain('private message')
    await act(async () => container.querySelector<HTMLButtonElement>('.bubble-deliveries')?.click())
    expect(container.textContent).toContain(request.text)
    expect(container.textContent).toContain('Hermes replied')
    expect(container.textContent).toContain(reply.text)
    expect(container.textContent).toContain('Invitation completed')

    // Pending invitations and pages lacking the sender's reply retain a card.
    const pending = { ...request, socialTasks: [{ ...request.socialTasks![0], status: 'running' }] }
    const page = visibleConversationMessages(conversation, [pending])
    expect(page[0].text).toBe('')
    expect(page[0].deliveries?.[0].content).toBe(request.text)
    expect(page[0].deliveries?.[0].status).toBe('running')
    expect(page[0].deliveries?.[0].replies).toBeUndefined()

    // Chained invitations belong to the next agent's own public reply.
    const next = { ...pending, id: `${request.id}:delegate`, authorId: 'hermes', authorName: 'Hermes', text: 'Dobi, join us.',
      socialTasks: [{ id: 'root:task:grok:delegate:delegate', agentId: 'dobi', agentName: 'Dobi', status: 'pending' }] }
    const chain = visibleConversationMessages(conversation, [...raw, next])
    expect(chain.map((message) => message.id)).toEqual([sender.id, reply.id])
    expect(chain[1].deliveries?.[0].recipientName).toBe('Dobi')
  })

  it('shows a status while a sent message is waiting for the task snapshot', async () => {
    await act(async () => root.render(<MessageRow messages={[{ ...incomingReply, authorId: 'user', deliveryState: 'confirming' }]} agents={[]} relatedMessages={[]} userName="You" userAvatar="" showAuthor={false} />))
    expect(container.querySelector('.message-delivery-state')?.textContent).toBe('已发送，正在同步接单状态…')
  })

  it('renders saved reply quotes inline with the author and keeps the reply separate', async () => {
    const message = { ...incomingReply, authorId: 'user', text: '> Dobi:\n> First line\n> Second line\n\nMy reply' }
    await act(async () => root.render(<MessageRow messages={[message]} agents={agents} relatedMessages={[]} userName="You" userAvatar="" showAuthor={false} />))
    const quote = container.querySelector('.message-quote')!
    expect(quote.textContent).toBe('Dobi: First line\nSecond line')
    expect(quote.querySelector('button')).toBeNull()
    expect(container.querySelector('.user-bubble > span')?.textContent).toBe('My reply')
  })

  it.each([true, false])('places quoted images inside the quote, preserving new images (legacy=%s)', async legacy => {
    window.douchat = { getAttachmentData: vi.fn().mockResolvedValue('data:image/png;base64,aGVsbG8=') } as unknown as typeof window.douchat
    const image = { id: 'quoted', kind: 'image' as const, name: 'reference.png', mimeType: 'image/png' as const, size: 5 }
    const attachments = legacy ? [image] : [{ ...image, quoted: true }, { ...image, id: 'new', name: 'new.png', quoted: false }]
    const message = { ...incomingReply, authorId: 'user', text: '> Dobi:\n> Image\n\nMy reply', attachments }
    await act(async () => root.render(<MessageRow messages={[message]} agents={agents} relatedMessages={[]} userName="You" userAvatar="" showAuthor={false} />))
    expect(container.querySelector('.message-quote img')?.getAttribute('alt')).toBe('reference.png')
    expect(container.querySelectorAll('.user-bubble > .message-attachments img')).toHaveLength(legacy ? 0 : 1)
    if (!legacy) expect(container.querySelector('.user-bubble > .message-attachments img')?.getAttribute('alt')).toBe('new.png')
  })

  it('blocks sending and offers a retry, not an agent picker, when the signed-in cloud is unavailable', async () => {
    const onSend = vi.fn(async () => {})
    const reconnectCloud = vi.fn().mockResolvedValue({ runtime: { mode: 'offline', label: '' } })
    window.douchat = { reconnectCloud } as unknown as typeof window.douchat
    const render = (cloudUnavailable: boolean) => act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={directConversation} messages={[]} allMessages={[]} agents={agents} members={agents} offline cloudUnavailable={cloudUnavailable} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={onSend} onStop={() => {}} />))
    await render(true)
    const banner = container.querySelector('.offline-banner')!
    expect(banner.textContent).toContain('Douchat Cloud is unavailable right now. Messages cannot be sent.')
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((container.querySelector('.send-button') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => (banner.querySelector('button') as HTMLButtonElement).click())
    expect(reconnectCloud).toHaveBeenCalledOnce()
    expect(container.querySelector('.offline-banner')?.textContent).toContain('Still cannot reach Douchat Cloud')
    await render(false)
    expect(container.querySelector('.offline-banner')?.textContent).toContain('Choose a local agent')
  })

  it('removes pasted images with Backspace at the start and previews them on click', async () => {
    await act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={directConversation} messages={[]} allMessages={[]} agents={agents} members={agents} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={async () => {}} onStop={() => {}} />))
    const textarea = container.querySelector('textarea')!
    const paste = async (name: string) => {
      // jsdom's File has no arrayBuffer(); supply the part the composer reads.
      const file = { name, type: 'image/png', size: 4, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer }
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } })
      await act(async () => { textarea.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 20)) })
    }
    await paste('first.png'); await paste('second.png')
    const names = () => [...container.querySelectorAll('.composer-image img')].map(img => img.getAttribute('alt'))
    expect(names()).toEqual(['first.png', 'second.png'])
    const copyImageData = vi.fn().mockResolvedValue(undefined)
    window.douchat = { ...window.douchat, copyImageData } as typeof window.douchat
    await act(async () => (container.querySelector('.composer-image-open') as HTMLButtonElement).click())
    const dialog = () => document.querySelector('dialog.chat-image-preview')!
    const shown = () => dialog().querySelector('.chat-image-preview-stage img')?.getAttribute('alt')
    expect(shown()).toBe('first.png')
    expect(dialog().querySelector('.chat-image-preview-count')?.textContent).toBe('1 / 2')
    await act(async () => (dialog().querySelector('.chat-image-preview-nav.is-next') as HTMLButtonElement).click())
    expect(shown()).toBe('second.png')
    await act(async () => { dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(shown()).toBe('first.png')
    const copy = [...dialog().querySelectorAll('button')].find(button => button.textContent?.includes('Copy image'))!
    await act(async () => copy.click())
    expect(copyImageData).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/))
    expect(dialog().textContent).toContain('Copied')
    await act(async () => (dialog().querySelector('.chat-image-preview-toolbar button[aria-label]') as HTMLButtonElement).click())
    expect(document.querySelector('dialog.chat-image-preview')).toBeNull()
    const backspace = async () => act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })) })
    // Text before the caret is edited normally.
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'hi'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
    textarea.setSelectionRange(2, 2)
    await backspace()
    expect(names()).toHaveLength(2)
    textarea.setSelectionRange(0, 0)
    await backspace()
    expect(names()).toEqual(['first.png'])
    await backspace()
    expect(names()).toEqual([])
  })

  it('browses and copies every image of a message in one preview', async () => {
    const images = ['a', 'b', 'c'].map(id => ({ id, kind: 'image' as const, name: `${id}.png`, mimeType: 'image/png' as const, size: 5 }))
    const copyAttachment = vi.fn().mockResolvedValue(undefined)
    window.douchat = { copyAttachment, getAttachmentData: vi.fn(async (id: string) => `data:image/png;base64,${id}`) } as unknown as typeof window.douchat
    const message = { ...incomingReply, conversationId: directConversation.id, source: undefined, attachments: images }
    await act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={directConversation} messages={[message]} allMessages={[message]} agents={agents} members={agents} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={async () => {}} onStop={() => {}} />))
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.message-image-button')[2].click())
    const dialog = () => document.querySelector('dialog.chat-image-preview')!
    expect(dialog().querySelector('.chat-image-preview-stage img')?.getAttribute('src')).toBe('data:image/png;base64,c')
    expect(dialog().querySelector('.chat-image-preview-count')?.textContent).toBe('3 / 3')
    await act(async () => (dialog().querySelector('.chat-image-preview-nav.is-next') as HTMLButtonElement).click())
    expect(dialog().querySelector('.chat-image-preview-stage img')?.getAttribute('src')).toBe('data:image/png;base64,a')
    await act(async () => { [...dialog().querySelectorAll('button')].find(button => button.textContent === 'Copy image')!.click() })
    expect(copyAttachment).toHaveBeenCalledWith('a')
    await act(async () => (dialog().querySelector('[aria-label="Close"]') as HTMLButtonElement).click())
  })

  it('keeps the latest message visible when the queue grows without pulling readers away from history', async () => {
    const messages = [{ ...incomingReply, conversationId: directConversation.id }]
    const render = async (count: number) => act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={directConversation} messages={messages} allMessages={messages} agents={agents} members={agents} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={async () => {}} onStop={() => {}}
      queuedMessages={Array.from({ length: count }, (_, id) => ({ id, conversationId: directConversation.id, text: 'Queued message' }))} />))
    await render(0)
    const scroller = container.querySelector<HTMLDivElement>('.message-scroll')!
    Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 400 } })
    scroller.scrollTop = 600
    await act(async () => scroller.dispatchEvent(new Event('scroll')))
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 300 })
    await render(2)
    expect(scroller.scrollTop).toBe(1000)
    scroller.scrollTop = 200
    await act(async () => scroller.dispatchEvent(new Event('scroll')))
    await render(3)
    expect(scroller.scrollTop).toBe(200)
  })

  it('does not re-render the transcript while typing in the composer', async () => {
    const messages = Array.from({ length: 3 }, (_, index) => ({ ...incomingReply, id: `incoming-${index}`, conversationId: directConversation.id, source: undefined }))
    await act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={directConversation} messages={messages} allMessages={messages} agents={agents} members={agents} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={async () => {}} onStop={() => {}} />))
    expect(container.querySelectorAll('.agent-bubble')).toHaveLength(3)
    const textarea = container.querySelector('textarea')!
    markdownRenders.count = 0
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(textarea.value).toBe('Hello')
    expect(markdownRenders.count).toBe(0)
  })

  it('tracks deferred message layout before paint without pulling readers away from history', async () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    let resized!: () => void
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe = observe
      disconnect = disconnect
    })
    try {
      const messages = [{ ...incomingReply, conversationId: directConversation.id }]
      await act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={directConversation} messages={messages} allMessages={messages} agents={agents} members={agents} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={async () => {}} onStop={() => {}} />))
      const scroller = container.querySelector<HTMLDivElement>('.message-scroll')!
      expect(observe).toHaveBeenCalledWith(scroller)
      expect(observe).toHaveBeenCalledWith(container.querySelector('.message-canvas'))
      Object.defineProperties(scroller, { scrollHeight: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 400 } })
      scroller.scrollTop = 600
      resized()
      expect(scroller.scrollTop).toBe(1200)
      scroller.scrollTop = 200
      await act(async () => scroller.dispatchEvent(new Event('scroll')))
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1500 })
      resized()
      expect(scroller.scrollTop).toBe(200)
      await act(async () => root.render(null))
      expect(disconnect).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps a selected duplicate-name member ID when sending visible mention text', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const same = agents.map(agent => ({ ...agent, name: 'Dr. Dou' }))
    await act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={{ ...directConversation, type: 'group' }} messages={[]} allMessages={[]} agents={same} members={same} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={send} onStop={() => {}} />))
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '@Dr')
      textarea.selectionStart = 3
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[role="option"]')[1].click())
    expect(textarea.value).toBe('@Dr. Dou ')
    await act(async () => container.querySelector<HTMLButtonElement>('.send-button')!.click())
    expect(send).toHaveBeenCalledWith('@Dr. Dou', [], [], [{ id: 'agent-2', name: 'Dr. Dou', start: 0, end: 8 }])
  })

  it('selects, removes and sends a file without requiring text', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={directConversation} messages={[]} allMessages={[]} agents={agents} members={agents} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={send} onStop={() => {}} />))
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    const bytes = new TextEncoder().encode('<svg/>')
    const file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
    const select = async () => { await act(async () => {
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }) }
    await select()
    expect(container.querySelector('.composer-file')?.textContent).toContain('logo.svg')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除文件"]')!.click())
    expect(container.querySelector('.composer-file')).toBeNull()
    await select()
    await act(async () => container.querySelector<HTMLButtonElement>('.send-button')!.click())
    expect(send).toHaveBeenCalledTimes(1)
    const [text, images, files] = send.mock.calls[0]
    expect(text).toBe('')
    expect(images).toEqual([])
    expect(files[0].name).toBe('logo.svg')
    expect(Array.from(files[0].data)).toEqual(Array.from(bytes))
    expect(container.querySelector('.composer-file')).toBeNull()
  })

  it('copies, quotes and deletes the selected message from its context menu', async () => {
    const image = { id: 'quoted-image', name: 'logo.png', mimeType: 'image/png' as const, kind: 'image' as const, size: 5 }
    const message = { ...incomingReply, conversationId: directConversation.id, source: undefined, attachments: [image] }
    const writeText = vi.fn().mockResolvedValue(undefined)
    const deleteMessage = vi.fn().mockResolvedValue(true)
    const copyAttachment = vi.fn().mockResolvedValue(undefined)
    window.douchat = { deleteMessage, copyText: writeText, copyAttachment, getAttachmentData: vi.fn().mockResolvedValue('data:image/png;base64,aGVsbG8=') } as unknown as typeof window.douchat
    const send = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={directConversation} messages={[message]} allMessages={[message]} agents={agents} members={agents} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={send} onStop={() => {}} />))
    const open = async (): Promise<void> => { await act(async () => {
      container.querySelector('.message-bubble')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }))
    }) }
    const click = async (label: string): Promise<void> => { await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent === label)!.click()
    }) }
    await act(async () => container.querySelector<HTMLButtonElement>('.message-image-button')!.click())
    expect(document.querySelector('dialog[open] img')?.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=')
    await act(async () => { Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(button => button.textContent === 'Copy image')!.click() })
    expect(copyAttachment).toHaveBeenCalledWith(image.id)
    await act(async () => document.querySelector<HTMLButtonElement>('dialog [aria-label="Close"]')!.click())
    expect(document.querySelector('dialog')).toBeNull()
    await open()
    await click('Copy')
    expect(writeText).toHaveBeenCalledWith(message.text)
    await open()
    await click('Quote')
    expect(container.querySelector('.composer-quote')?.textContent).toContain(message.text)
    expect(container.querySelector('.composer-quote img')).not.toBeNull()
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'My reply')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    vi.mocked(window.douchat.getAttachmentData).mockRejectedValueOnce(new Error('Image unavailable'))
    await act(async () => { container.querySelector<HTMLButtonElement>('.send-button')!.click() })
    expect(send).not.toHaveBeenCalled()
    expect(container.querySelector('.composer-quote')).not.toBeNull()
    expect(textarea.value).toBe('My reply')
    expect(container.querySelector('.composer-attachment-error')?.textContent).toBe('Image unavailable')
    await act(async () => { container.querySelector<HTMLButtonElement>('.send-button')!.click() })
    expect(send).toHaveBeenCalledWith(expect.stringContaining(`> ${message.text}\n\nMy reply`), [{ name: 'logo.png', mimeType: 'image/png', data: new Uint8Array([104, 101, 108, 108, 111]), quoted: true }])
    expect(container.querySelector('.composer-quote')).toBeNull()
    await open()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[role="menu"]')).toBeNull()
    deleteMessage.mockResolvedValueOnce(false)
    await open()
    await click('Delete')
    expect(container.querySelector('.message-bubble')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    deleteMessage.mockRejectedValueOnce(new Error('Database unavailable'))
    await open()
    await click('Delete')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Could not delete message')
    expect(container.querySelector('.message-bubble')).not.toBeNull()
    await open()
    await click('Delete')
    expect(deleteMessage).toHaveBeenCalledWith(message.conversationId, message.id)
    expect(container.querySelector('.message-bubble')).toBeNull()
  })

  it('shows the follow-up recipient and hides it when explicitly addressing a human', async () => {
    const conversation: Conversation = { ...directConversation, id: 'friend-follow-up', ownerId: 'alice', type: 'group',
      socialRoom: { id: 'follow-up', name: 'Group', kind: 'group', createdAt: '',
        members: [{ id: 'bob', name: 'Bob', email: '' }],
        agents: [{ id: 'agent-1', localId: 'local', ownerId: 'alice', name: '拽姐' }] } }
    const request: ChatMessage = { ...incomingReply, id: `${conversation.id}:request`, conversationId: conversation.id,
      authorId: 'user', text: '@拽姐 hello', createdAt: Date.now(), source: undefined,
      socialTasks: [{ id: 'request', agentId: 'agent-1', agentName: '拽姐', status: 'succeeded' }] }
    const reply: ChatMessage = { ...request, id: `${request.id}:reply`, authorId: 'agent-1', text: 'Hello', socialTasks: undefined }
    const messages = [request, reply]
    await act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={conversation} messages={messages} allMessages={messages} agents={agents} members={agents} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={async () => {}} onStop={() => {}} />))
    const textarea = container.querySelector('textarea')!
    expect(textarea.placeholder).toBe('Continue chatting with 拽姐')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '@Bob hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(textarea.placeholder).not.toContain('Continue chatting')
  })

  it('shows group delivery receipts without a disclosure control', async () => {
    await act(async () => root.render(<MessageDeliveries deliveries={[
      { id: 'secret', recipientId: 'agent-1', recipientName: '拽姐', content: '' }
    ]} agents={agents} />))
    expect(container.textContent).toContain('Sent private message to 拽姐')
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('.bubble-delivery-details')).toBeNull()
  })

  it.each(['alice', 'bob'])('shows the all mention only to the shared group owner (%s)', async (ownerId) => {
    const conversation: Conversation = { ...directConversation, id: 'friend-group', ownerId, type: 'group',
      socialRoom: { id: 'group', name: 'Group', kind: 'group', createdAt: '', agents: [],
        members: [{ id: 'alice', name: 'Alice', email: '' }, { id: 'bob', name: 'Bob', email: '' }] } }
    await act(async () => root.render(<ChatPane userName="You" userAvatar="" conversation={conversation} messages={[]} allMessages={[]} agents={agents} members={agents} offline={false} onConnect={() => {}} inspectorOpen={false} onToggleInspector={() => {}} onOpenAgentProfile={() => {}} onOpenUserProfile={() => {}} onSend={async () => {}} onStop={() => {}} />))
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '@')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const options = [...container.querySelectorAll('[role="option"]')].map(option => option.textContent)
    expect(options.some(label => label?.includes('Everyone'))).toBe(ownerId === 'alice')
  })

  it('renders a failed reply once when its body repeats the error', async () => {
    const error = 'The owner declined this request'
    const failed: ChatMessage = { ...incomingReply, source: undefined, text: error, error }
    await act(async () => root.render(<MessageRow messages={[failed]} agents={agents} relatedMessages={[]} userName="You" userAvatar="" showAuthor />))
    expect(container.textContent?.split(error)).toHaveLength(2)
    expect(container.querySelector('.has-error')).not.toBeNull()
    expect(container.querySelector('.bubble-error')).toBeNull()
    await act(async () => root.render(<MessageRow messages={[{ ...failed, text: 'Completed the first step.' }]} agents={agents} relatedMessages={[]} userName="You" userAvatar="" showAuthor />))
    expect(container.textContent).toContain('Completed the first step.')
    expect(container.querySelector('.bubble-error')?.textContent).toBe(error)
  })

  it('does not repeat a failed reply inside invitation details', async () => {
    const error = 'The owner declined the operation, or permission expired'
    await act(async () => root.render(<MessageDeliveries deliveries={[{
      id: 'invitation', kind: 'group-invitation', recipientId: 'agent-1', recipientName: '拽姐', content: 'Join us',
      replies: [{ id: 'reply', senderId: 'agent-1', senderName: '拽姐', content: error, error, createdAt: 1 }]
    }]} agents={agents} />))
    await act(async () => container.querySelector<HTMLButtonElement>('.bubble-deliveries')?.click())
    expect(container.textContent?.split(error)).toHaveLength(2)
  })

  it('keeps private content sealed until the delivery summary is opened', async () => {
    await act(async () => root.render(<MessageDeliveries deliveries={deliveries} agents={agents} />))

    const toggle = container.querySelector<HTMLButtonElement>('.bubble-deliveries')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.textContent).toContain('Sent private message to 拽姐, 小微')
    expect(container.textContent).not.toContain('先确认她有没有空。')
    expect(container.textContent).not.toContain('我有空，七点见。')

    await act(async () => toggle?.click())

    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('To拽姐')
    expect(container.textContent).not.toContain('Private message to')
    expect(container.textContent).toContain('拽姐')
    expect(container.textContent).toContain('先确认她有没有空。')
    expect(container.textContent).toContain('小微')
    expect(container.textContent).toContain('准备一副牌。')
    expect(container.textContent).toContain('拽姐 replied')
    expect(container.textContent).toContain('我有空，七点见。')
    expect(container.textContent).toContain('规则先说好。')
    expect(container.querySelectorAll('.bubble-delivery-reply')).toHaveLength(1)
    expect(container.querySelectorAll('.bubble-delivery-reply-author')).toHaveLength(1)
    expect(container.querySelectorAll('.bubble-delivery-reply-segment')).toHaveLength(2)
    expect(container.querySelectorAll('[data-testid="agent-avatar"]')).toHaveLength(2)
    expect(container.querySelector('[data-testid="empty-avatar"]')).toBeNull()

    await act(async () => toggle?.click())
    expect(container.textContent).not.toContain('准备一副牌。')
  })

  it('shows an incoming private source with the same compact avatar card', async () => {
    await act(async () => root.render(
      <MessageSourceCard
        source={{ kind: 'bot', id: 'agent-1', name: '拽姐', content: '今晚七点半，老地方见。' }}
        agents={agents}
      />
    ))

    const toggle = container.querySelector<HTMLButtonElement>('.bubble-deliveries')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('Received privately from 拽姐')
    expect(container.textContent).not.toContain('今晚七点半，老地方见。')

    await act(async () => toggle?.click())

    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.bubble-private-source')).not.toBeNull()
    expect(container.querySelector('[data-testid="agent-avatar"]')?.getAttribute('data-agent-name')).toBe('拽姐')
    expect(container.textContent).toContain('From拽姐')
    expect(container.textContent).not.toContain('Private message from')
    expect(container.textContent).toContain('今晚七点半，老地方见。')
  })

  it('recovers legacy private content and replies from related messages', async () => {
    await act(async () => root.render(
      <MessageSourceCard
        source={incomingReply.source!}
        agents={agents}
        receiverId="agent-1"
        receivedAt={incomingReply.createdAt}
        relatedMessages={[outbound, incomingReply]}
      />
    ))

    const toggle = container.querySelector<HTMLButtonElement>('.bubble-deliveries')
    await act(async () => toggle?.click())
    expect(container.textContent).toContain('今晚七点半，老地方见。')

    await act(async () => root.render(
      <MessageDeliveries
        deliveries={outbound.deliveries!}
        agents={agents}
        senderId="sender-1"
        sentAt={outbound.createdAt}
        relatedMessages={[outbound, incomingReply]}
      />
    ))
    const sentToggle = container.querySelector<HTMLButtonElement>('.bubble-deliveries')
    await act(async () => sentToggle?.click())
    expect(container.textContent).toContain('拽姐 replied')
    expect(container.textContent).toContain('好，我会准时到。')
  })

  it('renders one source card and one bubble for a multi-part private reply', async () => {
    const source = { kind: 'bot' as const, id: 'sender-1', name: '豆博士', content: '一起打牌吗？' }
    const replies = ['第一段回复', '第二段回复', '第三段回复'].map((text, index): ChatMessage => ({
      id: `private-reply-${index}`,
      conversationId: directConversation.id,
      topicId: 'topic-2',
      authorId: 'agent-1',
      authorName: '拽姐',
      text,
      kind: 'message',
      createdAt: 10,
      replyGroupId: 'private-reply-group',
      source
    }))

    await act(async () => root.render(
      <MessageGroupRow
        messages={replies}
        agent={agents[0]}
        agents={agents}
        relatedMessages={replies}
        userName="You"
        userAvatar=""
        showAuthor={false}
      />
    ))

    expect(container.querySelectorAll('.message-bubble')).toHaveLength(1)
    expect(container.querySelectorAll('.bubble-private-source-disclosure')).toHaveLength(1)
    expect(container.querySelectorAll('.bubble-reply-segment')).toHaveLength(3)
    expect(container.textContent).toContain('第一段回复')
    expect(container.textContent).toContain('第三段回复')
  })

  it('renders an avatar beside every ordinary bubble from one reply turn', async () => {
    const replies = ['第一条消息', '第二条消息'].map((text, index): ChatMessage => ({
      id: `ordinary-reply-${index}`,
      conversationId: directConversation.id,
      topicId: 'topic-2',
      authorId: 'agent-1',
      authorName: '拽姐',
      text,
      kind: 'message',
      createdAt: 10,
      replyGroupId: 'ordinary-reply-group'
    }))

    await act(async () => root.render(
      <MessageGroupRow
        messages={replies}
        agent={agents[0]}
        agents={agents}
        relatedMessages={replies}
        userName="You"
        userAvatar=""
        showAuthor={false}
      />
    ))

    expect(container.querySelectorAll('.message-row')).toHaveLength(2)
    expect(container.querySelectorAll('.message-bubble')).toHaveLength(2)
    expect(container.querySelectorAll('[data-testid="agent-avatar"]')).toHaveLength(2)
  })

  it('shows a plain-language receipt for a completed local-file tool action', async () => {
    await act(async () => root.render(
      <MessageActions actions={[
        { id: 'tool-1', tool: 'computer_open_file', status: 'succeeded', target: 'qin-emperor.mp4' }
      ]} />
    ))

    expect(container.querySelector('.message-action.is-succeeded')).not.toBeNull()
    expect(container.textContent).toContain('Opened qin-emperor.mp4 with the system default app')
    expect(container.textContent).not.toContain('computer_open_file')
  })

  it('collapses multiple tool attempts behind the final successful action', async () => {
    await act(async () => root.render(
      <MessageActions actions={[
        { id: 'tool-1', tool: 'computer_list_files', status: 'failed', target: 'Downloads' },
        { id: 'tool-2', tool: 'computer_list_files', status: 'succeeded', target: 'Videos' },
        { id: 'tool-3', tool: 'computer_open_file', status: 'succeeded', target: 'qin-emperor.mp4' }
      ]} />
    ))

    const toggle = container.querySelector<HTMLButtonElement>('.message-actions-toggle')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('Opened qin-emperor.mp4 with the system default app')
    expect(container.textContent).toContain('3 actions')
    expect(container.textContent).not.toContain('Could not check files in Downloads')

    await act(async () => toggle?.click())

    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Could not check files in Downloads')
    expect(container.textContent).toContain('Checked files in Videos')
  })

  it('keeps completed tool action receipts hidden from chat messages', async () => {
    const message: ChatMessage = {
      id: 'tool-receipt-hidden',
      conversationId: directConversation.id,
      topicId: 'topic-2',
      authorId: 'agent-1',
      authorName: '拽姐',
      text: '已经打开了。',
      kind: 'message',
      createdAt: 20,
      actions: [
        { id: 'tool-1', tool: 'computer_open', status: 'succeeded', target: 'douchat.ai' },
        { id: 'tool-2', tool: 'computer_open', status: 'failed' }
      ]
    }

    await act(async () => root.render(
      <MessageGroupRow
        messages={[message]}
        agent={agents[0]}
        agents={agents}
        relatedMessages={[message]}
        userName="You"
        userAvatar=""
        showAuthor={false}
      />
    ))

    expect(container.textContent).toContain('已经打开了。')
    expect(container.querySelector('.message-actions')).toBeNull()
    expect(container.textContent).not.toContain('Opened douchat.ai')
  })

  it('opens the shared agent profile from an agent message avatar', async () => {
    const openProfile = vi.fn()
    await act(async () => root.render(
      <MessageGroupRow
        messages={[incomingReply]}
        agent={agents[0]}
        agents={agents}
        relatedMessages={[incomingReply]}
        userName="You"
        userAvatar=""
        showAuthor={false}
        onOpenAgentProfile={openProfile}
      />
    ))

    const avatar = container.querySelector<HTMLButtonElement>('.message-avatar-button')
    expect(avatar?.getAttribute('aria-label')).toBe('拽姐 — view profile')
    await act(async () => avatar?.click())
    expect(openProfile).toHaveBeenCalledTimes(1)
    expect(openProfile.mock.calls[0][0]).toBe('agent-1')
    expect(openProfile.mock.calls[0][1]).toMatchObject({ left: 0, right: 0, top: 0 })
  })

  it('renders a human friend with the shared incoming bubble and their own profile', async () => {
    const openProfile = vi.fn()
    const message: ChatMessage = {
      id: 'friend-message', conversationId: 'dm', topicId: 'dm',
      authorId: 'bob', authorName: 'Bob', text: 'Hello', kind: 'message', createdAt: 20
    }
    await act(async () => root.render(<MessageRow messages={[message]} agents={[]} relatedMessages={[message]}
      person={{ id: 'bob', name: 'Bob', email: 'bob@example.com', image: 'bob.png' }}
      onOpenPersonProfile={openProfile} userName="Alice" userAvatar="" showAuthor={false} />))
    expect(container.querySelector('.agent-bubble')?.textContent).toContain('Hello')
    expect(container.querySelector('[data-user-name="Bob"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="empty-avatar"]')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.message-avatar-button')!.click())
    expect(openProfile).toHaveBeenCalledOnce()
  })

  it('opens profile editing from the user message avatar', async () => {
    const openUserProfile = vi.fn()
    const userMessage: ChatMessage = {
      id: 'user-profile-message',
      conversationId: directConversation.id,
      topicId: 'topic-2',
      authorId: 'user',
      authorName: 'You',
      text: 'Hello',
      kind: 'message',
      createdAt: 20
    }
    await act(async () => root.render(
      <MessageRow
        messages={[userMessage]}
        agents={agents}
        relatedMessages={[userMessage]}
        userName="You"
        userAvatar=""
        showAuthor={false}
        onOpenUserProfile={openUserProfile}
      />
    ))

    const avatar = container.querySelector<HTMLButtonElement>('.user-profile-avatar-button')
    expect(avatar?.getAttribute('aria-label')).toBe('You — open your profile')
    await act(async () => avatar?.click())
    expect(openUserProfile).toHaveBeenCalledOnce()
  })

  it('shows the current activity inside one reply bubble', async () => {
    const activity: ConversationActivityState = {
      conversationId: directConversation.id,
      topicId: 'topic-2',
      phase: 'replying',
      agentIds: ['agent-1'],
      label: '拽姐',
      startedAt: 1,
      action: { id: 'tool-1', tool: 'computer_list_files', status: 'running', target: 'Other' }
    }

    await act(async () => root.render(<ChatActivity activity={activity} agents={agents} />))

    expect(container.querySelectorAll('.typing-bubble')).toHaveLength(1)
    expect(container.querySelector('.typing-activity-text')?.textContent).toContain('Checking files in Other')
    expect(container.querySelector('.typing-activity-detail')).toBeNull()

    await act(async () => root.render(
      <ChatActivity
        activity={{
          ...activity,
          action: { id: 'tool-2', tool: 'computer_open_file', status: 'running', target: 'agreement.docx' }
        }}
        agents={agents}
      />
    ))

    expect(container.querySelector('.typing-activity-text')?.textContent)
      .toContain('Opening agreement.docx with the system default app')

    await act(async () => root.render(<ChatActivity activity={{ ...activity, action: undefined }} agents={agents} />))
    expect(container.querySelector('.typing-activity-text')?.textContent).toBe('Thinking about the next step')

    await act(async () => root.render(
      <ChatActivity
        activity={{ ...activity, phase: 'planning', agentIds: [], label: 'Coordinating the group', action: undefined }}
        agents={agents}
      />
    ))
    expect(container.querySelector('.system-message[role="status"]')?.textContent).toContain('Coordinating the group')
    expect(container.querySelector('.typing-row')).toBeNull()
    expect(container.querySelector('[data-testid="empty-avatar"]')).toBeNull()
    expect(container.querySelector('.typing-activity-text')?.textContent).toBe('Coordinating the group')
    await act(async () => root.render(<ChatActivity activity={{ ...activity, phase: 'planning', agentIds: [], label: 'Group scheduler', planningStage: 'health', action: undefined }} agents={agents} />))
    expect(container.querySelector('.system-message[role="status"]')).not.toBeNull()
    expect(container.querySelector('.typing-row')).toBeNull()
    expect(container.querySelector('[data-testid="empty-avatar"]')).toBeNull()
    expect(container.querySelector('.typing-activity-text')?.textContent).toBe('Checking group member availability')
    await act(async () => root.render(<ChatActivity activity={{ ...activity, phase: 'planning', agentIds: [], label: 'Decision service', serviceName: 'OpenRouter · Jev', planningStage: 'decision', action: undefined }} agents={agents} />))
    expect(container.querySelector('.system-message')?.textContent).toContain('OpenRouter · Jev')
    expect(container.querySelector('.typing-activity-text')?.textContent).toBe('Choosing a leader and reply order')
    await act(async () => root.render(<ChatActivity activity={{ ...activity, phase: 'planning', agentIds: [agents[0].id], label: 'Coordinating the group', planningStage: 'plan', action: undefined }} agents={agents} />))
    expect(container.querySelector('.typing-activity-text')?.textContent).toBe('Preparing the task plan')
    expect(container.querySelector('[data-testid="agent-avatar"]')).not.toBeNull()
    await act(async () => root.render(
      <ChatActivity activity={{ ...activity, phase: 'planning', agentIds: [agents[0].id], label: 'Coordinating the group', action: undefined }} agents={agents} />
    ))
    expect(container.querySelector('.typing-label')?.textContent).toBe(agents[0].name)
    expect(container.querySelector('[data-testid="agent-avatar"]')?.getAttribute('data-agent-name')).toBe(agents[0].name)
    expect(container.querySelector('.typing-activity-text')?.textContent).toBe('Coordinating the group')


    await act(async () => root.render(
      <ChatActivity
        activity={{
          ...activity,
          action: { id: 'tool-3', tool: 'computer_open_file', status: 'succeeded', target: 'agreement.docx' }
        }}
        agents={agents}
      />
    ))
    expect(container.querySelector('.typing-activity-text')?.textContent).toBe('Preparing the result')
  })

  it.each(['planning', 'replying'] as const)('gives simultaneous members separate %s status rows', async phase => {
    const activity: ConversationActivityState = {
      conversationId: 'group', topicId: 'topic', phase, agentIds: agents.map(agent => agent.id),
      label: 'Coordinating the group', startedAt: 1, planningStage: phase === 'planning' ? 'plan' : undefined
    }
    await act(async () => root.render(<ChatActivity activity={activity} agents={agents} />))
    const rows = container.querySelectorAll('.typing-row')
    expect(rows).toHaveLength(2)
    rows.forEach((row, index) => {
      expect(row.querySelectorAll('[data-testid="agent-avatar"]')).toHaveLength(1)
      expect(row.querySelector('[data-testid="agent-avatar"]')?.getAttribute('data-agent-name')).toBe(agents[index].name)
      expect(row.querySelector('.typing-label')?.textContent).toBe(agents[index].name)
      expect(row.querySelectorAll('.typing-bubble')).toHaveLength(1)
    })
    await act(async () => root.render(<ChatActivity activity={{ ...activity, agentIds: [agents[1].id] }} agents={agents} />))
    expect(container.querySelectorAll('.typing-row')).toHaveLength(1)
    expect(container.querySelector('.typing-label')?.textContent).toBe(agents[1].name)
  })

  it('shows local connection and stalled-progress feedback without claiming completion', async () => {
    const activity: ConversationActivityState = {
      conversationId: directConversation.id, topicId: 'topic-2', phase: 'replying',
      agentIds: ['agent-1'], label: 'Local', startedAt: 1,
      localProgress: { phase: 'connecting', elapsedSeconds: 0, silentSeconds: 0 }
    }
    await act(async () => root.render(<ChatActivity activity={activity} agents={agents} />))
    expect(container.textContent).toContain('Connecting to local agent')
    setRemoteAgents([{ id: 'remote-codex', name: 'sg-codex', kind: 'custom', remote: { transport: 'ssh', host: 'build-sg', adapter: 'codex', executable: 'codex', args: [] } } as never])
    const remoteAgents = agents.map((agent, index) => index === 0 ? { ...agent, localAgentId: 'remote-codex' } : agent)
    await act(async () => root.render(<ChatActivity activity={activity} agents={remoteAgents} />))
    expect(container.textContent).toContain('Connecting to remote agent on build-sg')
    expect(container.textContent).not.toContain('local agent')
    await act(async () => root.render(<ChatActivity activity={{ ...activity, localProgress: { phase: 'working', elapsedSeconds: 5, silentSeconds: 0 } }} agents={remoteAgents} />))
    expect(container.textContent).toContain('Remote agent is running')
    setRemoteAgents([])
    await act(async () => root.render(<ChatActivity activity={{ ...activity, localProgress: {
      phase: 'waiting', elapsedSeconds: 185, silentSeconds: 70, detail: 'Checking results'
    } }} agents={agents} />))
    expect(container.textContent).toContain('Waiting for new progress from local agent')
    expect(container.textContent).toContain('3:05')
    expect(container.textContent).toContain('Checking results')
    await act(async () => root.render(<ChatActivity activity={{ ...activity, localProgress: { phase: 'approval', elapsedSeconds: 200, silentSeconds: 80 } }} agents={agents} />))
    expect(container.textContent).toContain('Waiting for your approval; review the permission dialog')
    expect(container.textContent).not.toContain('Local agent is running')
  })
  it('keeps an attributed loading indicator for an image tool and displays elapsed time, not a percentage', async () => {
    const activity: ConversationActivityState = {
      conversationId: directConversation.id, topicId: 'topic-2', phase: 'replying',
      agentIds: ['agent-1'], label: 'Grok', startedAt: 1,
      localProgress: { phase: 'working', elapsedSeconds: 42, silentSeconds: 20, detail: 'Generating an image; waiting for the tool result' }
    }
    await act(async () => root.render(<ChatActivity activity={activity} agents={agents} />))
    expect(container.querySelector('[data-testid="agent-avatar"]')).not.toBeNull()
    expect(container.querySelector('.reply-status-dots')).not.toBeNull()
    expect(container.textContent).toContain('Generating an image; waiting for the tool result')
    expect(container.textContent).toContain('0:42')
    expect(container.textContent).not.toContain('%')
    await act(async () => root.render(<ChatActivity activity={{ ...activity, localProgress: {
      phase: 'working', elapsedSeconds: 45, silentSeconds: 0, detail: 'Attaching generated images'
    } }} agents={agents} />))
    expect(container.textContent).toContain('Attaching generated images')
    expect(container.textContent).not.toContain('Generating an image;')
  })
  it('shows the specific problem immediately while keeping raw detail folded', async () => {
    const onOpenCredits = vi.fn()
    const detail = '429: {"message":"Douchat credit balance is insufficient"}'
    const message: ChatMessage = {
      id: 'error-1',
      conversationId: directConversation.id,
      topicId: 'topic-2',
      authorId: 'system',
      authorName: 'Douchat',
      text: 'The provider is rate limiting this key · HTTP 429',
      detail,
      kind: 'system',
      createdAt: 30
    }

    await act(async () => root.render(<SystemMessage message={message} onOpenCredits={onOpenCredits} />))

    const toggle = container.querySelector<HTMLButtonElement>('.system-toggle')
    expect(container.textContent).toContain('Douchat does not have enough credits')
    expect(container.textContent).toContain('Top up credits to continue.')
    expect(container.textContent).not.toContain('credit balance')

    const topUp = container.querySelector<HTMLButtonElement>('.system-inline-action')
    expect(topUp?.parentElement?.classList.contains('system-guidance')).toBe(true)
    expect(topUp?.querySelector('svg')).toBeNull()
    await act(async () => topUp?.click())
    expect(onOpenCredits).toHaveBeenCalledOnce()

    await act(async () => toggle?.click())

    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain(detail)
  })

  it('renders scheduling notice metadata instead of its previously stored language', async () => {
    const message: ChatMessage = {
      id: 'schedule-translation', conversationId: directConversation.id, topicId: 'topic-2',
      authorId: 'system', authorName: 'Douchat', kind: 'system', createdAt: 31,
      text: '本轮已结束：3 人已回复。',
      localization: { key: 'Round complete: {count} replied.', values: { count: 3 } }
    }
    await act(async () => root.render(<SystemMessage message={message} />))
    expect(container.textContent).toBe('Round complete: 3 replied.')
    expect(container.querySelector('.is-error')).toBeNull()
  })

  it('renders the context reset boundary using the centered system notice', async () => {
    const message: ChatMessage = {
      id: 'context-reset:test', conversationId: directConversation.id, topicId: 'topic-2',
      authorId: 'system', authorName: 'Douchat', kind: 'system', createdAt: 31, text: 'Context reset'
    }
    await act(async () => root.render(<SystemMessage message={message} />))
    expect(container.querySelector('.system-message')?.textContent).toBe('Context reset')
    expect(container.querySelector('.is-error')).toBeNull()
  })

  it('shows a next step for a local Claude startup failure', async () => {
    const message: ChatMessage = {
      id: 'error-2', conversationId: directConversation.id, topicId: 'topic-2',
      authorId: 'system', authorName: 'Douchat', text: 'Claude Code: Exited with status 1',
      detail: 'Run ID: run-1\nCause:\nClaude Code: Exited with status 1', kind: 'system', createdAt: 31
    }
    await act(async () => root.render(<SystemMessage message={message} />))
    expect(container.textContent).toContain('Claude Code could not start')
    expect(container.textContent).toContain('Open Claude Code in Terminal once')
    expect(container.textContent).not.toContain('Run ID: run-1')
  })

  it('offers a Grok update without expanding raw sandbox diagnostics', async () => {
    const maintainLocalAgent = vi.fn(async () => true)
    Object.defineProperty(window, 'douchat', { configurable: true, value: { maintainLocalAgent } })
    const message: ChatMessage = {
      id: 'grok-error', conversationId: directConversation.id, topicId: 'topic-2',
      authorId: 'system', authorName: 'Douchat', text: 'could not apply strict sandbox',
      detail: 'Grok Build: sandbox could not be applied: socket deny resolution failed: /var/run/docker.sock: endpoint is a symlink',
      kind: 'system', createdAt: 31
    }
    await act(async () => root.render(<SystemMessage message={message} />))
    expect(container.textContent).toContain('Grok cannot start with the current Docker socket setup')
    expect(container.querySelector('pre')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.system-inline-action')?.click())
    expect(maintainLocalAgent).toHaveBeenCalledWith('grok')
  })

  it('shows a next step when a local Claude account is out of credit', async () => {
    const openLocalAgentTerminal = vi.fn(async () => ({ terminal: 'termany' as const }))
    Object.defineProperty(window, 'douchat', {
      configurable: true,
      value: { openLocalAgentTerminal }
    })
    const message: ChatMessage = {
      id: 'error-3', conversationId: directConversation.id, topicId: 'topic-2',
      authorId: 'system', authorName: 'Douchat', text: 'Claude Code: Credit balance is too low',
      detail: 'Run ID: run-2\nCause:\nClaude Code: Credit balance is too low', kind: 'system', createdAt: 32
    }
    await act(async () => root.render(<SystemMessage message={message} />))
    expect(container.textContent).toContain('Claude Code does not have enough credit')
    expect(container.textContent).toContain('add credit or switch to an account with available usage')
    expect(container.textContent).not.toContain('Run ID: run-2')

    await act(async () => container.querySelector<HTMLButtonElement>('.system-toggle')?.click())
    const action = [...container.querySelectorAll<HTMLButtonElement>('.system-recovery-action')]
      .find((button) => button.textContent?.includes('Open Claude Code'))
    expect(action).toBeTruthy()
    await act(async () => action?.click())
    expect(openLocalAgentTerminal).toHaveBeenCalledWith('claude')
  })

  it('unlocks a stuck Claude terminal action after six seconds', async () => {
    vi.useFakeTimers()
    try {
      const openLocalAgentTerminal = vi.fn(() => new Promise<{ terminal: 'termany' | 'system' }>(() => undefined))
      Object.defineProperty(window, 'douchat', {
        configurable: true,
        value: { openLocalAgentTerminal }
      })
      const message: ChatMessage = {
        id: 'error-4', conversationId: directConversation.id, topicId: 'topic-2',
        authorId: 'system', authorName: 'Douchat', text: 'Claude Code: Credit balance is too low',
        detail: 'Cause:\nClaude Code: Credit balance is too low', kind: 'system', createdAt: 33
      }
      await act(async () => root.render(<SystemMessage message={message} />))
      await act(async () => container.querySelector<HTMLButtonElement>('.system-toggle')?.click())
      const action = container.querySelector<HTMLButtonElement>('.system-recovery-action')

      await act(async () => action?.click())
      expect(action?.disabled).toBe(true)
      expect(action?.textContent).toContain('Opening')

      await act(async () => vi.advanceTimersByTimeAsync(6_100))

      expect(action?.disabled).toBe(false)
      expect(action?.textContent).toContain('Open Claude Code')
      expect(container.textContent).toContain('Opening Claude Code timed out')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('direct-chat transcript visibility', () => {
  it('hides legacy handoffs and standalone replies from delegated agents', () => {
    const user: ChatMessage = {
      id: 'user-1', conversationId: directConversation.id, topicId: 'topic-2', authorId: 'user',
      authorName: 'You', text: 'Ask for help.', kind: 'message', createdAt: 1
    }
    const handoff: ChatMessage = {
      id: 'handoff-1', conversationId: directConversation.id, topicId: 'topic-2', authorId: 'agent-1',
      authorName: '拽姐', text: '拽姐 → 豆博士 · Help', kind: 'handoff', createdAt: 2
    }
    const leakedReply: ChatMessage = {
      id: 'leaked-1', conversationId: directConversation.id, topicId: 'topic-2', authorId: 'agent-2',
      authorName: '豆博士', text: 'Internal answer.', kind: 'message', createdAt: 3
    }

    expect(visibleConversationMessages(
      directConversation,
      [user, handoff, leakedReply, incomingReply]
    ).map((message) => message.id)).toEqual(['user-1', 'incoming-1'])
  })

  it('groups contiguous private-reply segments produced by the same turn', () => {
    const source = { kind: 'bot' as const, id: 'sender-1', name: '豆博士', content: '一起打牌吗？' }
    const replies = ['第一段回复', '第二段回复', '第三段回复'].map((text, index): ChatMessage => ({
      id: `reply-${index}`,
      conversationId: directConversation.id,
      topicId: 'topic-2',
      authorId: 'agent-1',
      authorName: '拽姐',
      text,
      kind: 'message',
      createdAt: 10,
      replyGroupId: 'reply-group-1',
      source
    }))

    expect(groupConversationMessages(replies)).toEqual([replies])
  })

  it('keeps ordinary bubbles from the same reply turn as separate avatar rows', () => {
    const replies = ['第一条消息', '第二条消息'].map((text, index): ChatMessage => ({
      id: `ordinary-${index}`,
      conversationId: directConversation.id,
      topicId: 'topic-2',
      authorId: 'agent-1',
      authorName: '拽姐',
      text,
      kind: 'message',
      createdAt: 10,
      replyGroupId: 'reply-group-1'
    }))

    expect(groupConversationMessages(replies)).toEqual(replies.map((message) => [message]))
  })

  it('groups delivery replies from the same recipient turn', () => {
    const replies = deliveries[0].replies!
    expect(groupDeliveryReplies(replies)).toEqual([replies])
  })
})

it('labels successful and failed skill reads with their actual relative file paths', async () => {
  const { messageActionLabel } = await import('./ChatPane')
  expect(messageActionLabel({ id: 'skill', tool: 'read_skill_file', status: 'succeeded', target: 'references/value.md' })).toBe('Read skill file references/value.md')
  expect(messageActionLabel({ id: 'skill', tool: 'read_skill_file', status: 'failed', target: 'references/value.md' })).toBe('Could not read skill file references/value.md')
})
