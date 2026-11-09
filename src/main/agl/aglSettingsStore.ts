import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { aglSettings, type AglSettings } from '../../shared/agl'

/**
 * agl settings of this computer, in `<userData>/agl-settings.json`. Besides
 * the switches the UI shows, the file may name an agl `home` (a developer
 * override, like DOUCHAT_AGL_HOME); it is read at startup only.
 */
export class AglSettingsStore {
  private value: AglSettings
  readonly home?: string

  constructor(private readonly file: string) {
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { raw = undefined }
    this.value = aglSettings(raw)
    const home = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).home : undefined
    if (typeof home === 'string' && home.trim()) this.home = home.trim()
  }

  get(): AglSettings { return { ...this.value } }

  async save(patch: unknown): Promise<AglSettings> {
    const input = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {}
    const next = aglSettings({ ...this.value, ...Object.fromEntries(Object.entries(input).filter(([key]) => key === 'autoLink' || key === 'useForLocalAgents')) })
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify({ ...next, ...(this.home ? { home: this.home } : {}) }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
    this.value = next
    return this.get()
  }
}
