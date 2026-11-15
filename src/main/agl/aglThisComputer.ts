import type { AglSettings, AglStatusView } from '../../shared/agl'
import type { AglPairing } from '../../shared/types'
import type { AglHubLink } from './aglStatus'

export type LinkDecision =
  | { action: 'link' }
  | { action: 'none'; reason: 'unsupported' | 'off' | 'disabled' | 'signed-out' | 'not-running' | 'no-machine' | 'linked' }

/**
 * Whether to link this computer to the signed-in account now: only with agl
 * turned on and the setting on, while signed in, with agl running and its
 * machine id known, and when agl has no link to the Douchat hub yet. A link
 * that exists but no longer works (`unauthorized`: the device was removed
 * from an account) is left alone, since relinking would undo the user's
 * choice; "Re-link" does it on request.
 */
export function linkDecision(input: { settings: Pick<AglSettings, 'autoLink'>; signedIn: boolean; view: Pick<AglStatusView, 'state' | 'machineId' | 'linked'> }): LinkDecision {
  if (input.view.state === 'unsupported' || input.view.state === 'disabled') return { action: 'none', reason: 'unsupported' }
  if (input.view.state === 'off') return { action: 'none', reason: 'off' }
  if (!input.settings.autoLink) return { action: 'none', reason: 'disabled' }
  if (!input.signedIn) return { action: 'none', reason: 'signed-out' }
  if (input.view.state !== 'running') return { action: 'none', reason: 'not-running' }
  if (!input.view.machineId) return { action: 'none', reason: 'no-machine' }
  if (input.view.linked) return { action: 'none', reason: 'linked' }
  return { action: 'link' }
}

/**
 * Who the existing link belongs to: the account Douchat recorded when it made
 * the link, else (a link made by the install command, or before Douchat
 * recorded it) whether the signed-in account lists this machine. Only a link
 * that works (`connected`) can be judged that way: the service lists no
 * machine whose link it revoked.
 */
export function linkOwner(input: { recorded?: string; account: string; link: Pick<AglHubLink, 'status'>; listed?: boolean }): 'this-account' | 'other-account' | 'unknown' {
  if (input.recorded) return input.recorded === input.account ? 'this-account' : 'other-account'
  if (input.listed === undefined) return 'unknown'
  if (input.listed) return 'this-account'
  return input.link.status === 'connected' ? 'other-account' : 'unknown'
}

export interface ThisComputerDependencies {
  lifecycle: {
    view(): AglStatusView
    /** The link to the Douchat hub, from the last `agl status --json`. */
    douchatLink(): AglHubLink | undefined
    connectHub(hubUrl: string, code: string, options?: { appName?: string }): Promise<void>
    disconnectHub(hubUrl: string): Promise<void>
    setLinkError(error: string | undefined): void
  }
  /** The desktop action `agl-pairing-create`, as the signed-in account. */
  createPairing: () => Promise<AglPairing>
  settings: () => AglSettings
  /** The signed-in account, if any. */
  account: () => string | undefined
  /** The account Douchat last linked this computer for (persisted). */
  linkedAccount: () => string | undefined
  rememberLinkedAccount: (account: string | undefined) => Promise<void>
  /** Whether the signed-in account lists this machine; undefined when that cannot be told now. */
  listedForAccount?: (machineId: string) => Promise<boolean | undefined>
  /** Right before this computer's link is removed (account switch, Re-link): drop its agent bindings on the service. Never throws. */
  beforeUnlink?: () => Promise<void>
  /** After a successful link (or unlink): refresh the device list. */
  linked?: () => void
  now?: () => number
  log?: (event: string, detail?: string) => void
}

/** The product name agl runs this computer's hub sessions under (`agl connect --app-name`). */
export const DOUCHAT_APP_NAME = 'Douchat'

/** After a failed attempt, wait this long before trying again for the same account. */
export const LINK_RETRY_MS = 10 * 60_000

/**
 * Links this computer to the Douchat service through agl, the same link the
 * `curl … | sh` install command makes: a one-time pairing code minted with
 * the signed-in session, then `agl connect <hub> --code <code> --transport
 * http --app-name Douchat`. The machine then shows up in Devices, where it is "This computer".
 *
 * One account per link: when another account signs in, the link made for the
 * previous one is removed (`agl disconnect <hub>`) and, with the setting on,
 * a link for the new account is made.
 */
