import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

const CDN = 'https://cdn.douchat.ai/'

export function generateDownloadCatalog(feeds, macBase = `${CDN}thinkany/`) {
  const version = (feed) => {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(feed?.version ?? '')) {
      throw new Error('Invalid release version')
    }
    return feed.version
  }
  const file = (feed, name, base = CDN) => {
    const entry = feed.files?.find((entry) => {
      try { return new URL(entry.url, base).pathname.endsWith(`/${name}`) } catch { return false }
    })
    if (!entry) throw new Error(`Missing installer: ${name}`)
    const url = new URL(entry.url, base)
    if (url.origin !== new URL(CDN).origin || url.username || url.password || url.search || url.hash) {
      throw new Error(`Invalid installer URL: ${name}`)
    }
    return url.href
  }
  const mac = version(feeds.mac), windows = version(feeds.windows), linux = version(feeds.linux)
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    platforms: {
      mac: { version: mac, downloads: {
        arm64: file(feeds.mac, `Douchat-${mac}-mac-arm64.dmg`, macBase),
        x64: file(feeds.mac, `Douchat-${mac}-mac-x64.dmg`, macBase)
      } },
      windows: { version: windows, downloads: { x64: file(feeds.windows, `Douchat-${windows}-win-x64.exe`) } },
      linux: { version: linux, downloads: {
        appImage: file(feeds.linux, `Douchat-${linux}-linux-x86_64.AppImage`),
        deb: file(feeds.linux, `Douchat-${linux}-linux-amd64.deb`)
      } }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, output = path.join(directory ?? '.', 'latest.json')] = process.argv.slice(2)
  if (!directory) throw new Error('Usage: node scripts/generate-download-catalog.mjs <feed directory> [output]')
  const load = async (name) => parse(await readFile(path.join(directory, name), 'utf8'))
  const feeds = { mac: await load('latest-mac.yml'), windows: await load('latest.yml'), linux: await load('latest-linux.yml') }
  const prefix = (process.env.MAC_CDN_PREFIX ?? 'thinkany').replace(/^\/+|\/+$/g, '')
  const catalog = generateDownloadCatalog(feeds, `${CDN}${prefix ? `${prefix}/` : ''}`)
  await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`)
}
