import { Link2, RefreshCw } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import type { AglSettings, AglStatusView } from '../../../shared/agl'
import { messageSendError } from '../messageQueue'
import { t, tr } from '../preferences'

const STATE_LABELS: Record<AglStatusView['state'], string> = {
  unsupported: 'Not available on this system', disabled: 'Off in development builds', off: 'Off', starting: 'Starting…', 'not-installed': 'Not installed',
  'needs-update': 'Needs update', stopped: 'Not running', running: 'Running', error: 'Not running'
}

const time = (value: number): string => new Date(value).toLocaleString()

/** What agl's updates look like right now, in one line. */
export function aglUpdateLine(status: AglStatusView): string {
  const update = status.update
  if (update.appliedAt && update.appliedVersion) return tr('Updated to {version} on {time}', { version: update.appliedVersion, time: time(update.appliedAt) })
  if (update.available && update.busy) return tr('agl {version} is available; it installs once agents finish their current turns.', { version: update.latest ?? '' })
  if (update.available) return tr('agl {version} is available.', { version: update.latest ?? '' })
  if (update.checkedAt) return tr('Up to date · checked {time}', { time: time(update.checkedAt) })
  return t('agl checks for updates by itself every 12 hours.')
}

/** agl can be managed here: not on Windows, not in a development build without an agl home. */
export const aglManaged = (status: AglStatusView | undefined): status is AglStatusView => Boolean(status && status.state !== 'unsupported' && status.state !== 'disabled')

/** This computer's link to the account is missing or stopped working, so "Re-link" helps. */
export const aglNeedsRelink = (status: AglStatusView | undefined): boolean =>
  Boolean(status && status.state === 'running' && status.machineId && (status.linked === false || status.hubStatus === 'unauthorized' || status.linkError))

/** agl's status and settings, following status pushes from the main process. */
export function useAgl(): {
  available: boolean; status?: AglStatusView; settings?: AglSettings; error: string
  setStatus: (status: AglStatusView) => void; save: (patch: Partial<AglSettings>) => Promise<void>; setError: (error: string) => void
} {
  const api = window.douchat
  const available = api.platform !== 'web' && Boolean(api.getAglStatus && api.getAglSettings)
  const [status, setStatus] = useState<AglStatusView>()
  const [settings, setSettings] = useState<AglSettings>()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!available) return
    let active = true
    void Promise.all([api.getAglStatus!(), api.getAglSettings!()]).then(([nextStatus, nextSettings]) => {
      if (active) { setStatus(nextStatus); setSettings(nextSettings) }
    }, cause => { if (active) setError(messageSendError(cause)) })
    const off = api.onAglStatus?.(next => setStatus(next))
    return () => { active = false; off?.() }
  }, [available])
  const save = async (patch: Partial<AglSettings>): Promise<void> => {
    setError('')
    try { setSettings(await api.saveAglSettings!(patch)) } catch (cause) { setError(messageSendError(cause)) }
  }
  return { available, status, settings, error, setStatus, save, setError }
}

/**
 * The one-time question before Douchat touches ~/.agl. Shown until the user
 * answers it (Enable or Not now); afterwards the master switch in Settings →
 * Agents → agl changes the answer.
 */
export function AglConsentCard({ status, settings, onSave }: { status?: AglStatusView; settings?: AglSettings; onSave: (patch: Partial<AglSettings>) => Promise<void> }): ReactElement | null {
  const [saving, setSaving] = useState(false)
  if (!aglManaged(status) || !settings || settings.enabled !== undefined) return null
  const answer = async (enabled: boolean): Promise<void> => {
    setSaving(true)
    try { await onSave({ enabled }) } finally { setSaving(false) }
  }
  return <section className="agl-consent" aria-labelledby="agl-consent-title">
    <h2 id="agl-consent-title">{t('Run coding agents with agl')}</h2>
    <p>{t('Douchat uses agl to run coding agents on this computer. If you turn it on, Douchat will:')}</p>
    <ul>
      <li>{tr('install agl in {folder}, which other apps that use agl share;', { folder: status.home })}</li>
      <li>{t('keep it running in the background (it starts when you log in) and update it automatically;')}</li>
      <li>{t('link this computer to your Douchat account, so the web app and your phone can use its agents.')}</li>
    </ul>
    <p className="settings-note">{t('You can turn it off at any time in Settings → Agents. Turning it off uninstalls nothing.')}</p>
    <div className="agl-consent-actions">
      <button type="button" className="secondary-button" disabled={saving} onClick={() => void answer(false)}>{t('Not now')}</button>
      <button type="button" className="primary-button" disabled={saving} onClick={() => void answer(true)}>{t('Enable')}</button>
    </div>
  </section>
}

/** "Re-link": links this computer to the signed-in account again. */
export function AglRelinkButton({ onDone, onError, label = 'Re-link' }: { onDone: (status: AglStatusView) => void; onError: (error: string) => void; label?: string }): ReactElement | null {
  const api = window.douchat
  const [linking, setLinking] = useState(false)
  if (!api.relinkAgl) return null
  const relink = async (): Promise<void> => {
    setLinking(true); onError('')
    try { onDone(await api.relinkAgl!()) } catch (cause) { onError(messageSendError(cause)) } finally { setLinking(false) }
  }
  return <button type="button" className="secondary-button" disabled={linking} onClick={() => void relink()}>
    <Link2 size={15} />{t(linking ? 'Linking…' : label)}</button>
}

