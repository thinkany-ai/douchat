import { Bot, Check, Copy, Laptop, MoreHorizontal, Plus, RefreshCw, ScanSearch, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { AglDeviceAgent, AglDeviceView, AglPairing, ConnectionView, LocalAgent } from '../../../shared/types'
import { messageSendError } from '../messageQueue'
import { t, tr } from '../preferences'
import { agentIcons } from '../agentIcons'
import { NativeDialog } from './NativeDialog'
import { DesktopAppLinks, ServerConnections, useDesktopOnline } from './ConnectionsPanel'

export type DevicesTab = 'devices' | 'environments'
/** How often the add-device dialog looks for the newly linked machine. */
export const PAIRING_POLL_MS = 2_000

const deviceName = (device: AglDeviceView): string => device.name || device.hostname || device.machineId
// agl reports Rust's names (macos, aarch64); show the ones people know.
const OS_NAMES: Record<string, string> = { macos: 'macOS', linux: 'Linux', windows: 'Windows' }
const ARCH_NAMES: Record<string, string> = { aarch64: 'arm64', x86_64: 'x64' }
export const deviceDetails = (device: AglDeviceView): string => [
  device.hostname,
  [OS_NAMES[device.os] ?? device.os, ARCH_NAMES[device.arch] ?? device.arch].filter(Boolean).join(' '),
  device.version ? `agl ${device.version}` : ''
].filter(Boolean).join(' · ')
/** An agent agl reports on a device that is already one of this computer's agents. */
const alreadyAdded = (agents: LocalAgent[], device: Pick<AglDeviceView, 'machineId' | 'connectionId'>, agent: AglDeviceAgent): boolean =>
  agents.some(item => (item.agl?.machineId === device.machineId && item.agl.agent === agent.id)
    || (Boolean(device.connectionId) && item.remoteAgent?.connectionId === device.connectionId && item.remoteAgent?.executable === agent.id))

function useCopy(): { copied: string; copyError: string; copy: (value: string, key: string) => void } {
  const [copied, setCopied] = useState('')
  const [copyError, setCopyError] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = (value: string, key: string): void => {
    clearTimeout(timer.current)
    setCopied(''); setCopyError('')
    void window.douchat.copyText(value).then(() => {
      setCopied(key)
      timer.current = setTimeout(() => setCopied(''), 2500)
    }).catch(() => setCopyError('Could not copy command. Try again.'))
  }
  return { copied, copyError, copy }
}

/**
 * Discover → Devices & Environments. Devices are machines linked to the
 * account through agl (plus douchat-host servers added before it);
 * Environments are SSH servers this computer connects to.
 */
export function DevicesPanel({ agents = [], onAgentsChange, onShowAgents }: {
  agents?: LocalAgent[]
  onAgentsChange: (agents: LocalAgent[]) => void
  /** After adding agents: show them in Settings → Agents, on their device. */
  onShowAgents?: (connectionId: string) => void
}): ReactElement {
  const [tab, setTab] = useState<DevicesTab>('devices')
  const web = window.douchat.platform === 'web'
  return <>
    <header className="settings-heading local-proxy-heading"><div><h1>{t('Devices & Environments')}</h1><p>{t('Use the coding agents on your other machines and servers.')}</p></div></header>
    <div className="connections-tabs" role="tablist">
      {(['devices', 'environments'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{t(value === 'devices' ? 'Devices' : 'Environments')}</button>)}
    </div>
    {tab === 'devices'
      ? <DevicesTabPanel web={web} agents={agents} onAgentsChange={onAgentsChange} onShowAgents={onShowAgents} />
      : web ? <WebEnvironments /> : <ServerConnections kind="ssh" agents={agents} onAgentsChange={onAgentsChange} onShowAgents={onShowAgents} />}
  </>
}

function WebEnvironments(): ReactElement {
  const online = useDesktopOnline(true)
  return <>
    <p className="settings-note">{t('Environments are servers the desktop app reaches over SSH, with the SSH config and keys on your computer. Add and manage them in the desktop app; their agents then work here too.')}</p>
    <DesktopAppLinks online={online} />
  </>
}

function DevicesTabPanel({ web, agents, onAgentsChange, onShowAgents }: { web: boolean; agents: LocalAgent[]; onAgentsChange: (agents: LocalAgent[]) => void; onShowAgents?: (connectionId: string) => void }): ReactElement {
  const [devices, setDevices] = useState<AglDeviceView[]>()
  const [hosts, setHosts] = useState<ConnectionView[]>([])
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [scanning, setScanning] = useState<AglDeviceView>()
  const [renaming, setRenaming] = useState<AglDeviceView>()
  const [menu, setMenu] = useState<string>()
  const desktopOnline = useDesktopOnline(web)
  const load = useCallback(() => {
    void window.douchat.listAglDevices().then(setDevices, cause => { setDevices(current => current ?? []); setError(messageSendError(cause)) })
    // douchat-host servers are managed in the desktop app only.
    if (!web) void window.douchat.listConnections().then(list => setHosts(list.filter(item => item.kind === 'daemon')), () => undefined)
  }, [web])
  useEffect(() => { load(); return window.douchat.onConnectionsChanged(() => load()) }, [load])
  const run = async (action: () => Promise<AglDeviceView[] | void>): Promise<void> => {
    setError('')
    try { const next = await action(); if (next) setDevices(next) } catch (cause) { setError(messageSendError(cause)) }
  }
  const remove = (device: AglDeviceView): void => {
    setMenu(undefined)
    if (!device.agentIds.length) {
      if (window.confirm(t('Remove this device from your account? Douchat can no longer reach it until you add it again.'))) void run(() => window.douchat.removeAglDevice(device.machineId, 'disable-agents'))
      return
    }
    const deleteAgents = window.confirm(t('Agents use this device. Press OK to delete them too (agents used by contacts are kept), or Cancel to keep them all (they will be unavailable).'))
    if (!deleteAgents && !window.confirm(t('Keep the agents and remove the device?'))) return
    void run(async () => {
      const next = await window.douchat.removeAglDevice(device.machineId, deleteAgents ? 'delete-agents' : 'disable-agents')
      onAgentsChange(await window.douchat.detectLocalAgents())
      return next
    })
  }
  const added = (list: LocalAgent[], machineId: string): void => {
    onAgentsChange(list)
    load()
    const connectionId = list.find(agent => agent.agl?.machineId === machineId)?.agl?.connectionId
    if (connectionId) onShowAgents?.(connectionId)
  }
  const status = (device: AglDeviceView): string => {
    if (device.connectionId && device.enabled === false) return t('Turned off')
    return t(device.online ? 'Online' : 'Offline')
  }
  return <>
    {web ? <>
      <p className="settings-note">{t('Devices are added in the desktop app, and Douchat on your computer drives the agents on them. Open the desktop app to add a device; its agents then work here too.')}</p>
      <DesktopAppLinks online={desktopOnline} />
    </> : <>
      <p className="settings-note">{t('Link any machine to your Douchat account by running one command on it. It connects out to Douchat, so it needs no open port, and Douchat drives the coding agents on it through agl.')}</p>
      <div className="connection-add"><button className="secondary-button" onClick={() => setAdding(true)}><Plus size={15} />{t('Add device')}</button></div>
    </>}
    {error && <p className="settings-error" role="alert">{t(error)}</p>}
    {devices && !devices.length && !hosts.length && <p className="settings-note">{t(web ? 'No devices yet.' : 'No devices yet. Add one and run the install command on it.')}</p>}
    {devices && devices.length > 0 && <section aria-label={t('Devices')}>{devices.map(device => <article className="local-agent-row connection-row" key={device.machineId}>
      {!web && device.connectionId && <button type="button" className="detail-switch" role="switch" aria-label={`${t('Enabled')} ${deviceName(device)}`} aria-checked={device.enabled !== false}
        onClick={() => void run(async () => { await window.douchat.setConnectionEnabled(device.connectionId!, device.enabled === false); return window.douchat.listAglDevices() })} />}
      <span className="local-agent-icon installed"><Laptop size={20} /></span>
      <div className="local-agent-copy">
        <strong>{deviceName(device)}{device.thisComputer && <span className="local-agent-remote-badge this-computer-badge">{t('This computer')}</span>}</strong>
        <span className={`connection-status connection-status-${device.connectionId && device.enabled === false ? 'disabled' : device.online ? 'connected' : 'disabled'}`} role="status"><i aria-hidden="true" />{status(device)}{device.agentIds.length ? ` · ${device.agentIds.length} ${t(device.agentIds.length === 1 ? 'agent' : 'agents')}` : ''}</span>
        {deviceDetails(device) && <code title={device.machineId}>{deviceDetails(device)}</code>}
      </div>
      {!web && <div className="local-agent-row-aside">
        {/* This computer's agents run here directly; they are in Settings → Agents. */}
        {!device.thisComputer && <button type="button" className="secondary-button" disabled={!device.online || device.enabled === false} title={t('Scan for agents on this device')} aria-label={`${t('Scan for agents on this device')} ${deviceName(device)}`} onClick={() => setScanning(device)}><ScanSearch size={15} /></button>}
        <div className="connection-menu">
          <button type="button" className="icon-button" aria-label={`${t('More')} ${deviceName(device)}`} aria-expanded={menu === device.machineId} onClick={() => setMenu(menu === device.machineId ? undefined : device.machineId)}><MoreHorizontal size={16} /></button>
          {menu === device.machineId && <div className="connection-menu-items" role="menu">
            <button role="menuitem" onClick={() => { setMenu(undefined); setRenaming(device) }}>{t('Rename')}</button>
            <button role="menuitem" className="danger" onClick={() => remove(device)}>{t('Remove device')}</button>
          </div>}
        </div>
      </div>}
    </article>)}</section>}
    {!web && <ServerConnections kind="daemon" agents={agents} onAgentsChange={onAgentsChange} onShowAgents={onShowAgents} />}
    {devices && devices.length > 0 && <p className="settings-note">{t('Images and files in chats are not sent to agents on devices yet.')}</p>}
    {adding && <AddDeviceDialog agents={agents} onClose={() => { setAdding(false); load() }} onAdded={(list, machineId) => { setAdding(false); added(list, machineId) }} />}
    {scanning && <NativeDialog className="modal-backdrop" onClose={() => setScanning(undefined)} width={520}>
      <div className="local-agent-editor" role="dialog" aria-modal="true" aria-labelledby="agl-agents-title">
        <header><h2 id="agl-agents-title">{t('Agents on')} {deviceName(scanning)}</h2><button type="button" className="icon-button" aria-label={t('Close')} onClick={() => setScanning(undefined)}><X size={18} /></button></header>
        <AglAgentPicker device={scanning} agents={agents} onCancel={() => setScanning(undefined)} onAdded={list => { const id = scanning.machineId; setScanning(undefined); added(list, id) }} />
      </div>
    </NativeDialog>}
    {renaming && <RenameDeviceDialog device={renaming} onClose={() => setRenaming(undefined)} onSaved={next => { setDevices(next); setRenaming(undefined) }} />}
  </>
}

/** Scans a device with agl's `agents.list` and adds the chosen agents as this account's agents. */
function AglAgentPicker({ device, agents, cancelLabel = 'Cancel', onCancel, onAdded }: {
  device: Pick<AglDeviceView, 'machineId' | 'connectionId' | 'name' | 'hostname'>
  agents: LocalAgent[]
  cancelLabel?: string
  onCancel: () => void
  onAdded: (agents: LocalAgent[]) => void
}): ReactElement {
  const [found, setFound] = useState<AglDeviceAgent[]>()
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const name = device.name || device.hostname || t('Device')
  useEffect(() => {
    void window.douchat.discoverAglAgents(device.machineId).then(list => {
      setFound(list)
      setChosen(new Set(list.filter(item => item.available && !alreadyAdded(agents, device, item)).map(item => item.id)))
    }, cause => setError(messageSendError(cause))).finally(() => setBusy(false))
  }, [device.machineId])
  const add = async (): Promise<void> => {
    setBusy(true); setError('')
    try {
      onAdded(await window.douchat.addAglAgents(device.machineId, (found ?? []).filter(item => chosen.has(item.id)).map(item => ({ id: item.id, name: `${item.name} · ${name}` }))))
    } catch (cause) { setError(messageSendError(cause)); setBusy(false) }
  }
  const shown = found?.filter(item => item.available || item.status === 'desktop-only') ?? []
  return <>
    {!found && busy && <p className="settings-note"><RefreshCw size={13} className="spin" /> {t('Scanning the device…')}</p>}
    {found && !shown.length && <p className="settings-note">{t('agl found no supported agents on this device. Install one there, then scan again.')}</p>}
    {shown.length > 0 && <p className="settings-note">{t('They join Settings → Agents, ready to add as contacts.')}</p>}
    {shown.length > 0 && <div className="discovered-agents">{shown.map(item => {
      const already = alreadyAdded(agents, device, item)
      const version = item.version?.match(/v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? item.version ?? ''
      return <label key={item.id} className={`discovered-agent ${already || !item.available ? 'added' : ''}`}>
        <span className="local-agent-icon">{agentIcons[item.id] ? <img src={agentIcons[item.id]} alt="" /> : <Bot size={22} />}</span>
        <span className="local-agent-copy"><strong>{item.name}</strong><code>{item.id}</code></span>
        {already ? <span className="discovered-agent-added">{t('Added')}</span> : !item.available ? <span className="discovered-agent-added">{t('Desktop app only')}</span> : version && <span className="local-agent-version" title={item.version}>{version}</span>}
        <input type="checkbox" aria-label={item.name} disabled={already || !item.available} checked={already || chosen.has(item.id)} onChange={event => setChosen(current => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next })} />
      </label>
    })}</div>}
    {error && <p className="settings-error" role="alert">{t(error)}</p>}
    <footer><span /><button type="button" className="secondary-button" onClick={onCancel}>{t(cancelLabel)}</button><button type="button" className="primary-button" disabled={busy || !chosen.size} onClick={() => void add()}>{chosen.size ? tr(chosen.size === 1 ? 'Add {count} agent' : 'Add {count} agents', { count: chosen.size }) : t('Add agents')}</button></footer>
  </>
}

/**
 * Adds a device: a one-time pairing code in an install command, then the
 * device list is polled until a machine paired after this dialog opened comes
 * online. The user names it and picks which of its agents to add.
 */
export function AddDeviceDialog({ agents, onClose, onAdded }: { agents: LocalAgent[]; onClose: () => void; onAdded: (agents: LocalAgent[], machineId: string) => void }): ReactElement {
  const [pairing, setPairing] = useState<AglPairing>()
  const [device, setDevice] = useState<AglDeviceView>()
  const [step, setStep] = useState<'install' | 'name' | 'agents'>('install')
  const [name, setName] = useState('')
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const { copied, copyError, copy } = useCopy()
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setPairing(undefined); setDevice(undefined); setExpired(false); setError('')
    // Devices already paired before this dialog opened are not the new one; a re-paired machine gets a newer pairedAt.
    const before = window.douchat.listAglDevices().then(list => new Map(list.map(item => [item.machineId, item.pairedAt])), () => new Map<string, number>())
    void Promise.all([window.douchat.createAglPairing(), before]).then(([created, known]) => {
      if (!active) return
      setPairing(created)
      const poll = async (): Promise<void> => {
        if (!active) return
        try {
          // This computer may link itself meanwhile (Settings → Agents → agl); it is not the device being added.
          const found = (await window.douchat.listAglDevices()).find(item => item.online && !item.thisComputer && (!known.has(item.machineId) || item.pairedAt > known.get(item.machineId)!))
          if (!active) return
          if (found) { setDevice(found); setName(deviceName(found)); setStep('name'); return }
        } catch { /* Polled again shortly. */ }
        if (created.expiresAt && Date.now() > created.expiresAt) { setExpired(true); return }
        timer = setTimeout(() => void poll(), PAIRING_POLL_MS)
      }
      timer = setTimeout(() => void poll(), PAIRING_POLL_MS)
    }).catch(cause => { if (active) setError(messageSendError(cause)) })
    return () => { active = false; clearTimeout(timer) }
  }, [attempt])
  const handOff = pairing ? `${t('Install agl on this machine and link it to my Douchat account by running this command in a terminal (not as root):')}\n\n${pairing.installCommand}` : ''
  const saveName = async (): Promise<void> => {
    if (!device) return
    setBusy(true); setError('')
    try {
      const next = await window.douchat.renameAglDevice(device.machineId, name.trim())
      setDevice(next.find(item => item.machineId === device.machineId) ?? { ...device, name: name.trim() })
      setStep('agents')
    } catch (cause) { setError(messageSendError(cause)) }
    finally { setBusy(false) }
  }
  return <NativeDialog className="modal-backdrop" onClose={onClose} width={560}>
    <form className="local-agent-editor" role="dialog" aria-modal="true" aria-labelledby="add-device-title" onSubmit={event => { event.preventDefault(); if (step === 'name' && name.trim() && !busy) void saveName() }}>
      <header><h2 id="add-device-title">{t('Add device')}</h2><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><X size={18} /></button></header>
      {step === 'install' && !pairing && !error && <p className="settings-note"><RefreshCw size={13} className="spin" /> {t('Creating install command…')}</p>}
      {step === 'install' && pairing && <>
        <p className="settings-note">{t('Run this in a terminal on the machine, as the user the agents should run as (not root). It installs agl, links the machine to your account and keeps agl running.')}</p>
        <div className="daemon-command"><code>{pairing.installCommand}</code><button type="button" className="secondary-button" aria-label={t('Copy install command')} onClick={() => copy(pairing.installCommand, 'install')}>{copied === 'install' ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{t(copied === 'install' ? 'Copied' : 'Copy')}</span></button></div>
        <p className="settings-note">{t('Or hand it to an agent already working on that machine:')}</p>
        <div className="daemon-command"><code>{handOff}</code><button type="button" className="secondary-button" aria-label={t('Copy instructions for an agent')} onClick={() => copy(handOff, 'agent')}>{copied === 'agent' ? <Check size={14} /> : <Copy size={14} />}<span aria-live="polite">{t(copied === 'agent' ? 'Copied' : 'Copy')}</span></button></div>
        <p className="settings-note">{t('The command contains a one-time code that expires in 10 minutes. Do not share it.')}</p>
        {expired
          ? <p className="settings-error" role="alert">{t('The install command expired before the device connected.')} <button type="button" className="local-settings-link" onClick={() => setAttempt(value => value + 1)}>{t('Create a new one')}</button></p>
          : <p className="settings-note" role="status"><RefreshCw size={13} className="spin" /> {t('Waiting for the device to connect…')}</p>}
      </>}
      {copyError && <p className="settings-error" role="alert">{t(copyError)}</p>}
      {step === 'name' && device && <fieldset disabled={busy}>
        <p className="connection-step-ok" role="status">✓ {t('The device is online')}{deviceDetails(device) ? ` · ${deviceDetails(device)}` : ''}</p>
        <label>{t('Name')}<input autoFocus maxLength={80} value={name} placeholder="dev-box" onChange={event => setName(event.target.value)} /></label>
      </fieldset>}
      {step === 'agents' && device && <AglAgentPicker device={device} agents={agents} cancelLabel="Skip" onCancel={onClose} onAdded={list => onAdded(list, device.machineId)} />}
      {error && <p className="settings-error" role="alert">{t(error)}</p>}
      {step !== 'agents' && <footer><span /><button type="button" className="secondary-button" onClick={onClose}>{t('Cancel')}</button>{step === 'name' && <button type="submit" className="primary-button" disabled={busy || !name.trim()}>{t(busy ? 'Saving…' : 'Next')}</button>}</footer>}
    </form>
  </NativeDialog>
}

function RenameDeviceDialog({ device, onClose, onSaved }: { device: AglDeviceView; onClose: () => void; onSaved: (devices: AglDeviceView[]) => void }): ReactElement {
  const [name, setName] = useState(deviceName(device))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (): Promise<void> => {
    setBusy(true); setError('')
    try { onSaved(await window.douchat.renameAglDevice(device.machineId, name.trim())) }
    catch (cause) { setError(messageSendError(cause)); setBusy(false) }
  }
  return <NativeDialog className="modal-backdrop" onClose={onClose} width={440}>
    <form className="local-agent-editor" role="dialog" aria-modal="true" aria-labelledby="rename-device-title" onSubmit={event => { event.preventDefault(); if (name.trim() && !busy) void save() }}>
      <header><h2 id="rename-device-title">{t('Rename device')}</h2><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><X size={18} /></button></header>
      <fieldset disabled={busy}><label>{t('Name')}<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label></fieldset>
      {error && <p className="settings-error" role="alert">{t(error)}</p>}
      <footer><span /><button type="button" className="secondary-button" onClick={onClose}>{t('Cancel')}</button><button type="submit" className="primary-button" disabled={busy || !name.trim()}>{t(busy ? 'Saving…' : 'Save')}</button></footer>
    </form>
  </NativeDialog>
}
