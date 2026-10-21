/**
 * The owner-device signature format (remote-connections.md 6.8.4), shared by
 * the desktop, the web app and douchat-host. It must match douchat-tanstack
 * `signing.ts` byte for byte.
 */
export const OWNER_SIGNATURE_DOMAIN = 'douchat-owner-v1\n'
/** Signatures are valid for 10 minutes; the server and host accept at most 15. */
export const SIGNATURE_LIFETIME_MS = 10 * 60 * 1000
/** Thrown where an owner signature is needed but this session has no device key; the UI offers to sign in again. */
export const DEVICE_IDENTITY_REQUIRED = 'Sign in to Douchat again to register this device.'

/** Deterministic JSON: sorted keys, no whitespace, finite numbers only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid signed content.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  throw new Error('Invalid signed content.')
}

export interface OwnerEnvelope {
  v: 1
  origin: string
  ownerId: string
  hostId: string
  deviceId: string
  method: string
  requestId: string
  issuedAt: number
  expiresAt: number
  payloadHash: string
}
export interface SignedCommand<T = Record<string, unknown>> {
  envelope: OwnerEnvelope
  payload: T
  signature: string
}

export const ownerSignedBytes = (envelope: OwnerEnvelope): string => OWNER_SIGNATURE_DOMAIN + canonicalJson(envelope)
