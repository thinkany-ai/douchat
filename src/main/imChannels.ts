import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import * as lark from '@larksuiteoapi/node-sdk'
import { downloadMedia, decryptWechatMedia, decryptWecomMedia, dispositionName, IMMediaError, MAX_IM_FILE_BYTES, type IMMedia, type IMReplyPart } from './imMedia'
import { startIMTyping } from './imTyping'
import { formatIMMessages, type IMFormattedMessage } from './imFormatting'
import { openWecom, validateWecom, wecomPlatform, wecomQR, wecomReqId, WecomAuthError, WecomSupersededError, type WecomConnection, type WecomFrame, type WecomSocketFactory } from './wecom'
import type { IMChannel, IMConnectInput, IMLogin, IMLoginStatus, IMProvider, IMQRProvider } from '../shared/imChannels'
import { ATTACHMENT_LIMITS } from '../shared/attachments'

interface RecordData {
  id: string; owner: string; agentId: string; provider: IMProvider; label: string
  token: string; remoteId?: string; appId?: string; baseURL?: string; peer?: string; pairingCode: string
  /** The account that scanned to create the bot; its first private message pairs without /pair. */
  pairUser?: string
  cursor?: string; seen: string[]
  inbox?: { id: string; raw: any; state: 'queued' | 'running'; receiptId?: string; receivedAt?: number }[]
}
interface Codec { encrypt(value: string): string; decrypt(value: string): string }
interface Worker { abort: AbortController; close?: () => void; status: IMChannel['status']; error?: string; active: number; pending: (() => Promise<void>)[]; accepted: Set<string>; delivery: Promise<void>; typingCount: number; typingStop?: ReturnType<typeof startIMTyping>; typingBarrier?: Promise<void>; wecom?: WecomConnection }
interface Inbound { id: string; peer: string; sender?: string; text: string; context?: string; media?: () => Promise<IMMedia[]>; settle?: () => Promise<unknown> }
const WECHAT = 'https://ilinkai.weixin.qq.com'
const FEISHU_REGISTRATION = 'https://accounts.feishu.cn/oauth/v1/app/registration'
/** WeCom closes a reply stream after ~6 minutes; later output is pushed instead. */
const WECOM_STREAM_AGE = 5 * 60_000 + 30_000
/** WeCom renders Markdown, but desktop-local links mean nothing there. */
export function wecomMarkdown(text: string): string {
  return text.replace(/!?\[([^\]]*)\]\(<?(?:douchat-file|file):[^)>]*>?\)/gi, (_match, name: string) => `📄 \`${name || '文件'}\``)
}
const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} }
export function splitIMText(text: string, limit = 3500): string[] {
  const chars = Array.from(text)
  const parts: string[] = []
  for (let i = 0; i < chars.length; i += limit) parts.push(chars.slice(i, i + limit).join(''))
  return parts
}
export function wechatBaseURL(value?: string): string {
  const url = new URL(value || WECHAT)
  if (url.protocol !== 'https:' || !(url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.ilinkai.weixin.qq.com')) || url.port || url.username || url.password) throw new Error('微信返回了无效的服务地址')
  return url.origin
}

/** Credentials never cross IPC. One cancellable transport per owner/contact/provider. */
export class IMChannelManager {
  private records: RecordData[] = []
  private workers = new Map<string, Worker>()
  private logins = new Map<string, { owner: string; agent: string; provider: IMQRProvider; qr: string; expires: number }>()
  private owner = ''
  private storageError = false
  private generation = 0
  private connecting = new Set<string>()
  constructor(private directory: string, private codec: Codec,
    private currentOwner: () => string, private hasAgent: (id: string) => boolean,
    private reply: (agentId: string, thread: string, text: string, signal: AbortSignal, provider?: IMProvider, media?: IMMedia[], receiptId?: string) => Promise<IMReplyPart[]>,
    private request: typeof fetch = fetch,
    private received?: (agentId: string, thread: string, text: string, provider: IMProvider, messageId: string) => string,
    private diagnostic?: (event: string, detail: string) => void,
    private socket: WecomSocketFactory = url => new WebSocket(url)) {}
  private file(): string { return join(this.directory, createHash('sha256').update(this.owner).digest('hex') + '.json') }
  private save(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = this.file()
    writeFileSync(file + '.tmp', this.codec.encrypt(JSON.stringify(this.records)), { mode: 0o600 })
    renameSync(file + '.tmp', file)
  }
  activate(): void {
    this.stop()
    this.owner = this.currentOwner()
    this.records = []
    this.storageError = false
    if (!this.owner) return
    try {
      if (existsSync(this.file())) this.records = JSON.parse(this.codec.decrypt(readFileSync(this.file(), 'utf8')))
    } catch (error) { this.storageError = true; throw error }
    for (const record of this.records) if (this.hasAgent(record.agentId)) this.start(record)
  }
  stop(): void {
    this.generation++
    for (const worker of this.workers.values()) { worker.abort.abort(); worker.close?.() }
    this.workers.clear(); this.logins.clear()
  }
  private assert(agent: string): void {
    if (this.storageError) throw new Error('无法读取渠道凭证，请检查系统钥匙串后重新登录')
    if (!this.owner || this.owner !== this.currentOwner() || !this.hasAgent(agent)) throw new Error('联系人不存在或账号已切换')
  }
  list(agent: string): IMChannel[] {
    this.assert(agent)
    return this.records.filter(r => r.agentId === agent).map(r => {
      const worker = this.workers.get(r.id)
      return { agentId: agent, provider: r.provider, label: r.label, status: worker?.status ?? 'error', error: worker?.error,
        paired: Boolean(r.peer), ...(!r.peer ? { pairingCode: r.pairingCode } : {}) }
    })
  }
  disconnect(agent: string, provider: IMProvider): void {
    this.assert(agent)
    const record = this.records.find(r => r.agentId === agent && r.provider === provider)
    if (!record) return
    const previous = this.records
    this.records = this.records.filter(r => r !== record)
    try { this.save() } catch (error) { this.records = previous; throw error }
    const worker = this.workers.get(record.id)
    worker?.abort.abort(); worker?.close?.(); this.workers.delete(record.id)
    for (const [id, login] of this.logins) if (login.agent === agent) this.logins.delete(id)
  }
  private commit(record: RecordData): void {
    this.assert(record.agentId)
    if (this.records.some(r => r.provider === record.provider && (r.appId || r.remoteId || r.label) === (record.appId || record.remoteId || record.label))) throw new Error('这个机器人已经绑定了联系人，请先断开原连接')
    if (this.records.some(r => r.agentId === record.agentId && r.provider === record.provider)) throw new Error('请先断开已有渠道')
    this.records.push(record)
    try { this.save() } catch (error) { this.records.pop(); throw error }
    this.start(record)
  }
  async connect(agent: string, input: IMConnectInput): Promise<void> {
    this.assert(agent)
    if (!input || !['telegram', 'feishu', 'wecom'].includes(input.provider)) throw new Error('请选择支持的渠道')
    const lock = `${this.owner}:${agent}:${input.provider}`
    if (this.connecting.has(lock)) throw new Error('正在连接，请稍候')
    this.connecting.add(lock)
    const generation = this.generation
    try {
      const secret = input.provider === 'telegram' ? input.token : input.provider === 'wecom' ? input.secret : input.appSecret
      const token = typeof secret === 'string' ? secret.trim() : ''
      if (!token || token.length > 500) throw new Error('请输入有效的机器人凭证')
      const appId = input.provider === 'wecom' ? input.botId : input.appId
      const record: RecordData = { id: randomUUID(), owner: this.owner, agentId: agent, provider: input.provider, token,
        appId: typeof appId === 'string' ? appId.trim() : undefined, label: '', pairingCode: randomBytes(8).toString('hex'), seen: [] }
      if (record.provider === 'telegram') {
        if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Bot Token 格式不正确')
        const me = await this.telegram(record, 'getMe', {})
        if (!me?.id || !me.username) throw new Error('Telegram 未返回有效机器人信息')
        record.remoteId = String(me.id)
        record.label = '@' + me.username
        const hook = await this.telegram(record, 'getWebhookInfo', {})
        if (hook.url) throw new Error('该机器人已配置 Webhook，请先在原服务中解除后再连接')
      } else if (record.provider === 'wecom') {
        if (!record.appId || !/^[\w-]{1,128}$/.test(record.appId)) throw new Error('请输入有效的 Bot ID')
        // Only safe before commit: a successful subscribe takes over any live connection for this bot.
        if (this.records.some(r => r.provider === 'wecom' && r.appId === record.appId)) throw new Error('这个机器人已经绑定了联系人，请先断开原连接')
        await validateWecom(this.socket, record.appId, token).catch(error => {
          throw error instanceof WecomAuthError ? error : new Error('无法连接企业微信，请检查网络后重试')
        })
        record.label = record.appId
      } else {
        if (!record.appId || !/^cli_[0-9a-fA-F]{16}$/.test(record.appId)) throw new Error('请输入有效的 App ID')
        await this.json('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: record.appId, app_secret: token })
        record.label = record.appId
      }
      if (generation !== this.generation) throw new Error('账号已切换，请重新连接')
      this.commit(record)
    } finally { this.connecting.delete(lock) }
  }
  async login(agent: string, provider: IMQRProvider = 'wechat'): Promise<IMLogin> {
    this.assert(agent)
    if (!['wechat', 'feishu', 'wecom'].includes(provider)) throw new Error('请选择支持的渠道')
    const generation = this.generation
    let code: string, qr: string, ttl: number
    if (provider === 'feishu') {
      // Device-code flow that creates a "PersonalAgent" app on the scanner's tenant, as @larksuite/openclaw-lark does.
      const data = await this.form(FEISHU_REGISTRATION, { action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id' })
      if (!data.device_code || !data.verification_uri_complete) throw new Error('获取飞书二维码失败')
      const url = new URL(data.verification_uri_complete)
      if (url.protocol !== 'https:') throw new Error('获取飞书二维码失败')
      url.searchParams.set('from', 'onboard')
      code = data.device_code; qr = url.href; ttl = Math.min(Number(data.expires_in) || 600, 900) * 1000
    } else if (provider === 'wecom') {
      const data = await wecomQR(this.request, `/generate?source=wecom-cli&plat=${wecomPlatform()}`)
      if (!data.scode || !data.auth_url) throw new Error('获取企业微信二维码失败')
      code = data.scode; qr = data.auth_url; ttl = 300_000
    } else {
      const data = await this.json(WECHAT + '/ilink/bot/get_bot_qrcode?bot_type=3')
      if (!data.qrcode || !data.qrcode_img_content) throw new Error('获取微信二维码失败')
      code = data.qrcode; qr = data.qrcode_img_content; ttl = 240_000
    }
    this.assert(agent)
    if (generation !== this.generation) throw new Error('账号已切换')
    for (const [id, login] of this.logins) if (login.agent === agent || login.expires < Date.now()) this.logins.delete(id)
    const sessionId = randomUUID()
    this.logins.set(sessionId, { owner: this.owner, agent, provider, qr: code, expires: Date.now() + ttl })
    return { sessionId, qr }
  }
  cancelLogin(agent: string, sessionId: string): void {
    const login = this.logins.get(sessionId)
    if (login?.owner === this.currentOwner() && login.agent === agent) this.logins.delete(sessionId)
  }
  async loginStatus(agent: string, sessionId: string): Promise<IMLoginStatus> {
    this.assert(agent)
    const login = this.logins.get(sessionId)
    if (!login || login.owner !== this.owner || login.agent !== agent || login.expires < Date.now()) return { status: 'expired' }
    const base = { id: randomUUID(), owner: this.owner, agentId: agent, pairingCode: randomBytes(8).toString('hex'), seen: [] }
    // A confirmed scan is single-use: drop the session first so a failed commit cannot be retried with it.
    const install = (record: RecordData) => { this.logins.delete(sessionId); this.commit(record); return { status: 'confirmed' as const } }
    if (login.provider === 'feishu') {
      const data = await this.form(FEISHU_REGISTRATION, { action: 'poll', device_code: login.qr })
      this.assert(agent)
      if (this.logins.get(sessionId) !== login) return { status: 'expired' }
      if (data.client_id && data.client_secret) {
        if (data.user_info?.tenant_brand === 'lark') { this.logins.delete(sessionId); throw new Error('暂不支持 Lark 国际版，请使用飞书账号扫码') }
        return install({ ...base, provider: 'feishu', label: data.client_id, appId: data.client_id, token: data.client_secret,
          ...(typeof data.user_info?.open_id === 'string' ? { pairUser: data.user_info.open_id } : {}) })
      }
      if (!data.error || data.error === 'authorization_pending' || data.error === 'slow_down') return { status: 'wait' }
      this.logins.delete(sessionId)
      if (data.error === 'access_denied') return { status: 'denied' }
      if (data.error === 'expired_token' || data.error === 'invalid_grant') return { status: 'expired' }
      throw new Error('飞书授权失败，请刷新二维码后重试')
    }
    if (login.provider === 'wecom') {
      const data = await wecomQR(this.request, '/query_result?scode=' + encodeURIComponent(login.qr))
      this.assert(agent)
      if (this.logins.get(sessionId) !== login) return { status: 'expired' }
      // "init" until scanned; like the official CLI, every other state means keep waiting.
      if (data.status !== 'success') return { status: 'wait' }
      const botId = data.bot_info?.botid, secret = data.bot_info?.secret
      if (!botId || !secret) { this.logins.delete(sessionId); throw new Error('企业微信未返回机器人凭证，请重新扫码') }
      return install({ ...base, provider: 'wecom', label: botId, appId: botId, token: secret })
    }
    const data = await this.json(WECHAT + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(login.qr))
    this.assert(agent)
    if (this.logins.get(sessionId) !== login) return { status: 'expired' }
    if (data.status === 'confirmed') {
      if (!data.bot_token || !data.ilink_bot_id) throw new Error('微信未返回有效凭证，请重新扫码')
      return install({ ...base, provider: 'wechat', label: data.ilink_bot_id, token: data.bot_token, baseURL: wechatBaseURL(data.baseurl) })
    } else if (data.status === 'expired') this.logins.delete(sessionId)
    return { status: ['confirmed', 'expired', 'scaned'].includes(data.status) ? data.status : 'wait' }
  }
  /** OAuth-style form call; pending and denied polls arrive as HTTP 400 with an error body. */
  private async form(url: string, body: Record<string, string>): Promise<any> {
    const response = await this.request(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(15000) })
    try { return await response.json() } catch { throw new Error(`飞书请求失败（HTTP ${response.status}），请检查网络后重试`) }
  }
  private async json(url: string, body?: unknown, headers?: Record<string, string>, signal?: AbortSignal): Promise<any> {
    const response = await this.request(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]) })
    if (!response.ok) throw new Error(`渠道请求失败（HTTP ${response.status}），请检查凭证和网络`)
    const data = await response.json() as any
    if (data.ok === false || (data.code && data.code !== 0) || (data.ret && data.ret !== 0 && data.errcode !== -14) || (data.errcode && data.errcode !== -14)) throw new Error('渠道拒绝请求，请检查凭证、机器人权限和订阅配置')
    return data
  }
  private async telegram(r: RecordData, method: string, body: unknown, signal?: AbortSignal): Promise<any> {
    return (await this.json(`https://api.telegram.org/bot${r.token}/${method}`, body, undefined, signal)).result
  }
  private wechat(r: RecordData, path: string, body: object, signal?: AbortSignal): Promise<any> {
    return this.json(wechatBaseURL(r.baseURL) + '/ilink/bot/' + path, { ...body, base_info: { channel_version: '1.0.0' } },
      { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${r.token}`, 'X-WECHAT-UIN': Buffer.from('123456789').toString('base64') }, signal)
  }
  private live(r: RecordData, worker: Worker): boolean {
    return !worker.abort.signal.aborted && this.owner === r.owner && this.currentOwner() === r.owner && this.hasAgent(r.agentId) && this.workers.get(r.id) === worker
  }
  private start(r: RecordData): void {
    const worker: Worker = { abort: new AbortController(), status: 'connecting', active: 0, pending: [], accepted: new Set(), delivery: Promise.resolve(), typingCount: 0 }
    this.workers.set(r.id, worker)
    if (r.provider === 'feishu') {
      const client = new lark.Client({ appId: r.appId!, appSecret: r.token, logger: quietLogger })
      const connected = () => { if (this.live(r, worker)) { worker.status = 'connected'; worker.error = undefined } }
      const ws = new lark.WSClient({ appId: r.appId!, appSecret: r.token, logger: quietLogger,
        onReady: connected, onReconnected: connected,
        onReconnecting: () => { if (this.live(r, worker)) { worker.status = 'connecting'; worker.error = '飞书连接中断，正在重连' } },
        onError: () => { if (this.live(r, worker)) { worker.status = 'error'; worker.error = '飞书连接失败，请检查凭证和长连接订阅配置' } }
      })
      worker.close = () => ws.close({ force: true })
      for (const entry of r.inbox ?? []) this.acceptFeishu(r, worker, client, entry.raw)
      void ws.start({ eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async data => {
          this.acceptFeishu(r, worker, client, data)
        }
      }) }).then(() => { if (!this.live(r, worker)) ws.close({ force: true }) }).catch(() => { worker.status = 'error'; worker.error = '飞书连接失败，请检查网络和长连接订阅配置' })
    } else if (r.provider === 'wecom') {
      worker.close = () => worker.wecom?.close()
      for (const entry of r.inbox ?? []) this.acceptWecom(r, worker, entry.raw)
      void this.runWecom(r, worker)
    } else {
      for (const entry of r.inbox ?? []) {
        if (r.provider === 'telegram') this.acceptTelegram(r, worker, entry.raw)
        else this.acceptWechat(r, worker, entry.raw)
      }
      void this.poll(r, worker)
    }
  }
  private acceptFeishu(r: RecordData, worker: Worker, client: lark.Client, data: any): void {
    const m = data.message
    if (m.chat_type !== 'p2p' || data.sender.sender_type !== 'user') return
    let content: { text?: string; image_key?: string; file_key?: string; file_name?: string } = {}
    try { content = JSON.parse(m.content) } catch { return }
    let reactionId: string | undefined
    this.enqueue(r, worker, { id: m.message_id, peer: m.chat_id, sender: data.sender.sender_id?.open_id, text: m.message_type === 'text' ? content.text ?? '' : '',
      ...(['image', 'file'].includes(m.message_type) ? { media: async () => {
        // Fetch through our bounded, cancellable downloader rather than an unbounded SDK buffer.
        const signal = AbortSignal.any([worker.abort.signal, AbortSignal.timeout(45000)])
        const auth = await this.json('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: r.appId, app_secret: r.token }, undefined, signal)
        const key = m.message_type === 'image' ? content.image_key : content.file_key
        if (!key) throw new IMMediaError('附件信息不完整，请重新发送。')
        const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(m.message_id)}/resources/${encodeURIComponent(key)}?type=${m.message_type}`
        const data = await downloadMedia(this.request, url, signal, { Authorization: `Bearer ${auth.tenant_access_token}` })
        return [{ name: content.file_name || 'image', data, image: m.message_type === 'image' }]
      } } : {}) }, async (text, formatted) => {
      const rich = Boolean(formatted?.entities.length)
      const result = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: m.chat_id, msg_type: rich ? 'post' : 'text', content: JSON.stringify(rich ? formatted!.post : { text }) } })
      if (result.code) throw new Error('飞书发送失败，请检查 im:message:send_as_bot 权限')
    }, () => startIMTyping(worker.abort.signal, async () => {
      const result = await client.im.messageReaction.create({ path: { message_id: m.message_id }, data: { reaction_type: { emoji_type: 'Typing' } } })
      if (!result.code) reactionId = result.data?.reaction_id
    }, async () => {
      if (reactionId) await client.im.messageReaction.delete({ path: { message_id: m.message_id, reaction_id: reactionId } })
    }, 0), data)
  }
  private acceptTelegram(r: RecordData, worker: Worker, update: any): void {
    const signal = worker.abort.signal
    const m = update.message
    if (m && m.chat?.type === 'private' && !m.from?.is_bot) this.enqueue(r, worker,
      { id: String(update.update_id), peer: String(m.chat.id), text: m.text ?? m.caption ?? '',
        ...(m.photo?.length || m.document ? { media: async () => {
          const file = m.document ?? m.photo[m.photo.length - 1]
          if (file.file_size > MAX_IM_FILE_BYTES) throw new IMMediaError('附件超过 20 MB，请压缩或拆分后重发。')
          const timed = AbortSignal.any([signal, AbortSignal.timeout(45000)])
          const result = await this.telegram(r, 'getFile', { file_id: file.file_id }, timed)
          if (typeof result.file_path !== 'string' || !/^[\w/.-]+$/.test(result.file_path) || result.file_path.split('/').includes('..')) throw new IMMediaError('附件地址无效，请重新发送。')
          const data = await downloadMedia(this.request, `https://api.telegram.org/file/bot${r.token}/${result.file_path}`, timed)
          return [{ name: file.file_name || 'image.jpg', data, image: !m.document }]
        } } : {}) },
      (text, formatted) => this.telegram(r, 'sendMessage', { chat_id: m.chat.id, text, ...(formatted?.entities.length ? { entities: formatted.entities } : {}) }, signal), undefined, update)
  }
  private acceptWechat(r: RecordData, worker: Worker, m: any): void {
    const signal = worker.abort.signal
    if (m.message_type !== 1 || m.message_state !== 2) return
    const text = (m.item_list ?? []).map((item: any) => item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : '').filter(Boolean).join('\n')
    this.enqueue(r, worker, { id: String(m.message_id ?? m.seq ?? ''), peer: m.from_user_id, text, context: m.context_token,
      ...((m.item_list ?? []).some((i: any) => i.type === 2 || i.type === 4) ? { media: async () => {
        const items = m.item_list.filter((i: any) => i.type === 2 || i.type === 4)
        if (items.length > ATTACHMENT_LIMITS.count) throw new IMMediaError('一次最多发送 4 个附件，请分批发送。')
        const files: IMMedia[] = []
        for (const item of items) {
          const file = item.type === 2 ? item.image_item : item.file_item
          const media = file?.media
          if (!media?.encrypt_query_param && !media?.full_url) throw new IMMediaError('附件信息不完整，请重新发送。')
          const url = new URL(media.full_url || `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`)
          if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port || url.username || url.password) throw new IMMediaError('微信附件地址无效，请重新发送。')
          const data = await downloadMedia(this.request, url.href, AbortSignal.any([signal, AbortSignal.timeout(45000)]))
          files.push({ name: file.file_name || 'image', image: item.type === 2, data: item.type === 2 && !media.aes_key && !file.aeskey ? data : decryptWechatMedia(data, media.aes_key, file.aeskey) })
        }
        return files
      } } : {}) },
      text => this.wechat(r, 'sendmessage', { msg: { from_user_id: r.label, to_user_id: m.from_user_id, client_id: randomUUID(), message_type: 2, message_state: 2,
        context_token: m.context_token, item_list: [{ type: 1, text_item: { text } }] } }, signal), undefined, m)
  }
  private async runWecom(r: RecordData, worker: Worker): Promise<void> {
    let failures = 0
    while (this.live(r, worker)) {
      let lost: Error
      try {
        let closed!: (error: Error) => void
        const done = new Promise<Error>(resolve => { closed = resolve })
        const connection = await openWecom(this.socket, r.appId!, r.token, frame => {
          if (frame.cmd === 'aibot_msg_callback' && this.live(r, worker)) this.acceptWecom(r, worker, frame)
        }, error => closed(error), worker.abort.signal)
        if (!this.live(r, worker)) { connection.close(); return }
        worker.wecom = connection; worker.status = 'connected'; worker.error = undefined; failures = 0
        lost = await done
        if (worker.wecom === connection) worker.wecom = undefined
      } catch (error) { lost = error instanceof Error ? error : new Error(String(error)) }
      if (!this.live(r, worker)) return
      // Reconnecting would just kick the other client back, so a superseded bot stays idle.
      if (lost instanceof WecomSupersededError) { worker.status = 'error'; worker.error = lost.message; return }
      const auth = lost instanceof WecomAuthError
      worker.status = auth ? 'error' : 'connecting'
      worker.error = auth ? '企业微信凭证无效，请断开后重新连接' : '企业微信连接中断，正在自动重连'
      try { await delay(auth ? 60_000 : Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)), undefined, { signal: worker.abort.signal }) } catch { return }
    }
  }
  private async wecomLink(r: RecordData, worker: Worker): Promise<WecomConnection> {
    // Replayed inbox entries can finish before the long connection is back.
    for (let i = 0; i < 120 && !worker.wecom && this.live(r, worker); i++) await delay(250, undefined, { signal: worker.abort.signal })
    if (!worker.wecom || !this.live(r, worker)) throw new Error('企业微信未连接')
    return worker.wecom
  }
  private acceptWecom(r: RecordData, worker: Worker, frame: WecomFrame): void {
    const m = frame.body ?? {}
    if (m.chattype === 'group' || typeof m.from?.userid !== 'string') return
    const signal = worker.abort.signal
    const texts: string[] = []
    const files: { kind: 'image' | 'file'; src: { url?: string; aeskey?: string } }[] = []
    if (m.msgtype === 'text') texts.push(m.text?.content)
    else if (m.msgtype === 'voice') texts.push(m.voice?.content)
    else if (m.msgtype === 'image') files.push({ kind: 'image', src: m.image })
    else if (m.msgtype === 'file' || m.msgtype === 'video') files.push({ kind: 'file', src: m[m.msgtype] })
    else if (m.msgtype === 'mixed') for (const item of m.mixed?.msg_item ?? []) {
      if (item.msgtype === 'text') texts.push(item.text?.content)
      else if (item.msgtype === 'image') files.push({ kind: 'image', src: item.image })
    }
    let text = texts.filter(part => typeof part === 'string').join('\n').trim()
    const quoted = String(m.quote?.text?.content || m.quote?.voice?.content || '').trim()
    if (quoted && text) text = '> ' + quoted.replaceAll('\n', '\n> ') + '\n\n' + text
    // Each inbound req_id carries one reply stream: opened as "thinking" while working, finished by the first bubble.
    const reqId: string | undefined = frame.headers?.req_id
    const reply = { stream: undefined as string | undefined, tried: false, answered: !reqId, at: Date.now() }
    const finish = async (content: string): Promise<boolean> => {
      if (reply.answered || Date.now() - reply.at > WECOM_STREAM_AGE) return false
      reply.answered = true
      try { await (await this.wecomLink(r, worker)).respondStream(reqId!, reply.stream ?? wecomReqId('stream'), content, true); return true }
      catch { return false }
    }
    this.enqueue(r, worker, { id: String(m.msgid ?? ''), peer: m.from.userid, sender: m.from.userid, text,
      // An open stream spins until finished with visible text, e.g. after an image-only reply.
      settle: async () => { if (reply.stream) await finish('✅') },
      ...(files.length ? { media: async () => {
        if (files.length > ATTACHMENT_LIMITS.count) throw new IMMediaError('一次最多发送 4 个附件，请分批发送。')
        const result: IMMedia[] = []
        for (const { kind, src } of files) {
          let url: URL
          try { url = new URL(src?.url ?? '') } catch { throw new IMMediaError('附件信息不完整，请重新发送。') }
          if (url.protocol !== 'https:' || url.username || url.password) throw new IMMediaError('企业微信附件地址无效，请重新发送。')
          let name: string | undefined
          const data = await downloadMedia(this.request, url.href, AbortSignal.any([signal, AbortSignal.timeout(45000)]), undefined,
            response => { name = dispositionName(response.headers.get('content-disposition')) })
          result.push({ name: name || kind, image: kind === 'image', data: src.aeskey ? decryptWecomMedia(data, src.aeskey) : data })
        }
        return result
      } } : {}) },
      async text => { if (!(await finish(text))) await (await this.wecomLink(r, worker)).sendMarkdown(m.from.userid, text) },
      () => startIMTyping(signal, async () => {
        if (reply.answered || !this.live(r, worker)) return
        if (reply.stream && Date.now() - reply.at > WECOM_STREAM_AGE - 30_000) { await finish('⏳ 仍在处理，完成后会继续发送结果。'); return }
        if (reply.tried) return
        reply.tried = true
        reply.stream = wecomReqId('stream')
        // WeCom renders an empty think block as its native "thinking" state.
        await (await this.wecomLink(r, worker)).respondStream(reqId!, reply.stream, '<think></think>', false)
      }, undefined, 30_000), frame)
  }
  private drain(r: RecordData, worker: Worker): void {
    while (this.live(r, worker) && worker.active < 4 && worker.pending.length) {
      const task = worker.pending.shift()!
      worker.active++
      void task().catch(() => {
        if (this.live(r, worker)) { worker.status = 'error'; worker.error = '消息处理或发送失败，请检查网络后重试；已执行的任务不会自动重复执行' }
      }).finally(() => { worker.active--; this.drain(r, worker) })
    }
  }
  private acquireTyping(r: RecordData, worker: Worker, message: Inbound): () => Promise<void> {
    worker.typingCount++
    // One indicator per chat: finishing one concurrent task must not clear another's status.
    const start = () => {
      if (worker.typingCount && !worker.typingStop && this.live(r, worker)) worker.typingStop = this.typing(r, worker, message)
    }
    if (worker.typingBarrier) void worker.typingBarrier.then(start)
    else start()
    let released = false
    return () => {
      if (released) return worker.typingBarrier ?? Promise.resolve()
      released = true
      if (--worker.typingCount === 0 && worker.typingStop) {
        const barrier = worker.typingStop()
        worker.typingBarrier = barrier
        void barrier.finally(() => { if (worker.typingBarrier === barrier) worker.typingBarrier = undefined })
        worker.typingStop = undefined
      }
      return worker.typingBarrier ?? Promise.resolve()
    }
  }
  private enqueue(r: RecordData, worker: Worker, message: Inbound, send: (text: string, formatted?: IMFormattedMessage) => Promise<void>, typing: (() => () => Promise<void>) | undefined, raw: any): void {
    if (!this.live(r, worker) || !message.id || !message.peer || worker.accepted.has(message.id)) return
    const saved = r.inbox?.find(entry => entry.id === message.id)
    if (!saved && r.seen.includes(message.id)) return
    // Persist receipt before advancing the polling cursor or running any tools.
    if (!saved) {
      r.seen = [...r.seen.slice(-499), message.id]
      if (!r.peer) {
        const paired = message.text.trim() === `/pair ${r.pairingCode}` || Boolean(r.pairUser && message.sender === r.pairUser)
        if (paired) { r.peer = message.peer; r.pairingCode = ''; r.pairUser = undefined }
        this.save()
        void send(paired ? '配对成功，可以开始给这个联系人发消息了。' :
          (/^\/pair(?:\s|$)/.test(message.text.trim()) ? '配对指令无效。' : '还未配对，暂时无法聊天。') + '请在 Douchat 中打开对应联系人的「消息渠道」，复制配对指令并发送到当前私信，完成绑定后即可聊天。').catch(() => {})
        return
      }
      if (message.peer !== r.peer) { this.save(); return }
    }
    if (message.peer !== r.peer) return
    const entry = saved ?? { id: message.id, raw, state: 'queued' as const, receiptId: undefined as string | undefined, receivedAt: Date.now() }
    if (!saved) { (r.inbox ??= []).push(entry); this.save() }
    // Receipt IDs are deterministic, so recovery between these writes cannot duplicate the desktop message.
    entry.receiptId ??= this.received?.(r.agentId, r.id, message.text, r.provider, message.id)
    this.save()
    worker.accepted.add(message.id)
    this.diagnostic?.('im.received', JSON.stringify({ provider: r.provider, channel: r.id, message: message.id, pending: worker.pending.length, active: worker.active }))
    const stopTyping = (message.text.trim() || message.media) ? (typing ? typing() : this.acquireTyping(r, worker, message)) : undefined
    const interrupted = entry.state === 'running'
    worker.pending.push(async () => {
      if (!this.live(r, worker)) return
      try {
        if (interrupted) {
          await send('上一条任务的回复未完成回传，操作可能已执行。请在 Douchat 检查结果后再决定是否重发。')
          return
        }

        let bubbles: IMReplyPart[] = ['支持文字、图片和文件，请使用这些消息类型发送。']
        if (message.text.trim() || message.media) {
          try {
            let media: IMMedia[] | undefined
            try { media = message.media ? await message.media() : undefined }
            catch (error) {
              if (error instanceof IMMediaError) throw error
              throw new IMMediaError('附件下载失败，请检查渠道权限或网络后重新发送。')
            }
            if (!this.live(r, worker)) return
            entry.state = 'running'; this.save()
            this.diagnostic?.('im.processing', JSON.stringify({ provider: r.provider, channel: r.id, message: message.id, waitMs: Date.now() - (entry.receivedAt ?? Date.now()) }))
            bubbles = await this.reply(r.agentId, r.id, message.text, worker.abort.signal, r.provider, media, entry.receiptId)
          }
          catch (error) { bubbles = error instanceof IMMediaError ? [error.message] : ['联系人暂时无法回复，请在 Douchat 检查模型配置、运行状态或权限请求后重试。'] }
        }
        // Stop refreshing before delivery, so Telegram cannot re-show typing after a reply.
        void stopTyping?.()
        // Deliver each completed answer as a group of bubbles; model work and polling stay concurrent.
        const delivery = worker.delivery.catch(() => {}).then(async () => {
          const nonempty = bubbles.filter(part => typeof part !== 'string' || part.trim())
          for (const bubble of nonempty.length ? nonempty : ['任务已完成。']) {
            if (!this.live(r, worker)) return
            if (typeof bubble !== 'string') {
              try { await this.sendImage(r, worker, message, bubble.image) }
              catch {
                if (!this.live(r, worker)) return
                await send('图片已生成，但发送失败。请在 Douchat 查看图片，并检查渠道权限或网络。')
                worker.error = '图片发送失败，已保留桌面会话中的图片'; worker.status = 'error'
                return
              }
            } else if (r.provider === 'wecom') for (const part of splitIMText(wecomMarkdown(bubble).trim(), 6000)) {
              if (!this.live(r, worker)) return
              await send(part)
            } else for (const part of formatIMMessages(bubble, 3500, r.provider === 'wechat')) {
              if (!this.live(r, worker)) return
              await send(part.text, part)
            }
          }
        })
        worker.delivery = delivery.catch(() => {})
        await delivery
        // Sending a reply can clear the platform indicator even when other work remains.
        if (worker.typingCount) worker.typingStop?.refresh()
      } finally {
        // Feishu reactions belong to this message; late cleanup cannot affect the next one.
        void stopTyping?.()
        if (this.live(r, worker)) {
          void message.settle?.()
          this.diagnostic?.('im.finished', JSON.stringify({ provider: r.provider, channel: r.id, message: message.id, elapsedMs: Date.now() - (entry.receivedAt ?? Date.now()) }))
          worker.accepted.delete(message.id)
          r.inbox = (r.inbox ?? []).filter(item => item !== entry)
          this.save()
        }
      }
    })
    this.drain(r, worker)
  }
  private async sendImage(r: RecordData, worker: Worker, message: Inbound, image: { name: string; mimeType: string; data: Uint8Array }): Promise<void> {
    const signal = AbortSignal.any([worker.abort.signal, AbortSignal.timeout(60000)])
    const assertLive = () => { signal.throwIfAborted(); if (!this.live(r, worker)) throw new Error('Channel disconnected') }
    const multipart = async (url: string, form: FormData, token?: string): Promise<any> => {
      assertLive()
      const response = await this.request(url, { method: 'POST', body: form, redirect: 'error', signal,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) })
      if (!response.ok) throw new Error('Image upload failed')
      const result = await response.json() as any
      if (result.ok === false || result.code) throw new Error('Image upload rejected')
      assertLive()
      return result
    }
    assertLive()
    if (r.provider === 'telegram') {
      const form = new FormData()
      form.set('chat_id', message.peer)
      // Telegram does not accept WebP/GIF as sendPhoto input; retain the original as a document.
      const photo = image.mimeType === 'image/png' || image.mimeType === 'image/jpeg'
      form.set(photo ? 'photo' : 'document', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.name || 'image.png')
      await multipart(`https://api.telegram.org/bot${r.token}/${photo ? 'sendPhoto' : 'sendDocument'}`, form)
    } else if (r.provider === 'wecom') {
      // WeCom image messages take PNG/JPEG; anything else goes out as a file.
      const kind = image.mimeType === 'image/png' || image.mimeType === 'image/jpeg' ? 'image' : 'file'
      const link = await this.wecomLink(r, worker)
      assertLive()
      await Promise.race([link.sendMedia(message.peer, kind, image.name || 'image.png', image.data),
        new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
    } else if (r.provider === 'feishu') {
      const auth = await this.json('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { app_id: r.appId, app_secret: r.token }, undefined, signal)
      const form = new FormData(); form.set('image_type', 'message')
      form.set('image', new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.name || 'image.png')
      const uploaded = await multipart('https://open.feishu.cn/open-apis/im/v1/images', form, auth.tenant_access_token)
      if (!uploaded.data?.image_key) throw new Error('Missing image key')
      assertLive()
      await this.json('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        receive_id: message.peer, msg_type: 'image', content: JSON.stringify({ image_key: uploaded.data.image_key })
      }, { Authorization: `Bearer ${auth.tenant_access_token}` }, signal)
    } else {
      const data = Buffer.from(image.data), key = randomBytes(16), filekey = randomBytes(16).toString('hex')
      const cipher = createCipheriv('aes-128-ecb', key, null)
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()])
      const upload = await this.wechat(r, 'getuploadurl', { filekey, media_type: 1, to_user_id: message.peer,
        rawsize: data.length, rawfilemd5: createHash('md5').update(data).digest('hex'), filesize: encrypted.length,
        no_need_thumb: true, aeskey: key.toString('hex') }, signal)
      if (!upload.upload_full_url && !upload.upload_param) throw new Error('Missing upload URL')
      const url = new URL(upload.upload_full_url || `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${filekey}`)
      if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port || url.username || url.password) throw new Error('Invalid upload URL')
      assertLive()
      const response = await this.request(url.href, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted, redirect: 'error', signal })
      const param = response.headers.get('x-encrypted-param')
      if (!response.ok || !param) throw new Error('Image upload failed')
      assertLive()
      await this.wechat(r, 'sendmessage', { msg: { from_user_id: r.label, to_user_id: message.peer, client_id: randomUUID(), message_type: 2, message_state: 2,
        context_token: message.context, item_list: [{ type: 2, image_item: { media: { encrypt_query_param: param,
          aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, mid_size: encrypted.length } }] } }, signal)
    }
  }
  private typing(r: RecordData, worker: Worker, message: Inbound): ReturnType<typeof startIMTyping> {
    let ticket: string | undefined
    const signal = () => AbortSignal.any([worker.abort.signal, AbortSignal.timeout(3000)])
    return startIMTyping(worker.abort.signal, async () => {
      if (!this.live(r, worker)) return
      if (r.provider === 'telegram') {
        await this.telegram(r, 'sendChatAction', { chat_id: message.peer, action: 'typing' }, signal())
      } else {
        if (!ticket) {
          const config = await this.wechat(r, 'getconfig', { ilink_user_id: message.peer, context_token: message.context }, signal())
          ticket = config.typing_ticket
        }
        if (ticket && this.live(r, worker)) await this.wechat(r, 'sendtyping', { ilink_user_id: message.peer, typing_ticket: ticket, status: 1 }, signal())
      }
    }, async () => {
      // Cancellation needs its own timeout: the worker may already be aborted.
      if (ticket) await this.wechat(r, 'sendtyping', { ilink_user_id: message.peer, typing_ticket: ticket, status: 2 }, AbortSignal.timeout(3000))
    })
  }
  private async poll(r: RecordData, worker: Worker): Promise<void> {
    let failures = 0; let expired = 0
    const signal = worker.abort.signal
    while (this.live(r, worker)) {
      try {
        let received = false
        if (r.provider === 'telegram') {
          const updates = await this.telegram(r, 'getUpdates', { offset: Number(r.cursor || 0), timeout: 30, allowed_updates: ['message'] }, signal)
          if (!this.live(r, worker)) return
          received = updates.length > 0
          for (const update of updates) {
            this.acceptTelegram(r, worker, update)
            if (!this.live(r, worker)) return
            r.cursor = String(update.update_id + 1); this.save()
          }
        } else {
          const data = await this.wechat(r, 'getupdates', { get_updates_buf: r.cursor || '' }, signal)
          if (!this.live(r, worker)) return
          if (data.errcode === -14) {
            if (r.cursor) { r.cursor = ''; expired = 0; this.save() } else expired++
            if (expired >= 20) { worker.status = 'error'; worker.error = '微信登录已失效，请断开后重新扫码'; return }
            throw new Error('微信会话正在恢复')
          }
          expired = 0
          received = Boolean(data.msgs?.length)
          for (const m of data.msgs ?? []) {
            this.acceptWechat(r, worker, m)
          }
          if (!this.live(r, worker)) return
          if (data.get_updates_buf) { r.cursor = data.get_updates_buf; this.save() }
        }
        failures = 0; worker.status = worker.error ? 'error' : 'connected'
        if (!received) await delay(200, undefined, { signal })
      } catch {
        if (!this.live(r, worker)) return
        worker.status = 'error'; worker.error = '连接暂时中断，正在自动重试；请检查网络和凭证'
        try { await delay(Math.min(60000, 3000 * 2 ** Math.min(failures++, 5)), undefined, { signal }) } catch { return }
        worker.error = undefined
      }
    }
  }
}
