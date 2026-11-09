#!/usr/bin/env node
/**
 * Puts the pinned agl release binary for each packaging target under
 * resources/bin/<target>/agl, where electron-builder's `extraResources` picks
 * it up (package.json "build.mac" / "build.linux") and ships it as
 * <resources>/bin/agl. On macOS, @electron/osx-sign signs every Mach-O file in
 * the bundle, so the sidecar gets the app's identity and hardened runtime and
 * is notarized with the app.
 *
 * The version is pinned once, in package.json "agl.version". Override it with
 * DOUCHAT_AGL_VERSION. The release must exist on
 * https://github.com/thinkany-ai/agl/releases before packaging: this script
 * downloads `agl-<target>` and `agl-<target>.sha256` from `v<version>` and
 * refuses a binary whose sha256 does not match.
 *
 * Unreleased agl (development only): DOUCHAT_AGL_BIN=/path/to/agl copies that
 * binary for the host's own target instead of downloading. Refused with
 * --release, so a signed release never ships an unverified binary.
 *
 * Usage:
 *   node scripts/fetch-agl.mjs                      # the host's target
 *   node scripts/fetch-agl.mjs --platform mac       # darwin-arm64 + darwin-x64
 *   node scripts/fetch-agl.mjs --platform linux     # linux-x64 + linux-arm64
 *   node scripts/fetch-agl.mjs --targets darwin-arm64,linux-x64 [--release]
 *
 * Windows is not supported by agl; asking for it is a no-op.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RELEASES = (process.env.AGL_RELEASES_BASE || 'https://github.com/thinkany-ai/agl/releases').replace(/\/+$/, '')
export const AGL_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']
const PLATFORM_TARGETS = { mac: ['darwin-arm64', 'darwin-x64'], darwin: ['darwin-arm64', 'darwin-x64'], linux: ['linux-x64', 'linux-arm64'], win: [], win32: [], windows: [] }

/** The target this machine runs, as agl's releases name it; undefined on Windows. */
export function hostTarget(platform = process.platform, arch = process.arch) {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined
  return os && cpu ? `${os}-${cpu}` : undefined
}

export function parseArgs(argv) {
  const options = { release: false, targets: undefined }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--release') options.release = true
    else if (arg === '--platform') {
      const value = argv[++index]
      if (!(value in PLATFORM_TARGETS)) throw new Error(`unknown --platform ${value}`)
      options.targets = PLATFORM_TARGETS[value]
    } else if (arg === '--targets') {
      options.targets = String(argv[++index] ?? '').split(',').map(item => item.trim()).filter(Boolean)
      for (const target of options.targets) if (!AGL_TARGETS.includes(target)) throw new Error(`unknown agl target ${target}`)
    } else throw new Error(`unknown argument ${arg}`)
  }
  if (!options.targets) options.targets = hostTarget() ? [hostTarget()] : []
  return options
}

export async function pinnedVersion() {
  const fromEnv = process.env.DOUCHAT_AGL_VERSION?.trim().replace(/^v/, '')
  if (fromEnv) return fromEnv
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const version = pkg.agl?.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json "agl.version" must pin an agl release, e.g. "0.3.12"')
  return version
}

/** The first hex token of a `.sha256` file (`<hex>  agl-<target>` or just `<hex>`). */
export function parseChecksum(text) {
  const token = String(text).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('the .sha256 file holds no sha256')
  return token
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function download(url) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'douchat-fetch-agl' } })
  if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}${response.status === 404 ? ' (is this agl version released?)' : ''}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Writes the binary next to its destination, then renames it into place. */
async function place(target, bytes, version) {
  const directory = join(root, 'resources', 'bin', target)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `.agl.${process.pid}.tmp`)
  await writeFile(temporary, bytes, { mode: 0o755 })
  await chmod(temporary, 0o755)
  await rename(temporary, join(directory, 'agl'))
  await writeFile(join(directory, 'VERSION'), `${version}\n${sha256(bytes)}\nrelease\n`)
}

async function alreadyThere(target, version) {
  try {
    // Only a verified release download counts; a DOUCHAT_AGL_BIN copy is always replaced.
    const [recorded, digest, source] = (await readFile(join(root, 'resources', 'bin', target, 'VERSION'), 'utf8')).trim().split('\n')
    return recorded === version && source === 'release' && digest === sha256(await readFile(join(root, 'resources', 'bin', target, 'agl')))
  } catch { return false }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.targets.length) {
    console.log('fetch-agl: agl has no Windows build; nothing to bundle')
    return
  }
  const local = process.env.DOUCHAT_AGL_BIN?.trim()
  if (local) {
    if (options.release) throw new Error('DOUCHAT_AGL_BIN is for development builds; a release bundles the published, checksum-verified agl')
    const host = hostTarget()
    if (options.targets.length !== 1 || options.targets[0] !== host) throw new Error(`DOUCHAT_AGL_BIN only stands in for this machine's target (${host}); pass --targets ${host}`)
    const printed = execFileSync(local, ['--version'], { encoding: 'utf8' }).trim()
    const version = printed.replace(/^agl\s+/, '')
    const directory = join(root, 'resources', 'bin', host)
    await mkdir(directory, { recursive: true })
    await rm(join(directory, 'agl'), { force: true })
    await copyFile(local, join(directory, 'agl'))
    await chmod(join(directory, 'agl'), 0o755)
    await writeFile(join(directory, 'VERSION'), `${version}\n${sha256(await readFile(local))}\nlocal\n`)
    console.warn(`fetch-agl: using the local, unverified ${printed} from DOUCHAT_AGL_BIN for ${host} (development only)`)
    return
  }
  const version = await pinnedVersion()
  for (const target of options.targets) {
    if (await alreadyThere(target, version)) {
      console.log(`fetch-agl: agl ${version} for ${target} is already in resources/bin`)
      continue
    }
    const url = `${RELEASES}/download/v${version}/agl-${target}`
    const [binary, sum] = await Promise.all([download(url), download(`${url}.sha256`)])
    const want = parseChecksum(sum.toString('utf8'))
    const got = sha256(binary)
    if (want !== got) throw new Error(`checksum mismatch for ${url}: expected ${want}, got ${got}`)
    await place(target, binary, version)
    if (target === hostTarget()) {
      const printed = execFileSync(join(root, 'resources', 'bin', target, 'agl'), ['--version'], { encoding: 'utf8' }).trim()
      if (!printed.includes(version)) throw new Error(`the downloaded agl reports "${printed}", expected ${version}`)
    }
    console.log(`fetch-agl: agl ${version} for ${target} verified (sha256 ${got.slice(0, 12)}…)`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`fetch-agl: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  })
}
