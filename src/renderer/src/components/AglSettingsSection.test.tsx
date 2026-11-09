// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AglStatusView } from '../../../shared/agl'
vi.mock('../preferences', () => ({ t: (text: string) => text, tr: (text: string, values: Record<string, unknown>) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key])) }))
import { AglSettingsSection, aglUpdateLine } from './AglSettingsSection'

let container: HTMLDivElement, root: Root
let api: Record<string, any>
let pushStatus: ((status: AglStatusView) => void) | undefined
const status = (extra: Partial<AglStatusView> = {}): AglStatusView => ({ state: 'running', home: '/Users/me/.agl', minimumVersion: '0.3.12', running: true, version: '0.3.12', service: true,
  machineId: 'm-1', linked: true, hubStatus: 'connected', update: { checkedAt: 1_700_000_000_000, latest: '0.3.12', available: false }, ...extra })
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  api = {
    platform: 'darwin',
    getAglStatus: vi.fn(async () => status()),
    getAglSettings: vi.fn(async () => ({ enabled: true, autoLink: true, useForLocalAgents: false })),
    saveAglSettings: vi.fn(async (patch: object) => ({ enabled: true, autoLink: true, useForLocalAgents: false, ...patch })),
    relinkAgl: vi.fn(async () => status()),
    checkAglUpdates: vi.fn(async () => status({ update: { checkedAt: 1_700_000_000_000, latest: '0.3.13', available: true, busy: 1 } })),
    onAglStatus: vi.fn((listener: (value: AglStatusView) => void) => { pushStatus = listener; return () => { pushStatus = undefined } })
  }
  Object.defineProperty(window, 'douchat', { configurable: true, value: api })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
const render = async () => { await act(async () => root.render(<AglSettingsSection />)) }
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label) || item.getAttribute('aria-label') === label)

it('shows agl’s version, status, link and updates, and checks for updates on request', async () => {
  await render()
  const text = container.textContent ?? ''
  expect(text).toContain('Running')
  expect(text).toContain('agl 0.3.12')
  expect(text).toContain('Starts at login')
  expect(text).toContain('Linked to your account')
  expect(text).toContain('Up to date · checked')
  expect(text).toContain('/Users/me/.agl')
  await act(async () => button('Check for updates')!.click())
  expect(api.checkAglUpdates).toHaveBeenCalled()
  expect(container.textContent).toContain('agl 0.3.13 is available; it installs once agents finish their current turns.')
})

it('follows status pushes and shows the last error and needs-update', async () => {
  await render()
  await act(async () => pushStatus!(status({ state: 'needs-update', version: '0.3.11', error: 'agl 0.3.11 is older than 0.3.12, which Douchat needs.' })))
  expect(container.textContent).toContain('Needs update')
  expect(container.textContent).toContain('0.3.12 or newer needed')
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Last error: agl 0.3.11 is older than 0.3.12, which Douchat needs.')
})

it('saves the two switches', async () => {
  await render()
  const autoLink = button('Show this computer in Devices')!
  const useAgl = button('Use agl for local agents (experimental)')!
  expect(autoLink.getAttribute('aria-checked')).toBe('true')
  expect(useAgl.getAttribute('aria-checked')).toBe('false')
  await act(async () => useAgl.click())
  expect(api.saveAglSettings).toHaveBeenCalledWith({ useForLocalAgents: true })
  expect(button('Use agl for local agents (experimental)')!.getAttribute('aria-checked')).toBe('true')
  await act(async () => autoLink.click())
  expect(api.saveAglSettings).toHaveBeenLastCalledWith({ autoLink: false })
})

it('explains Windows and is absent from the web app', async () => {
  api.getAglStatus.mockResolvedValue(status({ state: 'unsupported', running: false, version: undefined }))
  await render()
  expect(container.textContent).toContain('agl does not support Windows yet.')
  expect(button('Check for updates')).toBeUndefined()
  expect(button('Show this computer in Devices')).toBeUndefined()
  await act(async () => root.unmount())
  root = createRoot(container)
  api.platform = 'web'
  await render()
  expect(container.textContent).toBe('')
})

it('describes applied updates', () => {
  expect(aglUpdateLine(status({ update: { appliedAt: 1, appliedVersion: '0.3.13' } }))).toMatch(/^Updated to 0.3.13 on /)
  expect(aglUpdateLine(status({ update: { available: true, latest: '0.3.13' } }))).toBe('agl 0.3.13 is available.')
  expect(aglUpdateLine(status({ update: {} }))).toBe('agl checks for updates by itself every 12 hours.')
})

it('asks once before touching agl, and saves the answer', async () => {
  api.getAglStatus.mockResolvedValue(status({ state: 'off', running: true, linked: false, hubStatus: undefined }))
  api.getAglSettings.mockResolvedValue({ autoLink: true, useForLocalAgents: false })
  api.saveAglSettings.mockImplementation(async (patch: object) => ({ autoLink: true, useForLocalAgents: false, ...patch }))
  await render()
  const text = container.textContent ?? ''
  expect(text).toContain('Run coding agents with agl')
  expect(text).toContain('install agl in /Users/me/.agl, which other apps that use agl share;')
  expect(text).toContain('keep it running in the background (it starts when you log in) and update it automatically;')
  expect(text).toContain('so the web app and your phone can use its agents')
  // No switches, no update checks until the user answers.
  expect(button('Enable agl')).toBeUndefined()
  expect(button('Check for updates')).toBeUndefined()
  expect(text).not.toContain('Up to date')
  await act(async () => button('Not now')!.click())
  expect(api.saveAglSettings).toHaveBeenCalledWith({ enabled: false })
  expect(container.textContent).not.toContain('Run coding agents with agl')
  // The master switch now says off; turning it on is the same consent.
  const master = button('Enable agl')!
  expect(master.getAttribute('aria-checked')).toBe('false')
  expect(button('Show this computer in Devices')).toBeUndefined()
  await act(async () => master.click())
  expect(api.saveAglSettings).toHaveBeenLastCalledWith({ enabled: true })
  expect(button('Show this computer in Devices')).toBeDefined()
})

it('enables from the card', async () => {
  api.getAglStatus.mockResolvedValue(status({ state: 'off' }))
  api.getAglSettings.mockResolvedValue({ autoLink: true, useForLocalAgents: false })
  await render()
  await act(async () => button('Enable')!.click())
  expect(api.saveAglSettings).toHaveBeenCalledWith({ enabled: true })
  expect(container.textContent).not.toContain('Run coding agents with agl')
})

it('offers Re-link when this computer is not linked or was removed', async () => {
  api.getAglStatus.mockResolvedValue(status({ linked: true, hubStatus: 'unauthorized' }))
  await render()
  expect(container.textContent).toContain('Removed from your account')
  await act(async () => button('Re-link')!.click())
  expect(api.relinkAgl).toHaveBeenCalled()
  expect(container.textContent).toContain('Linked to your account')
  expect(button('Re-link')).toBeUndefined()

  api.relinkAgl.mockRejectedValueOnce(new Error('agl connect failed: 401'))
  await act(async () => pushStatus!(status({ linked: false, hubStatus: undefined })))
  await act(async () => button('Re-link')!.click())
  expect(container.querySelector('[role=alert]')?.textContent).toContain('agl connect failed: 401')
})