export class ThisComputerLinker {
  private running?: Promise<boolean>
  private failedAt = new Map<string, number>()
  constructor(private readonly deps: ThisComputerDependencies) {}

  /** Links if {@link linkDecision} says so; true when this call linked the machine. Never throws. */
  maybeLink(): Promise<boolean> {
    this.running ??= this.attempt().finally(() => { this.running = undefined })
    return this.running
  }

  /**
   * "Re-link": on request, whatever happened before. Removes the link agl
   * has to the Douchat hub (one that stopped working, or another account's)
   * and links again for the signed-in account. Throws what went wrong.
   */
  async relink(): Promise<void> {
    await this.running?.catch(() => undefined)
    const account = this.deps.account()
    if (!account) throw new Error('Sign in first.')
    const view = this.deps.lifecycle.view()
    if (view.state === 'off') throw new Error('Turn on agl first.')
    if (view.state !== 'running' || !view.machineId) throw new Error('agl is not running on this computer.')
    this.failedAt.delete(account)
    const work = (async () => {
      const link = this.deps.lifecycle.douchatLink()
      if (link) await this.unlink(link)
      const error = await this.link(account)
      if (error) throw new Error(error)
      return true
    })()
    // Automatic attempts wait for this one.
    let tracked: Promise<boolean> | undefined
    tracked = this.running = work.then(() => true, () => false).finally(() => { if (this.running === tracked) this.running = undefined })
    await work
  }

  private async attempt(): Promise<boolean> {
    const account = this.deps.account()
    const view = this.deps.lifecycle.view()
    if (!account || view.state !== 'running') return this.decide(account, view)
    const link = this.deps.lifecycle.douchatLink()
    if (link && view.linked) {
      const listed = this.deps.linkedAccount() ? undefined : await this.deps.listedForAccount?.(view.machineId ?? '').catch(() => undefined)
      const owner = linkOwner({ recorded: this.deps.linkedAccount(), account, link, listed })
      if (owner === 'this-account' && !this.deps.linkedAccount()) await this.deps.rememberLinkedAccount(account).catch(() => undefined)
      if (owner === 'other-account') {
        // Never leave this computer reachable from an account that is no longer signed in here.
        try { await this.unlink(link) } catch (error) {
          this.report(error)
          return false
        }
        this.deps.linked?.()
      }
    }
    return this.decide(account, this.deps.lifecycle.view())
  }

  private async decide(account: string | undefined, view: AglStatusView): Promise<boolean> {
    const decision = linkDecision({ settings: this.deps.settings(), signedIn: Boolean(account), view })
    if (decision.action !== 'link' || !account) {
      if (decision.action === 'none' && (decision.reason === 'linked' || decision.reason === 'disabled' || decision.reason === 'off')) this.deps.lifecycle.setLinkError(undefined)
      return false
    }
    const now = this.deps.now ?? Date.now
    const failed = this.failedAt.get(account)
    if (failed !== undefined && now() - failed < LINK_RETRY_MS) return false
    return !(await this.link(account))
  }

  private async unlink(link: AglHubLink): Promise<void> {
    this.deps.log?.('agl.unlink', link.url)
    await this.deps.beforeUnlink?.().catch(() => undefined)
    await this.deps.lifecycle.disconnectHub(link.url)
    await this.deps.rememberLinkedAccount(undefined).catch(() => undefined)
  }

  /** Links for `account`; the error text when it failed. */
  private async link(account: string): Promise<string | undefined> {
    const now = this.deps.now ?? Date.now
    try {
      const pairing = await this.deps.createPairing()
      if (!pairing?.code || !pairing.hubUrl) throw new Error('The Douchat service did not return a pairing code.')
      this.deps.log?.('agl.link', pairing.hubUrl)
      // Agents the service starts on this computer run as Douchat (macOS privacy prompts name it).
      await this.deps.lifecycle.connectHub(pairing.hubUrl, pairing.code, { appName: DOUCHAT_APP_NAME })
      this.failedAt.delete(account)
      await this.deps.rememberLinkedAccount(account).catch(() => undefined)
      this.deps.lifecycle.setLinkError(undefined)
      this.deps.linked?.()
      return undefined
    } catch (error) {
      this.failedAt.set(account, now())
      return this.report(error)
    }
  }

  private report(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error)
    this.deps.log?.('agl.link-failed', text)
    this.deps.lifecycle.setLinkError(text)
    return text
  }
}
