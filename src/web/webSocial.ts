import type { SelectedMention } from '../shared/bot/mentions'
import { addressesEveryone } from '../shared/bot/mentions'
import type { SocialAction, SocialMessage, SocialMessageImage, SocialResult, SocialRoom, SocialSnapshot } from '../shared/social'
import { overlapCursor } from '../shared/social'
import { socialFollowUpTarget } from '../shared/socialFollowUp'
import { checkHumanAgentTargets, privacySafeSocialSnapshot, rendererSocialSnapshot, sharedGroupReplyTargets } from '../shared/socialRules'
import type { ChatMessage, Conversation, MessageAttachment } from '../shared/types'

/**
 * Friends' chats and shared groups in the web app. They already live on the
 * Douchat service (they are not part of account sync), so the web app reads
 * them the way a desktop does: the room list, then each room's messages, and
 * sends through the same `send` action. Agents in a group still answer from
 * their owners' desktops.
 */

type Service = <T>(path: string, init?: RequestInit) => Promise<T>
const POLL_MS = 3000
const TOPIC_ID = 'main'
const READ_KEY = 'douchat.web.socialRead'
const SEEN_KEY = 'douchat.web.socialSeen'
const PREFS_KEY = 'douchat.web.socialPrefs'
/** Inbox choices for service rooms; a desktop keeps its own, as it does today. */
export type RoomPrefs = Partial<Pick<Conversation, 'pinned' | 'muted' | 'hidden' | 'savedToContacts'>>
const stored = <T>(key: string): T => { try { return JSON.parse(localStorage.getItem(key) ?? '{}') as T } catch { return {} as T } }

interface RoomState { revision?: string; messages: Map<string, SocialMessage>; loaded: boolean; cursor: { time: string; id: string } }

export class WebSocial {
  private snapshot?: SocialSnapshot
  private readonly rooms = new Map<string, RoomState>()
  private readonly roomSyncs = new Map<string, Promise<boolean>>()
  /** Messages sent here, shown until the service confirms them. */
  private readonly sending = new Map<string, ChatMessage>()
  private readonly attachments = new Map<string, string>()
  /** Images the service sent by reference, fetched the first time they are shown. */
  private readonly imageRefs = new Map<string, { roomId: string; ref: string }>()
  private readonly loadingImages = new Map<string, Promise<string>>()
  private readRooms = stored<Record<string, number>>(READ_KEY)
  private prefs = stored<Record<string, RoomPrefs>>(PREFS_KEY)
  /** When this browser first saw each room, for rooms no client has read yet. */
  private seenRooms = stored<Record<string, number>>(SEEN_KEY)
  /** Read marks shared with the desktop through account sync (see RoomReadMark). */
  sharedReads?: { get: (roomId: string) => number | undefined; mark: (roomId: string, readAt: number) => void }
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(private readonly service: Service, private readonly ownerId: () => string | undefined, private readonly onChange: () => void) {}

