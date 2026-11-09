import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { signAsync } from '@electron/osx-sign'

// Only the legacy-signed migration build uses this hook. Keep nested helpers'
// own identifiers and requirements; widen the main app to our two teams only.
export async function sign(options) {
  const requirements = await readFile(
    fileURLToPath(new URL('../resources/mac-bridge-requirements.txt', import.meta.url)),
    'utf8'
  )
  const originalOptionsForFile = options.optionsForFile
  await signAsync({
    ...options,
    optionsForFile(file) {
      const fileOptions = originalOptionsForFile?.(file) ?? {}
      return path.resolve(file) === path.resolve(options.app)
        ? { ...fileOptions, requirements: `=${requirements.trim()}` }
        : fileOptions
    }
  })
}
