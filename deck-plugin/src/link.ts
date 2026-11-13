/**
 * The plugin's end of the deck link: a WebSocket server on 127.0.0.1 that the GM's
 * Foundry window dials into. A browser pairs once by typing the code the dials show; after that it
 * presents its token. Ported from foundry-mcp's bridge.
 */
import { EventEmitter } from "node:events";
import { randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  CLOSE, DECK_PORT, DECK_PROTOCOL, FoundryMessageSchema,
  type DeckCommand, type DeckState, type LibraryTrack, type PluginMessage,
} from "../../shared/protocol";

export type LinkStatus = "offline" | "pairing" | "online";

export interface TokenStore {
  load(): Promise<string[]>;
  save(tokens: string[]): Promise<void>;
}

type NudgeType = "fader.nudge" | "music.vol.nudge" | "battle.vol.nudge" | "ambient.vol.nudge" | "sfx.vol.nudge";
type Held = "fader" | "musicVol" | "ambientVol" | "sfxVol" | "muted" | "ambientMuted" | "sfxMuted" | "panic" | "sceneVols" | "battleVol";

const NUDGE_FIELD: Record<NudgeType, Held> = { "fader.nudge": "fader", "music.vol.nudge": "musicVol", "battle.vol.nudge": "battleVol", "ambient.vol.nudge": "ambientVol", "sfx.vol.nudge": "sfxVol" };
const TOGGLE_FIELD: Partial<Record<DeckCommand["type"], Held>> = { "music.mute": "muted", "ambient.mute": "ambientMuted", "sfx.mute": "sfxMuted", panic: "panic" };

