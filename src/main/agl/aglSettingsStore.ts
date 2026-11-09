import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { aglSettings, type AglSettings } from '../../shared/agl'

/** The settings the UI may change. */
const USER_SETTINGS = new Set(['enabled', 'autoLink', 'useForLocalAgents'])
const ACCOUNT_ID = /^[\w.:@-]{1,200}$/

/**
 * agl settings of this computer, in `<userData>/agl-settings.json`. Besides
 * the switches the UI shows, the file may name an agl `home` (a developer
 * override, like DOUCHAT_AGL_HOME; read at startup only), and records which
 * Douchat account this computer's agl link was made for (`linkedAccount`).
 */
export class AglSettingsStore {
  private value: AglSettings
  private account?: string
  readonly home?: string

  constructor(private readonly file: string) {
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { raw = undefined }
    this.value = aglSettings(raw)
    const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (typeof record.home === 'string' && record.home.trim()) this.home = record.home.trim()
    if (typeof record.linkedAccount === 'string' && ACCOUNT_ID.test(record.linkedAccount)) this.account = record.linkedAccount
  }

  get(): AglSettings { return { ...this.value } }

  /** The Douchat account the agl link of this computer was made for, if Douchat made it. */
  get linkedAccount(): string | undefined { return this.account }

  async save(patch: unknown): Promise<AglSettings> {
    const input = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {}
    const next = aglSettings({ ...this.value, ...Object.fromEntries(Object.entries(input).filter(([key]) => USER_SETTINGS.has(key))) })
    await this.write(next, this.account)
    this.value = next
    return this.get()
  }

  async setLinkedAccount(account: string | undefined): Promise<void> {
    const value = account && ACCOUNT_ID.test(account) ? account : undefined
    if (value === this.account) return
    await this.write(this.value, value)
    this.account = value
  }

  private async write(settings: AglSettings, account: string | undefined): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify({ ...settings, ...(this.home ? { home: this.home } : {}), ...(account ? { linkedAccount: account } : {}) }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
  }
}
