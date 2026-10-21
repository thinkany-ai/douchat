import type { SelectedMention } from '../../shared/bot/mentions'
import { AgentSettingsDialog } from './components/AgentSettingsDialog'
import { reportDiagnostic } from './diagnostics'
import { ChatErrorBoundary } from './components/ChatErrorBoundary'
import { AgentPermissionPrompt } from './components/AgentPermissions'
import { DialogErrorBoundary } from './components/DialogErrorBoundary'
import { messageSendError, MessageQueue, type QueuedMessage } from './messageQueue'
import type { SocialSnapshot } from '../../shared/social'
import { AddFriendModal } from './components/AddFriendModal'
import { SocialWorkspace } from './components/SocialWorkspace'
import { ChevronLeft, X } from 'lucide-react'
import { resolveInterfaceLanguage, t, tr, usePreferences } from './preferences'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AgentConfig,
  LocalAgent,
  AppSnapshot,
  Conversation,
  CreateAgentInput,
  CreateGroupInput,
  DesktopAuthState,
  MessageImageInput,
  MessageFileInput,
  UpdateAgentInput
} from '../../shared/types'
import { SettingsPanel, type SettingsTab } from './components/SettingsPanel'
import { AppRail, type AppView } from './components/AppRail'
import { DiscoverContent, DiscoverSidebar, type DiscoverPage } from './components/DiscoverView'
import { COMPACT_LAYOUT_QUERY, readRoute, resolveConversation, showRoute, usesWebRoutes } from './webRoute'
import { BotInbox } from './components/BotInbox'
import { MemberProfilePopover, type ProfileAnchor } from './components/MemberProfilePopover'
import { ContactCard, SelfProfileCard } from './components/ContactCard'
import { ContactList, type ContactSelection } from './components/ContactList'
import { isDouchatCreditError } from '../../shared/bot/errors'
import { ChatPane } from './components/ChatPane'
import { InspectorRail } from './components/InspectorRail'
import { AddMembersModal, BotModal, EndpointModal, GroupModal } from './components/dialogs'
import { agentDisplayName, conversationMembers } from './components/common'
import { setRemoteAgents } from './components/RemoteMark'
import { LoginScreen } from './components/LoginScreen'
import { CodeArtifactWindow } from './components/CodeArtifactWindow'
import { isImeCommitEnter } from './ime'
import { withAccountIdentity } from './accountIdentity'

type Dialog =
  | { kind: 'agent-permissions'; agent: AgentConfig }
  | { kind: 'self-profile'; anchor: ProfileAnchor }
  | { kind: 'add-friend' }
  | { kind: 'friend-profile'; personId: string; anchor: ProfileAnchor }
  | { kind: 'member-profile'; agentId: string; anchor: ProfileAnchor }
  | { kind: 'im-channels'; agent: AgentConfig }
  | { kind: 'local-model'; agent: AgentConfig }
  | { kind: 'bot'; agent?: AgentConfig; localAgentId?: string }
  | { kind: 'add-members' | 'remove-members'; conversation: Conversation }
  | { kind: 'group'; conversation?: Conversation; initialAgentIds?: string[]; initialFriendIds?: string[] }
  | { kind: 'endpoint' }
  | null

export function App(): ReactElement {
  const artifactId = new URLSearchParams(window.location.search).get('artifact')
  return artifactId ? <CodeArtifactWindow artifactId={artifactId} /> : <WorkspaceApp />
}