/**
 * Settings → Agents: the agl daemon on this computer, which Douchat installs
 * and keeps running once the user turned it on, plus its switches. Desktop app only.
 */
export function AglSettingsSection(): ReactElement | null {
  const api = window.douchat
  const { available, status, settings, error, setStatus, save, setError } = useAgl()
  const [checking, setChecking] = useState(false)
  if (!available) return null
  const check = async (): Promise<void> => {
    setChecking(true); setError('')
    try { setStatus(await api.checkAglUpdates!()) } catch (cause) { setError(messageSendError(cause)) } finally { setChecking(false) }
  }
  const managed = aglManaged(status)
  const enabled = settings?.enabled === true
  const problem = status?.error || status?.update.error || status?.linkError
  return <section className="agl-settings" aria-label="agl">
    <div className="local-agent-section-heading"><h2>agl {status && <span className={`connection-status connection-status-${status.state === 'running' ? 'connected' : 'disabled'}`} role="status"><i aria-hidden="true" />{t(STATE_LABELS[status.state])}</span>}</h2>
      {managed && enabled && <div className="local-agent-heading-actions">
        {aglNeedsRelink(status) && <AglRelinkButton onDone={setStatus} onError={setError} />}
        <button type="button" className="secondary-button" disabled={checking || status.busy} onClick={() => void check()}>
          <RefreshCw size={15} className={checking || status.busy ? 'spin' : undefined} />{t(checking ? 'Checking for updates…' : 'Check for updates')}</button></div>}
    </div>
    <p className="settings-note">{t('agl runs the coding agents on this computer for Douchat and links it to your account, so it appears in Devices. It is shared with the agl command and other apps, and updates itself.')}</p>
    {status?.state === 'unsupported' && <p className="settings-note">{t('agl does not support Windows yet. Douchat runs agents on this computer itself.')}</p>}
    {status?.state === 'disabled' && <p className="settings-note">{t('Set DOUCHAT_AGL_HOME to try agl in a development build; the shared ~/.agl is left alone.')}</p>}
    <AglConsentCard status={status} settings={settings} onSave={save} />
    {managed && <dl className="agl-facts">
      <div><dt>{t('Version')}</dt><dd>{status.version ? `agl ${status.version}` : '—'}{status.daemonVersion ? ` · ${tr('daemon {version}', { version: status.daemonVersion })}` : ''}{status.state === 'needs-update' ? ` · ${tr('{version} or newer needed', { version: status.minimumVersion })}` : ''}</dd></div>
      <div><dt>{t('Status')}</dt><dd>{status.state === 'off' ? t(status.running ? 'Running (Douchat does not manage it)' : 'Not running') : t(STATE_LABELS[status.state])}{status.service !== undefined ? ` · ${t(status.service ? 'Starts at login' : 'Does not start at login')}` : ''}</dd></div>
      <div><dt>{t('This computer')}</dt><dd>{status.linked === undefined ? '—' : t(!status.linked ? 'Not linked to your account' : status.hubStatus === 'unauthorized' ? 'Removed from your account' : 'Linked to your account')}</dd></div>
      {enabled && <div><dt>{t('Updates')}</dt><dd>{aglUpdateLine(status)}</dd></div>}
      <div><dt>{t('Folder')}</dt><dd><code>{status.home}</code></dd></div>
    </dl>}
    {problem && <p className="settings-error" role="alert">{t('Last error:')} {t(problem)}</p>}
    {error && <p className="settings-error" role="alert">{t(error)}</p>}
    {managed && settings && settings.enabled !== undefined && <div className="agl-switches">
      <label><span><strong>{t('Enable agl')}</strong><small>{t('Lets Douchat install agl, keep it running and up to date, and link this computer to your account. Turning it off stops all of that; nothing is uninstalled.')}</small></span>
        <button type="button" className="detail-switch" role="switch" aria-label={t('Enable agl')} aria-checked={enabled} onClick={() => void save({ enabled: !enabled })} /></label>
      {enabled && <>
        <label><span><strong>{t('Show this computer in Devices')}</strong><small>{t('Links this computer to your Douchat account through agl, so you can use its agents from your other devices.')}</small></span>
          <button type="button" className="detail-switch" role="switch" aria-label={t('Show this computer in Devices')} aria-checked={settings.autoLink} onClick={() => void save({ autoLink: !settings.autoLink })} /></label>
        <label><span><strong>{t('Use agl for local agents (experimental)')}</strong><small>{t('Detect agents and list their models through agl, and run Codex through agl. Other agents still run the way they do now.')}</small></span>
          <button type="button" className="detail-switch" role="switch" aria-label={t('Use agl for local agents (experimental)')} aria-checked={settings.useForLocalAgents} onClick={() => void save({ useForLocalAgents: !settings.useForLocalAgents })} /></label>
      </>}
    </div>}
  </section>
}
