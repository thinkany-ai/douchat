import { Bot, Camera, RefreshCw, X } from 'lucide-react'

import { useEffect, useRef, useState } from 'react'
import { REMOTE_AGENT_ADAPTERS, type ConnectionView, type CustomLocalAgentInput, type LocalAgent, type RemoteAgentAdapter, type RemoteAgentBinding } from '../../../shared/types'
import { agentIcons } from '../agentIcons'
import { readAvatarFile } from '../avatarFile'
import { messageSendError } from '../messageQueue'
import { t, tr } from '../preferences'
import { NativeDialog } from './NativeDialog'

const ADAPTER_LABELS: Record<RemoteAgentAdapter, string> = {
  codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini', grok: 'Grok Build', cursor: 'Cursor', opencode: 'OpenCode',
  kimi: 'Kimi', openclaw: 'OpenClaw', fastclaw: 'FastClaw', hermes: 'Hermes', omp: 'OMP', custom: 'Custom CLI'
}
const DEFAULT_COMMANDS: Record<RemoteAgentAdapter, string> = {
  codex: 'codex', claude: 'claude', gemini: 'gemini', grok: 'grok', cursor: 'cursor-agent', opencode: 'opencode',
  kimi: 'kimi', openclaw: 'openclaw', fastclaw: 'fastclaw', hermes: 'hermes', omp: 'omp', custom: ''
}

const LOCAL = '@local'

