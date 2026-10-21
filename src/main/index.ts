import { groupMemberSessionId } from '../shared/bot/group'
import type { SelectedMention } from '../shared/bot/mentions'
import { ConnanyManager } from './connany'
import { supportedInterfaceLanguage } from '../shared/language'
import { CONNECTORS_ENABLED } from '../shared/connany'
import { LocalAccountData } from './accountData'
import { exportAgentArchive, parseAgentArchive } from './agentArchive'
import { parseSkillArchive } from './skillArchive'
import { replyToIM } from './imReply'
import { IMChannelManager } from './imChannels'
import { testLocalAgent } from './localAgentTest'
import { listSshHosts } from './sshHosts'
import { listLocalAgentModels, cancelLocalModelQueries } from './localAgentModels'
import { disposeAllLocalAgentSessions } from './localAgentRuntime'
import { localModelId, configurableLocalAgents, localAgentAdapter } from '../shared/localModels'
import { thinkingLevel } from '../shared/thinkingLevels'
import { authorizeTokenDance } from './tokenDanceAuth'
import { CustomModelStore } from './customModels'
import { CUSTOM_PROVIDER_PREFIX, type CustomProviderInput, type CustomModelTest } from '../shared/customModels'
import { configureManagedNode, ensureManagedNode } from './managedNode'
import { configureNativeDialogWindows, resizeNativeDialog } from './nativeDialogs'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { BUILT_IN_PRODUCTS, parseProducts } from '../shared/products'
import { configureTimingLog, DiagnosticLog } from './diagnostics'
import { hostname, release as osRelease } from 'node:os'
import { notifyWindows } from './windowNotifications'
import { SocialClient } from './social'
import { CloudSyncClient } from './cloudSync'
import { captureIpcHandlers, REMOTE_SENDER, runDesktopRpc } from './desktopRpc'
import { fitImageForSync } from './remoteImage'
import { SUPPORT_SHARE_HOURS } from '../shared/cloudSync'
import type { SocialAction } from '../shared/social'
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, nativeImage, net, powerMonitor, powerSaveBlocker, session, shell, safeStorage, systemPreferences } from 'electron'
import electronUpdater from 'electron-updater'
import type {
  AppSnapshot,
  CodeArtifactInput,
  EmailConnectorInput,
  CreateAgentInput,
  CustomLocalAgentInput,
  DesktopAuthState,
  EndpointInput,
  MessageImageInput,
  MessageFileInput,
  CreateGroupInput,
  CreateRoutineInput,
  UpdateAgentInput,
  UpdateConversationInput,
  UpdateDesktopProfileInput,
  UpdateState,
  AgentWorkspaceBinding,
  Conversation,
  ConversationWorkspaceView,
  MemberWorkspaceView
} from '../shared/types'
import { LocalComputerProvider } from './computer'
import { DouchatRuntime, hostTarget } from './runtime'
import { RoutineScheduler } from './scheduler'
import { DouchatStore } from './store'
import { addCustomLocalAgent, agentsOnConnection, hasRemoteAgent, configureLocalAgentRegistry, connectionRegistry, detectLocalAgents, remoteAgentPlacement, removeAgentsOnConnection, removeCustomLocalAgent, setConnectionAccount, setHostBindingLookup, hostExecutedAgent, updateLocalAgent, validateLocalAgent } from './localAgents'
import { ConnectionManager } from './connectionManager'
import { migrateConnections, skippedMigrationAgents } from './connectionStore'
import { migrateWorkspaceTargets } from './workspaceMigration'
import { migrateSharingToPermissions } from './sharingMigration'
import { closeRemoteConnections, configureRemoteTransport } from './remoteTransport'
import { checkLocalAgentUpdates } from './localAgentUpdates'
import { resetShellPath } from './shellPath'
import { DesktopAuth } from './desktopAuth'
import { DeviceIdentity } from './deviceIdentity'
import { DaemonClient, hostAwareExecutor } from './remote/daemonClient'
import { desktopAgentExecutor } from './desktopAgentExecutor'
import { rendererSocialSnapshot } from './social'
import { chatApiBaseUrl, desktopAuthScheme, isDesktopAuthUrl, isDesktopCreditsUrl, parseDesktopGroupUrl, normalizeWebAppUrl, parseDesktopConnectorsUrl, DEVELOPMENT_APP_SCHEME } from './authProtocol'
import { DesktopUpdater, type UpdateDriver } from './updater'
import { EmailConnectorManager } from './emailConnector'
import { applicationName, userDataDirectoryName } from './userData'
import { configureLocalWorkspaces, validateWorkspaceFolder, resolveSavedWorkspace, localWorkspace, openableWorkspace, localExecutionTarget } from './localWorkspaces'
import { listRemoteDirectories, remoteTerminalArgs, resolveRemoteWorkspace } from './remoteWorkspace'
import { remoteHostLabel } from './remoteValidate'
import { probeRemoteAgent } from './remoteTransport'
import { configureDaemonRelay } from './remote/daemonRelay'
import { canAssignAgentWorkspace, canAssignConversationWorkspace, memberWorkspace, ownMemberAgentIds } from '../shared/conversationWorkspace'
import { prepareNpmMaintenance, resolveMaintenancePlan } from './localAgentMaintenance'
import { openMaintenanceTerminal, openLocalAgentTerminal, openSshTerminal } from './terminalLauncher'

// Use the software compositor on Windows: modal layers can blank the entire
// window on affected GPU/driver combinations. Must run before app readiness.
if (process.platform === 'win32') app.disableHardwareAcceleration()

const development = !app.isPackaged
// Where the connector return page sends the browser back: the dev host has its own scheme.
const connectorScheme = development ? DEVELOPMENT_APP_SCHEME : 'douchat'
// Chromium derives the macOS safeStorage Keychain service from the application
// name. Keep development on "Douchat Dev Safe Storage" so local builds never
// contend with the signed release's "Douchat Safe Storage" credentials.
app.setName(applicationName(development))
const appIcon = join(app.getAppPath(), 'resources/icons', development ? 'douchat-dev.png' : 'douchat.png')
const authScheme = desktopAuthScheme()
const webAppUrl = normalizeWebAppUrl(
  process.env.DOUCHAT_SERVICE_URL || process.env.DOUCHAT_WEB_URL,
  development
)

/**
 * Keep packaged user data stable across display-name changes, while isolating
 * local development so test logins, screenshots and database resets cannot
 * overwrite a user's installed Douchat data.
 */
app.setPath('userData', join(app.getPath('appData'), userDataDirectoryName(development)))
configureLocalAgentRegistry(app.getPath('userData'))
const connections = new ConnectionManager(connectionRegistry(), agentsOnConnection)
configureRemoteTransport(app.getPath('userData'))
configureManagedNode(app.getPath('userData'))
configureLocalWorkspaces(app.getPath('userData'))
const customModels = new CustomModelStore(join(app.getPath('userData'), 'custom-models'), {
  encrypt: (value) => {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error("System credential storage is unavailable. Enable the system keychain and try again.")
    return safeStorage.encryptString(value).toString('base64')
  },
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64'))
})
function reloadCustomModels(): void {
  if (store.currentAccountId) {
    try { runtime.configureCustomModels(customModels.records(store.currentAccountId), customModels.list(store.currentAccountId).defaultModel) }
    catch { runtime.configureCustomModels([]); console.warn('[douchat] Custom model keys could not be loaded for this account') }
  } else runtime.configureCustomModels([])
}
const diagnostics = new DiagnosticLog(join(app.getPath('userData'), 'logs'))
configureTimingLog(diagnostics)
try {
  const crashDirectory = join(diagnostics.directory, 'crashes')
  mkdirSync(crashDirectory, { recursive: true })
  app.setPath('crashDumps', crashDirectory)
  crashReporter.start({ uploadToServer: false })
  diagnostics.write('crash-reporter.ready', 'Local dumps: logs/crashes; upload disabled')
} catch (error) {
  diagnostics.write('crash-reporter.failed', error instanceof Error ? error.message : String(error))
}

diagnostics.write('app.start', JSON.stringify({ version: app.getVersion(), platform: process.platform, arch: process.arch, os: osRelease(), electron: process.versions.electron, chrome: process.versions.chrome, hardwareAccelerationDisabled: process.platform === 'win32' }))
process.on('uncaughtExceptionMonitor', (error) => diagnostics.write('main.uncaughtException', error.stack || error.message))
const settingsTimers = new Map<number, ReturnType<typeof setTimeout>>()
function clearSettingsTimer(id: number): void {
  clearTimeout(settingsTimers.get(id))
  settingsTimers.delete(id)
}
/** Native dialogs follow the renderer's interface language; before the runtime
 * exists (early crashes) they fall back to the system locale. */
function ui(en: string, zh: string): string {
  return (runtime ? runtime.language : supportedInterfaceLanguage(app.getLocale())) === 'zh-CN' ? zh : en
}
async function openDiagnosticLogs(): Promise<void> {
  diagnostics.write('logs.open')
  const error = await shell.openPath(diagnostics.directory)
  if (error) {
    diagnostics.write('logs.open-failed', error)
    dialog.showErrorBox('Douchat', `${ui('Could not open the log folder:', '无法打开日志目录：')} ${diagnostics.directory}\n${error}`)
  }
}
app.on('browser-window-created', (_event, window) => {
  const contents = window.webContents
  const id = contents.id
  configureNativeDialogWindows(window)
  const record = (event: string, detail = '') => diagnostics.write(event, `window=${id} ${detail}`)
  contents.on('preload-error', (_event, _path, error) => record('preload.error', error.stack || error.message))
  contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => record('window.load-failed', JSON.stringify({ code, description, mainFrame })))
  let showingCrashDialog = false
  contents.on('render-process-gone', (_event, details) => {
    record('renderer.gone', JSON.stringify({ ...details, settingsPending: settingsTimers.has(id) }))
    clearSettingsTimer(id)
    if (details.reason === 'clean-exit' || showingCrashDialog || window.isDestroyed()) return
    showingCrashDialog = true
    // Native UI remains usable after the renderer (including its React boundaries) exits.
    void dialog.showMessageBox(window, {
      type: 'error', title: 'Douchat', message: ui('The interface stopped unexpectedly', '界面进程意外退出'),
      detail: `${ui('Please send diagnostics.log and the crashes folder from the log folder to the developers.', '请将日志目录中的 diagnostics.log 和 crashes 文件夹发给开发者。')}\n${ui('Error:', '错误：')} ${details.reason} (${details.exitCode})`,
      buttons: [ui('Open log folder and reload', '打开日志目录并重新加载'), ui('Reload', '重新加载'), ui('Close window', '关闭窗口')], defaultId: 0, cancelId: 2
    }).then(async ({ response }) => {
      if (response === 0) await openDiagnosticLogs()
      if (window.isDestroyed() || contents.isDestroyed()) return
      if (response === 2) window.close()
      else contents.reload()
    }).catch((error) => record('crash-dialog.failed', String(error)))
      .finally(() => { showingCrashDialog = false })
  })
  window.on('unresponsive', () => record('window.unresponsive'))
  window.on('responsive', () => record('window.responsive'))
  window.on('closed', () => clearSettingsTimer(id))
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'l') {
      event.preventDefault()
      void openDiagnosticLogs()
    }
  })
})
app.on('child-process-gone', (_event, details) => diagnostics.write('child-process.gone', JSON.stringify(details)))
// Every handler registered from here on can also serve the web app (desktopRpc.ts).
captureIpcHandlers()
ipcMain.handle('douchat:resize-dialog', (event, name: unknown, width: unknown, height: unknown) => {
  if (typeof name !== 'string' || typeof width !== 'number' || typeof height !== 'number') return false
  return resizeNativeDialog(event.sender, name, height, width)
})
ipcMain.on('douchat:diagnostic', (event, name: unknown, detail: unknown) => {
  if (!isDouchatRenderer(event.sender) || typeof name !== 'string' || typeof detail !== 'string' || name.length > 100 || detail.length > 16000) return
  if (name === 'native-dialog.resize') {
    try {
      const request = JSON.parse(detail)
      if (typeof request.name === 'string' && typeof request.height === 'number') resizeNativeDialog(event.sender, request.name, request.height)
    } catch { /* Ignore malformed resize requests. */ }
    return
  }
  const id = event.sender.id
  diagnostics.write(name, `window=${id} ${detail}`)
  if (name === 'settings.open-request') {
    clearSettingsTimer(id)
    settingsTimers.set(id, setTimeout(() => {
      settingsTimers.delete(id)
      diagnostics.write('settings.render-timeout', `window=${id} No layout acknowledgement within 5 seconds`)
    }, 5000))
  } else if (name === 'settings.layout' || name === 'settings.close' || name === 'dialog.render-error') clearSettingsTimer(id)
})
ipcMain.handle('douchat:open-diagnostic-logs', async (event) => {
  if (!isDouchatRenderer(event.sender)) return
  await openDiagnosticLogs()
})


