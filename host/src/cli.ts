#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { callChannel, HostClient, UnauthorizedError } from './client'
import { Relay, type OpenRequest } from './relay'
import { Executor } from './executor'
import { desktopAgentExecutor } from '../../src/main/desktopAgentExecutor'
import { configureLocalWorkspaces } from '../../src/main/localWorkspaces'
import { resolveExecutable } from '../../src/main/shellPath'
import { executableVersion } from '../../src/main/localAgents'
import { compareVersions, isLocalBase, parseManifest, ReleaseError, sha256Hex, type ReleaseManifest } from './release'
import { installedService, installService, PID_FILE, removeService, restartService, rotateLog, serviceStatus, startService, stopService } from './service'
import { configFloor, ensureHome, HOST_HOME, loadState, loadTrust, purgeHome, saveState, saveTrust, SeenRequests, type HostState, type TrustState } from './state'
import { acceptOwnerCommand, deviceFingerprint, generateHostKey, nextTrust, signAsHost, VerifyError } from './verify'

export const HOST_VERSION = '0.2.0'
const ENROLLMENT_PREFIX = 'dch1_'
const TRUST_REFRESH_MS = 5 * 60 * 1000
const ROTATE_BEFORE_MS = 30 * 24 * 60 * 60 * 1000
/** Written by install.sh: where updates come from and which Node runs the bundle. */
const INSTALL_FILE = join(HOST_HOME, 'install.json')

const log = (message: string) => process.stderr.write(`${new Date().toISOString()} ${message}\n`)
const die = (message: string, code = 1): never => {
  process.stderr.write(`douchat-host: ${message}\n`)
  process.exit(code)
}

/** v1 from a desktop: trust that device's key. v2 from the web app: follow the service. */
type Enrollment = {
  serviceUrl: string
  ticket: string
  hostId: string
  ownerId: string
  exp: number
} & ({ v: 1; devicePublicKey: string; deviceId: string; fingerprint: string } | { v: 2; trust: 'service' })

function parseEnrollment(raw: string | undefined): Enrollment {
  if (!raw) die('Set DOUCHAT_ENROLL to the install token shown in Douchat (Connections → Add server → douchat-host).')
  const token = raw!.trim()
  if (!token.startsWith(ENROLLMENT_PREFIX)) die('This is not a Douchat install token.')
  let value: Enrollment
  try { value = JSON.parse(Buffer.from(token.slice(ENROLLMENT_PREFIX.length), 'base64url').toString('utf8')) } catch { return die('The install token is damaged. Copy the command from Douchat again.') }
  if ((value?.v !== 1 && value?.v !== 2) || typeof value.serviceUrl !== 'string' || typeof value.ticket !== 'string' || !/^hst_[0-9a-f-]{36}$/.test(value.hostId) || typeof value.ownerId !== 'string')
    die('The install token is damaged. Copy the command from Douchat again.')
  if (value.v === 2 && value.trust !== 'service') die('The install token is damaged. Copy the command from Douchat again.')
  if (value.v === 1 && (typeof value.deviceId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.devicePublicKey) || deviceFingerprint(value.devicePublicKey) !== value.fingerprint))
    die('The install token is damaged. Copy the command from Douchat again.')
  if (!Number.isFinite(value.exp) || value.exp < Date.now()) die('The install token expired. Create a new install command in Douchat.')
  return value
}

function refuseRoot(): void {
  if (process.getuid?.() === 0 && process.env.DOUCHAT_HOST_ALLOW_ROOT !== '1')
    die('Do not run douchat-host as root. Agents run with this user\'s permissions; use a regular account.')
}

/** Asks on the terminal even when stdin is the piped install script; undefined without a terminal. */
function askTerminal(question: string): boolean | undefined {
  let fd: number
  try { fd = openSync('/dev/tty', 'r+') } catch { return undefined }
  try {
    writeSync(fd, question)
    const buffer = Buffer.alloc(256)
    let line = ''
    while (!line.includes('\n')) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      line += buffer.toString('utf8', 0, read)
    }
    return /^\s*y(es)?\s*$/i.test(line.split('\n')[0])
  } catch { return undefined } finally { closeSync(fd) }
}

