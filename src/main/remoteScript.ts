import { randomBytes } from 'node:crypto'
import { shQuote, assertUuid, COMMAND_NAME } from './remoteValidate'

/** The only command text ever placed after the host on the ssh command line.
 * It parses identically in sh, bash, zsh, dash, ksh, csh, tcsh and fish; the
 * payload that follows it only contains base64 characters. */
export const REMOTE_BOOTSTRAP = `/bin/sh -c 'eval "$(printf %s "$1" | base64 -d 2>/dev/null || printf %s "$1" | base64 -D)"' sh`

export function encodePayload(script: string): string {
  return Buffer.from(script, 'utf8').toString('base64')
}

/** Remote paths are anchored to "$HOME" in the remote shell, never to a value
 * returned by the server. */
export const REMOTE_ROOT = '"$HOME"/.douchat-remote'
export function runDirectory(runId: string): string { return `${REMOTE_ROOT}/${shQuote(`t-${assertUuid(runId, 'run')}`)}` }
export function bridgeSocketName(bridgeId: string): string { return `b-${assertUuid(bridgeId, 'bridge')}.sock` }

/** Conversation folders mirror local-workspaces: Douchat derives the name from a
 * session hash; the user never types a server path. Without a session the run
 * uses a throwaway folder inside its own run directory. */
export const WORKSPACE_KEY = /^[a-f0-9]{64}$/
export function assertWorkspaceKey(key: string): string {
  if (!WORKSPACE_KEY.test(key)) throw new Error('Invalid remote workspace')
  return key
}
/** `key` names the Douchat-managed folder and the conversation's run owner
 * record. `path` is a folder the owner chose on this server; it was resolved
 * with `pwd -P` when saved and is used in place, never created or removed. */
export interface RemoteWorkspaceRef { key?: string; path?: string }

const CONTROL = /[\0-\x1f\x7f]/
/** Structural check of a canonical absolute server path; the server resolves it. */
export function assertRemoteWorkspacePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 1024 || CONTROL.test(path)) throw new Error('Invalid server folder')
  if (path !== '/' && (path.endsWith('/') || path.includes('//') || path.split('/').some(part => part === '.' || part === '..'))) throw new Error('Invalid server folder')
  return path
}
export function workspaceDirectory(runId: string, workspace: RemoteWorkspaceRef = {}): string {
  if (workspace.path) return shQuote(assertRemoteWorkspacePath(workspace.path))
  return workspace.key ? `${REMOTE_ROOT}/w/${shQuote(assertWorkspaceKey(workspace.key))}` : `${runDirectory(runId)}/work`
}
/** Absolute path of the same folder, for prompts and JSON-RPC only. */
export function workspacePath(remoteHome: string, runId: string, workspace: RemoteWorkspaceRef = {}): string {
  if (workspace.path) return assertRemoteWorkspacePath(workspace.path)
  return workspace.key ? `${remoteHome}/.douchat-remote/w/${assertWorkspaceKey(workspace.key)}` : `${remoteHome}/.douchat-remote/t-${assertUuid(runId, 'run')}/work`
}
const CHECK_WORKSPACE = '[ -d "$w" ] && [ ! -L "$w" ] && [ -O "$w" ] || { echo "Douchat remote workspace is invalid" >&2; exit 3; }'
/** A chosen folder must still resolve to the saved path: a folder replaced by a
 * symbolic link (or moved) since it was chosen is refused, not followed. */
function checkChosenWorkspace(path: string): string {
  // Enter the folder in this shell and compare where we actually are, so there
  // is no window between the check and the agent starting in it.
  return `{ cd -P -- "$w" 2>/dev/null && [ -w . ] && [ "$(pwd -P)" = ${shQuote(assertRemoteWorkspacePath(path))} ]; } || { echo "The chosen folder on the server is missing, was replaced or is not writable. Choose it again in chat details." >&2; exit 3; }`
}
function checkWorkspace(workspace: RemoteWorkspaceRef): string {
  return workspace.path ? checkChosenWorkspace(workspace.path) : CHECK_WORKSPACE
}

