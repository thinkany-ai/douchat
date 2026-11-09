import { randomBytes } from 'node:crypto'
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'

/** Whether `path` is `root` or inside it. */
function within(path: string, root: string): boolean {
  const offset = relative(root, path)
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

/**
 * `$AGL_HOME/config.json` with Douchat's CLI directories in `extra_paths`.
 *
 * Conservative by design, since other products share this file: only
 * `extra_paths` changes, every other key (hubs and their tokens, custom
 * agents, other products' settings) is kept as it is, other products'
 * `extra_paths` entries are kept in order, and the only entries removed are
 * stale ones inside `ownedRoot` (Douchat's own tool directory, e.g. an older
 * managed Node runtime). Returns `changed: false` when nothing needs writing.
 * Throws when the file is not a JSON object or `extra_paths` is not a list,
 * so a file it does not understand is never rewritten.
 */
export function mergeExtraPaths(text: string, wanted: string[], ownedRoot: string): { text: string; changed: boolean; extraPaths: string[] } {
  const data: unknown = JSON.parse(text)
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('agl config.json is not a JSON object')
  const config = data as Record<string, unknown>
  if (config.extra_paths !== undefined && !Array.isArray(config.extra_paths)) throw new Error('agl config.json has an extra_paths that is not a list')
  const existing = (config.extra_paths as unknown[] | undefined) ?? []
  const kept = existing.filter(entry => typeof entry !== 'string' || !isAbsolute(entry) || !within(entry, ownedRoot) || wanted.includes(entry))
  const next = [...kept, ...wanted.filter(entry => !kept.includes(entry))]
  const changed = next.length !== existing.length || next.some((entry, index) => entry !== existing[index])
  const extraPaths = next.filter((entry): entry is string => typeof entry === 'string')
  if (!changed) return { text, changed, extraPaths }
  config.extra_paths = next
  return { text: `${JSON.stringify(config, null, 2)}\n`, changed, extraPaths }
}

/**
 * Applies {@link mergeExtraPaths} to `<home>/config.json` in place: written
 * to a temporary file in the same directory (mode 0600, as agl keeps it, since
 * it holds hub tokens) and renamed over the original, so a reader never sees
 * half a file. If the file changed while merging (agl or another product wrote
 * it), the merge is redone on the new content. A missing file is left for agl
 * to create.
 */
export async function ensureExtraPaths(home: string, wanted: string[], ownedRoot: string): Promise<{ changed: boolean; extraPaths: string[] } | undefined> {
  const file = join(home, 'config.json')
  for (let attempt = 0; attempt < 3; attempt++) {
    let original: string
    try { original = await readFile(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const merged = mergeExtraPaths(original, wanted, ownedRoot)
    if (!merged.changed) return { changed: false, extraPaths: merged.extraPaths }
    const temporary = join(dirname(file), `.config.json.douchat-${randomBytes(6).toString('hex')}`)
    try {
      await writeFile(temporary, merged.text, { mode: 0o600 })
      await chmod(temporary, 0o600)
      if (await readFile(file, 'utf8') !== original) continue
      await rename(temporary, file)
      return { changed: true, extraPaths: merged.extraPaths }
    } finally {
      await rm(temporary, { force: true })
    }
  }
  throw new Error('agl config.json kept changing; extra_paths was not updated')
}
