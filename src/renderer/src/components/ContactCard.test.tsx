// @vitest-environment jsdom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig, AppSnapshot, Conversation } from '../../../shared/types'

vi.mock('../preferences', () => ({
  t: (text: string) => text
}))

vi.mock('./common', () => ({
  UserAvatar: ({ name }: { name: string }) => <span data-user-avatar={name} />,
  AgentAvatar: ({ agent }: { agent: AgentConfig }) => <span data-agent-avatar={agent.id} />,
  ConversationAvatar: ({ conversation }: { conversation: Conversation }) => (
    <span data-conversation-avatar={conversation.id} />
  ),
  agentDisplayName: (agent: AgentConfig) => agent.name,
  agentSourceLabel: (agent: AgentConfig) => agent.localAgentId ? `Local · ${agent.localAgentId}` : 'Cloud'
}))

import { ContactCard, SelfProfileCard } from './ContactCard'

const agents: AgentConfig[] = [
  { id: 'alpha', name: 'Alpha', role: '', instructions: '', color: '#14B8A6', provider: '', model: '', createdAt: 1 },
  { id: 'beta', name: 'Beta', role: '', instructions: '', color: '#7C6CF2', provider: '', model: '', createdAt: 2 }
]

const group: Conversation = {
  id: 'group-team',
  type: 'group',
  name: 'Team room',
  description: 'A busy group description that should not compete with the open action.',
  agentIds: ['alpha', 'beta'],
  leadAgentId: 'alpha',
  topics: [],
  activeTopicId: '',
  unread: 0,
  readAt: 0,
  createdAt: 1,
  updatedAt: 1
}

const snapshot = { agents, conversations: [group] } as AppSnapshot

