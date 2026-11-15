import { describe, expect, it, vi } from 'vitest'
import { addressesEveryone, insertMention, mentionedMembers, mentionOnlyFilter, mentionQuery } from './mentions'
import { BOT_MESSAGE_BREAK, splitBotReply } from './messages'
import {
  explicitGroupDecision,
  groupMemberSessionId,
  runGroupConversation,
  validateGroupDecision,
  type BotGroup,
  type GroupMessage
} from './group'
import { parsePrivateReply, privateReplyDeliveries } from './privateMessages'
import { a2aReplyMessages } from './a2a'
import { latestAssistantPreview, markdownPreview } from './preview'
import { contactSection, contactSections, matchesContactQuery } from './contacts'
import { isDouchatCreditError, isRetryableRuntimeError, summarizeRuntimeError } from './errors'

const members = [
  { id: 'a', name: 'Ann' },
  { id: 'b', name: 'Anna' },
  { id: 'c', name: '我的 codex' }
]
const group: BotGroup = { id: 'g', name: 'Crew', leadMemberId: 'a', members }

describe('mentions', () => {
  it('prefers the longest matching name', () => {
    expect(mentionedMembers('@Anna please take this', members).map((member) => member.id)).toEqual(['b'])
    expect(mentionedMembers('@Ann please take this', members).map((member) => member.id)).toEqual(['a'])
  })

  it('ignores mentions inside code, quotes and links', () => {
    expect(mentionedMembers('`@Ann`', members)).toHaveLength(0)
    expect(mentionedMembers('> @Ann said so', members)).toHaveLength(0)
    expect(mentionedMembers('[@Ann](https://example.com/@Ann)', members)).toHaveLength(0)
  })

  it('recognizes an address to everyone', () => {
    expect(addressesEveryone('@all ship it')).toBe(true)
    expect(addressesEveryone('@大家 ship it')).toBe(true)
    expect(addressesEveryone('mail me at a@allstate.com')).toBe(false)
  })

  it('keeps spaces inside an incomplete member name', () => {
    const value = '@我的 cod'
    expect(mentionQuery(value, value.length, members)?.query).toBe('我的 cod')
    const finished = '@all now'
    expect(mentionQuery(finished, finished.length, members)).toBeNull()
  })

  it('inserts a mention with a trailing space', () => {
    const query = mentionQuery('@An', 3, members)!
    expect(insertMention('@An', query, 'Anna')).toEqual({ value: '@Anna ', cursor: 6 })
  })
})

describe('reply bubbles', () => {
  it('honours explicit separators', () => {
    expect(splitBotReply(`one\n${BOT_MESSAGE_BREAK}\ntwo`)).toEqual(['one', 'two'])
  })

  it('never splits fenced code or structured markdown', () => {
    const code = 'Here:\n\n```js\nconst a = 1\n\nconst b = 2\n```'
    expect(splitBotReply(code)).toHaveLength(2)
    expect(splitBotReply('- one\n\n- two')).toHaveLength(1)
  })

  it('caps a turn at four bubbles', () => {
    expect(splitBotReply(['a', 'b', 'c', 'd', 'e'].join('\n\n'))).toHaveLength(4)
  })
})

