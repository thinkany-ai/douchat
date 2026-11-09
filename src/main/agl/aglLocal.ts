import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { LocalAgentImage } from '../../shared/agentExecutor'
import { AglClient, type CreateSession, type SessionMeta } from './aglClient'
import type { AglLocalExecutorOptions } from './aglLocalExecutor'
import type { AglCommandResult, AglDaemonConnection, AglRunner } from './aglLifecycle'

/** The user's real, shared agl home. */
export const defaultAglHome = (): string => join(homedir(), '.agl')

/**
 * The agl home Douchat manages. One setting decides it: DOUCHAT_AGL_HOME,
 * else the saved `home` setting, else ~/.agl. A development run without an
 * explicit home is disabled, so trying the app never touches the shared ~/.agl
 * (set DOUCHAT_AGL_HOME=~/.agl to opt in on purpose).
 */
export function resolveAglHome(input: { env?: string; setting?: string; development: boolean; platform: NodeJS.Platform }): { home: string; defaultHome: boolean; enabled: boolean } {
  const chosen = input.env?.trim() || input.setting?.trim()
  const expanded = chosen?.startsWith('~/') ? join(homedir(), chosen.slice(2)) : chosen === '~' ? homedir() : chosen
  const home = expanded ? resolve(expanded) : defaultAglHome()
  return { home, defaultHome: home === resolve(defaultAglHome()), enabled: input.platform !== 'win32' && (!input.development || Boolean(chosen)) }
}

/** The agl that ships with the app: DOUCHAT_AGL_BIN, else <resources>/bin/agl (packaged) or resources/bin/<target>/agl (development). */
export function bundledAglPath(input: { env?: string; packaged: boolean; resourcesPath: string; appPath: string; platform: NodeJS.Platform; arch: string }): string | undefined {
  if (input.env?.trim()) return resolve(input.env.trim())
  if (input.platform === 'win32') return undefined
  if (input.packaged) return join(input.resourcesPath, 'bin', 'agl')
  const os = input.platform === 'darwin' ? 'darwin' : input.platform === 'linux' ? 'linux' : undefined
  return os ? join(input.appPath, 'resources', 'bin', `${os}-${input.arch}`, 'agl') : undefined
}

export const runAgl: AglRunner = (file, args, options) => new Promise<AglCommandResult>((done) => {
  execFile(file, args, { env: options.env, timeout: options.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    const code = error ? typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : null : 0
    done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error && code === null ? error.message : '') })
  })
})

export async function fileExists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true } catch { return false }
}

/**
 * Copies the bundled agl to `to` the way `agl update` replaces itself: into a
 * temporary file in the same directory, made executable, then renamed over the
 * old one, so a running daemon keeps its copy and nobody sees half a binary.
 * On macOS the quarantine attribute a downloaded app carries is removed from
 * the copy, since launchd runs it outside the app.
 */
export async function installAglBinary(from: string, to: string, run: AglRunner = runAgl): Promise<void> {
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(to), `.agl.douchat-${randomBytes(6).toString('hex')}`)
  try {
    await copyFile(from, temporary)
    await chmod(temporary, 0o755)
    if (process.platform === 'darwin') await run('/usr/bin/xattr', ['-d', 'com.apple.quarantine', temporary], { env: {}, timeoutMs: 10_000 })
    const check = await run(temporary, ['--version'], { env: {}, timeoutMs: 10_000 })
    if (check.code !== 0) throw new Error(`the bundled agl does not run here: ${(check.stderr || check.stdout).trim().slice(0, 200)}`)
    await rename(temporary, to)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** The command that makes the installed per-user service start its daemon now. */
export function serviceStartCommand(platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | undefined {
  if (platform === 'darwin') return { file: '/bin/launchctl', args: ['kickstart', `gui/${userInfo().uid}/cc.agl.daemon`] }
  if (platform === 'linux') return { file: 'systemctl', args: ['--user', 'start', 'agl.service'] }
  return undefined
}

/** Connects to the daemon of `home` with the vendored client; it re-reads daemon.json before every reconnect. */
export async function connectAgl(home: string): Promise<AglClient & AglDaemonConnection> {
  return AglClient.local(home)
}

/**
 * Settings every session the desktop creates on the local daemon gets: no hub
 * link ever sees it (even one linked with `share_local`), and agl keeps no
 * history of it on disk, since Douchat prompts carry memory and identity.
 */
export function localSessionParams(params: CreateSession): CreateSession {
  return { ...params, visibility: 'local', history: false }
}

/** Creates a session on the local daemon, always local-only (see {@link localSessionParams}). */
export function createLocalSession(client: Pick<AglClient, 'createSession'>, params: CreateSession): Promise<SessionMeta> {
  return client.createSession(localSessionParams(params))
}

/** The folders and files the local agl executor works with, as the desktop runtime lays them out. */
export const aglLocalFiles: Pick<AglLocalExecutorOptions, 'scratch' | 'writeImage' | 'inputFolder'> = {
  scratch: async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douchat-session-'))
    return { directory, remove: () => rm(directory, { recursive: true, force: true }) }
  },
  writeImage: async (directory: string, image: LocalAgentImage) => {
    const path = join(directory, `input-${randomBytes(12).toString('hex')}.${image.mimeType.split('/')[1]}`)
    await writeFile(path, image.data, { mode: 0o600 })
    return path
  },
  inputFolder: async (directory: string) => {
    const folder = join(directory, `.douchat-input-${randomBytes(12).toString('hex')}`)
    await mkdir(folder, { mode: 0o700 })
    return { directory: folder, remove: () => rm(folder, { recursive: true, force: true }) }
  }
}