async function setup(args: string[]): Promise<void> {
  refuseRoot()
  const enrollment = parseEnrollment(process.env.DOUCHAT_ENROLL)
  delete process.env.DOUCHAT_ENROLL
  const existing = loadState()
  const serviceOrigin = new URL(enrollment.serviceUrl).origin
  // One install per server: a new install command for the same account reuses
  // this registration, so every Douchat app shares one connection.
  if (existing && existing.ownerId === enrollment.ownerId && new URL(existing.serviceUrl).origin === serviceOrigin && !args.includes('--force')) {
    try {
      const adopted = await callChannel<{ hostId: string; name: string | null; trustMode: string }>(serviceOrigin, existing.hostToken, { action: 'adopt-ticket', ticket: enrollment.ticket })
      if (adopted.trustMode === 'service' && existing.trustMode !== 'service') saveState({ ...existing, trustMode: 'service' })
      console.log(`This server is already connected to your Douchat account${adopted.name ? ` as "${adopted.name}"` : ''}. Reusing that connection.`)
      return
    } catch (error) {
      // A removed registration cannot be reused; register this server again below.
      if (!(error instanceof UnauthorizedError)) throw error
    }
  } else if (existing && !args.includes('--force'))
    die(`Already registered as ${existing.hostId} with another Douchat account or service. Run "douchat-host uninstall" first, or set DOUCHAT_HOST_FORCE=1 to replace it.`)
  if (enrollment.v === 2) console.log('This server follows your Douchat account, so every Douchat app you sign in to can use it.')
  else console.log(`Owner device fingerprint: ${enrollment.fingerprint}`)
  if (enrollment.v === 1 && !args.includes('--yes') && process.env.DOUCHAT_HOST_YES !== '1') {
    const confirmed = askTerminal('Does this match the fingerprint shown in Douchat? [y/N] ')
    if (confirmed === false) die('Cancelled. Nothing was saved.')
    if (confirmed === undefined) console.log('No terminal to confirm on; check that it matches the fingerprint shown in Douchat.')
  }
  const keys = generateHostKey()
  const serviceUrl = new URL(enrollment.serviceUrl).origin
  const result = await callChannel<{
    hostId: string; hostToken: string; tokenExpiresAt: number; owner?: { id: string; name?: string }; trustMode?: string
    trustedDevices?: { revision?: number; devices?: { deviceId: string; publicKey: string }[] } | null
  }>(serviceUrl, undefined, { action: 'enroll', ticket: enrollment.ticket, signKey: keys.signPublicKey, info: { os: platform(), arch: arch(), version: HOST_VERSION } })
  if (result.hostId !== enrollment.hostId || (result.owner && result.owner.id !== enrollment.ownerId) || !result.hostToken?.startsWith('dhh_'))
    die('The Douchat service answered for a different host or account. Nothing was saved.')
  // The anchor comes from the token the owner copied, never from the response.
  let trust: TrustState = { revision: 0, devices: [] }
  if (enrollment.v === 1) {
    const anchor = { deviceId: enrollment.deviceId, publicKey: enrollment.devicePublicKey }
    const served = result.trustedDevices
    const sameList = served?.devices?.length === 1 && served.devices[0].deviceId === anchor.deviceId && served.devices[0].publicKey === anchor.publicKey
    trust = { revision: sameList && Number.isSafeInteger(served?.revision) ? served!.revision! : 1, devices: [anchor] }
  } else if (result.trustMode !== 'service') die('The Douchat service answered for a different kind of host. Nothing was saved.')
  const state: HostState = {
    v: 1, serviceUrl, hostId: result.hostId, ownerId: enrollment.ownerId, ownerName: result.owner?.name,
    hostToken: result.hostToken, tokenExpiresAt: result.tokenExpiresAt, signKey: keys.signKey, signPublicKey: keys.signPublicKey, enrolledAt: Date.now(),
    ...(enrollment.v === 2 ? { trustMode: 'service' as const } : {})
  }
  ensureHome()
  saveTrust(trust)
  saveState(state)
  console.log(`Registered ${state.hostId} with ${serviceUrl}${state.ownerName ? ` for ${state.ownerName}` : ''}.`)
  if (!process.env.DOUCHAT_HOST_INSTALLER) console.log('Start it with: douchat-host service install   (or run it in the foreground: douchat-host run)')
}

function requireState(): { state: HostState; trust: TrustState } {
  const state = loadState()
  const trust = loadTrust()
  if (!state || !trust) return die('Not registered. Run the install command from Douchat first.')
  return { state, trust }
}

function lockSingleInstance(): () => void {
  ensureHome()
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    if (pid && pid !== process.pid) {
      try { process.kill(pid, 0); die(`douchat-host is already running (pid ${pid}).`) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') die(`douchat-host is already running (pid ${pid}).`)
      }
    }
  }
  writeFileSync(PID_FILE, `${process.pid}\n`, { mode: 0o600 })
  return () => { try { if (readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) rmSync(PID_FILE) } catch { /* gone */ } }
}

