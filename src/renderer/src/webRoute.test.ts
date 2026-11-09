import { describe, expect, it } from 'vitest'
import { conversationCode, readRoute, resolveConversation, routePath } from './webRoute'

describe('web app addresses', () => {
  const conversations = [{ id: 'direct-system-admin-43c923d0-c05a-480f-a5d6-278b96799865' }, { id: 'friend:owner:dm-9b4fb0cd6c078adee754905' }]

  it('names a conversation by a short code every device derives the same way', () => {
    const code = conversationCode(conversations[0].id)
    expect(code).toMatch(/^[0-9a-z]{1,11}$/)
    expect(conversationCode(conversations[0].id)).toBe(code)
    expect(conversationCode(conversations[1].id)).not.toBe(code)
    expect(routePath({ view: 'chats', conversationId: conversations[0].id }, '/app')).toBe(`/app/chat/${code}`)
    expect(resolveConversation(code, conversations)).toBe(conversations[0].id)
  })

  it('still opens older links that carry the full id, and ignores unknown codes', () => {
    expect(resolveConversation(conversations[1].id, conversations)).toBe(conversations[1].id)
    expect(resolveConversation('unknown', conversations)).toBeUndefined()
  })

  it('reads pages under /app and at the root of app.douchat.ai', () => {
    expect(readRoute('/app/chat/abc')).toEqual({ view: 'chats', conversationId: 'abc' })
    expect(readRoute('/chat/abc')).toEqual({ view: 'chats', conversationId: 'abc' })
    expect(readRoute('/app/contacts')).toEqual({ view: 'contacts' })
    expect(readRoute('/app/settings/general')).toEqual({ view: 'chats', settingsTab: 'general' })
    expect(readRoute('/app/settings/nope')).toEqual({ view: 'chats', settingsTab: 'profile' })
    expect(routePath({ view: 'contacts' }, '')).toBe('/contacts')
  })

  it('addresses Discover pages, and sends older settings links for them there', () => {
    expect(readRoute('/app/discover')).toEqual({ view: 'discover' })
    expect(readRoute('/app/discover/connectors')).toEqual({ view: 'discover', discoverPage: 'connectors' })
    expect(readRoute('/app/discover/nope')).toEqual({ view: 'discover' })
    expect(readRoute('/app/settings/automation')).toEqual({ view: 'discover', discoverPage: 'automation' })
    expect(readRoute('/app/settings/connectors')).toEqual({ view: 'discover', discoverPage: 'connectors' })
    expect(routePath({ view: 'discover', discoverPage: 'automation' }, '/app')).toBe('/app/automation')
    expect(routePath({ view: 'discover', discoverPage: 'connectors' }, '')).toBe('/connectors')
    expect(readRoute('/app/automation')).toEqual({ view: 'discover', discoverPage: 'automation' })
    expect(readRoute('/app/connectors')).toEqual({ view: 'discover', discoverPage: 'connectors' })
    expect(routePath({ view: 'discover' }, '')).toBe('/discover')
  })

  it('addresses Devices & Environments, and keeps the older connections links working', () => {
    expect(readRoute('/app/devices')).toEqual({ view: 'discover', discoverPage: 'devices' })
    expect(readRoute('/devices')).toEqual({ view: 'discover', discoverPage: 'devices' })
    expect(readRoute('/app/discover/devices')).toEqual({ view: 'discover', discoverPage: 'devices' })
    expect(routePath({ view: 'discover', discoverPage: 'devices' }, '/app')).toBe('/app/devices')
    // Servers moved from Settings → Connections; that tab still exists and explains the web and desktop apps.
    expect(readRoute('/app/connections')).toEqual({ view: 'discover', discoverPage: 'devices' })
    expect(readRoute('/connections')).toEqual({ view: 'discover', discoverPage: 'devices' })
    expect(readRoute('/app/discover/connections')).toEqual({ view: 'discover', discoverPage: 'devices' })
    expect(readRoute('/app/settings/connections')).toEqual({ view: 'chats', settingsTab: 'connections' })
    expect(readRoute('/settings/connections')).toEqual({ view: 'chats', settingsTab: 'connections' })
  })
})
