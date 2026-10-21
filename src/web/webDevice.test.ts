import { createPublicKey, verify } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { verifyOwnerCommand } from '../../host/src/verify'
import { deviceFingerprint as desktopFingerprint } from '../main/remote/daemonClient'
import { activeDevice, loginProofs, signOwnerCommand } from './webDevice'

/** Just enough IndexedDB for the key store: one object store keyed by id. */
function memoryIndexedDb() {
  const rows = new Map<string, unknown>()
  const request = <T>(result: () => T) => {
    const value: { result?: T; onsuccess?: () => void; onerror?: () => void; error?: unknown; onupgradeneeded?: () => void } = {}
    queueMicrotask(() => { value.result = result(); value.onupgradeneeded?.(); value.onsuccess?.() })
    return value
  }
  const store = {
    getAll: () => request(() => [...rows.values()]),
    put: (row: { id: string }) => request(() => { rows.set(row.id, row); return row.id })
  }
  const db = { createObjectStore: () => store, transaction: () => ({ objectStore: () => store }), close: () => undefined }
  return { open: () => request(() => db) }
}

beforeEach(() => {
  Object.assign(globalThis, { indexedDB: memoryIndexedDb(), isSecureContext: true })
  const values = new Map<string, string>()
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } })
})

describe('web device key', () => {
  it('proves key possession at sign-in the way the service checks it', async () => {
    const login = await loginProofs('code-123')
    expect(login?.proofs).toHaveLength(1)
    const proof = login!.proofs[0]
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: proof.publicKey }, format: 'jwk' })
    expect(verify(null, Buffer.from('douchat-device-v1\ncode-123'), key, Buffer.from(proof.signature, 'base64url'))).toBe(true)
    await login!.adopt(proof.id)
    const device = await activeDevice()
    expect(device?.id).toBe(proof.id)
    // The desktop shows the same code before trusting this browser.
    expect(device?.fingerprint).toBe(desktopFingerprint(proof.publicKey))
  })

  it('signs owner commands a douchat-host accepts', async () => {
    const login = await loginProofs('code-1')
    const proof = login!.proofs[0]
    await login!.adopt(proof.id)
    const signed = await signOwnerCommand({ origin: 'https://douchat.test/app', ownerId: 'owner', hostId: 'hst_1', method: 'task.approval', payload: { approvalId: 'a', decision: 'allow' } })
    const trust = { revision: 1, devices: [{ deviceId: proof.id, publicKey: proof.publicKey }] }
    expect(verifyOwnerCommand(signed, { origin: 'https://douchat.test', ownerId: 'owner', hostId: 'hst_1', method: 'task.approval', trust }).payload).toEqual({ approvalId: 'a', decision: 'allow' })
    expect(() => verifyOwnerCommand({ ...signed, payload: { approvalId: 'a', decision: 'deny' } }, { origin: 'https://douchat.test', ownerId: 'owner', hostId: 'hst_1', method: 'task.approval', trust })).toThrow(/does not match/)
  })

  it('refuses to sign without a device bound at sign-in', async () => {
    await expect(signOwnerCommand({ origin: 'https://douchat.test', ownerId: 'o', hostId: 'h', method: 'task.cancel', payload: {} })).rejects.toThrow(/Sign in again/)
  })
})
