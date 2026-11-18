import { expect, it, vi } from 'vitest'
import type { SocialMessage, SocialRoom } from '../shared/social'
import { conversationIdFor, WebSocial } from './webSocial'

const room: SocialRoom = { id: 'team', kind: 'group', name: 'Team', agents: [], createdAt: '2026-10-01T00:00:00.000Z', revision: 'r1',
  members: [{ id: 'me', name: 'Me', email: 'me@example.com' }, { id: 'ann', name: 'Ann', email: 'ann@example.com' }] }
const message = (id: string, createdAt: string): SocialMessage => ({ id, roomId: room.id, authorId: 'ann', authorName: 'Ann', content: id, status: 'sent', createdAt,
  images: [{ name: 'a.png', mimeType: 'image/png', size: 8, ref: `${id}|image|0` }] })

it('loads a room once, then fetches only newer messages and each image once', async () => {
  const messages = [message('one', '2026-10-01T00:00:01.000Z')]
  const calls: Record<string, unknown>[] = []
  const service = async <T,>(_path: string, init?: RequestInit): Promise<T> => {
    if (!init?.body) return { userId: 'me', friendships: [], rooms: [room] } as T
    const body = JSON.parse(String(init.body))
    calls.push(body)
    if (body.action === 'attachment') return { attachment: { mimeType: 'image/png', base64: 'iVBORw0KGgo=' } } as T
    const after = body.after as { time: string } | undefined
    return { messages: messages.filter((item) => !after || item.createdAt > after.time), updates: [], hasMore: false } as T
  }
  const social = new WebSocial(service, () => 'me', () => {})
  await social.refresh()
  messages.push(message('two', '2026-10-01T00:01:00.000Z'))
  room.revision = 'r2'
  await social.refresh()

  const pages = calls.filter((body) => body.action === 'messages')
  expect(pages).toHaveLength(2)
  expect(pages.every((body) => body.attachments === 'ref')).toBe(true)
  expect(pages[0].after).toBeUndefined()
  // Newer than the last message seen, with the usual 5 s overlap.
  expect(pages[1].after).toEqual({ time: '2026-09-30T23:59:56.000Z', id: '' })

  const view = social.view()
  expect(view.messages.map((item) => item.text)).toEqual(['one', 'two'])
  const id = view.messages[0].attachments![0].id
  expect(await social.attachmentData(id)).toBe('data:image/png;base64,iVBORw0KGgo=')
  expect(await social.attachmentData(id)).toBe('data:image/png;base64,iVBORw0KGgo=')
  expect(calls.filter((body) => body.action === 'attachment')).toHaveLength(1)
})

it('shows a shared message and selected agent before the send response, then reconciles the task', async () => {
  const agent = { id: 'helper', localId: 'helper', ownerId: 'me', name: 'Helper' }
  const group = { ...room, agents: [agent] }
  let finishSend!: () => void
  const receipt = new Promise<void>((resolve) => { finishSend = resolve })
  let saved: SocialMessage | undefined
  const service = async <T,>(_path: string, init?: RequestInit): Promise<T> => {
    if (!init?.body) return { userId: 'me', friendships: [], rooms: [group] } as T
    const body = JSON.parse(String(init.body))
    if (body.action === 'send') {
      await receipt
      saved = {
        id: body.id, roomId: group.id, authorId: 'me', authorName: 'Me', content: body.content,
        status: 'running', agentId: agent.id, agentName: agent.name, createdAt: new Date().toISOString()
      }
      return {} as T
    }
    return { messages: saved ? [saved] : [] } as T
  }
  const social = new WebSocial(service, () => 'me', () => {})
  await social.refresh()
  const sending = social.send(conversationIdFor('me', group), '@Helper hello', [])
  const [pending] = social.view().messages
  expect(pending).toMatchObject({
    text: '@Helper hello', authorId: 'user', deliveryState: 'sending',
    socialTasks: [{ agentId: agent.id, agentName: agent.name, status: 'pending' }]
  })

  finishSend()
  await sending
  await vi.waitFor(() => {
    const messages = social.view().messages
    expect(messages).toMatchObject([{
      id: pending.id, socialTasks: [{ id: saved?.id, agentId: agent.id, status: 'running' }]
    }])
    expect(messages[0].deliveryState).toBeUndefined()
  })
})