export function LocalAgentEditor({ agent, connectionId: initialConnection, onSaved, onClose }: {
  agent?: LocalAgent
  /** For a new agent: start on this server connection (the one Settings → Agents is showing). */
  connectionId?: string
  onSaved: (agents: LocalAgent[]) => void
  onClose: () => void
}) {
  const [name, setName] = useState(agent?.name ?? '')
  const [command, setCommand] = useState(agent?.path || agent?.command || '')
  const [args, setArgs] = useState((agent?.remoteAgent?.args ?? agent?.args ?? []).join('\n'))
  const [avatar, setAvatar] = useState(agent?.avatar ?? '')
  // The run location is fixed once saved; only new custom agents can choose it.
  const [location, setLocation] = useState<'local' | 'remote'>(agent?.remoteAgent || (!agent && initialConnection) ? 'remote' : 'local')
  const [adapter, setAdapter] = useState<RemoteAgentAdapter>(agent?.remoteAgent?.adapter ?? 'codex')
  const [connectionId, setConnectionId] = useState(agent?.connectionId ?? (agent ? '' : initialConnection ?? ''))
  const [connections, setConnections] = useState<ConnectionView[]>()
  const [advanced, setAdvanced] = useState(Boolean(agent?.remoteAgent && (agent.remoteAgent.args.length || agent.remoteAgent.executable !== DEFAULT_COMMANDS[agent.remoteAgent.adapter])))
  const [executable, setExecutable] = useState(agent?.remoteAgent?.executable ?? 'codex')
  const [busy, setBusy] = useState<'test' | 'save' | 'avatar' | ''>('')
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const testing = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (testing.current) void window.douchat.cancelLocalAgentTest().catch(() => {})
    }
  }, [])
  useEffect(() => {
    if (typeof window.douchat.listConnections !== 'function') return
    void window.douchat.listConnections().then(list => {
      if (!mounted.current) return
      // Agents on an agl device are added from the device's scan, not configured here.
      setConnections(list.filter(item => item.kind !== 'agl'))
      if (!agent) setConnectionId(current => current || list.find(item => item.enabled)?.id || '')
    }).catch(() => { if (mounted.current) setConnections([]) })
  }, [])
  const remote = location === 'remote'
  /** An agent on an agl device: agl runs it, so only its name and picture are edited here. */
  const device = agent?.agl
  const canChooseLocation = !agent
  const argumentList = () => args.split(/\r?\n/).filter(arg => arg.length > 0)
  // Host, port, user and key belong to the connection; the agent only names it.
  const connection = connections?.find(item => item.id === connectionId)
  const remoteAgent = (): RemoteAgentBinding => device && agent?.remoteAgent ? agent.remoteAgent : ({
    connectionId, adapter, executable: executable.trim() || DEFAULT_COMMANDS[adapter], args: argumentList()
  })
  const draft = (): CustomLocalAgentInput => remote
    ? { name, command: remoteAgent().executable, avatar, args: [], remoteAgent: remoteAgent() }
    : { name, command, avatar, args: argumentList() }
  const changed = () => { setResult(''); setError('') }
  const ready = Boolean(name.trim()) && (device ? true : remote ? Boolean(connection?.enabled && (executable.trim() || DEFAULT_COMMANDS[adapter])) : Boolean(command.trim()))
  const test = async () => {
    setBusy('test'); setError(''); setResult(''); testing.current = true
    try {
      const response = await window.douchat.testLocalAgent(agent?.id, draft())
      if (mounted.current) {
        const version = remote ? response.version : response.version?.match(/v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? response.version
        setResult(`${t('Connected')} · ${(response.durationMs / 1000).toFixed(1)}s${version ? ` · ${version}` : ''}`)
      }
    } catch (cause) { if (mounted.current) setError(messageSendError(cause)) }
    finally { testing.current = false; if (mounted.current) setBusy('') }
  }
  const save = async () => {
    setBusy('save'); setError('')
    try {
      const agents = agent ? await window.douchat.updateLocalAgent(agent.id, draft()) : await window.douchat.addCustomLocalAgent(draft())
      onSaved(agents)
      if (mounted.current) onClose()
    } catch (cause) { if (mounted.current) { setError(messageSendError(cause)); setBusy('') } }
  }
  const icon = avatar || (agent && agentIcons[agent.remoteAgent?.adapter ?? agent.id]) || (remote ? agentIcons[adapter] : undefined)
  return <NativeDialog className="modal-backdrop" onClose={onClose} width={560}>
    <form className="local-agent-editor" role="dialog" aria-modal="true" aria-labelledby="local-agent-editor-title" onSubmit={event => { event.preventDefault(); if (!busy && ready) void save() }}>
      <header><h2 id="local-agent-editor-title">{t(agent ? (agent.remoteAgent ? 'Edit remote agent' : 'Edit agent') : 'Add agent')}</h2><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><X size={18} /></button></header>
      <fieldset disabled={Boolean(busy)}>
        <div className="local-agent-editor-avatar">
          <button type="button" className="local-agent-picture" aria-label={t('Choose picture')} onClick={() => file.current?.click()}>{icon ? <img src={icon} alt="" /> : <Bot size={30} />}<Camera size={14} /></button>
          <button type="button" className="secondary-button" onClick={() => file.current?.click()}>{t('Choose picture')}</button>
          {avatar && <button type="button" className="local-settings-link" onClick={() => { setAvatar(''); changed() }}>{t('Remove picture')}</button>}
          <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={async event => {
            const selected = event.target.files?.[0]; event.target.value = ''
            if (!selected) return
            setBusy('avatar'); changed()
            try { const image = await readAvatarFile(selected); if (mounted.current) setAvatar(image) }
            catch (cause) { if (mounted.current) setError(messageSendError(cause)) }
            finally { if (mounted.current) setBusy('') }
          }} />
        </div>
        <label>{t('Name')}<input autoFocus required maxLength={80} value={name} onChange={event => { setName(event.target.value); changed() }} /></label>
        {/* One choice: this computer or a specific server connection. */}
        {canChooseLocation && <label>{t('Run location')}<select aria-label={t('Run location')} value={remote ? connectionId : LOCAL} onChange={event => {
          if (event.target.value === LOCAL) setLocation('local')
          else { setLocation('remote'); setConnectionId(event.target.value) }
          changed()
        }}>
          <option value={LOCAL}>{t('This computer')}</option>
          {connections?.map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name}{item.enabled ? '' : ` (${t('Turned off')})`}</option>)}
        </select></label>}
        {canChooseLocation && connections && !connections.length && <p className="settings-note">{t('To run it on a server, add the server in Discover → Devices & Environments first.')}</p>}
        {device && <p className="settings-note">{tr('Runs on the device {device} through agl. Its agents are added and removed in Discover → Devices & Environments.', { device: device.label })}</p>}
        {!remote && <>
          <label>{t('Executable path')}<input required maxLength={2048} value={command} placeholder={agent?.path || '/path/to/agent'} spellCheck={false} onChange={event => { setCommand(event.target.value); changed() }} /></label>
          <label>{t('Startup arguments')}<textarea value={args} rows={4} spellCheck={false} placeholder={'--model\nmy-model'} onChange={event => { setArgs(event.target.value); changed() }} /></label>
          <p className="settings-note">{t(agent && !agent.custom ? 'One argument per line. Added to the built-in launch arguments.' : 'One argument per line. Use {prompt} for the message; otherwise it is appended as the last argument.')}</p>
        </>}
        {remote && !device && <>
          {!canChooseLocation && <label>{t('Connection')}<select value={connectionId} onChange={event => { setConnectionId(event.target.value); changed() }}>
            {!connection && <option value="">{t(connections && !connections.length ? 'No connections yet' : 'Choose a connection')}</option>}
            {connections?.map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name}{item.enabled ? '' : ` (${t('Turned off')})`}</option>)}
          </select></label>}
          {agent?.unavailable && <p className="settings-error" role="alert">{t(agent.unavailable === 'disabled' ? 'This agent\'s connection is turned off.' : 'This agent\'s connection was removed. Choose another one.')}</p>}
          <label>{t('Agent type')}<select value={adapter} onChange={event => {
            const next = event.target.value as RemoteAgentAdapter
            if (executable === DEFAULT_COMMANDS[adapter]) setExecutable(DEFAULT_COMMANDS[next])
            setAdapter(next); changed()
          }}>{REMOTE_AGENT_ADAPTERS.map(item => <option key={item} value={item}>{t(ADAPTER_LABELS[item])}</option>)}</select></label>
          <p className="settings-note">{t('Each chat gets its own private folder on the server unless you choose one in chat details.')}</p>
          <button type="button" className="local-settings-link" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>{t(advanced ? 'Hide advanced settings' : 'Advanced settings')}</button>
          {advanced && <>
            <label>{t('Executable on the server')}<input maxLength={1024} value={executable} placeholder={DEFAULT_COMMANDS[adapter] || '/path/to/agent'} spellCheck={false} onChange={event => { setExecutable(event.target.value); changed() }} /></label>
            <label>{t('Startup arguments')}<textarea value={args} rows={3} spellCheck={false} placeholder={adapter === 'custom' ? '--message\n{prompt}' : '--profile\nwork'} onChange={event => { setArgs(event.target.value); changed() }} /></label>
            <p className="settings-note">{t(adapter === 'custom' ? 'One argument per line. Use {prompt} for the message; otherwise it is appended as the last argument.' : 'One argument per line. Added to the built-in launch arguments. Options that disable the sandbox or approvals are rejected.')}</p>
          </>}
          <p className="settings-note">{t('Conversation context and attachments are sent to this server.')}</p>
        </>}
      </fieldset>
      {error && <p className="settings-error" role="alert">{t(error)}</p>}
      {result && <p className="local-agent-test-result" role="status">{result}</p>}
      {!device && <p className="settings-note">{t('Testing sends a short request using this CLI’s account and may use its quota.')}</p>}
      <footer>
        {device ? <span /> : <button type="button" className="secondary-button" disabled={Boolean(busy) || !ready} onClick={() => void test()}>{busy === 'test' && <RefreshCw size={15} className="spin" />}{t(busy === 'test' ? 'Testing…' : 'Test connection')}</button>}
        <span />
        <button type="button" className="secondary-button" onClick={onClose}>{t('Cancel')}</button>
        <button type="submit" className="primary-button" disabled={Boolean(busy) || !ready}>{t(busy === 'save' ? 'Saving…' : 'Save')}</button>
      </footer>
    </form>
  </NativeDialog>
}
