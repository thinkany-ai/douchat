import { drDouLocalizations, legacyDrDouDefaults } from '../shared/builtInAgentLocalization'
import { agentPermissions } from '../shared/agentPermissions'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentConfig, BuiltInAgentManifest, ResolvedCreateAgentInput, UpdateAgentInput } from '../shared/types'
import { DouchatStore } from './store'

const temporaryDirectories: string[] = []

function createStore(): DouchatStore {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-test-'))
  temporaryDirectories.push(directory)
  return new DouchatStore(join(directory, 'douchat.db'), { seedDemo: true })
}

it('isolates persisted group health by group and account', () => {
  const store = createStore()
  const owner = store.currentAccountId
  const health = { dobi: { fingerprint: 'config-v1', status: 'healthy' as const, checkedAt: 123, latencyMs: 42, failures: 0 } }
  store.saveGroupHealth('crew', health)
  expect(store.groupHealth('crew')).toEqual(health)
  expect(store.groupHealth('direct-dobi')).toEqual({})
  store.setCurrentAccountId('someone-else')
  expect(store.groupHealth('crew')).toEqual({})
  store.saveGroupHealth('crew', {})
  store.setCurrentAccountId(owner)
  expect(store.groupHealth('crew')).toEqual(health)
  store.close()
})

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('DouchatStore', () => {
  it('resets only the selected context while preserving public and private history across restart', () => {
    const store = createStore()
    const conversationId = 'crew', topicId = store.activeTopicId(conversationId)
    const old = store.addMessage({ conversationId, topicId, authorId: 'user', authorName: 'You', text: 'OLD_CONTEXT', kind: 'message' })
    store.addPrivateMessages([{ id: 'private-before', conversationId, topicId, sender: { id: 'dobi', name: 'Dobi' }, recipient: { id: 'lin', name: 'Lin' }, content: 'PRIVATE_OLD', createdAt: Date.now() }])
    const other = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    store.saveGroupHealth(conversationId, { dobi: { fingerprint: 'old', status: 'unavailable', checkedAt: Date.now(), failures: 1 } })
    store.resetConversationContext(conversationId, topicId)
    expect(store.groupHealth(conversationId)).toEqual({})
    expect(store.contextMessages(conversationId, topicId)).toEqual([])
    expect(store.contextPrivateMessages(conversationId, topicId)).toEqual([])
    expect(store.topicMessages(conversationId, topicId).at(-1)).toMatchObject({ kind: 'system', authorId: 'system', text: 'Context reset' })
    expect(store.topicMessages(conversationId, topicId)).toContainEqual(old)
    expect(store.topicPrivateMessages(conversationId, topicId)).toHaveLength(1)
    expect(store.contextMessages('direct-dobi', store.activeTopicId('direct-dobi'))).toEqual(other)
    const fresh = store.addMessage({ conversationId, topicId, authorId: 'user', authorName: 'You', text: 'NEW_CONTEXT', kind: 'message' })
    store.addPrivateMessages([{ id: 'private-after', conversationId, topicId, sender: { id: 'dobi', name: 'Dobi' }, recipient: { id: 'lin', name: 'Lin' }, content: 'PRIVATE_NEW', createdAt: Date.now() }])
    expect(store.contextMessages(conversationId, topicId)).toEqual([fresh])
    expect(store.contextPrivateMessages(conversationId, topicId).map(message => message.content)).toEqual(['PRIVATE_NEW'])
    store.close()
    const reopened = new DouchatStore(join(temporaryDirectories.at(-1)!, 'douchat.db'))
    expect(reopened.contextMessages(conversationId, topicId)).toEqual([fresh])
    expect(reopened.topicMessages(conversationId, topicId).filter(message => message.text === 'Context reset')).toHaveLength(1)
    expect(reopened.topicMessages(conversationId, topicId).some(message => message.id === old.id)).toBe(true)
    reopened.resetConversationContext(conversationId, topicId)
    expect(reopened.contextMessages(conversationId, topicId)).toEqual([])
    expect(reopened.topicMessages(conversationId, topicId).filter(message => message.text === 'Context reset')).toHaveLength(2)
    reopened.setCurrentAccountId('other-account')
    expect(() => reopened.resetConversationContext(conversationId, topicId)).toThrow('Chat not found')
    reopened.close()
  })
  it('preserves a renamed group through member updates, removal and restart', () => {
    const store = createStore()
    const member = store.createAgent({ name: 'Member', role: '', instructions: '', color: '', provider: 'local', model: 'default', localAgentId: 'codex' })
    const group = store.createGroup({ name: '', agentIds: [member.id] })
    store.updateAgent(member.id, { name: 'Updated member' })
    expect(store.conversation(group.id)?.name).toBe('Updated member')
    store.updateConversation(group.id, { name: 'local agents' })
    store.updateAgent(member.id, { name: 'Another name' })
    expect(store.conversation(group.id)?.name).toBe('local agents')
    store.deleteAgent(member.id)
    expect(store.conversation(group.id)?.name).toBe('local agents')
    store.close()
    const reopened = new DouchatStore(join(temporaryDirectories.at(-1)!, 'douchat.db'))
    expect(reopened.conversation(group.id)?.name).toBe('local agents')
    reopened.close()
  })
  it('persists agent permission choices across restarts', () => {
    const store = createStore()
    const agent = store.createAgent({ name: 'Permission test', role: '', instructions: '', color: '', provider: 'local', model: 'default', localAgentId: 'codex' })
    const permissions = agentPermissions()
    permissions.groupAgents = 'deny'
    permissions.sensitive.filesRead = 'allow'
    store.updateAgent(agent.id, { permissions })
    store.close()
    const reopened = new DouchatStore(join(temporaryDirectories.at(-1)!, 'douchat.db'))
    expect(reopened.agent(agent.id)?.permissions).toEqual(permissions)
    reopened.close()
  })

  it('deletes only the requested message from stored history', () => {
    const store = createStore()
    const input = { conversationId: 'direct-dobi', topicId: 'main', authorId: 'user', authorName: 'You', kind: 'message' as const }
    const first = store.addMessage({ ...input, text: 'First' })
    const second = store.addMessage({ ...input, text: 'Second' })
    store.deleteMessage('direct-lin', first.id)
    expect(store.topicMessages(input.conversationId, input.topicId).some((item) => item.id === first.id)).toBe(true)
    store.deleteMessage(input.conversationId, first.id)
    expect(store.topicMessages(input.conversationId, input.topicId).map((item) => item.id)).toEqual([second.id])
  })

  it('keeps a saved group when its inbox conversation is deleted', () => {
    const store = createStore()
    const group = store.createGroup({ name: 'Saved', agentIds: store.agents.slice(0, 2).map((agent) => agent.id) })
    expect(group.savedToContacts).toBeUndefined()
    store.updateConversation(group.id, { savedToContacts: true })
    store.deleteConversation(group.id)
    expect(store.conversation(group.id)).toMatchObject({ savedToContacts: true, hidden: true })
    store.updateConversation(group.id, { savedToContacts: false })
    expect(store.conversation(group.id)?.savedToContacts).toBe(false)
  })

  it('persists shared agent ownership and ignores forged owner updates', () => {
    const store = createStore()
    const agent = store.agents[0]
    expect(store.claimSocialAgent(agent.id, 'local-demo-account').ownerId).toBe('local-demo-account')
    expect(() => store.claimSocialAgent(agent.id, 'bob')).toThrow('your own')
    store.updateAgent(agent.id, { ownerId: 'bob', name: 'Updated' } as UpdateAgentInput)
    expect(store.agent(agent.id)?.ownerId).toBe('local-demo-account')
    store.saveSocialTaskResult({ id: 'task', ownerId: 'local-demo-account', claim: 'claim', reply: 'Done', failed: false })
    expect(store.socialTaskOutbox()).toHaveLength(1)
    store.saveSocialTaskResult({ id: 'task', ownerId: 'local-demo-account', claim: 'claim', reply: 'Updated', failed: false })
    expect(store.socialTaskOutbox()).toHaveLength(1)
    store.setCurrentAccountId('other-account')
    expect(store.socialTaskOutbox()).toEqual([])
    store.setCurrentAccountId('local-demo-account')
    store.removeSocialTaskResult('task')
    expect(store.socialTaskOutbox()).toHaveLength(0)
  })

  it('allows sharing the current account’s built-in agent while rejecting other accounts', () => {
    const store = createStore()
    const admin = store.ensureDefaultCloudContact('alice', { provider: 'gateway', model: 'default' }).agent!
    expect(store.claimSocialAgent(admin.id, 'alice').systemRole).toBe('admin')
    store.setCurrentAccountId('bob')
    expect(() => store.claimSocialAgent(admin.id, 'bob')).toThrow('your own')
  })

  it('persists menu preferences and restores hidden chats when new messages arrive', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-menu-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'douchat.db')
    const store = new DouchatStore(file, { seedDemo: true })
    store.setConversationPinned('direct-dobi', true)
    store.updateConversation('direct-dobi', { muted: true, hidden: true, manuallyUnread: true })
    const restored = new DouchatStore(file, { seedDemo: true })
    expect(restored.conversation('direct-dobi')).toMatchObject({ pinned: true, muted: true, hidden: true, manuallyUnread: true, unread: 1 })
    restored.addUnread('direct-dobi', 1)
    expect(restored.conversation('direct-dobi')).toMatchObject({ hidden: false, unread: 2, muted: true })
    restored.markConversationRead('direct-dobi')
    expect(restored.conversation('direct-dobi')).toMatchObject({ manuallyUnread: false, unread: 0 })
    restored.deleteConversation('direct-dobi')
    expect(new DouchatStore(file, { seedDemo: true }).conversation('direct-dobi')).toBeUndefined()
  })

  it('starts with a crew and private threads', () => {
    const store = createStore()

    expect(store.agents.map((agent) => agent.name)).toEqual(['Dobi', 'Lin'])
    expect(store.conversations.filter((conversation) => conversation.type === 'direct')).toHaveLength(2)
    expect(store.conversations.find((conversation) => conversation.id === 'crew')?.agentIds).toEqual(['dobi', 'lin'])
  })

  it('starts production profiles empty and removes an untouched legacy demo', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-empty-'))
    temporaryDirectories.push(directory)
    const empty = new DouchatStore(join(directory, 'empty.db'))
    expect(empty.agents).toEqual([])
    expect(empty.conversations).toEqual([])
    empty.close()

    const legacyFile = join(directory, 'legacy.db')
    new DouchatStore(legacyFile, { seedDemo: true }).close()
    const migrated = new DouchatStore(legacyFile)
    expect(migrated.agents).toEqual([])
    expect(migrated.conversations).toEqual([])
  })

  it('backfills a stable illustrated avatar seed for existing cloud contacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-avatar-migration-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'legacy.db')
    const original = new DouchatStore(file, { seedDemo: true })
    original.close()

    // Model the on-disk shape written by releases before avatarSeed existed.
    const database = new DatabaseSync(file)
    const rows = database.prepare('SELECT id, data FROM agents').all() as Array<{ id: string; data: string }>
    for (const row of rows) {
      const agent = JSON.parse(row.data) as { avatarSeed?: string }
      delete agent.avatarSeed
      database.prepare('UPDATE agents SET data = ? WHERE id = ?').run(JSON.stringify(agent), row.id)
    }
    database.close()

    const migrated = new DouchatStore(file, { seedDemo: true })
    const seeds = migrated.agents.map((agent) => agent.avatarSeed)
    expect(seeds.every((seed) => /^[0-9a-f-]{36}$/i.test(seed ?? ''))).toBe(true)
    migrated.close()

    expect(new DouchatStore(file, { seedDemo: true }).agents.map((agent) => agent.avatarSeed)).toEqual(seeds)
  })

  it('preserves legacy demo contacts after the user has chatted with them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-used-demo-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'legacy.db')
    const legacy = new DouchatStore(file, { seedDemo: true })
    legacy.addMessage({
      conversationId: 'direct-dobi',
      topicId: legacy.activeTopicId('direct-dobi'),
      authorId: 'user',
      authorName: 'You',
      text: 'Keep this conversation',
      kind: 'message'
    })
    legacy.close()

    const migrated = new DouchatStore(file)
    expect(migrated.agent('dobi')).toBeDefined()
    expect(migrated.conversation('direct-dobi')).toBeDefined()
  })

  it('reopens an existing direct chat or recreates it after deletion', () => {
    const store = createStore()
    const originalTopic = store.activeTopicId('direct-dobi')
    store.updateConversation('direct-dobi', { hidden: true })

    const reopened = store.ensureDirectConversation('dobi')
    expect(reopened.created).toBe(false)
    expect(reopened.conversation.hidden).toBeUndefined()
    expect(reopened.conversation.activeTopicId).toBe(originalTopic)

    store.deleteConversation('direct-lin')
    const recreated = store.ensureDirectConversation('lin')
    expect(recreated.created).toBe(true)
    expect(recreated.conversation).toMatchObject({ id: 'direct-lin', type: 'direct', agentIds: ['lin'] })
    expect(recreated.conversation.topics).toHaveLength(1)
    expect(() => store.ensureDirectConversation('missing')).toThrow('Contact not found')
  })

  it('backfills private source content in existing reply records', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-private-source-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'douchat.db')
    const store = new DouchatStore(file, { seedDemo: true })
    store.addMessage({
      conversationId: 'direct-dobi',
      topicId: store.activeTopicId('direct-dobi'),
      authorId: 'dobi',
      authorName: 'Dobi',
      text: 'I sent Lin the details.',
      kind: 'message',
      deliveries: [{ id: 'legacy-delivery', recipientId: 'lin', recipientName: 'Lin', content: '今晚七点半，老地方见。' }]
    })
    store.addMessage({
      conversationId: 'direct-lin',
      topicId: store.activeTopicId('direct-lin'),
      authorId: 'lin',
      authorName: 'Lin',
      text: '好，我会准时到。',
      kind: 'message',
      source: { kind: 'bot', id: 'dobi', name: 'Dobi' }
    })
    store.close()

    const restored = new DouchatStore(file, { seedDemo: true })
    expect(restored.topicMessages('direct-lin', restored.activeTopicId('direct-lin')).at(-1)?.source?.content)
      .toBe('今晚七点半，老地方见。')
    expect(restored.topicMessages('direct-dobi', restored.activeTopicId('direct-dobi')).at(-1)?.deliveries?.[0].replies?.[0])
      .toMatchObject({ senderId: 'lin', content: '好，我会准时到。' })
    restored.close()
  })

  it('localizes default fields on creation and language switches while preserving edits and clears', () => {
    const store = createStore()
    store.setInterfaceLanguage('zh-CN')
    const { agent } = store.ensureDefaultCloudContact('locale-user', { provider: 'gateway', model: 'default' })
    expect(agent).toMatchObject(drDouLocalizations['zh-CN'])
    store.setInterfaceLanguage('en')
    expect(store.agent(agent!.id)).toMatchObject(drDouLocalizations.en)
    store.updateAgent(agent!.id, { instructions: 'My custom instructions', labels: '' })
    store.setInterfaceLanguage('zh-CN')
    expect(store.agent(agent!.id)).toMatchObject({ role: '豆博士', instructions: 'My custom instructions', labels: '' })
    store.setInterfaceLanguage('en')
    expect(store.agent(agent!.id)).toMatchObject({ role: 'Douchat assistant', instructions: 'My custom instructions', labels: '' })
  })

  it('migrates legacy Chinese template values and cached overrides without changing the contact id', () => {
    const store = createStore(), binding = { provider: 'gateway', model: 'default' }
    const legacy: BuiltInAgentManifest = { version: 1, agents: [{
      id: 'old-admin', systemKey: 'dr-dou', systemRole: 'admin', capabilities: ['manage_agents'],
      templateVersion: 1, name: 'Dr. Dou', ...legacyDrDouDefaults, color: '#14B8A6', modelRoute: 'default'
    }] }
    const { agent } = store.ensureDefaultCloudContact('locale-user', binding, legacy)
    store.updateAgent(agent!.id, { ...legacyDrDouDefaults })
    store.setInterfaceLanguage('en')
    expect(store.agent(agent!.id)).toMatchObject({ id: 'old-admin', ...drDouLocalizations.en })
  })

  it('adopts an administrator saved before the account record existed instead of adding a second', () => {
    const store = createStore()
    const binding = { provider: 'gateway', model: 'default' }
    const manifest: BuiltInAgentManifest = { version: 1, agents: [{
      id: 'system-admin-05396590649a568e3cc4dcfd', systemKey: 'dr-dou', systemRole: 'admin', capabilities: ['manage_agents'],
      templateVersion: 2, name: 'Dr. Dou', ...legacyDrDouDefaults, color: '#14B8A6', modelRoute: 'default'
    }] }
    const original = store.ensureDefaultCloudContact('user-1', binding, manifest).agent!
    // An older version kept neither the account record nor the manifest, so the
    // next sign-in falls back to the account-derived id.
    const meta = store as unknown as { setMeta: (key: string, value: string) => void }
    meta.setMeta('accountDefaultContacts:v1', '[]')
    meta.setMeta('builtInAgentManifest:v1:user-1', '')
    const again = store.ensureDefaultCloudContact('user-1', binding)
    expect(again.created).toBe(false)
    expect(again.agent?.id).toBe(original.id)
    expect(store.agents.filter((agent) => agent.systemKey === 'dr-dou')).toHaveLength(1)
  })

  it('creates one Dr. Dou Cloud contact per newly signed-in account', () => {
    const store = createStore()
    const binding = { provider: 'gateway', model: 'default' }

    const first = store.ensureDefaultCloudContact('user-1', binding)
    expect(first.created).toBe(true)
    expect(first.agent).toMatchObject({
      name: 'Dr. Dou',
      systemRole: 'admin',
      systemKey: 'dr-dou',
      capabilities: ['manage_agents'],
      role: 'Douchat assistant',
      labels: 'Dr. Dou, Douchat',
      provider: 'gateway',
      model: 'default'
    })
    // Derived from the account, so every signed-in device makes the same contact.
    expect(first.agent?.id).toMatch(/^system-admin-[0-9a-f]{32}$/)
    expect(first.conversation).toMatchObject({ type: 'direct', agentIds: [first.agent?.id] })
    expect(store.systemAdminAgentId).toBe(first.agent?.id)
    expect(store.defaultConversationId).toBe(first.conversation?.id)

    const repeated = store.ensureDefaultCloudContact('user-1', { provider: 'gateway', model: 'changed' })
    expect(repeated.created).toBe(false)
    expect(repeated.agent?.id).toBe(first.agent?.id)
    expect(store.agents.filter((agent) => agent.name === 'Dr. Dou')).toHaveLength(1)

    const second = store.ensureDefaultCloudContact('user-2', binding)
    expect(second.created).toBe(true)
    expect(second.agent?.id).not.toBe(first.agent?.id)
    expect(second.agent?.systemRole).toBe('admin')
    expect(store.systemAdminAgentId).toBe(second.agent?.id)
    expect(store.defaultConversationId).toBe(second.conversation?.id)
    expect(store.agents.filter((agent) => agent.name === 'Dr. Dou')).toHaveLength(2)

    expect(() => store.deleteAgent(second.agent!.id)).toThrow('system administrator cannot be deleted')
    expect(store.agent(second.agent!.id)).toBeDefined()

    store.deleteConversation(second.conversation!.id)
    expect(store.defaultConversationId).toBeUndefined()
    expect(store.systemAdminAgentId).toBe(second.agent?.id)
    expect(store.agent(second.agent!.id)).toBeDefined()

    const withoutChat = store.ensureDefaultCloudContact('user-2', binding)
    expect(withoutChat.created).toBe(false)
    expect(withoutChat.agent?.id).toBe(second.agent?.id)
    expect(withoutChat.conversation).toBeUndefined()

    const reopened = store.ensureDirectConversation(second.agent!.id)
    expect(reopened.created).toBe(true)
    expect(store.defaultConversationId).toBe(reopened.conversation.id)
  })

  it('keeps all account data isolated by the active account', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-account-scope-'))
    temporaryDirectories.push(directory)
    const store = new DouchatStore(join(directory, 'douchat.db'))
    const binding = { provider: 'gateway', model: 'default' }
    const firstAdmin = store.ensureDefaultCloudContact('user-1', binding).agent!
    const firstAgent = store.createAgent({
      name: 'First helper',
      role: 'Assistant',
      instructions: 'Help the first account.',
      color: '#7C6CF2',
      provider: 'gateway',
      model: 'default'
    })
    const firstConversation = store.accountConversations.find((item) => item.agentIds[0] === firstAgent.id)!
    const firstRoutine = store.createRoutine({
      name: 'First reminder',
      agentId: firstAgent.id,
      conversationId: firstConversation.id,
      prompt: 'Only notify the first account.',
      schedule: { kind: 'interval', intervalMinutes: 30 },
      timezone: 'Asia/Shanghai'
    }, Date.now() + 30 * 60_000)
    store.createRun({
      agentId: firstAgent.id,
      conversationId: firstConversation.id,
      routineId: firstRoutine.id,
      title: firstRoutine.name,
      prompt: firstRoutine.prompt,
      trigger: 'manual'
    })
    const firstAvatar = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
    store.setUserName('First user')
    store.setUserAvatar(firstAvatar)
    store.setEndpoint({ baseUrl: 'https://first.example.com/v1', apiKey: 'first-secret' })
    store.setConnectors([{
      id: 'first-mail', kind: 'email', name: 'First mailbox', email: 'first@example.com', username: 'first@example.com',
      imapHost: 'imap.example.com', imapPort: 993, imapSecure: true,
      smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true,
      agentIds: [firstAgent.id], status: 'connected', updatedAt: 1
    }])
    const firstAttachment = await store.saveImageAttachment({
      name: 'private.png', mimeType: 'image/png', data: Uint8Array.from([1, 2, 3])
    })
    store.addMessage({
      conversationId: firstConversation.id,
      topicId: store.activeTopicId(firstConversation.id),
      authorId: 'user',
      authorName: 'First user',
      text: '',
      kind: 'message',
      attachments: [firstAttachment]
    })

    const secondAdmin = store.ensureDefaultCloudContact('user-2', binding).agent!
    expect(store.currentAccountId).toBe('user-2')
    expect(store.accountAgents.map((agent) => agent.id)).toEqual([secondAdmin.id])
    expect(store.accountConversations).toHaveLength(1)
    expect(store.accountRoutines).toEqual([])
    expect(store.accountRuns).toEqual([])
    expect(store.userName).toBe('You')
    expect(store.userAvatar).toBe('')
    expect(store.endpoint).toBeUndefined()
    expect(store.connectors).toEqual([])
    await expect(store.attachmentDataUrl(firstAttachment.id)).rejects.toThrow('Attachment not found')

    store.setUserName('Second user')
    store.setEndpoint({ baseUrl: 'https://second.example.com/v1', apiKey: 'second-secret' })

    store.setCurrentAccountId('user-1')
    expect(store.accountAgents.map((agent) => agent.id)).toEqual([firstAdmin.id, firstAgent.id])
    expect(store.accountConversations).toHaveLength(2)
    expect(store.accountRoutines.map((routine) => routine.id)).toEqual([firstRoutine.id])
    expect(store.accountRuns).toHaveLength(1)
    expect(store.userName).toBe('First user')
    expect(store.userAvatar).toBe(firstAvatar)
    expect(store.endpoint).toEqual({ baseUrl: 'https://first.example.com/v1', apiKey: 'first-secret' })
    expect(store.connectors.map((connector) => connector.id)).toEqual(['first-mail'])
    expect(await store.attachmentDataUrl(firstAttachment.id)).toContain('data:image/png;base64,')

    store.setCurrentAccountId('user-2')
    expect(store.userName).toBe('Second user')
    expect(store.endpoint).toEqual({ baseUrl: 'https://second.example.com/v1', apiKey: 'second-secret' })

    store.setCurrentAccountId('')
    expect(store.accountAgents).toEqual([])
    expect(store.accountConversations).toEqual([])
    expect(store.accountRoutines).toEqual([])
    expect(store.accountRuns).toEqual([])
    expect(store.userName).toBe('You')
    expect(store.userAvatar).toBe('')
    expect(store.endpoint).toBeUndefined()
    expect(store.connectors).toEqual([])
  })

  it('migrates legacy unowned tasks to the account identified by their contacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-account-migration-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'douchat.db')
    const store = new DouchatStore(file)
    const binding = { provider: 'gateway', model: 'default' }
    const firstAdmin = store.ensureDefaultCloudContact('user-1', binding).agent!
    const helper = store.createAgent({
      name: 'Legacy helper',
      role: 'Assistant',
      instructions: 'Legacy account helper.',
      color: '#14B8A6',
      provider: 'gateway',
      model: 'default'
    })
    const direct = store.accountConversations.find((conversation) => conversation.agentIds[0] === helper.id)!
    const group = store.createGroup({ name: 'Legacy team', agentIds: [firstAdmin.id, helper.id] })
    const routine = store.createRoutine({
      name: 'Legacy reminder',
      agentId: helper.id,
      conversationId: direct.id,
      prompt: 'Send only to the original account.',
      schedule: { kind: 'interval', intervalMinutes: 60 },
      timezone: 'Asia/Shanghai'
    }, Date.now() + 60 * 60_000)
    const run = store.createRun({
      agentId: helper.id,
      conversationId: direct.id,
      routineId: routine.id,
      title: routine.name,
      prompt: routine.prompt,
      trigger: 'manual'
    })
    store.ensureDefaultCloudContact('user-2', binding)
    store.close()

    // Releases before account scoping wrote these rows without ownerId. The
    // group still links the custom contact to user-1's system administrator.
    const database = new DatabaseSync(file)
    const stripOwner = (table: string, ids: string[]): void => {
      for (const id of ids) {
        const row = database.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined
        if (!row) continue
        const value = JSON.parse(row.data) as { ownerId?: string }
        delete value.ownerId
        database.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(JSON.stringify(value), id)
      }
    }
    stripOwner('agents', [helper.id])
    stripOwner('conversations', [direct.id, group.id])
    stripOwner('routines', [routine.id])
    stripOwner('runs', [run.id])
    const legacyConnector = {
      id: 'legacy-mail', kind: 'email', name: 'Legacy mailbox', email: 'legacy@example.com', username: 'legacy@example.com',
      imapHost: 'imap.example.com', imapPort: 993, imapSecure: true,
      smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true,
      agentIds: [helper.id], status: 'connected', updatedAt: 1
    }
    const upsertMeta = database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    upsertMeta.run('userName', 'Legacy current user')
    upsertMeta.run('userAvatar', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==')
    upsertMeta.run('endpoint', JSON.stringify({ baseUrl: 'https://legacy.example.com/v1', apiKey: 'legacy-secret' }))
    upsertMeta.run('connectors:v1', JSON.stringify([legacyConnector]))
    database.close()

    const migrated = new DouchatStore(file)
    expect(migrated.currentAccountId).toBe('user-2')
    expect(migrated.accountRoutines).toEqual([])
    expect(migrated.agent(helper.id)?.ownerId).toBe('user-1')
    expect(migrated.conversation(direct.id)?.ownerId).toBe('user-1')
    expect(migrated.routines.find((item) => item.id === routine.id)?.ownerId).toBe('user-1')
    expect(migrated.runs.find((item) => item.id === run.id)?.ownerId).toBe('user-1')
    expect(migrated.userName).toBe('You')
    expect(migrated.userAvatar).toBe('')
    expect(migrated.endpoint).toBeUndefined()
    expect(migrated.connectors).toEqual([])
    migrated.setCurrentAccountId('user-1')
    expect(migrated.accountRoutines.map((item) => item.id)).toEqual([routine.id])
    expect(migrated.accountRuns.map((item) => item.id)).toEqual([run.id])
    expect(migrated.connectors.map((connector) => connector.id)).toEqual(['legacy-mail'])
    expect(migrated.userName).toBe('You')
    expect(migrated.endpoint).toBeUndefined()
  })

  it('migrates legacy profile and endpoint settings only when one account is known', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-account-meta-migration-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'douchat.db')
    const store = new DouchatStore(file)
    store.ensureDefaultCloudContact('only-user', { provider: 'gateway', model: 'default' })
    store.close()
    const database = new DatabaseSync(file)
    database.prepare("DELETE FROM meta WHERE key LIKE 'account:v1:only-user:%'").run()
    const upsert = database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    upsert.run('userName', 'Legacy user')
    upsert.run('userAvatar', 'data:image/jpeg;base64,/9j/4AAQSkZJRg==')
    upsert.run('endpoint', JSON.stringify({ baseUrl: 'https://legacy.example.com/v1', apiKey: 'legacy-key' }))
    database.close()

    const migrated = new DouchatStore(file)
    expect(migrated.currentAccountId).toBe('only-user')
    expect(migrated.userName).toBe('Legacy user')
    expect(migrated.userAvatar).toContain('data:image/jpeg;base64,')
    expect(migrated.endpoint).toEqual({ baseUrl: 'https://legacy.example.com/v1', apiKey: 'legacy-key' })
  })

  it('recovers legacy attachment ownership and refuses cross-account reads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-attachment-scope-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'douchat.db')
    const store = new DouchatStore(file)
    const contact = store.ensureDefaultCloudContact('user-1', { provider: 'gateway', model: 'default' })
    const attachment = await store.saveImageAttachment({
      name: 'legacy.png', mimeType: 'image/png', data: Uint8Array.from([4, 5, 6])
    })
    store.addMessage({
      conversationId: contact.conversation!.id,
      topicId: store.activeTopicId(contact.conversation!.id),
      authorId: 'user',
      authorName: 'User one',
      text: '',
      kind: 'message',
      attachments: [attachment]
    })
    store.close()
    const database = new DatabaseSync(file)
    database.prepare('DELETE FROM attachmentOwners WHERE id = ?').run(attachment.id)
    database.close()

    const migrated = new DouchatStore(file)
    expect(await migrated.attachmentDataUrl(attachment.id)).toContain('data:image/png;base64,')
    migrated.setCurrentAccountId('user-2')
    await expect(migrated.attachmentDataUrl(attachment.id)).rejects.toThrow('Attachment not found')
  })

  it('syncs cloud-owned built-in fields while preserving local user overrides and history ids', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-built-in-sync-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'douchat.db')
    const store = new DouchatStore(file)
    const binding = { provider: 'gateway', model: 'douchat-default' }
    const fallback = store.ensureDefaultCloudContact('user-1', binding)
    const localId = fallback.agent!.id
    const conversationId = fallback.conversation!.id
    const manifest: BuiltInAgentManifest = {
      version: 7,
      agents: [{
        id: 'system-admin-cloud-stable',
        systemKey: 'dr-dou',
        systemRole: 'admin',
        capabilities: ['manage_agents'],
        templateVersion: 3,
        name: 'Dr. Dou Cloud',
        role: 'Cloud administrator',
        instructions: 'Cloud prompt version three.',
        labels: 'cloud, built-in',
        color: '#123456',
        modelRoute: 'primary'
      }]
    }

    const synced = store.ensureDefaultCloudContact('user-1', binding, manifest)
    expect(synced.agent?.id).toBe(localId)
    expect(synced.conversation?.id).toBe(conversationId)
    expect(synced.agent).toMatchObject({
      cloudAgentId: 'system-admin-cloud-stable',
      systemKey: 'dr-dou',
      templateVersion: 3,
      capabilities: ['manage_agents'],
      name: 'Dr. Dou Cloud',
      role: 'Cloud administrator',
      instructions: 'Cloud prompt version three.',
      color: '#123456',
      modelRoute: 'primary',
      model: 'primary'
    })
    expect(synced.conversation?.name).toBe('Dr. Dou Cloud')

    store.updateAgent(localId, {
      name: '我的豆博士',
      instructions: 'Use my custom description.',
      avatarEmoji: '🫘'
    })
    const upgraded: BuiltInAgentManifest = {
      ...manifest,
      version: 8,
      agents: [{
        ...manifest.agents[0],
        templateVersion: 4,
        name: 'Renamed by cloud',
        instructions: 'Cloud prompt version four.',
        role: 'Updated cloud role'
      }]
    }
    const preserved = store.ensureDefaultCloudContact('user-1', binding, upgraded)
    expect(preserved.agent).toMatchObject({
      id: localId,
      name: '我的豆博士',
      instructions: 'Use my custom description.',
      avatarEmoji: '🫘',
      role: 'Updated cloud role',
      templateVersion: 4,
      userOverrides: {
        name: '我的豆博士',
        instructions: 'Use my custom description.',
        avatarEmoji: '🫘',
        avatar: ''
      }
    })
    store.close()

    const restored = new DouchatStore(file)
    const cached = restored.ensureDefaultCloudContact('user-1', binding)
    expect(cached.agent).toMatchObject({
      id: localId,
      cloudAgentId: 'system-admin-cloud-stable',
      name: '我的豆博士',
      role: 'Updated cloud role',
      templateVersion: 4
    })
    restored.close()
  })

  it('restores a system administrator deleted by an older release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-admin-recovery-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'douchat.db')
    const binding = { provider: 'gateway', model: 'default' }
    const originalStore = new DouchatStore(file)
    const original = originalStore.ensureDefaultCloudContact('user-1', binding)
    const originalId = original.agent!.id
    originalStore.close()

    // Older builds allowed the contact and its chat to be removed while the
    // account onboarding record remained in metadata.
    const database = new DatabaseSync(file)
    database.prepare('DELETE FROM conversations WHERE id = ?').run(original.conversation!.id)
    database.prepare('DELETE FROM agents WHERE id = ?').run(originalId)
    database.close()

    const recoveredStore = new DouchatStore(file)
    const recovered = recoveredStore.ensureDefaultCloudContact('user-1', binding)
    expect(recovered.created).toBe(true)
    expect(recovered.agent).toMatchObject({ name: 'Dr. Dou', systemRole: 'admin' })
    // The account-derived id is reused; the earlier chat and contact are gone.
    expect(recovered.agent?.id).toBe(originalId)
    expect(recoveredStore.systemAdminAgentId).toBe(recovered.agent?.id)
    expect(recoveredStore.defaultConversationId).toBe(recovered.conversation?.id)
  })

  it('marks an existing legacy Dr. Dou as the system administrator', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-admin-migration-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'douchat.db')
    const binding = { provider: 'gateway', model: 'default' }
    const originalStore = new DouchatStore(file)
    const original = originalStore.ensureDefaultCloudContact('user-1', binding)
    originalStore.close()

    const database = new DatabaseSync(file)
    const row = database.prepare('SELECT data FROM agents WHERE id = ?').get(original.agent!.id) as { data: string }
    const legacy = JSON.parse(row.data) as AgentConfig
    delete legacy.systemRole
    database.prepare('UPDATE agents SET data = ? WHERE id = ?').run(JSON.stringify(legacy), legacy.id)
    database.close()

    const migratedStore = new DouchatStore(file)
    expect(migratedStore.agent(original.agent!.id)?.systemRole).toBe('admin')
    expect(migratedStore.systemAdminAgentId).toBe(original.agent?.id)
    const migrated = migratedStore.ensureDefaultCloudContact('user-1', binding)
    expect(migrated.created).toBe(false)
    expect(migrated.agent?.id).toBe(original.agent?.id)
    expect(migrated.agent?.systemRole).toBe('admin')
    expect(migratedStore.systemAdminAgentId).toBe(original.agent?.id)
  })

  it.each([
    { provider: 'custom:mine', model: 'private-model' },
    { provider: 'gateway', model: 'chosen-cloud-model' }
  ])('persists a built-in model selection across restart and sync: $provider', (binding) => {
    const store = createStore()
    const admin = store.ensureDefaultCloudContact('user-1', { provider: 'gateway', model: 'original-default' }).agent!
    const conversationId = store.accountConversations.find(item => item.agentIds.includes(admin.id))?.id
    store.updateAgent(admin.id, {}, { binding, followDefault: false })
    expect(store.agent(admin.id)).toMatchObject({ ...binding, userOverrides: { modelBinding: binding } })
    store.close()
    const reopened = new DouchatStore(join(temporaryDirectories.at(-1)!, 'douchat.db'))
    try {
      const synced = reopened.ensureDefaultCloudContact('user-1', { provider: 'gateway', model: 'new-default' })
      expect(synced.agent).toMatchObject({ id: admin.id, ...binding, systemRole: 'admin', capabilities: ['manage_agents'] })
      expect(synced.conversation?.id).toBe(conversationId)
      // Profile edits and raw model fields must not erase a validated choice.
      reopened.updateAgent(admin.id, { name: 'My admin', provider: 'forged', model: 'forged' })
      expect(reopened.agent(admin.id)).toMatchObject({ name: 'My admin', ...binding })
      reopened.updateAgent(admin.id, {}, { binding: { provider: 'gateway', model: 'new-default' }, followDefault: true })
      expect(reopened.agent(admin.id)?.userOverrides?.modelBinding).toBeUndefined()
      expect(reopened.agent(admin.id)).toMatchObject({ provider: 'gateway', model: 'new-default' })
      expect(reopened.ensureDefaultCloudContact('user-1', { provider: 'gateway', model: 'latest-default' }).agent)
        .toMatchObject({ provider: 'gateway', model: 'latest-default', name: 'My admin' })
    } finally { reopened.close() }
  })

  it('does not let ordinary create or update payloads grant or clear the system role', () => {
    const store = createStore()
    const forged = store.createAgent({
      name: 'Forged admin',
      role: 'Assistant',
      instructions: '',
      color: '#7C6CF2',
      provider: 'gateway',
      model: 'default',
      systemRole: 'admin',
      capabilities: ['manage_agents']
    } as ResolvedCreateAgentInput & { systemRole: 'admin'; capabilities: ['manage_agents'] })
    expect(forged.systemRole).toBeUndefined()
    expect(forged.capabilities).toBeUndefined()

    const admin = store.ensureDefaultCloudContact('user-1', { provider: 'gateway', model: 'default' }).agent!
    store.updateAgent(admin.id, {
      name: 'Renamed admin',
      systemRole: undefined,
      capabilities: []
    } as UpdateAgentInput & { systemRole?: undefined; capabilities: [] })
    expect(store.agent(admin.id)).toMatchObject({
      name: 'Renamed admin',
      systemRole: 'admin',
      capabilities: ['manage_agents']
    })
  })

  it('gives a new bot its own private chat without joining existing groups', () => {
    const store = createStore()
    const agent = store.createAgent({
      name: 'Nova',
      role: 'Researcher',
      instructions: 'Find useful evidence.',
      color: '#7C6CF2',
      provider: 'openai',
      model: 'gpt-5.6-terra'
    })

    expect(store.conversations.find((conversation) => conversation.id === 'crew')?.agentIds).not.toContain(agent.id)
    const direct = store.conversations.find(
      (conversation) => conversation.type === 'direct' && conversation.agentIds[0] === agent.id
    )
    expect(agent.avatarSeed).toMatch(/^[0-9a-f-]{36}$/i)
    expect(store.agent(agent.id)?.avatarSeed).toBe(agent.avatarSeed)
    expect(direct?.topics).toHaveLength(1)
  })

  it('persists a local agent binding and keeps contacts on the same CLI independent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-local-store-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'douchat.db')
    const store = new DouchatStore(file, { seedDemo: true })
    const input = { name: 'Research', role: 'Researcher', instructions: 'Find evidence', color: '#14B8A6', provider: 'local', model: 'default', localAgentId: 'codex' }
    const first = store.createAgent(input)
    const second = store.createAgent({ ...input, name: 'Builder' })
    const restored = new DouchatStore(file, { seedDemo: true })
    expect(first.avatarSeed).toBeUndefined()
    expect(second.avatarSeed).toBeUndefined()
    expect(restored.agent(first.id)?.localAgentId).toBe('codex')
    expect(restored.agent(second.id)?.localAgentId).toBe('codex')
    expect(restored.activeTopicId(`direct-${first.id}`)).not.toBe(restored.activeTopicId(`direct-${second.id}`))
  })

  it('switches an existing contact between local and endpoint without losing its chat', () => {
    const store = createStore()
    const topic = store.activeTopicId('direct-dobi')
    const before = store.topicMessages('direct-dobi', topic)
    store.updateAgent('dobi', { localAgentId: 'codex', provider: 'local', model: 'default' })
    expect(store.agent('dobi')?.localAgentId).toBe('codex')
    expect(store.activeTopicId('direct-dobi')).toBe(topic)
    expect(store.topicMessages('direct-dobi', topic)).toEqual(before)
    store.updateAgent('dobi', { localAgentId: '', provider: 'openai', model: 'test' })
    expect(store.agent('dobi')?.localAgentId).toBeFalsy()
  })

  it('creates a group with an explicit lead member', () => {
    const store = createStore()
    const group = store.createGroup({ name: 'AGI Group', agentIds: ['lin', 'dobi'], leadAgentId: 'lin' })

    expect(group.type).toBe('group')
    expect(group.leadAgentId).toBe('lin')
    expect(group.topics).toHaveLength(1)
  })

  it('keeps topics, their transcripts and unread counts apart', () => {
    const store = createStore()
    const first = store.activeTopicId('direct-dobi')
    store.addMessage({
      conversationId: 'direct-dobi',
      topicId: first,
      authorId: 'user',
      authorName: 'You',
      text: 'Plan the launch',
      kind: 'message'
    })
    const second = store.createTopic('direct-dobi')!

    expect(store.activeTopicId('direct-dobi')).toBe(second.id)
    expect(store.topicMessages('direct-dobi', second.id)).toHaveLength(0)
    // The first human line names the topic the way a chat thread is titled.
    expect(store.conversation('direct-dobi')?.topics[0].title).toBe('Plan the launch')

    store.addUnread('direct-dobi', 2)
    expect(store.conversation('direct-dobi')?.unread).toBe(2)
    store.markConversationRead('direct-dobi')
    expect(store.conversation('direct-dobi')?.unread).toBe(0)

    store.deleteTopic('direct-dobi', first)
    expect(store.topicMessages('direct-dobi', first)).toHaveLength(0)
  })

  it('keeps insertion order when messages share a timestamp', () => {
    const store = createStore()
    const topicId = store.activeTopicId('direct-dobi')
    // One model turn splits into several bubbles written in the same
    // millisecond; only insertion order can tell them apart.
    for (const text of ['first', 'second', 'third']) {
      store.addMessage({
        conversationId: 'direct-dobi',
        topicId,
        authorId: 'dobi',
        authorName: 'Dobi',
        text,
        kind: 'message',
        createdAt: 5_000
      })
    }
    expect(store.topicMessages('direct-dobi', topicId).map((message) => message.text)).toEqual([
      'first',
      'second',
      'third'
    ])
  })

  it('takes a conversation\'s messages, deliveries and routines down with it', () => {
    const store = createStore()
    const topicId = store.activeTopicId('direct-dobi')
    store.addMessage({ conversationId: 'direct-dobi', topicId, authorId: 'user', authorName: 'You', text: 'Hi', kind: 'message' })
    store.addPrivateMessages([
      {
        id: 'p1',
        conversationId: 'direct-dobi',
        topicId,
        sender: { id: 'dobi', name: 'Dobi' },
        recipient: { id: 'lin', name: 'Lin' },
        content: 'take this',
        createdAt: 1
      }
    ])
    store.createRoutine(
      {
        name: 'Daily',
        agentId: 'dobi',
        conversationId: 'direct-dobi',
        prompt: 'brief me',
        schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' },
        timezone: 'Asia/Shanghai'
      },
      1_000
    )

    store.deleteConversation('direct-dobi')

    expect(store.conversation('direct-dobi')).toBeUndefined()
    expect(store.messages.filter((message) => message.conversationId === 'direct-dobi')).toEqual([])
    expect(store.privateMessages).toEqual([])
    expect(store.routines).toEqual([])
  })

  it('removes a deleted bot from groups and drops its private deliveries', () => {
    const store = createStore()
    const topicId = store.activeTopicId('crew')
    store.addPrivateMessages([
      {
        id: 'p1',
        conversationId: 'crew',
        topicId,
        sender: { id: 'lin', name: 'Lin' },
        recipient: { id: 'dobi', name: 'Dobi' },
        content: 'for you',
        createdAt: 1
      }
    ])
    const run = store.createRun({
      agentId: 'dobi',
      conversationId: 'crew',
      title: 'Task',
      prompt: 'go',
      trigger: 'chat'
    })
    store.addRunEvent({ runId: run.id, type: 'status', label: 'Started', status: 'running' })

    store.deleteAgent('dobi')

    expect(store.agent('dobi')).toBeUndefined()
    expect(store.conversation('direct-dobi')).toBeUndefined()
    expect(store.conversation('crew')?.agentIds).toEqual(['lin'])
    expect(store.conversation('crew')?.leadAgentId).toBe('lin')
    expect(store.privateMessages).toEqual([])
    // The run goes, and its events cascade with it.
    expect(store.runs).toEqual([])
    expect(store.runEvents).toEqual([])
  })

  it('caps run history and drops the events of runs that aged out', () => {
    const store = createStore()
    const firstRun = store.createRun({ agentId: 'dobi', conversationId: 'crew', title: 'First', prompt: 'go', trigger: 'chat' })
    store.addRunEvent({ runId: firstRun.id, type: 'status', label: 'Started', status: 'running' })
    for (let index = 0; index < 125; index += 1) {
      store.createRun({ agentId: 'dobi', conversationId: 'crew', title: `Run ${index}`, prompt: 'go', trigger: 'chat' })
    }

    expect(store.runs).toHaveLength(120)
    expect(store.runs.some((item) => item.id === firstRun.id)).toBe(false)
    expect(store.runEvents).toEqual([])
    // An event for a run that already aged out is dropped, not an exception.
    expect(() => store.addRunEvent({ runId: firstRun.id, type: 'status', label: 'Late', status: 'failed' })).not.toThrow()
    expect(store.runEvents).toEqual([])
  })

  it('persists messages between store instances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-test-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'douchat.db')
    const store = new DouchatStore(filePath, { seedDemo: true })
    store.addMessage({
      conversationId: 'crew',
      topicId: store.activeTopicId('crew'),
      authorId: 'user',
      authorName: 'You',
      text: 'Build the first version.',
      kind: 'message'
    })

    const restored = new DouchatStore(filePath, { seedDemo: true })
    expect(restored.messages.at(-1)?.text).toBe('Build the first version.')
  })

  it('keeps the profile picture across restarts and rejects anything that is not one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-test-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'douchat.db')
    const store = new DouchatStore(filePath, { seedDemo: true })
    const picture = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

    expect(store.userAvatar).toBe('')
    store.setUserAvatar(picture)
    expect(new DouchatStore(filePath, { seedDemo: true }).userAvatar).toBe(picture)

    // A remote URL would let the state file pull an image at render time, and
    // an oversized payload would slow every load; both are refused outright.
    store.setUserAvatar('https://example.com/me.png')
    store.setUserAvatar(`data:image/png;base64,${'A'.repeat(2_000_000)}`)
    expect(store.userAvatar).toBe(picture)

    store.setUserAvatar('')
    expect(new DouchatStore(filePath, { seedDemo: true }).userAvatar).toBe('')
  })

  it('persists a contact picture, clears it, and refuses remote images', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-contact-avatar-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'douchat.db')
    const store = new DouchatStore(filePath, { seedDemo: true })
    const picture = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

    store.updateAgent('dobi', { avatar: picture })
    expect(new DouchatStore(filePath, { seedDemo: true }).agent('dobi')?.avatar).toBe(picture)

    store.updateAgent('dobi', { avatar: 'https://example.com/contact.png' })
    expect(store.agent('dobi')?.avatar).toBe(picture)

    store.updateAgent('dobi', { avatar: '' })
    expect(new DouchatStore(filePath, { seedDemo: true }).agent('dobi')?.avatar).toBe('')
  })

  it('persists routines and their run history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-test-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'douchat.db')
    const store = new DouchatStore(filePath, { seedDemo: true })
    const routine = store.createRoutine(
      {
        name: 'Morning brief',
        agentId: 'dobi',
        conversationId: 'direct-dobi',
        prompt: 'Review the morning brief.',
        schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' },
        timezone: 'Asia/Shanghai'
      },
      2_000
    )
    const run = store.createRun({
      agentId: 'dobi',
      conversationId: 'direct-dobi',
      routineId: routine.id,
      title: routine.name,
      prompt: routine.prompt,
      trigger: 'manual'
    })
    store.updateRun(run.id, { status: 'succeeded', finishedAt: 3_000 })
    store.addRunEvent({ runId: run.id, type: 'status', label: 'Finished', status: 'succeeded' })

    const restored = new DouchatStore(filePath, { seedDemo: true })
    expect(restored.routines[0]).toMatchObject({ name: 'Morning brief', nextRunAt: 2_000, enabled: true })
    expect(restored.runs[0]).toMatchObject({ routineId: routine.id, status: 'succeeded' })
    expect(restored.runEvents[0]).toMatchObject({ runId: run.id, label: 'Finished' })
  })

  it('fails interrupted runs on launch and retries interrupted one-time work', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-interrupted-run-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'douchat.db')
    const store = new DouchatStore(filePath, { seedDemo: true })
    const routine = store.createRoutine({
      name: 'One-time reminder',
      agentId: 'dobi',
      conversationId: 'direct-dobi',
      prompt: 'Send the reminder.',
      schedule: { kind: 'once', runAt: Date.now() - 1_000 },
      timezone: 'Asia/Shanghai'
    }, Date.now() - 1_000)
    store.setRoutineEnabled(routine.id, false)
    const run = store.createRun({
      agentId: 'dobi',
      conversationId: 'direct-dobi',
      routineId: routine.id,
      title: routine.name,
      prompt: routine.prompt,
      trigger: 'schedule',
      status: 'running',
      startedAt: Date.now() - 500
    })
    const reopenedAt = Date.now()

    const restored = new DouchatStore(filePath, { seedDemo: true })

    expect(restored.runs.find((item) => item.id === run.id)).toMatchObject({
      status: 'failed',
      latestActivity: 'Interrupted',
      error: 'Douchat restarted before this task finished'
    })
    expect(restored.routines.find((item) => item.id === routine.id)).toMatchObject({ enabled: true })
    expect(restored.routines.find((item) => item.id === routine.id)!.nextRunAt).toBeGreaterThanOrEqual(reopenedAt + 60_000)
  })

  it('persists connector metadata without credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-connectors-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'douchat.db')
    const store = new DouchatStore(filePath, { seedDemo: true })
    store.setConnectors([{
      id: 'email-work', kind: 'email', name: 'Work email', email: 'team@example.com', username: 'team@example.com',
      imapHost: 'imap.example.com', imapPort: 993, imapSecure: true,
      smtpHost: 'smtp.example.com', smtpPort: 465, smtpSecure: true,
      agentIds: ['dobi'], status: 'connected', updatedAt: 123
    }])

    const restored = new DouchatStore(filePath, { seedDemo: true }).connectors
    expect(restored).toEqual([expect.objectContaining({ id: 'email-work', email: 'team@example.com', agentIds: ['dobi'] })])
    expect(JSON.stringify(restored)).not.toContain('password')
  })
})

