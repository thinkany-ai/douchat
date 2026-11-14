import type { SelectedMention } from '../shared/bot/mentions'
import { decodeSocialFiles, exportSocialFiles } from './socialFiles'
import { agentPermissions } from '../shared/agentPermissions'
import { addressesEveryone, resolveMentionedMembers } from '../shared/bot/mentions'
import { socialFollowUpTarget } from '../shared/socialFollowUp'
import type { AgentConfig, MessageAttachment, MessageImageInput, MessageFileInput } from '../shared/types'
import { randomUUID } from 'node:crypto'
import type { DesktopAuth } from './desktopAuth'
import type { DouchatStore } from './store'
import type { DouchatRuntime } from './runtime'
import type { SocialAction, SocialAgent, SocialResult, SocialSnapshot, SocialTask, SocialMessage, SocialImage, SocialFile } from '../shared/social'

interface InboxDelivery {
  snapshot: SocialSnapshot
  pages: Record<string, SocialResult & { after: { time: string; id: string }; pending: string[] }>
}
const overlapCursor = (cursor: { time: string; id: string }) => ({ time: new Date(Math.max(0, Date.parse(cursor.time) - 5000)).toISOString(), id: '' })

/**
 * Keep private contact data out of renderer state unless the signed-in user is
 * allowed to see it. The service remains the primary privacy boundary; this is
 * a second boundary for older service responses and cached room membership.
 */
export function privacySafeSocialSnapshot(snapshot: SocialSnapshot): SocialSnapshot {
  const emailVisibleTo = new Set([
    snapshot.userId,
    ...snapshot.friendships.filter((friendship) => friendship.status === 'accepted').map((friendship) => friendship.person.id)
  ])
  const protectPerson = (person: SocialSnapshot['rooms'][number]['members'][number]) =>
    emailVisibleTo.has(person.id) || !person.email ? person : { ...person, email: '' }

  return {
    ...snapshot,
    friendships: snapshot.friendships.map((friendship) => ({ ...friendship, person: protectPerson(friendship.person) })),
    rooms: snapshot.rooms.map((room) => ({ ...room, members: room.members.map(protectPerson) }))
  }
}

export function sharedGroupReplyTargets(content: string, agents: SocialAgent[], humans: { id: string; name: string }[] = [], requesterId?: string, selections?: SelectedMention[]): string[] {
  if (addressesEveryone(content)) {
    if (!requesterId || humans[0]?.id !== requesterId) throw new Error('Only the group owner can mention everyone.')
    return agents.filter(agent => agent.ownerId === requesterId || agent.interactionHumans === 'allow' || agent.interactionHumans === 'ask').map(agent => agent.id)
  }
  // Explicit mentions take priority over any eligible follow-up recipient.
  const members = [...humans, ...agents]
  const addressed = resolveMentionedMembers(content, members, selections)
  return addressed.filter(member => agents.some(agent => agent.id === member.id)).map(member => member.id)
}

function sharedAgentProfile(agent: AgentConfig) {
  const permissions = agentPermissions(agent.permissions)
  return { interactionHumans: permissions.groupHumans, interactionAgents: permissions.groupAgents, name: agent.name, avatar: agent.avatar ?? '', avatarEmoji: agent.avatarEmoji ?? '',
    avatarSeed: agent.avatarSeed ?? '', color: agent.color, localAgentId: agent.localAgentId ?? '',
    systemRole: agent.systemRole ?? '' }
}

function checkHumanAgentTargets(ids: string[], agents: SocialAgent[], requesterId: string): void {
  for (const id of ids) {
    const agent = agents.find(member => member.id === id)
    if (!agent) throw new Error('The selected agent is no longer a member of this group.')
    if (agent.ownerId === requesterId) continue
    if (agent.interactionHumans === 'deny') throw new Error(`The owner of "${agent.name}" has disabled requests from group members.`)
    if (!agent.interactionHumans) throw new Error(`Permissions for "${agent.name}" have not synchronized. Ask the owner to reconnect.`)
    // `ask` is not consent: the executing owner's runtime still requests approval.
  }
}