  start(): void {
    document.addEventListener('visibilitychange', this.onVisible)
    void this.poll()
  }
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    document.removeEventListener('visibilitychange', this.onVisible)
  }
  /** Catch up as soon as a hidden tab is shown again. */
  private readonly onVisible = () => {
    if (document.hidden || this.stopped) return
    clearTimeout(this.timer)
    void this.poll()
  }

  getSnapshot(): SocialSnapshot { return this.snapshot ?? { userId: this.ownerId() ?? '', friendships: [], rooms: [] } }
  attachmentData(id: string): string | Promise<string> | undefined {
    const data = this.attachments.get(id)
    if (data) return data
    const image = this.imageRefs.get(id)
    if (!image) return undefined
    let loading = this.loadingImages.get(id)
    if (!loading) {
      loading = this.action({ action: 'attachment', roomId: image.roomId, ref: image.ref })
        .then((result) => {
          const attachment = (result as { attachment?: { mimeType?: string; base64?: string } }).attachment
          if (!attachment?.base64) throw new Error('This image is no longer available.')
          const url = `data:${attachment.mimeType};base64,${attachment.base64}`
          this.attachments.set(id, url)
          return url
        })
        .finally(() => this.loadingImages.delete(id))
      this.loadingImages.set(id, loading)
    }
    return loading
  }
  roomOf(conversationId: string): SocialRoom | undefined {
    return this.snapshot?.rooms.find((room) => conversationIdFor(this.ownerId() ?? '', room) === conversationId)
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    // A tab left open in the background must not keep downloading.
    if (!document.hidden) try { await this.refresh() } catch { /* Next poll retries. */ }
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), POLL_MS)
  }

  async refresh(): Promise<void> {
    const snapshot = rendererSocialSnapshot(privacySafeSocialSnapshot(await this.service<SocialSnapshot>('/api/desktop-auth/social')))
    if (snapshot.userId !== this.ownerId()) return
    this.snapshot = snapshot
    this.onChange()
    await Promise.all(snapshot.rooms.map(async (room) => {
      if (await this.syncRoom(room).catch(() => false)) this.onChange()
    }))
  }

  /**
   * Load a room's recent history once; after that, fetch only messages newer
   * than the last one seen plus replies still in progress, never whole pages
   * again. Images come as refs and are fetched once, when shown.
   */
  private syncRoom(room: SocialRoom, force = false): Promise<boolean> {
    const previous = this.roomSyncs.get(room.id) ?? Promise.resolve(false)
    const current = previous.catch(() => false).then(() => this.fetchRoom(room, force)).finally(() => {
      if (this.roomSyncs.get(room.id) === current) this.roomSyncs.delete(room.id)
    })
    this.roomSyncs.set(room.id, current)
    return current
  }

  private async fetchRoom(room: SocialRoom, force: boolean): Promise<boolean> {
    const state: RoomState = this.rooms.get(room.id) ?? { messages: new Map(), loaded: false, cursor: { time: '1970-01-01T00:00:00.000Z', id: '' } }
    this.rooms.set(room.id, state)
    if (!force && state.loaded && room.revision && state.revision === room.revision) return false
    const revision = room.revision
    if (!state.loaded) {
      let before: string | undefined
      for (let pages = 0; pages < 10; pages++) {
        const page = await this.action({ action: 'messages', roomId: room.id, attachments: 'ref', ...(before ? { before } : {}) })
        const batch = page.messages ?? []
        this.take(room, state, batch)
        if (!page.hasMore || !batch.length) break
        before = batch[0].id
      }
    } else {
      let after = overlapCursor(state.cursor)
      let pending = [...state.messages.values()].filter((message) => message.status === 'pending' || message.status === 'running').map((message) => message.id).slice(-200)
      for (let pages = 0; pages < 10; pages++) {
        const page = await this.action({ action: 'messages', roomId: room.id, after, pending, attachments: 'ref' })
        const batch = page.messages ?? []
        this.take(room, state, [...batch, ...(page.updates ?? [])])
        const last = batch.at(-1)
        if (!page.hasMore || !last) break
        after = { time: last.createdAt, id: last.id }
        pending = []
      }
    }
    state.loaded = true
    if (!force) state.revision = revision
    return true
  }

  private take(room: SocialRoom, state: RoomState, messages: SocialMessage[]): void {
    for (const message of messages) {
      state.messages.set(message.id, message)
      this.sending.delete(`${conversationIdFor(this.ownerId() ?? '', room)}:${message.id}`)
      if (message.createdAt > state.cursor.time || (message.createdAt === state.cursor.time && message.id > state.cursor.id)) state.cursor = { time: message.createdAt, id: message.id }
    }
  }

  action(input: SocialAction | Record<string, unknown>): Promise<SocialResult> {
    return this.service<SocialResult>('/api/desktop-auth/social', { method: 'POST', body: JSON.stringify(input) })
  }

  /** The service rooms as inbox conversations and their messages, shaped like a desktop's copy. */
  view(): { conversations: Conversation[]; messages: ChatMessage[] } {
    const ownerId = this.ownerId()
    if (!ownerId || !this.snapshot) return { conversations: [], messages: [] }
    const conversations: Conversation[] = []
    const messages: ChatMessage[] = []
    for (const room of this.snapshot.rooms) {
      if (room.kind === 'agent' || !room.members.some((member) => member.id === ownerId)) continue
      const id = conversationIdFor(ownerId, room)
      const person = room.members.find((member) => member.id !== ownerId)
      if (room.kind === 'direct' && !person) continue
      const createdAt = Date.parse(room.createdAt)
      const own: ChatMessage[] = []
      const roomMessages = [...(this.rooms.get(room.id)?.messages.values() ?? [])]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(Boolean(a.parentMessageId)) - Number(Boolean(b.parentMessageId)) || a.id.localeCompare(b.id))
      const byId = new Map<string, ChatMessage>()
      for (const message of roomMessages) {
        const messageId = `${id}:${message.id}`
        const at = Date.parse(message.createdAt)
        if (!message.parentMessageId && !byId.has(messageId)) {
          const chat: ChatMessage = {
            id: messageId, conversationId: id, topicId: TOPIC_ID, authorId: message.authorId === ownerId ? 'user' : message.authorId,
            authorName: message.authorName, text: message.content, kind: 'message', createdAt: at,
            ...this.images(room.id, messageId, message.images)
          }
          byId.set(messageId, chat)
          own.push(chat)
        }
        if (message.agentId) {
          const parent = byId.get(`${id}:${message.parentMessageId || message.id}`)
          if (parent) parent.socialTasks = [...(parent.socialTasks ?? []).filter((task) => task.id !== message.id), { id: message.id, agentId: message.agentId, agentName: message.agentName || '', status: message.status }]
        }
        if (message.reply || message.replyImages?.length) {
          own.push({
            id: `${messageId}:reply`, conversationId: id, topicId: TOPIC_ID, authorId: message.agentId ?? 'system', authorName: message.agentName || '',
            text: message.reply ?? '', kind: 'message', createdAt: at, ...this.images(room.id, `${messageId}:reply`, message.replyImages),
            ...(message.status === 'failed' ? { error: message.reply } : {})
          })
        }
      }
      for (const pending of this.sending.values()) if (pending.conversationId === id) own.push(pending)
      const updatedAt = Math.max(createdAt, ...own.map((message) => message.createdAt))
      const readAt = this.readAt(room.id)
      conversations.push({
        id, ownerId, type: room.kind, name: room.kind === 'direct' ? person!.name : room.name, remoteRoomId: room.id,
        ...(room.kind === 'direct' ? { person } : { socialRoom: room }),
        agentIds: room.kind === 'group' ? room.agents.map((agent) => agent.id) : [],
        ...this.prefs[room.id],
        topics: [{ id: TOPIC_ID, title: '', createdAt, updatedAt }], activeTopicId: TOPIC_ID,
        unread: own.filter((message) => message.authorId !== 'user' && message.createdAt > readAt).length, readAt, createdAt, updatedAt
      })
      messages.push(...own)
    }
    return { conversations, messages }
  }

  private images(roomId: string, id: string, images?: SocialMessageImage[]): { attachments?: MessageAttachment[] } {
    if (!images?.length) return {}
    return {
      attachments: images.map((image, index) => {
        const attachmentId = `${id}:image:${index}`
        if (image.base64 === undefined) this.imageRefs.set(attachmentId, { roomId, ref: image.ref })
        else this.attachments.set(attachmentId, `data:${image.mimeType};base64,${image.base64}`)
        const size = image.base64 === undefined ? image.size : Math.floor(image.base64.length * 3 / 4)
        return { id: attachmentId, kind: 'image', name: image.name, mimeType: image.mimeType, size }
      })
    }
  }

  /**
   * How far a room has been read: the later of the synced mark (shared with the
   * desktop) and this browser's own. A room no client ever marked counts as read
   * up to when this browser first saw it, so signing in to the web app does not
   * turn a room's whole history unread.
   */
  private readAt(roomId: string): number {
    const marks = [this.sharedReads?.get(roomId), this.readRooms[roomId]].filter((value): value is number => typeof value === 'number')
    if (marks.length) return Math.max(...marks)
    if (this.seenRooms[roomId] === undefined) {
      this.seenRooms[roomId] = Date.now()
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(this.seenRooms)) } catch { /* This tab only. */ }
    }
    return this.seenRooms[roomId]
  }

  markRead(conversationId: string): void {
    const room = this.roomOf(conversationId)
    if (!room) return
    const now = Date.now()
    this.readRooms[room.id] = now
    try { localStorage.setItem(READ_KEY, JSON.stringify(this.readRooms)) } catch { /* This tab only. */ }
    this.sharedReads?.mark(room.id, now)
    this.onChange()
  }

  setPrefs(conversationId: string, prefs: RoomPrefs): void {
    const room = this.roomOf(conversationId)
    if (!room) throw new Error('Chat not found')
    this.prefs[room.id] = { ...this.prefs[room.id], ...prefs }
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)) } catch { /* This tab only. */ }
    this.onChange()
  }

  /** Send text to a friend or group, addressing agents the way the desktop does. */
  async send(conversationId: string, content: string, history: ChatMessage[], mentions?: SelectedMention[]): Promise<void> {
    const ownerId = this.ownerId()
    const room = this.roomOf(conversationId)
    if (!ownerId || !room) throw new Error('Chat not found')
    const explicit = room.kind !== 'group' && addressesEveryone(content) ? [] : sharedGroupReplyTargets(content, room.agents, room.members, ownerId, mentions)
    const conversation = this.view().conversations.find((item) => item.id === conversationId)
    const followUp = explicit.length ? undefined : socialFollowUpTarget(conversation, history, content)
    const agentIds = explicit.length ? explicit : followUp ? [followUp.id] : []
    checkHumanAgentTargets(agentIds, room.agents, ownerId)
    const id = crypto.randomUUID()
    const socialTasks = agentIds.map((agentId) => ({
      id: `${id}:local:${agentId}`, agentId, agentName: room.agents.find((agent) => agent.id === agentId)?.name ?? '', status: 'pending' as const
    }))
    const local: ChatMessage = {
      id: `${conversationId}:${id}`, conversationId, topicId: TOPIC_ID, authorId: 'user', authorName: 'You',
      text: content, kind: 'message', createdAt: Date.now(), deliveryState: 'sending',
      ...(socialTasks.length ? { socialTasks } : {})
    }
    this.sending.set(local.id, local)
    this.onChange()
    try {
      await this.action({ action: 'send', roomId: room.id, id, content, agentId: agentIds[0], agentIds } as Record<string, unknown>)
      if (this.sending.has(local.id)) {
        this.sending.set(local.id, { ...local, deliveryState: agentIds.length ? 'confirming' : undefined })
        this.onChange()
      }
    } catch (error) {
      if (this.sending.has(local.id)) {
        this.sending.set(local.id, { ...local, deliveryState: 'failed', socialTasks: undefined })
        this.onChange()
      }
      throw error
    }
    // Fetch this chat immediately. An unrelated room's history must not delay
    // the handoff from the local bubble to the server's task state.
    void this.syncRoom(room, true).then(() => this.onChange()).catch(() => undefined)
  }
}

/** The same local id a desktop gives the room, so links work across clients. */
export function conversationIdFor(ownerId: string, room: SocialRoom): string {
  return `${room.kind === 'direct' ? 'friend' : 'shared'}:${ownerId}:${room.id}`
}