function WorkspaceApp(): ReactElement {
  const preferences = usePreferences()
  const imeComposing = useRef(false)
  const [authState, setAuthState] = useState<DesktopAuthState>({ status: 'checking' })
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([])
  const [messageQueue] = useState(() => new MessageQueue(setQueuedMessages))
  useEffect(() => { messageQueue.kick() }, [snapshot, messageQueue])
  const detachedId = new URLSearchParams(window.location.search).get('conversation')
  const [initialRoute] = useState(() => usesWebRoutes() ? readRoute() : undefined)
  const [activeId, setActiveId] = useState(detachedId || '')
  /** A conversation named by the web address, opened once the inbox has loaded. */
  const routedConversation = useRef(initialRoute?.conversationId)
  const [view, setView] = useState<AppView>(initialRoute?.view ?? 'chats')
  const [settingsOpen, updateSettingsOpen] = useState(Boolean(initialRoute?.settingsTab))
  function setSettingsOpen(open: boolean): void {
    reportDiagnostic(open ? 'settings.open-request' : 'settings.close')
    updateSettingsOpen(open)
  }
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(initialRoute?.settingsTab ?? 'profile')
  const [discoverPage, setDiscoverPage] = useState<DiscoverPage>(initialRoute?.discoverPage ?? 'automation')
  // The web app mirrors the page in its address, and follows Back/Forward.
  // On a phone the list and the open chat (or contact) are separate screens.
  const compact = useCompactLayout()
  const [detailOpen, setDetailOpen] = useState(Boolean(initialRoute?.conversationId || initialRoute?.discoverPage))
  /** The open chat added a history entry, so Back (or the back button) returns to the list. */
  const detailPushed = useRef(false)
  const openDetail = (): void => {
    if (!compact || detailOpen) return
    detailPushed.current = true
    setDetailOpen(true)
  }
  const closeDetail = (): void => {
    if (detailPushed.current) { detailPushed.current = false; window.history.back(); return }
    setDetailOpen(false)
  }
  useEffect(() => {
    if (!usesWebRoutes()) return
    const showsChat = view === 'chats' && (!compact || detailOpen)
    showRoute({ view, conversationId: showsChat ? activeId || undefined : undefined, settingsTab: settingsOpen ? settingsTab : undefined,
      discoverPage: view === 'discover' && (!compact || detailOpen) ? discoverPage : undefined },
      { separateScreens: compact, awaitingChat: Boolean(routedConversation.current) })
  }, [view, activeId, settingsOpen, settingsTab, compact, detailOpen, discoverPage])
  useEffect(() => {
    if (!usesWebRoutes()) return
    const follow = () => {
      const route = readRoute()
      setView(route.view)
      if (route.discoverPage) setDiscoverPage(route.discoverPage)
      const routed = resolveConversation(route.conversationId, snapshotRef.current?.conversations ?? [])
      if (routed) setActiveId(routed)
      updateSettingsOpen(Boolean(route.settingsTab))
      if (route.settingsTab) setSettingsTab(route.settingsTab)
      if (!route.settingsTab) {
        // Back from a chat on a phone is back to the list.
        if (!route.conversationId) detailPushed.current = false
        if (route.view === 'chats') setDetailOpen(Boolean(route.conversationId))
        if (route.view === 'discover') setDetailOpen(Boolean(route.discoverPage))
      }
    }
    window.addEventListener('popstate', follow)
    return () => window.removeEventListener('popstate', follow)
  }, [])
  const [creditsRefreshToken, setCreditsRefreshToken] = useState(0)
  const [creditsAttention, setCreditsAttention] = useState(false)
  const knownCreditErrors = useRef<Set<string> | null>(null)
  const [socialSnapshot, setSocialSnapshot] = useState<SocialSnapshot>()
  const socialRefreshVersion = useRef(0)
  const [socialError, setSocialError] = useState('')
  const [contact, setContact] = useState<ContactSelection>()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [showInspector, setShowInspector] = useState(false)
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey
        || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
      // Do not move focus out of a modal into the inactive window behind it.
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return
      const input = document.querySelector<HTMLInputElement>('input[data-app-search]')
      if (!input || input.disabled) return
      event.preventDefault()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])
  const [inspectorAgentId, setInspectorAgentId] = useState<string>()
  const interfaceLanguage = resolveInterfaceLanguage(preferences.language)
  const openCreditRecovery = useCallback(() => {
    setSettingsTab('usage')
    setSettingsOpen(true)
    setCreditsAttention(true)
    setCreditsRefreshToken((value) => value + 1)
  }, [])
  useEffect(() => {
    void window.douchat.setInterfaceLanguage(interfaceLanguage)
  }, [interfaceLanguage])
  useEffect(() => {
    if (!showInspector) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowInspector(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showInspector])

  const [toast, setToast] = useState('')
  const [localAgents, setLocalAgents] = useState<LocalAgent[]>([])
  const [localAgentsLoaded, setLocalAgentsLoaded] = useState(false)
  // Agents configured on hosts that follow the account, as every device lists them (desktop only;
  // the web app returns them from detectLocalAgents). They are not in this computer's registry.
  const [hostAgents, setHostAgents] = useState<LocalAgent[]>([])
  const agents = useMemo(() => [...localAgents.filter(agent => !hostAgents.some(item => item.id === agent.id)), ...hostAgents], [localAgents, hostAgents])
  // Labels and avatars elsewhere read remote hosts synchronously during render.
  setRemoteAgents(agents, localAgentsLoaded)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')
  const scanInFlight = useRef(false)
  // A scan asked for while one runs (say, the account changed) runs right after it.
  const scanAgain = useRef(false)
  async function scanAgents(): Promise<void> {
    if (scanInFlight.current) { scanAgain.current = true; return }
    scanInFlight.current = true
    let scanTimer: ReturnType<typeof setTimeout> | undefined
    setScanning(true)
    setScanError('')
    // First: it also drops this computer's leftover copies of agents a host already has.
    await window.douchat.listHostAgents?.().then(setHostAgents, () => { /* Keep the last known list. */ })
    try { setLocalAgents(await Promise.race([
      window.douchat.detectLocalAgents(),
      new Promise<LocalAgent[]>((_, reject) => { scanTimer = setTimeout(() => reject(new Error('检测暂未完成，请稍后点击检测重试。')), 20000) })
    ])) }
    catch (error) { setScanError(messageSendError(error)) }
    finally {
      clearTimeout(scanTimer); scanInFlight.current = false; setScanning(false); setLocalAgentsLoaded(true)
      if (scanAgain.current) { scanAgain.current = false; void scanAgents() }
    }
  }
  // Agents on a douchat-host belong to the account that added the host, so
  // the list is read again whenever a different account signs in.
  const signedInAccountId = authState.status === 'signed-in' ? authState.user.id : ''
  useEffect(() => {
    void scanAgents()
  }, [signedInAccountId])
  // Agents added on another device arrive by sync; read again which of them a host runs.
  const agentIds = snapshot?.agents.map(agent => agent.id).join() ?? ''
  useEffect(() => {
    if (agentIds) void window.douchat.listHostAgents?.().then(setHostAgents, () => { /* Keep the last known list. */ })
  }, [agentIds])
  // The web app reads the desktop app's agents through it, so the list is
  // empty until it is online: read it again whenever it comes online.
  useEffect(() => {
    if (!window.douchat.desktopAvailability) return
    let online = window.douchat.desktopAvailability() === 'online'
    const timer = setInterval(() => {
      const now = window.douchat.desktopAvailability?.() === 'online'
      if (now && !online) void scanAgents()
      online = now
    }, 3000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    void window.douchat.getAuthState().then(setAuthState)
    return window.douchat.onAuthState(setAuthState)
  }, [])

  useEffect(() => {
    const consumeCreditsReturn = (): void => {
      void window.douchat.consumeCreditsReturn().then((shouldRefresh) => {
        if (!shouldRefresh) return
        setSettingsTab('usage')
        setSettingsOpen(true)
        setCreditsAttention(false)
        setCreditsRefreshToken((value) => value + 1)
      }).catch(() => {
        // A malformed or stale callback should not interrupt the workspace.
      })
    }
    const unsubscribe = window.douchat.onCreditsUpdated(consumeCreditsReturn)
    consumeCreditsReturn()
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!snapshot) {
      knownCreditErrors.current = null
      return
    }
    const next = new Set(snapshot.messages
      .filter((message) => message.kind === 'system' && isDouchatCreditError(`${message.text}\n${message.detail ?? ''}`))
      .map((message) => message.id))
    const previous = knownCreditErrors.current
    knownCreditErrors.current = next
    // The first snapshot is history. Only a newly delivered failure should
    // interrupt the workspace with the recovery panel.
    if (previous && [...next].some((id) => !previous.has(id))) openCreditRecovery()
  }, [snapshot, openCreditRecovery])

  useEffect(() => {
    if (authState.status !== 'signed-in') return
    const refresh = (): void => {
      void window.douchat.refreshProfile().then(setAuthState).catch(() => {
        // A temporary network failure must not cover the existing workspace.
      })
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [authState.status])

  useEffect(() => {
    if (authState.status !== 'signed-in') {
      setSnapshot(null)
      return
    }
    void window.douchat.getSnapshot().then(setSnapshot)
    return window.douchat.onSnapshot(setSnapshot)
  }, [authState.status])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (snapshot && routedConversation.current) {
      const routed = resolveConversation(routedConversation.current, snapshot.conversations)
      if (routed || snapshot.conversations.length) routedConversation.current = undefined
      if (routed) { setActiveId(routed); return }
    }
    if (snapshot && !snapshot.conversations.some((conversation) => conversation.id === activeId && (!conversation.hidden || detachedId))) {
      const welcome = snapshot.defaultConversationId
        ? snapshot.conversations.find((item) => item.id === snapshot.defaultConversationId && !item.hidden)
        : undefined
      setActiveId(welcome?.id ?? snapshot.conversations.find((item) => !item.hidden)?.id ?? '')
    }
  }, [snapshot, activeId])

  useEffect(() => {
    setSocialSnapshot(undefined)
    setSocialError('')
    if (authState.status !== 'signed-in') return
    const userId = authState.user.id
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const version = socialRefreshVersion.current
        const next = await window.douchat.getSocialSnapshot()
        if (active && version === socialRefreshVersion.current && next.userId === userId) {
          setSocialSnapshot(next); setSocialError('')

        }
      } catch (error) { if (active) setSocialError(error instanceof Error ? error.message : String(error)) }
      finally { if (active) timer = setTimeout(refresh, 3000) }
    }
    void refresh()
    return () => { active = false; clearTimeout(timer) }
  }, [authState.status === 'signed-in' ? authState.user.id : ''])

  // A newly signed-in account lands directly in its Dr. Dou welcome chat.
  // Detached chat windows and web links keep the conversation from their URL.
  useEffect(() => {
    if (detachedId || initialRoute?.conversationId || authState.status !== 'signed-in' || !snapshot?.defaultConversationId) return
    if (snapshot.conversations.some((item) => item.id === snapshot.defaultConversationId && !item.hidden)) {
      setActiveId(snapshot.defaultConversationId)
    }
  }, [detachedId, authState.status === 'signed-in' ? authState.user.id : '', snapshot?.defaultConversationId])

  useEffect(() => {
    if (!snapshot || !contact || !['bot', 'group'].includes(contact.kind)) return
    const exists =
      contact.kind === 'bot'
        ? snapshot.agents.some((agent) => agent.id === contact.id)
        : snapshot.conversations.some((item) => item.id === contact.id)
    if (!exists) setContact(undefined)
  }, [snapshot, contact])

  const conversation = snapshot?.conversations.find((item) => item.id === activeId)
  const topic = conversation?.topics.find((item) => item.id === conversation.activeTopicId) ?? conversation?.topics[0]
  const members = useMemo(() => conversationMembers(conversation, snapshot?.agents ?? []), [conversation, snapshot?.agents])
  const activity = snapshot?.activity.find((item) => item.conversationId === activeId)
  const workingIds = useMemo(
    () => new Set((snapshot?.activity ?? []).map((item) => item.conversationId)),
    [snapshot?.activity]
  )
  const totalUnread = snapshot?.conversations.reduce((sum, item) => sum + (item.muted || item.hidden ? 0 : item.unread), 0) ?? 0
  const messages = useMemo(
    () =>
      snapshot?.messages.filter(
        (message) => message.conversationId === activeId && (!topic || message.topicId === topic.id)
      ) ?? [],
    [snapshot?.messages, activeId, topic?.id]
  )

  // An open, quiet chat is read: the badge never lingers on what you are looking at.
  useEffect(() => {
    if (view !== 'chats' || !conversation || conversation.unread === 0 || conversation.manuallyUnread || activity) return
    const read = (): void => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void window.douchat.markConversationRead(conversation.id)
    }
    read()
    window.addEventListener('focus', read)
    document.addEventListener('visibilitychange', read)
    return () => {
      window.removeEventListener('focus', read)
      document.removeEventListener('visibilitychange', read)
    }
  }, [view, conversation?.id, conversation?.unread, conversation?.manuallyUnread, activity])

  useEffect(() => {
    if (!members.length) {
      setInspectorAgentId(undefined)
      return
    }
    if (!members.some((agent) => agent.id === inspectorAgentId)) setInspectorAgentId(members[0].id)
  }, [conversation?.id, members, inspectorAgentId])

  const fail = (error: unknown, fallback: string): void =>
    setToast(t(error instanceof Error ? error.message : fallback))

  async function send(text: string, images?: MessageImageInput[], files?: MessageFileInput[], mentions?: SelectedMention[]): Promise<void> {
    if (!conversation) return
    const target = conversation
    const targetTopic = topic?.id
    messageQueue.enqueue(target.id, text || (files?.length ? files.map(file => file.name).join('、') : `[${images?.length ?? 0} 张图片]`), async () => {
      const current = snapshotRef.current?.conversations.find((item) => item.id === target.id)
      if (!current || current.ownerId !== target.ownerId) throw new Error('会话已不可用，请移除这条排队消息。')
      const currentTopic = current.activeTopicId ?? current.topics[0]?.id
      if (currentTopic !== targetTopic) throw new Error('话题已切换，请切回原话题后重试。')
      await window.douchat.sendMessage(target.id, text, images, files, mentions)
    }, () => !snapshotRef.current?.activity.some((item) => item.conversationId === target.id))
  }

  async function createAgent(input: CreateAgentInput): Promise<void> {
    const next = await window.douchat.createAgent(input)
    setSnapshot(next)
    const created = next.agents[next.agents.length - 1]
    const direct = next.conversations.find(
      (item) => item.type === 'direct' && item.agentIds[0] === created.id
    )
    if (direct) setActiveId(direct.id)
    setContact({ kind: 'bot', id: created.id })
    setView('chats')
    setShowInspector(false)
    setToast(tr('{name} joined the workspace', { name: agentDisplayName(created) }))
  }

  async function updateAgent(agentId: string, input: UpdateAgentInput): Promise<void> {
    setSnapshot(await window.douchat.updateAgent(agentId, input))
    setToast(tr('{name} updated', { name: input.name ?? t('Agent') }))
  }

  function deleteAgent(agent: AgentConfig): void {
    if (!window.confirm(tr('Delete {name}? Their chat and group memberships are removed.', { name: agentDisplayName(agent) }))) return
    void window.douchat
      .deleteAgent(agent.id)
      .then((next) => {
        setSnapshot(next)
        setDialog(null)
        setToast(tr('{name} was removed', { name: agentDisplayName(agent) }))
      })
      .catch((error) => fail(error, 'Agent could not be deleted'))
  }

  async function createGroup(input: CreateGroupInput): Promise<void> {
    const next = await window.douchat.createGroup(input)
    setSnapshot(next)
    const created = [...next.conversations].filter((item) => item.type === 'group').sort((a, b) => b.createdAt - a.createdAt)[0]
    if (created) setActiveId(created.id)
    setToast(tr('{name} is ready', { name: input.name }))
  }

  async function startDirectChat(agentId: string): Promise<void> {
    const result = await window.douchat.startDirectChat(agentId)
    setSnapshot(result.snapshot)
    setActiveId(result.conversationId)
    setContact({ kind: 'bot', id: agentId })
    setView('chats')
    setShowInspector(false)
  }

  async function updateGroup(
    conversationId: string,
    input: { name: string; description: string; agentIds: string[]; leadAgentId: string }
  ): Promise<void> {
    setSnapshot(await window.douchat.updateConversation(conversationId, input))
    setToast(t('Group updated'))
  }

  function deleteConversation(target: Conversation): void {
    /* Native confirmation is handled by the main process. */
    void window.douchat
      .deleteConversation(target.id)
      .then(setSnapshot)
      .catch((error) => fail(error, 'Chat could not be deleted'))
  }

  async function openFriendChat(id: string): Promise<void> {
    try {
      const result = await window.douchat.socialAction({ action: 'create-room', kind: 'direct', friendIds: [id] })
      if (!result.conversationId) throw new Error('Chat could not be synchronized')
      await openChat(result.conversationId)
    } catch (error) { fail(error, 'Chat could not be opened') }
  }

  async function openChat(conversationId: string): Promise<void> {
    try {
      await window.douchat.updateConversation(conversationId, { hidden: false })
      const next = await window.douchat.markConversationRead(conversationId)
      if (!next.conversations.some((item) => item.id === conversationId)) throw new Error('Chat not found')
      setSnapshot(next)
      setActiveId(conversationId)
      setShowInspector(false)
      setView('chats')
      openDetail()
    } catch (error) {
      fail(error, 'Chat could not be opened')
      throw error
    }
  }

  function togglePin(target: Conversation): void {
    void window.douchat.setConversationPinned(target.id, !target.pinned).then(setSnapshot).catch((error) => fail(error, 'Chat could not be pinned'))
  }

  function editConversation(target: Conversation): void {
    if (target.person) {
      setDialog({ kind: 'friend-profile', personId: target.person.id, anchor: { left: 300, right: 320, top: 100 } })
      return
    }
    if (target.type === 'group') setDialog({ kind: 'group', conversation: target })
    else {
      const agent = snapshot?.agents.find((item) => item.id === target.agentIds[0])
      if (agent) setDialog({ kind: 'bot', agent })
    }
  }

  if (authState.status === 'checking') {
    return (
      <div className="loading-screen">
        <span className="brand-mark">
          <i />
          <i />
        </span>
        <span>{t('Checking your login…')}</span>
      </div>
    )
  }

  if (authState.status !== 'signed-in') {
    return <LoginScreen state={authState} onLogin={() => void window.douchat.startLogin().then(setAuthState)} onCancel={() => void window.douchat.cancelLogin().then(setAuthState)} />
  }

  if (!snapshot) {
    return (
      <div className="loading-screen">
        <span className="brand-mark"><i /><i /></span>
        <span>{t('Opening Douchat…')}</span>
      </div>
    )
  }

  // Account data is authoritative for presentation. The runtime snapshot may
  // still contain a legacy local avatar used by older installs.
  const uiSnapshot = withAccountIdentity(snapshot, authState.user)

  return (
    <div
      className={`app-shell messenger with-rail ${detachedId ? 'detached-chat' : ''} ${view === 'chats' && showInspector ? 'with-inspector' : ''}${compact ? ` compact view-${view}${detailOpen ? ' detail-open' : ''}` : ''}`}
      onCompositionStartCapture={() => { imeComposing.current = true }}
      onCompositionEndCapture={() => { imeComposing.current = false }}
      onKeyDownCapture={(event) => {
        if (!isImeCommitEnter(event.nativeEvent, imeComposing.current)) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <AppRail
        view={view}
        unread={totalUnread}
        friendRequests={socialSnapshot?.userId === authState.user.id ? socialSnapshot.friendships.filter((item) => item.status === 'pending' && item.recipientId === authState.user.id).length : 0}
        userName={authState.user.name}
        userAvatar={authState.user.image || ''}
        settingsOpen={settingsOpen}
        onSelect={(next) => {
          setSettingsOpen(false)
          setView(next)
          detailPushed.current = false
          setDetailOpen(false)
        }}
        onOpenSettings={(profile) => {
          if (profile) setSettingsTab('profile')
          setSettingsOpen(true)
        }}
      />

      {compact && detailOpen && <button type="button" className="compact-back" onClick={() => showInspector ? setShowInspector(false) : closeDetail()} aria-label={t('Back')} title={t('Back')}><ChevronLeft size={22} /></button>}

      {view === 'discover' ? (
        <>
          <DiscoverSidebar page={discoverPage} onSelect={(next) => { setDiscoverPage(next); openDetail() }} />
          <DiscoverContent
            page={discoverPage}
            userId={authState.user.id}
            userName={authState.user.name}
            userAvatar={authState.user.image || ''}
            routines={snapshot.routines}
            runs={snapshot.runs}
            agents={snapshot.agents}
            conversations={snapshot.conversations}
            onDeleteRoutine={async (id) => setSnapshot(await window.douchat.deleteRoutine(id))}
            onSetRoutineEnabled={async (id, enabled) => setSnapshot(await window.douchat.setRoutineEnabled(id, enabled))}
            onRunRoutineNow={(id) => window.douchat.runRoutineNow(id)}
          />
        </>
      ) : view === 'contacts' ? (
        <>
          <ContactList
            snapshot={uiSnapshot}
            selected={contact}
            social={socialSnapshot}
            socialError={socialError}
            onSelect={(next) => { setContact(next); openDetail() }}
          />
          {contact && !['bot', 'group', 'friend'].includes(contact.kind) ? <SocialWorkspace
            key={`${authState.user.id}:${contact.kind}:${contact.id}`} embedded
            agents={snapshot.agents} userId={authState.user.id}
            onOpenDirectChat={(id) => void openChat(id)}
            friendId={contact.kind === 'friend-chat' ? contact.id : undefined}
            roomId={contact.kind === 'social-group' ? contact.id : undefined}
            showRequests={contact.kind === 'friend-requests'} startGroup={contact.kind === 'new-social-group'}
            onRoomCreated={(id) => setContact({ kind: 'social-group', id })}
            onAddFriend={() => setDialog({ kind: 'add-friend' })}
          /> : <ContactCard
            social={socialSnapshot}
            onFriendMessage={(id) => void openFriendChat(id)}
            onRespondRequest={async (id, accept) => {
              await window.douchat.socialAction({ action: 'respond', id, accept })
              setSocialSnapshot(await window.douchat.getSocialSnapshot())
            }}
            snapshot={uiSnapshot}
            selection={contact}
            onMessage={openChat}
            onStartDirect={(agentId) => { void startDirectChat(agentId) }}
            onEditBot={(agent) => setDialog({ kind: 'bot', agent })} onConfigureModel={(agent) => setDialog({ kind: 'local-model', agent })} onConfigureIM={(agent) => setDialog({ kind: 'im-channels', agent })}
              onEditPermissions={(agent) => setDialog({ kind: 'agent-permissions', agent })}
            onRemoveFromContacts={(group) => { void window.douchat.updateConversation(group.id, { savedToContacts: false }).then(setSnapshot).catch((error) => fail(error, 'Could not save changes')) }} onDeleteConversation={deleteConversation} onDeleteBot={deleteAgent}
            onTogglePin={togglePin}
          />}
        </>
      ) : (
        <>
      <BotInbox
        snapshot={uiSnapshot}
        activeId={activeId}
        workingIds={workingIds}
        onSelect={openChat}
        onCreateBot={() => setDialog({ kind: 'bot' })}
        onAddFriend={() => setDialog({ kind: 'add-friend' })}
        onCreateGroup={() => setDialog({ kind: 'group' })}
        onUpdate={(target, input) => {
          void window.douchat.updateConversation(target.id, input).then(setSnapshot).catch((error) => fail(error, 'Chat could not be updated'))
        }}
        onMarkAllRead={async () => {
          try { setSnapshot(await window.douchat.markAllConversationsRead()) }
          catch (error) { fail(error, 'Could not mark chats as read') }
        }}
        onOpenWindow={(target) => { void window.douchat.openConversationWindow(target.id).catch((error) => fail(error, 'Window could not be opened')) }}
        onEdit={editConversation}
        onTogglePin={togglePin}
        onDelete={deleteConversation}
      />

      <div className="chat-stage">
      <ChatErrorBoundary key={`${activeId}:${topic?.id}`}>
      <ChatPane person={conversation?.person}
        onOpenPersonProfile={(anchor) => conversation?.person && setDialog({ kind: 'friend-profile', personId: conversation.person.id, anchor })}
        key={`${activeId}:${topic?.id}`}
        userName={authState.user.name}
        userAvatar={authState.user.image || ''}
        conversation={conversation}
        topic={topic}
        messages={messages}
        allMessages={snapshot.messages}
        agents={[...snapshot.agents, ...members]}
        members={members}
        activity={activity}
        offline={!conversation?.remoteRoomId && snapshot.runtime.mode === 'offline' && !members.some((agent) => agent.localAgentId)}
        onConnect={() => {
          const agent = members.find((member) => member.id === conversation?.leadAgentId) ?? members[0]
          setDialog(agent ? { kind: 'bot', agent } : { kind: 'endpoint' })
        }}
        inspectorOpen={showInspector}
        onToggleInspector={() => setShowInspector((value) => !value)}
        onOpenAgentProfile={(agentId, anchor) => {
          setInspectorAgentId(agentId)
          setDialog({ kind: 'member-profile', agentId: conversation?.socialRoom?.agents.find((member) => member.id === agentId && member.ownerId === conversation.ownerId)?.localId ?? agentId, anchor })
        }}
        onOpenUserProfile={(anchor) => setDialog({ kind: 'self-profile', anchor })}
        onOpenCredits={openCreditRecovery}
        queuedMessages={queuedMessages.filter((item) => item.conversationId === conversation?.id)}
        onPromoteQueued={(id) => messageQueue.promote(id)}
        onRemoveQueued={(id) => messageQueue.remove(id)}
        onSend={send}
        onStop={() => conversation && void window.douchat.stopConversation(conversation.id)}
      />

      <div className={`chat-details-layer ${showInspector && conversation ? 'is-open' : ''}`} inert={!showInspector || !conversation} aria-hidden={!showInspector || !conversation}>
        <button className="chat-details-dismiss" onClick={() => setShowInspector(false)} aria-label={t('Close chat details')} tabIndex={-1} />
        <InspectorRail person={conversation?.person}
          onSelectPerson={(anchor, personId) => { const id = personId ?? conversation?.person?.id; if (id) setDialog({ kind: 'friend-profile', personId: id, anchor }) }}
          snapshot={{ ...uiSnapshot, agents: [...uiSnapshot.agents, ...members] }}
          conversation={conversation}
          members={members}
          selectedAgentId={inspectorAgentId}
          onSelectAgent={(agentId, anchor) => { setInspectorAgentId(agentId); setDialog({ kind: 'member-profile', agentId: conversation?.socialRoom?.agents.find((member) => member.id === agentId && member.ownerId === conversation.ownerId)?.localId ?? agentId, anchor }) }}
          onSelectUser={(anchor) => setDialog({ kind: 'self-profile', anchor })}
          onRemoveMembers={() => conversation && setDialog({ kind: 'remove-members', conversation })}
          onAddMembers={() => conversation?.person ? setDialog({ kind: 'group', initialFriendIds: [conversation.person.id] }) : conversation && (conversation.type === 'group' ? setDialog({ kind: 'add-members', conversation }) : setDialog({ kind: 'group', initialAgentIds: conversation.agentIds }))}
          onDeleteRoutine={async (routineId) => setSnapshot(await window.douchat.deleteRoutine(routineId))}
          onSetRoutineEnabled={async (routineId, enabled) => setSnapshot(await window.douchat.setRoutineEnabled(routineId, enabled))}
          onRunRoutineNow={(routineId) => window.douchat.runRoutineNow(routineId)}
        />
      </div>
      </ChatErrorBoundary>
      </div>
        </>
      )}

      <DialogErrorBoundary key={`${dialog?.kind ?? 'none'}:${settingsOpen}`} onClose={() => { setDialog(null); setSettingsOpen(false) }}>
      {dialog?.kind === 'self-profile' && <MemberProfilePopover anchor={dialog.anchor} onClose={() => setDialog(null)}>
        <button autoFocus className="icon-button member-profile-close" aria-label={t('Close')} onClick={() => setDialog(null)}><X size={18} /></button>
        <SelfProfileCard name={authState.user.name} email={authState.user.email} avatar={authState.user.image || ''} onEdit={() => { setDialog(null); setSettingsTab('profile'); setSettingsOpen(true) }} />
      </MemberProfilePopover>}
      {dialog?.kind === 'friend-profile' && <MemberProfilePopover anchor={dialog.anchor} onClose={() => setDialog(null)}>
        <button autoFocus className="icon-button member-profile-close" aria-label={t('Close')} onClick={() => setDialog(null)}><X size={18} /></button>
        <ContactCard social={socialSnapshot} snapshot={uiSnapshot} selection={{ kind: 'friend', id: dialog.personId }}
          onFriendMessage={(id) => { setDialog(null); void openFriendChat(id) }}
          onMessage={openChat} onStartDirect={(id) => void startDirectChat(id)} onEditBot={(agent) => setDialog({ kind: 'bot', agent })} onConfigureModel={(agent) => setDialog({ kind: 'local-model', agent })} onConfigureIM={(agent) => setDialog({ kind: 'im-channels', agent })}
              onEditPermissions={(agent) => setDialog({ kind: 'agent-permissions', agent })}
          onRemoveFromContacts={(group) => { void window.douchat.updateConversation(group.id, { savedToContacts: false }).then(setSnapshot).catch((error) => fail(error, 'Could not save changes')) }} onDeleteConversation={deleteConversation} onDeleteBot={deleteAgent} onTogglePin={togglePin} />
      </MemberProfilePopover>}
      {dialog?.kind === 'member-profile' && (
        <MemberProfilePopover anchor={dialog.anchor} onClose={() => setDialog(null)}>
            <button autoFocus className="icon-button member-profile-close" aria-label={t('Close')} onClick={() => setDialog(null)}><X size={18} /></button>
            <ContactCard snapshot={{ ...uiSnapshot, agents: [...uiSnapshot.agents, ...members.filter((member) => !uiSnapshot.agents.some((agent) => agent.id === member.id))] }} ownerName={conversation?.socialRoom?.members.find((person) => person.id === members.find((agent) => agent.id === dialog.agentId)?.ownerId)?.name} readOnly={!uiSnapshot.agents.some((agent) => agent.id === dialog.agentId)} selection={{ kind: 'bot', id: dialog.agentId }}
              onMessage={(id) => { setDialog(null); openChat(id) }}
              onStartDirect={(agentId) => { setDialog(null); void startDirectChat(agentId) }}
              onEditBot={(agent) => setDialog({ kind: 'bot', agent })} onConfigureModel={(agent) => setDialog({ kind: 'local-model', agent })} onConfigureIM={(agent) => setDialog({ kind: 'im-channels', agent })}
              onEditPermissions={(agent) => setDialog({ kind: 'agent-permissions', agent })}
              onRemoveFromContacts={(group) => { void window.douchat.updateConversation(group.id, { savedToContacts: false }).then(setSnapshot).catch((error) => fail(error, 'Could not save changes')) }} onDeleteConversation={deleteConversation} onDeleteBot={deleteAgent}
              onTogglePin={togglePin} />
        </MemberProfilePopover>
      )}
      {uiSnapshot.permissionRequests?.[0] && <AgentPermissionPrompt key={uiSnapshot.permissionRequests[0].id} request={uiSnapshot.permissionRequests[0]} agent={uiSnapshot.agents.find(agent => agent.id === uiSnapshot.permissionRequests![0].agentId)} social={socialSnapshot}
        onResolve={async (allow) => { setSnapshot(await window.douchat.resolveAgentPermission(uiSnapshot.permissionRequests![0].id, allow)) }} />}
      {dialog?.kind === 'add-friend' && <AddFriendModal onClose={() => setDialog(null)} />}
      {dialog && ((dialog.kind === 'bot' && dialog.agent) || dialog.kind === 'agent-permissions' || dialog.kind === 'im-channels' || dialog.kind === 'local-model') && <AgentSettingsDialog
        key={dialog.agent!.id} agent={uiSnapshot.agents.find(agent => agent.id === dialog.agent!.id) ?? dialog.agent!}
        localAgents={agents} cloudModels={snapshot.models ?? []}
        initialTab={dialog.kind === 'agent-permissions' ? 'permissions' : dialog.kind === 'im-channels' ? 'channels' : dialog.kind === 'local-model' ? 'models' : 'profile'}
        onClose={() => setDialog(null)} onUpdate={updateAgent} onDelete={deleteAgent}
        onModelSettings={() => { setDialog(null); setSettingsTab('models'); setSettingsOpen(true) }}
        onCreditsSettings={() => { setDialog(null); setSettingsTab('usage'); setSettingsOpen(true) }} />}
      {dialog?.kind === 'bot' && !dialog.agent && <BotModal localAgents={agents} cloudModels={snapshot.models}
        initialLocalAgentId={dialog.localAgentId}
        onModelSettings={() => { setDialog(null); setSettingsTab('models'); setSettingsOpen(true) }}
        onCreditsSettings={() => { setDialog(null); setSettingsTab('usage'); setSettingsOpen(true) }}
        onSettings={() => { setDialog(null); setSettingsOpen(true) }}
        onClose={() => setDialog(null)} onCreate={createAgent} onUpdate={updateAgent} />}
      {(dialog?.kind === 'add-members' || dialog?.kind === 'remove-members') && (
        <AddMembersModal social={socialSnapshot}
          onRemoveContacts={dialog.conversation.remoteRoomId ? async (friendIds, agentIds) => {
            const result = await window.douchat.socialAction({ action: 'remove-members', roomId: dialog.conversation.remoteRoomId!, friendIds, agentIds })
            ++socialRefreshVersion.current
            if (result.snapshot) setSocialSnapshot(result.snapshot)
            setSnapshot(await window.douchat.getSnapshot())
          } : undefined}
          onAddContacts={async (friendIds, agentIds) => {
            if (friendIds.length || dialog.conversation.remoteRoomId) {
              const result = await window.douchat.socialAction({ action: 'invite-members', conversationId: dialog.conversation.id, friendIds, agentIds })
              ++socialRefreshVersion.current
              if (result.snapshot) setSocialSnapshot(result.snapshot)
              setSnapshot(await window.douchat.getSnapshot())
            } else await updateGroup(dialog.conversation.id, {
              name: dialog.conversation.name, description: dialog.conversation.description || '',
              agentIds: [...new Set([...dialog.conversation.agentIds, ...agentIds])], leadAgentId: dialog.conversation.leadAgentId || dialog.conversation.agentIds[0]
            })
          }}
          remove={dialog.kind === 'remove-members'} snapshot={uiSnapshot} conversation={dialog.conversation} onClose={() => setDialog(null)} onUpdate={updateGroup} />
      )}
      {dialog?.kind === 'group' && (
        <GroupModal
          snapshot={uiSnapshot}
          social={socialSnapshot}
          onStartFriend={openFriendChat}
          conversation={dialog.conversation}
          initialAgentIds={dialog.initialAgentIds}
          initialFriendIds={dialog.initialFriendIds}
          onCreateSocialGroup={async (friendIds, agentIds, memberOrder = []) => {
            const people = socialSnapshot?.friendships.filter((friend) => friendIds.includes(friend.person.id)).map((friend) => friend.person.name) ?? []
            const agentNames = snapshot.agents.filter((agent) => agentIds.includes(agent.id)).map(agentDisplayName)
            const result = await window.douchat.socialAction({ action: 'create-room', kind: 'group', name: [...agentNames, ...people].join('、'), friendIds, memberOrder, agentIds })
            if (!result.roomId) throw new Error('Chat could not be created')
            if (result.snapshot) setSocialSnapshot(result.snapshot)
            const next = await window.douchat.getSnapshot()
            setSnapshot(next)
            const created = next.conversations.find((conversation) => conversation.remoteRoomId === result.roomId)
            if (created) await openChat(created.id)
          }}
          onClose={() => setDialog(null)}
          onCreate={createGroup}
          onStartDirect={startDirectChat}
          onOpenConversation={openChat}
          onUpdate={updateGroup}
          onNewBot={() => setDialog({ kind: 'bot' })}
        />
      )}
      {dialog?.kind === 'endpoint' && (
        <EndpointModal
          endpoint={snapshot.endpoint}
          models={snapshot.models.length}
          onClose={() => setDialog(null)}
          onSave={async (input) => {
            const next = await window.douchat.setEndpoint(input)
            setSnapshot(next)
            setToast(next.models.length ? tr('Connected · {count} models', { count: next.models.length }) : t('Endpoint saved'))
          }}
          onTest={(input) => window.douchat.testEndpoint(input)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          user={authState.user}
          agents={agents}
          scanning={scanning}
          error={scanError}
          tab={settingsTab}
          creditsRefreshToken={creditsRefreshToken}
          creditsAttention={creditsAttention}
          onCreditsAvailable={() => setCreditsAttention(false)}
          onTab={setSettingsTab}
          onClose={() => setSettingsOpen(false)}
          onSignOut={async () => {
            const next = await window.douchat.signOut()
            setSettingsOpen(false)
            setAuthState(next)
          }}
          onUpdateProfile={async (input) => {
            const next = await window.douchat.updateProfile(input)
            setAuthState(next)
            if (next.status !== 'signed-in') setSettingsOpen(false)
          }}
          onDetect={() => void scanAgents()}
          onLocalAgentsChange={setLocalAgents}
          onRemoveCustom={async (id) => setLocalAgents(await window.douchat.removeCustomLocalAgent(id))}
        />
      )}
      </DialogErrorBoundary>
      {toast && <ToastNotice message={toast} />}
    </div>
  )
}

function ToastNotice({ message }: { message: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof element.showPopover !== 'function') return
    try {
      if (!element.matches(':popover-open')) element.showPopover()
    } catch {
      element.removeAttribute('popover')
    }
  }, [message])
  return <div ref={ref} className="toast" popover="manual" role="status">{message}</div>
}

/** A phone-sized web page (the desktop app keeps its own layout at any width). */
function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(() => usesWebRoutes() && Boolean(window.matchMedia?.(COMPACT_LAYOUT_QUERY).matches))
  useEffect(() => {
    if (!usesWebRoutes() || !window.matchMedia) return
    const media = window.matchMedia(COMPACT_LAYOUT_QUERY)
    const update = () => setCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return compact
}
