import { expect, it, vi } from 'vitest'
import { DEFAULT_AGL_SETTINGS, type AglSettings, type AglStatusView } from '../../shared/agl'
import type { AglHubLink } from './aglStatus'
import { LINK_RETRY_MS, linkDecision, linkOwner, ThisComputerLinker } from './aglThisComputer'

const view = (extra: Partial<AglStatusView> = {}): AglStatusView => ({ state: 'running', home: '/h', minimumVersion: '0.3.12', running: true, machineId: 'm-1', linked: false, update: {}, ...extra })
const on = { autoLink: true }
const HUB = 'https://douchat.ai/agl'

it('links only when turned on, enabled, signed in, running, identified and not linked yet', () => {
  expect(linkDecision({ settings: on, signedIn: true, view: view() })).toEqual({ action: 'link' })
  expect(linkDecision({ settings: on, signedIn: true, view: view({ state: 'off' }) })).toEqual({ action: 'none', reason: 'off' })
  expect(linkDecision({ settings: { autoLink: false }, signedIn: true, view: view() })).toEqual({ action: 'none', reason: 'disabled' })
  expect(linkDecision({ settings: on, signedIn: false, view: view() })).toEqual({ action: 'none', reason: 'signed-out' })
  expect(linkDecision({ settings: on, signedIn: true, view: view({ state: 'needs-update' }) })).toEqual({ action: 'none', reason: 'not-running' })
  expect(linkDecision({ settings: on, signedIn: true, view: view({ machineId: undefined }) })).toEqual({ action: 'none', reason: 'no-machine' })
  // Linked, even if the link stopped working (removed from an account): not relinked behind the user's back.
  expect(linkDecision({ settings: on, signedIn: true, view: view({ linked: true, hubStatus: 'unauthorized' }) })).toEqual({ action: 'none', reason: 'linked' })
  expect(linkDecision({ settings: on, signedIn: true, view: view({ state: 'unsupported' }) })).toEqual({ action: 'none', reason: 'unsupported' })
})

it('tells whose link it is from the recorded account, else from the account’s device list', () => {
  const connected = { status: 'connected' }
  expect(linkOwner({ recorded: 'alice', account: 'alice', link: connected })).toBe('this-account')
  expect(linkOwner({ recorded: 'alice', account: 'bob', link: { status: 'unauthorized' } })).toBe('other-account')
  expect(linkOwner({ account: 'bob', link: connected, listed: true })).toBe('this-account')
  expect(linkOwner({ account: 'bob', link: connected, listed: false })).toBe('other-account')
  // A revoked link is listed nowhere: whose it was cannot be told that way.
  expect(linkOwner({ account: 'bob', link: { status: 'unauthorized' }, listed: false })).toBe('unknown')
  expect(linkOwner({ account: 'bob', link: connected })).toBe('unknown')
})

function setup(extra: { settings?: AglSettings; account?: string; view?: AglStatusView; link?: AglHubLink; recorded?: string; listed?: boolean } = {}) {
  let current = extra.view ?? view(extra.link ? { linked: true, hubStatus: extra.link.status } : {})
  let link = extra.link
  let recorded = extra.recorded
  let account = 'account' in extra ? extra.account : 'alice'
  let now = 1_000
  const lifecycle = {
    view: () => current,
    douchatLink: () => link,
    connectHub: vi.fn(async (url: string) => { link = { url, status: 'connected' }; current = { ...current, linked: true, hubStatus: 'connected' } }),
    disconnectHub: vi.fn(async () => { link = undefined; current = { ...current, linked: false, hubStatus: undefined } }),
    setLinkError: vi.fn()
  }
  const createPairing = vi.fn(async () => ({ code: 'c0de', expiresAt: 0, installCommand: '', hubUrl: HUB }))
  const linked = vi.fn()
  const listedForAccount = vi.fn(async () => extra.listed)
  const rememberLinkedAccount = vi.fn(async (value: string | undefined) => { recorded = value })
  const beforeUnlink = vi.fn(async () => undefined)
  const linker = new ThisComputerLinker({
    lifecycle, createPairing, settings: () => extra.settings ?? DEFAULT_AGL_SETTINGS, account: () => account, linked, now: () => now,
    linkedAccount: () => recorded, rememberLinkedAccount, listedForAccount, beforeUnlink
  })
  return {
    lifecycle, createPairing, linked, linker, beforeUnlink, listedForAccount, rememberLinkedAccount,
    recorded: () => recorded, signIn: (value: string | undefined) => { account = value }, advance: (ms: number) => { now += ms },
    setView: (next: Partial<AglStatusView>) => { current = { ...current, ...next } }
  }
}

it('mints a pairing code as the account, runs agl connect and records the account', async () => {
  const { linker, lifecycle, createPairing, linked, recorded } = setup()
  expect(await linker.maybeLink()).toBe(true)
  expect(createPairing).toHaveBeenCalledTimes(1)
  expect(lifecycle.connectHub).toHaveBeenCalledWith(HUB, 'c0de', { appName: 'Douchat' })
  expect(linked).toHaveBeenCalled()
  expect(recorded()).toBe('alice')
  // Linked now: nothing more to do.
  expect(await linker.maybeLink()).toBe(false)
  expect(createPairing).toHaveBeenCalledTimes(1)
})