async function run(): Promise<void> {
  refuseRoot()
  let { state, trust } = requireState()
  const unlock = lockSingleInstance()
  const client = new HostClient(state)
  const seen = new SeenRequests()
  const origin = new URL(state.serviceUrl).origin
  const stop = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, () => { log(`${signal}: stopping`); stop.abort() })

  const relay = new Relay({
    client,
    log,
    verifyOpen(signed, streamId): OpenRequest {
      // Shells are only ever opened by a device this server trusts, whatever the trust mode.
      const command = acceptOwnerCommand<Record<string, unknown>>(signed, { origin, ownerId: state.ownerId, hostId: state.hostId, method: 'relay.open', trust }, seen)
      const payload = command.payload
      if (payload.streamId !== streamId) throw new VerifyError('Signed for a different stream.')
      if (payload.kind === 'exec') return { kind: 'exec', script: String(payload.script ?? '') }
      if (payload.kind === 'listen') return { kind: 'listen', socketPath: String(payload.socketPath ?? '') }
      throw new VerifyError('Unknown stream kind.')
    }
  })

  const maintain = async () => {
    if (state.trustMode !== 'service') try {
      const { trustedDevices } = await client.call<{ trustedDevices?: unknown }>({ action: 'agents' })
      const next = nextTrust(trust, trustedDevices, { origin, ownerId: state.ownerId, hostId: state.hostId })
      if (next) { trust = next; saveTrust(next); log(`trusted devices updated (revision ${next.revision}, ${next.devices.length} device(s))`) }
    } catch (error) {
      if (error instanceof UnauthorizedError) return
      log(`device list not updated: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (state.tokenExpiresAt - Date.now() < ROTATE_BEFORE_MS) {
      try {
        const issuedAt = Date.now()
        const signature = signAsHost(state.signKey, { hostId: state.hostId, method: 'rotate-token', issuedAt })
        const rotated = await client.call<{ hostToken: string; tokenExpiresAt: number }>({ action: 'rotate-token', issuedAt, signature })
        state = { ...state, hostToken: rotated.hostToken, tokenExpiresAt: rotated.tokenExpiresAt }
        saveState(state)
        client.update(state)
        log('host token rotated')
      } catch (error) {
        log(`token not rotated: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  void maintain()
  const timer = setInterval(() => void maintain(), TRUST_REFRESH_MS)

  // Owner tasks run here with the same runtime the desktop uses for local agents.
  const data = join(HOST_HOME, 'data')
  configureLocalWorkspaces(data)
  const executor = new Executor({
    client, log, origin, ownerId: state.ownerId, hostId: state.hostId, trust: () => trust, seen, version: HOST_VERSION,
    serviceTrusted: state.trustMode === 'service',
    executor: desktopAgentExecutor,
    resolveCommand: resolveExecutable,
    readVersion: executableVersion,
    workRoot: join(HOST_HOME, 'work'),
    sessionRoot: join(data, 'local-workspaces', 'sessions'),
    configFloor
  })

  log(`douchat-host ${HOST_VERSION} running as ${state.hostId} (${state.serviceUrl})`)
  try {
    await Promise.all([relay.run(stop.signal), executor.run(stop.signal)])
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      unlock()
      // Exit 0 so systemd and launchd leave a removed host stopped instead of restarting it.
      log('This host was removed from Douchat. Run the install command again to reconnect it.')
      process.exit(0)
    }
    throw error
  } finally {
    clearInterval(timer)
    unlock()
  }
}

async function uninstall(args: string[]): Promise<void> {
  const state = loadState()
  if (state) {
    try {
      await new HostClient(state).call({ action: 'unregister' })
      console.log(`Removed ${state.hostId} from ${state.serviceUrl}.`)
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) die(`Could not reach Douchat: ${error instanceof Error ? error.message : String(error)}. Try again, or remove the server in Douchat.`)
      console.log('This host was already removed from Douchat.')
    }
  }
  removeService()
  if (args.includes('--purge')) { purgeHome(); console.log(`Deleted ${HOST_HOME}.`) }
  else if (state) {
    rmSync(join(HOST_HOME, 'state.json'), { force: true })
    rmSync(join(HOST_HOME, 'trust.json'), { force: true })
  }
}

function service(args: string[]): void {
  refuseRoot()
  const [action = 'status'] = args
  if (action === 'status') { console.log(serviceStatus()); return }
  if (action === 'remove') { removeService(); console.log('Service removed.'); return }
  requireState()
  if (action === 'install') { for (const note of installService()) console.log(note); console.log(serviceStatus()); return }
  if (!installedService()) die('No service installed. Run: douchat-host service install')
  if (action === 'start') startService()
  else if (action === 'stop') stopService()
  else if (action === 'restart') restartService()
  else die(`Unknown service action "${action}".`, 2)
  console.log(serviceStatus())
}

