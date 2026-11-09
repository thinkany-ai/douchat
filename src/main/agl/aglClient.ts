// Vendored from agl (https://github.com/thinkany-ai/agl), clients/typescript/agl.ts
// at ce5c2df (agl 0.3.12). MIT License, Copyright (c) 2026 ThinkAny, LLC.
// Keep this file a verbatim copy so it can be updated by copying it again:
//   cp ../agl/clients/typescript/agl.ts src/main/agl/aglClient.ts  (then restore this header)
// Douchat-specific behavior belongs in aglLocal.ts / aglLifecycle.ts, not here.

/**
 * agl client — zero dependencies, works in Node ≥22 (global WebSocket),
 * browsers, Electron, Deno and Bun.
 *
 * Talks to either
 *   - the local daemon:   ws://127.0.0.1:<port>/ws?token=<token>   (daemon.json)
 *   - a hub's UI socket:  wss://hub/ws/ui?token=<admin>  with `machineId`
 *
 * Usage:
 *   const agl = await AglClient.local();                 // Node: reads ~/.agl/daemon.json
 *   const s = await agl.createSession({ agent: "claude", cwd: "/repo", access: "ask" });
 *   const r = await agl.runTurn(s.id, "fix the failing test", {
 *     onEvent: (e) => e.kind === "text_delta" && process.stdout.write(e.text),
 *     onPermission: async (p) => "allow",               // or show a dialog
 *   });
 *   console.log(r.outcome, r.timing);
 *
 * Reconnects: the client reconnects by itself (re-reading daemon.json when made
 * with `local()`), reports it through `onConnection`, and `runTurn` never
 * hangs across one: a daemon restart resolves it `{outcome: "aborted",
 * restarted: true}`.
 */

export type Access = "full" | "edit" | "ask" | "read_only";
export type Decision = "allow" | "allow_session" | "deny";

/** An image a tool returned (base64). `omitted` images carry no data. */
export interface ToolImage { mime_type: string; data: string; omitted?: boolean }

export type AgentEvent =
  | { kind: "status"; status: "idle" | "starting" | "running" | "waiting" | "suspended" | "closed" }
  | { kind: "user_message"; turn_id: string; text: string }
  | { kind: "queued"; turn_id: string; position: number }
  | { kind: "steered"; turn_id: string; into_turn_id: string }
  | { kind: "turn_started"; turn_id: string }
  /** `phase: "commentary"`: an interim update while the agent keeps working (Codex). */
  | { kind: "text_delta"; text: string; phase?: "commentary" }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_start"; call_id: string; name: string; input: unknown }
  | { kind: "tool_end"; call_id: string; ok: boolean; output: string; images?: ToolImage[] }
  | { kind: "plan"; entries: unknown }
  /** `decided_by`: agl answered it itself (`policy` / `session`); don't ask the user. */
  | { kind: "permission_request"; request_id: string; tool: string; title: string; input: unknown; options: Decision[]; expires_at: number; decided_by?: "policy" | "session" }
  | { kind: "permission_resolved"; request_id: string; decision: Decision; by: "client" | "policy" | "session" | "timeout" | "cancelled" }
  | { kind: "heartbeat"; turn_id: string; elapsed_ms: number; idle_ms: number; stalled: boolean }
  | { kind: "retrying"; message: string }
  /** `text` (agl 0.3.12+): the final answer of a completed turn, without interim commentary. */
  | { kind: "turn_ended"; turn_id: string; outcome: "completed" | "failed" | "aborted"; error?: string; usage?: unknown; timing?: Timing; text?: string }
  | { kind: "info"; native_id?: string; model?: string }
  | { kind: "error"; message: string };

export interface Timing { warm: boolean; launch_ms: number | null; first_event_ms: number | null; first_text_ms: number | null; total_ms: number }

export interface EventEnvelope { session_id: string; seq: number; ts: number; event: AgentEvent; machine_id?: string }

export interface SessionMeta {
  id: string; name?: string; agent: string; cwd: string; model?: string; current_model?: string; effort?: string; access: Access; origin: string;
  native_id?: string; status: string; created_at: number; last_active_at: number; turns: number;
  queued: number; live: boolean; pending_approvals: number; features: string[];
  /** agl 0.3.12+ */
  visibility?: "shared" | "local"; history?: boolean; last_seq?: number;
  extra_args?: string[]; instructions?: string; ephemeral?: boolean;
}

export interface InstallInfo {
  /** For an installed agent. */
  source?: "npm" | "bun" | "brew" | "native" | "app-bundle" | "unknown";
  package?: string; prefix?: string;
  /** Shell commands for the user to confirm; agl never runs them. */
  install_command?: string; update_command?: string; guide?: string;
}

