import { createHash, generateKeyPairSync } from 'node:crypto'
import { expect, it } from 'vitest'
import { agentPermissions } from '../../shared/agentPermissions'
import type { AgentConfig } from '../../shared/types'
import { deviceFingerprint, enrollmentServiceUrl, hostAgentConfig } from './daemonClient'
import { hostInstallCommand } from '../../shared/hostInstall'

const publicKey = (generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string }).x

it('builds the short install command for a one-time code, quoting nothing the shell could read', () => {
  expect(hostInstallCommand('https://douchat.ai/', '7KQ2-M9XP-4TCE')).toBe('curl -fsSL https://douchat.ai/h/7KQ2-M9XP-4TCE | sh')
  // A local service is reached directly even where a proxy is configured.
  expect(hostInstallCommand('http://localhost:3005', '7KQ2-M9XP-4TCE')).toBe("curl -fsSL --noproxy '*' http://localhost:3005/h/7KQ2-M9XP-4TCE | sh")
  expect(() => hostInstallCommand('https://douchat.ai', "7KQ2'; rm -rf ~")).toThrow(/invalid install ticket/)
  expect(() => hostInstallCommand('http://douchat.example', '7KQ2-M9XP-4TCE')).toThrow(/HTTPS/)
})

it('fingerprints the raw public key bytes', () => {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex')
  expect(deviceFingerprint(publicKey)).toBe(hex.slice(0, 16).match(/.{4}/g)!.join('-'))
  expect(deviceFingerprint(publicKey)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/)
})

it('sends a host only enabled skills, without files, and derives sharing from permissions', () => {
  const agent = { id: 'a1', name: 'Codex', role: 'Dev', instructions: 'Be brief', color: '#123456', provider: 'local', model: 'default', revision: 4, startupArgs: ['--x'],
    skills: [{ id: 's1', name: 'One', enabled: true, files: [{ path: 'a' }], directory: '/tmp/x' }, { id: 's2', name: 'Two', enabled: false }] } as unknown as AgentConfig
  const config = hostAgentConfig(agent, { adapter: 'codex', executable: 'codex', args: ['--a'] })
  expect(config).toMatchObject({ localId: 'a1', configRevision: 4, permissionsRevision: 4, adapter: 'codex', args: ['--a', '--x'], allowSharing: true })
  expect(config.skills).toEqual([{ id: 's1', name: 'One', enabled: true }])
  const closed = { ...agent, permissions: { ...agentPermissions(), groupHumans: 'deny', groupAgents: 'deny' } } as AgentConfig
  expect(hostAgentConfig(closed, { adapter: 'codex', executable: 'codex', args: [] }).allowSharing).toBe(false)
  const agentsOnly = { ...agent, permissions: { ...agentPermissions(), groupHumans: 'deny', groupAgents: 'ask' } } as AgentConfig
  expect(hostAgentConfig(agentsOnly, { adapter: 'codex', executable: 'codex', args: [] }).allowSharing).toBe(true)
})

it('keeps local enrollment on the service that issued the ticket', () => {
  const service = enrollmentServiceUrl('http://localhost:3004', 'https://douchat.ai')
  expect(service).toBe('http://localhost:3004')
  expect(enrollmentServiceUrl('http://127.0.0.1:3004', 'https://douchat.ai')).toBe('http://127.0.0.1:3004')
  expect(enrollmentServiceUrl('https://douchat.ai', 'https://douchat.ai')).toBe('https://douchat.ai')
})
