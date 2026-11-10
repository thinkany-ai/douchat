import { QRCodeSVG } from 'qrcode.react'
import { UserMemoryPanel } from './UserMemoryPanel'
import { LocalAgentEditor } from './LocalAgentEditor'
import { ConnectionsPanel } from './ConnectionsPanel'
import { CustomModelSettings } from './CustomModelSettings'
import { SchedulingSettings } from './SchedulingSettings'
import { RemoteMark, agentServer } from './RemoteMark'
import { messageSendError } from '../messageQueue'
import { NativeDialog } from './NativeDialog'
import { reportDiagnostic } from '../diagnostics'
import { agentIcons } from '../agentIcons'
import douchatLogo from '../../../../resources/icons/douchat.png'
import { setPreferences, usePreferences, resolveInterfaceLanguage, t, tr, type LanguagePreference } from '../preferences'
import { SlidersHorizontal, Bot, ChevronLeft, LayoutGrid, SquareArrowUpRight, Camera, CircleUserRound, Coins, Cpu, ExternalLink, FolderOpen, Info, LogOut, Network, Plus, RefreshCw, ScanSearch, Server, SquareArrowOutUpRight, Trash2, TriangleAlert, Workflow, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactElement } from 'react'
import type { DesktopAuthUser, LocalAgent, UpdateDesktopProfileInput, UpdateState, UsageSummary } from '../../../shared/types'
import { readAvatarFile } from '../avatarFile'
import { BUILT_IN_PRODUCTS, productLink, type Product } from '../../../shared/products'
import { trimmedIcon } from '../productIcon'
import { UserAvatar } from './common'

const LOCAL_AGENTS = '@local'
/** The server connection an agent runs on; none for one on this computer. */
const agentConnection = (agent: LocalAgent): string | undefined => agent.connectionId ?? agent.remoteAgent?.connectionId ?? agent.daemon?.connectionId

export type SettingsTab = 'memory' | 'profile' | 'general' | 'usage' | 'agents' | 'connections' | 'models' | 'scheduling' | 'about' | 'more'