export interface AgentInfo {
  id: string; name: string; protocol: string; available: boolean; path?: string; version?: string; features: string[];
  /** Empty from agl 0.2.0 and earlier. */
  status?: "ready" | "desktop-only" | "not-found";
  desktop_app?: string; install?: InstallInfo;
  /** Only with `check_updates`. */
  latest_version?: string; update?: "available" | "current" | "unknown";
}

export interface CreateSession {
  agent: string; cwd?: string; model?: string; effort?: string; access?: Access; name?: string; resume?: string; warm?: boolean;
  /** agl 0.3.12+: `local` hides the session from every hub link. */
  visibility?: "shared" | "local";
  /** agl 0.3.12+: false keeps its events out of $AGL_HOME/history (memory only). */
  history?: boolean;
  /** agl 0.3.12+, local connections only: appended to the agent's launch arguments. */
  extra_args?: string[];
  /** agl 0.3.12+, local only, agents with the `instructions` feature. */
  instructions?: string;
  /** agl 0.3.12+, local only, agents with the `ephemeral` feature. */
  ephemeral?: boolean;
}

/**
 * `text`: every non-commentary `text_delta` of the turn. `answer`: the final
 * answer agl reported on `turn_ended` (agl 0.3.12+), else undefined.
 */
export interface TurnResult {
  turn_id: string; outcome: "completed" | "failed" | "aborted"; error?: string; usage?: unknown; timing?: Timing; text: string; answer?: string;
  /** The daemon restarted while the turn ran: it is gone, not merely unanswered. */
  restarted?: boolean;
}

type Listener = (e: EventEnvelope) => void;

/** A URL, or a function giving the current one; it runs again before every reconnect. */
export type UrlSource = string | (() => string | Promise<string>);

/**
 * Connection changes (`onConnection`):
 * - `disconnected`: the socket closed. Calls in flight were rejected with
 *   `AglError("connection closed")`; events sent meanwhile are missed (read
 *   them back with `session.history {after_seq}`). The client reconnects by
 *   itself (1s, backing off to 10s) until `close()`.
 * - `reconnected`: the socket is back and subscriptions are restored.
 *   `restarted` is true when it reached a different daemon process than
 *   before (agl restarted or updated: every turn that was running is gone
 *   and its `turn_ended` was never sent live), false when it is the same
 *   one, null when that cannot be told (no answer to `ping`/`daemon.status`).
 */
export type ConnectionEvent =
  | { state: "disconnected" }
  | { state: "reconnected"; restarted: boolean | null };

export class AglError extends Error {}

