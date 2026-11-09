import { join } from 'node:path'
import { AGL_MIN_VERSION, AGL_PROTOCOL, type AglState, type AglStatusView, type AglUpdateInfo } from '../../shared/agl'
import type { ConnectionEvent } from './aglClient'
import { ensureExtraPaths as ensureExtraPathsInFile } from './aglConfig'
import { douchatHubLink, parseAglStatus, parseAglUpdate, type AglStatusJson } from './aglStatus'
import { isOlder, meetsMinimum, parseAglVersion, shouldInstallBundled } from './aglVersion'

export interface AglCommandResult { code: number | null; stdout: string; stderr: string }
/** Runs a program without a shell and collects its output; never rejects for a non-zero exit. */
export type AglRunner = (file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<AglCommandResult>

/** The part of the vendored AglClient the lifecycle uses (a fake in tests). */
export interface AglDaemonConnection {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  onConnection(listener: (event: ConnectionEvent) => void): () => void
  close(): void
}

export interface AglLifecycleOptions {
  platform: NodeJS.Platform
  /** False in a development run without an explicit agl home: nothing is touched. */
  enabled: boolean
  /** The agl home (AGL_HOME) to manage; ~/.agl unless overridden. */
  home: string
  /** `home` is the user's real ~/.agl. Only then is the per-user autostart service installed or used. */
  defaultHome: boolean
  /** The agl shipped with the app (or DOUCHAT_AGL_BIN in development). */
  bundledBin?: string
  run: AglRunner
  fileExists: (path: string) => Promise<boolean>
  /** Puts `from` at `to` atomically (temporary file in the same directory, then rename). */
  installBinary: (from: string, to: string) => Promise<void>
  /** The environment agl commands run with (the login shell's PATH); AGL_HOME is added. */
  environment: () => Promise<NodeJS.ProcessEnv>
  connect: (home: string) => Promise<AglDaemonConnection>
  /** Directories where Douchat installs agent CLIs, for `extra_paths`. */
  extraPaths: () => string[]
  /** Douchat's own tool directory: stale `extra_paths` entries inside it are removed. */
  ownedRoot: string
  ensureExtraPaths?: typeof ensureExtraPathsInFile
  /** The command that makes the installed autostart service start its daemon now, if any. */
  serviceStartCommand?: () => { file: string; args: string[] } | undefined
  /** Default: first check 2 minutes after start, then every 12 hours. */
  firstUpdateCheckMs?: number
  updateIntervalMs?: number
  /** How long to wait for a daemon to come up after starting it. */
  startWaitMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (event: string, detail?: string) => void
}

/** What to do about the daemon, given `agl status --json` and the agl binary in the home. */
export type AglDaemonAction = 'none' | 'service-install' | 'service-start' | 'start' | 'restart' | 'defer'

/**
 * - Not running: the default home gets the autostart service (installed, or
 *   asked to start); any other home only `agl start`, since the service is per
 *   user and would be pointed away from the user's real ~/.agl.
 * - Running but older than the binary in the home (it was just replaced), or
 *   not under the service in the default home: restart onto it, but only
 *   while no session runs a turn (`busy`), otherwise later (`defer`).
 */
export function planDaemon(status: AglStatusJson, binaryVersion: string | undefined, defaultHome: boolean): AglDaemonAction {
  if (!status.running) return defaultHome ? status.service ? 'service-start' : 'service-install' : 'start'
  const idle = (status.busy ?? 0) === 0
  if (defaultHome && !status.service) return idle ? 'service-install' : 'defer'
  const stale = Boolean(status.daemonVersion && binaryVersion && isOlder(status.daemonVersion, binaryVersion))
  if (!stale) return 'none'
  if (!idle) return 'defer'
  return defaultHome ? 'service-install' : 'restart'
}

/**
 * Whether `agl update` may install a release. It restarts the daemon through
 * the per-user service whenever one is installed, so with any home but the
 * default one that would repoint the user's real service: check only.
 */
export const canApplyUpdates = (defaultHome: boolean, status: Pick<AglStatusJson, 'service'> | undefined): boolean => defaultHome || !status?.service

const HOUR = 3_600_000
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const output = (result: AglCommandResult): string => (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)

/**
 * The shared agl daemon on this computer ("Shared daemon" in agl's
 * desktop-app guide): installs the bundled agl into `<home>/bin/agl` when it
 * is missing or older (never a downgrade), installs the autostart service,
 * starts the daemon, connects to it, keeps Douchat's CLI folders in
 * `extra_paths`, and lets agl update itself on its own schedule.
 *
 * Nothing here blocks the app: every step runs in the background, failures
 * are kept in `view().error`, and the desktop's own runtime keeps working.
 * Windows is left alone entirely.
 */
export class AglLifecycle {
  private state: AglState
  private error?: string
  private linkError?: string
  private binaryVersion?: string
  private bundledVersion?: string
  private status?: AglStatusJson
  private daemonVersion?: string
  private connection?: AglDaemonConnection
  private connectionOff?: () => void
  private update: AglUpdateInfo = {}
  private refreshing?: Promise<AglStatusView>
  private updating?: Promise<AglStatusView>
  private hubUrls: string[] = []
  private updateTimer?: ReturnType<typeof setTimeout>
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  private readonly statusListeners = new Set<(view: AglStatusView) => void>()
  private readonly restartListeners = new Set<() => void>()

  constructor(private readonly options: AglLifecycleOptions) {
    this.state = options.platform === 'win32' ? 'unsupported' : options.enabled ? 'starting' : 'disabled'
  }

  get supported(): boolean { return this.state !== 'unsupported' && this.state !== 'disabled' }
  /** `<home>/bin/agl`: where the install script and Douchat put agl, and where it updates itself. */
  get binary(): string { return join(this.options.home, 'bin', 'agl') }
  get home(): string { return this.options.home }

  /** The Douchat service's hub URLs, to tell whether this machine is linked to it. */
  setHubUrls(urls: string[]): void { this.hubUrls = urls.filter(Boolean) }

  onStatus(listener: (view: AglStatusView) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener) }
  /** The daemon restarted (update, crash, reboot): every turn that was running on it is gone. */
  onRestart(listener: () => void): () => void { this.restartListeners.add(listener); return () => this.restartListeners.delete(listener) }

  /** The connected daemon, while it runs and is recent enough. */
  client(): AglDaemonConnection | undefined { return this.state === 'running' ? this.connection : undefined }
  /** The last `agl status --json`. */
  lastStatus(): AglStatusJson | undefined { return this.status }

  view(): AglStatusView {
    const link = this.status ? douchatHubLink(this.status, this.hubUrls) : undefined
    return {
      state: this.state, home: this.options.home, minimumVersion: AGL_MIN_VERSION, running: this.state === 'running' || Boolean(this.status?.running),
      ...(this.binaryVersion ? { version: this.binaryVersion } : {}),
      ...(this.daemonVersion && this.daemonVersion !== this.binaryVersion ? { daemonVersion: this.daemonVersion } : {}),
      ...(this.bundledVersion ? { bundledVersion: this.bundledVersion } : {}),
      ...(this.status && this.options.defaultHome ? { service: this.status.service } : {}),
      ...(this.status?.machineId ? { machineId: this.status.machineId } : {}),
      ...(this.status ? { linked: Boolean(link) } : {}),
      ...(link ? { hubStatus: link.status } : {}),
      update: { ...this.update },
      ...(this.refreshing || this.updating ? { busy: true } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.linkError ? { linkError: this.linkError } : {})
    }
  }

  private emit(): void {
    const view = this.view()
    for (const listener of this.statusListeners) {
      try { listener(view) } catch { /* A listener never breaks the lifecycle. */ }
    }
  }

  private log(event: string, detail?: string): void { this.options.log?.(event, detail) }

  /** Starts managing agl in the background; safe to call again (on sign-in). */
  start(): void {
    if (!this.supported || this.disposed) return
    void this.refresh()
    if (!this.updateTimer) this.scheduleUpdate(this.options.firstUpdateCheckMs ?? 2 * 60_000)
  }

  private scheduleUpdate(ms: number): void {
    clearTimeout(this.updateTimer)
    this.updateTimer = setTimeout(() => {
      void this.checkForUpdates(true).finally(() => { if (!this.disposed) this.scheduleUpdate(this.options.updateIntervalMs ?? 12 * HOUR) })
    }, ms)
    this.updateTimer.unref?.()
  }

  async env(): Promise<NodeJS.ProcessEnv> {
    return { ...await this.options.environment(), AGL_HOME: this.options.home }
  }

  private async agl(args: string[], timeoutMs = 30_000): Promise<AglCommandResult> {
    return this.options.run(this.binary, args, { env: await this.env(), timeoutMs })
  }

  private async version(file: string): Promise<string | undefined> {
    const result = await this.options.run(file, ['--version'], { env: await this.env(), timeoutMs: 10_000 }).catch(() => undefined)
    return result?.code === 0 ? parseAglVersion(result.stdout) : undefined
  }

  private async readStatus(): Promise<AglStatusJson> {
    const result = await this.agl(['status', '--json'], 20_000)
    if (result.code !== 0) throw new Error(`agl status failed: ${output(result)}`)
    this.status = parseAglStatus(result.stdout)
    return this.status
  }

  /** Runs every step once; concurrent calls share one run. */
  refresh(): Promise<AglStatusView> {
    if (!this.supported || this.disposed) return Promise.resolve(this.view())
    this.refreshing ??= this.ensure().catch((error) => {
      this.error = message(error)
      if (this.state === 'starting') this.state = 'error'
      this.log('agl.error', this.error)
    }).then(() => {
      this.refreshing = undefined
      this.emit()
      return this.view()
    })
    this.emit()
    return this.refreshing
  }

  private async ensure(): Promise<void> {
    const options = this.options
    this.error = undefined
    // 1. The binary: the bundled agl goes into <home>/bin/agl only when that is missing or older.
    this.bundledVersion = options.bundledBin && await options.fileExists(options.bundledBin) ? await this.version(options.bundledBin) : undefined
    const exists = await options.fileExists(this.binary)
    this.binaryVersion = exists ? await this.version(this.binary) : undefined
    if (shouldInstallBundled({ exists, version: this.binaryVersion }, this.bundledVersion)) {
      this.log('agl.install-binary', `${this.binaryVersion ?? 'none'} -> ${this.bundledVersion}`)
      await options.installBinary(options.bundledBin!, this.binary)
      this.binaryVersion = await this.version(this.binary)
    }
    if (!(await options.fileExists(this.binary))) {
      this.state = 'not-installed'
      throw new Error('agl is not installed and this build of Douchat does not include it.')
    }
    if (exists && !this.binaryVersion) this.log('agl.unknown-binary', `${this.binary} does not report a version; it is left as it is`)

    // 2. The daemon.
    let status = await this.readStatus()
    const action = planDaemon(status, this.binaryVersion, options.defaultHome)
    if (action !== 'none') this.log('agl.daemon', action)
    if (action === 'service-install') await this.must(['service', 'install'], 60_000)
    else if (action === 'service-start') await this.startService()
    else if (action === 'start') await this.must(['start'], 30_000)
    else if (action === 'restart') {
      await this.must(['stop'], 30_000)
      await this.must(['start'], 30_000)
    }
    if (action === 'defer') this.retryLater(10 * 60_000)
    if (action !== 'none' && action !== 'defer') status = await this.waitForDaemon()
    if (!status.running) {
      this.state = 'stopped'
      throw new Error('The agl daemon did not start. See agl.log in the agl folder.')
    }

    // 3. The connection, and what the daemon must support.
    const connection = await this.connected()
    const pong = await connection.call<{ version?: string; protocol?: number }>('ping')
    this.daemonVersion = parseAglVersion(pong?.version) ?? status.daemonVersion
    if (pong?.protocol !== AGL_PROTOCOL || !meetsMinimum(this.daemonVersion)) {
      this.state = 'needs-update'
      this.error = pong?.protocol !== AGL_PROTOCOL
        ? `This agl speaks protocol ${pong?.protocol ?? 0}; Douchat needs protocol ${AGL_PROTOCOL}.`
        : `agl ${this.daemonVersion ?? '?'} is older than ${AGL_MIN_VERSION}, which Douchat needs.`
      // Let agl update itself now rather than in 12 hours.
      if (!this.updating) setTimeout(() => void this.checkForUpdates(true), 0).unref?.()
      return
    }
    this.state = 'running'

    // 4. Douchat's CLI folders, so agl finds agents Douchat installed.
    await this.ensureExtraPaths()
  }

  private async must(args: string[], timeoutMs: number): Promise<void> {
    const result = await this.agl(args, timeoutMs)
    if (result.code !== 0) throw new Error(`agl ${args.join(' ')} failed: ${output(result)}`)
  }

  /** Asks the installed service to start its daemon; `agl start` if it does not (agl allows one daemon per home). */
  private async startService(): Promise<void> {
    const command = this.options.serviceStartCommand?.()
    if (command) {
      await this.options.run(command.file, command.args, { env: await this.env(), timeoutMs: 15_000 }).catch(() => undefined)
      if ((await this.waitForDaemon(Math.min(this.options.startWaitMs ?? 10_000, 5_000))).running) return
    }
    await this.must(['start'], 30_000)
  }

  private async waitForDaemon(ms = this.options.startWaitMs ?? 10_000): Promise<AglStatusJson> {
    const sleep = this.options.sleep ?? ((delay: number) => new Promise<void>(resolve => setTimeout(resolve, delay)))
    const deadline = (this.options.now ?? Date.now)() + ms
    for (;;) {
      const status = await this.readStatus()
      if (status.running || (this.options.now ?? Date.now)() >= deadline) return status
      await sleep(250)
    }
  }

  private async connected(): Promise<AglDaemonConnection> {
    if (this.connection) return this.connection
    let timer: ReturnType<typeof setTimeout> | undefined
    const connection = await Promise.race([
      this.options.connect(this.options.home),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Could not connect to the agl daemon.')), 15_000) })
    ]).finally(() => clearTimeout(timer))
    this.connection = connection
    this.connectionOff = connection.onConnection(event => this.connectionChanged(event))
    return connection
  }

  private connectionChanged(event: ConnectionEvent): void {
    if (this.disposed) return
    if (event.state === 'disconnected') {
      this.log('agl.disconnected')
      if (this.state === 'running') this.state = 'stopped'
      this.emit()
      // The client reconnects by itself, but nothing restarts a daemon that is gone.
      this.retryLater(5_000, true)
      return
    }
    this.log('agl.reconnected', event.restarted ? 'restarted' : 'same daemon')
    if (event.restarted !== false) for (const listener of this.restartListeners) {
      try { listener() } catch { /* A listener never breaks the lifecycle. */ }
    }
    // A restarted daemon may be a new version: check it again.
    void this.refresh()
  }

  /** Runs every step again after `ms` (only if the daemon is still not running, with `unlessRunning`). */
  private retryLater(ms: number, unlessRunning = false): void {
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = setTimeout(() => { if (!unlessRunning || this.state !== 'running') void this.refresh() }, ms)
    this.recoveryTimer.unref?.()
  }

  /** Keeps Douchat's CLI folders in `extra_paths`, and has the daemon re-read its config when they change. */
  async ensureExtraPaths(): Promise<void> {
    const wanted = this.options.extraPaths()
    if (!wanted.length) return
    const result = await (this.options.ensureExtraPaths ?? ensureExtraPathsInFile)(this.options.home, wanted, this.options.ownedRoot)
    if (result?.changed) {
      this.log('agl.extra-paths', result.extraPaths.join(':'))
      await this.connection?.call('env.reload')
    }
  }

  /** After Douchat installed or updated a CLI: let agl look for agents again. */
  async reloadEnvironment(): Promise<void> {
    if (this.state !== 'running') return
    await this.ensureExtraPaths().catch(error => this.log('agl.extra-paths-failed', message(error)))
    await this.connection?.call('env.reload').catch(error => this.log('agl.env-reload-failed', message(error)))
  }

  /**
   * `agl update --check --json`, then, when a release is available and
   * `apply`, `agl update --if-idle --json`, which waits while any session runs
   * a turn. agl replaces `<home>/bin/agl` with the verified release and
   * restarts its daemon; the client reconnects by itself.
   */
  checkForUpdates(apply = true): Promise<AglStatusView> {
    if (!this.supported || this.disposed) return Promise.resolve(this.view())
    this.updating ??= (async () => {
      this.emit()
      if (!(await this.options.fileExists(this.binary))) return
      const now = this.options.now ?? Date.now
      const check = await this.agl(['update', '--check', '--json'], 60_000)
      if (check.code !== 0) throw new Error(`Could not check for agl updates: ${output(check)}`)
      const checked = parseAglUpdate(check.stdout)
      this.update = { ...this.update, checkedAt: now(), latest: checked.latest, available: checked.updateAvailable, error: undefined, busy: undefined }
      if (!checked.updateAvailable || !apply) return
      if (!canApplyUpdates(this.options.defaultHome, this.status)) {
        this.log('agl.update-skipped', 'a custom agl home with the per-user service installed: check only')
        return
      }
      this.log('agl.update', `${checked.current ?? '?'} -> ${checked.latest ?? '?'}`)
      const applied = await this.agl(['update', '--if-idle', '--json'], 5 * 60_000)
      if (applied.code !== 0) throw new Error(`agl update failed: ${output(applied)}`)
      const result = parseAglUpdate(applied.stdout)
      if (result.updated) this.update = { ...this.update, available: false, appliedAt: now(), appliedVersion: result.latest }
      else if (result.busy) this.update = { ...this.update, busy: result.busy }
    })().catch((error) => {
      this.update = { ...this.update, checkedAt: (this.options.now ?? Date.now)(), error: message(error) }
      this.log('agl.update-failed', message(error))
    }).then(async () => {
      this.updating = undefined
      // An update replaced the binary and restarted the daemon: read everything again.
      if (this.update.appliedAt && this.update.appliedVersion !== this.binaryVersion) await this.refresh()
      this.emit()
      return this.view()
    })
    return this.updating
  }

  /** `agl connect <hub> --code <code> --transport http`: links this machine to a hub. The code is never logged. */
  async connectHub(hubUrl: string, code: string): Promise<void> {
    const result = await this.agl(['connect', hubUrl, '--code', code, '--transport', 'http'], 60_000)
    if (result.code !== 0) throw new Error(`agl connect failed: ${output(result).replaceAll(code, '…')}`)
    await this.readStatus().catch(() => undefined)
    this.emit()
  }

  /** `agl disconnect <hub>`: unlinks this machine from that hub only. */
  async disconnectHub(hubUrl: string): Promise<void> {
    const result = await this.agl(['disconnect', hubUrl], 30_000)
    if (result.code !== 0) throw new Error(`agl disconnect failed: ${output(result)}`)
    await this.readStatus().catch(() => undefined)
    this.emit()
  }

  /** Re-reads `agl status --json` without changing anything. */
  async readOnlyStatus(): Promise<AglStatusJson | undefined> {
    if (!this.supported) return undefined
    return this.readStatus().catch(() => this.status)
  }

  setLinkError(error: string | undefined): void {
    if (this.linkError === error) return
    this.linkError = error
    this.emit()
  }

  /** Stops watching agl. The shared daemon keeps running: other products and the hub use it. */
  dispose(): void {
    this.disposed = true
    clearTimeout(this.updateTimer)
    clearTimeout(this.recoveryTimer)
    this.connectionOff?.()
    this.connection?.close()
    this.connection = undefined
  }
}
