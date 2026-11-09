import { Bot, ExternalLink, Download, Monitor, MoreHorizontal, Plus, RefreshCw, ScanSearch, Server, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { ConnectionStatus, ConnectionTestReport, ConnectionView, DiscoveredRemoteAgent, LocalAgent, RemoteConnectionInput } from '../../../shared/types'
import { messageSendError } from '../messageQueue'
import { t, tr } from '../preferences'
import { agentIcons } from '../agentIcons'
import { NativeDialog } from './NativeDialog'

const MANUAL_HOST = '\u0000manual'
export const ADAPTER_NAMES: Record<string, string> = {
  codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini', grok: 'Grok Build', cursor: 'Cursor', opencode: 'OpenCode',
  kimi: 'Kimi', openclaw: 'OpenClaw', fastclaw: 'FastClaw', hermes: 'Hermes', omp: 'OMP'
}
const STEP_NAMES: Record<string, string> = { ssh: 'SSH login and host key', shell: 'Shell and base64', environment: 'Login PATH and home folder', workspace: 'Private folder on the server', forwarding: 'Socket forwarding', host: 'douchat-host online' }
const UNINSTALL_COMMAND = '"$HOME/.douchat-host/bin/douchat-host" uninstall --purge'
// Development builds pair with each other: the development desktop app
// registers douchat-dev:// (not douchat://), and the web app runs locally.
const development = import.meta.env.DEV
const WEB_APP_URL = development ? 'http://app.localhost:5276' : 'https://app.douchat.ai'
/** Brings the installed desktop app forward through the scheme it registers. */
const DESKTOP_APP_LINK = development ? 'douchat-dev://open' : 'douchat://open'
const DESKTOP_DOWNLOAD_URL = 'https://douchat.ai/download?utm_source=douchat-web'

export function statusText(status: ConnectionStatus): string {
  if (status.state === 'disabled') return t('Turned off')
  if (status.state === 'connecting') return t('Connecting…')
  if (status.state === 'connected') return status.latencyMs === undefined ? t('Connected') : `${t('Connected')} · ${status.latencyMs} ms`
  return t(status.message)
}

const desktopOnlineNow = (): boolean => window.douchat.desktopAvailability?.() === 'online'

/** Whether the desktop app is online, rechecked while the web app shows it. */
export function useDesktopOnline(web: boolean): boolean {
  const [online, setOnline] = useState(() => web && desktopOnlineNow())
  useEffect(() => {
    if (!web) return
    const timer = setInterval(() => setOnline(desktopOnlineNow()), 5000)
    return () => clearInterval(timer)
  }, [web])
  return online
}

/** Open the desktop app, and download it while it is not online. */
export function DesktopAppLinks({ online }: { online: boolean }): ReactElement {
  // Online means it is installed; offline may just mean it is closed, so both are offered.
  return <p className="connection-peer-actions">
    <a className={`${online ? 'primary-button' : 'secondary-button'} connection-peer-link`} href={DESKTOP_APP_LINK}><Monitor size={15} />{t('Open desktop app')}</a>
    {!online && <a className="primary-button connection-peer-link" href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noreferrer"><Download size={15} />{t('Download desktop app')}</a>}
  </p>
}

/**
 * Settings → Connections: the other way in to the same account, the desktop
 * app from the web and the web app from the desktop. Machines and servers
 * live in Discover → Devices & Environments.
 */
export function ConnectionsPanel(): ReactElement {
  const web = window.douchat.platform === 'web'
  const desktopOnline = useDesktopOnline(web)
  return <>
    <header className="settings-heading local-proxy-heading"><div><h1>{t('Connections')}</h1><p>{t(web ? 'Use the agents on your computer from the web.' : 'Use the agents on this computer from the web.')}</p></div></header>
    {web ? <>
      <p className="settings-note">{t('Install Douchat on your computer to use the agents on it here, such as Codex and Claude Code. Your computer runs them, so keep Douchat open on it.')}</p>
      <p className={`connection-status connection-status-${desktopOnline ? 'connected' : 'disabled'}`} role="status"><i aria-hidden="true" />{t(desktopOnline ? 'The desktop app is online. Agents on your computer are ready to use.' : 'The desktop app is offline. Open Douchat on your computer and sign in to this account.')}</p>
      <p className="settings-note">{t('Devices and servers are added in the desktop app, under Discover → Devices & Environments. Their agents then work here too.')}</p>
      <DesktopAppLinks online={desktopOnline} />
    </> : <>
      <p className="settings-note">{t('Sign in to the web app with this account to use every agent on this computer from a browser or phone. This computer runs them, so keep Douchat open here.')}</p>
      <p><a className="secondary-button connection-peer-link" href={WEB_APP_URL} target="_blank" rel="noreferrer"><ExternalLink size={15} />{t('Open web app')}</a></p>
      <p className="settings-note">{t('Other machines and servers are in Discover → Devices & Environments.')}</p>
    </>}
  </>
}

/**
 * One row per server connection of a kind: SSH environments, or douchat-host
 * servers added before agl (listed with devices; no new ones can be added).
 * Agents on a server are added from a scan.
 */
export function ServerConnections({ kind, agents = [], onAgentsChange, onShowAgents }: {
  kind: 'ssh' | 'daemon'
  /** Agents already registered, so a scan can tell which ones are added. */
  agents?: LocalAgent[]
  onAgentsChange: (agents: LocalAgent[]) => void
  /** After adding agents from a server: show them in Settings → Agents. */
  onShowAgents?: (connectionId: string) => void
}): ReactElement {
  const [items, setItems] = useState<ConnectionView[]>()
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<ConnectionView | 'new'>()
  const [scanning, setScanning] = useState<ConnectionView>()
  const [menu, setMenu] = useState<string>()
  const [report, setReport] = useState<{ id: string; result?: ConnectionTestReport; running: boolean }>()
  const load = useCallback(() => window.douchat.listConnections().then(setItems, cause => setError(messageSendError(cause))), [])
  useEffect(() => { void load(); return window.douchat.onConnectionsChanged(() => void load()) }, [load])
  const run = async (action: () => Promise<ConnectionView[] | void>): Promise<void> => {
    setError('')
    try { const next = await action(); if (next) setItems(next) } catch (cause) { setError(messageSendError(cause)) }
  }
  const remove = (item: ConnectionView): void => {
    setMenu(undefined)
    if (!item.agentIds.length) { if (window.confirm(t('Delete this connection?'))) void run(() => window.douchat.removeConnection(item.id, 'disable-agents')); return }
    const deleteAgents = window.confirm(t('Agents use this connection. Press OK to delete them too (agents used by contacts are kept), or Cancel to keep them all (they will be unavailable).'))
    if (!deleteAgents && !window.confirm(t('Keep the agents and delete the connection?'))) return
    void run(async () => {
      const next = await window.douchat.removeConnection(item.id, deleteAgents ? 'delete-agents' : 'disable-agents')
      onAgentsChange(await window.douchat.detectLocalAgents())
      return next
    })
  }
  const test = async (item: ConnectionView): Promise<void> => {
    setMenu(undefined); setReport({ id: item.id, running: true })
    try { setReport({ id: item.id, result: await window.douchat.testConnection(item.id), running: false }) }
    catch (cause) { setReport(undefined); setError(messageSendError(cause)) }
  }
  const shown = items?.filter(item => item.kind === kind)
  return <>
    {kind === 'ssh' && <>
      <p className="settings-note">{t('Add a server you reach over SSH to use the agents installed on it. Douchat connects with the SSH config and keys on this computer.')}</p>
      <div className="connection-add"><button className="secondary-button" onClick={() => setEditing('new')}><Plus size={15} />{t('Add')}</button></div>
    </>}
    {error && <p className="settings-error" role="alert">{t(error)}</p>}
    {kind === 'ssh' && shown && !shown.length && <p className="settings-note">{t('No connections yet. Add a server from your SSH config to run agents on it.')}</p>}
    {shown && shown.length > 0 && <section aria-label={t(kind === 'ssh' ? 'Environments' : 'douchat-host servers')}>{shown.map(item => <article className="local-agent-row connection-row" key={item.id}>
      <button type="button" className="detail-switch" role="switch" aria-label={`${t('Enabled')} ${item.name}`} aria-checked={item.enabled} onClick={() => void run(() => window.douchat.setConnectionEnabled(item.id, !item.enabled))} />
      <span className="local-agent-icon installed"><Server size={20} /></span>
      <div className="local-agent-copy">
        <strong>{item.name}</strong>
        <span className={`connection-status connection-status-${item.status.state}`} role="status"><i aria-hidden="true" />{statusText(item.status)}{item.agentIds.length ? ` · ${item.agentIds.length} ${t(item.agentIds.length === 1 ? 'agent' : 'agents')}` : ''}{item.kind === 'daemon' ? ` · douchat-host` : ''}</span>
        {report?.id === item.id && <div className="connection-report">
          {report.running ? <p className="settings-note"><RefreshCw size={13} className="spin" /> {t('Testing…')}</p> : report.result?.steps.map(step => <p key={step.name} className={step.passed ? 'connection-step-ok' : 'connection-step-failed'}>{step.passed ? '✓' : '✕'} {t(STEP_NAMES[step.name] ?? step.name)}{step.message ? ` · ${t(step.message)}` : ''}</p>)}
          {!report.running && <button type="button" className="local-settings-link" onClick={() => setReport(undefined)}>{t('Close')}</button>}
        </div>}
      </div>
      <div className="local-agent-row-aside">
        <button type="button" className="secondary-button" disabled={!item.enabled} title={t('Scan for agents on this server')} aria-label={`${t('Scan for agents on this server')} ${item.name}`} onClick={() => setScanning(item)}><ScanSearch size={15} /></button>
        <div className="connection-menu">
          <button type="button" className="icon-button" aria-label={`${t('More')} ${item.name}`} aria-expanded={menu === item.id} onClick={() => setMenu(menu === item.id ? undefined : item.id)}><MoreHorizontal size={16} /></button>
          {menu === item.id && <div className="connection-menu-items" role="menu">
            {item.kind !== 'daemon' && <button role="menuitem" onClick={() => { setMenu(undefined); setEditing(item) }}>{t('Edit')}</button>}
            <button role="menuitem" onClick={() => void test(item)}>{t('Test connection')}</button>
            <button role="menuitem" disabled={!item.enabled} onClick={() => { setMenu(undefined); void run(() => window.douchat.setConnectionEnabled(item.id, false)) }}>{t('Disconnect')}</button>
            <button role="menuitem" disabled={item.kind === 'daemon' || !item.enabled} title={item.kind === 'daemon' ? t('douchat-host servers have no terminal here. Work on the server directly.') : undefined}
              onClick={() => { setMenu(undefined); void run(() => window.douchat.openConnectionTerminal(item.id)) }}>{t('Open in terminal')}</button>
            {item.kind === 'daemon' && <button role="menuitem" onClick={() => { setMenu(undefined); void run(() => window.douchat.copyText(UNINSTALL_COMMAND)) }}>{t('Copy uninstall command')}</button>}
            <button role="menuitem" className="danger" onClick={() => remove(item)}>{t('Delete')}</button>
          </div>}
        </div>
      </div>
    </article>)}</section>}
    {editing && <ConnectionEditor connection={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={next => { setItems(next); setEditing(undefined) }} />}
    {scanning && <DiscoverDialog connection={scanning} agents={agents} onClose={() => setScanning(undefined)} onAdded={list => { onAgentsChange(list); const id = scanning.id; setScanning(undefined); void load(); onShowAgents?.(id) }} />}
  </>
}

function ConnectionEditor({ connection, onClose, onSaved }: { connection?: ConnectionView; onClose: () => void; onSaved: (items: ConnectionView[]) => void }): ReactElement {
  const [name, setName] = useState(connection?.name ?? '')
  const [host, setHost] = useState(connection?.ssh?.host ?? '')
  const [port, setPort] = useState(connection?.ssh?.port ? String(connection.ssh.port) : '')
  const [user, setUser] = useState(connection?.ssh?.user ?? '')
  const [identityFile, setIdentityFile] = useState(connection?.ssh?.identityFile ?? '')
  const [hosts, setHosts] = useState<string[]>([])
  const [manual, setManual] = useState(Boolean(connection))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => {
    void window.douchat.listSshHosts().then(list => {
      if (!mounted.current) return
      setHosts(list)
      if (!connection && list.length) setHost(current => current || list[0])
      else if (!list.length || (connection && !list.includes(connection.ssh?.host ?? ''))) setManual(true)
      else if (connection) setManual(false)
    }).catch(() => { if (mounted.current) setManual(true) })
  }, [])
  // Until the SSH config is read (slow from the web app), the select can only show manual entry.
  const manualEntry = manual || !hosts.length
  const moved = connection && (host.trim() !== connection.ssh?.host || (port ? Number(port) : undefined) !== connection.ssh?.port || (user.trim() || undefined) !== connection.ssh?.user || (identityFile.trim() || undefined) !== connection.ssh?.identityFile)
  const save = async (): Promise<void> => {
    if (moved && connection.agentIds.length && !window.confirm(t('Changing the server stops running turns on it, and folders chosen on the old server will no longer be used. Continue?'))) return
    setBusy(true); setError('')
    const input: RemoteConnectionInput = { ...(connection ? { id: connection.id } : {}), name: name.trim(),
      ssh: { host: host.trim(), ...(port.trim() ? { port: Number(port) } : {}), ...(user.trim() ? { user: user.trim() } : {}), ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}) } }
    try { onSaved(await window.douchat.saveConnection(input)) }
    catch (cause) { if (mounted.current) { setError(messageSendError(cause)); setBusy(false) } }
  }
  return <NativeDialog className="modal-backdrop" onClose={onClose} width={520}>
    <form className="local-agent-editor" role="dialog" aria-modal="true" aria-labelledby="connection-editor-title" onSubmit={event => { event.preventDefault(); if (!busy && host.trim()) void save() }}>
      <header><h2 id="connection-editor-title">{t(connection ? 'Edit connection' : 'Add connection')}</h2><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><X size={18} /></button></header>
      <fieldset disabled={busy}>
        <label>{t('Server')}<select value={manualEntry ? MANUAL_HOST : host} onChange={event => { if (event.target.value === MANUAL_HOST) { setManual(true); setHost('') } else { setManual(false); setHost(event.target.value) } }}>
          {hosts.map(item => <option key={item} value={item}>{item}</option>)}
          <option value={MANUAL_HOST}>{t('Enter manually…')}</option>
        </select></label>
        {manualEntry && <label>{t('Host alias or address')}<input required maxLength={255} value={host} placeholder="dev-box" spellCheck={false} onChange={event => setHost(event.target.value)} /></label>}
        <div className="local-agent-remote-grid">
          <label>{t('User')}<input maxLength={32} value={user} placeholder={t('From SSH config')} spellCheck={false} onChange={event => setUser(event.target.value)} /></label>
          <label>{t('Port')}<input inputMode="numeric" maxLength={5} value={port} placeholder="22" onChange={event => setPort(event.target.value.replace(/\D/g, ''))} /></label>
          <label>{t('Identity file')}<input maxLength={1024} value={identityFile} placeholder="~/.ssh/id_ed25519" spellCheck={false} onChange={event => setIdentityFile(event.target.value)} /></label>
        </div>
        <label>{t('Name')}<input maxLength={80} value={name} placeholder={host || 'dev-box'} onChange={event => setName(event.target.value)} /></label>
        <p className="settings-note">{t('Leave user, port and key empty to use your SSH config (~/.ssh/config). Uses the ssh client, keys and ssh-agent on this computer; passwords are not stored. Confirm the host key once in Terminal with ssh before testing.')}</p>
      </fieldset>
      {error && <p className="settings-error" role="alert">{t(error)}</p>}
      <footer><span /><button type="button" className="secondary-button" onClick={onClose}>{t('Cancel')}</button><button type="submit" className="primary-button" disabled={busy || !host.trim()}>{t(busy ? 'Saving…' : 'Save')}</button></footer>
    </form>
  </NativeDialog>
}