export const SAFE_NAME = /^[A-Za-z0-9._-]{1,128}$/
function safeName(name: string): string {
  if (!SAFE_NAME.test(name) || name.startsWith('.')) throw new Error('Invalid remote file name')
  return name
}
function integer(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`)
  return String(value)
}

function preamble(remotePath?: string): string[] {
  return ['set -eu', 'umask 077', ...(remotePath ? [`PATH=${shQuote(remotePath)}; export PATH`] : [])]
}
const CHECK_RUN = '[ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] || { echo "Douchat remote run directory is invalid" >&2; exit 3; }'

/** Create the private per-run directory and the conversation workspace. */
export function prepareScript(runId: string, workspace: RemoteWorkspaceRef = {}): string {
  return [
    ...preamble(),
    'case "$HOME" in /*) ;; *) echo "Remote HOME must be an absolute path" >&2; exit 3;; esac',
    `r=${REMOTE_ROOT}`,
    '[ -L "$r" ] && { echo "Douchat remote directory is a symbolic link" >&2; exit 3; }',
    'mkdir -p -- "$r"',
    '[ -d "$r" ] && [ ! -L "$r" ] && [ -O "$r" ] || { echo "Douchat remote directory is not owned by this user" >&2; exit 3; }',
    // BSD chmod has no "--"; "$r" is absolute so it cannot start with "-".
    'chmod 700 "$r"',
    // A single turn may run for hours; only remove run folders idle for a day.
    `find "$r" -maxdepth 1 -name 't-*' -type d -mmin +1440 -exec rm -rf -- {} + 2>/dev/null || :`,
    `find "$r" -maxdepth 1 -name 'b-*.sock' -mmin +1440 -exec rm -f -- {} + 2>/dev/null || :`,
    `d=${runDirectory(runId)}`,
    'mkdir -m 700 -- "$d"',
    'mkdir -m 700 -- "$d/out"',
    CHECK_RUN,
    '(set -C; : > "$d/.marker")',
    // The owner record lives in $r/w for chosen folders too: it tracks the conversation, not the folder.
    ...(workspace.key ? [
      '[ -L "$r/w" ] && { echo "Douchat remote workspace root is a symbolic link" >&2; exit 3; }',
      '[ -d "$r/w" ] || mkdir -m 700 -- "$r/w"',
      '[ -d "$r/w" ] && [ ! -L "$r/w" ] && [ -O "$r/w" ] || { echo "Douchat remote workspace root is invalid" >&2; exit 3; }'
    ] : []),
    `w=${workspaceDirectory(runId, workspace)}`,
    ...(workspace.path ? [] : workspace.key ? [
      '[ -L "$w" ] && { echo "Douchat remote workspace is a symbolic link" >&2; exit 3; }',
      '[ -d "$w" ] || mkdir -m 700 -- "$w"'
    ] : ['mkdir -m 700 -- "$w"']),
    ...(workspace.key ? takeoverLines(runId, workspace.key) : []),
    checkWorkspace(workspace)
  ].join('\n') + '\n'
}

/**
 * One live run per conversation folder. A previous Douchat process can outlive
 * its connection (app quit mid-cleanup, laptop sleep, half-open TCP), and a
 * long-lived agent keeps holding the conversation (Codex: "thread ... already
 * has an active writer"). The owner record lives in $r/w, outside the folder the
 * agent may write, and only a strictly formatted run name is accepted.
 */
function takeoverLines(runId: string, workspaceKey: string): string[] {
  return [
    `own="$r"/w/${shQuote(`${assertWorkspaceKey(workspaceKey)}.run`)}`,
    '[ -L "$own" ] && { echo "Douchat remote workspace owner is a symbolic link" >&2; exit 3; }',
    'if [ -f "$own" ]; then',
    '  old=$(head -c 64 -- "$own" 2>/dev/null || :)',
    '  case "$old" in',
    '    t-????????-????-????-????-????????????) case "${old#t-}" in *[!0-9a-f-]*) old=;; esac;;',
    '    *) old=;;',
    '  esac',
    `  if [ -n "$old" ] && [ "$old" != ${shQuote(`t-${assertUuid(runId, 'run')}`)} ]; then`,
    '    od="$r/$old"',
    '    if [ -d "$od" ] && [ ! -L "$od" ] && [ -O "$od" ]; then',
    ...STOP_LINES('"$od"').map(line => `      ${line}`),
    '      rm -rf -- "$od"',
    '    fi',
    '  fi',
    '  rm -f -- "$own"',
    'fi',
    `(set -C; printf %s ${shQuote(`t-${runId}`)} > "$own")`
  ]
}

/** Write exactly `size` stdin bytes into a new file named by Douchat. */
export function uploadScript(runId: string, name: string, size: number): string {
  const file = `"$d"/${shQuote(safeName(name))}`
  return [
    ...preamble(), 'set -C', `d=${runDirectory(runId)}`, CHECK_RUN,
    `head -c ${integer(size, 'size')} > ${file}`,
    `wc -c < ${file} | tr -d ' '`
  ].join('\n') + '\n'
}

export function cleanupScript(runId: string, kill = true): string {
  return [
    'set -u', `d=${runDirectory(runId)}`,
    ...(kill ? [
      'if [ -f "$d/pid" ] && [ ! -L "$d/pid" ]; then',
      ...KILL_LINES.map(line => `  ${line}`),
      'fi'
    ] : []),
    'rm -rf -- "$d"', 'exit 0'
  ].join('\n') + '\n'
}

export function killScript(runId: string): string {
  return [
    'set -u', `d=${runDirectory(runId)}`,
    '[ -f "$d/pid" ] && [ ! -L "$d/pid" ] || exit 0',
    ...KILL_LINES, 'exit 0'
  ].join('\n') + '\n'
}

/** sshd starts every channel in its own session, so the agent's process group
 * belongs to this run only. Both pid and pgid must be plain numbers above 1. */
const KILL_LINES = [
  'pid=$(head -c 32 -- "$d/pid" 2>/dev/null || :)',
  'case "$pid" in ""|*[!0-9]*) pid=;; esac',
  'if [ -n "$pid" ] && [ "$pid" -gt 1 ]; then',
  '  pg=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d " ")',
  '  case "$pg" in ""|*[!0-9]*) pg=;; esac',
  '  if [ -n "$pg" ] && [ "$pg" -gt 1 ]; then kill -TERM -- "-$pg" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || :; else kill -TERM "$pid" 2>/dev/null || :; fi',
  'fi'
]

/** Terminate a run's agent and wait until it is gone, so locks it held are
 * released before the next agent starts. TERM first, KILL after 5 seconds. */
function STOP_LINES(directory: string): string[] {
  return [
    `pf=${directory}/pid`,
    'pid=; [ -f "$pf" ] && [ ! -L "$pf" ] && pid=$(head -c 32 -- "$pf" 2>/dev/null || :)',
    'case "$pid" in ""|*[!0-9]*) pid=;; esac',
    'if [ -n "$pid" ] && [ "$pid" -gt 1 ] && kill -0 "$pid" 2>/dev/null; then',
    '  pg=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d " ")',
    '  case "$pg" in ""|*[!0-9]*) pg=;; esac',
    '  [ -n "$pg" ] && [ "$pg" -gt 1 ] && [ "$pg" = "$pid" ] || pg=',
    // Node launchers (nvm codex, claude) run the real binary as a child; it holds the locks.
    '  kids=$(ps -eo pid=,ppid= 2>/dev/null | awk -v p="$pid" \'$2 == p && $1 ~ /^[0-9]+$/ { print $1 }\')',
    '  if [ -n "$pg" ]; then kill -TERM -- "-$pg" 2>/dev/null || :; else kill -TERM "$pid" $kids 2>/dev/null || :; fi',
    '  i=0',
    '  while [ "$i" -lt 50 ]; do alive=; for q in "$pid" $kids; do kill -0 "$q" 2>/dev/null && alive=1; done; [ -n "$alive" ] || break; sleep 0.1 2>/dev/null || sleep 1; i=$((i + 1)); done',
    '  if [ -n "$pg" ]; then kill -KILL -- "-$pg" 2>/dev/null || :; fi',
    '  kill -KILL "$pid" $kids 2>/dev/null || :',
    'fi'
  ]
}

/** Start a turn: reset the timestamp marker. */
export function markerScript(runId: string): string {
  return ['set -eu', `d=${runDirectory(runId)}`, CHECK_RUN, 'rm -f -- "$d/.marker"', '(set -C; : > "$d/.marker")'].join('\n') + '\n'
}

/** Remove previous deliverables so each turn only returns new outbox files. */
export function clearOutboxScript(runId: string): string {
  return ['set -u', `d=${runDirectory(runId)}`, CHECK_RUN, '[ -d "$d/out" ] && [ ! -L "$d/out" ] || exit 3',
    'find "$d/out" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +', 'exit 0'].join('\n') + '\n'
}

/** Both of the above in one remote round trip, each with its own error handling. */
export function beginTurnScript(runId: string): string {
  return markerScript(runId) + 'set +e\n' + clearOutboxScript(runId)
}

/** A single argv entry. `prompt` entries expand to "$p" in the remote shell. */
export type RemoteArg = string | { prompt: true } | { parts: Array<string | { prompt: true }> }
export const PROMPT_ARG: RemoteArg = { prompt: true }

function renderArg(arg: RemoteArg): string {
  if (typeof arg === 'string') return shQuote(arg)
  if ('prompt' in arg) return '"$p"'
  if (!arg.parts.length) return "''"
  return arg.parts.map(part => typeof part === 'string' ? (part ? shQuote(part) : '') : '"$p"').join('') || "''"
}

/** Same semantics as customLocalAgentArguments, but the prompt is never part
 * of the script: each {prompt} becomes a "$p" expansion between literals. */
export function customRemoteArguments(args: string[]): RemoteArg[] {
  const hasPrompt = args.some(arg => arg.includes('{prompt}'))
  const rendered: RemoteArg[] = args.map(arg => {
    if (!arg.includes('{prompt}')) return arg
    const pieces = arg.split('{prompt}')
    const parts: Array<string | { prompt: true }> = []
    pieces.forEach((piece, index) => { if (index) parts.push({ prompt: true }); if (piece) parts.push(piece) })
    return { parts }
  })
  return hasPrompt ? rendered : [...rendered, PROMPT_ARG]
}

/** Replace the local prompt value in an adapter's argv with a "$p" marker. */
export function markPromptArguments(args: string[], prompt: string): RemoteArg[] {
  return args.map(arg => arg === prompt ? PROMPT_ARG : arg)
}

export type PromptChannel = 'stdin' | 'argv' | 'none'

export interface LaunchScriptOptions {
  runId: string
  /** Conversation folder: Douchat's managed folder, or one the owner chose and Douchat verified. */
  workspace?: RemoteWorkspaceRef
  executable: string
  args: RemoteArg[]
  /** stdin: the agent inherits ssh stdin. argv: the prompt is read into "$p". */
  channel: PromptChannel
  remotePath?: string
  /** Fixed environment statements chosen by Douchat, never user text. */
  environment?: 'gemini' | 'claude-account' | undefined
}

/** The launch script contains validated configuration only, never the prompt. */
export function launchScript(options: LaunchScriptOptions): string {
  const exe = options.executable
  if (!exe.startsWith('/') && !COMMAND_NAME.test(exe)) throw new Error('Invalid remote executable')
  const usesPrompt = options.args.some(arg => typeof arg !== 'string')
  if (usesPrompt && options.channel !== 'argv') throw new Error('Prompt arguments require the argv channel')
  return [
    ...preamble(options.remotePath),
    `d=${runDirectory(options.runId)}`, CHECK_RUN,
    `w=${workspaceDirectory(options.runId, options.workspace)}`, checkWorkspace(options.workspace ?? {}),
    // A chosen folder was entered by its check; a managed one is entered here.
    ...(options.workspace?.path ? [] : ['cd -- "$w"']),
    ...(options.environment === 'gemini' ? ['GEMINI_CLI_TRUST_WORKSPACE=true; export GEMINI_CLI_TRUST_WORKSPACE'] : []),
    ...(options.environment === 'claude-account' ? ['unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL'] : []),
    `exe=${shQuote(exe)}`,
    'rm -f -- "$d/pid"',
    '(set -C; printf %s "$$" > "$d/pid")',
    ...(options.channel === 'argv' ? ['p=$(cat; printf x); p=${p%x}'] : []),
    `exec "$exe"${options.args.map(arg => ` ${renderArg(arg)}`).join('')}${options.channel === 'stdin' ? '' : ' < /dev/null'}`
  ].join('\n') + '\n'
}

export interface FramesScriptOptions {
  /** Trusted shell fragment built by Douchat; may contain one glob segment. */
  directory: string
  /** How many parent directories must also not be symbolic links. */
  parentChecks?: number
  exclude?: string[]
  only?: string[]
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  /** List names only (for before/after snapshots). */
  listOnly?: boolean
  /** Only files modified after this run's .marker (immune to clock skew). */
  newerThanRun?: string
}

function nameList(names: string[] = []): string {
  return shQuote(` ${names.filter(name => SAFE_NAME.test(name)).join(' ')} `)
}

/** Emit `<size> <name>\n<bytes>` frames for regular files in exactly one
 * directory level. Symlinks, hard links, directories and unsafe names are skipped. */
export function framesScript(options: FramesScriptOptions): string {
  const parents = Array.from({ length: options.parentChecks ?? 0 }, (_, index) => `[ ! -L "\${b%${'/*'.repeat(index + 1)}}" ] || continue`)
  return [
    'set -u', 'n=0', 't=0',
    `ex=${nameList(options.exclude)}`, `only=${nameList(options.only)}`,
    ...(options.newerThanRun ? [`mk=${runDirectory(options.newerThanRun)}/.marker`, '[ -f "$mk" ] && [ ! -L "$mk" ] || exit 0'] : []),
    `for b in ${options.directory}; do`,
    '  [ -d "$b" ] && [ ! -L "$b" ] || continue',
    ...parents.map(line => `  ${line}`),
    '  for f in "$b"/*; do',
    '    [ -f "$f" ] && [ ! -L "$f" ] || continue',
    '    m=${f##*/}',
    '    case "$m" in ""|.*|*[!A-Za-z0-9._-]*) continue;; esac',
    '    case "$ex" in *" $m "*) continue;; esac',
    ...(options.only ? ['    case "$only" in *" $m "*) ;; *) continue;; esac'] : []),
    '    [ -n "$(find "$f" -prune -links 1 2>/dev/null)" ] || continue',
    ...(options.newerThanRun ? ['    [ "$f" -nt "$mk" ] || continue'] : []),
    ...(options.listOnly ? ['    printf "%s\\n" "$m"', '    continue'] : [
      '    s=$(wc -c < "$f" | tr -d " ")',
      '    case "$s" in ""|*[!0-9]*) continue;; esac',
      `    [ "$s" -gt 0 ] && [ "$s" -le ${integer(options.maxFileBytes, 'limit')} ] || continue`,
      `    [ "$n" -lt ${integer(options.maxFiles, 'limit')} ] || exit 0`,
      `    [ $((t + s)) -le ${integer(options.maxTotalBytes, 'limit')} ] || exit 0`,
      '    printf "%s %s\\n" "$s" "$m"',
      '    head -c "$s" < "$f"',
      '    n=$((n + 1)); t=$((t + s))'
    ]),
    '  done',
    'done', 'exit 0'
  ].join('\n') + '\n'
}

/** Directory fragments for generated files. Values are validated first and
 * variables such as CODEX_HOME are only expanded on the server. */
export const remoteImageDirectories = {
  codex: (threadId: string) => ({ directory: `"\${CODEX_HOME:-$HOME/.codex}/generated_images"/${shQuote(assertUuid(threadId, 'thread'))}`, parentChecks: 1 }),
  gemini: (runId: string, workspace?: RemoteWorkspaceRef) => ({ directory: `${workspaceDirectory(runId, workspace)}/nanobanana-output`, parentChecks: 1 }),
  grok: (sessionId: string) => ({ directory: `"\${GROK_HOME:-$HOME/.grok}/sessions"/*/${shQuote(assertUuid(sessionId, 'session'))}/images`, parentChecks: 2 }),
  outbox: (runId: string) => ({ directory: `${runDirectory(runId)}/out`, parentChecks: 1 })
}

/** Fixed file names Douchat itself reads back from the run directory. */
export function runFileScript(runId: string, name: 'reply.txt', maxBytes: number): string {
  return framesScript({ directory: runDirectory(runId), parentChecks: 0, only: [name], maxFiles: 1, maxFileBytes: maxBytes, maxTotalBytes: maxBytes })
}

/** Resolve the executable with the user's login PATH. The login shell is only
 * asked to run `env`, which every shell family parses the same way. */
/** Conventional per-user install locations, mirroring executableSearchPath() in
 * shellPath.ts. Fixed text chosen by Douchat and anchored to "$HOME"; nvm
 * versions are listed newest-name first. */
const REMOTE_SEARCH_DIRS = [
  '"$HOME/.local/bin"', '"$HOME/.local/share/pnpm"', '"$HOME/.local/share/mise/shims"', '"$HOME/.asdf/shims"',
  '"$HOME/.volta/bin"', '"$HOME/.fnm/aliases/default/bin"', '"$HOME/.npm-global/bin"', '"$HOME/.bun/bin"',
  '"$HOME/.cargo/bin"', '"$HOME/.opencode/bin"', '"$HOME/.kimi-code/bin"',
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'
]

/**
 * Resolve the executable the way a terminal on the server would, in the same
 * order as the local shellPath.ts:
 * 1. interactive login shell (`-lic`), because zsh skips ~/.zshrc otherwise and
 *    nvm, pnpm and ~/.local/bin installers write there;
 * 2. non-interactive login shell (`-lc`);
 * 3. conventional install directories.
 * rc files may print banners or terminal escape codes, so the PATH is framed by
 * a per-probe random marker and only the text between the markers is used.
 * The resolved executable's own directory goes first on PATH so a Node-based
 * CLI finds the node installed next to it.
 */
export function probeScript(executable: string, nonce = randomBytes(8).toString('hex')): string {
  if (!executable.startsWith('/') && !COMMAND_NAME.test(executable)) throw new Error('Invalid remote executable')
  if (!/^[a-f0-9]{16}$/.test(nonce)) throw new Error('Invalid probe marker')
  const open = `DOUCHAT_PATH_${nonce}_BEGIN`
  const close = `DOUCHAT_PATH_${nonce}_END`
  const inner = `printf "%s%s%s\\n" ${open} "$PATH" ${close}`
  return [
    'set -u',
    'case "$HOME" in /*) ;; *) echo "Remote HOME must be an absolute path" >&2; exit 3;; esac',
    's=${SHELL:-/bin/sh}',
    'case "$s" in /*) ;; *) s=/bin/sh;; esac',
    '[ -x "$s" ] || s=/bin/sh',
    'to=; command -v timeout >/dev/null 2>&1 && to="timeout 10"',
    `q=${shQuote(inner)}`,
    'P=',
    'for f in -lic -lc; do',
    `  P=$($to "$s" "$f" "$q" < /dev/null 2>/dev/null | sed -n ${shQuote(`s/.*${open}\\(.*\\)${close}.*/\\1/p`)} | tail -n 1) || P=`,
    '  case "$P" in /*) break;; esac',
    '  P=',
    'done',
    '[ -n "$P" ] || P=$PATH',
    'add() { case "$1" in *:*|"") return;; esac; [ -d "$1" ] || return 0; case ":$P:" in *":$1:"*) ;; *) P=$P:$1;; esac; }',
    'nv=',
    'for x in "$HOME"/.nvm/versions/node/*/bin; do case "$x" in *:*) ;; *) [ -d "$x" ] && nv=$x${nv:+:$nv};; esac; done',
    'o=$IFS; IFS=:; set -f',
    'for x in $nv; do add "$x"; done',
    'IFS=$o; set +f',
    `for x in ${REMOTE_SEARCH_DIRS.join(' ')}; do add "$x"; done`,
    'PATH=$P; export PATH',
    `e=$(command -v ${shQuote(executable)} 2>/dev/null || :)`,
    'case "$e" in /*) ed=${e%/*}; [ -n "$ed" ] || ed=/; case "$ed" in *:*) ;; *) PATH=$ed:$PATH;; esac;; *) e=;; esac',
    'printf "%s\\n%s\\n%s\\n" "$e" "$PATH" "$HOME"'
  ].join('\n') + '\n'
}

/** Remote UNIX socket path for the reverse skill bridge. */
export function bridgeSocketPath(remoteHome: string, bridgeId: string): string {
  return `${remoteHome}/.douchat-remote/${bridgeSocketName(bridgeId)}`
}

/** Exit 0 only when the forwarded socket exists, is a socket and is ours. */
export function bridgeCheckScript(bridgeId: string): string {
  return [`s=${REMOTE_ROOT}/${shQuote(bridgeSocketName(bridgeId))}`, '[ -S "$s" ] && [ ! -L "$s" ] && [ -O "$s" ]'].join('\n') + '\n'
}
export function bridgeCleanupScript(bridgeId: string): string {
  return [`s=${REMOTE_ROOT}/${shQuote(bridgeSocketName(bridgeId))}`, '[ -S "$s" ] && [ ! -L "$s" ] && rm -f -- "$s"', 'exit 0'].join('\n') + '\n'
}

/** One level of sub-folders, for choosing a folder on the server. The first
 * line is the listed folder's canonical path; hidden folders, symbolic links
 * and names with line breaks are skipped, and at most 500 names are returned. */
export function listDirectoriesScript(path: string): string {
  return [
    'set -u', 'LC_ALL=C; export LC_ALL',
    `cd -P -- ${shQuote(assertRemoteWorkspacePath(path))} 2>/dev/null || { echo "Folder not found on the server" >&2; exit 3; }`,
    'pwd -P',
    "nl=$(printf '\\nx'); nl=${nl%x}",
    'n=0',
    'for d in *; do',
    '  [ -d "$d" ] && [ ! -L "$d" ] || continue',
    '  case "$d" in .*|*"$nl"*) continue;; esac',
    "  printf '%s\\n' \"$d\"",
    '  n=$((n + 1)); [ "$n" -lt 500 ] || break',
    'done', 'exit 0'
  ].join('\n') + '\n'
}

/** Print the server's system name, its canonical home folder and the
 * canonical path of a folder the agent can write to. The policy compares real
 * paths only: a symlinked home (/home -> /var/home) or a case-insensitive
 * file system cannot hide ~/.ssh behind another spelling. */
export function resolveDirectoryScript(path: string): string {
  return [
    'set -u',
    'uname -s',
    '(cd -P -- "$HOME" 2>/dev/null && pwd -P) || { echo "Remote HOME is not accessible" >&2; exit 3; }',
    `cd -P -- ${shQuote(assertRemoteWorkspacePath(path))} 2>/dev/null || { echo "Folder not found on the server" >&2; exit 3; }`,
    '[ -w . ] || { echo "This folder on the server is not writable" >&2; exit 3; }',
    'pwd -P'
  ].join('\n') + '\n'
}

/** Fixed CLI names Douchat knows how to talk to, in discovery order. */
export const DISCOVERABLE_CLIS = [
  ['codex', 'codex'], ['claude', 'claude'], ['gemini', 'gemini'], ['grok', 'grok'], ['cursor', 'cursor-agent'], ['opencode', 'opencode'],
  ['kimi', 'kimi'], ['openclaw', 'openclaw'], ['fastclaw', 'fastclaw'], ['hermes', 'hermes'], ['omp', 'omp']
] as const

/**
 * Find every known CLI with the same PATH rules as the agent probe. Each hit is
 * printed as "<name>\t<path>"; command names are constants, never user text.
 * `--version` runs with a 5 second limit where `timeout` exists.
 */
export function discoverScript(nonce = randomBytes(8).toString('hex')): string {
  // The probe's PATH resolution, up to and including `export PATH`.
  const probe = probeScript('true', nonce).replace(/\ne=\$\(command -v [\s\S]*$/, '')
  return [
    probe,
    'vt=; command -v timeout >/dev/null 2>&1 && vt="timeout 5"',
    `for c in ${DISCOVERABLE_CLIS.map(([, command]) => shQuote(command)).join(' ')}; do`,
    '  e=$(command -v "$c" 2>/dev/null || :)',
    '  case "$e" in /*) ;; *) continue;; esac',
    '  case "$e" in *"$(printf \'\\t\')"*) continue;; esac',
    '  v=$($vt "$e" --version < /dev/null 2>/dev/null | head -n 1 | tr -d \'\\t\\r\' | cut -c 1-120 || :)',
    "  printf '%s\\t%s\\t%s\\n' \"$c\" \"$e\" \"$v\"",
    'done', 'exit 0'
  ].join('\n') + '\n'
}
