import type { DesktopAuth } from '../desktopAuth'

/** The signed-in account and its desktop token. */
export type SocialIdentity = { id: string; token: string }
export type SocialAuth = Pick<DesktopAuth, 'getState' | 'getAccessToken' | 'invalidateSession'>

export function socialIdentity(auth: SocialAuth): SocialIdentity {
  const state = auth.getState()
  const token = auth.getAccessToken()
  if (state.status !== 'signed-in' || !token) throw new Error('Sign in first.')
  return { id: state.user.id, token }
}

/**
 * One `POST /api/desktop-auth/social` call with the desktop bearer token: the
 * convention for every desktop-facing action (`{action, …}` → `{code, message, data}`).
 * A reply that arrives after the account changed is refused rather than applied.
 */
export async function socialRequest<T>(url: string, auth: SocialAuth, body: object, signal?: AbortSignal, identity = socialIdentity(auth), timeoutMs = 25_000): Promise<T> {
  const response = await fetch(new URL('/api/desktop-auth/social', url), {
    method: 'POST',
    headers: { Authorization: `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  })
  const current = socialIdentity(auth)
  if (current.id !== identity.id || current.token !== identity.token) throw new Error('The account changed. Try again.')
  if (response.status === 401) { await auth.invalidateSession(); throw new Error('Your session expired. Sign in again.') }
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.data === undefined) throw new Error(payload?.message || 'The Douchat service could not be reached. Try again later.')
  return payload.data as T
}