describe('group dispatch', () => {
  it('extracts structural mention hints without treating them as authorization', () => {
    expect(explicitGroupDecision('@Ann @Anna go', group, 'u1')).toEqual({
      mode: 'parallel',
      memberIds: ['a', 'b'],
      triggerMessageIds: ['u1']
    })
    expect(explicitGroupDecision('no address here', group, 'u1')).toBeNull()
  })

  it('rejects a decision that names an unknown member or message', () => {
    const context = { messages: [{ id: 'u1', role: 'user' as const, content: 'hi' }], privateDeliveries: [], completedTurns: [] }
    expect(() => validateGroupDecision({ mode: 'single', memberIds: ['zz'], triggerMessageIds: ['u1'] }, group, context)).toThrow()
    expect(() => validateGroupDecision({ mode: 'single', memberIds: ['a'], triggerMessageIds: ['nope'] }, group, context)).toThrow()
    expect(validateGroupDecision({ mode: 'none', memberIds: [], triggerMessageIds: [] }, group, context).mode).toBe('none')
  })

  it('lets only the dispatched worker answer a single-recipient decision', async () => {
    const user: GroupMessage = { id: 'u1', role: 'user', content: 'plan the launch' }
    const spoke: string[] = []
    const decide = vi
      .fn()
      .mockResolvedValueOnce({ mode: 'single', memberIds: ['b'], triggerMessageIds: ['u1'] })
      .mockResolvedValue({ mode: 'none', memberIds: [], triggerMessageIds: [] })
    const result = await runGroupConversation({
      group,
      user,
      signal: new AbortController().signal,
      decide,
      reply: async (member, turn) => {
        spoke.push(member.id)
        return [{ id: `${member.id}:${turn.round}`, role: 'assistant', sender: { id: member.id, name: member.name }, content: 'done' }]
      }
    })

    expect(spoke).toEqual(['b'])
    expect(decide).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ limited: false, failed: false, unavailableMemberIds: [] })
  })

  it('uses the controller to dispatch unaddressed follow-ups without an extra leader reply', async () => {
    const user: GroupMessage = { id: 'u2', role: 'user', content: 'and what happened next?' }
    const decide = vi.fn().mockResolvedValueOnce({ mode: 'single', memberIds: ['b'], triggerMessageIds: ['u2'] })
      .mockResolvedValue({ mode: 'none', memberIds: [], triggerMessageIds: [] })
    const spoke: string[] = []
    const result = await runGroupConversation({
      group,
      user,
      history: [
        { id: 'u1', role: 'user', content: 'give me the latest' },
        { id: 'b1', role: 'assistant', sender: { id: 'b', name: 'Anna' }, content: 'Here is the latest.' }
      ],
      signal: new AbortController().signal,
      decide,
      reply: async (member, turn) => {
        spoke.push(member.id)
        return [{ id: `${member.id}:${turn.round}`, role: 'assistant', sender: { id: member.id, name: member.name }, content: 'follow-up' }]
      }
    })

    expect(spoke).toEqual(['b'])
    expect(decide).toHaveBeenCalledTimes(1)
    expect(result.failed).toBe(false)
  })

  it('does not treat a proactive greeting as an established speaker', async () => {
    const user: GroupMessage = { id: 'u1', role: 'user', content: 'who should take this?' }
    const decide = vi.fn().mockResolvedValueOnce({ mode: 'single', memberIds: ['b'], triggerMessageIds: ['u1'] })
      .mockResolvedValue({ mode: 'none', memberIds: [], triggerMessageIds: [] })
    const spoke: string[] = []
    await runGroupConversation({
      group,
      user,
      history: [{ id: 'hello', role: 'assistant', sender: { id: 'a', name: 'Ann' }, content: 'Welcome.' }],
      signal: new AbortController().signal,
      decide,
      reply: async (member, turn) => {
        spoke.push(member.id)
        return [{ id: `${member.id}:${turn.round}`, role: 'assistant', sender: { id: member.id, name: member.name }, content: 'done' }]
      }
    })

    expect(spoke).toEqual(['b'])
  })

  it('respects an initial no-reply decision for messages addressed only to humans', async () => {
    const user: GroupMessage = { id: 'u1', role: 'user', content: '小王，晚上几点到？AI 不需要回复。' }
    const decide = vi.fn().mockResolvedValue({ mode: 'none', memberIds: [], triggerMessageIds: [] })
    const spoke: string[] = []
    const result = await runGroupConversation({
      group,
      user,
      signal: new AbortController().signal,
      decide,
      reply: async (member, turn) => {
        spoke.push(member.id)
        return [{ id: `${member.id}:${turn.round}`, role: 'assistant', sender: { id: member.id, name: member.name }, content: 'answer' }]
      }
    })

    expect(spoke).toEqual([])
    expect(result.failed).toBe(false)
  })

  it('fails over to another member when one cannot reply', async () => {
    const user: GroupMessage = { id: 'u1', role: 'user', content: '@Ann take this' }
    const spoke: string[] = []
    const result = await runGroupConversation({
      group,
      user,
      signal: new AbortController().signal,
      decide: async context => context.completedTurns.length ? { mode: 'none', memberIds: [], triggerMessageIds: [] } : { mode: 'single', memberIds: ['a'], triggerMessageIds: ['u1'] },
      reply: async (member, turn) => {
        spoke.push(member.id)
        if (member.id === 'a') return { messages: [], failed: true }
        return [{ id: `${member.id}:${turn.round}`, role: 'assistant', sender: { id: member.id, name: member.name }, content: 'ok' }]
      }
    })

    expect(spoke[0]).toBe('a')
    expect(spoke).toContain('b')
    expect(result.failed).toBe(false)
    expect(result.unavailableMemberIds).toEqual(['a'])
  })

  it('isolates every member session per group topic', () => {
    expect(groupMemberSessionId('g', 'a', 't1')).not.toBe(groupMemberSessionId('g', 'a', 't2'))
  })
})

