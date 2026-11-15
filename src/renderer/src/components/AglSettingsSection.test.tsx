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

it('never asks: agl is on by default, and the master switch can still turn it off', async () => {
  // Settings saved by no one yet: `enabled` is undefined, which means on.
  api.getAglSettings.mockResolvedValue({ autoLink: true, useForLocalAgents: false })
  api.saveAglSettings.mockImplementation(async (patch: object) => ({ autoLink: true, useForLocalAgents: false, ...patch }))
  await render()
  const text = container.textContent ?? ''
  expect(text).not.toContain('Run coding agents with agl')
  expect(button('Not now')).toBeUndefined()
  expect(button('Enable')).toBeUndefined()
  expect(container.querySelector('.agl-consent')).toBeNull()
  const master = button('Enable agl')!
  expect(master.getAttribute('aria-checked')).toBe('true')
  expect(button('Show this computer in Devices')).toBeDefined()
  expect(button('Check for updates')).toBeDefined()
  await act(async () => master.click())
  expect(api.saveAglSettings).toHaveBeenLastCalledWith({ enabled: false })
  expect(button('Enable agl')!.getAttribute('aria-checked')).toBe('false')
  expect(button('Show this computer in Devices')).toBeUndefined()
  await act(async () => button('Enable agl')!.click())
  expect(api.saveAglSettings).toHaveBeenLastCalledWith({ enabled: true })
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
