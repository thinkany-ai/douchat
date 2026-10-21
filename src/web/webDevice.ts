import { canonicalJson, ownerSignedBytes, SIGNATURE_LIFETIME_MS, type OwnerEnvelope, type SignedCommand } from '../shared/ownerSignature'

/**
 * This browser's owner-device key, the web counterpart of the desktop's
 * deviceIdentity.ts. It is an Ed25519 key made by WebCrypto with a private
 * half that cannot be exported, kept in IndexedDB. The service binds it to the
 * account at sign-in (the same proof a desktop sends), and once a trusted
 * desktop adds it to a douchat-host's device list, this browser can sign
 * approvals and cancels for that host's agents.
 */

const DB_NAME = 'douchat-web-device'
const STORE = 'keys'
const ACTIVE_KEY = 'douchat.web.device'
const DEVICE_LOGIN_DOMAIN = 'douchat-device-v1\n'
/** As on the desktop: one key per account signed in here, plus the spare offered at sign-in. */
const MAX_KEYS = 7

interface StoredKey { id: string; publicKey: string; privateKey: CryptoKey; createdAt: number }
export interface DeviceProof { id: string; publicKey: string; signature: string }

const base64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** Ed25519 in WebCrypto needs a secure context and a current browser. */
export function webDeviceSupported(): boolean {
  return Boolean(globalThis.isSecureContext && globalThis.crypto?.subtle && globalThis.indexedDB)
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE, { keyPath: 'id' }) }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally { db.close() }
}
const storedKeys = () => transact<StoredKey[]>('readonly', store => store.getAll() as IDBRequest<StoredKey[]>)

async function generate(): Promise<StoredKey> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  return { id: `dev_${crypto.randomUUID()}`, publicKey, privateKey: pair.privateKey, createdAt: Date.now() }
}
async function signWith(key: CryptoKey, message: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(message))))
}

/**
 * Sign-in proofs for every key kept here plus one new spare, so a new account
 * gets its own key and a known one gets its old one back. `adopt` keeps the
 * key the service bound and makes it this browser's active device.
 */
export async function loginProofs(code: string): Promise<{ proofs: DeviceProof[]; adopt(deviceId: string | undefined): Promise<void> } | undefined> {
  if (!webDeviceSupported()) return undefined
  try {
    const kept = (await storedKeys()).sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_KEYS - 1)
    const spare = await generate()
    const keys = [...kept, spare]
    const proofs = await Promise.all(keys.map(async key => ({ id: key.id, publicKey: key.publicKey, signature: await signWith(key.privateKey, DEVICE_LOGIN_DOMAIN + code) })))
    return {
      proofs,
      async adopt(deviceId) {
        if (!deviceId || !keys.some(key => key.id === deviceId)) { localStorage.removeItem(ACTIVE_KEY); return }
        if (deviceId === spare.id) await transact('readwrite', store => store.put(spare))
        localStorage.setItem(ACTIVE_KEY, deviceId)
      }
    }
  } catch {
    // Ed25519 unsupported here: sign in without a device; approvals stay on the desktop.
    return undefined
  }
}

export function forgetActiveDevice(): void { try { localStorage.removeItem(ACTIVE_KEY) } catch { /* Private mode. */ } }

async function activeKey(): Promise<StoredKey | undefined> {
  const id = (() => { try { return localStorage.getItem(ACTIVE_KEY) } catch { return null } })()
  if (!id || !webDeviceSupported()) return undefined
  return (await storedKeys().catch(() => [])).find(key => key.id === id)
}

/** This browser's device id and the fingerprint a desktop shows before trusting it. */
export async function activeDevice(): Promise<{ id: string; fingerprint: string } | undefined> {
  const key = await activeKey()
  return key ? { id: key.id, fingerprint: await deviceFingerprint(key.publicKey) } : undefined
}

/** Same short fingerprint as the desktop's deviceFingerprint (daemonClient.ts). */
export async function deviceFingerprint(publicKey: string): Promise<string> {
  const raw = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))).slice(0, 16)
  return digest.match(/.{4}/g)!.join('-')
}

/** Signs one owner command for one host, exactly as the desktop's signCommand does. */
export async function signOwnerCommand<T extends Record<string, unknown>>(input: { origin: string; ownerId: string; hostId: string; method: string; payload: T }): Promise<SignedCommand<T>> {
  const key = await activeKey()
  if (!key) throw new Error('Sign in again in this browser to approve requests here, or answer them in the desktop app.')
  const payload = JSON.parse(JSON.stringify(input.payload)) as T
  const issuedAt = Date.now()
  const envelope: OwnerEnvelope = {
    v: 1, origin: new URL(input.origin).origin, ownerId: input.ownerId, hostId: input.hostId, deviceId: key.id, method: input.method,
    requestId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + SIGNATURE_LIFETIME_MS,
    payloadHash: hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(payload)))))
  }
  return { envelope, payload, signature: await signWith(key.privateKey, ownerSignedBytes(envelope)) }
}