/** Tokens and execution claims never cross the preload boundary. */
export class SocialClient {
  private timer?: ReturnType<typeof setTimeout>
  private abort?: AbortController
  private generation = 0
  private inboxTimer?: ReturnType<typeof setTimeout>
  private syncing?: Promise<SocialSnapshot>
  private roomSync = new Map<string, { revision?: string; cursor: { time: string; id: string }; pending: Set<string>; checkedAt: number; auditedAt: number }>()
  private pendingSends = new Map<string, { content: string; signature: string; id: string; agentIds: string[] }>()
  constructor(private url: string, private auth: DesktopAuth, private store: DouchatStore, private runtime: DouchatRuntime, private onInboxChanged: () => void = () => {}) {}
  private identity() {
    const state = this.auth.getState()
    const token = this.auth.getAccessToken()
    if (state.status !== 'signed-in' || !token) throw new Error("Sign in first.")
    return { id: state.user.id, token }
  }
  private async request<T>(body?: object, identity = this.identity(), signal?: AbortSignal): Promise<T> {
    const response = await fetch(new URL('/api/desktop-auth/social', this.url), {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    })
    const current = this.identity()
    if (current.id !== identity.id || current.token !== identity.token) throw new Error("The account changed. Try again.")
    if (response.status === 401) { await this.auth.invalidateSession(); throw new Error("Your session expired. Sign in again.") }
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.data === undefined) throw new Error(payload?.message || "The chat service connection failed. Try again later.")
    return payload.data as T
  }
  async snapshot(): Promise<SocialSnapshot> { return privacySafeSocialSnapshot(await this.request()) }

  /**
   * Every group runs on the chat service: an own group becomes a shared room
   * (same id on every device) with its agents and their mention-only settings.
   * Idempotent; the service decides who answers each message.
   */
  async ensureGroupRoom(conversationId: string): Promise<string> {
    const conversation = this.store.accountConversations.find(item => item.id === conversationId)
    if (!conversation || conversation.type !== 'group') throw new Error('Chat not found')
    if (conversation.remoteRoomId) return conversation.remoteRoomId
    const result = await this.action({ action: 'invite-members', conversationId, friendIds: [], agentIds: [] }) as { roomId: string; snapshot?: SocialSnapshot }
    const quiet = new Set(conversation.mentionOnlyAgentIds ?? [])
    if (quiet.size) {
      const identity = this.identity()
      const room = result.snapshot?.rooms.find(entry => entry.id === result.roomId)
      for (const agent of room?.agents ?? []) {
        if (agent.ownerId === identity.id && quiet.has(agent.localId))
          await this.request({ action: 'set-agent-mode', roomId: result.roomId, agentId: agent.id, mentionOnly: true }, identity).catch(() => undefined)
      }
    }
    return result.roomId
  }

  /** One of this account's agents posts in a group as itself; the agents it mentions answer there. */
  async postAsAgent(roomId: string, localId: string, content: string, agentIds: string[]): Promise<void> {
    await this.request({ action: 'agent-post', roomId, localId, id: randomUUID(), content, agentIds })
    await this.refreshRoom(roomId)
  }

  async resetConversationContext(conversationId: string): Promise<void> {
    const identity = this.identity()
    const conversation = this.store.accountConversations.find(item => item.id === conversationId)
    if (!conversation?.remoteRoomId || conversation.ownerId !== identity.id) throw new Error('Chat not found')
    await this.request({ action: 'reset-context', roomId: conversation.remoteRoomId }, identity)
  }
  private rosterGeneration = 0

  private async refreshRoom(roomId: string): Promise<SocialSnapshot> {
    const identity = this.identity()
    const generation = this.generation
    // Invalidate older inbox snapshots so an in-flight poll cannot restore the
    // previous roster after the mutation has been confirmed by the server.
    ++this.rosterGeneration
    const snapshot = privacySafeSocialSnapshot(await this.request<SocialSnapshot>(undefined, identity, this.abort?.signal))
    if (generation !== this.generation || snapshot.userId !== identity.id || this.identity().id !== identity.id) throw new Error('Chat account mismatch')
    const room = snapshot.rooms.find(item => item.id === roomId)
    if (!room) throw new Error('Chat could not be synchronized')
    ++this.rosterGeneration
    this.store.syncFriendConversation(identity.id, room, [])
    this.onInboxChanged()
    return snapshot
  }

  syncInbox(fresh = false, delivery?: InboxDelivery): Promise<SocialSnapshot> {
    if (this.syncing) return fresh || delivery
      ? this.syncing.catch(() => undefined).then(() => this.syncInbox())
      : this.syncing
    const generation = this.generation
    const signal = this.abort?.signal
    const work = async () => {
      const rosterGeneration = this.rosterGeneration
      const identity = this.identity()
      const snapshot = privacySafeSocialSnapshot(delivery?.snapshot ?? await this.request<SocialSnapshot>(undefined, identity, signal))
      if (snapshot.userId !== identity.id) throw new Error('Chat account mismatch')
      const queue = [...snapshot.rooms]
      const syncRoom = async (room: SocialSnapshot['rooms'][number]) => {
        const stateKey = `${identity.id}:${room.id}`
        const previous = snapshot.syncVersion === 1 ? this.roomSync.get(stateKey) : undefined
        if (previous && room.revision && previous.revision === room.revision && Date.now() - previous.checkedAt < 30000) return
        const cursor = previous ? { ...previous.cursor } : { time: '1970-01-01T00:00:00.000Z', id: '' }
        const pending = new Set(previous?.pending ?? [])
        for (const remote of room.agents.filter((agent) => agent.ownerId === identity.id)) {
          const agent = this.store.accountAgents.find((item) => item.id === remote.localId)
          if (!agent) continue
          const profile = sharedAgentProfile(agent)
          if (!Object.entries(profile).some(([key, value]) => (!key.startsWith('interaction') || snapshot.permissionsVersion === 1) && ((remote as unknown as Record<string, unknown>)[key] ?? '') !== value)) continue
          // Only update an existing membership, never resurrect one removed on another device.
          try {
            const result = await this.request<{ agent?: typeof remote }>({ action: 'update-agent', roomId: room.id, localId: agent.id, ...profile }, identity, signal)
            if (result.agent) Object.assign(remote, result.agent)
          } catch { /* Older/offline services keep the last profile; retry on the next sync. */ }
        }
        const local = this.store.accountConversations.find((conversation) => conversation.remoteRoomId === room.id)
        const known = new Set(local ? [...this.store.topicMessages(local.id, local.activeTopicId).map((message) => message.id), ...this.store.socialClearedMessageIds(local.id)] : [])
        const incoming: SocialMessage[] = []
        const incremental = previous && Date.now() - previous.auditedAt < 300000
        if (incremental) {
          // Replay a small overlap so equal timestamps and transaction commit
          // ordering cannot drop messages at the cursor boundary.
          const fetchCursor = overlapCursor(cursor)
          let prefetched = delivery?.pages?.[room.id]
          let hasMore = true
          const pendingIds = [...pending]
          do {
            const chunk = pendingIds.splice(0, 200)
            const page = prefetched && prefetched.after.time === fetchCursor.time && prefetched.after.id === fetchCursor.id && JSON.stringify(prefetched.pending) === JSON.stringify(chunk)
              ? prefetched
              : await this.request<SocialResult>({ action: 'messages', roomId: room.id, after: fetchCursor, pending: chunk }, identity, signal)
            prefetched = undefined
            const batch = page.messages ?? []
            incoming.push(...batch, ...(page.updates ?? []))
            const last = batch.at(-1)
            if (last) { fetchCursor.time = last.createdAt; fetchCursor.id = last.id }
            hasMore = Boolean(page.hasMore && last)
          } while (hasMore || pendingIds.length)
        } else {
          let before: string | undefined
          for (;;) {
            const page = await this.request<SocialResult>({ action: 'messages', roomId: room.id, before }, identity, signal)
            const batch = page.messages || []
            incoming.push(...batch)
            if (!page.hasMore || !batch.length || (snapshot.syncVersion !== 1 && batch.some((message) => known.has(`${local?.id}:${message.id}`)))) break
            before = batch[0].id
          }
        }
        for (const message of incoming) {
          if (message.createdAt > cursor.time || (message.createdAt === cursor.time && message.id > cursor.id)) { cursor.time = message.createdAt; cursor.id = message.id }
          if (message.status === 'pending' || message.status === 'running') pending.add(message.id)
          else pending.delete(message.id)
        }
        const attachments = new Map<string, MessageAttachment[]>()
        const fileLinks = new Map<string, string[]>()
        for (const message of new Map(incoming.map((message) => [message.id, message])).values()) {
          for (const [id, files, images] of [[message.id, message.files, message.images], [`${message.id}:reply`, message.replyFiles, message.replyImages]] as const) {
            if (!files?.length || known.has(`${local?.id}:${id}`)) continue
            const links: string[] = []
            for (const file of decodeSocialFiles(files, images)) links.push(await this.store.saveIMFile(file, identity.id))
            fileLinks.set(id, links)
          }
          for (const [id, images] of [[message.id, message.images], [`${message.id}:reply`, message.replyImages]] as const) {
            if (!images?.length || known.has(`${local?.id}:${id}`)) continue
            const saved: MessageAttachment[] = []
            for (const image of images) {
              if (this.identity().id !== identity.id || this.store.currentAccountId !== identity.id) throw new Error('Chat account mismatch')
              saved.push(await this.store.saveImageAttachment({ ...image, data: Buffer.from(image.base64, 'base64') }, identity.id))
            }
            attachments.set(id, saved)
          }
        }
        if (generation !== this.generation || this.identity().id !== identity.id) throw new Error('Chat account mismatch')
        if (rosterGeneration !== this.rosterGeneration) return
        this.store.syncFriendConversation(identity.id, room, incoming, attachments, fileLinks)
        if (snapshot.syncVersion === 1) this.roomSync.set(stateKey, { revision: room.revision, cursor, pending, checkedAt: Date.now(), auditedAt: incremental ? previous.auditedAt : Date.now() })
        this.onInboxChanged()
      }
      // One slow room must not hold up all the others; keep concurrency bounded.
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        let failure: unknown
        for (;;) {
          const room = queue.shift()
          if (!room) break
          try { await syncRoom(room) } catch (error) { failure = error }
        }
        if (failure) throw failure
      })
      const results = await Promise.allSettled(workers)
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      return snapshot
    }
    const current = work().finally(() => { if (this.syncing === current) this.syncing = undefined })
    this.syncing = current
    return current
  }

  async sendMessage(conversationId: string, content: string, inputImages?: MessageImageInput[], inputFiles?: MessageFileInput[], mentions?: SelectedMention[]): Promise<void> {
    const identity = this.identity()
    const conversation = this.store.accountConversations.find((item) => item.id === conversationId)
    if (!conversation?.remoteRoomId || conversation.ownerId !== identity.id) throw new Error('Chat not found')
    if (!Array.isArray(inputImages ?? []) || (inputImages?.length ?? 0) > 4) throw new Error('Invalid image attachments')
    let total = 0
    const images = (inputImages ?? []).map((image) => {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) || !ArrayBuffer.isView(image.data) || !image.data.byteLength || image.data.byteLength > 8 * 1024 * 1024) throw new Error('Invalid image attachment')
      total += image.data.byteLength
      if (total > 20 * 1024 * 1024) throw new Error('Images must total 20 MB or less.')
      return { name: image.name, mimeType: image.mimeType, base64: Buffer.from(image.data).toString('base64') }
    })
    const mentionContent = content
    const portable = await exportSocialFiles(this.store, content, identity.id)
    content = portable.text
    const files = [...portable.files, ...(inputFiles ?? []).map(file => ({ name: file.name, base64: Buffer.from(file.data).toString('base64') }))]
    const decodedFiles = decodeSocialFiles(files, images)
    if (files.length && (await this.request<SocialSnapshot>(undefined, identity)).filesVersion !== 1) throw new Error('服务器尚未支持文件传输，请更新服务端后重试。')
    const room = conversation.socialRoom
    const explicitIds = room?.kind !== 'group' && addressesEveryone(content) ? []
      : sharedGroupReplyTargets(mentionContent, room?.agents ?? [], room?.members ?? [], identity.id, mentions)
    const followUp = explicitIds.length ? undefined : socialFollowUpTarget(conversation, this.store.messagePage(conversationId, conversation.activeTopicId).messages, content)
    const signature = JSON.stringify([content, images, files, mentions])
    const key = `${identity.id}:${conversationId}`
    let pending = this.pendingSends.get(key)
    // A lost receipt must retry the same task even after optimistic insertion
    // or a new group message changes the current follow-up context.
    const agentIds = pending?.signature === signature ? pending.agentIds : explicitIds.length ? explicitIds : followUp ? [followUp.id] : []
    checkHumanAgentTargets(agentIds, room?.agents ?? [], identity.id)
    const agentId = agentIds[0]
    if (pending?.signature !== signature) {
      pending = { content, signature, id: randomUUID(), agentIds }
      this.pendingSends.set(key, pending)
    }
    const localId = `${conversationId}:${pending!.id}`
    const existing = this.store.topicMessages(conversationId, conversation.activeTopicId).find((message) => message.id === localId)
    if (!existing) {
      const attachments = await Promise.all((inputImages ?? []).map((image) => this.store.saveImageAttachment(image, identity.id)))
      const links = await Promise.all(decodedFiles.map(file => this.store.saveIMFile(file, identity.id)))
      if (this.identity().id !== identity.id) throw new Error('Chat account mismatch')
      this.store.addMessage({ id: localId, conversationId, topicId: conversation.activeTopicId,
        authorId: 'user', authorName: 'You', text: [content, ...links].filter(Boolean).join('\n\n'), kind: 'message',
        deliveryState: 'sending', ...(attachments.length ? { attachments } : {}) })
    } else this.store.setMessageDeliveryState(localId, 'sending')
    this.onInboxChanged()
    try {
      await this.request({ action: 'send', roomId: conversation.remoteRoomId, content, images, ...(files.length ? { files } : {}), agentId, agentIds, id: pending!.id }, identity)
      this.pendingSends.delete(key)
      // A send receipt can arrive before the task snapshot (or after a watch update).
      const confirmedTasks = this.store.topicMessages(conversationId, conversation.activeTopicId).find((message) => message.id === localId)?.socialTasks
      this.store.setMessageDeliveryState(localId, agentIds.length && !confirmedTasks?.length ? 'confirming' : undefined)
    } catch (error) {
      this.store.setMessageDeliveryState(localId, 'failed')
      throw error
    } finally {
      this.onInboxChanged()
    }
    // The local bubble is already visible; inbox refresh must not block sending.
    void this.syncInbox().catch(() => { /* The next inbox poll recovers confirmed delivery. */ })
  }
  async action(input: SocialAction): Promise<SocialResult> {
    const allowed = ['leave-room', 'group-invite', 'rename-room', 'remove-members', 'invite-members', 'add-members', 'lookup', 'request', 'respond', 'create-room', 'add-agent', 'remove-agent', 'messages', 'send']
    if (!input || !allowed.includes(input.action)) throw new Error("Unsupported operation.")
    if (input.action === 'leave-room') {
      const identity = this.identity()
      const generation = this.generation
      const conversation = this.store.accountConversations.find(item => item.remoteRoomId === input.roomId)
      if (!conversation?.socialRoom || conversation.type !== 'group') throw new Error('Chat not found')
      if (conversation.socialRoom.members[0]?.id === identity.id) throw new Error('群主不能退出自己的群聊。')
      const result = await this.request<SocialResult>(input, identity)
      if (generation !== this.generation || this.identity().id !== identity.id) throw new Error('Chat account mismatch')
      ++this.rosterGeneration
      this.runtime.resetConversation(conversation.id)
      this.store.updateConversation(conversation.id, { savedToContacts: false, hidden: true })
      this.onInboxChanged()
      return result
    }
    if (input.action === 'send') {
      // The legacy workspace has an explicit recipient picker. Apply the same
      // default silence and permissions as the standard inbox, using a fresh roster.
      const identity = this.identity()
      const snapshot = await this.request<SocialSnapshot>(undefined, identity)
      if (snapshot.userId !== identity.id) throw new Error('Chat account mismatch')
      const room = snapshot.rooms.find(item => item.id === input.roomId)
      if (!room) throw new Error('Chat not found')
      const conversation = this.store.accountConversations.find(item => item.remoteRoomId === room.id)
      const explicitIds = room.kind !== 'group' && addressesEveryone(input.content) ? [] : addressesEveryone(input.content) || !input.agentId
        ? sharedGroupReplyTargets(input.content, room.agents, room.members, identity.id) : [input.agentId]
      const followUp = conversation && !explicitIds.length ? socialFollowUpTarget(
        { ...conversation, socialRoom: room }, this.store.messagePage(conversation.id, conversation.activeTopicId).messages, input.content
      ) : undefined
      const agentIds = explicitIds.length ? explicitIds : followUp ? [followUp.id] : []
      checkHumanAgentTargets(agentIds, room.agents, identity.id)
      return this.request({ ...input, agentId: agentIds[0], agentIds }, identity)
    }
    if (input.action === 'group-invite') {
      const conversation = this.store.accountConversations.find((item) => item.id === input.conversationId)
      if (!conversation || conversation.type !== 'group') throw new Error('Chat not found')
      if (!conversation.remoteRoomId) await this.action({ action: 'invite-members', conversationId: conversation.id, friendIds: [], agentIds: [] })
      const roomId = this.store.accountConversations.find((item) => item.id === conversation.id)?.remoteRoomId
      if (!roomId) throw new Error('Chat could not be shared')
      const result = await this.request<SocialResult>({ action: 'group-invite', roomId, regenerate: Boolean(input.regenerate) })
      if (!result.invite) throw new Error('Invitation could not be created')
      const url = new URL('/join-group', this.url)
      url.searchParams.set('room', roomId)
      url.searchParams.set('token', result.invite.token)
      return { ...result, invite: { ...result.invite, url: url.toString() } }
    }
    if (input.action === 'rename-room') {
      const identity = this.identity()
      const generation = this.generation
      const name = input.name.trim()
      const result = await this.request<SocialResult>({ ...input, name }, identity)
      if (generation !== this.generation || this.identity().id !== identity.id) throw new Error('Chat account mismatch')
      // The mutation acknowledgement is sufficient; do not fetch the complete
      // inbox just to rediscover the name we saved. Discard older poll results.
      ++this.rosterGeneration
      const conversation = this.store.accountConversations.find(item => item.remoteRoomId === input.roomId)
      if (conversation?.socialRoom) {
        this.store.syncFriendConversation(identity.id, { ...conversation.socialRoom, name }, [])
      } else if (conversation) this.store.updateConversation(conversation.id, { name })
      this.onInboxChanged()
      return result
    }
    if (input.action === 'remove-members') {
      const result = await this.request<SocialResult>(input)
      const snapshot = await this.refreshRoom(input.roomId)
      if (input.action === 'remove-members') {
        const room = snapshot.rooms.find((entry) => entry.id === input.roomId)
        if (room && (room.members.some((person) => input.friendIds.includes(person.id)) || room.agents.some((agent) =>
          input.agentIds.includes(agent.id) || (agent.ownerId === snapshot.userId && input.agentIds.includes(agent.localId)) || input.friendIds.includes(agent.ownerId)))) {
          throw new Error("The group member has not been removed. Refresh and try again.")
        }
      }
      return { ...result, snapshot }
    }
    if (input.action === 'invite-members') {
      const identity = this.identity()
      const conversation = this.store.accountConversations.find((item) => item.id === input.conversationId)
      if (!conversation || conversation.type !== 'group') throw new Error('Chat not found')
      const existingAgents = new Set(conversation.socialRoom?.agents.filter(agent => agent.ownerId === identity.id).map(agent => agent.localId))
      const localIds = [...new Set(conversation.socialRoom ? input.agentIds : [...conversation.agentIds, ...input.agentIds])].filter(id => !existingAgents.has(id))
      const agents = localIds.map((id) => this.store.claimSocialAgent(id, identity.id))
      const friendIds = [...new Set(input.friendIds)].filter(id => !conversation.socialRoom?.members.some(person => person.id === id))
      let roomId = conversation.remoteRoomId
      if (!roomId) {
        if (this.runtime.snapshot().activity.some((activity) => activity.conversationId === conversation.id)) throw new Error("Wait for the current reply to finish before inviting friends.")
        const result = await this.request<SocialResult>({ action: 'create-room', kind: 'group', name: conversation.name, friendIds, clientId: conversation.id }, identity)
        if (!result.roomId) throw new Error('Chat could not be created')
        roomId = result.roomId
        this.store.linkSharedGroup(conversation.id, roomId)
      } else if (friendIds.length) await this.request({ action: 'add-members', roomId, friendIds }, identity)
      for (const agent of agents) await this.request({ action: 'add-agent', roomId, localId: agent.id, ...sharedAgentProfile(agent) }, identity)
      const snapshot = await this.refreshRoom(roomId)
      // Reuse this confirmed, privacy-filtered roster in the picker instead of
      // making the renderer fetch the entire social snapshot a second time.
      return { roomId, conversationId: conversation.id, snapshot }
    }
    if (input.action === 'add-agent') {
      const agent = this.store.claimSocialAgent(input.localId, this.identity().id)
      return this.request({ ...input, ...sharedAgentProfile(agent) })
    }
    if (input.action === 'create-room') {
      const identity = this.identity()
      const { agentIds = [], ...request } = input
      // Validate ownership before creating anything remotely.
      const agents = [...new Set(agentIds)].map(id => this.store.claimSocialAgent(id, identity.id))
      const result = await this.request<SocialResult>(request, identity)
      if (!result.roomId) throw new Error('Chat could not be created')
      // Bounded parallel registration keeps latency independent of member count
      // for ordinary groups and does not overload the service for large selections.
      for (let offset = 0; offset < agents.length; offset += 4) {
        const results = await Promise.allSettled(agents.slice(offset, offset + 4).map(agent => this.request({
          action: 'add-agent', roomId: result.roomId, localId: agent.id,
          order: (input.memberOrder ?? []).indexOf(`agent:${agent.id}`) + 1,
          ...sharedAgentProfile(agent)
        }, identity)))
        const failed = results.find(item => item.status === 'rejected')
        if (failed?.status === 'rejected') throw new Error(`The group was created, but some agents could not be added. Open the group and retry adding them. ${failed.reason instanceof Error ? failed.reason.message : ''}`)
      }
      // Never wait for unrelated room history or an older long-running inbox poll.
      const snapshot = await this.refreshRoom(result.roomId)
      const conversation = this.store.accountConversations.find(item => item.remoteRoomId === result.roomId)
      if (!conversation) throw new Error('Chat could not be synchronized')
      return { ...result, conversationId: conversation.id, snapshot }
    }
    return this.request(input)
  }
  private heartbeatTimer?: ReturnType<typeof setTimeout>
  private readonly activeTasks = new Map<string, { localId: string; taskId: string }>()
  start(): void {
    this.stop()
    const generation = this.generation
    this.abort = new AbortController()
    const signal = this.abort.signal
    const heartbeat = async () => {
      try {
        const identity = this.identity()
        const requests = this.runtime.snapshot().permissionRequests ?? []
        const approvals = [...this.activeTasks.values()].filter(active => requests.some(request => request.agentId === active.localId))
        await this.request({ action: 'heartbeat', localIds: this.store.agents.filter((agent) => agent.ownerId === identity.id).map((agent) => agent.id), approvals }, identity, signal)
      } catch { /* Older services and offline devices do not advertise presence. */ }
      finally { if (!signal.aborted && generation === this.generation) this.heartbeatTimer = setTimeout(() => void heartbeat(), 10000) }
    }
    void heartbeat()
    let delivery: InboxDelivery | undefined
    const sync = async () => {
      let delay = 2000
      try {
        const incoming = delivery
        delivery = undefined
        const snapshot = await this.syncInbox(false, incoming)
        if (signal.aborted || generation !== this.generation) return
        if (snapshot.syncVersion === 1) {
          const versions = Object.fromEntries(snapshot.rooms.map((room) => [room.id, room.revision ?? '']))
          const identity = this.identity()
          const cursors = Object.fromEntries(snapshot.rooms.flatMap((room) => {
            const state = this.roomSync.get(`${identity.id}:${room.id}`)
            return state && state.pending.size <= 200 ? [[room.id, { after: overlapCursor(state.cursor), pending: [...state.pending] }]] : []
          }))
          const result = await this.request<Partial<InboxDelivery>>({ action: 'watch', versions, includeMessages: true, cursors }, identity, signal)
          if (result.snapshot && result.pages) delivery = { snapshot: result.snapshot, pages: result.pages }
          delay = 0
        }
      } catch { /* Polling is the fallback when notification requests fail. */ }
      finally { if (generation === this.generation) this.inboxTimer = setTimeout(() => void sync(), delay) }
    }
    void sync()
    const poll = async (): Promise<void> => {
      try {
        const identity = this.identity()
        for (const result of this.store.socialTaskOutbox().filter((item) => item.ownerId === identity.id && !this.activeTasks.has(item.id))) {
          await this.request({ action: 'complete', ...result }, identity)
          this.store.removeSocialTaskResult(result.id, identity.id)
        }
        const { tasks } = await this.request<{ tasks: (SocialTask & { localId?: string })[] }>({ action: 'tasks', localIds: this.store.agents.filter((agent) => agent.ownerId === identity.id).map((agent) => agent.id) }, identity)
        for (const pending of tasks) {
          if (signal.aborted || this.activeTasks.size >= 8) break
          if (this.activeTasks.has(pending.id)) continue
          // Tasks for an agent on another computer remain queued there.
          if (pending.localId && this.store.agent(pending.localId)?.ownerId !== identity.id) continue
          const { task } = await this.request<{ task: SocialTask | null }>({ action: 'claim', id: pending.id }, identity)
          if (!task) continue
          this.store.saveSocialTaskResult({ id: task.id, ownerId: identity.id, claim: task.claim, failed: true, reply: '设备在执行期间中断，任务未自动重试。请确认执行结果后再派发新任务。' })
          this.activeTasks.set(task.id, { localId: task.agent.localId, taskId: task.id })
          void (async () => {
            let reply: string
            let images: SocialImage[] | undefined
            let files: SocialFile[] | undefined
            let failed = false
            try {
              if (signal.aborted || task.ownerId !== identity.id || task.agent.ownerId !== identity.id) throw new Error("Task permission check failed.")
              // A task can arrive before the inbox poll creates this room locally.
              // Materialize its trusted room identity before resolving group memory.
              if (task.roomId && !this.store.accountConversations.some(room => room.remoteRoomId === task.roomId)) await this.refreshRoom(task.roomId)
              // History attachment metadata alone is not readable. Finish the
              // inbox download before constructing this agent's file context.
              if (task.context && /"(?:fileNames|replyFileNames)"/.test(task.context)) await this.syncInbox(true)
              const output = await this.runtime.executeSocialTask(identity.id, task.agent.localId, task.id, task.content, signal, task.context, {
                roomId: task.roomId, requesterId: task.authorId, requester: task.authorName, requesterAgentId: task.requesterAgentId, roomName: task.roomName ?? '',
                delegate: async (agentId, content) => { await this.request({ action: 'delegate', taskId: task.id, claim: task.claim, agentId, content }, identity, signal) }
              }, task.images, task.files)
              reply = output.text
              images = output.images
              files = output.files
            } catch (error) { failed = true; reply = error instanceof Error ? error.message : '任务执行失败。' }
            const result = { id: task.id, ownerId: identity.id, claim: task.claim, reply: reply.slice(0, 32000), ...(images?.length ? { images } : {}), ...(files?.length ? { files } : {}), failed }
            this.store.saveSocialTaskResult(result)
            if (!signal.aborted) {
              try {
                await this.request({ action: 'complete', ...result }, identity)
                this.store.removeSocialTaskResult(task.id, identity.id)
              } catch { /* The durable outbox retries publication without rerunning work. */ }
            }
          })().catch(() => { /* Keep the result in the durable outbox. */ }).finally(() => {
            if (generation === this.generation) this.activeTasks.delete(task.id)
          })
        }
      } catch { /* Offline/sign-out does not interrupt local chats. The UI shows request errors. */ }
      finally { if (generation === this.generation) this.timer = setTimeout(() => { void poll() }, 2500) }
    }
    void poll()
  }
  stop(): void {
    this.generation++
    clearTimeout(this.heartbeatTimer)
    this.activeTasks.clear()
    clearTimeout(this.timer)
    clearTimeout(this.inboxTimer)
    this.abort?.abort()
    this.abort = undefined
    this.syncing = undefined
    this.pendingSends.clear()
    this.roomSync.clear()
  }
}