export function SettingsPanel({ user, agents, scanning, error, tab, creditsRefreshToken, creditsAttention = false, onCreditsAvailable, onTab, onClose, onSignOut, onUpdateProfile, onDetect, onLocalAgentsChange, onRemoveCustom }: {
  user: DesktopAuthUser
  agents: LocalAgent[]
  scanning: boolean
  error: string
  tab: SettingsTab
  creditsRefreshToken: number
  creditsAttention?: boolean
  onCreditsAvailable?: () => void
  onTab: (tab: SettingsTab) => void
  onClose: () => void
  onSignOut: () => Promise<void>
  onUpdateProfile: (input: UpdateDesktopProfileInput) => Promise<void>
  onDetect: () => void
  onLocalAgentsChange?: (agents: LocalAgent[]) => void
  onRemoveCustom?: (id: string) => Promise<void>
}): ReactElement {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // Avoid a synchronous focus/layout flush in React's initial DOM commit on Windows.
    // Keep keyboard focus in the dialog, and restore it to the opener when dismissed.
    const opener = document.activeElement
    const timer = window.setTimeout(() => {
      reportDiagnostic('settings.focus-start')
      closeRef.current?.focus({ preventScroll: true })
      reportDiagnostic('settings.focus-complete')
    }, 300)
    return () => {
      window.clearTimeout(timer)
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    reportDiagnostic('settings.mounted')
    const timer = window.setTimeout(() => {
      const element = closeRef.current?.ownerDocument.querySelector('.settings-modal')
      const bounds = element?.getBoundingClientRect()
      const style = element ? getComputedStyle(element) : undefined
      reportDiagnostic('settings.layout', JSON.stringify({ tab, width: bounds?.width, height: bounds?.height, display: style?.display, visibility: style?.visibility, opacity: style?.opacity, viewport: [element?.ownerDocument.defaultView?.innerWidth, element?.ownerDocument.defaultView?.innerHeight] }))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [tab])
  const preferences = usePreferences()
  // On a phone the tab list and a tab's page take turns filling the screen.
  const [tabListShown, setTabListShown] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const [customError, setCustomError] = useState('')
  const [editingLocalAgent, setEditingLocalAgent] = useState<LocalAgent | 'new'>()
  // The list shows one place at a time: this computer by default, or one server connection.
  const [agentSource, setAgentSource] = useState<string>(LOCAL_AGENTS)
  const [connectionNames, setConnectionNames] = useState<Record<string, string>>({})
  useEffect(() => {
    if (tab !== 'agents' || !window.douchat.listConnections) return
    let active = true
    void window.douchat.listConnections().then((list) => { if (active) setConnectionNames(Object.fromEntries(list.map((item) => [item.id, item.name]))) }).catch(() => undefined)
    return () => { active = false }
  }, [tab])
  const servers = [...new Map(agents.flatMap((agent) => {
    const id = agentConnection(agent)
    return id ? [[id, connectionNames[id] || agentServer(agent) || t('Server')] as const] : []
  })).entries()]
  // The desktop app runs and manages its own agents. The web app lists them
  // (while the desktop is online) next to agents on servers added here.
  const manageable = window.douchat.platform !== 'web'
  const countIn = (id: string) => agents.filter((agent) => (agentConnection(agent) ?? LOCAL_AGENTS) === id).length
  const source = manageable && servers.some(([id]) => id === agentSource) ? agentSource : LOCAL_AGENTS
  // The desktop app lists one place at a time (its Add and Detect act on it); the web app lists all.
  const inSource = (agent: LocalAgent) => !manageable || (agentConnection(agent) ?? LOCAL_AGENTS) === source
  const shownAgents = agents.filter(inSource)
  const installed = shownAgents.filter((agent) => agent.installed)
  const desktopOnly = shownAgents.filter((agent) => agent.status === 'desktop-only')
  // Remote agents whose connection is off or removed are listed with the reason, not as "not detected".
  const unavailable = shownAgents.filter((agent) => agent.unavailable)
  const missing = shownAgents.filter((agent) => agent.status === 'not-found' && !agent.unavailable)


  const signOut = async (): Promise<void> => {
    setSigningOut(true)
    setSignOutError('')
    try { await onSignOut() }
    catch (cause) {
      setSignOutError(cause instanceof Error ? cause.message : 'Could not sign out. Try again.')
      setSigningOut(false)
    }
  }
  const removeCustom = async (agent: LocalAgent): Promise<void> => {
    if (!onRemoveCustom || !window.confirm(t('Delete this custom local agent?'))) return
    setCustomError('')
    try { await onRemoveCustom(agent.id) }
    catch (cause) { setCustomError(cause instanceof Error ? cause.message : 'Could not remove custom local agent.') }
  }
  // The web app has no Detect button: read the list again whenever this page opens.
  useEffect(() => { if (tab === 'agents' && !manageable) onDetect() }, [tab])
  const [maintaining, setMaintaining] = useState('')
  const refreshAfterTerminal = useRef(false)
  useEffect(() => {
    const focus = () => { if (refreshAfterTerminal.current) { refreshAfterTerminal.current = false; onDetect() } }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [onDetect])
  const maintain = async (agent: LocalAgent): Promise<void> => {
    setMaintaining(agent.id); setCustomError('')
    try { refreshAfterTerminal.current = await window.douchat.maintainLocalAgent(agent.id) }
    catch (cause) { setCustomError(messageSendError(cause)) }
    finally { setMaintaining('') }
  }
  const row = (agent: LocalAgent): ReactElement => {
    const version = agent.version?.match(/v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? agent.version ?? ''
    return <article className="local-agent-row" key={agent.id}>
        <span data-agent={agent.id} className={`local-agent-icon ${agent.installed ? 'installed' : ''}`}>{(agent.avatar || agentIcons[agent.remote?.adapter ?? agent.remoteAgent?.adapter ?? agent.id]) ? <img src={agent.avatar || agentIcons[agent.remote?.adapter ?? agent.remoteAgent?.adapter ?? agent.id]} alt="" /> : <Bot size={22} />}{agent.remoteAgent && <RemoteMark />}</span>
        <div className="local-agent-copy">
          <strong>{agent.name}</strong>
          <code title={agent.remote ? agent.version : agent.path || agent.desktopPath}>{agent.remote ? agent.remote.executable : agent.remoteAgent?.executable || agent.path || agent.desktopPath || agent.command}</code>
        </div>
        <div className="local-agent-row-aside">
          {(agent.remote || agent.daemon) && <span className="local-agent-remote-badge" title={agent.version}><Server size={12} />{agentServer(agent)}</span>}
          {agent.unavailable && <span className="local-agent-remote-badge"><Server size={12} />{t(agent.unavailable === 'disabled' ? 'Connection turned off' : 'Connection removed')}</span>}
          {version && !agent.remote && <span className="local-agent-version" title={agent.version}>{version}</span>}
          {agent.installed && !agent.custom && (!agent.updateStatus || agent.updateStatus === 'unknown') && <span className="local-agent-version" title={t('Could not confirm the latest version. Detect again later.')}>{t('Version unconfirmed')}</span>}
          {manageable && (!agent.custom && !agent.unavailable && (!agent.installed || agent.updateStatus === 'available')) && <button type="button" className="secondary-button" title={agent.latestVersion ? tr('Latest version: {version}', { version: agent.latestVersion }) : undefined} disabled={Boolean(maintaining) || scanning} onClick={() => void maintain(agent)}>{t(maintaining === agent.id ? 'Preparing…' : agent.installed ? 'Update' : 'Install')}</button>}
          {/* An agent configured on a host is changed through its contact, on any device. */}
          {manageable && !agent.hosted && <button type="button" className="secondary-button" aria-label={`${t('Edit')} ${agent.name}`} onClick={() => setEditingLocalAgent(agent)}>{t('Edit')}</button>}
          {manageable && agent.custom && !agent.hosted && <button type="button" className="icon-button local-agent-remove" aria-label={`${t('Remove')} ${agent.name}`} title={t('Remove')} onClick={() => void removeCustom(agent)}><Trash2 size={16} /></button>}
        </div>
      </article>
  }
  return <><NativeDialog className="modal-backdrop settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onClose={onClose} width={980} height={720}>
    <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-compact-view={tabListShown ? 'list' : 'page'}>
    <aside className="settings-sidebar">
      <div className="settings-modal-title"><div id="settings-title" className="wordmark">{t('Settings')}</div><button type="button" className="settings-list-close" onClick={onClose} aria-label={t('Close')} title={t('Close')}><X size={18} /></button></div>
      <div className="settings-tabs" role="tablist" aria-label={t('Settings')} onClick={() => setTabListShown(false)}>
        <button id="profile-tab" role="tab" aria-selected={tab === 'profile'} aria-controls="settings-content" className={tab === 'profile' ? 'active' : ''} onClick={() => onTab('profile')}><CircleUserRound size={18} /><span>{t('Account')}</span></button>
        <button id="general-tab" role="tab" aria-selected={tab === 'general'} aria-controls="settings-content" className={tab === 'general' ? 'active' : ''} onClick={() => onTab('general')}><SlidersHorizontal size={18} /><span>{t('General')}</span></button>
        <button id="usage-tab" role="tab" aria-selected={tab === 'usage'} aria-controls="settings-content" className={tab === 'usage' ? 'active' : ''} onClick={() => onTab('usage')}><Coins size={18} /><span>{t('Credits')}</span></button>
        <button id="models-tab" role="tab" aria-selected={tab === 'models'} aria-controls="settings-content" className={tab === 'models' ? 'active' : ''} onClick={() => onTab('models')}><Cpu size={18} /><span>{t("Models")}</span></button>
        <button id="agents-tab" role="tab" aria-selected={tab === 'agents'} aria-controls="settings-content" className={tab === 'agents' ? 'active' : ''} onClick={() => onTab('agents')}><Bot size={18} /><span>{t('Agents')}</span></button>
        <button id="connections-tab" role="tab" aria-selected={tab === 'connections'} aria-controls="settings-content" className={tab === 'connections' ? 'active' : ''} onClick={() => onTab('connections')}><Network size={18} /><span>{t('Connections')}</span></button>
        <button id="scheduling-tab" role="tab" aria-selected={tab === 'scheduling'} aria-controls="settings-content" className={tab === 'scheduling' ? 'active' : ''} onClick={() => onTab('scheduling')}><Workflow size={18} /><span>{t('Scheduling')}</span></button>
        <button id="about-tab" role="tab" aria-selected={tab === 'about'} aria-controls="settings-content" className={tab === 'about' ? 'active' : ''} onClick={() => onTab('about')}><Info size={18} /><span>{t('About')}</span></button>
        <div className="settings-tabs-divider" role="separator" />
        <button id="more-tab" role="tab" aria-selected={tab === 'more'} aria-controls="settings-content" className={tab === 'more' ? 'active' : ''} onClick={() => onTab('more')}><LayoutGrid size={18} /><span>{t('More from Us')}</span></button>
      </div>
    </aside>
    <main id="settings-content" role="tabpanel" aria-labelledby={`${tab}-tab`} className="settings-content">
      <button ref={closeRef} className="settings-close" onClick={onClose} aria-label={t('Close')} title={t('Close')}><X size={18} /></button>
      <button type="button" className="settings-back" onClick={() => setTabListShown(true)} aria-label={t('Settings')}><ChevronLeft size={22} /><span>{t('Settings')}</span></button>
      {tab === 'profile' ? (
        <ProfileTab user={user} signingOut={signingOut} signOutError={signOutError} onSignOut={() => void signOut()} onUpdateProfile={onUpdateProfile} />
      ) : tab === 'memory' ? <UserMemoryPanel key={user.id} /> : tab === 'general' ? <>
        <header className="settings-heading"><div><h1>{t('General')}</h1><p>{t('Choose your language and appearance.')}</p></div></header>
        <div className="general-settings">
          <label><span>{t('Language')}</span><select value={preferences.language} onChange={(event) => setPreferences({ language: event.target.value as LanguagePreference })}><option value="system">{t('Follow system')}</option><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
          <label><span>{t('Appearance')}</span><select value={preferences.appearance} onChange={(event) => setPreferences({ appearance: event.target.value as 'system' | 'light' | 'dark' })}><option value="system">{t('System')}</option><option value="light">{t('Light')}</option><option value="dark">{t('Dark')}</option></select></label>
          <label className="font-size-setting"><span>{t('Font size')}</span><div className="font-size-control">
            <input type="range" min="0" max="4" step="1" value={preferences.fontSize} aria-label={t('Font size')} aria-valuetext={`${[85, 92, 100, 110, 120][preferences.fontSize]}%`} onChange={(event) => setPreferences({ fontSize: Number(event.target.value) })} />
            <div className="font-size-labels"><span>{t('Small')}</span><button type="button" onClick={() => setPreferences({ fontSize: 1 })}>{t('Standard')}</button><span>{t('Large')}</span></div>
          </div></label>
          <div className="font-size-preview" aria-label={t('Font preview')}>{t('Messages and interface text update immediately.')}</div>
        </div>
      </> : tab === 'usage' ? <UsageTab refreshToken={creditsRefreshToken} attention={creditsAttention} onCreditsAvailable={onCreditsAvailable} /> : tab === 'agents'  ? <>
        <header className="settings-heading local-proxy-heading"><div><h1>{t('Agents')}</h1><p>{t('Agent programs on this computer and your servers. Use them to create contacts.')}</p></div>
          {manageable && servers.length > 0 && <select className="local-agent-source" aria-label={t('Show agents on')} value={source} onChange={(event) => setAgentSource(event.target.value)}>
            <option value={LOCAL_AGENTS}>{t('This computer')} ({countIn(LOCAL_AGENTS)})</option>
            {servers.map(([id, name]) => <option key={id} value={id}>{name} ({countIn(id)})</option>)}
          </select>}
        </header>
        {!manageable && <p className="settings-note">{t('Agents on your computer run in the desktop app and are managed there; you can use them here while it is online. Agents on a server added under Connections → Host run on that server and work here any time.')}</p>}
        {error && <p className="settings-error" role="alert">{t(error)}</p>}
        {maintaining && <p role="status">{t('Preparing to install or update. Downloading the runtime for the first time may take a few minutes.')}</p>}
        {customError && <p className="settings-error" role="alert">{t(customError)}</p>}
        <section aria-label={t('Installed agents')}><div className="local-agent-section-heading"><h2>{t('Installed')} <span>{installed.length}</span></h2>
          {manageable && <div className="local-agent-heading-actions"><button className="secondary-button" onClick={() => setEditingLocalAgent('new')}><Plus size={15} />{t('Add')}</button>
          <button className="secondary-button" disabled={scanning} onClick={onDetect}>{scanning ? <RefreshCw className="spin" size={15} /> : <ScanSearch size={15} />}{scanning ? t('Detecting…') : t('Detect')}</button></div>}</div>
          {installed.map(row)}
          {!installed.length && <p className="settings-note">{source !== LOCAL_AGENTS ? t('No agents on this server can run right now.') : !manageable ? t('No agents yet. Add a server under Connections → Host, or open the desktop app to use the agents on your computer.') : scanning ? t('Checking your shell and installed commands…') : t('No supported local agents found. Install one in your terminal, then detect again.')}</p>}
        </section>
        {unavailable.length > 0 && <section aria-label={t('Unavailable server agents')}><h2>{t('Server unavailable')} <span>{unavailable.length}</span></h2>{unavailable.map(row)}</section>}
        {desktopOnly.length > 0 && <section aria-label={t('Desktop apps needing a CLI')}><h2>{t('Desktop app only')} <span>{desktopOnly.length}</span></h2>{desktopOnly.map(row)}</section>}
        {missing.length > 0 && <section aria-label={t('Other supported agents')}><h2>{t('Not detected')} <span>{missing.length}</span></h2>{missing.map(row)}</section>}
      </> : tab === 'connections' ? <ConnectionsPanel key={user.id} agents={agents} onAgentsChange={list => { if (onLocalAgentsChange) onLocalAgentsChange(list); else onDetect() }} onShowAgents={(id) => { setAgentSource(id); onTab('agents') }} />
      : tab === 'models' ? <CustomModelSettings /> : tab === 'scheduling' ? <SchedulingSettings /> : tab === 'more' ? <MoreFromUsTab /> : <AboutTab />}
    </main>
    </section>
  </NativeDialog>
  {editingLocalAgent && <LocalAgentEditor agent={editingLocalAgent === 'new' ? undefined : editingLocalAgent} connectionId={source !== LOCAL_AGENTS ? source : undefined} onSaved={list => { if (onLocalAgentsChange) onLocalAgentsChange(list); else onDetect() }} onClose={() => setEditingLocalAgent(undefined)} />}
  </>
}

export function UsageTab({ refreshToken = 0, attention = false, onCreditsAvailable }: { refreshToken?: number; attention?: boolean; onCreditsAvailable?: () => void }): ReactElement {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)

  const load = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const next = await window.douchat.getUsageSummary()
      setSummary(next)
      if (next.credits > 0) onCreditsAvailable?.()
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [refreshToken])

  const openTopUp = async (): Promise<void> => {
    setOpening(true)
    setError('')
    try { await window.douchat.openSubscriptionPlans() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOpening(false) }
  }

  const credits = summary ? new Intl.NumberFormat(document.documentElement.lang || undefined).format(summary.credits) : '—'
  const showAttention = attention && (!summary || summary.credits <= 0)
  return <>
    <header className="settings-heading usage-heading">
      <div><h1>{t('Credits')}</h1><p>{t('Manage your Douchat credit balance.')}</p></div>
      <button className="secondary-button usage-refresh" type="button" disabled={loading} onClick={() => void load()}>
        <RefreshCw className={loading ? 'spin' : ''} size={15} />{t('Refresh')}
      </button>
    </header>
    {showAttention && <div className="usage-credit-alert" role="alert">
      <TriangleAlert size={18} aria-hidden="true" />
      <div><strong>{t('Not enough Douchat credits')}</strong><span>{t('Top up credits to continue.')}</span></div>
    </div>}
    <section className="usage-card" aria-label={t('Credits')} aria-busy={loading}>
      <div className="usage-credit-row">
        <span className="usage-credit-icon" aria-hidden="true"><Coins size={23} /></span>
        <div className="usage-credit-copy">
          <span>{t('Credit balance')}</span>
          <strong aria-live="polite">{loading && !summary ? '—' : credits}</strong>
        </div>
        <button
          className="primary-button usage-top-up-button"
          type="button"
          disabled={opening}
          onClick={() => void openTopUp()}
        >
          <Plus size={16} />{t(opening ? 'Opening…' : 'Top up')}
        </button>
      </div>
      <div className="usage-credit-note">
        <span>{t('Cloud agent replies use Douchat credits. Local agents do not.')}</span>
        <span>{t('Top up securely in your browser.')}</span>
      </div>
      {error && <div className="usage-error" role="alert"><span>{t(error)}</span><button type="button" onClick={() => void load()}>{t('Try again')}</button></div>}
    </section>
  </>
}

/** Our other apps, from the service's shared list; the built-in copy shows until it answers. */
function MoreFromUsTab(): ReactElement {
  const [products, setProducts] = useState<Product[]>(BUILT_IN_PRODUCTS)
  const preferences = usePreferences()
  const chinese = resolveInterfaceLanguage(preferences.language) === 'zh-CN'
  const source = window.douchat.platform === 'web' ? 'douchat-web' : 'douchat-desktop'
  useEffect(() => {
    let active = true
    void window.douchat.getProducts().then((list) => { if (active && list.length) setProducts(list) }).catch(() => undefined)
    return () => { active = false }
  }, [])
  return <>
    <header className="settings-heading"><div><h1>{t('More from Us')}</h1></div></header>
    <section aria-labelledby="more-apps-title">
      <h2 id="more-apps-title">{t('Our Other Apps')}</h2>
      <div className="more-apps">
        {products.map((product) => <a key={product.id} className="more-app" href={productLink(product, source)} target="_blank" rel="noreferrer" title={tr('Open {name}', { name: product.name })}>
          <ProductIcon product={product} />
          <span className="more-app-copy"><strong>{product.name}</strong><span>{chinese ? product.summary.zh : product.summary.en}</span></span>
          <SquareArrowUpRight className="more-app-open" size={18} aria-hidden="true" />
        </a>)}
      </div>
    </section>
  </>
}

/** The app's icon with its margins trimmed (all icons then match in size), untrimmed if
 * it cannot be read, or a tile with its first letter when there is none or it fails to load. */
function ProductIcon({ product }: { product: Product }): ReactElement {
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setSrc(undefined)
    if (product.icon) void trimmedIcon(product.icon).then((trimmed) => { if (active) setSrc(trimmed ?? product.icon) })
    return () => { active = false }
  }, [product.icon])
  if (!product.icon || failed) return <span className="more-app-icon more-app-letter" aria-hidden="true">{product.name.slice(0, 1).toUpperCase()}</span>
  // An empty tile holds the place while the icon is prepared, so nothing jumps.
  return src ? <img className="more-app-icon" src={src} alt="" onError={() => setFailed(true)} /> : <span className="more-app-icon" aria-hidden="true" />
}

