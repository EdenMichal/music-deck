/**
 * The deck link: the active GM's Foundry window dials out to the Stream Deck plugin on 127.0.0.1,
 * pairs once with the code shown on the deck, runs its gestures and pushes back what it should show.
 * Ported from foundry-mcp's BridgeClient.
 */
import { CLOSE, DECK_PORT, DECK_PROTOCOL, PluginMessageSchema, type DeckCommand } from "../../shared/protocol";
import { deckState, runCommand } from "./deck-handlers";
import { LIBRARY_HOOK, libraryScannedAt, scanLibrary } from "./library";
import { deckTrackChoices } from "./library-sources";
import { MIX_HOOK, MODULE_ID } from "./live-gain";
import { CUE_PLAYING_HOOK } from "./cue-player";

export type LinkStatus = "off" | "connecting" | "offline" | "pairing" | "connected";
/** Fired with the new status whenever it changes. */
export const LINK_HOOK = "musicDeckLink";

const ENABLED_SETTING = "deckLink";
const TOKEN_SETTING = "deckToken";
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 15_000;
const PUSH_MS = 50;
/** The Set Track picker's list waits this long after a change, so a batch of edits sends it once. */
const LIBRARY_MS = 500;
/** What changes the Library: playlists, their sounds and folders, and a rescan of Data/music/. */
const LIBRARY_HOOKS = [
  "createPlaylist", "updatePlaylist", "deletePlaylist", "createPlaylistSound", "updatePlaylistSound", "deletePlaylistSound",
  "createFolder", "updateFolder", "deleteFolder", LIBRARY_HOOK,
];
const DOC_HOOKS = ["updatePlaylist", "updatePlaylistSound", "createPlaylistSound", "deletePlaylistSound", CUE_PLAYING_HOOK, "musicDeck.cueSheets"];

let ws: WebSocket | null = null;
let status: LinkStatus = "off";
let attempts = 0;
let reconnectTimer: number | undefined;
let pushTimer: number | undefined;
let lastSent = "";
let libraryTimer: number | undefined;
let lastLibrary = "";
let asking = false;
let hookIds: [string, number][] = [];

export const linkStatus = () => status;

function setStatus(next: LinkStatus): void {
  if (next === status) return;
  status = next;
  Hooks.callAll(LINK_HOOK, status);
}

export function registerDeckLinkSettings(): void {
  game.settings.register(MODULE_ID, ENABLED_SETTING, {
    name: "Connect to Stream Deck",
    hint: "Link this browser to the Music Deck Stream Deck plugin on this computer. Only the GM who runs the mixer connects.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => updateDeckLink(),
  });
  game.settings.register(MODULE_ID, TOKEN_SETTING, { scope: "client", config: false, type: String, default: "" });
}

/** Connect or disconnect to match the setting and who's running the mixer. Safe to call any time. */
export function updateDeckLink(): void {
  const want = !!game.users.activeGM?.isSelf && game.settings.get(MODULE_ID, ENABLED_SETTING);
  if (want && status === "off") start();
  else if (!want && status !== "off") stop();
}

function start(): void {
  hookIds = [MIX_HOOK, ...DOC_HOOKS].map(h => [h, Hooks.on(h, schedulePush)] as [string, number]);
  hookIds.push(...LIBRARY_HOOKS.map(h => [h, Hooks.on(h, scheduleLibrary)] as [string, number]));
  connect();
}

function stop(): void {
  for (const [h, id] of hookIds) Hooks.off(h, id);
  hookIds = [];
  window.clearTimeout(reconnectTimer);
  window.clearTimeout(pushTimer);
  window.clearTimeout(libraryTimer);
  libraryTimer = undefined;
  const old = ws;
  ws = null;
  old?.close();
  setStatus("off");
}

