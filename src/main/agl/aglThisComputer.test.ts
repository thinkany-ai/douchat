import { expect, it, vi } from 'vitest'
import { DEFAULT_AGL_SETTINGS, type AglSettings, type AglStatusView } from '../../shared/agl'
import { LINK_RETRY_MS, linkDecision, ThisComputerLinker } from './aglThisComputer'

const view = (extra: Partial<AglStatusView> = {}): AglStatusView => ({ state: 'running', home: '/h', minimumVersion: '0.3.12', running: true, machineId: 'm-1', linked: false, update: {}, ...extra })
const on = { autoLink: true }

it('links only when enabled, signed in, running, identified and not linked yet', () => {
  expect(linkDecision({ settings: on, signedIn: true, view: view() })).toEqual({ action: 'link' })
  expect(linkDecision({ settings: { autoLink: false }, signedIn: true, view: view() })).toEqual({ action: 'none', reason: 'disabled' })
  expect(linkDecision({ settings: on, signedIn: false, view: view() })).toEqual({ action: 'none', reason: 'signed-out' })
  expect(linkDecision({ settings: on, signedIn: true, view: view({ state: 'needs-update' }) })).toEqual({ action: 'none', reason: 'not-running' })
  expect(linkDecision({ settings: on, signedIn: true, view: view({ machineId: undefined }) })).toEqual({ action: 'none', reason: 'no-machine' })
  // Linked, even if the link stopped working (removed from an account): not relinked behind the user's back.
  expect(linkDecision({ settings: on, signedIn: true, view: view({ linked: true, hubStatus: 'unauthorized' }) })).toEqual({ action: 'none', reason: 'linked' })
  expect(linkDecision({ settings: on, signedIn: true, view: view({ state: 'unsupported' }) })).toEqual({ action: 'none', reason: 'unsupported' })
})

function setup(extra: { settings?: AglSettings; account?: string; view?: AglStatusView } = {}) {
  let current = extra.view ?? view()
  let now = 1_000
  const lifecycle = {
    view: () => current,
    connectHub: vi.fn(async () => { current = { ...current, linked: true, hubStatus: 'connected' } }),
    setLinkError: vi.fn()
  }
  const createPairing = vi.fn(async () => ({ code: 'c0de', expiresAt: 0, installCommand: '', hubUrl: 'https://douchat.ai/agl' }))
  const linked = vi.fn()
  const linker = new ThisComputerLinker({ lifecycle, createPairing, settings: () => extra.settings ?? DEFAULT_AGL_SETTINGS, account: () => 'account' in extra ? extra.account : 'alice', linked, now: () => now })
  return { lifecycle, createPairing, linked, linker, advance: (ms: number) => { now += ms } }
}

it('mints a pairing code as the account and runs agl connect with the http transport', async () => {
  const { linker, lifecycle, createPairing, linked } = setup()
  expect(await linker.maybeLink()).toBe(true)
  expect(createPairing).toHaveBeenCalledTimes(1)
  expect(lifecycle.connectHub).toHaveBeenCalledWith('https://douchat.ai/agl', 'c0de')
  expect(linked).toHaveBeenCalled()
  // Linked now: nothing more to do.
  expect(await linker.maybeLink()).toBe(false)
  expect(createPairing).toHaveBeenCalledTimes(1)
})

it('does nothing when off or signed out, and retries a failure only after a while', async () => {
  expect(await setup({ settings: { ...DEFAULT_AGL_SETTINGS, autoLink: false } }).linker.maybeLink()).toBe(false)
  const signedOut = setup({ account: undefined })
  expect(await signedOut.linker.maybeLink()).toBe(false)
  expect(signedOut.createPairing).not.toHaveBeenCalled()

  const failing = setup()
  failing.lifecycle.connectHub.mockRejectedValueOnce(new Error('agl connect failed: 401'))
  expect(await failing.linker.maybeLink()).toBe(false)
  expect(failing.lifecycle.setLinkError).toHaveBeenLastCalledWith('agl connect failed: 401')
  expect(await failing.linker.maybeLink()).toBe(false)
  expect(failing.createPairing).toHaveBeenCalledTimes(1)
  failing.advance(LINK_RETRY_MS)
  expect(await failing.linker.maybeLink()).toBe(true)
  expect(failing.lifecycle.setLinkError).toHaveBeenLastCalledWith(undefined)
})

it('shares one attempt between concurrent calls', async () => {
  const { linker, createPairing } = setup()
  await Promise.all([linker.maybeLink(), linker.maybeLink(), linker.maybeLink()])
  expect(createPairing).toHaveBeenCalledTimes(1)
})