function AboutTab(): ReactElement {
  const preferences = usePreferences()
  const chineseCommunity = resolveInterfaceLanguage(preferences.language) === 'zh-CN'
  const communityUrl = chineseCommunity
    ? 'https://douchat.ai/join-group?room=f167a810-5899-445d-af9c-d0c3fc115ae0&token=hbXNPJmbHii1oBanMARVIVzyOMOIWeAzFbG48jPkbcc'
    : 'https://douchat.ai/join-group?room=89f7e3f2-aa50-4a9a-bb49-1a9abef3abf9&token=uTuAltFkHr8lpe3PSGo007zM_HrKvAGAKqmOnReB8Tc'
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [requestError, setRequestError] = useState('')

  useEffect(() => {
    let active = true
    void window.douchat.getUpdateState()
      .then((state) => { if (active) setUpdate(state) })
      .catch((cause) => { if (active) setRequestError(cause instanceof Error ? cause.message : String(cause)) })
    const unsubscribe = window.douchat.onUpdateState((state) => { if (active) setUpdate(state) })
    return () => { active = false; unsubscribe() }
  }, [])

  const check = async (): Promise<void> => {
    setRequestError('')
    try { setUpdate(await window.douchat.checkForUpdates()) }
    catch (cause) { setRequestError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const install = async (): Promise<void> => {
    setRequestError('')
    try { setUpdate(await window.douchat.installUpdate()) }
    catch (cause) { setRequestError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const status = update?.status ?? 'idle'
  const version = update?.availableVersion
  const error = requestError || update?.error || ''
  const checkButton = (
    <button
      className="secondary-button update-check-button"
      disabled={status === 'checking' || status === 'disabled'}
      title={status === 'disabled' ? t('Update checks are available in packaged builds.') : undefined}
      onClick={() => void check()}
    >
      {status === 'checking' && <RefreshCw className="spin" size={15} />}
      {status === 'checking' ? t('Checking for updates…') : t('Check for updates')}
    </button>
  )
  // The web app has no install to update or local logs; it points to the desktop app instead.
  const web = window.douchat.platform === 'web'
  return <div className="about-page">
    <header className="about-hero">
      <img className="about-logo" src={douchatLogo} alt="" />
      <div className="about-hero-copy">
        <h1>Douchat</h1>
        <p>{t('A desktop workspace where AI agents work and talk together.')}</p>
        <div className="about-meta">
          {web ? <span className="about-badge">{t('Web')}</span> : <>
            <code>{update?.currentVersion ? `v${update.currentVersion}` : '…'}</code>
            <span className="about-badge">{status === 'disabled' ? t('Development') : t('Desktop')}</span>
          </>}
        </div>
      </div>
    </header>
    <nav className="about-links" aria-label={t('Links')}>
      <a className="about-link about-website-button" href={`https://douchat.ai/?utm_source=${web ? 'douchat-web' : 'douchat-desktop'}`} target="_blank" rel="noreferrer">{t('Official website')}<ExternalLink size={15} /></a>
      <a className="about-link" href="https://github.com/thinkany-ai/douchat" target="_blank" rel="noreferrer">{t('Source code')}<ExternalLink size={15} /></a>
      <a className="about-link" href="https://github.com/thinkany-ai/douchat/issues" target="_blank" rel="noreferrer">{t('Report an issue')}<ExternalLink size={15} /></a>
      {!web && <button type="button" className="about-link" title={t('Share local logs to help troubleshoot display errors.')} onClick={() => { void window.douchat.openDiagnosticLogs().catch((error) => window.alert(String(error))) }}>{t('Open log folder')}<FolderOpen size={15} /></button>}
    </nav>
    <footer className="about-footer">
      <span>{t('AGPL-3.0-only license')}</span>
      <span aria-hidden="true">·</span>
      <span>© 2026 ThinkAny, LLC</span>
    </footer>
    {web ? <section className="about-update-card" aria-labelledby="about-download-title">
      <div className="about-update-copy">
        <h2 id="about-download-title">{t('Douchat for desktop')}</h2>
        <div className="about-update-status"><span>{t('Run local agents such as Codex and Claude Code, work with files on your computer, and keep everything in sync with the web app.')}</span></div>
      </div>
      <div className="about-action">
        <a className="primary-button" href="https://douchat.ai/download?utm_source=douchat-web" target="_blank" rel="noreferrer">{t('Download desktop app')}<ExternalLink size={15} /></a>
      </div>
    </section> : <section className="about-update-card" aria-labelledby="about-update-title">
      <div className="about-update-copy">
        <h2 id="about-update-title">{t('Software update')}</h2>
        <div className="about-update-status" aria-live="polite">
          {status === 'downloading' ? <>
            <div className="update-progress"><i style={{ width: `${update?.percent ?? 0}%` }} /></div>
            <span>{t('Downloading the verified update from Douchat…')}</span>
          </> : status === 'available' ? <div className="update-copy"><span>{t('Version {version} is available').replace('{version}', version ?? '')}</span>{update?.releaseNotes && <p>{update.releaseNotes}</p>}</div>
            : status === 'downloaded' ? <div className="update-copy"><span>{t('Update ready to install')}</span>{Boolean(update?.busyTasks) && <p>{t('Finish {count} active tasks before restarting.').replace('{count}', String(update?.busyTasks))}</p>}</div>
              : status === 'installing' ? <span>{t('Installing update and restarting…')}</span>
                : status === 'checking' ? <span>{t('Connecting to the Douchat update service…')}</span>
                  : status === 'up-to-date' ? <span>{t('You are using the latest version.')}</span>
                    : status === 'disabled' ? <span>{t('Update checks are available in packaged builds.')}</span>
                      : null}
          {error && <p className="settings-error">{t('Update failed:')} {t(error)}</p>}
        </div>
      </div>
      <div className="about-action">
        {status === 'available'
          ? <button className="primary-button" onClick={() => void install()}>{t('Update to v{version} and restart').replace('{version}', version ?? '')}</button>
          : status === 'downloaded'
            ? <button className="primary-button" onClick={() => void install()}>{t('Restart to finish update')}</button>
            : status === 'installing'
              ? <button className="secondary-button update-check-button" disabled>{t('Installing update and restarting…')}</button>
              : status === 'downloading'
                ? <button className="secondary-button update-check-button" disabled>{t('Downloading update…')} {update?.percent ?? 0}%</button>
                : checkButton}
      </div>
    </section>}
    <section className="about-community" aria-labelledby="about-community-title">
      <QRCodeSVG value={communityUrl} size={112} level="M" marginSize={4} title={t('Invitation QR code')} />
      <div className="about-community-copy">
        <h2 id="about-community-title">{t('Douchat Community')}</h2>
        <p>{t('Scan to join the community, share ideas and get help.')}</p>
        <a className="about-link" href={communityUrl} target="_blank" rel="noreferrer">
          {t('Join community')}<ExternalLink size={15} />
        </a>
      </div>
    </section>
  </div>
}

/** One account, one identity: edits are saved to the service and the returned
 * user record becomes the desktop-wide source of truth. */
function ProfileTab({ user, signingOut, signOutError, onSignOut, onUpdateProfile }: {
  user: DesktopAuthUser
  signingOut: boolean
  signOutError: string
  onSignOut: () => void
  onUpdateProfile: (input: UpdateDesktopProfileInput) => Promise<void>
}): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(user.name)
  const [image, setImage] = useState(user.image || '')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')

  useEffect(() => {
    setName(user.name)
    setImage(user.image || '')
  }, [user.name, user.image])

  const dirty = name.trim() !== user.name || image !== (user.image || '')

  const choose = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    // Clearing lets the same file be picked again after a failure.
    event.target.value = ''
    if (!file) return
    setFailure('')
    setNotice('')
    try {
      setImage(await readAvatarFile(file))
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'This picture could not be used.')
    }
  }

  const save = async (): Promise<void> => {
    const nextName = name.trim()
    if (!nextName) {
      setFailure('Name cannot be empty.')
      return
    }
    setSaving(true)
    setFailure('')
    setNotice('')
    try {
      const changes: UpdateDesktopProfileInput = {}
      if (nextName !== user.name) changes.name = nextName
      if (image !== (user.image || '')) changes.image = image
      await onUpdateProfile(changes)
      setNotice(t('Saved to your Douchat account'))
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : 'Could not save account changes.')
    } finally {
      setSaving(false)
    }
  }

  return <>
    <header className="settings-heading"><div><h1>{t('Account')}</h1><p>{t('Your account identity is used everywhere in Douchat.')}</p></div></header>
    <form className="account-profile" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <section className="profile-identity" aria-label={t('Profile picture')}>
        <button type="button" className="profile-avatar" onClick={() => fileRef.current?.click()} aria-label={t('Change your picture')}>
          <UserAvatar src={image} name={name || user.name} size={96} />
          <span className="profile-avatar-overlay"><Camera size={18} strokeWidth={1.9} /></span>
        </button>
        <div className="profile-identity-copy">
          <strong>{name.trim() || user.name}</strong>
          <small>{t('PNG or JPG. Your picture is synced to your Douchat account.')}</small>
          <div className="profile-avatar-actions">
            <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()}>{t('Choose picture')}</button>
            {image && <button type="button" className="secondary-button" onClick={() => { setImage(''); setNotice('') }}>{t('Remove')}</button>}
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void choose(event)} />
      </section>
      <section className="profile-name-section" aria-label={t('Your name')}>
        <label className="profile-field">
          <span>{t('Name')}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('Your name')}
            aria-label={t('Display name')}
          />
        </label>
        <label className="profile-field">
          <span>{t('Email')}</span>
          <input value={user.email} disabled aria-label={t('Email')} />
        </label>
      </section>
      <div className="account-save-row">
        <div aria-live="polite">{failure ? <span className="settings-error">{t(failure)}</span> : notice ? <span className="settings-success">{notice}</span> : <span>{t('Changes sync to every signed-in Douchat app.')}</span>}</div>
        <button className="primary-button" type="submit" disabled={!dirty || saving || !name.trim()}>{t(saving ? 'Saving…' : 'Save changes')}</button>
      </div>
    </form>
    <section className="account-session" aria-label={t('Signed-in account')}>
      <div><strong>{t('Signed in to Douchat')}</strong><span>{user.email}</span></div>
      <button className="sign-out-button" disabled={signingOut} onClick={onSignOut}><LogOut size={15} />{t(signingOut ? 'Signing out…' : 'Sign out')}</button>
    </section>
    {signOutError && <p className="settings-error" role="alert">{t(signOutError)}</p>}
  </>
}
