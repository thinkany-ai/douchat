import type { LocalModel } from '../../shared/localModels'
import type { LocalAgent } from '../../shared/types'
import type { AgentInfo } from './aglClient'
import type { AglDaemonConnection } from './aglLifecycle'

/** Desktop catalog ids agl also supports, under the same id. FastClaw and custom agents stay with the desktop. */
export const AGL_DETECTED_AGENTS = ['claude', 'codex', 'gemini', 'grok', 'openclaw', 'hermes', 'opencode', 'cursor', 'kimi', 'omp'] as const

const DETECT_TTL_MS = 5 * 60_000
const CALL_TIMEOUT_MS = 20_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('agl did not answer in time')), ms) })]).finally(() => clearTimeout(timer))
}

const text = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.trim().replace(/[\0-\x1f\x7f]/g, '').slice(0, max) : undefined

/**
 * A catalog agent as agl detects it: path, version, desktop app and status
 * from `agents.list` instead of the desktop's own PATH lookup and `--version`.
 */
export function localAgentFromAgl(base: Pick<LocalAgent, 'id' | 'name' | 'command'> & Partial<Pick<LocalAgent, 'args' | 'avatar' | 'custom'>>, info: AgentInfo): LocalAgent {
  const path = info.available ? text(info.path, 4096) : undefined
  const desktopPath = text(info.desktop_app, 4096)
  const status: LocalAgent['status'] = path ? 'ready' : info.status === 'desktop-only' || desktopPath ? 'desktop-only' : 'not-found'
  const version = path ? text(info.version, 160) : undefined
  return {
    id: base.id, name: base.name, command: base.command, args: base.args, avatar: base.avatar,
    installed: Boolean(path), discovered: Boolean(path || desktopPath), path, desktopPath, version,
    chatSupported: true, status, authentication: 'unchecked', custom: base.custom
  }
}

/** Valid model ids the desktop runtime can pass on (the same rules as `localModelId`). */
function model(value: unknown): LocalModel | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const id = text(item.id, 256)
  if (!id || id.startsWith('-') || /[\r\n\0]/.test(id)) return undefined
  return { id, name: text(item.name, 120) ?? id }
}

/**
 * Agent detection and model lists through the local agl daemon, for the
 * experimental "Use agl for local agents" setting. `undefined` means agl
 * cannot answer right now (not running, too old, an error): the desktop then
 * uses its own probes, so agents never disappear because agl is down.
 */
export class AglAgentCatalog {
  private cache?: { at: number; agents: AgentInfo[] }
  private pending?: Promise<AgentInfo[] | undefined>
  constructor(private readonly client: () => Pick<AglDaemonConnection, 'call'> | undefined, private readonly now: () => number = Date.now) {}

  /** Forget the last list (after "Detect", or a CLI was installed). */
  invalidate(): void { this.cache = undefined }

  agents(): Promise<AgentInfo[] | undefined> {
    if (this.cache && this.now() - this.cache.at < DETECT_TTL_MS) return Promise.resolve(this.cache.agents)
    const client = this.client()
    if (!client) return Promise.resolve(undefined)
    this.pending ??= withTimeout(client.call<unknown>('agents.list', { check_updates: false }), CALL_TIMEOUT_MS).then((list) => {
      if (!Array.isArray(list)) return undefined
      const agents = list.filter((item): item is AgentInfo => Boolean(item && typeof item === 'object' && typeof (item as AgentInfo).id === 'string'))
      this.cache = { at: this.now(), agents }
      return agents
    }, () => undefined).finally(() => { this.pending = undefined })
    return this.pending
  }

  /** agl's `agents.models` for an agent it lists with the `models` feature; undefined otherwise. */
  async models(agentId: string): Promise<LocalModel[] | undefined> {
    const client = this.client()
    if (!client || !(AGL_DETECTED_AGENTS as readonly string[]).includes(agentId)) return undefined
    const info = (await this.agents())?.find(item => item.id === agentId)
    if (!info?.available || !info.features?.includes('models')) return undefined
    const result = await withTimeout(client.call<{ models?: unknown }>('agents.models', { agent: agentId }), CALL_TIMEOUT_MS).catch(() => undefined)
    if (!result || !Array.isArray(result.models)) return undefined
    const models = result.models.map(model).filter((item): item is LocalModel => Boolean(item))
    // The first entry for an id wins.
    return models.filter((item, index) => models.findIndex(other => other.id === item.id) === index)
  }
}