function connect(): void {
  setStatus("connecting");
  let socket: WebSocket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${DECK_PORT}`);
  } catch (e) {
    console.warn("Music Deck | can't open the Stream Deck link", e);
    return scheduleReconnect();
  }
  ws = socket;

  socket.addEventListener("open", () => {
    send({
      type: "hello",
      protocol: DECK_PROTOCOL,
      token: game.settings.get(MODULE_ID, TOKEN_SETTING) || undefined,
      world: game.world.title,
      user: game.user.name,
    });
  });

  socket.addEventListener("message", ev => {
    if (ws !== socket) return;
    let data: unknown;
    try { data = JSON.parse(String(ev.data)); } catch { return; }
    const msg = PluginMessageSchema.safeParse(data);
    if (!msg.success) return;
    const m = msg.data;
    switch (m.type) {
      case "welcome":
        return onLinked();
      case "paired":
        game.settings.set(MODULE_ID, TOKEN_SETTING, m.token);
        ui.notifications.info("Music Deck: Stream Deck paired.");
        return onLinked();
      case "needPairing":
        setStatus("pairing");
        return void askForCode();
      case "pairFailed":
        ui.notifications.warn(`Music Deck: ${m.reason}`);
        return void askForCode();
      default:
        if (status !== "connected") return;
        runCommand(m as DeckCommand)
          .catch(e => console.error("Music Deck | deck command failed", m, e))
          .finally(schedulePush);
    }
  });

  socket.addEventListener("close", ev => {
    if (ws !== socket) return;
    ws = null;
    if (ev.code === CLOSE.protocolMismatch) {
      ui.notifications.error("Music Deck: the Stream Deck plugin and the Foundry module are different versions. Update both.");
    }
    setStatus("offline");
    scheduleReconnect(ev.code === CLOSE.protocolMismatch ? 60_000 : undefined);
  });
}

function onLinked(): void {
  attempts = 0;
  lastSent = "";
  lastLibrary = "";
  setStatus("connected");
  pushState();
  pushLibrary();
  // A browser that has never opened the Library has no Data/music/ index yet; build it so keys can pick files.
  if (!libraryScannedAt()) scanLibrary().catch(e => console.warn("Music Deck | couldn't scan Data/music/", e));
}

function scheduleReconnect(delay?: number): void {
  if (status === "off") return;
  window.clearTimeout(reconnectTimer);
  delay ??= Math.min(RECONNECT_MIN_MS * 2 ** attempts++, RECONNECT_MAX_MS);
  reconnectTimer = window.setTimeout(() => { if (status !== "off" && !ws) connect(); }, delay);
}

function send(msg: object): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function schedulePush(): void {
  if (status !== "connected" || pushTimer !== undefined) return;
  pushTimer = window.setTimeout(() => { pushTimer = undefined; pushState(); }, PUSH_MS);
}

function pushState(): void {
  if (status !== "connected") return;
  const json = JSON.stringify({ type: "state", state: deckState() });
  if (json === lastSent) return;
  lastSent = json;
  ws?.send(json);
}

function scheduleLibrary(): void {
  if (status !== "connected" || libraryTimer !== undefined) return;
  libraryTimer = window.setTimeout(() => { libraryTimer = undefined; pushLibrary(); }, LIBRARY_MS);
}

/** The Set Track keys' picker list (protocol 8), sent only when it has changed. */
function pushLibrary(): void {
  if (status !== "connected") return;
  const json = JSON.stringify({ type: "library", tracks: deckTrackChoices() });
  if (json === lastLibrary) return;
  lastLibrary = json;
  ws?.send(json);
}

/** Ask for the code on the deck. The tab's "Pair Stream Deck" button calls this again after a cancel. */
export async function askForCode(): Promise<void> {
  if (asking || status !== "pairing") return;
  asking = true;
  try {
    const code = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Pair your Stream Deck", icon: "fa-solid fa-sliders" },
      content: `<p>Your Stream Deck shows a 4-digit code on its Music Deck dials and keys. Type it here to link it to this browser. You only do this once.</p>
        <input name="code" type="text" inputmode="numeric" maxlength="4" autocomplete="off" autofocus>`,
      ok: { label: "Pair", callback: (_event: Event, button: any) => button.form.elements.code.value.trim() },
      rejectClose: false,
    });
    if (code && status === "pairing") send({ type: "pair", code });
  } finally {
    asking = false;
  }
}
