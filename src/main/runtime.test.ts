import { replyToIM } from './imReply'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerProvider } from './computer'
import { DouchatRuntime } from './runtime'
import { DouchatStore } from './store'

const directories: string[] = []

const idleComputer: ComputerProvider = {
  snapshots: () => [],
  start: async () => {
    throw new Error('not used')
  },
  stop: async () => undefined,
  show: async () => undefined,
  createTools: () => [],
  dispose: () => undefined
}

interface ReplyOptions {
  sessionKey?: string
  toolsDisabled?: boolean
  config: { id: string; name: string }
  context: 'direct' | 'group' | 'controller'
  prompt: string
  images?: { type: 'image'; data: string; mimeType: string }[]
}

interface DecisionPayload {
  currentLeaderMemberId?: string
  leadMember: { id: string } | null
  members: { id: string; name: string }[]
  messages: { id: string; role: string; content?: string }[]
  completedTurns: { memberId: string }[]
}

interface MessageAgentToolLike {
  execute: (
    toolCallId: string,
    params: { agent: string; message: string; replyTo?: 'human' | 'caller' }
  ) => Promise<{ content: Array<{ type: string; text: string }> }>
}

interface AgentManagementToolLike {
  name: string
  execute: (
    toolCallId: string,
    params: Record<string, string | string[] | boolean | Record<string, string> | undefined>
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>
}

interface RoutineToolLike {
  execute: (
    toolCallId: string,
    params: {
      name: string
      prompt: string
      schedule:
        | { kind: 'once'; delayMinutes?: number; runAt?: number | string }
        | { kind: 'interval'; intervalMinutes: number }
        | { kind: 'weekly'; days: number[]; time: string }
    }
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>
}

/**
 * The suite covers orchestration — dispatch, mention routing, bubble splitting
 * — not a provider, so every bot answers from a scripted model rather than the
 * network. The controller reads the real dispatch prompt and returns a valid
 * decision: the lead first, then one specialist, then stop.
 */
function stubModel(runtime: DouchatRuntime): void {
  vi.spyOn(runtime as any, 'refreshHealth').mockResolvedValue({})
  const internals = runtime as unknown as {
    liveAuth: Map<string, boolean>
    runReply: (options: ReplyOptions) => Promise<{ text: string }>
  }
  for (const provider of ['openai', 'anthropic', 'google', 'openrouter', 'deepseek']) {
    internals.liveAuth.set(provider, true)
  }
  internals.runReply = async ({ config, context, prompt }: ReplyOptions) => {
    if (context !== 'controller') {
      return { text: `${config.name} here.\n<!-- message_break -->\nOn it.` }
    }
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as DecisionPayload
    const stop = { mode: 'none', memberIds: [], triggerMessageIds: [] }
    const latestUser = [...payload.messages].reverse().find((message) => message.role === 'user')
    if (!latestUser) return { text: JSON.stringify(stop) }
    const addressed = payload.members.find(member => latestUser.content?.includes('@' + member.name))
    if (addressed) return { text: JSON.stringify(payload.completedTurns.length ? stop : { mode: 'single', memberIds: [addressed.id], triggerMessageIds: [latestUser.id] }) }
    const answered = new Set(payload.completedTurns.map((turn) => turn.memberId))
    const next = answered.size
      ? payload.members.find((member) => !answered.has(member.id))
      : payload.members.find((member) => member.id === (payload.currentLeaderMemberId ?? payload.leadMember?.id))
    if (!next || answered.size >= 2) return { text: JSON.stringify(stop) }
    return { text: JSON.stringify({ leaderMemberId: payload.currentLeaderMemberId, mode: 'single', memberIds: [next.id], triggerMessageIds: [latestUser.id] }) }
  }
}

function createRuntime(): { store: DouchatStore; runtime: DouchatRuntime } {
  const directory = mkdtempSync(join(tmpdir(), 'douchat-runtime-'))
  directories.push(directory)
  const store = new DouchatStore(join(directory, 'state.json'), { seedDemo: true })
  const runtime = new DouchatRuntime(store, idleComputer, () => undefined)
  stubModel(runtime)
  return { store, runtime }
}

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('DouchatRuntime', () => {
  it('persists IM images and files in the shared conversation and supplies vision input', async () => {
    const { store, runtime } = createRuntime()
    const run = vi.spyOn(runtime as unknown as { runReply: (options: ReplyOptions) => Promise<{ text: string }> }, 'runReply').mockResolvedValue({ text: 'Received' })
    const signal = new AbortController().signal
    await replyToIM(store, runtime, 'dobi', 'tg', 'Describe', signal, 'telegram', [{ name: 'photo.png', image: true, data: Buffer.from('89504e470d0a1a0a', 'hex') }])
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }))
    const topic = store.activeTopicId('direct-dobi')
    const image = store.topicMessages('direct-dobi', topic).find(m => m.text === 'Describe')!
    expect(image.sourceChannel).toBe('telegram')
    expect(await store.attachmentDataUrl(image.attachments![0].id)).toBe('data:image/png;base64,iVBORw0KGgo=')
    await replyToIM(store, runtime, 'dobi', 'wx', '', signal, 'wechat', [{ name: '../../report (1).txt', image: false, data: Buffer.from('document body') }])
    const file = store.topicMessages('direct-dobi', topic).filter(m => m.authorId === 'user').at(-1)!
    expect(file.sourceChannel).toBe('wechat')
    expect(file.text).toContain('[report (1).txt](<douchat-file:')
    const url = new URL(file.text.match(/<(douchat-file:[^>]+)>/)![1]); url.protocol = 'file:'
    expect(readFileSync(decodeURIComponent(url.pathname), 'utf8')).toBe('document body')
    expect(run.mock.calls.at(-1)![0].prompt).toContain('report (1).txt')
  })

  it('routes all IM transports through the existing contact conversation and shared context', async () => {
    const { store, runtime } = createRuntime()
    const agent = store.agent('dobi')!
    const signal = new AbortController().signal
    const reply = await replyToIM(store, runtime, agent.id, 'telegram-binding', 'TG_PRIVATE_SENTINEL', signal, 'telegram')
    expect(reply).toEqual([`${agent.name} here.`, 'On it.'])
    const telegram = store.ensureIMConversation(agent.id, 'telegram-binding')
    expect(store.topicMessages(telegram.id, telegram.activeTopicId).some(m => m.text === 'TG_PRIVATE_SENTINEL')).toBe(true)
    expect(store.ensureDirectConversation(agent.id).conversation.id).toBe('direct-dobi')
    const model = vi.spyOn(runtime as any, 'runReply')
    await replyToIM(store, runtime, agent.id, 'wechat-binding', 'WX_PRIVATE_SENTINEL', signal, 'wechat')
    expect(model.mock.calls.some(([options]) => (options as ReplyOptions).prompt.includes('TG_PRIVATE_SENTINEL'))).toBe(true)
    expect(store.ensureIMConversation(agent.id, 'wechat-binding').id).toBe(telegram.id)
    expect(telegram.id).toBe('direct-dobi')
    expect(store.messages.find(m => m.text === 'TG_PRIVATE_SENTINEL')?.sourceChannel).toBe('telegram')
    expect(store.messages.find(m => m.text === 'WX_PRIVATE_SENTINEL')?.sourceChannel).toBe('wechat')
    expect(store.accountConversations.filter(c => c.type === 'direct' && c.agentIds[0] === agent.id)).toHaveLength(1)
    model.mockClear()
    await replyToIM(store, runtime, agent.id, 'telegram-binding', 'Continue', signal)
    expect(model.mock.calls.some(([options]) => (options as ReplyOptions).prompt.includes('TG_PRIVATE_SENTINEL'))).toBe(true)
    const aborted = new AbortController(); aborted.abort()
    await expect(replyToIM(store, runtime, agent.id, 'telegram-binding', 'cancelled', aborted.signal)).rejects.toThrow('disconnected')
    store.setCurrentAccountId('another-owner')
    await expect(replyToIM(store, runtime, agent.id, 'telegram-binding', 'wrong owner', signal)).rejects.toThrow('Contact not found')
    store.close()
  })

  it('handles simultaneous channel and desktop messages and returns only each channel answer', async () => {
    const { store, runtime } = createRuntime()
    vi.spyOn(runtime as any, 'runReply').mockImplementation(async (options: any) => ({ text: `Answer ${options.routineRequest}` }))
    const first = replyToIM(store, runtime, 'dobi', 'tg', 'ONE', new AbortController().signal)
    const desktop = runtime.sendMessage('direct-dobi', 'TWO')
    const second = replyToIM(store, runtime, 'dobi', 'wx', 'THREE', new AbortController().signal)
    const [one, , three] = await Promise.all([first, desktop, second])
    expect(one).toEqual(['Answer ONE'])
    expect(one).not.toContain('THREE')
    expect(three).toEqual(['Answer THREE'])
    const users = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi')).filter(m => m.authorId === 'user').map(m => m.text)
    expect(users.slice(-3)).toEqual(expect.arrayContaining(['ONE', 'TWO', 'THREE']))
    store.close()
  })

  it('cancels a queued channel request without stopping another channel turn', async () => {
    const { store, runtime } = createRuntime()
    const controller = new AbortController()
    const first = replyToIM(store, runtime, 'dobi', 'tg', 'FIRST', new AbortController().signal)
    const queued = replyToIM(store, runtime, 'dobi', 'wx', 'CANCELLED', controller.signal)
    controller.abort()
    await expect(queued).rejects.toThrow()
    expect(await first).toContain('Dobi here.')
    expect(store.messages.some(m => m.text === 'CANCELLED')).toBe(false)
    store.close()
  })

  it.each(['direct-dobi', 'crew'])('starts new model context while keeping the visible transcript in %s', async (conversationId) => {
    const { store, runtime } = createRuntime()
    const topicId = store.activeTopicId(conversationId)
    store.addMessage({ conversationId, topicId, authorId: 'user', authorName: 'You', text: 'OLD_RESET_SENTINEL', kind: 'message' })
    const model = vi.spyOn(runtime as any, 'runReply')
    runtime.resetConversation(conversationId, topicId)
    store.resetConversationContext(conversationId, topicId)
    expect(store.topicMessages(conversationId, topicId).at(-1)).toMatchObject({ kind: 'system', text: 'Context reset' })
    await runtime.sendMessage(conversationId, 'Hello again')
    expect(model).toHaveBeenCalled()
    expect(model.mock.calls.every(([options]) => !(options as ReplyOptions).prompt.includes('OLD_RESET_SENTINEL'))).toBe(true)
    expect(store.topicMessages(conversationId, topicId).some(message => message.text === 'OLD_RESET_SENTINEL')).toBe(true)
    expect(store.contextMessages(conversationId, topicId).some(message => message.text === 'Hello again')).toBe(true)
  })
  it('keeps private specialist progress out of the caller’s direct chat while allowing group and recipient progress', () => {
    const { store, runtime } = createRuntime()
    const internal = runtime as unknown as {
      setActivity: (conversationId: string, topicId: string, phase: string, ids: string[], label: string, extra?: object, sourceAgentId?: string) => void
      activity: Map<string, { agentIds: string[]; label: string }>
    }
    const topic = store.activeTopicId('direct-dobi')
    internal.setActivity('direct-dobi', topic, 'replying', ['dobi'], 'Contacting Lin')
    const original = internal.activity.get('direct-dobi')
    internal.setActivity('direct-dobi', topic, 'replying', ['lin'], 'Lin reconnecting', {}, 'lin')
    expect(internal.activity.get('direct-dobi')).toBe(original)
    // Tool events inherit the caller's IDs, so source identity must also be checked.
    internal.setActivity('direct-dobi', topic, 'replying', ['dobi'], 'Lin tool', { action: { tool: 'search' } }, 'lin')
    expect(internal.activity.get('direct-dobi')).toBe(original)
    internal.setActivity('direct-lin', store.activeTopicId('direct-lin'), 'replying', ['lin'], 'Lin', {}, 'lin')
    expect(internal.activity.get('direct-lin')?.agentIds).toEqual(['lin'])
    internal.setActivity('crew', store.activeTopicId('crew'), 'replying', ['lin'], 'Lin', {}, 'lin')
    expect(internal.activity.get('crew')?.agentIds).toEqual(['lin'])
  })

  it.each(['agent', 'conversation'] as const)('disposes a busy %s session without resetting an active agent', (scope) => {
    const { runtime } = createRuntime()
    const reset = vi.fn(() => { throw new Error('Agent is already processing') })
    const key = 'direct:direct-dobi:topic-1'
    const replacement = { agentId: 'dobi', agent: { abort: vi.fn(), reset } }
    const sessions = (runtime as unknown as {
      sessions: Map<string, typeof replacement>
    }).sessions
    const abort = vi.fn(() => {
      expect(sessions.has(key)).toBe(false)
      // A new request arriving during cancellation must keep its fresh session.
      sessions.set(key, replacement)
    })
    sessions.set(key, { agentId: 'dobi', agent: { abort, reset } })
    const other = { agentId: 'other', agent: { abort: vi.fn(), reset } }
    sessions.set('direct:other:topic-1', other)

    expect(() => {
      if (scope === 'agent') runtime.disposeAgent('dobi')
      else runtime.resetConversation('direct-dobi', 'topic-1')
    }).not.toThrow()

    expect(abort).toHaveBeenCalledOnce()
    expect(reset).not.toHaveBeenCalled()
    expect(sessions.get(key)).toBe(replacement)
    expect(sessions.get('direct:other:topic-1')).toBe(other)
    expect(other.agent.abort).not.toHaveBeenCalled()
  })

  it('rejects shared tasks for a different owner or a cancelled session before model execution', async () => {
    const { store, runtime } = createRuntime()
    const agent = store.agents[0]
    await expect(runtime.executeSocialTask('bob', agent.id, 'task', 'Do work', new AbortController().signal)).rejects.toThrow('does not belong')
    const abort = new AbortController()
    abort.abort()
    await expect(runtime.executeSocialTask('local-demo-account', agent.id, 'task', 'Do work', abort.signal)).rejects.toThrow('cancelled')
  })