let mainWindow: BrowserWindow | null = null
let store: DouchatStore
let imChannels: IMChannelManager | undefined
let runtime: DouchatRuntime
let computer: LocalComputerProvider
let scheduler: RoutineScheduler
let auth: DesktopAuth
let updater: DesktopUpdater
let connany: ConnanyManager
let connanyEvents: ReturnType<typeof setInterval> | undefined
let emailConnectors: EmailConnectorManager
let pendingGroupRoom = ''
let openingGroupRoom = false
let pendingAuthUrl = ''
let pendingCreditsRefresh = false
let cloudSessionActive = false

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

/** No window, and so no turn or agent edit, before connections are migrated. */
let startupReady = false
function focusMainWindow(): void {
  if (quitting) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady() && runtime && startupReady) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (process.platform === 'darwin') app.focus({ steal: true })
  mainWindow.show()
  mainWindow.focus()
}

function callbackUrlFromArgs(args: string[]): string | undefined {
  return args.find((arg) => isDesktopAuthUrl(arg, authScheme) || isDesktopCreditsUrl(arg, authScheme) || Boolean(parseDesktopGroupUrl(arg)) || parseDesktopConnectorsUrl(arg, connectorScheme) !== undefined)
}

async function openPendingGroup(): Promise<void> {
  if (!pendingGroupRoom || openingGroupRoom || !social || auth?.getState().status !== 'signed-in') return
  openingGroupRoom = true
  const roomId = pendingGroupRoom
  try {
    await social.syncInbox(true)
    const conversation = store.accountConversations.find((item) => item.remoteRoomId === roomId)
    if (!conversation) throw new Error("Sign in with the same account used to join this group.")
    if (conversation.hidden) store.updateConversation(conversation.id, { hidden: false })
    openChatWindow(conversation.id)
  } catch (error) {
    await dialog.showMessageBox({ type: 'info', message: ui('Could not open the group chat', '无法打开群聊'), detail: error instanceof Error ? error.message : ui('Please try again later.', '请稍后重试。') })
  } finally {
    if (pendingGroupRoom === roomId) pendingGroupRoom = ''
    openingGroupRoom = false
  }
}

function receiveAppUrl(url: string): void {
  const connectorSession = parseDesktopConnectorsUrl(url, connectorScheme)
  if (connectorSession !== undefined) {
    focusMainWindow()
    if (connectorSession && connany) void connany.handleReturn(connectorSession).catch(() => { /* Polling still completes the connection. */ })
    return
  }
  const roomId = parseDesktopGroupUrl(url)
  if (roomId) {
    pendingGroupRoom = roomId
    focusMainWindow()
    void openPendingGroup()
    return
  }
  if (isDesktopCreditsUrl(url, authScheme)) {
    pendingCreditsRefresh = true
    focusMainWindow()
    if (mainWindow) notifyWindows([mainWindow], 'douchat:credits-updated')
    return
  }
  focusMainWindow()
  // Other links, such as douchat://open from the web app, only bring Douchat forward.
  if (!isDesktopAuthUrl(url, authScheme)) return
  // Signing in starts account sync and shared tasks; wait until startup (and migration) is done.
  if (!auth || !startupReady) {
    pendingAuthUrl = url
    return
  }
  void auth.handleCallback(url)
}

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, commandLine) => {
    const url = callbackUrlFromArgs(commandLine)
    if (url) receiveAppUrl(url)
    else focusMainWindow()
  })
  app.on('open-url', (event, url) => {
    event.preventDefault()
    receiveAppUrl(url)
  })
}

const initialAppUrl = callbackUrlFromArgs(process.argv)
if (initialAppUrl) {
  if (parseDesktopGroupUrl(initialAppUrl)) pendingGroupRoom = parseDesktopGroupUrl(initialAppUrl)!
  else if (isDesktopCreditsUrl(initialAppUrl, authScheme)) pendingCreditsRefresh = true
  else pendingAuthUrl = initialAppUrl
}

let localWorkBlocker: number | undefined
let quitting = false
function broadcast(snapshot: AppSnapshot): void {
  if (quitting) return
  const localWork = !quitting && snapshot.agents.some((agent) => agent.localAgentId && snapshot.agentStatuses[agent.id] === 'thinking')
  if (localWork && localWorkBlocker === undefined) localWorkBlocker = powerSaveBlocker.start('prevent-app-suspension')
  if (!localWork && localWorkBlocker !== undefined) {
    powerSaveBlocker.stop(localWorkBlocker)
    localWorkBlocker = undefined
  }
  notifyWindows(BrowserWindow.getAllWindows(), 'douchat:snapshot', snapshot)
  // The web app shows the same "replying…" state as these windows.
  cloudSync?.publishActivity(snapshot.activity)
  cloudSync?.publishRoomReads(store.roomReadMarks())
}

// A full snapshot is built synchronously on this thread, which also forwards
// keystrokes to the renderer. Background changes (streaming, inbox sync,
// heartbeats) arrive in bursts, so publish at most one snapshot per interval.
const BACKGROUND_BROADCAST_INTERVAL_MS = 100
let backgroundBroadcast: ReturnType<typeof setTimeout> | undefined
let lastBackgroundBroadcastAt = 0
function scheduleBroadcast(): void {
  if (quitting || backgroundBroadcast) return
  backgroundBroadcast = setTimeout(() => {
    backgroundBroadcast = undefined
    if (quitting || !runtime) return
    lastBackgroundBroadcastAt = Date.now()
    broadcast(runtime.snapshot())
  }, Math.max(0, lastBackgroundBroadcastAt + BACKGROUND_BROADCAST_INTERVAL_MS - Date.now()))
}

let social: SocialClient | undefined
let cloudSync: CloudSyncClient | undefined
let daemon: DaemonClient | undefined
let socialAccountId = ''

function broadcastAuth(state: DesktopAuthState): void {
  const nextSocialAccount = state.status === 'signed-in' ? state.user.id : ''
  const accountChanged = Boolean(store && store.currentAccountId !== nextSocialAccount)
  if (store && accountChanged) {
    cancelLocalModelQueries()
    const previousAgents = store.accountAgents
    const previousConversations = store.accountConversations
    runtime?.games.stopAll()
    for (const conversation of previousConversations) runtime?.stopConversation(conversation.id)
    for (const agent of previousAgents) runtime?.disposeAgent(agent.id)
    for (const window of chatWindows.values()) window.close()
    for (const window of codeArtifactWindows.values()) window.close()
    codeArtifacts.clear()
    store.setCurrentAccountId(nextSocialAccount)
    reloadCustomModels()
    try { imChannels?.activate() } catch { console.warn("[douchat] IM credentials could not be loaded") }
    scheduler?.accountChanged()
    // Models and credentials are account state. Force the connection catalog
    // to be rebuilt even when both the old and new account are signed in.
    cloudSessionActive = false
  }
  if (nextSocialAccount !== socialAccountId) {
    socialAccountId = nextSocialAccount
    // Hosts belong to the account that added them; SSH connections stay with this computer.
    setConnectionAccount(nextSocialAccount)
    void connections.setAccount(nextSocialAccount).then(() => notifyWindows(BrowserWindow.getAllWindows(), 'douchat:connections-changed'))
    if (nextSocialAccount) { social?.start(); daemon?.start(); cloudSync?.start() }
    else { social?.stop(); daemon?.stop(); cloudSync?.stop() }
  }
  let welcomeConversationId: string | undefined
  let builtInRefresh: Promise<string | undefined> = Promise.resolve(undefined)
  if (state.status === 'signed-in' && store && runtime) {
    // The service account is the identity authority. Keep only the name as a
    // local runtime cache so agent prompts use the same identity when offline.
    store.setUserName(state.user.name)
    const welcome = store.ensureDefaultCloudContact(state.user.id, runtime.defaultCloudAgentModel())
    welcomeConversationId = welcome.conversation?.id ?? store.defaultConversationId
    broadcast(runtime.snapshot())
    builtInRefresh = auth.getBuiltInAgentManifest()
      .then((manifest) => {
        const current = auth.getState()
        if (current.status !== 'signed-in' || current.user.id !== state.user.id) return undefined
        const synced = store.ensureDefaultCloudContact(
          state.user.id,
          runtime.defaultCloudAgentModel(),
          manifest
        )
        // Window focus refreshes the profile too. Refresh cached sessions only
        // after active replies finish; disposeAgent would cancel their requests.
        if (synced.agent) runtime.refreshAgent(synced.agent.id)
        broadcast(runtime.snapshot())
        return synced.conversation?.id ?? store.defaultConversationId
      })
      .catch((error) => {
        // The cached manifest and embedded definition keep the administrator
        // usable offline. A refresh failure is therefore diagnostic only.
        console.warn('[douchat] built-in agent refresh failed:', error instanceof Error ? error.message : error)
        return welcomeConversationId
      })
  }
  const signedIn = state.status === 'signed-in'
  const shouldConnect = runtime && (
    signedIn
      ? !cloudSessionActive || runtime.snapshot().runtime.mode !== 'live'
      : cloudSessionActive
  )
  if (runtime && shouldConnect) {
    cloudSessionActive = signedIn
    void Promise.all([runtime.connect(), builtInRefresh]).then(async ([, refreshedConversationId]) => {
      if (state.status === 'signed-in' && store.currentAccountId === state.user.id) void runtime.recoverGroupWorkflows()
      // Wait for the account's Cloud model before asking Dr. Dou to open the
      // welcome chat. greet() is otherwise idempotent once a message exists.
      const current = auth?.getState()
      if (
        (refreshedConversationId ?? welcomeConversationId)
        && state.status === 'signed-in'
        && current?.status === 'signed-in'
        && current.user.id === state.user.id
      ) {
        await runtime.greet((refreshedConversationId ?? welcomeConversationId)!)
      }
      broadcast(runtime.snapshot())
    })
  } else {
    void builtInRefresh
  }
  notifyWindows(BrowserWindow.getAllWindows(), 'douchat:auth-state', state)
}