const HELLO_TIMEOUT_MS = 5000;
/** Turns are sent at once, then coalesced for this long, so a fast spin doesn't flood Foundry. */
const NUDGE_MS = 30;
/** After a local change, Foundry's echo of older values is ignored for this long so the strip doesn't jitter. */
const HOLD_MS = 400;
const MAX_PAIR_TRIES = 5;
const MAX_TOKENS = 10;
const RETRY_LISTEN_MS = 5000;
/** Big enough for the Set Track picker's list (protocol 8): Foundry sends at most 5000 tracks. */
const MAX_PAYLOAD = 4 * 1024 * 1024;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export class FoundryLink extends EventEmitter<{ change: [] }> {
  status: LinkStatus = "offline";
  /** The code to show on the dials while a browser waits to pair. */
  code: string | null = null;
  /** Last state from Foundry, with local predictions applied. Null until the first connect. */
  state: DeckState | null = null;
  world = "";
  /** The tracks a Set Track key can pick, from Foundry's Library (protocol 8). Kept while Foundry is away. */
  library: LibraryTrack[] | null = null;

  #wss?: WebSocketServer;
  #http?: ReturnType<typeof createServer>;
  #retryTimer?: NodeJS.Timeout;
  #client: WebSocket | null = null;
  #pairing = new Set<WebSocket>();
  #tokens: string[] = [];
  #tries = 0;
  #pending = new Map<NudgeType, number>();
  /** Scene Mix dial turns waiting to go, by scene id. */
  #scenePending = new Map<string, number>();
  #flushTimer?: NodeJS.Timeout;
  #heldUntil = new Map<Held, number>();

  constructor(
    private readonly store: TokenStore,
    private readonly port = DECK_PORT,
    private readonly log: (msg: string) => void = () => {},
    private readonly retryMs = RETRY_LISTEN_MS,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.#tokens = await this.store.load();
    this.#listen();
  }

  close(): void {
    clearTimeout(this.#flushTimer);
    clearTimeout(this.#retryTimer);
    for (const ws of this.#wss?.clients ?? []) ws.terminate();
    this.#wss?.close();
    this.#http?.close();
  }

  /**
   * Nothing here keeps the process alive: only the SDK's own connection to Stream Deck does, so the
   * plugin exits when Stream Deck stops it instead of holding the port.
   */
  #listen(): void {
    const http = createServer();
    const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });
    wss.on("connection", (ws, req) => {
      req.socket.unref();
      this.#onConnection(ws);
    });
    // ws re-emits the http server's errors; they're handled below, once.
    wss.on("error", () => {});
    http.on("listening", () => this.log(`listening on ws://127.0.0.1:${this.port}`));
    http.on("error", (e: NodeJS.ErrnoException) => {
      this.log(`server error: ${e.code ?? e.message}; retrying`);
      wss.close();
      http.close();
      // e.g. the old plugin process hasn't let go of the port yet.
      this.#retryTimer = setTimeout(() => this.#listen(), this.retryMs);
      this.#retryTimer.unref();
    });
    http.listen(this.port, "127.0.0.1");
    http.unref();
    this.#wss = wss;
    this.#http = http;
  }

  #onConnection(ws: WebSocket): void {
    let greeted = false;
    const helloTimer = setTimeout(() => ws.close(CLOSE.helloTimeout, "hello timeout"), HELLO_TIMEOUT_MS).unref();

    ws.on("message", raw => {
      let data: unknown;
      try { data = JSON.parse(raw.toString()); } catch { return void ws.close(CLOSE.badMessage, "invalid json"); }
      const parsed = FoundryMessageSchema.safeParse(data);
      if (!parsed.success) {
        if (ws !== this.#client) ws.close(CLOSE.badMessage, "unexpected message");
        return;
      }
      const msg = parsed.data;

      if (msg.type === "hello") {
        clearTimeout(helloTimer);
        greeted = true;
        if (msg.protocol !== DECK_PROTOCOL) {
          return void ws.close(CLOSE.protocolMismatch, `protocol ${msg.protocol}, plugin speaks ${DECK_PROTOCOL}`);
        }
        this.world = msg.world;
        if (msg.token && this.#tokens.includes(msg.token)) return this.#accept(ws, { type: "welcome" });
        this.#pairing.add(ws);
        this.code ??= this.#newCode();
        this.#reply(ws, { type: "needPairing" });
        return this.#update();
      }

      if (msg.type === "pair") {
        if (!greeted || !this.#pairing.has(ws)) return;
        if (this.code && msg.code === this.code) {
          const token = randomBytes(24).toString("base64url");
          this.#tokens = [...this.#tokens, token].slice(-MAX_TOKENS);
          this.store.save(this.#tokens).catch(e => this.log(`couldn't save token: ${e}`));
          this.code = null;
          this.#tries = 0;
          return this.#accept(ws, { type: "paired", token });
        }
        if (++this.#tries >= MAX_PAIR_TRIES) {
          // Guessing gets a fresh code; the GM reads the new one off the dials.
          this.code = this.#newCode();
          this.#tries = 0;
          this.#update();
        }
        return this.#reply(ws, { type: "pairFailed", reason: "That code doesn't match the one on your Stream Deck. Try again." });
      }

      if (msg.type === "state" && ws === this.#client) {
        this.state = this.#withHeld(msg.state);
        this.emit("change");
      }

      if (msg.type === "library" && ws === this.#client) {
        this.library = msg.tracks;
        this.emit("change");
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.#pairing.delete(ws);
      if (ws === this.#client) this.#client = null;
      this.#update();
    });
    ws.on("error", e => this.log(`socket error: ${e.message}`));
  }

  #accept(ws: WebSocket, reply: PluginMessage): void {
    this.#pairing.delete(ws);
    // The newest window wins: a reload's new socket can arrive before the old one closes.
    if (this.#client && this.#client !== ws) this.#client.close(CLOSE.replaced, "replaced by a newer connection");
    this.#client = ws;
    this.#reply(ws, reply);
    this.log(`Foundry linked (${this.world})`);
    this.#update();
  }

  #newCode(): string {
    const code = String(randomInt(0, 10_000)).padStart(4, "0");
    this.log(`pairing code ${code}`);
    return code;
  }

  #reply(ws: WebSocket, msg: PluginMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  #update(): void {
    // Pairing wins over online: someone is at the Foundry dialog waiting for the code.
    const status: LinkStatus = this.#pairing.size ? "pairing" : this.#client ? "online" : "offline";
    this.status = status;
    this.emit("change");
  }

  /** Keep values the user just changed on the deck until Foundry has caught up with them. */
  #withHeld(next: DeckState): DeckState {
    const now = Date.now();
    const prev = this.state;
    if (!prev) return next;
    const out = { ...next };
    for (const [field, until] of this.#heldUntil) {
      if (until > now) (out as any)[field] = prev[field];
      else this.#heldUntil.delete(field);
    }
    return out;
  }

  #hold(field: Held): void {
    this.#heldUntil.set(field, Date.now() + HOLD_MS);
  }

  /** Send a gesture. Returns false when Foundry isn't linked, so the caller can show an alert. */
  send(cmd: DeckCommand): boolean {
    if (this.status !== "online" || !this.#client) return false;
    const field = TOGGLE_FIELD[cmd.type];
    if (field && this.state) {
      this.state = { ...this.state, [field]: !this.state[field] };
      this.#hold(field);
      this.emit("change");
    }
    this.#reply(this.#client, cmd);
    return true;
  }

  /** A dial turn: shown on the strip at once, sent to Foundry coalesced. */
  nudge(type: NudgeType, delta: number): boolean {
    if (this.status !== "online" || !this.#client) return false;
    const field = NUDGE_FIELD[type];
    if (this.state) {
      this.state = { ...this.state, [field]: clamp01((this.state[field] as number) + delta) };
      this.#hold(field);
      this.emit("change");
    }
    this.#pending.set(type, (this.#pending.get(type) ?? 0) + delta);
    if (!this.#flushTimer) this.#flush();
    return true;
  }

  /** A Scene Mix dial turn: one scene's level, shown at once and sent coalesced like the other dials. */
  nudgeScene(sceneId: string, delta: number): boolean {
    if (this.status !== "online" || !this.#client) return false;
    if (this.state) {
      const level = clamp01((this.state.sceneVols[sceneId] ?? 1) + delta);
      this.state = { ...this.state, sceneVols: { ...this.state.sceneVols, [sceneId]: level } };
      this.#hold("sceneVols");
      this.emit("change");
    }
    this.#scenePending.set(sceneId, (this.#scenePending.get(sceneId) ?? 0) + delta);
    if (!this.#flushTimer) this.#flush();
    return true;
  }

  #flush(): void {
    for (const [type, delta] of this.#pending) {
      if (delta && this.#client) this.#reply(this.#client, { type, delta: Math.max(-1, Math.min(1, delta)) });
    }
    this.#pending.clear();
    for (const [sceneId, delta] of this.#scenePending) {
      if (delta && this.#client) this.#reply(this.#client, { type: "scene.vol.nudge", sceneId, delta: Math.max(-1, Math.min(1, delta)) });
    }
    this.#scenePending.clear();
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      if (this.#pending.size || this.#scenePending.size) this.#flush();
    }, NUDGE_MS).unref();
  }
}