describe('group contact profile', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    document.documentElement.lang = 'en'
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('has only one edit-agent entry for all contact settings', async () => {
    const configure = vi.fn()
    await act(async () => root.render(<ContactCard snapshot={snapshot} selection={{ kind: 'bot', id: agents[0].id }}
      onConfigureIM={vi.fn()} onConfigureModel={vi.fn()} onEditPermissions={vi.fn()}
      onMessage={vi.fn()} onStartDirect={vi.fn()} onEditBot={configure} onDeleteBot={vi.fn()} onTogglePin={vi.fn()} />))
    expect(container.querySelector('[aria-label="Agent menu"]')).toBeNull()
    const items = [...container.querySelectorAll('.contact-profile-actions button')].filter(button => button.textContent === 'Edit agent') as HTMLButtonElement[]
    expect(items.map(item => item.textContent)).toEqual(['Edit agent'])
    await act(async () => items[0].click())
    expect(configure).toHaveBeenCalledWith(agents[0])
  })

  it('never labels an unresolved custom binding as the cloud default', async () => {
    Object.defineProperty(window, 'douchat', { configurable: true, value: { getCustomModels: vi.fn().mockResolvedValue({ providers: [], defaultModel: '' }) } })
    const follower = { ...agents[0], provider: 'custom:@unavailable', model: 'default', followDefaultModel: true }
    await act(async () => root.render(<ContactCard snapshot={{ ...snapshot, agents: [follower] }} selection={{ kind: 'bot', id: follower.id }}
      onConfigureModel={vi.fn()} onMessage={vi.fn()} onStartDirect={vi.fn()} onEditBot={vi.fn()} onDeleteBot={vi.fn()} onTogglePin={vi.fn()} />))
    expect(container.textContent).toContain('Follow default model · No default model set')
    expect(container.textContent).not.toContain('Cloud default')
  })

  it('shows a local model and opens the unified editor from the profile actions', async () => {
    Object.defineProperty(window, 'douchat', { configurable: true, value: { listLocalAgentModels: vi.fn().mockResolvedValue({ models: [{ id: 'provider/test', name: 'Test Model' }] }) } })
    const configure = vi.fn()
    const local = { ...agents[0], localAgentId: 'opencode', model: 'provider/test' }
    await act(async () => root.render(<ContactCard snapshot={{ ...snapshot, agents: [local] }} selection={{ kind: 'bot', id: local.id }}
      onConfigureModel={vi.fn()} onMessage={vi.fn()} onStartDirect={vi.fn()} onEditBot={configure} onDeleteBot={vi.fn()} onTogglePin={vi.fn()} />))
    expect(container.textContent).toContain('Test Model')
    expect(container.textContent).not.toContain('provider/test')
    const item = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Edit agent')!
    await act(async () => item.click())
    expect(configure).toHaveBeenCalledWith(local)
  })
  it('shows another owner’s agent without editing or direct messaging controls', async () => {
    await act(async () => root.render(<ContactCard snapshot={snapshot} selection={{ kind: 'bot', id: 'alpha' }} readOnly ownerName="Alice"
      onMessage={vi.fn()} onStartDirect={vi.fn()} onEditBot={vi.fn()} onDeleteBot={vi.fn()} onTogglePin={vi.fn()} />))
    expect(container.querySelector('h1')?.textContent).toBe('Alpha')
    expect(container.textContent).toContain('Owned byAlice')
    expect(container.querySelector('[aria-label="Agent menu"]')).toBeNull()
    expect(container.textContent).not.toContain('Send message')
    expect(container.textContent).not.toContain('Edit agent')
  })

  it('shows a human group member even without a friendship', async () => {
    await act(async () => root.render(<ContactCard snapshot={snapshot} selection={{ kind: 'friend', id: 'bob' }}
      social={{ userId: 'me', friendships: [], rooms: [{ id: 'room', name: 'Team', kind: 'group', agents: [], createdAt: '', members: [{ id: 'bob', name: 'Bob', email: 'bob@test' }] }] }}
      onMessage={vi.fn()} onStartDirect={vi.fn()} onEditBot={vi.fn()} onDeleteBot={vi.fn()} onTogglePin={vi.fn()} />))
    expect(container.querySelector('h1')?.textContent).toBe('Bob')
    expect(container.textContent).not.toContain('bob@test')
    expect([...container.querySelectorAll('.contact-field')].some((field) => field.textContent?.startsWith('Email'))).toBe(false)
    expect(container.textContent).not.toContain('Send message')
  })

  it('continues to show the signed-in user their own email address', async () => {
    await act(async () => root.render(<SelfProfileCard name="Alice" email="alice@example.com" avatar="" onEdit={vi.fn()} />))
    expect(container.textContent).toContain('alice@example.com')
  })

  it('keeps the group page focused on entering the chat', async () => {
    const onMessage = vi.fn()
    await act(async () => root.render(
      <ContactCard
        snapshot={snapshot}
        selection={{ kind: 'group', id: group.id }}
        onMessage={onMessage}
        onStartDirect={vi.fn()}
        onEditBot={vi.fn()}
        onDeleteBot={vi.fn()}
        onTogglePin={vi.fn()}
      />
    ))

    expect(container.querySelector('[data-conversation-avatar="group-team"]')).not.toBeNull()
    expect(container.querySelector('.group-profile-main h1')?.textContent).toBe('Team room')
    expect(container.querySelector('.contact-members')).toBeNull()
    expect(container.textContent).not.toContain(group.description)
    expect(container.querySelector('.group-profile-toolbar')).toBeNull()
    expect(container.querySelector('.group-profile-footer')).toBeNull()

    const open = container.querySelector<HTMLButtonElement>('.group-profile-primary')!
    await act(async () => open.click())

    expect(onMessage).toHaveBeenCalledWith(group.id)
  })

  it('keeps the system administrator in contacts after its chat is deleted', async () => {
    const admin: AgentConfig = {
      id: 'system-admin-1',
      name: 'Dr. Dou',
      systemRole: 'admin',
      role: '豆博士',
      instructions: '',
      color: '#14B8A6',
      provider: 'gateway',
      model: 'default',
      createdAt: 1
    }
    const onStartDirect = vi.fn()
    await act(async () => root.render(
      <ContactCard
        snapshot={{ ...snapshot, agents: [admin], conversations: [] }}
        selection={{ kind: 'bot', id: admin.id }}
        onMessage={vi.fn()}
        onStartDirect={onStartDirect}
        onEditBot={vi.fn()}
        onDeleteBot={vi.fn()}
        onTogglePin={vi.fn()}
      />
    ))

    expect(container.textContent).toContain('Edit agent')
    expect(container.textContent).not.toContain('Delete agent')
    expect(container.querySelector('.contact-profile-identity p')?.textContent).toBe('Built-in')
    expect([...container.querySelectorAll('.contact-field')].find((field) => field.textContent?.startsWith('Run mode'))?.textContent).toBe('Run modeCloud')

    await act(async () => container.querySelector<HTMLButtonElement>('.contact-profile-actions button')!.click())
    expect(onStartDirect).toHaveBeenCalledWith(admin.id)
  })
  it('uses the same profile layout for friend requests and accepted friends', async () => {
    const respond = vi.fn(async () => {})
    const message = vi.fn()
    const relation = { id: 'request', senderId: 'bob', recipientId: 'me', status: 'pending' as const, person: { id: 'bob', name: 'Bob', email: 'bob@example.com' } }
    const props = { snapshot, selection: { kind: 'friend' as const, id: 'bob' }, onMessage: vi.fn(), onStartDirect: vi.fn(), onEditBot: vi.fn(), onDeleteBot: vi.fn(), onTogglePin: vi.fn(), onFriendMessage: message, onRespondRequest: respond }
    await act(async () => root.render(<ContactCard {...props} social={{ userId: 'me', rooms: [], friendships: [relation] }} />))
    expect(container.querySelector('.contact-profile-sheet')).not.toBeNull()
    expect(container.textContent).not.toContain('bob@example.com')
    expect(container.querySelector('.profile-edit')).toBeNull()
    const accept = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Accept request')!
    await act(async () => accept.click())
    expect(respond).toHaveBeenCalledWith('request', true)
    await act(async () => root.render(<ContactCard {...props} social={{ userId: 'me', rooms: [], friendships: [{ ...relation, status: 'accepted' }] }} />))
    expect(container.textContent).toContain('bob@example.com')
    const send = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Send message')!
    await act(async () => send.click())
    expect(message).toHaveBeenCalledWith('bob')
    expect(container.textContent).not.toContain('Accept request')
  })

})