  it('passes shared task images to the agent as multimodal input', async () => {
    const { store, runtime } = createRuntime()
    const admin = store.ensureDefaultCloudContact('alice', { provider: 'gateway', model: 'default' }).agent!
    const internal = runtime as unknown as { canRunLive: () => Promise<boolean>; runReply: (options: unknown) => Promise<object> }
    vi.spyOn(internal, 'canRunLive').mockResolvedValue(true)
    const reply = vi.spyOn(internal, 'runReply').mockResolvedValue({ text: 'A picture' })
    await runtime.executeSocialTask('alice', admin.id, 'image-input', 'Describe this', new AbortController().signal, '', undefined,
      [{ name: 'photo.png', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }])
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({
      images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]
    }))
  })

  it('lets shared agents read received files and returns generated files without local paths', async () => {
    const { store, runtime } = createRuntime()
    const admin = store.ensureDefaultCloudContact('alice', { provider: 'gateway', model: 'default' }).agent!
    const internals = runtime as any
    vi.spyOn(internals, 'canRunLive').mockResolvedValue(true)
    vi.spyOn(internals, 'runReply').mockImplementation(async (...params: unknown[]) => {
      const options = params[0] as ReplyOptions
      const url = /\]\(<(douchat-file:[^>]+)>\)/.exec(options.prompt)![1]
      internals.replyCancels.set(options.sessionKey, { conversationId: 'social:file-task', abort: new AbortController() })
      const tool = internals.artifactTools(admin.id, options.sessionKey).find((tool: any) => tool.name === 'read_message_file')
      const result = await tool.execute('read', { url })
      expect(JSON.parse(result.content[0].text).content).toBe('shared file contents')
      const link = await store.saveIMFile({ name: 'result.txt', data: Buffer.from('processed') }, 'alice')
      return { text: `Done\n\n${link}` }
    })
    const result = await runtime.executeSocialTask('alice', admin.id, 'file-task', 'Read this', new AbortController().signal, '', undefined, [], [{ name: 'input.txt', base64: Buffer.from('shared file contents').toString('base64') }])
    expect(result).toEqual({ text: 'Done', files: [{ name: 'result.txt', base64: Buffer.from('processed').toString('base64') }] })
    expect(internals.sharedFileUrls.size).toBe(0)
  })

  it('reads an earlier shared file on a later mention while excluding history outside the task context', async () => {
    const { store, runtime } = createRuntime()
    const admin = store.ensureDefaultCloudContact('alice', { provider: 'gateway', model: 'default' }).agent!
    const file = await store.saveIMFile({ name: 'sidepanel.html', data: Buffer.from('<html>side panel</html>') }, 'alice')
    const hidden = await store.saveIMFile({ name: 'old.txt', data: Buffer.from('excluded') }, 'alice')
    store.syncFriendConversation('alice', { id: 'room-files', name: 'Team', kind: 'group', members: [{ id: 'alice', name: 'Alice', email: '' }], agents: [], createdAt: new Date().toISOString() }, [
      { id: 'upload', roomId: 'room-files', authorId: 'alice', authorName: 'Alice', content: file, status: 'sent', createdAt: new Date().toISOString() },
      { id: 'excluded', roomId: 'room-files', authorId: 'alice', authorName: 'Alice', content: hidden, status: 'sent', createdAt: new Date().toISOString() }
    ])
    const internals = runtime as any
    vi.spyOn(internals, 'canRunLive').mockResolvedValue(true)
    vi.spyOn(internals, 'runReply').mockImplementation(async (...params: unknown[]) => {
      const options = params[0] as ReplyOptions
      expect(options.prompt).toContain('fileLinks')
      expect(options.prompt).toContain(file)
      expect(options.prompt).not.toContain(hidden)
      internals.replyCancels.set(options.sessionKey, { conversationId: 'social:followup', abort: new AbortController() })
      const tool = internals.artifactTools(admin.id, options.sessionKey).find((tool: any) => tool.name === 'read_message_file')
      const url = /\]\(<([^>]+)>\)/.exec(file)![1]
      const read = await tool.execute('read', { url })
      expect(JSON.parse(read.content[0].text).content).toBe('<html>side panel</html>')
      await expect(tool.execute('hidden', { url: /\]\(<([^>]+)>\)/.exec(hidden)![1] })).rejects.toThrow('not available')
      return { text: 'This is an HTML side panel.' }
    })
    const context = JSON.stringify({ history: [{ id: 'upload', content: 'What is this?', fileNames: ['sidepanel.html'] }] })
    const result = await runtime.executeSocialTask('alice', admin.id, 'followup', '@Dr. Dou ?', new AbortController().signal, context, { roomId: 'room-files', requesterId: 'alice', requester: 'Alice', roomName: 'Team', delegate: async () => {} })
    expect(result.text).toBe('This is an HTML side panel.')
  })

  it('returns generated image bytes with a shared task reply', async () => {
    const { store, runtime } = createRuntime()
    const admin = store.ensureDefaultCloudContact('alice', { provider: 'gateway', model: 'default' }).agent!
    const image = await store.saveImageAttachment({ name: 'car.png', mimeType: 'image/png', data: Buffer.from('iVBORw0KGgo=', 'base64') }, 'alice')
    const internal = runtime as unknown as { canRunLive: () => Promise<boolean>; runReply: (options: unknown) => Promise<object> }
    vi.spyOn(internal, 'canRunLive').mockResolvedValue(true)
    vi.spyOn(internal, 'runReply').mockResolvedValue({ text: '', attachments: [image] })
    await expect(runtime.executeSocialTask('alice', admin.id, 'image-task', 'Draw', new AbortController().signal)).resolves.toEqual({
      text: '', images: [{ name: 'car.png', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }]
    })
  })

  it('executes the owner’s built-in agent in shared group context', async () => {
    const { store, runtime } = createRuntime()
    const admin = store.ensureDefaultCloudContact('alice', { provider: 'gateway', model: 'default' }).agent!
    const internal = runtime as unknown as { canRunLive: () => Promise<boolean>; runReply: (options: unknown) => Promise<{ text: string }> }
    const reply = vi.spyOn(internal, 'runReply').mockResolvedValue({ text: 'Done' })
    vi.spyOn(internal, 'canRunLive').mockResolvedValue(true)
    expect(await runtime.executeSocialTask('alice', admin.id, 'shared-task', 'Help the group', new AbortController().signal)).toEqual({ text: 'Done' })
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ id: admin.id }), context: 'group' }))
    await expect(runtime.executeSocialTask('bob', admin.id, 'foreign-task', 'Run', new AbortController().signal)).rejects.toThrow('does not belong')
    expect(reply).toHaveBeenCalledTimes(1)
  })

  it('reads the current requester and cancellation signal when reusing shared tools', async () => {
    const { store } = createRuntime()
    const operation = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Done' }], details: {} }))
    const runtime = new DouchatRuntime(store, { ...idleComputer, createTools: () => [{
      name: 'computer_list_files', label: 'Read', description: 'Read', parameters: { type: 'object', properties: {} } as any, execute: operation
    }] }, () => {})
    const internal = runtime as any
    const agent = store.accountAgents[0]
    vi.spyOn(internal, 'resolveModel').mockReturnValue({ id: 'mock', provider: 'mock', api: 'openai-completions' })
    const authorize = vi.spyOn(internal.permissions, 'authorize').mockResolvedValue(undefined)
    const old = new AbortController()
    internal.sharedCallers.set('shared', { requesterId: 'first', requester: 'First', roomName: 'Room', signal: old.signal, delegate: vi.fn() })
    const session = internal.session(agent, 'shared', 'group')
    const tool = session.state.tools.find((item: any) => item.name === 'computer_list_files')
    await tool.execute('first', {})
    old.abort()
    internal.sharedCallers.set('shared', { requesterId: 'second', requester: 'Second', roomName: 'Room', signal: new AbortController().signal, delegate: vi.fn() })
    expect(internal.session(agent, 'shared', 'group')).toBe(session)
    await tool.execute('second', {})
    expect(authorize.mock.calls.map(call => (call[1] as any).requesterId)).toEqual(['first', 'second'])
    internal.sharedCallers.delete('shared')
    await expect(tool.execute('late', {})).rejects.toThrow('No active shared task')
    expect(operation).toHaveBeenCalledTimes(2)
    internal.disposeSession('shared')
  })

  it('guards the actual shared cloud tool invocation and leaves private owner tools separate', async () => {
    const { store } = createRuntime()
    const operation = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'secret' }], details: {} }))
    const runtime = new DouchatRuntime(store, { ...idleComputer, createTools: () => [{
      name: 'computer_list_files', label: 'Read files', description: 'Read files',
      parameters: { type: 'object', properties: {} } as any, execute: operation
    }] }, () => {})
    const agent = store.accountAgents[0]
    const internal = runtime as any
    vi.spyOn(internal, 'resolveModel').mockReturnValue({ id: 'mock', provider: 'mock', api: 'openai-completions' })
    internal.sharedCallers.set('social:task', { requesterId: 'other', requester: 'Other', roomName: 'Group', delegate: vi.fn() })
    const session = internal.session(agent, 'social:task', 'group')
    const guarded = session.state.tools.find((tool: any) => tool.name === 'computer_list_files')
    const work = guarded.execute('tool-id', { directory: 'Documents' })
    expect(operation).not.toHaveBeenCalled()
    runtime.resolveAgentPermission(runtime.snapshot().permissionRequests![0].id, true)
    await work
    expect(operation).toHaveBeenCalledOnce()
    const privateSession = internal.session(agent, 'direct:owner:topic', 'direct')
    await privateSession.state.tools.find((tool: any) => tool.name === 'computer_list_files').execute('private', {})
    expect(operation).toHaveBeenCalledTimes(2)
    expect(runtime.snapshot().permissionRequests).toHaveLength(0)
    const abort = new AbortController()
    const pending = guarded.execute('cancelled-tool', {}, abort.signal)
    const stopped = expect(pending).rejects.toThrow(/abort/i)
    abort.abort()
    await stopped
    expect(operation).toHaveBeenCalledTimes(2)
    expect(runtime.snapshot().permissionRequests).toHaveLength(0)
  })

  it('does not expire a cloud reply while the owner is reviewing a permission request', async () => {
    vi.useFakeTimers()
    const { store } = createRuntime()
    const runtime = new DouchatRuntime(store, idleComputer, () => {})
    const agent = store.accountAgents[0]
    const internal = runtime as any
    const abort = vi.fn()
    vi.spyOn(internal, 'session').mockReturnValue({
      abort,
      state: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Approved result' }] }] },
      prompt: () => internal.permissions.authorize(agent, { requester: 'Friend', roomName: 'Group', capability: 'filesRead', operation: 'read', details: '{}' })
    })
    let completed = false
    const result = internal.runReply({ config: agent, sessionKey: 'social:approval', context: 'group', prompt: 'Read', conversationId: 'crew', topicId: 'main' }).then((reply: any) => { completed = true; return reply })
    try {
      await vi.advanceTimersByTimeAsync(180_000)
      expect(completed).toBe(false)
      expect(abort).not.toHaveBeenCalled()
      runtime.resolveAgentPermission(runtime.snapshot().permissionRequests![0].id, true)
      expect((await result).text).toBe('Approved result')
    } finally { runtime.disposeAgent(agent.id); vi.useRealTimers() }
  })

  it.each(['direct', 'group'] as const)('allows ongoing model/tool rounds beyond 120 seconds in %s chat', async context => {
    vi.useFakeTimers()
    const { store } = createRuntime()
    const runtime = new DouchatRuntime(store, idleComputer, () => {})
    const internal = runtime as any, config = store.accountAgents[0]
    let emit: (event: any) => void = () => {}
    let finish!: () => void
    const unsubscribe = vi.fn()
    const session = {
      state: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'PPT ready' }] }] },
      abort: vi.fn(), subscribe: vi.fn((listener: typeof emit) => { emit = listener; return unsubscribe }),
      prompt: vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    }
    vi.spyOn(internal, 'session').mockReturnValue(session)
    internal.sessions.set('active-tools', { agentId: config.id, agent: session })
    const pending = internal.runReply({ config, sessionKey: 'active-tools', context, timeoutMs: 120_000,
      prompt: 'Build a PPT', conversationId: 'crew', topicId: 'main' })
    try {
      await vi.advanceTimersByTimeAsync(0)
      for (let index = 0; index < 4; index++) {
        await vi.advanceTimersByTimeAsync(60_000)
        emit({ type: 'message_update' })
        emit({ type: 'tool_execution_start', toolCallId: `tool-${index}` })
        // A long tool/approval interval must not consume model response time.
        await vi.advanceTimersByTimeAsync(150_000)
        emit({ type: 'tool_execution_end', toolCallId: `tool-${index}` })
      }
      expect(session.abort).not.toHaveBeenCalled()
      finish()
      await expect(pending).resolves.toMatchObject({ text: 'PPT ready' })
      expect(session.prompt).toHaveBeenCalledOnce()
      expect(unsubscribe).toHaveBeenCalledOnce()
    } finally { runtime.disposeAgent(config.id); vi.useRealTimers() }
  })

  it('keeps parallel tools paused, then times out a genuinely silent model after the final tool', async () => {
    vi.useFakeTimers()
    const { store } = createRuntime()
    const runtime = new DouchatRuntime(store, idleComputer, () => {})
    const internal = runtime as any, config = store.accountAgents[0]
    let emit: (event: any) => void = () => {}
    const unsubscribe = vi.fn()
    const session = { state: { messages: [] }, abort: vi.fn(),
      subscribe: (listener: typeof emit) => { emit = listener; return unsubscribe },
      prompt: vi.fn(() => new Promise<void>(() => {})) }
    vi.spyOn(internal, 'session').mockReturnValue(session)
    internal.sessions.set('parallel-tools', { agentId: config.id, agent: session })
    let completed = false
    const pending = internal.runReply({ config, sessionKey: 'parallel-tools', context: 'group', timeoutMs: 120_000,
      prompt: 'Build a PPT', conversationId: 'crew', topicId: 'main' }).then((reply: any) => { completed = true; return reply })
    try {
      await vi.advanceTimersByTimeAsync(0)
      emit({ type: 'tool_execution_start', toolCallId: 'first' })
      emit({ type: 'tool_execution_start', toolCallId: 'second' })
      await vi.advanceTimersByTimeAsync(150_000)
      emit({ type: 'tool_execution_end', toolCallId: 'first' })
      await vi.advanceTimersByTimeAsync(150_000)
      expect(completed).toBe(false)
      emit({ type: 'tool_execution_end', toolCallId: 'second' })
      await vi.advanceTimersByTimeAsync(119_999)
      expect(completed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ error: 'The model response timed out after 120 seconds.' })
      expect(session.abort).toHaveBeenCalledOnce()
      expect(session.prompt).toHaveBeenCalledOnce()
      expect(unsubscribe).toHaveBeenCalledOnce()
    } finally { runtime.disposeAgent(config.id); vi.useRealTimers() }
  })

  it('requires an explicit execution grant before starting an externally requested local agent', async () => {
    const { store, runtime } = createRuntime()
    const agent = store.createAgent({ name: 'Local', role: '', instructions: '', color: '', provider: 'local', model: 'default', localAgentId: 'codex' })
    const internal = runtime as any
    const reply = vi.spyOn(internal, 'runReply').mockResolvedValue({ text: 'Done' })
    vi.spyOn(internal, 'canRunLive').mockResolvedValue(true)
    const result = runtime.executeSocialTask(store.currentAccountId!, agent.id, 'external-local', 'Read a file', new AbortController().signal, '', {
      requesterId: 'other', requester: 'Other', roomName: 'Group', delegate: vi.fn()
    })
    const rejected = expect(result).rejects.toThrow('declined')
    await vi.waitFor(() => expect(runtime.snapshot().permissionRequests).toHaveLength(1))
    expect(runtime.snapshot().permissionRequests![0].capability).toBe('localExecution')
    expect(reply).not.toHaveBeenCalled()
    runtime.resolveAgentPermission(runtime.snapshot().permissionRequests![0].id, false)
    await rejected
    expect(reply).not.toHaveBeenCalled()
  })

  it('creates a persistent routine from a top-level chat tool and prevents duplicates', async () => {
    const { store, runtime } = createRuntime()
    const agent = store.agents[0]
    const conversation = store.conversations.find(
      (item) => item.type === 'direct' && item.agentIds.includes(agent.id)
    )!
    let createCount = 0
    runtime.setInterfaceLanguage('zh-CN')
    runtime.setRoutineCreator((input) => {
      createCount += 1
      const nextRunAt = input.schedule.kind === 'once'
        ? input.schedule.runAt
        : Date.now() + 60_000
      return store.createRoutine(input, nextRunAt)
    })
    const internals = runtime as unknown as {
      activeConversation: Map<string, string>
      routineTool: (config: NonNullable<ReturnType<DouchatStore['agent']>>) => RoutineToolLike
      systemPrompt: (
        config: NonNullable<ReturnType<DouchatStore['agent']>>,
        context: 'direct' | 'group' | 'controller',
        routineCreationAllowed: boolean
      ) => string
    }
    internals.activeConversation.set(agent.id, conversation.id)
    const tool = internals.routineTool(agent)
    const input = {
      name: '跟进峰会结果',
      prompt: '检查峰会结果，有新消息时给出来源和摘要。',
      schedule: { kind: 'weekly' as const, days: [6, 0, 4, 2, 5, 3, 1], time: '09:00' }
    }

    const created = await tool.execute('routine-1', input)

    expect(createCount).toBe(1)
    expect(store.routines).toHaveLength(1)
    expect(store.routines[0]).toMatchObject({
      name: input.name,
      prompt: input.prompt,
      agentId: agent.id,
      conversationId: conversation.id,
      schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' },
      enabled: true
    })
    expect(created.details).toMatchObject({ created: true, routineId: store.routines[0].id })
    expect(created.content[0].text).toContain('已创建自动任务“跟进峰会结果”')
    expect(created.content[0].text).toContain('每天 09:00')
    expect(created.content[0].text).toContain(`结果会推送到“${conversation.name}”`)

    const duplicate = await tool.execute('routine-2', input)
    expect(createCount).toBe(1)
    expect(store.routines).toHaveLength(1)
    expect(duplicate.details).toMatchObject({ created: false, existing: true, routineId: store.routines[0].id })
    expect(duplicate.content[0].text).toContain('已经存在，没有重复创建')

    const beforeReminder = Date.now()
    const reminder = await tool.execute('routine-3', {
      name: '喝水提醒',
      prompt: '提醒用户喝水。',
      schedule: { kind: 'once', delayMinutes: 5 }
    })
    expect(createCount).toBe(2)
    expect(reminder.details).toMatchObject({ created: true })
    const reminderRoutine = store.routines.find((routine) => routine.name === '喝水提醒')!
    expect(reminderRoutine.schedule.kind).toBe('once')
    expect(reminderRoutine.nextRunAt).toBeGreaterThanOrEqual(beforeReminder + 5 * 60_000)
    expect(reminderRoutine.nextRunAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000)
    expect(reminder.content[0].text).toContain('仅执行一次')

    const prompt = internals.systemPrompt(agent, 'direct', true)
    expect(prompt).toContain('original language')
    expect(prompt).toContain('only when the human requests it')
    expect(prompt).toContain('every day at 09:00')
    expect(internals.systemPrompt(agent, 'controller', true)).not.toContain('create_routine')
  })

  it('marks an empty scheduled response as failed and shows a localized error', async () => {
    const { store, runtime } = createRuntime()
    runtime.setInterfaceLanguage('zh-CN')
    const agent = store.agents[0]
    const conversation = store.conversations.find((item) => item.agentIds.includes(agent.id))!
    const routine = store.createRoutine({
      name: '一分钟后发笑话',
      prompt: '给用户发一个短笑话。',
      agentId: agent.id,
      conversationId: conversation.id,
      schedule: { kind: 'once', runAt: Date.now() + 60_000 },
      timezone: 'Asia/Shanghai'
    }, Date.now() + 60_000)
    const internals = runtime as unknown as {
      runReply: () => Promise<{ text: string; error?: string; attachments?: []; actions?: [] }>
    }
    internals.runReply = async () => ({ text: '', error: `${agent.name} finished without a text response.` })

    await expect(runtime.runRoutine(routine, 'schedule')).rejects.toThrow('finished without a text response')

    expect(store.runs[0]).toMatchObject({ routineId: routine.id, status: 'failed' })
    expect(store.runs[0].error).toContain('finished without a text response')
    expect(store.messages.at(-1)).toMatchObject({
      authorName: 'Douchat',
      kind: 'system',
      text: '自动任务“一分钟后发笑话”执行失败：智能体没有返回任何内容。'
    })
  })

  it('lets only the current account system administrator create and edit agents', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-runtime-management-'))
    directories.push(directory)
    const store = new DouchatStore(join(directory, 'state.json'))
    const defaultAgent = store.ensureDefaultCloudContact('account-1', {
      provider: 'gateway',
      model: 'default'
    }).agent!
    const avatar = 'data:image/png;base64,aGVsbG8='
    const runtime = new DouchatRuntime(store, idleComputer, () => undefined, {
      baseUrl: 'http://localhost:3004/v1',
      resolveAccessToken: () => 'dch_current',
      avatarFromImage: () => avatar
    })
    const internals = runtime as unknown as {
      activeInputImages: Map<string, Array<{ type: 'image'; data: string; mimeType: string }>>
      agentManagementTools: (config: NonNullable<ReturnType<DouchatStore['agent']>>) => AgentManagementToolLike[]
    }
    internals.activeInputImages.set(defaultAgent.id, [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }])

    const tools = internals.agentManagementTools(defaultAgent)
    expect(tools.map((tool) => tool.name)).toEqual(['read_agent_configuration', 'update_group', 'create_group', 'create_agent', 'update_agent'])
    const originalGroup = store.createGroup({ name: '闲聊小群', agentIds: [defaultAgent.id] })
    store.addMessage({ conversationId: originalGroup.id, topicId: originalGroup.activeTopicId, authorId: defaultAgent.id, authorName: defaultAgent.name, text: 'History stays', kind: 'message' })
    const groupCount = store.accountConversations.filter((item) => item.type === 'group').length
    const updateGroup = tools.find((tool) => tool.name === 'update_group')!
    await updateGroup.execute('rename', { group: originalGroup.id, name: '三国英雄', emoji: '⚔️' })
    expect(store.conversation(originalGroup.id)).toMatchObject({ name: '三国英雄', avatarEmoji: '⚔️', agentIds: [defaultAgent.id] })
    expect(store.topicMessages(originalGroup.id, originalGroup.activeTopicId)[0].text).toBe('History stays')
    expect(store.accountConversations.filter((item) => item.type === 'group')).toHaveLength(groupCount)
    await updateGroup.execute('image', { group: '三国英雄', avatar: 'attached' })
    expect(store.conversation(originalGroup.id)?.avatar).toBe(avatar)
    expect(store.conversation(originalGroup.id)?.avatarEmoji).toBeUndefined()
    await updateGroup.execute('remove', { group: originalGroup.id, avatar: 'remove' })
    expect(store.conversation(originalGroup.id)?.avatar).toBeUndefined()
    await expect(updateGroup.execute('invalid', { group: originalGroup.id, name: 'wrong', emoji: 'not emoji' })).rejects.toThrow()
    expect(store.conversation(originalGroup.id)?.name).toBe('三国英雄')
    store.createGroup({ name: '三国英雄', agentIds: [defaultAgent.id] })
    await expect(updateGroup.execute('ambiguous', { group: '三国英雄', name: 'oops' })).rejects.toThrow()
    const create = tools.find((tool) => tool.name === 'create_agent')!
    const createdResult = await create.execute('create-1', { name: 'Researcher', avatar: 'attached', systemFiles: { 'SOUL.md': 'Be precise.', 'IDENTITY.md': 'I am Researcher.' } })
    const createdId = createdResult.details.agentId as string
    await updateGroup.execute('add-member', { group: originalGroup.id, addAgents: ['Researcher', createdId] })
    expect(store.conversation(originalGroup.id)?.agentIds).toEqual([defaultAgent.id, createdId])
    await expect(updateGroup.execute('atomic', { group: originalGroup.id, name: 'must not change', addAgents: ['missing'] })).rejects.toThrow()
    expect(store.conversation(originalGroup.id)?.name).toBe('三国英雄')
    await updateGroup.execute('remove-leader', { group: originalGroup.id, removeAgents: [defaultAgent.id] })
    expect(store.conversation(originalGroup.id)).toMatchObject({ agentIds: [createdId], leadAgentId: createdId })
    expect(store.agent(defaultAgent.id)).toBeDefined()
    expect(store.topicMessages(originalGroup.id, originalGroup.activeTopicId)[0].text).toBe('History stays')
    await expect(updateGroup.execute('empty', { group: originalGroup.id, removeAgents: [createdId] })).rejects.toThrow('at least one')

    const groupResult = await tools.find((tool) => tool.name === 'create_group')!.execute('group-1', { name: '我们三', agents: ['Researcher'] })
    const group = store.conversation(groupResult.details.conversationId as string)!
    expect(group).toMatchObject({ name: '我们三', type: 'group', ownerId: 'account-1' })
    expect(group.agentIds).toEqual([defaultAgent.id, createdId])
    await expect(tools.find((tool) => tool.name === 'create_group')!.execute('group-bad', { name: 'Bad', agents: ['Missing'] })).rejects.toThrow('No agent')

    expect(createdResult.details.created).toBe(true)
    expect(store.agent(createdId)?.systemFiles).toEqual({ 'SOUL.md': 'Be precise.', 'IDENTITY.md': 'I am Researcher.' })
    expect(createdResult.content[0].text).toContain('SOUL.md')
    const read = tools.find(tool => tool.name === 'read_agent_configuration')!
    expect((await read.execute('read', { agent: createdId })).content[0].text).toContain('I am Researcher.')
    await expect(create.execute('bad-files', { name: 'Invalid', systemFiles: { 'USER.md': 'private' } })).rejects.toThrow('Personal user files')
    expect(store.accountAgents.some(agent => agent.name === 'Invalid')).toBe(false)
    expect(store.agent(createdId)).toMatchObject({
      name: 'Researcher',
      role: 'Assistant',
      instructions: '',
      avatar
    })
    expect(store.conversation(`direct-${createdId}`)?.agentIds).toEqual([createdId])

    const update = tools.find((tool) => tool.name === 'update_agent')!
    const updatedResult = await update.execute('update-1', {
      agent: 'Researcher',
      name: 'Release Scout',
      description: 'Track release notes.',
      systemFiles: { 'IDENTITY.md': 'I am Release Scout.' },
      emoji: '🦊'
    })
    expect(store.agent(createdId)?.systemFiles).toEqual({ 'SOUL.md': 'Be precise.', 'IDENTITY.md': 'I am Release Scout.' })
    expect(updatedResult.details.updated).toBe(true)
    expect(store.agent(createdId)).toMatchObject({
      name: 'Release Scout',
      instructions: 'Track release notes.',
      avatar: '',
      avatarEmoji: '🦊'
    })
    expect(store.conversation(`direct-${createdId}`)?.name).toBe('Release Scout')

    await update.execute('update-2', { agent: 'Release Scout', avatar: 'remove' })
    expect(store.agent(createdId)).toMatchObject({ avatar: '', avatarEmoji: '' })
    expect(internals.agentManagementTools(store.agent(createdId)!)).toEqual([])

    store.deleteConversation(`direct-${defaultAgent.id}`)
    expect(store.defaultConversationId).toBeUndefined()
    expect(store.systemAdminAgentId).toBe(defaultAgent.id)
    expect(internals.agentManagementTools(defaultAgent).map((tool) => tool.name)).toEqual(['read_agent_configuration', 'update_group', 'create_group', 'create_agent', 'update_agent'])
    const withoutCapability = { ...defaultAgent, capabilities: [] }
    expect(internals.agentManagementTools(withoutCapability)).toEqual([])
  })

  it('tells the system administrator to use management tools for contact requests', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-runtime-management-prompt-'))
    directories.push(directory)
    const store = new DouchatStore(join(directory, 'state.json'))
    const defaultAgent = store.ensureDefaultCloudContact('account-1', {
      provider: 'gateway',
      model: 'default'
    }).agent!
    const runtime = new DouchatRuntime(store, idleComputer, () => undefined)
    const prompt = (runtime as unknown as {
      systemPrompt: (agent: NonNullable<ReturnType<DouchatStore['agent']>>, context: 'direct') => string
    }).systemPrompt(defaultAgent, 'direct')

    expect(prompt).toContain('Treat 联系人、智能体、agent, and bot as equivalent')
    expect(prompt).toContain('call create_agent')
    expect(prompt).toContain('call update_agent')
    expect(prompt).toContain('choose one suitable for the agent')
    expect(prompt).toContain('should remain empty unless the human supplies one')
  })

  it('does not grant an earlier account administrator access after switching accounts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-runtime-account-admin-'))
    directories.push(directory)
    const store = new DouchatStore(join(directory, 'state.json'))
    const earlier = store.ensureDefaultCloudContact('account-1', {
      provider: 'gateway',
      model: 'default'
    }).agent!
    const current = store.ensureDefaultCloudContact('account-2', {
      provider: 'gateway',
      model: 'default'
    }).agent!
    const runtime = new DouchatRuntime(store, idleComputer, () => undefined)
    const internals = runtime as unknown as {
      agentManagementTools: (config: NonNullable<ReturnType<DouchatStore['agent']>>) => AgentManagementToolLike[]
    }

    expect(earlier.systemRole).toBe('admin')
    expect(current.systemRole).toBe('admin')
    expect(internals.agentManagementTools(earlier)).toEqual([])
    expect(internals.agentManagementTools(current).map((tool) => tool.name)).toEqual(['read_agent_configuration', 'update_group', 'create_group', 'create_agent', 'update_agent'])
  })

  it('asks agents to preserve verified local files as reopenable history links', () => {
    const { store, runtime } = createRuntime()
    const prompt = (runtime as unknown as {
      systemPrompt: (agent: NonNullable<ReturnType<DouchatStore['agent']>>, context: 'direct') => string
    }).systemPrompt(store.agent('dobi')!, 'direct')

    expect(prompt).toContain('[filename](<douchat-file:///absolute/path>)')
    expect(prompt).toContain('Do not create a local-file link for an unverified path')
    expect(prompt).toContain('Only access local files when the human explicitly asks')
    expect(prompt).toContain('otherwise ask for permission before calling a local-file tool')
  })

  it('returns to the ordinary reply loader after a tool action completes', () => {
    const { runtime } = createRuntime()
    const activityRuntime = runtime as unknown as {
      setActivity: (
        conversationId: string,
        topicId: string,
        phase: 'replying',
        agentIds: string[],
        label: string,
        extra?: { action?: { id: string; tool: string; status: 'running' } }
      ) => void
    }

    activityRuntime.setActivity('direct-dobi', 'topic-1', 'replying', ['dobi'], 'Dr. Dou', {
      action: { id: 'tool-1', tool: 'computer_list_files', status: 'running' }
    })
    expect(runtime.snapshot().activity[0]?.action?.status).toBe('running')

    activityRuntime.setActivity('direct-dobi', 'topic-1', 'replying', ['dobi'], 'Dr. Dou', { action: undefined })
    expect(runtime.snapshot().activity[0]?.action).toBeUndefined()
  })

  it('loads Cloud models with the desktop token and removes them on sign-out', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-runtime-cloud-'))
    directories.push(directory)
    const store = new DouchatStore(join(directory, 'state.json'), { seedDemo: true })
    let token: string | undefined = 'dch_current'
    const request = vi.fn(async () => Response.json({
      object: 'list',
      data: [{
        id: 'douchat-default',
        display_name: 'Douchat Cloud',
        model_type: 'chat',
        capabilities: ['chat.completions', 'streaming', 'tools']
      }]
    }))
    vi.stubGlobal('fetch', request)
    const runtime = new DouchatRuntime(store, idleComputer, () => undefined, {
      baseUrl: 'http://localhost:3004/v1',
      resolveAccessToken: () => token
    })

    expect(runtime.defaultCloudAgentModel()).toEqual({ provider: 'gateway', model: 'default' })
    await runtime.connect()
    expect(runtime.snapshot().models).toEqual([
      { provider: 'gateway', model: 'douchat-default', label: 'Douchat Cloud' }
    ])
    expect(runtime.defaultCloudAgentModel()).toEqual({ provider: 'gateway', model: 'douchat-default' })
    expect(runtime.snapshot().endpoint).toMatchObject({ source: 'account', hasApiKey: true })

    token = undefined
    await runtime.connect()
    expect(runtime.snapshot().models).toEqual([])
    expect(runtime.defaultCloudAgentModel()).toEqual({ provider: 'gateway', model: 'default' })
    expect(runtime.snapshot().endpoint).toMatchObject({ source: 'account', hasApiKey: false })
    expect(request).toHaveBeenCalledOnce()
  })

  it('retries Cloud model discovery when a signed-in chat is still offline', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-runtime-retry-'))
    directories.push(directory)
    const store = new DouchatStore(join(directory, 'state.json'), { seedDemo: true })
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ object: 'list', data: [] }))
      .mockResolvedValueOnce(Response.json({ object: 'list', data: [{ id: 'cloud-default', object: 'model' }] }))
    vi.stubGlobal('fetch', request)
    const runtime = new DouchatRuntime(store, idleComputer, () => undefined, {
      baseUrl: 'http://localhost:3004/v1',
      resolveAccessToken: () => 'dch_current'
    })

    await runtime.connect()
    expect(runtime.snapshot().runtime.mode).toBe('offline')

    const reconnectable = runtime as unknown as {
      canRunLive: (agent: NonNullable<ReturnType<DouchatStore['agent']>>) => Promise<boolean>
    }
    expect(await reconnectable.canRunLive(store.agent('dobi')!)).toBe(true)
    expect(runtime.snapshot().runtime.mode).toBe('live')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([['Request was aborted', false], ['Request aborted', false], ['Request aborted', true]] as const)('resumes an interrupted tool turn without replaying tools: %s, thrown=%s', async (errorMessage, thrown) => {
    vi.useFakeTimers()
    try {
      const directory = mkdtempSync(join(tmpdir(), 'douchat-runtime-stream-retry-'))
      directories.push(directory)
      const store = new DouchatStore(join(directory, 'state.json'), { seedDemo: true })
      const runtime = new DouchatRuntime(store, idleComputer, () => undefined)
      const config = store.agent('dobi')!
      const state = { messages: [] as Array<Record<string, unknown>> }
      const prompt = vi.fn(async (input: string) => {
        state.messages = [
          { role: 'user', content: [{ type: 'text', text: input }] },
          { role: 'assistant', content: [{ type: 'toolCall', id: 'create-1', name: 'create_group', arguments: {} }] },
          { role: 'toolResult', toolCallId: 'create-1', toolName: 'create_group', content: [{ type: 'text', text: 'Group created' }] },
          { role: 'assistant', content: [], errorMessage }
        ]
        if (thrown) {
          state.messages.pop()
          throw new Error(errorMessage)
        }
      })
      const resume = vi.fn(async () => {
        state.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Recovered reply' }] })
      })
      const session = { state, prompt, continue: resume, abort: vi.fn() }
      const internals = runtime as unknown as {
        sessions: Map<string, { agentId: string; agent: typeof session }>
        runReply: (options: {
          config: typeof config
          sessionKey: string
          context: 'direct'
          prompt: string
          conversationId: string
          topicId: string
        }) => Promise<{ text: string; error?: string }>
      }
      internals.sessions.set('retry-session', { agentId: config.id, agent: session })

      const replyPromise = internals.runReply({
        config,
        sessionKey: 'retry-session',
        context: 'direct',
        prompt: 'Play some music.',
        conversationId: 'direct-dobi',
        topicId: store.activeTopicId('direct-dobi')
      })
      await vi.advanceTimersByTimeAsync(400)

      await expect(replyPromise).resolves.toEqual({ text: 'Recovered reply', retryCount: 1 })
      expect(prompt).toHaveBeenCalledOnce()
      expect(resume).toHaveBeenCalledOnce()
      expect(state.messages.filter((message) => message.role === 'toolResult')).toHaveLength(1)
      expect(state.messages.some((message) => message.errorMessage === errorMessage)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([false, true])('retries empty HTTP 500 responses three times, recovering=%s', async (recover) => {
    vi.useFakeTimers()
    try {
      const directory = mkdtempSync(join(tmpdir(), 'douchat-runtime-500-'))
      directories.push(directory)
      const store = new DouchatStore(join(directory, 'state.json'), { seedDemo: true })
      const runtime = new DouchatRuntime(store, idleComputer, () => undefined)
      const config = store.agent('dobi')!
      const failed = () => ({ role: 'assistant', content: [], errorMessage: '500 status code (no body)' })
      const state = { messages: [] as Array<Record<string, unknown>> }
      const prompt = vi.fn(async () => { state.messages = [{ role: 'user', content: 'Start' }, { role: 'toolResult', content: 'Already created the group' }, failed()] })
      const resume = vi.fn(async () => {
        expect(state.messages.at(-1)?.role).toBe('toolResult')
        state.messages.push(recover && resume.mock.calls.length === 3
          ? { role: 'assistant', content: [{ type: 'text', text: 'Recovered' }] } : failed())
      })
      const session = { state, prompt, continue: resume, abort: vi.fn() }
      const internals = runtime as unknown as {
        sessions: Map<string, { agentId: string; agent: typeof session }>
        runReply: (options: object) => Promise<{ text: string; error?: string; retryCount?: number }>
      }
      internals.sessions.set('retry-500', { agentId: config.id, agent: session })
      const pending = internals.runReply({ config, sessionKey: 'retry-500', context: 'direct', prompt: 'Start', conversationId: 'direct-dobi', topicId: store.activeTopicId('direct-dobi') })
      await vi.advanceTimersByTimeAsync(400)
      expect(resume).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(800)
      expect(resume).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1600)
      const reply = await pending
      expect(resume).toHaveBeenCalledTimes(3)
      expect(prompt).toHaveBeenCalledOnce()
      expect(reply.retryCount).toBe(3)
      expect(reply.text).toBe(recover ? 'Recovered' : '')
      if (!recover) expect(reply.error).toBe('500 status code (no body)')
    } finally { vi.useRealTimers() }
  })

  it('defers a background agent refresh until the active reply completes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-refresh-'))
    directories.push(directory)
    const store = new DouchatStore(join(directory, 'state.json'), { seedDemo: true })
    const runtime = new DouchatRuntime(store, idleComputer, () => undefined)
    const config = store.agent('dobi')!
    let finish!: () => void
    const session = {
      state: { messages: [] as Array<Record<string, unknown>> },
      prompt: vi.fn(() => new Promise<void>(resolve => { finish = () => {
        session.state.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Here are your files.' }] })
        resolve()
      } })),
      abort: vi.fn()
    }
    const internals = runtime as any
    internals.sessions.set('refresh-session', { agentId: config.id, agent: session })
    const pending = internals.runReply({ config, sessionKey: 'refresh-session', context: 'direct', prompt: 'List files',
      conversationId: 'direct-dobi', topicId: store.activeTopicId('direct-dobi') })
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce())
    runtime.refreshAgent(config.id)
    runtime.refreshAgent(config.id)
    expect(session.abort).not.toHaveBeenCalled()
    expect(internals.sessions.has('refresh-session')).toBe(true)
    finish()
    await expect(pending).resolves.toMatchObject({ text: 'Here are your files.', error: undefined })
    expect(internals.sessions.has('refresh-session')).toBe(false)
    expect(internals.pendingSessionRefresh.has(config.id)).toBe(false)
    expect(session.abort).toHaveBeenCalledOnce()
    store.close()
  })

  it('refreshes idle cached sessions without stopping the agent computer', () => {
    const { store, runtime } = createRuntime()
    const abort = vi.fn()
    const stop = vi.spyOn(idleComputer, 'stop')
    const internals = runtime as any
    internals.sessions.set('idle-refresh', { agentId: 'dobi', agent: { abort } })
    runtime.refreshAgent('dobi')
    expect(abort).toHaveBeenCalledOnce()
    expect(internals.sessions.has('idle-refresh')).toBe(false)
    expect(stop).not.toHaveBeenCalled()
    stop.mockRestore()
    store.close()
  })

  it.each(['signal', 'conversation'])('cancels a stalled model through %s even when the provider ignores abort', async (method) => {
    const directory = mkdtempSync(join(tmpdir(), 'douchat-cancel-'))
    directories.push(directory)
    const store = new DouchatStore(join(directory, 'state.json'), { seedDemo: true })
    const runtime = new DouchatRuntime(store, idleComputer, () => undefined)
    const config = store.agent('dobi')!
    const session = {
      state: { messages: [] },
      prompt: vi.fn(() => new Promise<void>(() => undefined)),
      abort: vi.fn()
    }
    const internals = runtime as unknown as {
      sessions: Map<string, { agentId: string; agent: typeof session }>
      runReply: (options: object) => Promise<{ text: string; error?: string }>
      busyAgents: Set<string>
    }
    internals.sessions.set('cancel-me', { agentId: config.id, agent: session })
    const abort = new AbortController()
    const pending = internals.runReply({ config, sessionKey: 'cancel-me', context: 'direct', prompt: 'Hello',
      conversationId: 'direct-dobi', topicId: store.activeTopicId('direct-dobi'), signal: abort.signal })
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce())
    if (method === 'signal') abort.abort()
    else runtime.stopConversation('direct-dobi')
    await expect(pending).resolves.toMatchObject({ text: '', error: 'Reply stopped' })
    expect(session.abort).toHaveBeenCalled()
    expect(internals.sessions.has('cancel-me')).toBe(false)
    expect(internals.busyAgents.has(config.id)).toBe(false)
  })

  it('stops a stalled group coordinator instead of leaving the chat loading forever', async () => {
    vi.useFakeTimers()
    try {
      const directory = mkdtempSync(join(tmpdir(), 'douchat-runtime-controller-timeout-'))
      directories.push(directory)
      const store = new DouchatStore(join(directory, 'state.json'), { seedDemo: true })
      const runtime = new DouchatRuntime(store, idleComputer, () => undefined)
      const config = store.agent('dobi')!
      const state = { messages: [] as Array<Record<string, unknown>> }
      const prompt = vi.fn(() => new Promise<void>(() => undefined))
      const session = { state, prompt, continue: vi.fn(async () => undefined), abort: vi.fn() }
      const internals = runtime as unknown as {
        sessions: Map<string, { agentId: string; agent: typeof session }>
        runReply: (options: {
          config: typeof config
          sessionKey: string
          context: 'controller'
          prompt: string
          conversationId: string
          topicId: string
        }) => Promise<{ text: string; error?: string }>
      }
      internals.sessions.set('stalled-controller', { agentId: config.id, agent: session })

      const replyPromise = internals.runReply({
        config,
        sessionKey: 'stalled-controller',
        context: 'controller',
        prompt: 'Choose a group member.',
        conversationId: 'crew',
        topicId: store.activeTopicId('crew')
      })
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(replyPromise).resolves.toEqual({
        text: '',
        error: 'The model response timed out after 30 seconds.'
      })
      expect(session.abort).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs a group turn with the lead first and splits replies into bubbles', async () => {
    const { store, runtime } = createRuntime()
    const topicId = store.activeTopicId('crew')
    const before = store.topicMessages('crew', topicId).length

    await runtime.sendMessage('crew', 'plan the launch')

    const added = store.topicMessages('crew', topicId).slice(before)
    expect(added[0]).toMatchObject({ authorId: 'user', text: 'plan the launch' })
    const speakers = added.filter((message) => message.authorId !== 'user').map((message) => message.authorId)
    expect(speakers[0]).toBe('dobi')
    expect(new Set(speakers)).toEqual(new Set(['dobi', 'lin']))
    // One model turn becomes several conversational bubbles that share a turn id.
    const dobiBubbles = added.filter((message) => message.authorId === 'dobi')
    expect(dobiBubbles.length).toBeGreaterThan(1)
    expect(new Set(dobiBubbles.map((message) => message.replyGroupId)).size).toBe(1)
  })

  it('keeps the healthy leader for a contextual follow-up', async () => {
    const { store, runtime } = createRuntime()
    const topicId = store.activeTopicId('crew')
    await runtime.sendMessage('crew', 'plan the launch')
    const before = store.topicMessages('crew', topicId).length

    await runtime.sendMessage('crew', 'what happened next?')

    const added = store.topicMessages('crew', topicId).slice(before)
    expect(added[0]).toMatchObject({ authorId: 'user', text: 'what happened next?' })
    expect(added[1].authorId).toBe('dobi')
    expect(new Set(added.slice(1).map((message) => message.authorId))).toEqual(new Set(['dobi', 'lin']))
  })

  it('marks a group run failed when no member can produce a reply', async () => {
    const { store, runtime } = createRuntime()
    ;(runtime as unknown as {
      runReply: (options: ReplyOptions) => Promise<{ text: string; error?: string }>
    }).runReply = async () => ({ text: '', error: 'upstream unavailable' })

    await runtime.sendMessage('crew', '@Dobi please answer')

    const messages = store.topicMessages('crew', store.activeTopicId('crew'))
    expect(messages.at(-1)).toMatchObject({
      kind: 'system',
      text: 'upstream unavailable'
    })
    expect(store.runs.at(-1)).toMatchObject({
      status: 'failed',
      error: 'upstream unavailable'
    })
  })

  it('routes an @mention to that member only', async () => {
    const { store, runtime } = createRuntime()
    const topicId = store.activeTopicId('crew')
    const before = store.topicMessages('crew', topicId).length

    await runtime.sendMessage('crew', '@Lin take the build pass')

    const added = store.topicMessages('crew', topicId).slice(before)
    expect(added[0].recipients).toEqual([{ id: 'lin', name: 'Lin' }])
    expect(new Set(added.filter((message) => message.kind === 'message' && message.authorId !== 'user').map((message) => message.authorId))).toEqual(
      new Set(['lin'])
    )
  })

  it('delivers game secrets privately to agents and the human, with safe public receipts', async () => {
    const { store, runtime } = createRuntime()
    store.deleteConversation('direct-dobi')
    const prompts: string[] = []
    const internals = runtime as unknown as { runReply: (options: ReplyOptions) => Promise<{ text: string }> }
    internals.runReply = async ({ config, context, prompt }) => {
      if (context === 'controller') {
        expect(prompt).not.toContain('agent-secret'); expect(prompt).not.toContain('human-secret')
        const p = JSON.parse(prompt.slice(prompt.indexOf('{')))
        if (p.completedTurns.some((turn: { memberId: string }) => turn.memberId === 'lin')) {
          return { text: JSON.stringify({ mode: 'none', memberIds: [], triggerMessageIds: [] }) }
        }
        const target = p.completedTurns.length ? 'lin' : 'dobi'
        return { text: JSON.stringify({ mode: 'single', memberIds: [target], triggerMessageIds: [p.messages[0].id] }) }
      }
      if (config.id === 'dobi') return { text: 'Words delivered. [[private:lin]]agent-secret[[/private]][[private:human]]human-secret[[/private]]' }
      prompts.push(prompt)
      return { text: 'Ready.' }
    }
    await runtime.sendMessage('crew', '@Dobi start the game')
    const publicMessages = store.topicMessages('crew', store.activeTopicId('crew'))
    expect(JSON.stringify(publicMessages)).not.toContain('agent-secret')
    expect(JSON.stringify(publicMessages)).not.toContain('human-secret')
    expect(prompts[0]).toContain('agent-secret')
    expect(prompts[0]).not.toContain('human-secret')
    const direct = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    expect(direct.at(-1)).toMatchObject({ text: 'human-secret', source: { kind: 'group', id: 'crew' } })
    expect(store.conversation('direct-dobi')?.unread).toBeGreaterThan(0)
    let replyPrompt = ''
    internals.runReply = async ({ prompt }) => { replyPrompt = prompt; return { text: 'Got it.' } }
    await runtime.sendMessage('direct-dobi', 'I received my word')
    expect(replyPrompt).toContain('human-secret')
  })

  it('publishes a fast parallel answer before a slow member finishes', async () => {
    const { store, runtime } = createRuntime()
    let release!: () => void
    const slow = new Promise<void>((resolve) => { release = resolve })
    let fastFinished!: () => void
    const fast = new Promise<void>((resolve) => { fastFinished = resolve })
    const internals = runtime as unknown as { runReply: (options: ReplyOptions) => Promise<{ text: string }> }
    internals.runReply = async ({ config, context, prompt }) => {
      if (context === 'controller') {
        const payload = JSON.parse(prompt.slice(prompt.indexOf('{'))) as DecisionPayload
        if (payload.completedTurns.length >= 2) return { text: JSON.stringify({ mode: 'none', memberIds: [], triggerMessageIds: [] }) }
        return { text: JSON.stringify({ mode: 'parallel', memberIds: ['dobi', 'lin'], triggerMessageIds: [payload.messages.at(-1)!.id] }) }
      }
      if (config.id === 'dobi') await slow
      else fastFinished()
      return { text: `${config.name} joke` }
    }
    const running = runtime.sendMessage('crew', '@all tell a joke each')
    await fast
    // Allow the completed member's persistence continuation to run.
    await vi.waitFor(() => expect(store.topicMessages('crew', store.activeTopicId('crew')).some((message) => message.text === 'Lin joke')).toBe(true))
    expect(store.topicMessages('crew', store.activeTopicId('crew')).some((message) => message.text === 'Dobi joke')).toBe(false)
    expect(runtime.snapshot().activity.find((item) => item.conversationId === 'crew')?.agentIds).toEqual(['dobi'])
    release()
    await running
  })

  it('returns delegated images visibly in the caller conversation and the IM response', async () => {
    const { store, runtime } = createRuntime()
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex')
    const attachment = await store.saveImageAttachment({ name: 'wolf.png', mimeType: 'image/png', data: bytes })
    vi.spyOn(runtime as unknown as { runReply: (options: ReplyOptions) => Promise<object> }, 'runReply').mockImplementation(async ({ config, sessionKey }) => sessionKey?.startsWith('handoff-summary:') ? { text: 'Lin drew your wolf.' } : config.id === 'dobi'
      ? { text: 'Delegating.\n[[a2a:lin]]Draw a wolf[[/a2a]]' }
      : { text: 'Here is your wolf.', attachments: [attachment] })
    const result = await replyToIM(store, runtime, 'dobi', 'wx', 'Ask Lin to draw', new AbortController().signal, 'wechat')
    expect(result).toEqual(['Delegating.', 'Lin drew your wolf.', { image: { name: 'wolf.png', mimeType: 'image/png', data: bytes } }])
    const history = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    expect(history.filter(m => m.attachments?.length)).toHaveLength(1)
    expect(history.find(m => m.attachments?.length)).toMatchObject({ authorId: 'dobi', text: 'Lin drew your wolf.', attachments: [attachment] })
    expect(history.find(m => m.deliveries?.length)?.deliveries?.[0].replies?.[0].attachments).toEqual([attachment])
  })

  it('summarizes delegated text for the requesting chat and IM while retaining raw receipts', async () => {
    const { store, runtime } = createRuntime()
    vi.spyOn(runtime as unknown as { runReply: (options: ReplyOptions) => Promise<object> }, 'runReply').mockImplementation(async ({ config, sessionKey, prompt, toolsDisabled }) => {
      if (sessionKey?.startsWith('handoff-summary:')) {
        expect(toolsDisabled).toBe(true)
        expect(prompt).toContain('They are Alex.')
        expect(prompt).toContain('Ask Lin who I am')
        return { text: 'Lin says they know you as Alex.' }
      }
      return config.id === 'dobi'
      ? { text: 'Asking Lin.\n[[a2a:lin]]Do you know the human?[[/a2a]]' }
      : { text: 'Yes.\n<!-- message_break -->\nThey are Alex.' }
    })
    const result = await replyToIM(store, runtime, 'dobi', 'wx', 'Ask Lin who I am', new AbortController().signal, 'wechat')
    expect(result).toEqual(['Asking Lin.', 'Lin says they know you as Alex.'])
    const history = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    expect(history.filter(m => m.source?.id === 'lin')).toHaveLength(0)
    expect(history.at(-1)).toMatchObject({ authorId: 'dobi', text: 'Lin says they know you as Alex.' })
    expect(history.find(m => m.deliveries?.length)?.deliveries?.[0].replies).toHaveLength(2)
  })

  it.each(['failure', 'stop'] as const)('does not publish raw text when delegation synthesis ends in %s', async outcome => {
    const { store, runtime } = createRuntime()
    vi.spyOn(runtime as unknown as { runReply: (options: ReplyOptions) => Promise<object> }, 'runReply').mockImplementation(async ({ config, sessionKey }) => {
      if (sessionKey?.startsWith('handoff-summary:')) {
        if (outcome === 'stop') runtime.stopConversation('direct-dobi')
        return { text: '', error: 'Summary unavailable' }
      }
      return config.id === 'dobi'
        ? { text: 'Asking Lin.\n[[a2a:lin]]Who is the human?[[/a2a]]' }
        : { text: 'RAW_RECIPIENT_REPLY' }
    })
    await runtime.sendMessage('direct-dobi', 'Ask Lin who I am')
    const history = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    expect(history.some(message => message.text.includes('RAW_RECIPIENT_REPLY'))).toBe(false)
    expect(history.find(message => message.deliveries?.length)?.deliveries?.[0].replies?.[0].content).toBe('RAW_RECIPIENT_REPLY')
    if (outcome === 'failure') expect(history.some(message => message.error)).toBe(true)
    else expect(history.some(message => message.text.includes('Summary unavailable'))).toBe(false)
  })

  it('includes tool-delegated text in the originating IM turn and clears reply capture', async () => {
    const { store, runtime } = createRuntime()
    const internals = runtime as unknown as {
      activeConversation: Map<string, string>; activeTopic: Map<string, string>
      handoffReplies: Map<string, unknown[]>
      messageAgentTool: (config: unknown, sessionKey: string) => MessageAgentToolLike
      runReply: (options: ReplyOptions & { sessionKey: string; conversationId: string; topicId: string }) => Promise<object>
    }
    vi.spyOn(internals, 'runReply').mockImplementation(async ({ config, sessionKey, conversationId, topicId }) => {
      if (config.id === 'lin') return { text: 'Yes, I know Alex.' }
      internals.activeConversation.set(sessionKey, conversationId)
      internals.activeTopic.set(sessionKey, topicId)
      try {
        const result = await internals.messageAgentTool(store.agent('dobi')!, sessionKey).execute('ask', { agent: 'lin', message: 'Do you know the human?' })
        expect(result.content[0].text).toContain('Yes, I know Alex.')
        expect(result.content[0].text).toContain('in your own voice')
      } finally {
        internals.activeConversation.delete(sessionKey)
        internals.activeTopic.delete(sessionKey)
      }
      return { text: 'Lin knows you as Alex.' }
    })
    const result = await replyToIM(store, runtime, 'dobi', 'tg', 'Ask Lin who I am', new AbortController().signal, 'telegram')
    expect(result).toEqual(['Lin knows you as Alex.'])
    expect(internals.handoffReplies.size).toBe(0)
  })

  it('returns an image-only model reply without a no-reply error', async () => {
    const { store, runtime } = createRuntime()
    const attachment = await store.saveImageAttachment({ name: 'wolf.png', mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex') })
    vi.spyOn(runtime as unknown as { runReply: () => Promise<object> }, 'runReply').mockResolvedValue({ text: '', attachments: [attachment] })
    const answer = await replyToIM(store, runtime, 'dobi', 'tg', 'Draw a wolf', new AbortController().signal, 'telegram')
    expect(answer).toHaveLength(1)
    expect(answer[0]).toMatchObject({ image: { name: 'wolf.png' } })
  })

  it('keeps the incoming private content with the reply source', async () => {
    const { store, runtime } = createRuntime()
    ;(runtime as unknown as { runReply: (options: ReplyOptions) => Promise<{ text: string }> }).runReply = async ({ config }) => (
      config.id === 'dobi'
        ? { text: '[[a2a:lin]]今晚七点半，老地方见。[[/a2a]]' }
        : { text: '好，我会准时到。\n<!-- message_break -->\n七点见。' }
    )

    await runtime.sendMessage('direct-dobi', '邀请 Lin')

    const replies = store.topicMessages('direct-lin', store.activeTopicId('direct-lin'))
    const receivedReplies = replies.filter((message) => message.source?.id === 'dobi')
    expect(receivedReplies[0]).toMatchObject({
      authorId: 'lin',
      text: '好，我会准时到。',
      source: {
        kind: 'bot',
        id: 'dobi',
        content: '今晚七点半，老地方见。'
      }
    })
    const sent = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
      .find((message) => message.deliveries?.length)
    expect(sent?.deliveries?.[0].replies?.[0]).toMatchObject({
      senderId: 'lin',
      senderName: 'Lin',
      content: '好，我会准时到。'
    })
    expect(sent?.deliveries?.[0].replies).toHaveLength(2)
    expect(new Set(sent?.deliveries?.[0].replies?.map((reply) => reply.replyGroupId))).toEqual(
      new Set([receivedReplies[0]?.replyGroupId])
    )
  })

  it.each(['success', 'failure', 'stop'] as const)('cleans recipient handoff activity on %s', async (outcome) => {
    const { runtime } = createRuntime()
    const internals = runtime as unknown as {
      withHandoffConversation: (id: string, parent: AbortSignal, run: (signal: AbortSignal) => Promise<string>) => Promise<string>
      activity: Map<string, unknown>
      aborts: Map<string, AbortController>
    }
    const parent = new AbortController()
    const pending = internals.withHandoffConversation('direct-lin', parent.signal, async (signal) => {
      internals.activity.set('direct-lin', { phase: 'replying' })
      expect(internals.aborts.has('direct-lin')).toBe(true)
      if (outcome === 'failure') throw new Error('provider failed')
      if (outcome === 'stop') {
        runtime.stopConversation('direct-lin')
        expect(signal.aborted).toBe(true)
      }
      return 'done'
    })
    if (outcome === 'success') await expect(pending).resolves.toBe('done')
    else await expect(pending).rejects.toThrow(outcome === 'stop' ? 'Handoff stopped' : 'provider failed')
    expect(internals.activity.has('direct-lin')).toBe(false)
    expect(internals.aborts.has('direct-lin')).toBe(false)
    expect(parent.signal.aborted).toBe(false)
  })

  it.each(['caller', 'human'] as const)('preserves generated images from tool delegation to %s in the requesting conversation', async replyTo => {
    const { store, runtime } = createRuntime()
    const attachment = await store.saveImageAttachment({ name: 'wolf.png', mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex') })
    const internals = runtime as unknown as {
      activeConversation: Map<string, string>; activeTopic: Map<string, string>
      messageAgentTool: (config: { id: string; name: string }) => MessageAgentToolLike
      runReply: (options: ReplyOptions) => Promise<object>
    }
    const topic = store.activeTopicId('direct-dobi')
    internals.activeConversation.set('dobi', 'direct-dobi'); internals.activeTopic.set('dobi', topic)
    internals.runReply = async () => ({ text: 'Drawn.', attachments: [attachment] })
    await internals.messageAgentTool(store.agent('dobi')!).execute('draw', { agent: 'lin', message: 'Draw a wolf', replyTo })
    expect(store.topicMessages('direct-dobi', topic).find(message => message.attachments?.length)).toMatchObject({ authorId: 'dobi', attachments: [attachment], source: { id: 'lin' } })
  })

  it('keeps inline agent handoffs out of the direct-chat transcript', async () => {
    const { store, runtime } = createRuntime()
    const topicId = store.activeTopicId('direct-dobi')
    const internals = runtime as unknown as {
      activeConversation: Map<string, string>
      activeTopic: Map<string, string>
      messageAgentTool: (config: { id: string; name: string }) => MessageAgentToolLike
      runReply: (options: ReplyOptions) => Promise<{ text: string }>
    }
    internals.activeConversation.set('dobi', 'direct-dobi')
    internals.activeTopic.set('dobi', topicId)
    internals.runReply = async ({ config }) => ({ text: `${config.name} internal answer.` })

    const before = store.topicMessages('direct-dobi', topicId)
    const result = await internals.messageAgentTool(store.agent('dobi')!).execute('handoff-1', {
      agent: 'lin',
      message: 'Check this detail.',
      replyTo: 'caller'
    })

    expect(result.content[0]?.text).toBe('Lin replied: Lin internal answer.')
    expect(store.topicMessages('direct-dobi', topicId)).toEqual(before)
  })

  it('hands a newly configured contact a task immediately without a human greeting', async () => {
    const { store, runtime } = createRuntime()
    const internal = runtime as any
    const admin = store.accountAgents.find(agent => agent.systemRole === 'admin')
    // The demo fixture permits management through its configured coordinator.
    const manager = admin ?? store.agent('dobi')!
    const tools = internal.agentManagementTools(manager) as AgentManagementToolLike[]
    const create = tools.find(tool => tool.name === 'create_agent')
    const fresh = create
      ? store.agent((await create.execute('create', { name: 'PPT Master', systemFiles: { 'IDENTITY.md': 'I make PPTs.' } })).details.agentId as string)!
      : store.createAgent({ name: 'PPT Master', role: 'Assistant', instructions: '', color: '#123456', provider: 'gateway', model: 'douchat-default', systemFiles: { 'IDENTITY.md': 'I make PPTs.' } })
    internal.activeConversation.set('dobi', 'direct-dobi')
    internal.activeTopic.set('dobi', store.activeTopicId('direct-dobi'))
    internal.runReply = vi.fn(async ({ config }: any) => {
      expect(config.systemFiles['IDENTITY.md']).toBe('I make PPTs.')
      return { text: 'Here is the presentation.' }
    })
    expect(store.topicMessages(`direct-${fresh.id}`, store.activeTopicId(`direct-${fresh.id}`))).toHaveLength(0)
    const result = await internal.messageAgentTool(store.agent('dobi')!).execute('send', { agent: fresh.id, message: 'Make a PPT' })
    expect(result.details.delivered).toBe(true)
    expect(store.topicMessages(`direct-${fresh.id}`, store.activeTopicId(`direct-${fresh.id}`)).at(-1)?.text).toBe('Here is the presentation.')
  })

  it.each([true, false])('recovers empty model output once, preserving prior tool results (recovers=%s)', async recovers => {
    const { store, runtime } = createRuntime()
    const internal = runtime as any
    delete internal.runReply
    const state = { messages: [] as any[] }
    const prompt = vi.fn(async () => {
      if (!state.messages.length) state.messages.push(
        { role: 'user', content: 'Make a PPT' },
        { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: 'Template loaded' }] })
      state.messages.push({ role: 'assistant', stopReason: 'stop', content: prompt.mock.calls.length > 1 && recovers ? [{ type: 'text', text: 'Result' }] : [] })
    })
    internal.sessions.set('empty-recovery', { agentId: 'dobi', agent: { state, prompt, abort: vi.fn() } })
    const reply = await internal.runReply({ config: store.agent('dobi'), sessionKey: 'empty-recovery', context: 'direct',
      prompt: 'Make a PPT', conversationId: 'direct-dobi', topicId: store.activeTopicId('direct-dobi') })
    expect(prompt).toHaveBeenCalledTimes(2)
    expect(state.messages.filter(message => message.role === 'toolResult')).toHaveLength(1)
    if (recovers) expect(reply).toMatchObject({ text: 'Result', retryCount: 1 })
    else expect(reply.error).toContain('finished without a text response')
  })

  it('keeps tool handoff request and replies in a sender receipt without copying reply text into a bubble', async () => {
    const { store, runtime } = createRuntime()
    const internals = runtime as unknown as {
      activeConversation: Map<string, string>; activeTopic: Map<string, string>
      messageAgentTool: (config: { id: string; name: string }) => MessageAgentToolLike
      runReply: (options: ReplyOptions) => Promise<{ text: string }>
    }
    internals.activeConversation.set('dobi', 'direct-dobi')
    internals.activeTopic.set('dobi', store.activeTopicId('direct-dobi'))
    internals.runReply = async () => ({ text: 'Hi, I am Lin.' })
    store.deleteConversation('direct-lin')
    const before = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    await internals.messageAgentTool(store.agent('dobi')!).execute('hello', { agent: 'lin', message: 'Greet the human' })
    expect(store.topicMessages('direct-lin', store.activeTopicId('direct-lin')).at(-1)).toMatchObject({ authorId: 'lin', text: 'Hi, I am Lin.', source: { id: 'dobi' } })
    expect(store.conversation('direct-lin')?.unread).toBe(1)
    const after = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    expect(after).toHaveLength(before.length + 1)
    expect(after.at(-1)).toMatchObject({ authorId: 'dobi', text: '', deliveries: [{
      recipientId: 'lin', recipientName: 'Lin', content: 'Greet the human',
      replies: [{ senderId: 'lin', content: 'Hi, I am Lin.' }]
    }] })
    expect(runtime.snapshot().messages).toContainEqual(after.at(-1))
  })

  it.each(['group', 'failed'] as const)('does not expose a private tool receipt for %s handoffs', async scenario => {
    const { store, runtime } = createRuntime()
    const conversationId = scenario === 'group' ? 'crew' : 'direct-dobi'
    const topicId = store.activeTopicId(conversationId)
    const internals = runtime as unknown as {
      activeConversation: Map<string, string>; activeTopic: Map<string, string>
      messageAgentTool: (config: { id: string; name: string }) => MessageAgentToolLike
      runReply: (options: ReplyOptions) => Promise<object>
    }
    internals.activeConversation.set('dobi', conversationId)
    internals.activeTopic.set('dobi', topicId)
    internals.runReply = async () => scenario === 'failed' ? { text: '', error: 'Unavailable' } : { text: 'Private answer' }
    const before = store.topicMessages(conversationId, topicId)
    await internals.messageAgentTool(store.agent('dobi')!).execute('private', { agent: 'lin', message: 'Private request' })
    expect(store.topicMessages(conversationId, topicId)).toEqual(before)
    if (scenario === 'failed') expect(store.topicMessages('direct-lin', store.activeTopicId('direct-lin')).at(-1)).toMatchObject({ error: 'Unavailable', source: { id: 'dobi', content: 'Private request' } })
  })

  it('posts an introduction in the selected group on the chat service, not another member private inbox', async () => {
    const { store, runtime } = createRuntime()
    const linked: string[] = []
    const posts: [string, string, string, string[]][] = []
    runtime.setGroupRooms({
      available: () => true,
      link: async (conversationId) => { linked.push(conversationId); return `room-${conversationId}` },
      post: async (roomId, localId, content, agentIds) => { posts.push([roomId, localId, content, agentIds]) }
    })
    const tools = (runtime as unknown as { groupMessagingTools: (config: unknown) => AgentManagementToolLike[] }).groupMessagingTools(store.agent('dobi')!)
    const list = await tools.find((tool) => tool.name === 'list_groups')!.execute('list', {})
    expect(list.content[0].text).toContain('crew')
    const send = tools.find((tool) => tool.name === 'send_group_message')!
    const before = store.topicMessages('direct-lin', store.activeTopicId('direct-lin'))
    const text = '大家好，我是 Dobi，拉这个群是为了大家一起聊天。'
    const result = await send.execute('introduction', { group: 'crew', message: text })
    expect(result.details).toMatchObject({ delivered: true, conversationId: 'crew' })
    // The group is shared first, then the agent posts in it as itself.
    expect(linked).toEqual(['crew'])
    expect(posts).toEqual([['room-crew', 'dobi', text, []]])
    expect(store.topicMessages('direct-lin', store.activeTopicId('direct-lin'))).toEqual(before)
    const invalid = await send.execute('bad', { group: 'direct-lin', message: text })
    expect(invalid.details.delivered).toBe(false)
    const excluded = store.createGroup({ name: 'Other group', agentIds: ['lin'] })
    expect((await send.execute('outsider', { group: excluded.id, message: text })).details.delivered).toBe(false)
  })

  it('hands tool-posted group mentions to the chat service instead of running the group here', async () => {
    const { store, runtime } = createRuntime()
    const posts: [string, string, string, string[]][] = []
    runtime.setGroupRooms({
      available: () => true,
      link: async (conversationId) => `room-${conversationId}`,
      post: async (roomId, localId, content, agentIds) => { posts.push([roomId, localId, content, agentIds]) }
    })
    const internals = runtime as unknown as {
      activeRun: Map<string, string>
      groupMessagingTools: (config: unknown) => AgentManagementToolLike[]
      runReply: (options: ReplyOptions) => Promise<{ text: string }>
    }
    const calls: string[] = []
    internals.runReply = async ({ config, context }) => {
      calls.push(config.id)
      expect(context).toBe('direct')
      const tool = internals.groupMessagingTools(store.agent(config.id)!).find((item) => item.name === 'send_group_message')!
      await tool.execute('mention-lin', { group: 'crew', message: '@Lin 请在群里介绍一下自己' })
      return { text: '已在群里联系 Lin。' }
    }
    await runtime.sendMessage('direct-dobi', '让 Lin 在群里介绍自己')
    // Lin answers on the chat service; nothing runs the group on this computer.
    expect(calls).toEqual(['dobi'])
    expect(posts).toEqual([['room-crew', 'dobi', '@Lin 请在群里介绍一下自己', ['lin']]])
    expect(runtime.snapshot().activity.some((item) => item.conversationId === 'crew')).toBe(false)
  })

  it('shares an own group on its first message and sends it through the chat service', async () => {
    const { store, runtime } = createRuntime()
    const sent: string[] = []
    runtime.setGroupRooms({
      available: () => true,
      link: async (conversationId) => { store.linkSharedGroup(conversationId, 'room-crew'); return 'room-crew' },
      post: async () => undefined
    })
    runtime.setHumanSender(async (conversationId, text) => { sent.push(`${conversationId}:${text}`) })
    const internals = runtime as unknown as { runReply: (options: ReplyOptions) => Promise<{ text: string }> }
    internals.runReply = async () => { throw new Error('the group must not run on this computer') }
    await runtime.sendMessage('crew', '大家好')
    expect(store.conversation('crew')?.remoteRoomId).toBe('room-crew')
    expect(sent).toEqual(['crew:大家好'])
  })

  it('opens an empty topic with one proactive greeting', async () => {
    const { store, runtime } = createRuntime()
    store.clearConversation('direct-dobi', store.activeTopicId('direct-dobi'))

    await runtime.greet('direct-dobi')

    const messages = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    expect(messages).toHaveLength(1)
    expect(messages[0].authorId).toBe('dobi')

    // A topic that already has a transcript is never greeted again.
    await runtime.greet('direct-dobi')
    expect(store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))).toHaveLength(1)
  })

  it.each(['zh-CN', 'en'] as const)('welcomes a new account offline in %s without repeating or using a model', async (language) => {
    const { store, runtime } = createRuntime()
    store.setCurrentAccountId('new-user')
    const { agent, conversation } = store.ensureDefaultCloudContact('new-user', { provider: 'gateway', model: 'default' })
    runtime.setInterfaceLanguage(language)
    const internal = runtime as unknown as { canRunLive: () => Promise<boolean>; runReply: (options: ReplyOptions) => Promise<{ text: string }> }
    const live = vi.spyOn(internal, 'canRunLive').mockResolvedValue(false)
    const reply = vi.spyOn(internal, 'runReply')
    await Promise.all([runtime.greet(conversation!.id), runtime.greet(conversation!.id)])
    const messages = store.messages.filter(message => message.conversationId === conversation!.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ authorId: agent!.id, kind: 'message' })
    for (const text of language === 'zh-CN' ? ['创建联系人', '拉群协作', '解释代码', '设置提醒'] : ['Create a contact', 'Start a group', 'explain code', 'Set a reminder']) {
      expect(messages[0].text).toContain(text)
    }
    store.createTopic(conversation!.id)
    await runtime.greet(conversation!.id)
    expect(store.messages.filter(message => message.conversationId === conversation!.id)).toHaveLength(2)
    expect(store.contextMessages(conversation!.id, store.activeTopicId(conversation!.id))[0].text).toContain(agent!.name)
    expect(reply).not.toHaveBeenCalled()
  })

  it('bounds greetings, suppresses duplicates and discards late model output', async () => {
    vi.useFakeTimers()
    try {
      const { store, runtime } = createRuntime()
      const internal = runtime as any
      store.clearConversation('direct-lin', store.activeTopicId('direct-lin'))
      let finish!: (value: { text: string }) => void
      internal.runReply = vi.fn(() => new Promise(resolve => { finish = resolve }))
      const greeting = runtime.greet('direct-lin')
      await runtime.greet('direct-lin')
      await vi.advanceTimersByTimeAsync(8000)
      await greeting
      expect(internal.runReply).toHaveBeenCalledTimes(1)
      expect(internal.runReply.mock.calls[0][0]).toMatchObject({ toolsDisabled: true, timeoutMs: 8000 })
      expect(store.contextMessages('direct-lin', store.activeTopicId('direct-lin'))).toHaveLength(1)
      finish({ text: 'Late greeting' })
      await Promise.resolve()
      expect(store.contextMessages('direct-lin', store.activeTopicId('direct-lin'))[0].text).not.toBe('Late greeting')
    } finally { vi.useRealTimers() }
  })

  it('greets after a context reset with current customization, and skips if the human starts talking', async () => {
    const { store, runtime } = createRuntime()
    const internal = runtime as any
    const topic = store.activeTopicId('direct-lin')
    store.updateAgent('lin', { systemFiles: { 'IDENTITY.md': 'I am an English tutor.', 'BOOTSTRAP.md': 'Ask about learning goals.' } })
    store.resetConversationContext('direct-lin', topic)
    internal.runReply = vi.fn(async ({ config, prompt }: any) => {
      expect(config.systemFiles['BOOTSTRAP.md']).toBe('Ask about learning goals.')
      expect(prompt).toContain('IDENTITY.md')
      return { text: 'Hello, what would you like to learn?' }
    })
    await runtime.greet('direct-lin')
    expect(store.contextMessages('direct-lin', topic)[0].text).toContain('learn')
    store.resetConversationContext('direct-lin', topic)
    let finish!: (value: { text: string }) => void
    internal.runReply = () => new Promise(resolve => { finish = resolve })
    const greeting = runtime.greet('direct-lin')
    await Promise.resolve()
    store.addMessage({ conversationId: 'direct-lin', topicId: topic, authorId: 'user', authorName: 'Me', text: 'Start now', kind: 'message' })
    finish({ text: 'Must not interrupt' })
    await greeting
    expect(store.contextMessages('direct-lin', topic)).toHaveLength(1)
  })

  it('uses the selected interface language for proactive greetings', async () => {
    const { store, runtime } = createRuntime()
    const internals = runtime as unknown as {
      runReply: (options: ReplyOptions) => Promise<{ text: string }>
    }
    let greetingPrompt = ''
    internals.runReply = async ({ prompt }) => {
      greetingPrompt = prompt
      return { text: '你好，很高兴见到你。' }
    }
    runtime.setInterfaceLanguage('zh-CN')
    store.clearConversation('direct-dobi', store.activeTopicId('direct-dobi'))

    await runtime.greet('direct-dobi')

    expect(greetingPrompt).toContain('"language":"zh-CN"')
    expect(store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))[0]?.text).toBe('你好，很高兴见到你。')
  })

  it('keeps each topic transcript separate', async () => {
    const { store, runtime } = createRuntime()
    const first = store.activeTopicId('direct-lin')
    await runtime.sendMessage('direct-lin', 'first task')
    const second = store.createTopic('direct-lin')!
    await runtime.sendMessage('direct-lin', 'second task')

    expect(store.topicMessages('direct-lin', first).some((message) => message.text === 'second task')).toBe(false)
    expect(store.topicMessages('direct-lin', second.id)[0].text).toBe('second task')
  })

  it('restores direct-chat context when the in-memory session is recreated', async () => {
    const { store, runtime } = createRuntime()
    const conversationId = 'direct-dobi'
    const topicId = store.activeTopicId(conversationId)
    store.clearConversation(conversationId, topicId)
    store.addMessage({
      conversationId,
      topicId,
      authorId: 'user',
      authorName: store.userName,
      text: 'Play the Qin emperor video from Downloads.',
      kind: 'message'
    })
    store.addMessage({
      conversationId,
      topicId,
      authorId: 'dobi',
      authorName: 'Dobi',
      text: 'I could not open the local file in the browser.',
      kind: 'message'
    })
    let receivedPrompt = ''
    ;(runtime as unknown as { runReply: (options: ReplyOptions) => Promise<{ text: string }> }).runReply = async (options) => {
      receivedPrompt = options.prompt
      return { text: 'I will use the local-file tool this time.' }
    }

    await runtime.sendMessage(conversationId, 'Try again.')

    expect(receivedPrompt).toContain('Play the Qin emperor video from Downloads.')
    expect(receivedPrompt).toContain('I could not open the local file in the browser.')
    expect(receivedPrompt).toContain('Try again.')
    expect(receivedPrompt).toContain('Your model session was recreated')
  })

  it('persists completed tool actions on the reply bubble', async () => {
    const { store, runtime } = createRuntime()
    ;(runtime as unknown as {
      runReply: (options: ReplyOptions) => Promise<{
        text: string
        actions: Array<{ id: string; tool: string; status: 'succeeded'; target: string }>
      }>
    }).runReply = async () => ({
      text: 'The video is open.',
      actions: [{ id: 'open-video-1', tool: 'computer_open_file', status: 'succeeded', target: 'qin-emperor.mp4' }]
    })

    await runtime.sendMessage('direct-dobi', 'Open that video again.')

    const messages = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    const reply = [...messages].reverse().find((message) => message.authorId === 'dobi')
    expect(reply?.actions).toEqual([
      { id: 'open-video-1', tool: 'computer_open_file', status: 'succeeded', target: 'qin-emperor.mp4' }
    ])
  })

  it('shows one diagnostic error after tools succeed and the model continuation fails', async () => {
    const { store, runtime } = createRuntime()
    ;(runtime as unknown as {
      runReply: (options: ReplyOptions) => Promise<{
        text: string
        error: string
        retryCount: number
        actions: Array<{ id: string; tool: string; status: 'succeeded'; target?: string }>
      }>
    }).runReply = async () => ({
      text: '',
      error: 'Request was aborted',
      retryCount: 1,
      actions: [
        { id: 'create-1', tool: 'create_agent', status: 'succeeded', target: '东子' },
        { id: 'list-1', tool: 'computer_list_files', status: 'succeeded' }
      ]
    })

    await runtime.sendMessage('direct-dobi', 'Create 东子 and let it inspect my videos.')

    const messages = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    const errors = messages.filter((message) => message.kind === 'system')
    expect(errors).toHaveLength(1)
    expect(messages.some((message) => message.authorId === 'dobi' && message.error)).toBe(false)
    expect(errors[0]).toMatchObject({ text: 'The model connection was interrupted' })
    expect(errors[0].detail).toContain('Stage: model response after tool execution')
    expect(errors[0].detail).toContain('Automatic retries: 1')
    expect(errors[0].detail).toContain('- create_agent (东子)')
    expect(errors[0].detail).toContain('- computer_list_files')
    expect(store.runs.at(-1)).toMatchObject({ status: 'failed', error: 'The model connection was interrupted' })
  })

  it('stores selected files and lets the active agent read only files shared in its conversation', async () => {
    const { store, runtime } = createRuntime()
    let prompt = ''
    ;(runtime as any).runReply = async (options: ReplyOptions) => { prompt = options.prompt; return { text: 'Read it.' } }
    await runtime.sendMessage('direct-dobi', 'Inspect this SVG', [], [{ name: 'logo.svg', data: Buffer.from('<svg>hello</svg>') }])
    const messages = store.contextMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    const user = messages.filter(message => message.authorId === 'user').at(-1)!
    const url = /\]\(<(douchat-file:[^>]+)>\)/.exec(user.text)![1]
    expect(prompt).toContain(url)
    const session = 'test-file-session'
    ;(runtime as any).replyCancels.set(session, { conversationId: 'direct-dobi', abort: new AbortController() })
    ;(runtime as any).activeConversation.set(session, 'direct-dobi')
    const tool = (runtime as any).artifactTools('dobi', session).find((tool: any) => tool.name === 'read_message_file')
    const result = await tool.execute('read', { url })
    expect(JSON.parse(result.content[0].text).content).toBe('<svg>hello</svg>')
    const other = await store.saveIMFile({ name: 'private.txt', data: Buffer.from('private') }, store.currentAccountId)
    const otherUrl = /\]\(<([^>]+)>\)/.exec(other)![1]
    await expect(tool.execute('read', { url: otherUrl })).rejects.toThrow('not available')
  })

  it('rejects oversized or empty file batches without adding messages', async () => {
    const { store, runtime } = createRuntime()
    const before = store.contextMessages('direct-dobi', store.activeTopicId('direct-dobi')).length
    await expect(runtime.sendMessage('direct-dobi', '', [], [{ name: 'empty.txt', data: new Uint8Array() }])).rejects.toThrow('不能为空')
    await expect(runtime.sendMessage('direct-dobi', '', [], [{ name: 'large.bin', data: new Uint8Array(20 * 1024 * 1024 + 1) }])).rejects.toThrow('20 MB')
    expect(store.contextMessages('direct-dobi', store.activeTopicId('direct-dobi'))).toHaveLength(before)
  })

  it('persists a pasted image and passes its bytes to the model', async () => {
    const { store, runtime } = createRuntime()
    let received: ReplyOptions | undefined
    ;(runtime as unknown as { runReply: (options: ReplyOptions) => Promise<{ text: string }> }).runReply = async (options) => {
      received = options
      return { text: 'I can see it.' }
    }
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

    await runtime.sendMessage('direct-dobi', '', [{ name: 'clipboard.png', mimeType: 'image/png', data: bytes }])

    const messages = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))
    const user = [...messages].reverse().find((message) => message.authorId === 'user')
    expect(user).toMatchObject({ text: '', attachments: [{ name: 'clipboard.png', mimeType: 'image/png', size: 8 }] })
    expect(await store.attachmentDataUrl(user!.attachments![0].id)).toBe(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`)
    expect(received?.prompt).toContain('The human sent an image')
    expect(received?.images).toEqual([{ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }])
  })

  it('rejects pasted image batches beyond the safe limit before writing a message', async () => {
    const { store, runtime } = createRuntime()
    const before = store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi')).length
    const image = { name: 'clipboard.png', mimeType: 'image/png' as const, data: Uint8Array.from([1]) }

    await expect(runtime.sendMessage('direct-dobi', '', Array.from({ length: 5 }, () => image))).rejects.toThrow(
      'You can paste up to 4 images at a time.'
    )
    expect(store.topicMessages('direct-dobi', store.activeTopicId('direct-dobi'))).toHaveLength(before)
  })
})

it('uses the new default model after resetting context while preserving the agent display name', () => {
  const { store, runtime } = createRuntime()
  const records = [{ id: 'mine', name: 'Mine', kind: 'openai' as const, apiBase: 'https://custom.example/v1', apiKey: 'test-key', models: ['mimo-model', 'deepseek-flash'] }]
  runtime.configureCustomModels(records, 'mine/mimo-model')
  const bot = store.createAgent({ name: 'Mimo2', role: 'Assistant', instructions: '', color: '#fff', ...runtime.customAgentModel('@default', 'default') })
  const conversation = store.accountConversations.find(conversation => conversation.type === 'direct' && conversation.agentIds.includes(bot.id))!
  const topicId = store.activeTopicId(conversation.id)
  const key = `direct:${conversation.id}:${topicId}`
  const internals = runtime as unknown as { session: (config: typeof bot, key: string, context: 'direct') => { state: { model: { id: string }; systemPrompt: string } } }
  const previous = internals.session(bot, key, 'direct')
  expect(previous.state.model.id).toBe('mimo-model')
  runtime.configureCustomModels(records, 'mine/deepseek-flash')
  runtime.resetConversation(conversation.id, topicId)
  store.resetConversationContext(conversation.id, topicId)
  const current = internals.session(store.agent(bot.id)!, key, 'direct')
  expect(current).not.toBe(previous)
  expect(current.state.model.id).toBe('deepseek-flash')
  expect(current.state.systemPrompt).toContain('"name":"Mimo2"')
  expect(current.state.systemPrompt).toContain('"modelId":"deepseek-flash"')
  expect(current.state.systemPrompt).not.toContain('mimo-model')
  expect(store.contextMessages(conversation.id, topicId)).toEqual([])
})

it('updates only default followers, including the built-in agent, and keeps model IDs with slashes', () => {
  const { store, runtime } = createRuntime()
  store.setCurrentAccountId('default-owner')
  const records = [{ id: 'mine', name: 'Mine', kind: 'openai' as const, apiBase: 'https://custom.example/v1', apiKey: 'test-key', models: ['org/one', 'org/two'] }]
  runtime.configureCustomModels(records, 'mine/org/one')
  const binding = runtime.customAgentModel('@default', 'default')
  const follower = store.createAgent({ name: 'Follower', role: 'Assistant', instructions: '', color: '#fff', ...binding })
  const fixed = store.createAgent({ name: 'Fixed', role: 'Assistant', instructions: '', color: '#fff', ...runtime.customAgentModel('mine', 'org/one') })
  const admin = store.ensureDefaultCloudContact('default-owner', { provider: 'gateway', model: 'default' }).agent!
  store.updateAgent(admin.id, binding, { binding, followDefault: false })
  runtime.configureCustomModels(records, 'mine/org/two')
  for (const id of [follower.id, admin.id]) expect(store.agent(id)).toMatchObject({ followDefaultModel: true, provider: 'custom:mine', model: 'org/two' })
  expect(store.agent(fixed.id)?.model).toBe('org/one')
  store.ensureDefaultCloudContact('default-owner', { provider: 'gateway', model: 'default' })
  expect(store.agent(admin.id)).toMatchObject({ followDefaultModel: true, model: 'org/two' })
  const explicit = runtime.customAgentModel('mine', 'org/two')
  store.updateAgent(follower.id, explicit)
  runtime.configureCustomModels(records, 'mine/org/one')
  expect(store.agent(follower.id)).toMatchObject({ followDefaultModel: false, model: 'org/two' })
  runtime.configureCustomModels([])
  expect(() => runtime.customAgentModel('@default', 'default')).toThrow('Set a default model')
  expect(store.agent(admin.id)?.provider).toBe('custom:@unavailable')
})

it.each([false, true])('keeps custom model routing when cloud reconnects and never falls back after removal (built-in: %s)', async (builtIn) => {
  const { store, runtime } = createRuntime()
  store.setCurrentAccountId('custom-model-owner')
  runtime.configureCustomModels([{ id: 'mine', name: 'Mine', kind: 'openai', apiBase: 'https://custom.example/v1', apiKey: 'test-key', models: ['private-model'] }])
  const binding = runtime.customAgentModel('mine', 'private-model')
  let agent = builtIn
    ? store.ensureDefaultCloudContact('custom-model-owner', { provider: 'gateway', model: 'default' }).agent!
    : store.createAgent({ name: 'Private', role: 'Assistant', instructions: '', color: '#fff', ...binding })
  if (builtIn) agent = store.updateAgent(agent.id, {}, { binding, followDefault: false })!
  const internals = runtime as unknown as { resolveModel: (agent: typeof store.agents[number]) => { provider: string; id: string }; canRunLive: (agent: typeof store.agents[number]) => Promise<boolean> }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'cloud-default' }] }), { status: 200 })))
  await runtime.setEndpoint({ baseUrl: 'https://cloud.example/v1', apiKey: 'cloud-key' })
  expect(store.agent(agent.id)?.provider).toBe('custom:mine')
  expect(internals.resolveModel(agent)).toMatchObject({ provider: 'custom:mine', id: 'private-model' })
  expect(await internals.canRunLive(agent)).toBe(true)
  runtime.configureCustomModels([])
  expect(() => runtime.customAgentModel('mine', 'private-model')).toThrow('unavailable')
  await expect(internals.canRunLive(agent)).rejects.toThrow('unavailable')
})

it('starts isolated IM model turns concurrently, preserves receipt order and returns only their own out-of-order answers', async () => {
  const { store, runtime } = createRuntime()
  const internal = runtime as any
  internal.runReply = (DouchatRuntime.prototype as any).runReply
  const pending = new Map<string, { options: any; finish: (value: { text: string }) => void }>()
  vi.spyOn(internal, 'performReply').mockImplementation((options: any) => new Promise(resolve => {
    pending.set(options.routineRequest, { options, finish: resolve })
  }))
  const firstReceipt = runtime.receiveIMMessage('dobi', 'tg', 'FIRST_ONLY', 'telegram', '1')
  expect(runtime.receiveIMMessage('dobi', 'tg', 'FIRST_ONLY', 'telegram', '1')).toBe(firstReceipt)
  const first = replyToIM(store, runtime, 'dobi', 'tg', 'FIRST_ONLY', new AbortController().signal, 'telegram', undefined, firstReceipt)
  await vi.waitFor(() => expect(pending.has('FIRST_ONLY')).toBe(true))
  const secondReceipt = runtime.receiveIMMessage('dobi', 'tg', 'SECOND_ONLY', 'telegram', '2')
  const second = replyToIM(store, runtime, 'dobi', 'tg', 'SECOND_ONLY', new AbortController().signal, 'telegram', undefined, secondReceipt)
  await vi.waitFor(() => expect(pending.has('SECOND_ONLY')).toBe(true))
  const one = pending.get('FIRST_ONLY')!, two = pending.get('SECOND_ONLY')!
  expect(one.options.sessionKey).not.toBe(two.options.sessionKey)
  expect(one.options.prompt).not.toContain('SECOND_ONLY')
  expect(two.options.prompt).toContain('FIRST_ONLY')
  two.finish({ text: 'second result' })
  expect(await second).toEqual(['second result'])
  expect(internal.activity.has('direct-dobi')).toBe(true)
  one.finish({ text: 'first result' })
  expect(await first).toEqual(['first result'])
  expect(store.messages.filter(message => message.id === firstReceipt)).toHaveLength(1)
  expect(store.messages.filter(message => message.id === secondReceipt)).toHaveLength(1)
  expect(internal.activity.has('direct-dobi')).toBe(false)
  expect(internal.imTurns.size).toBe(0)
  store.close()
})

it('cancels one parallel IM request without aborting its sibling and stops all on desktop stop', async () => {
  const { store, runtime } = createRuntime()
  const internal = runtime as any
  internal.runReply = (DouchatRuntime.prototype as any).runReply
  const pending = new Map<string, { signal: AbortSignal; finish: (value: { text: string }) => void }>()
  vi.spyOn(internal, 'performReply').mockImplementation((options: any) => new Promise(resolve => {
    pending.set(options.routineRequest, { signal: options.signal, finish: resolve })
    options.signal.addEventListener('abort', () => resolve({ text: '' }), { once: true })
  }))
  const controller = new AbortController()
  const first = replyToIM(store, runtime, 'dobi', 'tg', 'ONE', controller.signal)
  const second = replyToIM(store, runtime, 'dobi', 'wx', 'TWO', new AbortController().signal)
  const firstFailure = expect(first).rejects.toThrow('disconnected')
  const secondFailure = expect(second).rejects.toThrow('disconnected')
  await vi.waitFor(() => expect(pending.size).toBe(2))
  controller.abort()
  await firstFailure
  expect(pending.get('TWO')!.signal.aborted).toBe(false)
  runtime.stopConversation('direct-dobi')
  await secondFailure
  expect(pending.get('TWO')!.signal.aborted).toBe(true)
  expect(internal.imTurns.size).toBe(0)
  store.close()
})

it('updates an attachment receipt in its original topic without duplicating it after the active topic changes', async () => {
  const { store, runtime } = createRuntime()
  const receiptId = runtime.receiveIMMessage('dobi', 'tg', '', 'telegram', 'photo')
  const original = store.messages.find(message => message.id === receiptId)!
  expect(original.text).toBe('📎')
  const nextTopic = store.createTopic('direct-dobi')!
  expect(nextTopic.id).not.toBe(original.topicId)
  const reply = await replyToIM(store, runtime, 'dobi', 'tg', 'Describe', new AbortController().signal, 'telegram',
    [{ name: 'photo.png', image: true, data: Buffer.from('89504e470d0a1a0a', 'hex') }], receiptId)
  expect(reply.length).toBeGreaterThan(0)
  const messages = store.messages.filter(message => message.id === receiptId)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ text: 'Describe', topicId: original.topicId, createdAt: original.createdAt })
  expect(messages[0].attachments).toHaveLength(1)
  store.close()
})

it('exposes live skill resources to private and group agents, but not scheduling controllers', async () => {
  const { store, runtime } = createRuntime()
  const internal = runtime as any
  const agent = store.accountAgents[0]
  vi.spyOn(internal, 'resolveModel').mockReturnValue({ id: 'mock', provider: 'mock', api: 'openai-completions' })
  store.updateAgent(agent.id, { skills: [{ id: 'growth', name: 'Growth', content: 'Read references/value.md before analysis', enabled: true, files: [{ path: 'references/value.md', data: Buffer.from('Reference evidence').toString('base64') }] }] })
  const current = store.agent(agent.id)!
  for (const context of ['direct', 'group']) {
    const session = internal.session(current, `${context}:skills`, context)
    const read = session.state.tools.find((tool: any) => tool.name === 'read_skill_file')
    expect(read).toBeDefined()
    const response = await read.execute('read', { skillId: 'growth', path: 'references/value.md' })
    expect(JSON.parse(response.content[0].text).content).toBe('Reference evidence')
    expect(session.state.systemPrompt).toContain('Skill ID: growth')
    expect(session.state.systemPrompt).toContain('read_skill_file with that ID')
  }
  expect(internal.session(current, 'controller:skills', 'controller').state.tools).toEqual([])
  expect(internal.session(current, 'direct:disabled-tools', 'direct', true).state.tools).toEqual([])
  const read = internal.session(current, 'direct:skills', 'direct').state.tools.find((tool: any) => tool.name === 'read_skill_file')
  store.updateAgent(agent.id, { skills: [] })
  await expect(read.execute('read', { skillId: 'growth', path: 'references/value.md' })).rejects.toThrow('not found')
  store.setCurrentAccountId('different-owner')
  await expect(read.execute('read', { skillId: 'growth', path: 'SKILL.md' })).rejects.toThrow('account changed')
})

it('feeds a real skill tool result back into the agent loop and records the successful read', async () => {
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')
  const { store, runtime } = createRuntime()
  const internal = runtime as any
  const agent = store.accountAgents[0]
  vi.spyOn(internal, 'resolveModel').mockReturnValue({ id: 'mock', provider: 'mock', api: 'openai-completions' })
  store.updateAgent(agent.id, { skills: [{ id: 'growth', name: 'Growth', content: 'Read references/value.md', enabled: true, files: [{ path: 'references/value.md', data: Buffer.from('REFERENCE_EVIDENCE').toString('base64') }] }] })
  const sessionKey = 'direct:skill-loop'
  const session = internal.session(store.agent(agent.id), sessionKey, 'direct')
  const run = store.createRun({ agentId: agent.id, conversationId: `direct-${agent.id}`, title: 'Skill loop', prompt: 'Diagnose growth', trigger: 'chat' })
  internal.activeRun.set(sessionKey, run.id)
  let calls = 0
  session.streamFunction = (_model: unknown, context: any) => {
    const stream = createAssistantMessageEventStream()
    const first = calls++ === 0
    if (!first) {
      const result = context.messages.find((message: any) => message.role === 'toolResult')
      expect(result.isError).toBe(false)
      expect(result.content[0].text).toContain('REFERENCE_EVIDENCE')
    }
    const message: any = {
      role: 'assistant', api: 'openai-completions', provider: 'mock', model: 'mock', timestamp: Date.now(),
      content: first ? [{ type: 'toolCall', id: 'read-value', name: 'read_skill_file', arguments: { skillId: 'growth', path: 'references/value.md' } }] : [{ type: 'text', text: 'Analysis based on the reference.' }],
      stopReason: first ? 'toolUse' : 'stop',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    }
    stream.push({ type: 'start', partial: message })
    stream.push({ type: 'done', reason: message.stopReason, message })
    return stream
  }
  await session.prompt('Diagnose growth')
  expect(calls).toBe(2)
  expect(internal.toolActions.get(`${run.id}:${agent.id}`).get('read-value')).toMatchObject({ status: 'succeeded', target: 'references/value.md' })
  expect(store.runEvents.some(event => event.runId === run.id && event.label.includes('read_skill_file succeeded'))).toBe(true)
})
