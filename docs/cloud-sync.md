# 云同步

Douchat 的账号数据以云端为准。桌面、Web、iOS 读写同一套记录；桌面本地 SQLite 是带离线能力的同步副本，同时是本地 agent 的执行端。这取代了 [本地版架构边界](local-first-architecture.md) 中“不启用云端聊天存储”的约定。

## 同步范围

| 类型 (`kind`) | 本地表 | 说明 |
| --- | --- | --- |
| `agent` | `agents` | 含身份 Markdown（`systemFiles`）与技能元数据 |
| `conversation` | `conversations` | 单聊、群聊、话题、置顶/静音/已读 |
| `routine` | `routines` | 带 `deviceId`，只在创建它的电脑上执行 |
| `message` | `messages` | |
| `privateMessage` | `privateMessages` | |

不上云的字段（`src/shared/cloudSync.ts`）：本地记录版本 `revision`、`systemFilesDirectory`、`workspacePath`、`agentWorkspaces`、`allowedFolders`、技能的 `directory`/`files`。它们只在本机有意义，拉取时保留本机原值。

不上云的数据：模型 API Key、IM 渠道凭据、邮箱密码、SSH/远程连接、运行日志（`runs`/`runEvents`）、群游戏与群工作流的运行态。好友单聊和共享群已经通过 social 服务同步，不再重复同步。

## 协议：`POST /api/sync`

服务端在 `douchat-tanstack`：`src/modules/sync/service.ts`，表 `sync_entity` / `sync_counter`（迁移 `drizzle/0005_cloud_sync.sql`）。桌面和 iOS 用 `Authorization: Bearer <desktop token>`，Web 用登录 cookie。

```ts
{ action: 'push', ops: { opId, kind, id, baseRevision, deleted?, data? }[] }   // 最多 100 条
  → { results: ({ opId, status: 'applied', revision, seq } | { opId, status: 'conflict', current })[] }
{ action: 'pull', after: number, limit?: number }   // 最多 500 条
  → { changes: { kind, id, seq, revision, deleted, data, deviceId, updatedAt }[], cursor, hasMore }
{ action: 'watch', after: number }                  // 长轮询，最长 25 秒
  → { changed, cursor }
```

- 每条记录有服务端 `revision`。写入必须带上客户端最后见到的 `baseRevision`（从未见过为 0），不匹配时返回 `conflict` 和当前记录，绝不静默覆盖。
- 每次被接受的写入取账号内递增的 `seq`。计数器递增和记录写入在同一个 D1 batch / 事务里，按 `seq` 顺序可见，游标不会跳过记录。
- 同一 `opId` 重试视为已应用，丢失响应后可以安全重发。
- 删除是墓碑（`deleted: true`），新设备也能收到。

## 桌面实现

- `src/main/cloudSyncStore.ts`：SQLite 触发器把五张表的每次写入记进 `syncOutbox`，store 的写入路径无需改动。应用云端数据时 `syncApplying` 中有一行，触发器跳过，避免回推。`syncShadow` 保存每条记录最后的云端版本：它的 revision 是下次推送的基线，它的数据是冲突时三方合并的基线。
- 冲突合并按字段：本机自上次同步后改过的字段保留本机值，其余取云端值；云端已删除时删除优先。
- 拉取先写入 `syncInbox`，整批拉完后在一个事务里按“agent → 会话 → 定时任务 → 消息（按时间）”应用，所以新设备的外键完整、消息顺序正确。
- `src/main/cloudSync.ts`：登录后启动。先拉后推，每秒推送 outbox，用 `watch` 长轮询接收其它设备的写入。首次登录会把本机已有的历史全部排队上传。
- 内置管理员 Dr. Dou 的 ID 由账号派生，各设备创建的是同一条记录。

## 管理后台与客服查看

后台没有直接浏览用户对话的入口。

| 页面 | 权限 | 内容 |
| --- | --- | --- |
| `/admin/sync` 云同步 | `admin.sync.read`（默认给 admin 角色） | 账号数、活跃账号、按类型的记录数和存储占用；每个账号的记录数、设备、最近同步时间、最近 50 次写入的类型/编号/版本/大小。只有元数据。 |
| `/admin/support-shares` 用户授权的会话 | `admin.support.conversations.read`（不在任何默认角色里，需单独授予；super_admin 的 `*` 包含它） | 用户主动分享的会话。 |

客服查看会话的规则（`douchat-tanstack/src/modules/sync/support.ts`）：

- 只能由用户在桌面版“聊天详情 → 分享给客服”发起，一次只授权一个会话，有效期 24 小时、3 天或 7 天，用户随时可撤销。
- 列表不含消息内容；点“查看”才读取内容，每次读取先写 `support_access_log`（查看人、时间），写不进去就不返回内容。
- 用户在同一个对话框里能看到客服查看了几次、最近一次是什么时候。
- 返回内容只有会话名、话题、成员名称/模型和消息文字；不含智能体指令等配置。

## 网页版

网页版运行在 **app.douchat.ai**：桌面版界面（`src/renderer`）加上浏览器版的 `window.douchat`（`src/web/`）。

- 独立子域名：登录 token 存在浏览器本地，和官网、博客、后台不同源，官网页面读不到。`douchat.ai/app/*` 永久跳转到子域名。
- 登录、充值、群邀请在主站 `douchat.ai` 完成，完成后回到子域名（`src/web/site.ts`）。
- 桌面端在线时，网页版的操作交给桌面端执行（`src/shared/desktopRpc.ts`，同一套 IPC 处理逻辑）；不在线时，网页版自己处理会话、云端 agent、建群，并直接和云端 agent 对话。
- 打开了「在服务器上运行智能体」的 douchat-host，上面的 agent 由服务器自己执行（[远程连接 6.1.1](remote-connections.md)）。桌面离线时网页把提示词作为主人任务派给它，单聊回复由服务端写回 sync；群聊里它们和云端 agent 一样参与网页调度。
- 构建：`npm run publish:web`，产物放进 `douchat-tanstack/public/app`，随服务一起部署。本地用 `http://app.localhost:3004` 模拟子域名。

## 发布顺序

1. 服务端执行迁移 `0005_cloud_sync.sql`（`pnpm cf:migrate`，含同步表和客服授权表），再部署服务。已有环境重新执行 `pnpm rbac:init` 以创建两个新权限。
2. 再发布桌面版。

## 后续

- 附件（`attachments/` 图片、技能资源文件）上传 R2，按内容哈希去重，其它设备按需下载。目前其它设备能看到消息，但看不到附件图片。
- 用户记忆、群记忆（Markdown + `user_profiles` / `agent_user_memories` / `group_memories`）。
- Web/iOS 发给本地 agent 的消息：服务端建任务，由该 agent 所在的桌面领取执行（复用 social 的任务领取机制）。
- 流式回复的实时推送；`watch` 改为每账号一个 Durable Object + WebSocket。
- 云模型 agent 在服务端执行，桌面离线也能对话。
- 旧版本在多台桌面各自创建的随机 ID Dr. Dou 不会自动合并，会显示为两个联系人。
