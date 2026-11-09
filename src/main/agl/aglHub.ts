import type { AglDevice, AglDeviceAgent, AglPairing } from '../../shared/types'

/** agl's `{session_id, seq, ts, event: {kind, …}}`, as the service relays it. */
export interface AglEventEnvelope {
  session_id: string
  seq: number
  ts?: number
  event: { kind: string; [field: string]: unknown }
}

/** `agl-request` / `agl-response`: a result, an error, or still pending after `waitMs`. */
export type AglRequestReply = { id: string; result: unknown } | { id: string; error: string } | { id: string; pending: true }

/** Sends one desktop-facing action (`POST /api/desktop-auth/social`) as the signed-in account. */
export type AglTransport = <T>(body: { action: string; [field: string]: unknown }, signal?: AbortSignal) => Promise<T>

/** Longest the service holds a request or an event poll open (contract §2). */
export const AGL_WAIT_MS = 15_000

/** The methods the service forwards to a device (contract §2 allow-list). */
export type AglMethod = 'machine.info' | 'agents.list' | 'agents.models' | 'session.create' | 'session.get' | 'session.prompt'
  | 'session.approve' | 'session.abort' | 'session.history' | 'session.configure' | 'session.close'

const text = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, max) : ''

/** Everything from a device is untrusted: keep only well-formed, bounded fields. */
export function aglAgent(value: unknown): AglDeviceAgent | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const id = text(item.id, 64)
  if (!/^[A-Za-z0-9._+][A-Za-z0-9._+-]{0,63}$/.test(id)) return undefined
  const features = Array.isArray(item.features) ? item.features.map(feature => text(feature, 40)).filter(Boolean).slice(0, 32) : undefined
  const version = text(item.version, 120)
  const status = text(item.status, 40)
  return { id, name: text(item.name, 80) || id, available: item.available === true,
    ...(version ? { version } : {}), ...(features?.length ? { features } : {}), ...(status ? { status } : {}) }
}

export function aglDevice(value: unknown): AglDevice | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  const machineId = text(item.machineId, 64)
  if (!machineId) return undefined
  const time = (field: unknown) => typeof field === 'number' && Number.isFinite(field) ? field : null
  return {
    machineId, name: text(item.name, 80), hostname: text(item.hostname, 120), os: text(item.os, 40), arch: text(item.arch, 40), version: text(item.version, 40),
    online: item.online === true, lastSeenAt: time(item.lastSeenAt), pairedAt: time(item.pairedAt) ?? 0,
    agents: Array.isArray(item.agents) ? item.agents.map(aglAgent).filter((agent): agent is AglDeviceAgent => Boolean(agent)).slice(0, 64) : []
  }
}

/** The service's agl hub, seen from the desktop (contract §2). Never logs codes or tokens. */
export class AglHub {
  constructor(private readonly send: AglTransport) {}

  createPairing(signal?: AbortSignal): Promise<AglPairing> {
    return this.send<AglPairing>({ action: 'agl-pairing-create' }, signal)
  }

  async listDevices(signal?: AbortSignal): Promise<AglDevice[]> {
    const data = await this.send<{ devices?: unknown }>({ action: 'agl-device-list' }, signal)
    return Array.isArray(data?.devices) ? data.devices.map(aglDevice).filter((device): device is AglDevice => Boolean(device)) : []
  }

  async renameDevice(machineId: string, name: string, signal?: AbortSignal): Promise<AglDevice | undefined> {
    const data = await this.send<{ device?: unknown }>({ action: 'agl-device-rename', machineId, name }, signal)
    return aglDevice(data?.device)
  }

  async revokeDevice(machineId: string, signal?: AbortSignal): Promise<void> {
    await this.send({ action: 'agl-device-revoke', machineId }, signal)
  }

  /**
   * Runs one method on a device and waits for its answer: `agl-request`, then
   * `agl-response` while the device has not answered yet. An `error` from agl
   * becomes a thrown Error with agl's message.
   */
  async call<T = unknown>(machineId: string, method: AglMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let reply = await this.send<AglRequestReply>({ action: 'agl-request', machineId, method, params, waitMs: AGL_WAIT_MS }, signal)
    while (reply && 'pending' in reply && reply.pending) {
      signal?.throwIfAborted()
      reply = await this.send<AglRequestReply>({ action: 'agl-response', machineId, id: reply.id, waitMs: AGL_WAIT_MS }, signal)
    }
    if (!reply || typeof reply !== 'object') throw new Error('The device sent an invalid answer.')
    if ('error' in reply) throw new Error(typeof reply.error === 'string' && reply.error ? reply.error : 'The device refused the request.')
    return (reply as { result: T }).result
  }

  /** Events of one session after `afterSeq`; long-polls up to `waitMs` when there are none. */
  async events(machineId: string, sessionId: string, afterSeq: number, signal?: AbortSignal, waitMs = AGL_WAIT_MS): Promise<{ events: AglEventEnvelope[]; lastSeq: number }> {
    const data = await this.send<{ events?: unknown; lastSeq?: unknown }>({ action: 'agl-events', machineId, sessionId, afterSeq, waitMs }, signal)
    const events = Array.isArray(data?.events)
      ? data.events.filter((item): item is AglEventEnvelope => Boolean(item && typeof item === 'object' && typeof (item as AglEventEnvelope).seq === 'number'
          && (item as AglEventEnvelope).event && typeof (item as AglEventEnvelope).event.kind === 'string'))
      : []
    const highest = events.reduce((max, item) => Math.max(max, item.seq), afterSeq)
    const lastSeq = typeof data?.lastSeq === 'number' && Number.isFinite(data.lastSeq) ? Math.max(data.lastSeq, highest) : highest
    return { events, lastSeq }
  }

  /** `agents.list` on the device, sanitised. */
  async agents(machineId: string, signal?: AbortSignal): Promise<AglDeviceAgent[]> {
    const result = await this.call<unknown>(machineId, 'agents.list', {}, signal)
    return Array.isArray(result) ? result.map(aglAgent).filter((agent): agent is AglDeviceAgent => Boolean(agent)).slice(0, 64) : []
  }
}