function DiscoverDialog({ connection, agents, onClose, onAdded }: { connection: ConnectionView; agents: LocalAgent[]; onClose: () => void; onAdded: (agents: LocalAgent[]) => void }): ReactElement {
  const [found, setFound] = useState<DiscoveredRemoteAgent[]>()
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  // An executable already registered on this connection is shown as added, not offered again.
  const added = (item: DiscoveredRemoteAgent) => agents.some(agent => (agent.remoteAgent?.connectionId ?? agent.connectionId) === connection.id && agent.remoteAgent?.executable === item.executable)
  useEffect(() => {
    void window.douchat.discoverRemoteAgents(connection.id).then(list => { setFound(list); setChosen(new Set(list.filter(item => !added(item)).map(item => item.adapter))) }, cause => setError(messageSendError(cause))).finally(() => setBusy(false))
  }, [connection.id])
  const add = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      onAdded(await window.douchat.addDiscoveredAgents(connection.id, (found ?? []).filter(item => chosen.has(item.adapter)).map(item => ({
        adapter: item.adapter, executable: item.executable, name: `${ADAPTER_NAMES[item.adapter] ?? item.adapter} · ${connection.name}`
      }))))
    } catch (cause) { setError(messageSendError(cause)); setBusy(false) }
  }
  return <NativeDialog className="modal-backdrop" onClose={onClose} width={520}>
    <div className="local-agent-editor" role="dialog" aria-modal="true" aria-labelledby="discover-title">
      <header><h2 id="discover-title">{t('Agents on')} {connection.name}</h2><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><X size={18} /></button></header>
      {!found && busy && <p className="settings-note"><RefreshCw size={13} className="spin" /> {t('Scanning the server…')}</p>}
      {found && !found.length && <p className="settings-note">{t('No supported agents were found in the login PATH on this server.')}</p>}
      {found && found.length > 0 && <p className="settings-note">{t('They join Settings → Agents, ready to add as contacts.')}</p>}
      {/* The same row as Settings → Agents: icon, name, path and version, with a checkbox to pick it. */}
      {found && found.length > 0 && <div className="discovered-agents">{found.map(item => {
        const name = ADAPTER_NAMES[item.adapter] ?? item.adapter
        const version = item.version?.match(/v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? item.version ?? ''
        const already = added(item)
        return <label key={item.adapter} className={`discovered-agent ${already ? 'added' : ''}`}>
          <span className="local-agent-icon">{agentIcons[item.adapter] ? <img src={agentIcons[item.adapter]} alt="" /> : <Bot size={22} />}</span>
          <span className="local-agent-copy"><strong>{name}</strong><code title={item.executable}>{item.executable}</code></span>
          {already ? <span className="discovered-agent-added">{t('Added')}</span> : version && <span className="local-agent-version" title={item.version}>{version}</span>}
          <input type="checkbox" aria-label={name} disabled={already} checked={already || chosen.has(item.adapter)} onChange={event => setChosen(current => { const next = new Set(current); if (event.target.checked) next.add(item.adapter); else next.delete(item.adapter); return next })} />
        </label>
      })}</div>}
      {error && <p className="settings-error" role="alert">{t(error)}</p>}
      <footer><span /><button type="button" className="secondary-button" onClick={onClose}>{t('Cancel')}</button><button type="button" className="primary-button" disabled={busy || !chosen.size} onClick={() => void add()}>{chosen.size ? tr(chosen.size === 1 ? 'Add {count} agent' : 'Add {count} agents', { count: chosen.size }) : t('Add agents')}</button></footer>
    </div>
  </NativeDialog>
}
