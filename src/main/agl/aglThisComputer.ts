import type { AglSettings, AglStatusView } from '../../shared/agl'
import type { AglPairing } from '../../shared/types'

export type LinkDecision =
  | { action: 'link' }
  | { action: 'none'; reason: 'unsupported' | 'disabled' | 'signed-out' | 'not-running' | 'no-machine' | 'linked' }

/**
 * Whether to link this computer to the signed-in account now: only with the
 * setting on, while signed in, with agl running and its machine id known,
 * and when agl has no link to the Douchat hub yet. A link that exists but no
 * longer works (`unauthorized`: the device was removed from an account) is
 * left alone, since relinking would undo the user's choice.
 */
export function linkDecision(input: { settings: Pick<AglSettings, 'autoLink'>; signedIn: boolean; view: Pick<AglStatusView, 'state' | 'machineId' | 'linked'> }): LinkDecision {
  if (input.view.state === 'unsupported' || input.view.state === 'disabled') return { action: 'none', reason: 'unsupported' }
  if (!input.settings.autoLink) return { action: 'none', reason: 'disabled' }
  if (!input.signedIn) return { action: 'none', reason: 'signed-out' }
  if (input.view.state !== 'running') return { action: 'none', reason: 'not-running' }
  if (!input.view.machineId) return { action: 'none', reason: 'no-machine' }
  if (input.view.linked) return { action: 'none', reason: 'linked' }
  return { action: 'link' }
}

export interface ThisComputerDependencies {
  lifecycle: { view(): AglStatusView; connectHub(hubUrl: string, code: string): Promise<void>; setLinkError(error: string | undefined): void }
  /** The desktop action `agl-pairing-create`, as the signed-in account. */
  createPairing: () => Promise<AglPairing>
  settings: () => AglSettings
  /** The signed-in account, if any. */
  account: () => string | undefined
  /** After a successful link: refresh the device list. */
  linked?: () => void
  now?: () => number
  log?: (event: string, detail?: string) => void
}

/** After a failed attempt, wait this long before trying again for the same account. */
export const LINK_RETRY_MS = 10 * 60_000

/**
 * Links this computer to the Douchat service through agl, the same link the
 * `curl … | sh` install command makes: a one-time pairing code minted with
 * the signed-in session, then `agl connect <hub> --code <code> --transport
 * http`. The machine then shows up in Devices, where it is "This computer".
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

  private async attempt(): Promise<boolean> {
    const account = this.deps.account()
    const decision = linkDecision({ settings: this.deps.settings(), signedIn: Boolean(account), view: this.deps.lifecycle.view() })
    if (decision.action !== 'link' || !account) {
      if (decision.action === 'none' && (decision.reason === 'linked' || decision.reason === 'disabled')) this.deps.lifecycle.setLinkError(undefined)
      return false
    }
    const now = this.deps.now ?? Date.now
    const failed = this.failedAt.get(account)
    if (failed !== undefined && now() - failed < LINK_RETRY_MS) return false
    try {
      const pairing = await this.deps.createPairing()
      if (!pairing?.code || !pairing.hubUrl) throw new Error('The Douchat service did not return a pairing code.')
      this.deps.log?.('agl.link', pairing.hubUrl)
      await this.deps.lifecycle.connectHub(pairing.hubUrl, pairing.code)
      this.failedAt.delete(account)
      this.deps.lifecycle.setLinkError(undefined)
      this.deps.linked?.()
      return true
    } catch (error) {
      this.failedAt.set(account, now())
      const text = error instanceof Error ? error.message : String(error)
      this.deps.log?.('agl.link-failed', text)
      this.deps.lifecycle.setLinkError(text)
      return false
    }
  }
}