it('does nothing while agl is off, when the setting is off or signed out, and retries a failure only after a while', async () => {
  const off = setup({ view: view({ state: 'off' }) })
  expect(await off.linker.maybeLink()).toBe(false)
  expect(off.createPairing).not.toHaveBeenCalled()
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

it('moves the link to the account that signed in: disconnect the old one, link the new one', async () => {
  const machine = setup({ link: { url: HUB, status: 'connected' }, recorded: 'alice' })
  expect(await machine.linker.maybeLink()).toBe(false)
  expect(machine.lifecycle.disconnectHub).not.toHaveBeenCalled()

  machine.signIn('bob')
  expect(await machine.linker.maybeLink()).toBe(true)
  expect(machine.lifecycle.disconnectHub).toHaveBeenCalledWith(HUB)
  expect(machine.lifecycle.connectHub).toHaveBeenCalledWith(HUB, 'c0de', { appName: 'Douchat' })
  expect(machine.lifecycle.disconnectHub.mock.invocationCallOrder[0]).toBeLessThan(machine.lifecycle.connectHub.mock.invocationCallOrder[0])
  // The previous account's agent bindings go before its link does.
  expect(machine.beforeUnlink).toHaveBeenCalledTimes(1)
  expect(machine.beforeUnlink.mock.invocationCallOrder[0]).toBeLessThan(machine.lifecycle.disconnectHub.mock.invocationCallOrder[0])
  expect(machine.recorded()).toBe('bob')
})

it('removes another account’s link even with "Show this computer in Devices" off, without linking', async () => {
  const machine = setup({ link: { url: HUB, status: 'connected' }, recorded: 'alice', account: 'bob', settings: { ...DEFAULT_AGL_SETTINGS, autoLink: false } })
  expect(await machine.linker.maybeLink()).toBe(false)
  expect(machine.lifecycle.disconnectHub).toHaveBeenCalledWith(HUB)
  expect(machine.lifecycle.connectHub).not.toHaveBeenCalled()
  expect(machine.recorded()).toBeUndefined()
})

it('asks the account’s device list about a link it did not record', async () => {
  const mine = setup({ link: { url: HUB, status: 'connected' }, listed: true })
  expect(await mine.linker.maybeLink()).toBe(false)
  expect(mine.listedForAccount).toHaveBeenCalledWith('m-1')
  expect(mine.lifecycle.disconnectHub).not.toHaveBeenCalled()
  expect(mine.recorded()).toBe('alice')

  const theirs = setup({ link: { url: HUB, status: 'connected' }, listed: false })
  expect(await theirs.linker.maybeLink()).toBe(true)
  expect(theirs.lifecycle.disconnectHub).toHaveBeenCalled()

  // The list could not be read, or the link was revoked: leave it.
  for (const unclear of [setup({ link: { url: HUB, status: 'connected' }, listed: undefined }), setup({ link: { url: HUB, status: 'unauthorized' }, listed: false })]) {
    expect(await unclear.linker.maybeLink()).toBe(false)
    expect(unclear.lifecycle.disconnectHub).not.toHaveBeenCalled()
    expect(unclear.createPairing).not.toHaveBeenCalled()
  }
})

it('never touches agl while it is off, even for another account’s link', async () => {
  const machine = setup({ link: { url: HUB, status: 'connected' }, recorded: 'alice', account: 'bob', view: view({ state: 'off', linked: true }) })
  expect(await machine.linker.maybeLink()).toBe(false)
  expect(machine.lifecycle.disconnectHub).not.toHaveBeenCalled()
})

it('re-links on request: drops a revoked link, clears the backoff, and reports failures', async () => {
  const machine = setup({ link: { url: HUB, status: 'unauthorized' }, recorded: 'alice' })
  // Left alone automatically…
  expect(await machine.linker.maybeLink()).toBe(false)
  // …but "Re-link" does it.
  await machine.linker.relink()
  expect(machine.lifecycle.disconnectHub).toHaveBeenCalledWith(HUB)
  expect(machine.lifecycle.connectHub).toHaveBeenCalledWith(HUB, 'c0de', { appName: 'Douchat' })

  const failing = setup()
  failing.lifecycle.connectHub.mockRejectedValueOnce(new Error('agl connect failed: 500'))
  expect(await failing.linker.maybeLink()).toBe(false)
  // In the 10-minute backoff, an automatic attempt waits; an explicit one does not.
  expect(await failing.linker.maybeLink()).toBe(false)
  await failing.linker.relink()
  expect(failing.createPairing).toHaveBeenCalledTimes(2)
  failing.lifecycle.connectHub.mockRejectedValueOnce(new Error('agl connect failed: 502'))
  failing.lifecycle.disconnectHub.mockClear()
  await expect(failing.linker.relink()).rejects.toThrow('agl connect failed: 502')

  await expect(setup({ view: view({ state: 'off' }) }).linker.relink()).rejects.toThrow('Turn on agl first.')
  await expect(setup({ account: undefined }).linker.relink()).rejects.toThrow('Sign in first.')
})
