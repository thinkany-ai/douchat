import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { RemoteAgentSpec } from '../../shared/types'
import type { SignedCommand } from './ownerSigning'
import { recordTiming, timedRemote } from '../diagnostics'

/**
 * Desktop half of the douchat-host relay (douchat-tanstack relay.ts). A relay
 * stream stands in for one `/usr/bin/ssh` process: "exec" runs one Douchat
 * remote script with its stdio forwarded, "listen" exposes a UNIX socket on
 * the server whose connections come back here. Everything else, prompts,
 * memory, approvals and replies, stays exactly as with SSH.
 */

export interface RelayBackend {
  /** POST /api/desktop-auth/social as the signed-in account. */
  request<T>(body: object, signal?: AbortSignal): Promise<T>
  sign<T extends Record<string, unknown>>(hostId: string, method: string, payload: T, serviceUrl: string): SignedCommand<T>
  ownerId(): string | undefined
}

let backend: RelayBackend | undefined
export function configureDaemonRelay(value: RelayBackend | undefined): void {
  backend = value
  if (!value) hub?.failAll(new Error('Signed out of Douchat.'))
}

type Daemon = NonNullable<RemoteAgentSpec['daemon']>
export interface RelayFrame { type: string; data?: Buffer; extra?: Record<string, unknown> }
interface WireFrame { streamId: string; seq: number; type: string; data?: string; extra?: unknown }
interface RecvResult { frames: WireFrame[]; streams: Record<string, { state: 'new' | 'open' | 'closed' | 'gone'; hostOnline: boolean }> }

