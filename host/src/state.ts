import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Everything douchat-host keeps lives here, readable only by this user. */
export const HOST_HOME = process.env.DOUCHAT_HOST_HOME || join(homedir(), '.douchat-host')
const STATE_FILE = join(HOST_HOME, 'state.json')
/** The local trust anchor (remote-connections.md 6.8.4): never replaced from a server response alone. */
const TRUST_FILE = join(HOST_HOME, 'trust.json')
const SEEN_FILE = join(HOST_HOME, 'seen.json')
const CONFIG_FLOOR_FILE = join(HOST_HOME, 'agents-floor.json')

export interface HostState {
  v: 1
  serviceUrl: string
  hostId: string
  ownerId: string
  ownerName?: string
  hostToken: string
  tokenExpiresAt: number
  /** Ed25519 private key, PKCS#8 DER in base64url. */
  signKey: string
  /** Raw Ed25519 public key in base64url, as registered with the service. */
  signPublicKey: string
  enrolledAt: number
  /** 'service': it follows the Douchat service (the owner's session) instead of owner-device signatures. */
  trustMode?: 'owner' | 'service'
}

export interface TrustedDevice { deviceId: string; publicKey: string }
export interface TrustState { revision: number; devices: TrustedDevice[] }

export function ensureHome(): void {
  mkdirSync(HOST_HOME, { recursive: true, mode: 0o700 })
  chmodSync(HOST_HOME, 0o700)
}

function writePrivate(file: string, value: unknown): void {
  ensureHome()
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, file)
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

export const loadState = (): HostState | undefined => readJson<HostState>(STATE_FILE)
export const saveState = (state: HostState): void => writePrivate(STATE_FILE, state)
export const loadTrust = (): TrustState | undefined => readJson<TrustState>(TRUST_FILE)
export const saveTrust = (trust: TrustState): void => writePrivate(TRUST_FILE, trust)
/** Signing time of the newest owner-signed agent configuration applied (executor.ts). */
export const configFloor = {
  load: (): number => Number(readJson<{ issuedAt?: number }>(CONFIG_FLOOR_FILE)?.issuedAt) || 0,
  save: (issuedAt: number): void => writePrivate(CONFIG_FLOOR_FILE, { issuedAt })
}

/** Accepted owner requestIds with their expiry, so a signed open runs at most once, even across restarts. */
export class SeenRequests {
  private readonly seen = new Map<string, number>(Object.entries(readJson<Record<string, number>>(SEEN_FILE) ?? {}))

  has(requestId: string): boolean { return this.seen.has(requestId) }

  add(requestId: string, expiresAt: number): void {
    const now = Date.now()
    for (const [id, expiry] of this.seen) if (expiry < now) this.seen.delete(id)
    this.seen.set(requestId, expiresAt)
    writePrivate(SEEN_FILE, Object.fromEntries(this.seen))
  }
}

export function purgeHome(): void {
  rmSync(HOST_HOME, { recursive: true, force: true })
}