function broadcastUpdate(state: UpdateState): void {
  notifyWindows(BrowserWindow.getAllWindows(), 'douchat:update-state', state)
}

const chatWindows = new Map<string, BrowserWindow>()
function openChatWindow(conversationId: string): void {
  const existing = chatWindows.get(conversationId)
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return }
  const window = new BrowserWindow({ acceptFirstMouse: true, icon: appIcon, width: 820, height: 720, minWidth: 480, minHeight: 480, title: store.conversation(conversationId)?.name,
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  chatWindows.set(conversationId, window)
  window.on('closed', () => chatWindows.delete(conversationId))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('conversation', conversationId)
    void window.loadURL(url.toString())
  } else void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { conversation: conversationId } })
}

const codeArtifacts = new Map<string, CodeArtifactInput>()
const codeArtifactWindows = new Map<string, BrowserWindow>()

function validateCodeArtifact(input: CodeArtifactInput): CodeArtifactInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid code file')
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : ''
  const language = typeof input.language === 'string' ? input.language.trim().toLowerCase().slice(0, 32) : ''
  const code = typeof input.code === 'string' ? input.code : ''
  if (!title || !language || !code || code.length > 2_000_000) throw new Error('Invalid code file')
  return { title, language, code }
}

function openCodeArtifactWindow(input: CodeArtifactInput): void {
  const artifact = validateCodeArtifact(input)
  const artifactId = randomUUID()
  const window = new BrowserWindow({ acceptFirstMouse: true,
    icon: appIcon,
    width: 1120,
    height: 760,
    minWidth: 680,
    minHeight: 480,
    title: artifact.title,
    show: false,
    backgroundColor: '#F6F7FA',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  codeArtifacts.set(artifactId, artifact)
  codeArtifactWindows.set(artifactId, window)
  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    codeArtifactWindows.delete(artifactId)
    codeArtifacts.delete(artifactId)
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  // The preview iframe may run the supplied page's scripts, but it may not
  // navigate itself to a remote document (which would discard our CSP).
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    url.searchParams.set('artifact', artifactId)
    void window.loadURL(url.toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { artifact: artifactId } })
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({ acceptFirstMouse: true,
    icon: appIcon,
    width: 1240,
    height: 800,
    // Rail + inbox + chat + activity rail all need room at once.
    minWidth: 1060,
    minHeight: 600,
    show: false,
    backgroundColor: '#F6F7FA',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // macOS native controls exceed the compact 60px rail on newer systems.
  // The renderer supplies compact controls backed by native window actions.
  if (process.platform === 'darwin') mainWindow.setWindowButtonVisibility(false)

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function validateRoutineInput(input: CreateRoutineInput): void {
  if (!input.name?.trim() || !input.prompt?.trim()) throw new Error('Routine name and instructions are required')
  if (!store.accountAgents.some((agent) => agent.id === input.agentId)) throw new Error('Routine agent not found')
  if (!store.accountConversations.some((conversation) => conversation.id === input.conversationId)) {
    throw new Error('Routine conversation not found')
  }
  if (input.schedule.kind === 'once') {
    if (!Number.isFinite(input.schedule.runAt) || input.schedule.runAt <= Date.now()) {
      throw new Error('One-time routine must be scheduled in the future')
    }
  } else if (input.schedule.kind === 'interval') {
    if (!Number.isFinite(input.schedule.intervalMinutes) || input.schedule.intervalMinutes < 1) {
      throw new Error('Routine interval must be at least one minute')
    }
  } else {
    if (!input.schedule.days.length || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.schedule.time)) {
      throw new Error('Choose at least one day and a valid time')
    }
  }
}

function isDouchatRenderer(contents: Electron.WebContents | null): boolean {
  // The web app's calls run through the same handlers as this app's windows.
  if (contents === REMOTE_SENDER) return true
  return Boolean(contents && BrowserWindow.getAllWindows().some((window) => window.webContents === contents))
}

function configureMediaPermissions(): void {
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => (
    permission === 'media'
    && isDouchatRenderer(contents)
    && details.isMainFrame
    && details.mediaType === 'audio'
  ))
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(
      permission === 'media'
      && isDouchatRenderer(contents)
      && details.isMainFrame
      && Boolean(mediaTypes?.includes('audio'))
      && !mediaTypes?.includes('video')
    )
  })
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  // Electron creates a default File/Edit/View/Window menu on Windows when no
  // application menu is provided. Douchat exposes its actions in the app UI,
  // so remove the native menu instead of merely hiding it until Alt is pressed.
  if (process.platform === 'win32') Menu.setApplicationMenu(null)
  configureMediaPermissions()
  // Development auth returns through a loopback HTTP callback, so it must not
  // claim the production douchat:// scheme. Registering Electron.app here
  // causes macOS to route packaged-app login and payment callbacks back into
  // the development process instead of /Applications/Douchat.app.
  if (!development) {
    app.setAsDefaultProtocolClient(authScheme)
  } else {
    app.setAsDefaultProtocolClient(DEVELOPMENT_APP_SCHEME)
  }
  app.dock?.setIcon(appIcon)
  ipcMain.on('douchat:window-action', (event, action: string) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return
    if (action === 'close') mainWindow.close()
    else if (action === 'minimize') mainWindow.minimize()
    else if (action === 'fullscreen') mainWindow.setFullScreen(!mainWindow.isFullScreen())
  })
  ipcMain.handle('douchat:set-interface-language', (_event, language: unknown) => {
    runtime.setInterfaceLanguage(typeof language === 'string' ? language : '')
  })
  store = DouchatStore.atUserData(app.getPath('userData'))
  // The account id persisted in the database belongs to the previous app
  // session. Keep the workspace closed until DesktopAuth identifies the
  // current session; otherwise its scheduler could briefly run old tasks.
  store.setCurrentAccountId('')
  emailConnectors = new EmailConnectorManager(store, app.getPath('userData'))
  connany = new ConnanyManager(store, webAppUrl, () => auth?.getAccessToken(), url => shell.openExternal(url), fetch, () => notifyWindows(BrowserWindow.getAllWindows(), 'douchat:connany-changed'), () => runtime?.language === 'zh-CN' ? 'zh' : 'en', development)
  computer = new LocalComputerProvider(
    scheduleBroadcast,
    [app.getPath('downloads'), app.getPath('desktop'), app.getPath('documents')],
    (path) => shell.openPath(path)
  )
  runtime = new DouchatRuntime(store, computer, broadcast, {
    baseUrl: chatApiBaseUrl(webAppUrl),
    resolveAccessToken: () => auth?.getAccessToken(),
    onUnauthorized: async () => { await auth?.invalidateSession() },
    avatarFromImage: (image) => {
      const source = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'))
      const size = source.getSize()
      if (source.isEmpty() || !size.width || !size.height) throw new Error('The attached image could not be read.')
      const edge = Math.min(size.width, size.height)
      return source
        .crop({
          x: Math.floor((size.width - edge) / 2),
          y: Math.floor((size.height - edge) / 2),
          width: edge,
          height: edge
        })
        .resize({ width: 256, height: 256, quality: 'best' })
        .toDataURL()
    }
  }, { revision: () => connany.revision(), snapshot: () => emailConnectors.snapshot(), createTools: (id, hooks) => [...emailConnectors.createTools(id), ...(CONNECTORS_ENABLED ? connany.createTools(id, hooks) : [])], prepare: () => CONNECTORS_ENABLED ? connany.prepareForTurn() : Promise.resolve(), createLocalTools: (id, hooks) => CONNECTORS_ENABLED ? connany.createTools(id, hooks) : [] },
  // Agents a douchat-host runs itself go to it as owner tasks (remote/daemonClient.ts).
  hostAwareExecutor(desktopAgentExecutor, () => daemon))
  runtime.notifyChangesWith(scheduleBroadcast)
  imChannels = new IMChannelManager(join(app.getPath('userData'), 'im-channels'), {
    encrypt: value => {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error(ui('The system keychain is unavailable. Enable it and try again.', '系统钥匙串不可用，请启用后重试'))
      return safeStorage.encryptString(value).toString('base64')
    },
    decrypt: value => safeStorage.decryptString(Buffer.from(value, 'base64'))
  }, () => store.currentAccountId, id => store.accountAgents.some(agent => agent.id === id),
  async (agent, thread, text, signal, provider, media, receiptId) => {
    const answer = await replyToIM(store, runtime, agent, thread, text, signal, provider, media, receiptId)
    scheduleBroadcast()
    return answer
  }, (input, init) => net.fetch(String(input), init),
  (agent, thread, text, provider, messageId) => runtime.receiveIMMessage(agent, thread, text, provider, messageId),
  (event, detail) => diagnostics.write(event, detail))
  ipcMain.handle('douchat:im-list', (_event, agent) => imChannels!.list(agent))
  ipcMain.handle('douchat:im-connect', (_event, agent, input) => imChannels!.connect(agent, input))
  ipcMain.handle('douchat:im-disconnect', (_event, agent, provider) => imChannels!.disconnect(agent, provider))
  ipcMain.handle('douchat:im-login', (_event, agent, provider) => imChannels!.login(agent, provider))
  ipcMain.handle('douchat:im-cancel-login', (_event, agent, session) => imChannels!.cancelLogin(agent, session))
  ipcMain.handle('douchat:im-status', (_event, agent, session) => imChannels!.loginStatus(agent, session))
  runtime.setInterfaceLanguage(app.getLocale())
  scheduler = new RoutineScheduler(
    store,
    runtime,
    scheduleBroadcast,
    async () => (await auth.getUsageSummary()).credits
  )
  runtime.setRoutineCreator((input) => scheduler.createRoutine(input))
  const updateDriver = app.isPackaged
    ? electronUpdater.autoUpdater as unknown as UpdateDriver
    : undefined
  updater = new DesktopUpdater(
    updateDriver,
    app.getVersion(),
    app.isPackaged,
    () => runtime.snapshot().activity.length,
    broadcastUpdate
  )
  auth = new DesktopAuth(webAppUrl, authScheme, development, app.getPath('userData'), (state, reason) => {
    broadcastAuth(state)
    if (CONNECTORS_ENABLED && state.status === 'signed-in') void connany.command({ op: 'list' }).catch(() => { /* Recheck from Settings when the service is available. */ })
    if (CONNECTORS_ENABLED) {
      // Connany has no push; the backend shares one project-wide event poll.
      clearInterval(connanyEvents)
      if (state.status === 'signed-in') connanyEvents = setInterval(() => void connany.pollEvents().catch(() => { /* Retried on the next tick. */ }), 30_000)
    }
    // The development flow returns through a loopback HTTP server instead of
    // the custom protocol, so it does not pass through receiveAppUrl(). Bring
    // Douchat forward only for an explicit login callback, never for session
    // restoration, profile refreshes or profile edits in the background.
    if (state.status === 'signed-in' && reason === 'login-completed') { focusMainWindow(); void openPendingGroup() }
  }, new DeviceIdentity(join(app.getPath('userData'), 'device.json'), safeStorage))

  social = new SocialClient(webAppUrl, auth, store, runtime, scheduleBroadcast)
  // Every account record lives in the cloud; this computer keeps a synced copy.
  cloudSync = new CloudSyncClient(webAppUrl, {
    identity: () => {
      const state = auth!.getState()
      const token = auth!.getAccessToken()
      return state.status === 'signed-in' && token ? { id: state.user.id, token } : undefined
    },
    invalidateSession: () => auth!.invalidateSession()
  }, store.cloudSync, scheduleBroadcast, fetch, async (request) => {
    // A message typed in the web app runs exactly as if it were typed here.
    await runtime.sendMessage(request.conversationId, request.text, undefined, undefined, undefined, request.id)
    scheduleBroadcast()
  }, async (call) => {
    const result = await runDesktopRpc(call)
    scheduleBroadcast()
    return result
  }, hostname())
  cloudSync.onRoomRead = (mark) => store.applyRoomRead(mark)
  if (socialAccountId) cloudSync.start()
  runtime.setHumanSender((id, text, images, files, mentions) => social!.sendMessage(id, text, images, files, mentions))
  // douchat-host connections: enrollment and status here; agents on them run from this
  // computer like SSH agents, with the relay carrying their scripts (remote/daemonRelay.ts).
  daemon = new DaemonClient(webAppUrl, auth, store, connections, () => runtime.remoteChanged())
  connections.setDaemonBackend(daemon)
  setHostBindingLookup(agentId => daemon?.hostBinding(agentId))
  configureDaemonRelay(daemon.relayBackend())
  if (socialAccountId) daemon.start()
  ipcMain.handle('douchat:social-snapshot', (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return social!.snapshot()
  })
  ipcMain.handle('douchat:social-action', async (event, input: SocialAction) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    const result = await social!.action(input)
    return result.snapshot ? { ...result, snapshot: rendererSocialSnapshot(result.snapshot) } : result
  })
  ipcMain.handle('douchat:get-auth-state', () => auth.getState())
  ipcMain.handle('douchat:user-memory', (event, agentId?: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalAccountData(store).getUserMemory(agentId)
  })
  ipcMain.handle('douchat:save-user-memory', (event, document: import('../shared/userMemory').UserMemoryDocument, agentId?: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalAccountData(store).saveUserMemory(document, agentId)
  })
  ipcMain.handle('douchat:group-memory', (event, conversationId: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalAccountData(store).getGroupMemory(conversationId)
  })
  ipcMain.handle('douchat:save-group-memory', (event, document: import('../shared/userMemory').UserMemoryDocument, conversationId: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalAccountData(store).saveGroupMemory(document, conversationId)
  })
  ipcMain.handle('douchat:request-microphone-access', async (event) => {
    if (!isDouchatRenderer(event.sender)) return 'denied'
    if (process.platform !== 'darwin') return 'granted'
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return 'granted'
    if (status === 'restricted') return 'denied'
    // Some development signatures report `denied` before TCC has created an
    // entry. askForMediaAccess() is the call that actually registers the app
    // and presents the first-use system prompt. For a genuine prior denial it
    // simply resolves false without displaying another prompt.
    return await systemPreferences.askForMediaAccess('microphone') ? 'granted' : 'denied'
  })
  ipcMain.handle('douchat:open-microphone-settings', async (event) => {
    if (!isDouchatRenderer(event.sender)) return
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone')
    } else if (process.platform === 'win32') {
      await shell.openExternal('ms-settings:privacy-microphone')
    }
  })
  ipcMain.handle('douchat:start-login', () => auth.startLogin())
  ipcMain.handle('douchat:cancel-login', () => auth.cancelLogin())
  ipcMain.handle('douchat:retry-auth', () => auth.initialize())
  ipcMain.handle('douchat:sign-out', () => auth.signOut())
  ipcMain.handle('douchat:refresh-profile', () => auth.refreshProfile())
  ipcMain.handle('douchat:update-profile', (_event, input: UpdateDesktopProfileInput) => auth.updateProfile(input))
  ipcMain.handle('douchat:get-usage-summary', () => auth.getUsageSummary())
  ipcMain.handle('douchat:consume-credits-return', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false
    const shouldRefresh = pendingCreditsRefresh
    pendingCreditsRefresh = false
    return shouldRefresh
  })
  ipcMain.handle('douchat:open-subscription-plans', () => auth.openSubscriptionPlans())
  ipcMain.handle('douchat:open-billing-portal', () => auth.openBillingPortal())
  ipcMain.handle('douchat:get-update-state', () => updater.state())
  // More from Us: the service's list, else the last good copy, else the built-in one.
  ipcMain.handle('douchat:get-products', async () => {
    const cache = join(app.getPath('userData'), 'products.json')
    try {
      const response = await net.fetch(new URL('/api/products', webAppUrl).toString(), { signal: AbortSignal.timeout(10_000) })
      const payload = response.ok ? await response.json() : undefined
      const products = parseProducts(payload, webAppUrl)
      if (products) {
        await writeFile(cache, JSON.stringify(payload)).catch(() => undefined)
        return products
      }
    } catch { /* Offline: fall back below. */ }
    return parseProducts(await readFile(cache, 'utf8').then(JSON.parse).catch(() => undefined), webAppUrl) ?? BUILT_IN_PRODUCTS
  })
  ipcMain.handle('douchat:check-for-updates', () => updater.checkForUpdates())
  ipcMain.handle('douchat:install-update', () => updater.installUpdate())
  ipcMain.handle('douchat:maintain-local-agent', async (event, id: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string') throw new Error('Invalid local agent request')
    const agent = (await detectLocalAgents({ version: async () => undefined }, id))[0]
    if (!agent) throw new Error('Unknown local agent')
    const plan = await prepareNpmMaintenance(await resolveMaintenancePlan(agent))
    if (!plan.command) {
      await dialog.showMessageBox({ type: 'info', message: ui('Install or update this tool the way it was originally installed.', '请按该工具原有的安装方式安装或更新。'), detail: ui('Douchat does not run install commands for custom tools or tools from unconfirmed sources.', '自定义工具或未确认来源的工具不会自动运行安装命令。') })
      return false
    }
    const result = await dialog.showMessageBox({ type: 'question', message: `${agent.installed ? ui('Update', '更新') : ui('Install', '安装')} ${agent.name}`, detail: `${plan.needsDownload ? ui('First use: Douchat will download and verify a runtime first. This may take a few minutes.', '首次使用，需要先下载并校验运行环境，可能需要几分钟。') + '\n\n' : ''}${ui('The following command will run in your system terminal. Finish any prompts there; Douchat checks again when you return.', '将在系统终端执行以下命令。请在终端完成提示，返回后会自动检测。')}\n\n${plan.command}`, buttons: [ui('Cancel', '取消'), ui('Run in Terminal', '在终端执行')], defaultId: 1, cancelId: 0 })
    if (result.response !== 1) return false
    if (plan.needsDownload) await ensureManagedNode()
    resetShellPath()
    await openMaintenanceTerminal(plan.command)
    return true
  })
  ipcMain.handle('douchat:list-local-agent-models', (_event, agentId: string) => {
    const agent = store.accountAgents.find(item => item.id === agentId)
    if (!agent?.localAgentId) throw new Error('Local agent not found')
    return listLocalAgentModels(agent.localAgentId)
  })
  // Before a contact exists: listLocalAgentModels validates the runtime id itself.
  ipcMain.handle('douchat:list-runtime-models', (_event, localAgentId: unknown) => {
    if (typeof localAgentId !== 'string' || !localAgentId) throw new Error('Local agent not found')
    return listLocalAgentModels(localAgentId)
  })
  ipcMain.handle('douchat:detect-local-agents', async () => { resetShellPath(); return checkLocalAgentUpdates(await detectLocalAgents()) })
  ipcMain.handle('douchat:list-host-agents', async () => {
    if (!daemon) return []
    const hosted = await daemon.hostAgents().catch(() => [])
    // Earlier desktops added agents found on a host only to this computer's list, so the
    // same CLI could show up twice. One no contact uses, and that the host already has, goes.
    const used = new Set(store.accountAgents.map(agent => agent.localAgentId))
    const service = new Map((await connectionRegistry().list()).flatMap(item => item.kind === 'daemon' && item.daemon?.trust === 'service' ? [[item.id, item.daemon.hostId] as const] : []))
    let removed = false
    for (const agent of await detectLocalAgents({ version: async () => undefined })) {
      const hostId = agent.remoteAgent && service.get(agent.remoteAgent.connectionId)
      if (!hostId || used.has(agent.id) || !hosted.some(item => item.daemon?.hostId === hostId && item.command === agent.remoteAgent!.executable)) continue
      await removeCustomLocalAgent(agent.id).catch(() => undefined)
      removed = true
    }
    if (removed) connectionChanged()
    return hosted
  })
  ipcMain.handle('douchat:open-local-agent-terminal', (event, id: unknown) => {
    if (!isDouchatRenderer(event.sender) || id !== 'claude') throw new Error('Invalid local agent terminal request')
    return openLocalAgentTerminal(id, {
      termanyAutomationAllowed: process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false)
    })
  })
  ipcMain.handle('douchat:add-custom-local-agent', async (event, input: CustomLocalAgentInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid custom local agent request')
    await addCustomLocalAgent(input)
    resetShellPath()
    return checkLocalAgentUpdates(await detectLocalAgents())
  })
  ipcMain.handle('douchat:update-local-agent', async (event, id: string, input: CustomLocalAgentInput) => {
    if (!isDouchatRenderer(event.sender) || typeof id !== 'string') throw new Error('Invalid local agent request')
    const previous = await remoteAgentPlacement(id).catch(() => undefined)
    await updateLocalAgent(id, input)
    // Its running sessions belong to the old settings; the connection itself stays open for other agents.
    if (previous || input.remoteAgent) for (const agent of store.agents) if (agent.localAgentId === id) runtime?.disposeAgent(agent.id)
    cancelLocalModelQueries()
    daemon?.scheduleSync()
    resetShellPath()
    return checkLocalAgentUpdates(await detectLocalAgents())
  })
  const localAgentTests = new Map<number, AbortController>()
  ipcMain.handle('douchat:test-local-agent', async (event, id: string | undefined, input: CustomLocalAgentInput) => {
    if (!isDouchatRenderer(event.sender) || (id !== undefined && typeof id !== 'string')) throw new Error('Invalid local agent request')
    const senderId = event.sender.id
    if (localAgentTests.has(senderId)) throw new Error('A connection test is already running.')
    const abort = new AbortController()
    const cancel = () => abort.abort(new Error('Connection test cancelled.'))
    localAgentTests.set(senderId, abort)
    event.sender.once('destroyed', cancel)
    try { return await testLocalAgent(id, input, abort.signal) }
    finally { event.sender.removeListener('destroyed', cancel); localAgentTests.delete(senderId) }
  })
  ipcMain.handle('douchat:cancel-local-agent-test', (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid local agent request')
    localAgentTests.get(event.sender.id)?.abort(new Error('Connection test cancelled.'))
  })
  ipcMain.handle('douchat:list-ssh-hosts', async (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid local agent request')
    return listSshHosts()
  })
  ipcMain.handle('douchat:remove-custom-local-agent', async (event, id: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid custom local agent request')
    if (store.agents.some((agent) => agent.localAgentId === id)) {
      throw new Error('Remove contacts using this local agent before deleting it.')
    }
    await removeCustomLocalAgent(id)
    return checkLocalAgentUpdates(await detectLocalAgents())
  })
  // ─── Server connections ────────────────────────────────────────────────────
  // Every handler validates in main; renderer checks are only hints.
  const connectionChanged = (): void => notifyWindows(BrowserWindow.getAllWindows(), 'douchat:connections-changed')
  // Hosts added from the web app appear here once the daemon client brings them in.
  if (daemon) daemon.onConnectionsImported = () => { connectionChanged(); scheduleBroadcast() }
  connections.onStatus(connectionChanged)
  const connectionRequest = (event: Electron.IpcMainInvokeEvent, id?: unknown): string => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid connection request')
    if (id !== undefined && (typeof id !== 'string' || !/^conn_[0-9a-f]{32}$/.test(id))) throw new Error('Invalid connection')
    return id as string
  }
  /** Stop every turn and process of agents on a connection; they must not continue elsewhere. */
  const stopAgentsOn = async (connectionId: string): Promise<void> => {
    const ids = new Set(await agentsOnConnection(connectionId))
    for (const agent of store.agents) if (agent.localAgentId && ids.has(agent.localAgentId)) runtime?.disposeAgent(agent.id)
  }
  ipcMain.handle('douchat:list-connections', (event) => { connectionRequest(event); return connections.list() })
  ipcMain.handle('douchat:save-connection', async (event, input: unknown) => {
    connectionRequest(event)
    const id = input && typeof input === 'object' ? (input as { id?: unknown }).id : undefined
    const previous = typeof id === 'string' ? await connectionRegistry().get(id) : undefined
    const saved = await connections.save(input)
    // A new target: work started under the old settings must not continue.
    if (previous && previous.targetRevision !== saved.targetRevision) await stopAgentsOn(saved.id)
    cancelLocalModelQueries()
    connectionChanged(); scheduleBroadcast()
    return connections.list()
  })
  ipcMain.handle('douchat:set-connection-enabled', async (event, id: unknown, enabled: unknown) => {
    const connectionId = connectionRequest(event, id)
    if (typeof enabled !== 'boolean') throw new Error('Invalid connection request')
    // Saved first so no new turn can start on it, then running turns stop.
    // Nothing falls back to this computer.
    await connections.setEnabled(connectionId, enabled)
    if (!enabled) { await stopAgentsOn(connectionId); cancelLocalModelQueries() }
    daemon?.scheduleSync()
    connectionChanged(); scheduleBroadcast()
    return connections.list()
  })
  ipcMain.handle('douchat:set-connection-host-execution', async (event, id: unknown, enabled: unknown) => {
    const connectionId = connectionRequest(event, id)
    if (typeof enabled !== 'boolean') throw new Error('Invalid connection request')
    const connection = await connectionRegistry().get(connectionId)
    if (connection?.kind !== 'daemon') throw new Error('Only douchat-host connections can run agents on the server.')
    if (enabled) await daemon!.requireHostExecution(connection)
    // Running turns belong to the old place; nothing moves mid-turn.
    await stopAgentsOn(connectionId)
    await connections.setHostExecution(connectionId, enabled)
    cancelLocalModelQueries()
    daemon?.scheduleSync()
    connectionChanged(); scheduleBroadcast()
    return connections.list()
  })
  ipcMain.handle('douchat:list-trusted-devices', async (event) => {
    connectionRequest(event)
    if (!daemon) throw new Error('Sign in to Douchat first.')
    return daemon.listDevices()
  })
  ipcMain.handle('douchat:set-device-trusted', async (event, deviceId: unknown, trusted: unknown) => {
    connectionRequest(event)
    if (typeof deviceId !== 'string' || !/^dev_[0-9a-f-]{36}$/.test(deviceId) || typeof trusted !== 'boolean') throw new Error('Invalid device request')
    if (!daemon) throw new Error('Sign in to Douchat first.')
    await daemon.trustDevice(deviceId, trusted)
    return daemon.listDevices()
  })
  ipcMain.handle('douchat:remove-connection', async (event, id: unknown, mode: unknown) => {
    const connectionId = connectionRequest(event, id)
    if (mode !== 'disable-agents' && mode !== 'delete-agents') throw new Error('Invalid connection request')
    // Turned off first so no new turn starts, then running turns stop.
    await connections.setEnabled(connectionId, false)
    await stopAgentsOn(connectionId)
    cancelLocalModelQueries()
    // Agents still used by contacts are kept (and cannot run) even with delete-agents.
    const inUse = (localId: string) => store.agents.some(agent => agent.localAgentId === localId)
    await removeAgentsOnConnection(connectionId, mode, inUse)
    await connections.remove(connectionId)
    daemon?.scheduleSync()
    connectionChanged(); scheduleBroadcast()
    return connections.list()
  })
  const connectionTests = new Map<number, AbortController>()
  ipcMain.handle('douchat:test-connection', async (event, id: unknown) => {
    const connectionId = connectionRequest(event, id)
    connectionTests.get(event.sender.id)?.abort()
    const abort = new AbortController()
    connectionTests.set(event.sender.id, abort)
    try { return await connections.test(connectionId, AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)])) }
    finally { if (connectionTests.get(event.sender.id) === abort) connectionTests.delete(event.sender.id); connectionChanged() }
  })
  ipcMain.handle('douchat:discover-remote-agents', (event, id: unknown) => connections.discover(connectionRequest(event, id), AbortSignal.timeout(120_000)))
  ipcMain.handle('douchat:add-discovered-agents', async (event, id: unknown, chosen: unknown) => {
    const connectionId = connectionRequest(event, id)
    if (!Array.isArray(chosen) || !chosen.length || chosen.length > 11) throw new Error('Choose agents to add.')
    // Only what discovery found on this server can be added this way.
    const found = await connections.discover(connectionId, AbortSignal.timeout(120_000))
    const matches = (chosen as Array<{ adapter?: unknown; executable?: unknown; name?: unknown }>).map(item => {
      const match = found.find(agent => agent.adapter === item?.adapter && agent.executable === item?.executable)
      if (!match) throw new Error('This agent was not found on the server. Scan again.')
      return { ...match, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : match.adapter }
    })
    // A host that follows the account keeps its agents in its own configuration,
    // each with a contact, exactly as the web app adds them: every device sees the same ones.
    const connection = await connectionRegistry().get(connectionId)
    if (connection?.kind === 'daemon' && connection.daemon?.trust === 'service') {
      if (!daemon) throw new Error('Sign in to Douchat to use douchat-host connections.')
      await daemon.addHostAgents(connection, matches, ({ name, localAgentId }) => store.createAgent({ name, localAgentId, localAgentName: name, role: '', instructions: '', color: '#14B8A6', provider: 'local', model: 'default' }))
      push()
      connectionChanged()
      return [...await checkLocalAgentUpdates(await detectLocalAgents()), ...await daemon.hostAgents().catch(() => [])]
    }
    for (const match of matches) {
      // Already added from an earlier scan: keep the one there is.
      if (await hasRemoteAgent(connectionId, match.executable)) continue
      await addCustomLocalAgent({ name: match.name, command: match.executable,
        remoteAgent: { connectionId, adapter: match.adapter, executable: match.executable, args: [] } })
    }
    connectionChanged()
    return checkLocalAgentUpdates(await detectLocalAgents())
  })
  ipcMain.handle('douchat:open-connection-terminal', async (event, id: unknown) => {
    const connection = await connectionRegistry().get(connectionRequest(event, id))
    if (!connection) throw new Error('Connection not found')
    if (!connection.enabled) throw new Error('This connection is turned off.')
    if (connection.kind !== 'ssh' || !connection.ssh) throw new Error('douchat-host 连接不提供终端。请在服务器上直接操作。')
    await openSshTerminal(remoteTerminalArgs({ transport: 'ssh', ...connection.ssh, adapter: 'custom', executable: 'true', args: [] }))
  })
  // ─── douchat-host enrollment ───────────────────────────────────────────────
  const enrollmentId = (id: unknown): string => {
    if (typeof id !== 'string' || !/^hst_[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid install request')
    return id
  }
  ipcMain.handle('douchat:create-daemon-enrollment', (event) => { connectionRequest(event); return daemon!.createEnrollment() })
  ipcMain.handle('douchat:wait-daemon-enrollment', (event, id: unknown) => { connectionRequest(event); return daemon!.waitEnrollment(enrollmentId(id)) })
  ipcMain.handle('douchat:cancel-daemon-enrollment', (event, id: unknown) => { connectionRequest(event); daemon!.cancelEnrollment(enrollmentId(id)) })
  ipcMain.handle('douchat:complete-daemon-enrollment', async (event, id: unknown, input: unknown) => {
    connectionRequest(event)
    const value = input && typeof input === 'object' ? input as { name?: unknown } : {}
    await daemon!.completeEnrollment(enrollmentId(id), { name: typeof value.name === 'string' ? value.name : '' })
    connectionChanged(); scheduleBroadcast()
    return connections.list()
  })
  ipcMain.handle('douchat:search-messages', (event, id: string, query: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalAccountData(store).searchMessages(id, query)
  })
  ipcMain.handle('douchat:message-page', (event, conversationId: string, topicId: string, before?: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unknown window')
    return new LocalAccountData(store).getMessagePage(conversationId, topicId, before)
  })
  const invitationImage = (dataUrl: unknown) => {
    if (typeof dataUrl !== 'string' || dataUrl.length > 4_000_000 || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('Invalid invitation image')
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty() || image.getSize().width > 2048 || image.getSize().height > 2048) throw new Error('Invalid invitation image')
    return image
  }
  ipcMain.handle('douchat:copy-invitation-image', (event, dataUrl: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid clipboard request')
    clipboard.writeImage(invitationImage(dataUrl))
  })
  // Images that are not saved yet (e.g. pasted into the composer); the renderer sends PNG.
  ipcMain.handle('douchat:copy-image-data', (event, dataUrl: unknown) => {
    if (!isDouchatRenderer(event.sender) || typeof dataUrl !== 'string' || dataUrl.length > 48_000_000 || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('Invalid clipboard request')
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) throw new Error('Image could not be copied')
    clipboard.writeImage(image)
  })
  ipcMain.handle('douchat:save-invitation-image', async (event, dataUrl: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid invitation image')
    const image = invitationImage(dataUrl)
    const result = await dialog.showSaveDialog({ defaultPath: join(app.getPath('downloads'), 'douchat-invitation.png'), filters: [{ name: 'PNG', extensions: ['png'] }] })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, image.toPNG())
    return true
  })
  ipcMain.handle('douchat:copy-text', (event, text: string) => {
    if (!isDouchatRenderer(event.sender) || typeof text !== 'string') throw new Error('Invalid clipboard request')
    clipboard.writeText(text)
  })
  ipcMain.handle('douchat:copy-attachment', async (event, attachmentId: string) => {
    if (!isDouchatRenderer(event.sender) || typeof attachmentId !== 'string') throw new Error('Invalid clipboard request')
    const image = nativeImage.createFromDataURL(await store.attachmentDataUrl(attachmentId))
    if (image.isEmpty()) throw new Error('Image could not be copied')
    clipboard.writeImage(image)
  })
  ipcMain.handle('douchat:attachment-data', async (event, attachmentId: string) => {
    // An image a douchat-host task delivered for a chat started in the web app.
    if (typeof attachmentId === 'string' && attachmentId.startsWith('hosttask:') && daemon) {
      const item = await daemon.hostTaskAttachment(attachmentId)
      if (!item.mimeType?.startsWith('image/')) throw new Error('This attachment is not an image.')
      const dataUrl = `data:${item.mimeType};base64,${item.base64}`
      return event.sender === REMOTE_SENDER ? fitImageForSync(dataUrl) : dataUrl
    }
    const dataUrl = await store.attachmentDataUrl(attachmentId)
    // For the web app the image returns through a size-capped sync record.
    return event.sender === REMOTE_SENDER ? fitImageForSync(dataUrl) : dataUrl
  })
  ipcMain.handle('douchat:open-local-file', async (event, path: string, conversationId?: string) => {
    if (!isDouchatRenderer(event.sender) || typeof path !== 'string' || (conversationId !== undefined && typeof conversationId !== 'string')) throw new Error('Invalid file request')
    const document = await store.ownedDocumentPath(path)
    if (document) {
      const error = await shell.openPath(document)
      if (error) throw new Error(error)
    } else await computer.openLocalFile(path, () => {
      const conversation = store.accountConversations.find(item => item.id === conversationId)
      if (!conversation || !canAssignConversationWorkspace(conversation, store.accountAgents, store.currentAccountId)) return []
      const roots = [...(conversation.allowedFolders ?? []), ...(conversation.workspacePath ? [conversation.workspacePath] : [])]
      if (!conversation.workspacePath) {
        const topic = store.activeTopicId(conversation.id)
        for (const id of conversation.agentIds) {
          const agent = store.accountAgents.find(item => item.id === id)!
          const key = conversation.type === 'direct' ? `direct:${conversation.id}:${topic}` : groupMemberSessionId(conversation.id, id, topic)
          const workspace = openableWorkspace(agent, key, conversation.type === 'group')
          if (workspace) roots.push(workspace.directory)
        }
      }
      return roots.flatMap(root => { try { return [resolveSavedWorkspace(root)] } catch { return [] } })
    })
  })
  ipcMain.handle('douchat:get-snapshot', () => runtime.snapshot())
  const push = (): AppSnapshot => {
    const snapshot = runtime.snapshot()
    broadcast(snapshot)
    return snapshot
  }

  const tokenDanceFlows = new Map<number, AbortController>()
  ipcMain.handle('douchat:authorize-tokendance', async (event) => {
    if (!isDouchatRenderer(event.sender) || !store.currentAccountId) throw new Error('Unauthorized')
    const owner = event.sender.id
    const account = store.currentAccountId
    tokenDanceFlows.get(owner)?.abort()
    const controller = new AbortController()
    tokenDanceFlows.set(owner, controller)
    const cancel = () => controller.abort()
    event.sender.once('destroyed', cancel)
    try {
      const key = await authorizeTokenDance(url => shell.openExternal(url), controller.signal)
      if (store.currentAccountId !== account) throw new Error('Account changed. Please authorize again.')
      return key
    } finally {
      event.sender.removeListener('destroyed', cancel)
      if (tokenDanceFlows.get(owner) === controller) tokenDanceFlows.delete(owner)
    }
  })
  ipcMain.handle('douchat:cancel-tokendance', (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    tokenDanceFlows.get(event.sender.id)?.abort()
  })
  ipcMain.handle('douchat:custom-models', (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return customModels.list(store.currentAccountId)
  })
  ipcMain.handle('douchat:decision-settings', (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return store.decisionSettings()
  })
  ipcMain.handle('douchat:cloud-decision-models', (event) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return runtime.getCloudDecisionModels()
  })
  ipcMain.handle('douchat:save-decision-settings', (event, settings) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return runtime.saveDecisionSettings(settings)
  })
  ipcMain.handle('douchat:test-decision-settings', (event, settings) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return runtime.testDecisionSettings(settings)
  })
  ipcMain.handle('douchat:save-custom-models', (event, providers: CustomProviderInput[], defaultModel: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    const result = customModels.save(store.currentAccountId, providers, defaultModel)
    reloadCustomModels()
    push()
    return result
  })
  ipcMain.handle('douchat:test-custom-model', (event, input: CustomModelTest) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return customModels.test(store.currentAccountId, input)
  })
  ipcMain.handle('douchat:create-agent', async (event, input: CreateAgentInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    if ((input.customModel || input.cloudModel) && input.localAgentId) throw new Error("Select one execution mode.")
    if (input.customModel && input.cloudModel) throw new Error("Select one model source.")
    const localAgent = input.localAgentId ? await validateLocalAgent(input.localAgentId, { allowDaemon: true }) : undefined
    // The main process owns runtime bindings. In particular, a renderer cannot
    // choose a model for a Cloud Agent by smuggling provider/model over IPC.
    const localModel = input.localAgentId ? localModelId(input.localModel) : undefined
    if (localModel && !configurableLocalAgents.includes(localAgentAdapter(localAgent!))) throw new Error('This local agent does not support a model override')
    const binding = input.localAgentId
      ? { provider: 'local', model: localModel ?? 'default' }
      : input.customModel ? runtime.customAgentModel(input.customModel.providerId, input.customModel.model) : input.cloudModel ? runtime.cloudAgentModel(input.cloudModel.model) : runtime.defaultCloudAgentModel()
    const { customModel: _selection, cloudModel: _cloudSelection, localModel: _localModel, thinkingLevel: requestedThinking, ...agentInput } = input
    const agent = store.createAgent({
      ...agentInput,
      // Douchat cloud models do not take a per-agent thinking level.
      thinkingLevel: binding.provider === 'local' || binding.provider.startsWith(CUSTOM_PROVIDER_PREFIX) ? thinkingLevel(requestedThinking) : undefined,
      avatar: agentInput.avatar || (agentInput.avatarEmoji ? undefined : localAgent?.avatar),
      localAgentName: localAgent?.custom ? localAgent.name : undefined,
      ...binding,
      followDefaultModel: input.customModel?.providerId === '@default'
    })
    const direct = store.accountConversations.find(
      (conversation) => conversation.type === 'direct' && conversation.agentIds[0] === agent.id
    )
    // A new bot opens with its own proactive greeting, like a new topic does.
    if (direct) void runtime.greet(direct.id)
    if (localAgent?.daemon) daemon?.scheduleSync()
    return push()
  })
  ipcMain.handle('douchat:resolve-agent-permission', async (_event, id: string, allow: import('../shared/agentPermissions').PermissionApproval) => {
    if (typeof id !== 'string') throw new Error('Unknown approval')
    await runtime.resolveAgentPermission(id, allow)
    return push()
  })
  ipcMain.handle('douchat:export-agent-archive', async (event, agentId: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    const agent = store.accountAgents.find(agent => agent.id === agentId)
    if (!agent) throw new Error('Agent not found')
    const data = exportAgentArchive(agent)
    const filename = agent.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'agent'
    const options = { defaultPath: join(app.getPath('downloads'), `${filename}.zip`), filters: [{ name: 'ZIP', extensions: ['zip'] }] }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, data)
    shell.showItemInFolder(result.filePath)
    return true
  })
  ipcMain.handle('douchat:parse-agent-archive', (event, data: Uint8Array, root?: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return parseAgentArchive(data, root)
  })
  ipcMain.handle('douchat:parse-skill-archive', async (event, data: Uint8Array) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return parseSkillArchive(data)
  })
  ipcMain.handle('douchat:get-agent-skill', (event, agentId: string, skillId: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    const skill = store.accountAgents.find(agent => agent.id === agentId)?.skills?.find(item => item.id === skillId)
    if (!skill) throw new Error('Skill not found')
    return skill
  })
  ipcMain.handle('douchat:update-agent', async (_event, agentId: string, input: UpdateAgentInput) => {
    if (!store.accountAgents.some((agent) => agent.id === agentId)) throw new Error('Agent not found')
    const existing = store.accountAgents.find(agent => agent.id === agentId)!
    const { customModel, cloudModel, ...update } = input
    if (customModel && cloudModel) throw new Error("Select one model source.")
    // Whitelist before storing; 'default' clears the override.
    if ('thinkingLevel' in update) (update as UpdateAgentInput).thinkingLevel = thinkingLevel(update.thinkingLevel) ?? 'default'
    if ((customModel || cloudModel) && (existing.localAgentId || input.localAgentId)) throw new Error("Select one execution mode.")
    const selectedBinding = customModel ? runtime.customAgentModel(customModel.providerId, customModel.model) : cloudModel ? runtime.cloudAgentModel(cloudModel.model) : undefined
    input = { ...update, ...selectedBinding, followDefaultModel: customModel?.providerId === '@default' ? true : selectedBinding || input.localAgentId ? false : existing.followDefaultModel }
    // Douchat cloud models do not take a per-agent thinking level; clear any stale override.
    const finalProvider = input.localAgentId || existing.localAgentId ? 'local' : input.provider ?? existing.provider
    if (finalProvider !== 'local' && !finalProvider.startsWith(CUSTOM_PROVIDER_PREFIX) && (existing.thinkingLevel || 'thinkingLevel' in input)) input.thinkingLevel = 'default'
    if (input.model !== undefined && (input.localAgentId || existing.localAgentId)) {
      const model = localModelId(input.model)
      // A server agent takes the override of the CLI it runs (its adapter), as at launch.
      if (model && !configurableLocalAgents.includes(localAgentAdapter(await validateLocalAgent(input.localAgentId || existing.localAgentId!, { allowDaemon: true })))) throw new Error('This local agent does not support a model override')
      input = { ...input, model: model ?? 'default' }
    }
    const localAgent = input.localAgentId ? await validateLocalAgent(input.localAgentId, { allowDaemon: true }) : undefined
    const { localAgentName: _ignoredLocalAgentName, ...safeInput } = input
    store.updateAgent(agentId, {
      ...safeInput,
      ...(input.localAgentId !== undefined ? { localAgentName: localAgent?.custom ? localAgent.name : undefined } : {})
    }, selectedBinding ? { binding: selectedBinding, followDefault: cloudModel?.model === 'douchat-default' } : undefined)
    // Identity and model edits take effect on the next turn, not mid-session.
    runtime.disposeAgent(agentId)
    // Configuration and permissions reach a douchat-host only as a signed sync.
    daemon?.scheduleSync()
    return push()
  })
  ipcMain.handle('douchat:delete-agent', (_event, agentId: string) => {
    const agent = store.accountAgents.find((item) => item.id === agentId)
    if (!agent) throw new Error('Agent not found')
    if (agent.systemRole === 'admin') {
      throw new Error('The system administrator cannot be deleted')
    }
    runtime.disposeAgent(agentId)
    for (const provider of ['wechat', 'feishu', 'wecom', 'telegram'] as const) imChannels?.disconnect(agentId, provider)
    store.deleteAgent(agentId)
    daemon?.scheduleSync()
    return push()
  })
  ipcMain.handle('douchat:start-direct-chat', (_event, agentId: string) => {
    if (typeof agentId !== 'string' || !store.accountAgents.some((agent) => agent.id === agentId)) {
      throw new Error('Contact not found')
    }
    const { conversation, created } = store.ensureDirectConversation(agentId)
    store.markConversationRead(conversation.id)
    if (created) void runtime.greet(conversation.id)
    return { snapshot: push(), conversationId: conversation.id }
  })
  ipcMain.handle('douchat:create-group', (_event, input: CreateGroupInput) => {
    if (!input.agentIds?.length) throw new Error('A group needs at least one bot')
    const group = store.createGroup(input)
    void runtime.greet(group.id)
    return push()
  })
  ipcMain.handle('douchat:update-conversation', async (_event, conversationId: string, input: UpdateConversationInput) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    const target = store.accountConversations.find((conversation) => conversation.id === conversationId)!
    if (target.type === 'group' && target.remoteRoomId && input.name !== undefined && input.name.trim() !== target.name) {
      await social!.action({ action: 'rename-room', roomId: target.remoteRoomId, name: input.name.trim() })
    }
    store.updateConversation(conversationId, input)
    if (input.agentIds || input.leadAgentId) runtime.resetConversation(conversationId)
    return push()
  })
  // Folders are set per member. Main looks up where each agent runs; the
  // renderer only names the chat and the agent, never a server or a target.
  const workspaceChat = (conversationId: unknown): Conversation => {
    if (typeof conversationId !== 'string') throw new Error('Invalid workspace request')
    const conversation = store.accountConversations.find(item => item.id === conversationId)
    if (!conversation) throw new Error('Chat not found')
    return conversation
  }
  const workspaceMember = async (conversationId: unknown, agentId: unknown) => {
    const conversation = workspaceChat(conversationId)
    const agent = typeof agentId === 'string' ? store.accountAgents.find(item => item.id === agentId) : undefined
    if (!agent || !canAssignAgentWorkspace(conversation, agent, store.currentAccountId)) throw new Error('Only the owner can choose a folder for this agent in this chat.')
    // An agent its douchat-host runs works in a folder on that server, picked through the host.
    const hostRun = await hostExecutedAgent(agent)
    if (hostRun) return { conversation, agent, placement: undefined, hostRun, target: { ...hostTarget(hostRun.hostId), location: 'remote' as const } }
    const placement = await remoteAgentPlacement(agent.localAgentId)
    const target = placement ? { ...placement.target, location: 'remote' as const } : { ...localExecutionTarget(), location: 'local' as const }
    return { conversation, agent, placement, hostRun: undefined, target }
  }
  const workspaceView = async (conversationId: unknown): Promise<ConversationWorkspaceView> => {
    const conversation = workspaceChat(conversationId)
    const members = await Promise.all(ownMemberAgentIds(conversation, store.currentAccountId).map(async (agentId): Promise<MemberWorkspaceView | undefined> => {
      const agent = store.accountAgents.find(item => item.id === agentId)
      if (!agent) return undefined
      const hostRun = await hostExecutedAgent(agent).catch(() => null)
      if (hostRun) {
        const target = { ...hostTarget(hostRun.hostId), location: 'remote' as const }
        const resolved = memberWorkspace(conversation, agent, target, store.accountAgents, store.currentAccountId)
        return { agentId, location: 'remote', host: hostRun.label, noTerminal: true,
          ...(resolved.binding ? { path: resolved.binding.path, source: 'custom' as const } : { source: 'default' as const }) }
      }
      // A member whose connection is off or removed has no folder to set right now.
      const placement = await remoteAgentPlacement(agent.localAgentId).catch(() => null)
      if (placement === null) return undefined
      const target = placement ? { ...placement.target, location: 'remote' as const } : { ...localExecutionTarget(), location: 'local' as const }
      const resolved = memberWorkspace(conversation, agent, target, store.accountAgents, store.currentAccountId)
      return {
        agentId, location: target.location, ...(placement ? { host: remoteHostLabel(placement.spec) } : {}), ...(placement && placement.spec.transport !== 'ssh' ? { noTerminal: true } : {}),
        ...(resolved.binding ? { path: resolved.binding.path, source: 'custom' as const } : resolved.legacyPath ? { path: resolved.legacyPath, source: 'legacy' as const } : { source: 'default' as const }),
        ...(resolved.stale ? { stale: true } : {})
      }
    }))
    const visible = members.filter((item): item is MemberWorkspaceView => Boolean(item))
    return {
      eligible: visible.length > 0, members: visible,
      ...(conversation.workspacePath ? { legacyPath: conversation.workspacePath, legacyUnused: !visible.some(item => item.source === 'legacy') } : {})
    }
  }
  const saveMemberWorkspace = (conversation: Conversation, agentId: string, binding: AgentWorkspaceBinding | undefined): void => {
    store.setAgentWorkspace(conversation.id, agentId, binding)
    runtime.workspaceChanged(conversation.id)
    scheduleBroadcast()
  }
  ipcMain.handle('douchat:conversation-workspaces', (event, conversationId: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid workspace request')
    return workspaceView(conversationId)
  })
  ipcMain.handle('douchat:choose-agent-workspace', async (event, conversationId: unknown, agentId: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid workspace request')
    const { conversation, agent, target } = await workspaceMember(conversationId, agentId)
    // A folder picker on this computer can only produce a path on this computer.
    if (target.location !== 'local') throw new Error('This agent runs on a server. Choose a folder on that server instead.')
    const current = memberWorkspace(conversation, agent, target, store.accountAgents, store.currentAccountId)
    const defaultPath = current.binding?.path ?? current.legacyPath
    const options: Electron.OpenDialogOptions = { title: ui('Choose a workspace folder', '选择工作区文件夹'), buttonLabel: ui('Use this folder', '使用此文件夹'), properties: ['openDirectory', 'createDirectory'], ...(defaultPath ? { defaultPath } : {}) }
    if (process.platform === 'darwin') app.focus({ steal: true })
    BrowserWindow.fromWebContents(event.sender)?.focus()
    const result = await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return workspaceView(conversation.id)
    const folder = validateWorkspaceFolder(result.filePaths[0])
    const latest = await workspaceMember(conversation.id, agent.id)
    if (latest.target.location !== 'local' || latest.target.executionTargetId !== target.executionTargetId) throw new Error('The agent changed. Try again.')
    saveMemberWorkspace(latest.conversation, agent.id, { path: folder, executionTargetId: target.executionTargetId, targetRevision: target.targetRevision })
    return workspaceView(conversation.id)
  })
  ipcMain.handle('douchat:list-remote-agent-directories', async (event, conversationId: unknown, agentId: unknown, parent: unknown, name: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid workspace request')
    const { placement, hostRun } = await workspaceMember(conversationId, agentId)
    if (parent !== undefined && typeof parent !== 'string') throw new Error('Invalid folder')
    if (name !== undefined && typeof name !== 'string') throw new Error('Invalid folder')
    if (hostRun) return daemon!.hostFolders(hostRun.hostId, 'fs.listDirs', { ...(parent !== undefined ? { parent } : {}), ...(name !== undefined ? { name } : {}) })
    if (!placement) throw new Error('This agent runs on this computer.')
    const spec = await probeRemoteAgent(placement.spec)
    return listRemoteDirectories(spec, parent, name)
  })
  ipcMain.handle('douchat:choose-remote-agent-workspace', async (event, conversationId: unknown, agentId: unknown, parent: unknown, name: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid workspace request')
    const { conversation, agent, placement, hostRun } = await workspaceMember(conversationId, agentId)
    if (hostRun) {
      // The host resolves and checks the folder on its own disk.
      const { path } = await daemon!.hostFolders(hostRun.hostId, 'fs.resolveDir', { parent, ...(name !== undefined && name !== null ? { name } : {}) }) as { path: string }
      const latest = await workspaceMember(conversation.id, agent.id)
      if (latest.hostRun?.hostId !== hostRun.hostId) throw new Error('The agent\'s server changed. Try again.')
      saveMemberWorkspace(latest.conversation, agent.id, { path, ...hostTarget(hostRun.hostId) })
      return workspaceView(conversation.id)
    }
    if (!placement) throw new Error('This agent runs on this computer. Choose a local folder instead.')
    const spec = await probeRemoteAgent(placement.spec)
    // The renderer names a listed folder and optionally one child; main joins and resolves.
    const resolved = await resolveRemoteWorkspace(spec, parent, name === undefined || name === null ? undefined : name)
    // The server may have been edited while the folder was resolving.
    const latest = await workspaceMember(conversation.id, agent.id)
    if (!latest.placement || latest.placement.target.executionTargetId !== placement.target.executionTargetId || latest.placement.target.targetRevision !== placement.target.targetRevision) throw new Error('The agent\'s server changed. Try again.')
    saveMemberWorkspace(latest.conversation, agent.id, { path: resolved, ...placement.target })
    return workspaceView(conversation.id)
  })
  ipcMain.handle('douchat:clear-agent-workspace', async (event, conversationId: unknown, agentId: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid workspace request')
    const conversation = workspaceChat(conversationId)
    const agent = typeof agentId === 'string' ? store.accountAgents.find(item => item.id === agentId) : undefined
    if (!agent || agent.ownerId !== store.currentAccountId) throw new Error('Only the owner can change this agent\'s folder.')
    if (conversation.agentWorkspaces?.[agent.id] || conversation.hostWorkspaces?.[agent.id]) saveMemberWorkspace(conversation, agent.id, undefined)
    return workspaceView(conversation.id)
  })
  ipcMain.handle('douchat:clear-conversation-workspace', (event, conversationId: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid workspace request')
    const conversation = workspaceChat(conversationId)
    if (conversation.workspacePath) {
      store.setConversationWorkspace(conversation.id, undefined)
      runtime.workspaceChanged(conversation.id)
      scheduleBroadcast()
    }
    return workspaceView(conversation.id)
  })
  ipcMain.handle('douchat:open-agent-workspace', async (event, conversationId: unknown, agentId: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid workspace request')
    const { conversation, agent, target } = await workspaceMember(conversationId, agentId)
    if (target.location !== 'local') throw new Error('This folder is on a server. Copy its path or open it in a terminal.')
    const resolved = memberWorkspace(conversation, agent, target, store.accountAgents, store.currentAccountId)
    let directory = resolved.binding?.path ?? resolved.legacyPath
    if (directory) directory = resolveSavedWorkspace(directory)
    else {
      const topicId = store.activeTopicId(conversation.id)
      const key = conversation.type === 'direct' ? `direct:${conversation.id}:${topicId}` : groupMemberSessionId(conversation.id, agent.id, topicId)
      directory = openableWorkspace(agent, key, conversation.type === 'group')?.directory ?? localWorkspace(agent, key)?.directory
    }
    if (!directory) throw new Error('Workspace unavailable')
    const error = await shell.openPath(directory)
    if (error) throw new Error(error)
  })
  ipcMain.handle('douchat:open-remote-agent-workspace-terminal', async (event, conversationId: unknown, agentId: unknown) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid workspace request')
    const { conversation, agent, placement, target } = await workspaceMember(conversationId, agentId)
    if (!placement) throw new Error('This agent runs on this computer.')
    const binding = memberWorkspace(conversation, agent, target, store.accountAgents, store.currentAccountId).binding
    if (!binding) throw new Error('No folder has been chosen on the server for this agent.')
    if (placement.spec.transport !== 'ssh') throw new Error('douchat-host 连接不提供终端。请在服务器上直接操作。')
    await openSshTerminal(remoteTerminalArgs(placement.spec, binding.path))
  })
  ipcMain.handle('douchat:open-conversation-window', (_event, conversationId: string) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    openChatWindow(conversationId)
  })
  ipcMain.handle('douchat:open-code-artifact', (event, input: CodeArtifactInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid preview request')
    openCodeArtifactWindow(input)
  })
  ipcMain.handle('douchat:get-code-artifact', (event, artifactId: string) => {
    if (typeof artifactId !== 'string') return null
    const window = codeArtifactWindows.get(artifactId)
    if (!window || window.isDestroyed() || window.webContents !== event.sender) return null
    return codeArtifacts.get(artifactId) ?? null
  })
  ipcMain.handle('douchat:connany', (event, command) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid connector request')
    return connany.command(command)
  })
  ipcMain.handle('douchat:connany-select', (event, selection) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid connector request')
    return connany.select(selection)
  })
  ipcMain.handle('douchat:test-email-connector', (event, input: EmailConnectorInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid connector request')
    return emailConnectors.test(input)
  })
  ipcMain.handle('douchat:save-email-connector', async (event, input: EmailConnectorInput) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Invalid connector request')
    await emailConnectors.save(input)
    for (const agent of store.accountAgents) runtime.disposeAgent(agent.id)
    return push()
  })
  ipcMain.handle('douchat:disconnect-email-connector', async (event, connectorId: string) => {
    if (!isDouchatRenderer(event.sender) || typeof connectorId !== 'string') throw new Error('Invalid connector request')
    await emailConnectors.disconnect(connectorId)
    for (const agent of store.accountAgents) runtime.disposeAgent(agent.id)
    return push()
  })
  ipcMain.handle('douchat:delete-message', async (event, conversationId: string, messageId: string) => {
    if (!isDouchatRenderer(event.sender) || typeof conversationId !== 'string' || typeof messageId !== 'string') throw new Error('Invalid message request')
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = { type: 'warning' as const, message: ui('Delete this message?', '删除这条消息？'), detail: ui('The message will be removed from your local chat history and cannot be recovered. This does not unsend it for others.', '消息将从本地聊天记录中删除，无法恢复。此操作不会撤回对方的消息。'), buttons: [ui('Cancel', '取消'), ui('Delete', '删除')], defaultId: 0, cancelId: 0 }
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) return false
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    store.deleteMessage(conversationId, messageId)
    push()
    return true
  })
  ipcMain.handle('douchat:delete-conversation', async (event, conversationId: string) => {
    const target = store.accountConversations.find((conversation) => conversation.id === conversationId)
    if (!target) return runtime.snapshot()
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options = { type: 'warning' as const, message: ui(`Delete the chat with “${target.name}”?`, `删除与“${target.name}”的聊天？`), detail: ui('The chat history will be deleted. This cannot be undone.', '聊天记录会被删除，此操作无法撤销。'), buttons: [ui('Cancel', '取消'), ui('Delete', '删除')], defaultId: 0, cancelId: 0 }
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) return runtime.snapshot()
    chatWindows.get(conversationId)?.close()
    runtime.stopConversation(conversationId)
    runtime.resetConversation(conversationId)
    store.deleteConversation(conversationId)
    return push()
  })
  ipcMain.handle('douchat:set-conversation-pinned', (_event, conversationId: string, pinned: boolean) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    store.setConversationPinned(conversationId, Boolean(pinned))
    return push()
  })
  ipcMain.handle('douchat:mark-read', (_event, conversationId: string) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    const conversation = store.conversation(conversationId)
    if (conversation?.type === 'direct') {
      void runtime.greet(conversationId)
    }
    store.markConversationRead(conversationId)
    return push()
  })
  ipcMain.handle('douchat:mark-all-read', () => {
    store.markAllConversationsRead()
    return push()
  })
  ipcMain.handle('douchat:create-topic', (_event, conversationId: string) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    const topic = store.createTopic(conversationId)
    if (topic) void runtime.greet(conversationId)
    return push()
  })
  ipcMain.handle('douchat:rename-topic', (_event, conversationId: string, topicId: string, title: string) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    store.renameTopic(conversationId, topicId, title)
    return push()
  })
  ipcMain.handle('douchat:delete-topic', (_event, conversationId: string, topicId: string) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    runtime.resetConversation(conversationId, topicId)
    store.deleteTopic(conversationId, topicId)
    return push()
  })
  ipcMain.handle('douchat:set-active-topic', (_event, conversationId: string, topicId: string) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    store.setActiveTopic(conversationId, topicId)
    return push()
  })
  ipcMain.handle('douchat:send-message', async (
    _event,
    conversationId: string,
    text: string,
    images?: MessageImageInput[],
    files?: MessageFileInput[],
    mentions?: SelectedMention[]
  ) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    await runtime.sendMessage(conversationId, text, images, files, mentions)
  })
  ipcMain.handle('douchat:prewarm-conversation', (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string' || !store.accountConversations.some((conversation) => conversation.id === conversationId)) return
    void runtime.prewarmConversation(conversationId)
  })
  ipcMain.handle('douchat:stop-conversation', (_event, conversationId: string) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    runtime.stopConversation(conversationId)
  })
  ipcMain.handle('douchat:set-endpoint', async (_event, input: EndpointInput) => {
    await runtime.setEndpoint(input)
    return push()
  })
  ipcMain.handle('douchat:test-endpoint', (_event, input: EndpointInput) => runtime.testEndpoint(input))
  ipcMain.handle('douchat:clear-conversation', (_event, conversationId: string) => {
    if (!store.accountConversations.some((conversation) => conversation.id === conversationId)) throw new Error('Chat not found')
    const topicId = store.activeTopicId(conversationId)
    store.clearConversation(conversationId, topicId)
    runtime.resetConversation(conversationId, topicId)
    return push()
  })
  // Support reads a conversation only after the user shares it here; see docs/cloud-sync.md.
  const shareableConversation = (conversationId: string) => {
    const conversation = store.accountConversations.find(item => item.id === conversationId)
    if (!conversation || conversation.remoteRoomId || conversation.person) throw new Error('Chat not found')
    if (!cloudSync) throw new Error('Sign in to Douchat first.')
    return cloudSync
  }
  ipcMain.handle('douchat:support-shares', (event, conversationId: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    return shareableConversation(conversationId).supportShares(conversationId)
  })
  ipcMain.handle('douchat:create-support-share', (event, conversationId: string, hours: number, note: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    if (!SUPPORT_SHARE_HOURS.includes(hours as typeof SUPPORT_SHARE_HOURS[number])) throw new Error('Invalid duration')
    return shareableConversation(conversationId).createSupportShare(conversationId, hours, typeof note === 'string' ? note.slice(0, 500) : '')
  })
  ipcMain.handle('douchat:revoke-support-share', async (event, shareId: string) => {
    if (!isDouchatRenderer(event.sender)) throw new Error('Unauthorized')
    if (!cloudSync || typeof shareId !== 'string') throw new Error('Sign in to Douchat first.')
    await cloudSync.revokeSupportShare(shareId)
  })
  ipcMain.handle('douchat:reset-conversation-context', async (_event, conversationId: string) => {
    const conversation = store.accountConversations.find(item => item.id === conversationId)
    if (!conversation) throw new Error('Chat not found')
    if (conversation.remoteRoomId) {
      if (!social) throw new Error('Chat service is unavailable')
      await social.resetConversationContext(conversationId)
    }
    const topicId = store.activeTopicId(conversationId)
    runtime.resetConversation(conversationId, topicId)
    store.resetConversationContext(conversationId, topicId)
    if (conversation.type === 'direct' && !conversation.remoteRoomId) void runtime.greet(conversationId)
    return push()
  })
  ipcMain.handle('douchat:create-routine', (_event, input: CreateRoutineInput) => {
    validateRoutineInput(input)
    scheduler.createRoutine({
      ...input,
      name: input.name.trim(),
      prompt: input.prompt.trim()
    })
    return runtime.snapshot()
  })
  ipcMain.handle('douchat:delete-routine', (_event, routineId: string) => {
    scheduler.deleteRoutine(routineId)
    return runtime.snapshot()
  })
  ipcMain.handle('douchat:set-routine-enabled', (_event, routineId: string, enabled: boolean) => {
    scheduler.setEnabled(routineId, Boolean(enabled))
    return runtime.snapshot()
  })
  ipcMain.handle('douchat:run-routine-now', async (_event, routineId: string) => {
    await scheduler.runNow(routineId)
  })
  ipcMain.handle('douchat:start-computer', async (_event, agentId: string) => {
    if (!store.accountAgents.some((agent) => agent.id === agentId)) throw new Error('Agent not found')
    await computer.start(agentId)
    const snapshot = runtime.snapshot()
    broadcast(snapshot)
    return snapshot
  })
  ipcMain.handle('douchat:stop-computer', async (_event, agentId: string) => {
    if (!store.accountAgents.some((agent) => agent.id === agentId)) throw new Error('Agent not found')
    await computer.stop(agentId)
    const snapshot = runtime.snapshot()
    broadcast(snapshot)
    return snapshot
  })
  ipcMain.handle('douchat:show-computer', async (_event, agentId: string) => {
    if (!store.accountAgents.some((agent) => agent.id === agentId)) throw new Error('Agent not found')
    await computer.show(agentId)
  })

  // Agents are not started until connections are migrated (docs/remote-connections.md §3).
  try {
    // Before migrateConnections: it no longer carries the old sharing switch over.
    const narrowed = await migrateSharingToPermissions(app.getPath('userData'), store)
    if (narrowed) diagnostics.write('connections.sharing-migrated', String(narrowed))
    const migrated = await migrateConnections(app.getPath('userData'), connectionRegistry())
    migrateWorkspaceTargets(store, migrated)
  } catch (error) {
    diagnostics.write('connections.migration-failed', String(error))
    void dialog.showMessageBox({ type: 'warning', message: ui('Server agents could not be set up', '无法完成服务器智能体的迁移'), detail: `${error instanceof Error ? error.message : String(error)}\n\n${ui('Agents on servers are unavailable until this is fixed. Agents on this computer work normally.', '修复前服务器上的智能体不可用，本机智能体不受影响。')}` })
  }
  const skipped = await skippedMigrationAgents(app.getPath('userData'))
  if (skipped.length) {
    diagnostics.write('connections.migration-skipped', JSON.stringify(skipped))
    void dialog.showMessageBox({ type: 'warning', message: ui('Some server agents were not moved to connections', '部分服务器智能体未能迁移到连接'),
      detail: `${skipped.join(', ')}\n\n${ui('Their saved SSH settings are invalid. They are kept unchanged in local-agents.json; add them again in Settings → Connections.', '它们保存的 SSH 设置无效，已原样保留在 local-agents.json 中。请在「设置 → 连接」中重新添加。')}` })
  }
  void connections.start()
  app.on('browser-window-focus', () => connections.retryFailed())
  startupReady = true
  createWindow()
  void auth.initialize().then(() => {
    if (!pendingAuthUrl) return
    const url = pendingAuthUrl
    pendingAuthUrl = ''
    return auth.handleCallback(url)
  })
  // Packaged clients quietly check after launch; development never contacts
  // the release feed, and draft releases are not copied to the public CDN.
  updater.startAutomaticChecks()
  scheduler.start()
  powerMonitor.on('resume', () => { scheduler.checkNow(); updater.checkAfterResume() })
  app.on('activate', () => focusMainWindow())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (quitting) return
  quitting = true
  updater?.stopAutomaticChecks()
  cancelLocalModelQueries()
  social?.stop()
  cloudSync?.stop()
  imChannels?.stop()
  if (localWorkBlocker !== undefined) { powerSaveBlocker.stop(localWorkBlocker); localWorkBlocker = undefined }
  for (const agent of store?.agents ?? []) runtime?.disposeAgent(agent.id)
  // Also covers transient and removed agents' processes the loop above can't name.
  disposeAllLocalAgentSessions()
  scheduler?.dispose()
  computer?.dispose()
  connections.stop()
  void closeRemoteConnections()
})

app.on('will-quit', () => {
  // Closing checkpoints the WAL, so the next launch opens a single tidy file.
  store?.close()
})