/** Same as VIRTUAL_PROCESS in localAgentConnection.ts (kept import-free). */
const VIRTUAL_PROCESS = Symbol.for('douchat.virtualProcess')
const MAX_BATCH_FRAMES = 64
const MAX_BATCH_BYTES = 6 * 1024 * 1024
const MAX_FRAME_BYTES = 1024 * 1024
/** A stream nobody claimed in this long is treated like an ssh connect timeout. */
const CLAIM_TIMEOUT_MS = 30_000
/** An open stream whose host stayed offline this long is treated like a dropped ssh connection. */
const OFFLINE_TIMEOUT_MS = 60_000
const SERVICE_TIMEOUT_MS = 60_000
const BACKOFF = [250, 1_000, 3_000, 10_000]

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export class RelayStream extends EventEmitter {
  lastSeq = 0
  ended = false
  private sendSeq = 0
  private queue: { type: string; data?: Buffer }[] = []
  private sending = false
  private pumpScheduled = false
  private batch?: { seq: number; type: string; data?: Buffer }[]
  /** The kill still goes out after the stream ended here. */
  private flushAfterEnd = false
  readonly openedAt = Date.now()
  offlineSince?: number
  closedRounds = 0
  private firstOutput = false

  constructor(private readonly hub: RelayHub, readonly id: string, readonly hostLabel: string) { super() }

  send(type: 'in' | 'eof' | 'kill', data?: Buffer): void {
    if (this.ended) return
    const last = this.queue[this.queue.length - 1]
    if (type === 'in' && data && last?.type === 'in' && last.data && last.data.length + data.length <= MAX_FRAME_BYTES) last.data = Buffer.concat([last.data, data])
    else this.queue.push({ type, data })
    // Writes made in the same tick (a protocol message, then EOF) go out as one send.
    if (!this.pumpScheduled) {
      this.pumpScheduled = true
      queueMicrotask(() => {
        this.pumpScheduled = false
        void this.pump()
      })
    }
  }

  /** Ends the stream here; the host is told to stop unless it already finished. */
  close(): void {
    if (this.ended) return
    this.queue = [{ type: 'kill' }]
    this.flushAfterEnd = true
    this.finish()
    void this.pump()
  }

  /** Delivers one frame from the host; the terminal ones end the stream. */
  deliver(frame: RelayFrame): void {
    if (this.ended) return
    if (!this.firstOutput && (frame.type === 'out' || frame.type === 'err')) {
      this.firstOutput = true
      recordTiming('relay.first-output', this.openedAt, { streamId: this.id })
    }
    if (frame.type === 'exit' || frame.type === 'error') recordTiming('relay.stream-complete', this.openedAt, {
      streamId: this.id, outcome: frame.type, code: frame.extra?.code, signal: frame.extra?.signal
    })
    this.emit('frame', frame)
    if (frame.type === 'exit' || frame.type === 'error') this.finish()
  }

  fail(error: Error): void {
    if (this.ended) return
    this.deliver({ type: 'error', extra: { message: error.message } })
    this.queue = [{ type: 'kill' }]
    this.flushAfterEnd = true
    void this.pump()
  }

  private finish(): void {
    this.ended = true
    this.hub.forget(this)
  }

  /** One send in flight, so the host applies frames in order. */
  private async pump(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      let failures = 0
      while ((!this.ended || this.flushAfterEnd) && (this.batch || this.queue.length)) {
        if (!this.batch) {
          const frames: { seq: number; type: string; data?: Buffer }[] = []
          let bytes = 0
          while (this.queue.length && frames.length < MAX_BATCH_FRAMES) {
            const next = this.queue[0]
            const size = next.data?.length ?? 0
            if (frames.length && bytes + size > MAX_BATCH_BYTES) break
            this.queue.shift()
            if (next.data && size > MAX_FRAME_BYTES) {
              this.queue.unshift({ type: next.type, data: next.data.subarray(MAX_FRAME_BYTES) })
              frames.push({ seq: ++this.sendSeq, type: next.type, data: next.data.subarray(0, MAX_FRAME_BYTES) })
              bytes += MAX_FRAME_BYTES
            } else {
              frames.push({ seq: ++this.sendSeq, ...next })
              bytes += size
            }
          }
          this.batch = frames
        }
        try {
          const result = await this.hub.call<{ closed?: boolean }>({ action: 'relay-send', streamId: this.id,
            frames: this.batch.map(frame => ({ seq: frame.seq, type: frame.type, ...(frame.data?.length ? { data: frame.data.toString('base64') } : {}) })) })
          this.batch = undefined
          failures = 0
          if (result?.closed) { this.queue = []; break }
        } catch (error) {
          // A slow host makes the service refuse more frames for a moment; anything else ends the stream.
          if (/对端处理较慢|fetch failed|timed out|aborted|ECONN|could not be reached/i.test(errorText(error)) && failures < 40) {
            recordTiming('relay.send-retry', Date.now(), { streamId: this.id, retry: failures + 1, backoffMs: BACKOFF[Math.min(failures, BACKOFF.length - 1)] })
            await sleep(BACKOFF[Math.min(failures++, BACKOFF.length - 1)])
            continue
          }
          this.batch = undefined
          this.queue = []
          if (!this.ended) this.deliver({ type: 'error', extra: { message: `douchat-host relay failed: ${errorText(error)}` } })
          break
        }
      }
    } finally {
      this.sending = false
    }
    if ((!this.ended || this.flushAfterEnd) && this.queue.length) void this.pump()
  }
}

/** One receive loop for every open stream of this desktop. */
class RelayHub {
  private readonly streams = new Map<string, RelayStream>()
  private running = false
  private poll?: AbortController

  call<T>(body: object, signal?: AbortSignal): Promise<T> {
    if (!backend) throw new Error('Sign in to Douchat to use douchat-host connections.')
    const request = body as { action?: string; streamId?: string }
    // The long poll waits by design; its length says nothing about latency.
    if (request.action === 'relay-recv') return backend.request<T>(body, signal)
    return timedRemote(`relay.${request.action}`, { streamId: request.streamId }, () => backend!.request<T>(body, signal))
  }

