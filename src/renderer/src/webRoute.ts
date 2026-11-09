import type { AppView } from './components/AppRail'
import type { DiscoverPage } from './components/DiscoverView'
import type { SettingsTab } from './components/SettingsPanel'

/**
 * Addresses for the web app, so reload, back/forward and shared links land on
 * the same chat or page. The desktop app has no address bar and ignores this.
 *
 *   /chat              chat list          /contacts            contacts
 *   /chat/<code>       one conversation   /settings/<tab>      settings
 *   /discover          Discover list      /<page>              a Discover page (/automation, /connectors, /devices)
 *
 * A conversation appears by a short code derived from its id rather than the
 * id itself: ids are long compound keys that other records reference, and
 * every device has the same id, so every device derives the same code.
 *
 * On douchat.ai these live under /app; on app.douchat.ai at the root.
 */

const SETTINGS_TABS: readonly SettingsTab[] = ['memory', 'profile', 'general', 'usage', 'agents', 'connections', 'models', 'scheduling', 'about', 'more']
const DISCOVER_PAGES: readonly DiscoverPage[] = ['automation', 'connectors', 'devices']
/** Older top-level addresses of Discover pages. */
const DISCOVER_ALIASES: Readonly<Record<string, DiscoverPage>> = { connections: 'devices' }

export interface WebRoute {
  view: AppView
  /** In a route read from the address, the conversation's code, not its id. */
  conversationId?: string
  settingsTab?: SettingsTab
  /** A page under Discover; absent for its bare list (a phone's first Discover screen). */
  discoverPage?: DiscoverPage
}

/** 53-bit cyrb53 hash in base 36: short, stable, and synchronous. */
export function conversationCode(id: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let index = 0; index < id.length; index++) {
    const char = id.charCodeAt(index)
    h1 = Math.imul(h1 ^ char, 2654435761)
    h2 = Math.imul(h2 ^ char, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** The conversation an address names; older links with the full id still work. */
export function resolveConversation(code: string | undefined, conversations: { id: string }[]): string | undefined {
  if (!code) return undefined
  return conversations.find((conversation) => conversation.id === code || conversationCode(conversation.id) === code)?.id
}

export const usesWebRoutes = (): boolean => window.douchat?.platform === 'web'

export function routeBase(pathname = window.location.pathname): string {
  if (typeof window !== 'undefined' && window.location.hostname.startsWith('app.')) return ''
  return pathname === '/app' || pathname.startsWith('/app/') ? '/app' : ''
}

export function readRoute(pathname = window.location.pathname): WebRoute {
  const parts = pathname.slice(routeBase(pathname).length).split('/').filter(Boolean).map(decodeURIComponent)
  if (parts[0] === 'contacts') return { view: 'contacts' }
  // Discover pages live at the top level; /discover/<page> and the Settings
  // tabs they moved from are older links that still land on them.
  // /connections (servers moved from Settings → Connections) opens Devices & Environments;
  // /settings/connections is still the Settings tab, which now explains the web and desktop apps.
  const top = DISCOVER_ALIASES[parts[0]] ?? parts[0]
  const discover = DISCOVER_PAGES.includes(top as DiscoverPage) ? top : parts[0] === 'discover' ? DISCOVER_ALIASES[parts[1]] ?? parts[1] : parts[0] === 'settings' && DISCOVER_PAGES.includes(parts[1] as DiscoverPage) ? parts[1] : undefined
  if (parts[0] === 'discover' || discover) return { view: 'discover', ...(DISCOVER_PAGES.includes(discover as DiscoverPage) ? { discoverPage: discover as DiscoverPage } : {}) }
  if (parts[0] === 'settings') {
    const tab = SETTINGS_TABS.includes(parts[1] as SettingsTab) ? parts[1] as SettingsTab : 'profile'
    return { view: 'chats', settingsTab: tab }
  }
  return { view: 'chats', ...(parts[0] === 'chat' && parts[1] ? { conversationId: parts[1] } : {}) }
}

export function routePath(route: WebRoute, base = routeBase()): string {
  if (route.settingsTab) return `${base}/settings/${route.settingsTab}`
  if (route.view === 'contacts') return `${base}/contacts`
  if (route.view === 'discover') return route.discoverPage ? `${base}/${route.discoverPage}` : `${base}/discover`
  return route.conversationId ? `${base}/chat/${conversationCode(route.conversationId)}` : `${base}/chat`
}

/**
 * Record the page in the address bar. On a wide screen, arriving at a chat
 * from the bare chat list (the app opening its first chat) replaces that
 * entry, so Back leaves the app rather than stepping through it. On a phone
 * the list and the chat are separate screens, so opening a chat adds an entry
 * and Back returns to the list.
 */
export function showRoute(route: WebRoute, options: { separateScreens?: boolean; awaitingChat?: boolean } = {}): void {
  const path = routePath(route)
  if (path === window.location.pathname) return
  const current = readRoute()
  // The address still names a chat the inbox has not loaded yet; keep it.
  if (options.awaitingChat && current.conversationId && !route.conversationId) return
  // Rewriting an older full-id link to its code is the same page.
  const same = current.conversationId === route.conversationId && !current.settingsTab && current.view === route.view
  const firstChat = !options.separateScreens && !current.conversationId && !current.settingsTab && current.view === route.view && Boolean(route.conversationId)
  window.history[same || firstChat ? 'replaceState' : 'pushState'](null, '', path)
}

/** A phone-sized web page: one screen at a time, sections in a bottom bar. */
export const COMPACT_LAYOUT_QUERY = '(max-width: 768px)'