describe('private and agent-to-agent transport', () => {
  it('removes private blocks from the public text', () => {
    const parsed = parsePrivateReply('public [[private:b]]secret[[/private]] tail')
    expect(parsed.publicText).toBe('public  tail')
    expect(parsed.deliveries).toEqual([{ to: 'b', content: 'secret' }])
  })

  it('withholds a partially streamed opening marker', () => {
    expect(parsePrivateReply('visible [[priv').publicText).toBe('visible ')
    expect(parsePrivateReply('visible [[priv').incomplete).toBe(true)
  })

  it('drops every delivery when one recipient is unknown', () => {
    const delivery = privateReplyDeliveries('[[private:nobody]]hi[[/private]]', members[0], members, 'r1')
    expect(delivery.invalid).toBe(true)
    expect(delivery.messages).toHaveLength(0)
  })

  it('accepts the human as a private address', () => {
    const delivery = privateReplyDeliveries('[[private:human]]just for you[[/private]]', members[0], members, 'r1', 't1')
    expect(delivery.messages).toHaveLength(1)
    expect(delivery.messages[0].recipient.id).toBe('human')
    expect(delivery.messages[0].topicId).toBe('t1')
  })

  it('accepts only opaque ids for agent-to-agent delivery', () => {
    expect(a2aReplyMessages('[[a2a:b]]look at this[[/a2a]]', members[0], members.slice(1), 'r1').messages).toHaveLength(1)
    expect(a2aReplyMessages('[[a2a:Anna]]look at this[[/a2a]]', members[0], members.slice(1), 'r1').invalid).toBe(true)
  })
})

describe('inbox preview', () => {
  it('flattens markdown into one line', () => {
    expect(markdownPreview('# Title\n\n- one `code`\n- [two](https://x.dev)')).toBe('Title one code two')
  })

  it('shows the newest bot line with its speaker', () => {
    const preview = latestAssistantPreview([
      { authorId: 'user', authorName: 'You', text: 'hi', createdAt: 1 },
      { authorId: 'a', authorName: 'Ann', text: '**done**', createdAt: 2 }
    ])
    expect(preview).toEqual({ text: 'done', authorId: 'a', authorName: 'Ann' })
  })
})

describe('contact index', () => {
  it('files Han names under their pinyin initial', () => {
    expect(contactSection('张小鱼')).toBe('Z')
    expect(contactSection('欧阳智')).toBe('O')
    expect(contactSection('李木')).toBe('L')
    expect(contactSection('阿明')).toBe('A')
  })

  it('files latin names under their own letter and everything else under #', () => {
    expect(contactSection('nova')).toBe('N')
    expect(contactSection('  Dobi')).toBe('D')
    expect(contactSection('🤖 helper')).toBe('#')
    expect(contactSection('')).toBe('#')
  })

  it('builds sections in index order with # last', () => {
    const sections = contactSections([
      { id: '1', name: '张小鱼' },
      { id: '2', name: 'Nova' },
      { id: '3', name: '+1 bot' },
      { id: '4', name: 'nine' },
      { id: '5', name: '欧阳智' }
    ])
    expect(sections.map((section) => section.letter)).toEqual(['N', 'O', 'Z', '#'])
    expect(sections[0].contacts.map((contact) => contact.name)).toEqual(['nine', 'Nova'])
  })

  it('matches a search query case-insensitively', () => {
    expect(matchesContactQuery('Nova', 'nov')).toBe(true)
    expect(matchesContactQuery('Nova', '  ')).toBe(true)
    expect(matchesContactQuery('Nova', 'lin')).toBe(false)
  })
})