  async open(spec: RemoteAgentSpec, payload: { kind: 'exec'; script: string } | { kind: 'listen'; socketPath: string }, signal?: AbortSignal): Promise<RelayStream> {
    const daemon = daemonOf(spec)
    if (!backend) throw new Error('Sign in to Douchat to use douchat-host connections.')
    const owner = backend.ownerId()
    if (owner !== daemon.ownerId) throw new Error('This host was added with another Douchat account. Sign in with that account to use it, or delete it and add it again.')
    signal?.throwIfAborted()
    const streamId = randomUUID()
    const signed = backend.sign(daemon.hostId, 'relay.open', { streamId, ...payload }, daemon.serviceUrl)
    await this.call({ action: 'relay-open', hostId: daemon.hostId, signed }, signal)
    const stream = new RelayStream(this, streamId, spec.host)
    this.streams.set(streamId, stream)
    this.kick()
    return stream
  }

  /** A bridge connection the host accepted on a listen stream. */
  adopt(streamId: string, hostLabel: string): RelayStream {
    const stream = new RelayStream(this, streamId, hostLabel)
    this.streams.set(streamId, stream)
    this.kick()
    return stream
  }

  forget(stream: RelayStream): void {
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id)
  }

  failAll(error: Error): void {
    for (const stream of [...this.streams.values()]) stream.fail(error)
  }

  /** Restart the long poll so it watches newly opened streams. */
  private kick(): void {
    if (this.running) this.poll?.abort()
    else void this.loop()
  }

  private async loop(): Promise<void> {
    this.running = true
    let failures = 0
    let failingSince: number | undefined
    try {
      while (this.streams.size) {
        const watch = Object.fromEntries([...this.streams.values()].slice(0, 64).map(stream => [stream.id, stream.lastSeq]))
        const poll = new AbortController()
        this.poll = poll
        let result: RecvResult
        try {
          result = await this.call<RecvResult>({ action: 'relay-recv', streams: watch, wait: true }, poll.signal)
          failures = 0
          failingSince = undefined
        } catch (error) {
          if (poll.signal.aborted) continue
          recordTiming('relay.recv-retry', Date.now(), { retry: failures + 1, backoffMs: BACKOFF[Math.min(failures, BACKOFF.length - 1)] })
          failingSince ??= Date.now()
          if (Date.now() - failingSince > SERVICE_TIMEOUT_MS || !backend) {
            this.failAll(new Error(`Lost the connection to the Douchat service: ${errorText(error)}`))
            failingSince = undefined
          }
          await sleep(BACKOFF[Math.min(failures++, BACKOFF.length - 1)])
          continue
        } finally {
          if (this.poll === poll) this.poll = undefined
        }
        this.handle(result, new Set(Object.keys(watch)))
      }
    } finally {
      this.running = false
      this.poll = undefined
    }
  }

  private handle(result: RecvResult, watched: Set<string>): void {
    const delivered = new Set<string>()
    for (const frame of Array.isArray(result.frames) ? result.frames : []) {
      const stream = this.streams.get(frame.streamId)
      if (!stream || !Number.isSafeInteger(frame.seq) || frame.seq <= stream.lastSeq) continue
      stream.lastSeq = frame.seq
      delivered.add(stream.id)
      stream.deliver({ type: frame.type, ...(frame.data ? { data: Buffer.from(frame.data, 'base64') } : {}),
        ...(frame.extra && typeof frame.extra === 'object' ? { extra: frame.extra as Record<string, unknown> } : {}) })
    }
    const now = Date.now()
    for (const id of watched) {
      const stream = this.streams.get(id)
      const status = result.streams?.[id]
      if (!stream || stream.ended || !status) continue
      if (status.state === 'gone') { stream.fail(new Error(`douchat-host on ${stream.hostLabel} dropped the session.`)); continue }
      if (status.state === 'closed') {
        // The final frames are written before the stream is marked closed; give them one more round.
        if (!delivered.has(id) && ++stream.closedRounds >= 2) stream.fail(new Error(`douchat-host on ${stream.hostLabel} ended the session.`))
        continue
      }
      stream.closedRounds = 0
      if (status.state === 'new') {
        if (!status.hostOnline) stream.fail(new Error(`douchat-host on ${stream.hostLabel} is offline. Check that its service is running on the server.`))
        else if (now - stream.openedAt > CLAIM_TIMEOUT_MS) stream.fail(new Error(`douchat-host on ${stream.hostLabel} did not respond in time.`))
        continue
      }
      if (status.hostOnline) stream.offlineSince = undefined
      else if ((stream.offlineSince ??= now) && now - stream.offlineSince > OFFLINE_TIMEOUT_MS) stream.fail(new Error(`Lost the connection to douchat-host on ${stream.hostLabel}.`))
    }
  }
}