export class AglClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private connectionListeners = new Set<(e: ConnectionEvent) => void>();
  private subscriptions = new Set<string>();
  private subscribedAll = false;
  private opening?: Promise<void>;
  private closed = false;
  private connectedOnce = false;
  private retryMs = 1000;
  /** Which daemon process answered last: `started_at` (agl 0.3.12+) or its pid. */
  private daemonId?: string;

  private url: UrlSource;
  private opts: { machineId?: string; WebSocket?: typeof WebSocket };
  /** For `forMachine` clients: the client that owns the connection. */
  private base?: AglClient;

  /**
   * @param url       ws(s) URL including the token query parameter, or a
   *                  function returning it (re-run before every reconnect)
   * @param machineId set when talking to a hub: requests are routed to this machine
   */
  constructor(url: UrlSource, opts: { machineId?: string; WebSocket?: typeof WebSocket } = {}) {
    this.url = url;
    this.opts = opts;
  }

  /**
   * Node/Electron main: connect to the local daemon via $AGL_HOME/daemon.json.
   * The file is read again before every reconnect, since a restarted daemon
   * has a new port and token.
   */
  static async local(home?: string): Promise<AglClient> {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(home ?? process.env.AGL_HOME ?? path.join(os.homedir(), ".agl"), "daemon.json");
    const c = new AglClient(() => {
      const info = JSON.parse(fs.readFileSync(file, "utf8"));
      return `ws://127.0.0.1:${info.port}/ws?token=${encodeURIComponent(info.token)}`;
    });
    await c.connect();
    return c;
  }

  /** Same client for a hub (`/ws/ui`), bound to one machine. */
  forMachine(machineId: string): AglClient {
    const c = new AglClient(this.url, { ...this.opts, machineId });
    c.base = this.base ?? this;
    c.listeners = this.listeners;
    c.connectionListeners = this.connectionListeners;
    return c;
  }

  /** Listen to connection changes; see `ConnectionEvent`. */
  onConnection(listener: (e: ConnectionEvent) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  connect(): Promise<void> {
    if (this.base) return this.base.connect();
    if (this.opening) return this.opening;
    const WS = this.opts.WebSocket ?? (globalThis as any).WebSocket;
    if (!WS) throw new AglError("no WebSocket implementation; pass opts.WebSocket");
    const opening = (async () => {
      const url = typeof this.url === "string" ? this.url : await this.url();
      await new Promise<void>((resolve, reject) => {
        const ws: WebSocket = new WS(url);
        let open = false;
        ws.onopen = async () => {
          open = true;
          this.ws = ws;
          this.retryMs = 1000;
          const again = this.connectedOnce;
          this.connectedOnce = true;
          // Restore subscriptions after a reconnect.
          if (this.subscribedAll) void this.send("subscribe", { all: true }).catch(() => {});
          for (const s of this.subscriptions) void this.send("subscribe", { session_id: s }).catch(() => {});
          // Tell listeners whether the daemon restarted before any other
          // call goes out on the new connection.
          await this.checkDaemon(again);
          resolve();
        };
        ws.onerror = () => reject(new AglError(`cannot connect to ${url.replace(/token=[^&]+/, "token=…")}`));
        ws.onclose = () => {
          for (const p of this.pending.values()) p.reject(new AglError("connection closed"));
          this.pending.clear();
          if (this.opening === opening) this.opening = undefined;
          if (open) this.emitConnection({ state: "disconnected" });
          this.scheduleReconnect();
        };
        ws.onmessage = (m: MessageEvent) => this.onMessage(JSON.parse(String(m.data)));
      });
    })();
    // A daemon.json that cannot be read yet (daemon down) is retried too.
    opening.catch(() => {
      if (this.opening === opening) this.opening = undefined;
      this.scheduleReconnect();
    });
    this.opening = opening;
    return opening;
  }

  private reconnectTimer?: ReturnType<typeof setTimeout>;

  private scheduleReconnect() {
    if (this.closed || !this.connectedOnce || this.reconnectTimer) return;
    const ms = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch(() => {});
    }, ms);
  }

  /** Note which daemon process answers; after a reconnect, say whether it changed. */
  private async checkDaemon(reconnected: boolean) {
    let id: string | undefined;
    try {
      const ask = <T>(method: string) =>
        Promise.race([this.send<T>(method, {}), new Promise<never>((_, reject) => setTimeout(() => reject(new AglError("timeout")), 5000))]);
      const pong = await ask<{ started_at?: number }>("ping");
      if (pong?.started_at) id = `started:${pong.started_at}`;
      else id = `pid:${(await ask<{ pid?: number }>("daemon.status")).pid}`;
    } catch {
      id = undefined;
    }
    const before = this.daemonId;
    if (id) this.daemonId = id;
    if (reconnected) this.emitConnection({ state: "reconnected", restarted: id && before ? id !== before : null });
  }

  private emitConnection(e: ConnectionEvent) {
    for (const l of this.connectionListeners) {
      try {
        l(e);
      } catch {}
    }
  }

  close(): void {
    if (this.base) return this.base.close();
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private onMessage(msg: any) {
    if (msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new AglError(msg.error)) : p.resolve(msg.result);
    } else if (msg.type === "event") {
      const { type, ...env } = msg;
      for (const l of this.listeners) l(env as EventEnvelope);
    }
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await (this.base ?? this).connect();
    return this.send<T>(method, params);
  }

  /** A request on the current socket, without waiting for `connect`. */
  private send<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const conn = this.base ?? this;
    const id = String(conn.nextId++);
    return new Promise<T>((resolve, reject) => {
      if (conn.ws?.readyState !== 1) return reject(new AglError("connection closed"));
      conn.pending.set(id, { resolve, reject });
      conn.ws!.send(JSON.stringify({ type: "request", id, method, params, machine_id: this.opts.machineId }));
    });
  }

  /** Listen to events (all sessions you subscribed to; on a hub, every event). */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async subscribe(sessionId?: string) {
    if (this.opts.machineId) return; // the hub forwards every event
    if (sessionId) {
      this.subscriptions.add(sessionId);
      await this.call("subscribe", { session_id: sessionId });
    } else {
      this.subscribedAll = true;
      await this.call("subscribe", { all: true });
    }
  }

  agents = (opts: { check_updates?: boolean } = {}) => this.call<AgentInfo[]>("agents.list", opts);
  models = (agent: string) => this.call<{ agent: string; models: { id: string; name?: string; efforts?: string[]; default?: boolean }[] }>("agents.models", { agent });
  createSession = (p: CreateSession) => this.call<SessionMeta>("session.create", p as any);
  sessions = () => this.call<SessionMeta[]>("session.list");
  session = (id: string) => this.call<SessionMeta>("session.get", { session_id: id });
  history = (id: string, afterSeq = 0, limit?: number) => this.call<EventEnvelope[]>("session.history", { session_id: id, after_seq: afterSeq, limit });
  prompt = (id: string, text: string, mode: "queue" | "steer" | "interrupt" = "queue", turnId?: string) =>
    this.call<{ session_id: string; turn_id: string }>("session.prompt", { session_id: id, text, mode, turn_id: turnId });
  approve = (id: string, requestId: string, decision: Decision) => this.call("session.approve", { session_id: id, request_id: requestId, decision });
  abort = (id: string) => this.call("session.abort", { session_id: id });
  warm = (id: string) => this.call("session.warm", { session_id: id });
  configure = (id: string, p: { model?: string; effort?: string; access?: Access; name?: string }) => this.call<SessionMeta>("session.configure", { session_id: id, ...p });
  closeSession = (id: string) => this.call("session.close", { session_id: id });

  /**
   * Send a prompt and resolve when its turn ends. Collects the reply text,
   * forwards every event, and answers permission requests via `onPermission`
   * (unanswered requests are denied by agl after its approval timeout).
   *
   * Across a reconnect it never hangs: if the same daemon answers, the events
   * missed meanwhile are read back from `session.history` (so a turn that
   * ended during the gap resolves); if the daemon restarted, the turn is gone
   * and resolves `{outcome: "aborted", restarted: true}`.
   */
  async runTurn(
    sessionId: string,
    text: string,
    o: { mode?: "queue" | "steer" | "interrupt"; onEvent?: (e: AgentEvent) => void; onPermission?: (p: Extract<AgentEvent, { kind: "permission_request" }>) => Promise<Decision> | Decision; signal?: AbortSignal } = {},
  ): Promise<TurnResult> {
    await this.subscribe(sessionId);
    const turnId = Math.random().toString(36).slice(2, 14);
    let started = false;
    let reply = "";
    let lastSeq = 0;
    let finished = false;
    const offs: (() => void)[] = [];
    let finish!: (r: TurnResult) => void;
    const done = new Promise<TurnResult>((resolve) => {
      finish = (r) => {
        if (finished) return;
        finished = true;
        offs.forEach((off) => off());
        resolve(r);
      };
    });
    const handle = async (env: EventEnvelope) => {
      if (finished || env.session_id !== sessionId || (this.opts.machineId && env.machine_id && env.machine_id !== this.opts.machineId)) return;
      // Live events and events read back after a reconnect may overlap.
      if (env.seq <= lastSeq) return;
      lastSeq = env.seq;
      const e = env.event;
      if (e.kind === "turn_started" && e.turn_id === turnId) started = true;
      if (e.kind === "steered" && e.turn_id === turnId) return finish({ turn_id: turnId, outcome: "completed", text: "" });
      if (e.kind === "turn_ended" && e.turn_id === turnId) {
        o.onEvent?.(e);
        return finish({ turn_id: turnId, outcome: e.outcome, error: e.error, usage: e.usage, timing: e.timing, text: reply, answer: e.text });
      }
      if (!started) return;
      if (e.kind === "text_delta" && e.phase !== "commentary") reply += e.text;
      o.onEvent?.(e);
      if (e.kind === "permission_request" && !e.decided_by && o.onPermission) {
        const d = await o.onPermission(e);
        await this.approve(sessionId, e.request_id, d).catch(() => {});
      }
    };
    offs.push(this.on((env) => void handle(env)));
    o.signal?.addEventListener("abort", () => void this.abort(sessionId));
    try {
      await this.prompt(sessionId, text, o.mode ?? "queue", turnId);
    } catch (err) {
      offs.forEach((off) => off());
      throw err;
    }
    // From here the turn lives on the daemon that accepted it.
    offs.push(
      this.onConnection(async (c) => {
        if (c.state !== "reconnected" || finished) return;
        if (c.restarted) {
          return finish({ turn_id: turnId, outcome: "aborted", error: "the agl daemon restarted during this turn", text: reply, restarted: true });
        }
        try {
          for (const env of await this.history(sessionId, lastSeq)) await handle(env);
        } catch (err) {
          // The session is gone (closed, or a daemon that forgot it).
          finish({ turn_id: turnId, outcome: "aborted", error: String((err as Error)?.message ?? err), text: reply });
        }
      }),
    );
    if (finished) offs.forEach((off) => off());
    return done;
  }
}
