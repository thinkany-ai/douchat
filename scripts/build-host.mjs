// Builds a douchat-host release (remote-connections.md 11):
//
//   host/dist/latest.txt                  newest version (never cached)
//   host/dist/install.sh                  installer the install command pipes to sh (short cache)
//   host/dist/<version>/install.sh        immutable
//   host/dist/<version>/douchat-host.mjs  immutable
//   host/dist/<version>/manifest.json     { version, sha256, installSha256, minNode, builtAt }
//
//   node scripts/build-host.mjs [--publish <dir>]
//
// --publish copies the tree into <dir>, e.g. ../douchat-tanstack/public/host
// for local testing (served at http://localhost:3000/host).
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'host', 'dist')
const args = process.argv.slice(2)
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

const version = /export const HOST_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'host', 'src', 'cli.ts'), 'utf8'))?.[1]
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(version)) throw new Error('HOST_VERSION not found in host/src/cli.ts')

rmSync(dist, { recursive: true, force: true })
const out = join(dist, version)
mkdirSync(out, { recursive: true })
await build({
  entryPoints: [join(root, 'host', 'src', 'cli.ts')],
  outfile: join(out, 'douchat-host.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'warning'
})
// The host runs the desktop's agent runtime; it must not pull in Electron.
if (/(?:from|require\()\s*["']electron["']/.test(readFileSync(join(out, 'douchat-host.mjs'), 'utf8')))
  throw new Error('douchat-host bundle imports electron')
for (const target of [join(out, 'install.sh'), join(dist, 'install.sh')]) {
  copyFileSync(join(root, 'host', 'install.sh'), target)
  chmodSync(target, 0o755)
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify({
  version,
  sha256: sha256(readFileSync(join(out, 'douchat-host.mjs'))),
  installSha256: sha256(readFileSync(join(out, 'install.sh'))),
  minNode: 20,
  builtAt: new Date().toISOString()
}, null, 2) + '\n')
writeFileSync(join(dist, 'latest.txt'), `${version}\n`)
console.log(`douchat-host ${version} → ${dist}`)

const at = args.indexOf('--publish')
if (at >= 0) {
  if (!args[at + 1]) throw new Error('--publish needs a directory')
  const target = resolve(args[at + 1])
  mkdirSync(target, { recursive: true })
  cpSync(dist, target, { recursive: true })
  console.log(`published to ${target}`)
}