let hub: RelayHub | undefined
function relayHub(): RelayHub { return hub ??= new RelayHub() }

export function daemonOf(spec: RemoteAgentSpec): Daemon {
  if (spec.transport !== 'daemon' || !spec.daemon) throw new Error('This is not a douchat-host connection.')
  return spec.daemon
}

export function openRelayStream(spec: RemoteAgentSpec, payload: { kind: 'exec'; script: string } | { kind: 'listen'; socketPath: string }, signal?: AbortSignal): Promise<RelayStream> {
  return relayHub().open(spec, payload, signal)
}
export function adoptRelayStream(streamId: string, hostLabel: string): RelayStream {
  return relayHub().adopt(streamId, hostLabel)
}

/**
 * A remote script as a child process, so every caller that handles the local
 * ssh process works unchanged. Like killing ssh, kill() ends it here at once
 * and tells the host to stop the remote process group.
 */
export class RelayProcess extends EventEmitter {
  readonly [VIRTUAL_PROCESS] = true
  readonly pid = undefined
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  private done = false

  constructor(private readonly stream: RelayStream) {
    super()
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, callback) => { stream.send('in', Buffer.from(chunk)); callback() },
      final: callback => { stream.send('eof'); callback() }
    })
    stream.on('frame', (frame: RelayFrame) => {
      if (frame.type === 'out' && frame.data) this.stdout.write(frame.data)
      else if (frame.type === 'err' && frame.data) this.stderr.write(frame.data)
      else if (frame.type === 'exit') {
        const code = typeof frame.extra?.code === 'number' ? frame.extra.code : null
        const signal = typeof frame.extra?.signal === 'string' ? frame.extra.signal as NodeJS.Signals : null
        if (signal) this.stderr.write(`Remote process was terminated by ${signal}.\n`)
        // A remote process killed by a signal looks like ssh's exit status 255.
        this.end(code ?? (signal ? 255 : null), null)
      } else if (frame.type === 'error') {
        this.stderr.write(`${String(frame.extra?.message ?? 'douchat-host failed').slice(0, 2000)}\n`)
        this.end(255, null)
      }
    })
    queueMicrotask(() => this.emit('spawn'))
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.done) return false
    this.killed = true
    this.stream.close()
    this.end(null, typeof signal === 'string' ? signal : 'SIGKILL')
    return true
  }

  private end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.done) return
    this.done = true
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    if (!this.stdin.destroyed) this.stdin.destroy()
    this.emit('exit', code, signal)
    // 'close' follows once stdio is flushed, as for a real process.
    let pending = 2
    const closed = () => { if (--pending === 0) this.emit('close', code, signal) }
    for (const pipe of [this.stdout, this.stderr]) {
      if (pipe.readableEnded || pipe.destroyed) closed()
      else { pipe.once('end', closed); pipe.once('close', () => { if (!pipe.readableEnded) closed() }) }
      // Nobody reading must not keep 'close' from firing.
      if (pipe.listenerCount('data') === 0 && !pipe.readableFlowing) pipe.resume()
    }
  }
}

/** Starts one remote script; resolves once the service accepted the stream. */
export async function relaySpawn(spec: RemoteAgentSpec, script: string, signal?: AbortSignal): Promise<ChildProcessWithoutNullStreams> {
  const payload = Buffer.from(script, 'utf8').toString('base64')
  if (payload.length > 512 * 1024) throw new Error('The remote script is too large for douchat-host.')
  const stream = await openRelayStream(spec, { kind: 'exec', script: payload }, signal)
  return new RelayProcess(stream) as unknown as ChildProcessWithoutNullStreams
}
