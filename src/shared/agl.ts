/** The agl release whose features the desktop relies on (`visibility`, `extra_paths` + `env.reload`, `started_at`, `turn_ended.text`). */
export const AGL_MIN_VERSION = '0.3.12'
/** agl's wire protocol version this desktop speaks. */
export const AGL_PROTOCOL = 1

/**
 * Where the shared agl daemon on this computer stands:
 * - `unsupported`: Windows (agl has no Windows build); the desktop runtime is used.
 * - `disabled`: a development run without DOUCHAT_AGL_HOME (the shared ~/.agl is left alone).
 * - `starting`: checking, installing or starting.
 * - `not-installed`: no agl in the agl home and none bundled with the app.
 * - `needs-update`: the agl that runs is older than {@link AGL_MIN_VERSION} or speaks another protocol.
 * - `stopped`: agl is installed but its daemon is not running.
 * - `running`: connected to the daemon.
 * - `error`: the last attempt failed; `error` says why.
 */
export type AglState = 'unsupported' | 'disabled' | 'starting' | 'not-installed' | 'needs-update' | 'stopped' | 'running' | 'error'

export interface AglUpdateInfo {
  checkedAt?: number
  /** The newest agl release, from `agl update --check`. */
  latest?: string
  available?: boolean
  /** When `agl update --if-idle` last installed a release, and which. */
  appliedAt?: number
  appliedVersion?: string
  /** Sessions running a turn when an update was due: it waits for them. */
  busy?: number
  error?: string
}

export interface AglStatusView {
  state: AglState
  /** The agl home the desktop manages (~/.agl unless overridden). */
  home: string
  /** The agl in that home (`<home>/bin/agl --version`). */
  version?: string
  /** The version of the running daemon, when it differs from the binary or the binary is unknown. */
  daemonVersion?: string
  /** The agl shipped with this build of Douchat. */
  bundledVersion?: string
  minimumVersion: string
  running: boolean
  /** The autostart service (launchd / systemd --user) is installed. Only meaningful for the default home. */
  service?: boolean
  machineId?: string
  /** This computer is linked to the Douchat service (a hub entry for it in agl). */
  linked?: boolean
  /** That link's status as agl reports it, e.g. `connected` or `unauthorized`. */
  hubStatus?: string
  update: AglUpdateInfo
  /** A check or update is running now. */
  busy?: boolean
  error?: string
  /** Why linking this computer last failed. */
  linkError?: string
}

/** Machine-level settings for agl on this computer (not per account). */
export interface AglSettings {
  /** Link this computer to the signed-in Douchat account through agl, so it shows up in Devices. */
  autoLink: boolean
  /** Experimental: detect local agents and their models through agl instead of the desktop's own probes. */
  useForLocalAgents: boolean
}

export const DEFAULT_AGL_SETTINGS: AglSettings = { autoLink: true, useForLocalAgents: false }

export function aglSettings(value: unknown): AglSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    autoLink: typeof input.autoLink === 'boolean' ? input.autoLink : DEFAULT_AGL_SETTINGS.autoLink,
    useForLocalAgents: typeof input.useForLocalAgents === 'boolean' ? input.useForLocalAgents : DEFAULT_AGL_SETTINGS.useForLocalAgents
  }
}