function installInfo(): { base?: string; node?: string; version?: string } {
  try { return JSON.parse(readFileSync(INSTALL_FILE, 'utf8')) } catch { return {} }
}

/**
 * Upgrades from where this copy came from: reads latest.txt, refuses to go
 * back to an older version, checks that version's install.sh against its
 * manifest, then runs it to switch versions and restart the service.
 */
async function upgrade(): Promise<void> {
  refuseRoot()
  const base = (process.env.DOUCHAT_HOST_URL || installInfo().base || '').replace(/\/+$/, '')
  if (!base) die('Unknown download address. Run the install command from Douchat again.')
  if (!base.startsWith('https://') && !isLocalBase(base)) die(`Refusing to upgrade from a non-HTTPS address: ${base}`)
  const download = async (url: string): Promise<Buffer> => {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch(() => undefined)
    if (!response?.ok) die(`Could not download ${url}${response ? ` (HTTP ${response.status})` : ''}.`)
    return Buffer.from(await response!.arrayBuffer())
  }
  let manifest: ReleaseManifest
  try {
    const latest = (await download(`${base}/latest.txt`)).toString('utf8').trim()
    if (!/^[0-9A-Za-z.-]{1,64}$/.test(latest)) throw new ReleaseError('The latest-version pointer is invalid.')
    manifest = parseManifest(await download(`${base}/${latest}/manifest.json`))
    if (manifest.version !== latest) throw new ReleaseError(`The manifest is for ${manifest.version}, not ${latest}.`)
  } catch (error) {
    return die(error instanceof ReleaseError ? error.message : String(error))
  }
  const order = compareVersions(manifest.version, HOST_VERSION)
  if (order < 0) die(`The download address offers ${manifest.version}, older than the installed ${HOST_VERSION}; refusing to downgrade.`)
  if (order === 0 && !process.argv.includes('--force')) { console.log(`douchat-host ${HOST_VERSION} is the latest version.`); return }
  const script = await download(`${base}/${manifest.version}/install.sh`)
  if (sha256Hex(script) !== manifest.installSha256) die('The installer failed verification. The download may have been tampered with.')
  const child = spawn('/bin/sh', ['-s'], { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, DOUCHAT_HOST_URL: base, DOUCHAT_HOST_VERSION: manifest.version, DOUCHAT_HOST_HOME: HOST_HOME } })
  child.stdin.end(script)
  const code = await new Promise<number>(resolve => child.on('close', value => resolve(value ?? 1)))
  if (code) process.exit(code)
}

function status(): void {
  const { state, trust } = requireState()
  console.log([
    `host:     ${state.hostId}`,
    `service:  ${state.serviceUrl}`,
    `owner:    ${state.ownerName ?? state.ownerId}`,
    `token:    expires ${new Date(state.tokenExpiresAt).toISOString()}`,
    state.trustMode === 'service' ? 'trust:    follows your Douchat account' : `devices:  revision ${trust.revision}; ${trust.devices.map(device => deviceFingerprint(device.publicKey)).join(', ')}`,
    `version:  ${HOST_VERSION} (node ${process.versions.node})`,
    `process:  ${serviceStatus()}`
  ].join('\n'))
}

async function doctor(): Promise<void> {
  status()
  const { state } = requireState()
  try {
    await new HostClient(state).call({ action: 'agents' })
    console.log('douchat:  reachable, host token accepted')
  } catch (error) {
    console.log(`douchat:  ${error instanceof UnauthorizedError ? 'host token rejected; this host was removed. Run the install command again.' : `unreachable: ${error instanceof Error ? error.message : String(error)}`}`)
    process.exitCode = 1
  }
}

const USAGE = `Usage: douchat-host <command>

  setup [--force] [--yes]   Register this server (reads DOUCHAT_ENROLL)
  run                       Connect and relay Douchat sessions in the foreground
  service <action>          install | start | stop | restart | status | remove
  status                    Show the registration and process
  doctor                    Status plus a connection check
  upgrade [--force]         Download and switch to the latest version
  uninstall [--purge]       Remove this server from Douchat (--purge deletes ${HOST_HOME})
  version                   Print the version
`

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv
  switch (command) {
    case 'setup': return setup(args)
    case 'run': rotateLog(); return run()
    case 'service': return service(args)
    case 'status': return status()
    case 'doctor': return doctor()
    case 'upgrade': return upgrade()
    case 'uninstall': return uninstall(args)
    case 'version': case '--version': console.log(HOST_VERSION); return
    default: process.stdout.write(USAGE); if (command && command !== 'help' && command !== '--help') process.exitCode = 2
  }
}

main(process.argv.slice(2)).catch(error => die(error instanceof Error ? error.message : String(error)))
