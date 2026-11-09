import { parseAglVersion } from './aglVersion'

/** One hub link, as `agl status --json` reports it. */
export interface AglHubLink { url: string; status: string; transport?: string }

/** `agl status --json` (works without a daemon). */
export interface AglStatusJson {
  version?: string
  running: boolean
  daemonVersion?: string
  pid?: number
  /** Sessions running or queuing a turn; undefined when the daemon is not running. */
  busy?: number
  /** The daemon was started by the autostart service (agl 0.3.8+). */
  managed?: boolean
  machineId?: string
  /** The autostart unit exists. It is per user, not per agl home. */
  service: boolean
  hubs: AglHubLink[]
}

/** `agl update --json` (with or without `--check` / `--if-idle`). */
export interface AglUpdateJson { current?: string; latest?: string; updateAvailable: boolean; updated: boolean; busy?: number }

const string = (value: unknown, max = 200): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

/** The JSON object an agl command printed; agl prints nothing else on stdout with `--json`. */
function json(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{')
  const value: unknown = JSON.parse(start >= 0 ? stdout.slice(start) : stdout)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('agl printed no JSON object')
  return value as Record<string, unknown>
}

export function parseAglStatus(stdout: string): AglStatusJson {
  const data = json(stdout)
  const hubs = Array.isArray(data.hubs) ? data.hubs.flatMap((item): AglHubLink[] => {
    if (!item || typeof item !== 'object') return []
    const hub = item as Record<string, unknown>
    const url = string(hub.url, 2048)
    return url ? [{ url, status: string(hub.status, 80) ?? 'unknown', ...(string(hub.transport, 20) ? { transport: string(hub.transport, 20) } : {}) }] : []
  }) : []
  const daemonVersion = parseAglVersion(string(data.daemon_version))
  return {
    version: parseAglVersion(string(data.version)),
    running: data.running === true,
    ...(daemonVersion ? { daemonVersion } : {}),
    ...(count(data.pid) !== undefined ? { pid: count(data.pid) } : {}),
    ...(count(data.busy) !== undefined ? { busy: count(data.busy) } : {}),
    ...(typeof data.managed === 'boolean' ? { managed: data.managed } : {}),
    ...(string(data.machine_id, 64) ? { machineId: string(data.machine_id, 64) } : {}),
    service: data.service === true,
    hubs
  }
}

export function parseAglUpdate(stdout: string): AglUpdateJson {
  const data = json(stdout)
  return {
    current: parseAglVersion(string(data.current)), latest: parseAglVersion(string(data.latest)),
    updateAvailable: data.update_available === true, updated: data.updated === true,
    ...(count(data.busy) !== undefined ? { busy: count(data.busy) } : {})
  }
}

/** A hub URL in the form agl compares: no trailing slash, lower-case scheme and host. */
export function normalizeHubUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    // URL lower-cases the scheme and host and drops a default port; the path keeps its case.
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`
  } catch { return value.trim().replace(/\/+$/, '') }
}

/** The link to one of `hubUrls` (the Douchat service's agl hub), if this machine has one. */
export function douchatHubLink(status: Pick<AglStatusJson, 'hubs'>, hubUrls: string[]): AglHubLink | undefined {
  const wanted = new Set(hubUrls.map(normalizeHubUrl))
  return status.hubs.find(hub => wanted.has(normalizeHubUrl(hub.url)))
}