describe('summarizeRuntimeError', () => {
  it('explains Grok socket sandbox failures without losing diagnostics', () => {
    const raw = 'Grok Build: sandbox could not be applied: socket deny resolution failed: /var/run/docker.sock: endpoint is a symlink'
    expect(summarizeRuntimeError(raw)).toMatchObject({
      title: 'Grok cannot start with the current Docker socket setup',
      action: { kind: 'update-local-agent', agentId: 'grok' },
      detail: raw
    })
    expect(isRetryableRuntimeError(raw)).toBe(false)
  })
  const codexDump =
    'Codex: :"ef5a1e03","to":"everyone","content":"Hey"}],"completedTurns":[] ' +
    'ERROR: Reconnecting... 1/5 ERROR: Reconnecting... 2/5 ERROR: Reconnecting... 3/5 ' +
    'ERROR: unexpected status 401 Unauthorized: CC Switch local proxy failed while handling ' +
    'Codex endpoint /responses. Provider: OpenRouter; model: gpt-5.2; upstream_status: HTTP 401; ' +
    'cause: User not found., url: http://127.0.0.1:5000/v1/responses ' +
    'ERROR: unexpected status 401 Unauthorized: CC Switch local proxy failed while handling ' +
    'Codex endpoint /responses. Provider: OpenRouter; model: gpt-5.2; upstream_status: HTTP 401; ' +
    'cause: User not found., url: http://127.0.0.1:5000/v1/responses'

  it('reduces a CLI dump to one actionable line and keeps the original', () => {
    const { title, detail } = summarizeRuntimeError(codexDump)
    expect(title).toBe(
      'The model endpoint rejected the request · HTTP 401 · OpenRouter · gpt-5.2 · User not found · after 3 retries'
    )
    // The echoed transcript never reaches the headline.
    expect(title).not.toContain('completedTurns')
    expect(detail).toBe(codexDump)
  })

  it('names the common transport and status failures', () => {
    expect(summarizeRuntimeError('ERROR: fetch failed ECONNREFUSED 127.0.0.1:8080').title).toContain(
      'Could not reach the model endpoint'
    )
    expect(summarizeRuntimeError('ERROR: unexpected status 429 Too Many Requests').title).toContain(
      'rate limiting'
    )
    expect(summarizeRuntimeError('ERROR: unexpected status 503 Service Unavailable').title).toContain(
      'server error'
    )
    expect(summarizeRuntimeError('ERROR: Reconnecting... 1/5 ERROR: Reconnecting... 2/5').title).toBe(
      'Lost the connection to the model endpoint · after 2 retries'
    )
    expect(summarizeRuntimeError('Request was aborted').title).toBe('The model connection was interrupted')
    expect(summarizeRuntimeError('Douchat needs permission to access Downloads. (EPERM)').title).toBe(
      'Douchat does not have permission to access that local file or folder'
    )
  })

  it('explains OpenClaw authentication and migration failures without promoting startup warnings', () => {
    const raw = 'OpenClaw: [skills] Skill precedence collision: skill="skill-creator"\n[diagnostic] lane task error: lane=main durationMs=23 error="No route-compatible authentication source is configured for openai." errorName=Error'
    expect(summarizeRuntimeError(raw)).toEqual({
      title: 'OpenClaw cannot authenticate with the selected model',
      guidance: 'Configure authentication for this model in OpenClaw, or select a model already configured there, then try again.',
      detail: raw
    })
    expect(summarizeRuntimeError('OpenClaw agent database uses schema version 19; stop active agents and run openclaw doctor --fix to migrate session identities.').title).toBe('OpenClaw needs a local data upgrade')
    expect(isRetryableRuntimeError(raw)).toBe(false)
  })

  it('shows the OMP billing failure instead of its Working progress line', () => {
    const raw = 'OMP: Working...\n400 {"error":{"message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'
    expect(summarizeRuntimeError(raw)).toEqual({
      title: 'OMP’s Anthropic API credit is insufficient',
      guidance: 'Select the model you use in OMP, or top up that provider’s API balance. Douchat credits do not cover local agent usage.',
      detail: raw
    })
    expect(isRetryableRuntimeError(raw)).toBe(false)
  })

  it('turns local Claude failures into an immediate next step', () => {
    expect(summarizeRuntimeError('Claude Code: Exited with status 1')).toMatchObject({
      title: 'Claude Code could not start',
      guidance: 'Open Claude Code in Terminal once. Finish signing in or fix the error shown there, then return to Douchat and try again.'
    })
    expect(summarizeRuntimeError('Claude Code: Please run /login')).toMatchObject({
      title: 'Claude Code is not signed in',
      guidance: 'Open Claude Code in Terminal and sign in, then return to Douchat and try again.'
    })
    expect(summarizeRuntimeError('Claude Code: Credit balance is too low')).toMatchObject({
      title: 'Claude Code does not have enough credit',
      guidance: 'Open Claude Code in Terminal and add credit or switch to an account with available usage, then return to Douchat and try again.',
      action: { kind: 'open-local-agent-terminal', agentId: 'claude', label: 'Open Claude Code' }
    })
  })

  it('turns a Douchat credit failure into the top-up recovery path', () => {
    expect(isDouchatCreditError('429: {"message":"Douchat credit balance is insufficient"}')).toBe(true)
    expect(isDouchatCreditError('Douchat 点数不足，暂时无法完成此请求。')).toBe(true)
    expect(summarizeRuntimeError('429: {"message":"Douchat credit balance is insufficient"}')).toMatchObject({
      title: 'Douchat does not have enough credits',
      guidance: 'Top up credits to continue.',
      action: { kind: 'open-douchat-credits', label: 'Top up credits' }
    })
  })

  it('retries only transient runtime failures', () => {
    expect(isRetryableRuntimeError('Request was aborted')).toBe(true)
    expect(isRetryableRuntimeError('stream_interrupted')).toBe(true)
    expect(isRetryableRuntimeError('unexpected status 503 Service Unavailable')).toBe(true)
    expect(isRetryableRuntimeError('context_length_exceeded: too many tokens')).toBe(false)
    expect(isRetryableRuntimeError('unexpected status 401 Unauthorized')).toBe(false)
    expect(isRetryableRuntimeError('insufficient_quota')).toBe(false)
  })

  it('passes a plain message through and never returns an empty headline', () => {
    expect(summarizeRuntimeError('Dobi finished without a text response.').title).toBe(
      'Dobi finished without a text response'
    )
    expect(summarizeRuntimeError('   ').title).toBe('The conversation could not finish.')
  })

  it('caps a runaway headline', () => {
    const { title } = summarizeRuntimeError('x'.repeat(500))
    expect(title.length).toBeLessThanOrEqual(180)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('mention-only group members', () => {
  const members = [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }, { id: 'c', name: 'Cy' }]
  it('keeps every member when none is mention-only', () => {
    expect(mentionOnlyFilter(members, [], 'hello', undefined)).toHaveLength(3)
  })
  it('drops mention-only members unless the message @mentions them', () => {
    expect(mentionOnlyFilter(members, ['b'], 'any ideas?').map(m => m.id)).toEqual(['a', 'c'])
    expect(mentionOnlyFilter(members, ['b'], '@Bob any ideas?').map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(mentionOnlyFilter(members, ['b', 'c'], 'hi', [{ id: 'c' }]).map(m => m.id)).toEqual(['a', 'c'])
    expect(mentionOnlyFilter(members, ['a', 'b', 'c'], '@all status?').map(m => m.id)).toEqual(['a', 'b', 'c'])
  })
})