describe('message pagination', () => {
  it('pages by insertion order without gaps when timestamps match and new replies arrive', () => {
    const store = createStore()
    const agent = store.createAgent({ name: 'Pages', role: 'Assistant', instructions: 'Help', color: '#fff', provider: 'local', model: 'default' })
    const conversationId = `direct-${agent.id}`
    const topicId = store.activeTopicId(conversationId)
    const add = (index: number) => store.addMessage({ conversationId, topicId, authorId: 'user', authorName: 'You', text: String(index), kind: 'message', createdAt: 1 })
    for (let i = 0; i < 125; i++) add(i)
    const latest = store.messagePage(conversationId, topicId)
    expect(latest.messages.map(m => Number(m.text))).toEqual(Array.from({ length: 50 }, (_, i) => i + 75))
    expect(latest.hasMore).toBe(true)
    add(125)
    const middle = store.messagePage(conversationId, topicId, latest.messages[0].id)
    const first = store.messagePage(conversationId, topicId, middle.messages[0].id)
    expect([...first.messages, ...middle.messages, ...latest.messages].map(m => Number(m.text))).toEqual(Array.from({ length: 125 }, (_, i) => i))
    expect(first.hasMore).toBe(false)
    expect(store.recentMessages().filter(m => m.conversationId === conversationId)).toHaveLength(51)
    expect(store.messagePage('missing', topicId).messages).toEqual([])
    expect(store.searchMessages(conversationId, '12').map(m => m.text)).toEqual(['125', '124', '123', '122', '121', '120', '112', '12'])
    expect(store.searchMessages('missing', '12')).toEqual([])
  })

  it('reuses recent messages until something writes', () => {
    const store = createStore()
    const agent = store.createAgent({ name: 'Cache', role: 'Assistant', instructions: 'Help', color: '#fff', provider: 'local', model: 'default' })
    const conversationId = `direct-${agent.id}`
    const topicId = store.activeTopicId(conversationId)
    const mine = () => store.recentMessages().filter(m => m.conversationId === conversationId)
    const first = store.addMessage({ conversationId, topicId, authorId: 'user', authorName: 'You', text: 'one', kind: 'message' })
    const before = mine()
    expect(mine()[0]).toBe(before[0])
    store.addMessage({ conversationId, topicId, authorId: 'user', authorName: 'You', text: 'two', kind: 'message' })
    expect(mine().map(m => m.text)).toEqual(['one', 'two'])
    store.setMessageDeliveryState(first.id, 'sending')
    expect(mine()[0].deliveryState).toBe('sending')
    store.deleteMessage(conversationId, first.id)
    expect(mine().map(m => m.text)).toEqual(['two'])
  })
})

it('isolates Connany selections by login account and backend origin', () => {
  const store = createStore()
  store.setCurrentAccountId('connector-owner-a')
  const selection = [{ provider: 'notion' as const, connectionId: 'conn_a' }]
  store.setConnanySelections('https://backend-a.example', selection)
  expect(store.getConnanySelections('https://backend-b.example')).toEqual([])
  store.setCurrentAccountId('connector-owner-b')
  expect(store.getConnanySelections('https://backend-a.example')).toEqual([])
  store.setCurrentAccountId('connector-owner-a')
  expect(store.getConnanySelections('https://backend-a.example')).toEqual(selection)
})

it('persists connector names separately for each account and service', () => {
  const store = createStore()
  store.setCurrentAccountId('names-a')
  store.setConnanyName('https://service-a.example', 'conn_one', 'Work GitHub')
  store.setCurrentAccountId('names-b')
  expect(store.getConnanyNames('https://service-a.example')).toEqual({})
  store.setCurrentAccountId('names-a')
  expect(store.getConnanyNames('https://service-b.example')).toEqual({})
  expect(store.getConnanyNames('https://service-a.example')).toEqual({ conn_one: 'Work GitHub' })
})
