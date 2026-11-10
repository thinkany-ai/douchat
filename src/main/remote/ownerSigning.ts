import { createHash, randomUUID } from 'node:crypto'

/**
 * Owner-device signatures (remote-connections.md 6.8.4). The encoding must
 * match douchat-tanstack `signing.ts` and douchat-host byte for byte: the
 * server checks it for normal authorization and the host verifies it again
 * against its local trust anchor before applying anything.
 */
export { canonicalJson, ownerSignedBytes, OWNER_SIGNATURE_DOMAIN, SIGNATURE_LIFETIME_MS, type OwnerEnvelope, type SignedCommand } from '../../shared/ownerSignature'
import { canonicalJson, DEVICE_IDENTITY_REQUIRED, ownerSignedBytes, SIGNATURE_LIFETIME_MS, type OwnerEnvelope, type SignedCommand } from '../../shared/ownerSignature'

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** What signing needs from DesktopAuth; the private key never leaves it. */
export interface OwnerSigner {
  getDeviceId(): string | undefined
  signAsDevice(message: string): string
}

/** Signs one owner command for one host (or '' for a desktop executor). */
export function signCommand<T extends Record<string, unknown>>(signer: OwnerSigner, input: { serviceUrl: string; ownerId: string; hostId: string; method: string; payload: T; now?: number }): SignedCommand<T> {
  const deviceId = signer.getDeviceId()
  if (!deviceId) throw new Error(DEVICE_IDENTITY_REQUIRED)
  // Round-trip so the signed payload is exactly what will be serialized.
  const payload = JSON.parse(JSON.stringify(input.payload)) as T
  const issuedAt = input.now ?? Date.now()
  const envelope: OwnerEnvelope = {
    v: 1,
    origin: new URL(input.serviceUrl).origin,
    ownerId: input.ownerId,
    hostId: input.hostId,
    deviceId,
    method: input.method,
    requestId: randomUUID(),
    issuedAt,
    expiresAt: issuedAt + SIGNATURE_LIFETIME_MS,
    payloadHash: sha256Hex(canonicalJson(payload))
  }
  return { envelope, payload, signature: signer.signAsDevice(ownerSignedBytes(envelope)) }
}
