/**
 * Players' side of the sound: Table play or Online play, the "click to turn on sound"
 * banner, and the reports behind the GM's "who can hear" line.
 *
 * - **Table play:** everyone is in the room, so only the GM's computer plays sound. Every other client
 *   is silenced with Foundry's own `game.audio.globalMute` (music, ambience and interface sounds), which
 *   leaves the players' volume sliders alone.
 * - **Online play:** everyone hears Foundry on their own device.
 *
 * A browser won't play sound until its first click or key press; Foundry waits for it (`game.audio.unlock`).
 */
import { SocketMessageSchema, type Hearing, type SocketMessage } from "@music-deck/shared/protocol";
import { MODULE_ID, SOCKET } from "./live-gain";

export type PlayMode = "table" | "online";

const PLAY_MODE = "playMode";
const BANNER_ID = "md-sound-banner";
/** Fired when the play mode changes, and on GM clients when a player's sound state changes or a player comes or goes. */
export const HEARING_HOOK = "musicDeckHearing";

const reports = new Map<string, Hearing>();

export interface PlayerHearing {
  name: string;
  /** Undefined until the player's Foundry has loaded and reported. */
  hearing?: Hearing;
}

/** The GM's status line: who can hear Foundry, and who can't hear yet. In Table play, players aren't meant to. */
export function hearingSummary(players: readonly PlayerHearing[], mode: PlayMode): { text: string; cantHear: string[] } {
  const n = players.length;
  const count = `${n} player${n === 1 ? "" : "s"}`;
  if (mode === "table") return { text: n ? `${count} at the table` : "No players online", cantHear: [] };
  if (!n) return { text: "No players online", cantHear: [] };
  const cantHear = players.filter(p => !p.hearing || p.hearing.locked).map(p => p.name);
  return { text: cantHear.length ? count : `${count}, all hearing`, cantHear };
}

/** The players online, with what each one's Foundry last reported. GM clients only. */
export function playersHearing(): PlayerHearing[] {
  return game.users
    .filter((u: any) => u.active && !u.isGM)
    .map((u: any) => ({ name: u.name, hearing: reports.get(u.id) }));
}

export const playMode = (): PlayMode => (game.settings.get(MODULE_ID, PLAY_MODE) === "table" ? "table" : "online");

/** GM only. */
export const setPlayMode = (mode: PlayMode) => game.settings.set(MODULE_ID, PLAY_MODE, mode);

/** In Table play, only the GM who runs the mixer plays sound. */
export const silencedHere = (): boolean => playMode() === "table" && !game.users.activeGM?.isSelf;

export function registerPlayerSettings(): void {
  game.settings.register(MODULE_ID, PLAY_MODE, {
    name: "Where you're playing",
    hint: "Table play: everyone is in the room, so only the GM's computer plays sound and the players' Foundry stays quiet. Online play: everyone hears Foundry on their own device. The GM can also switch it at the top of the Playlists tab.",
    scope: "world",
    config: true,
    type: String,
    choices: { table: "Table play", online: "Online play" },
    default: "online",
    onChange: () => refresh(),
  });
}

function refresh(): void {
  applyMute();
  updateBanner();
  syncTableNotes();
  Hooks.callAll(HEARING_HOOK);
}

function report(): void {
  game.socket.emit(SOCKET, { type: "hearing", userId: game.user.id, hearing: { locked: !!game.audio.locked } } satisfies SocketMessage);
}

function applyMute(): void {
  // Before the first click there are no audio contexts to mute; `unlock` re-applies it.
  if (game.audio.locked) return;
  const mute = silencedHere();
  if (game.audio.globalMute !== mute) game.audio.globalMute = mute;
}

export function startPlayers(): void {
  game.socket.on(SOCKET, (data: unknown) => {
    const msg = SocketMessageSchema.safeParse(data);
    if (!msg.success) return;
    if (msg.data.type === "hearingQuery") return report();
    if (msg.data.type === "hearing" && game.user.isGM) {
      reports.set(msg.data.userId, msg.data.hearing);
      Hooks.callAll(HEARING_HOOK);
    }
  });
  // Who runs the mixer can change as GMs come and go.
  Hooks.on("userConnected", (user: any, connected: boolean) => {
    if (!connected) reports.delete(user.id);
    refresh();
  });

  // Foundry sets each channel's volume straight from its slider, which would undo the mute.
  for (const hook of ["globalPlaylistVolumeChanged", "globalAmbientVolumeChanged", "globalInterfaceVolumeChanged"]) {
    Hooks.on(hook, (volume: number) => { if (volume > 0 && silencedHere()) game.audio.globalMute = true; });
  }
  Hooks.on("renderPlaylistDirectory", (_app: any, html: HTMLElement) => addTableNote(html));

  game.audio.unlock.then(() => {
    applyMute();
    updateBanner();
    report();
  });
  updateBanner();
  report();
  if (game.user.isGM) game.socket.emit(SOCKET, { type: "hearingQuery" } satisfies SocketMessage);
}

/* -------------------------------------------- */
/*  Banner and the players' note                */
/* -------------------------------------------- */

/** Shown until the first click, except on a player's device in Table play, which stays quiet anyway. */
function updateBanner(): void {
  const show = game.audio.locked && !silencedHere();
  const existing = document.getElementById(BANNER_ID);
  if (!show) return existing?.remove();
  if (existing) return;
  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "status");
  banner.innerHTML = `<i class="fa-solid fa-volume-xmark" aria-hidden="true"></i>
    <span>Click anywhere to turn on the game's music and sound.</span>`;
  document.body.append(banner);
}

/** In Table play, a line at the top of the players' Playlists tab says why Foundry is quiet. */
function addTableNote(html: HTMLElement): void {
  if (game.user.isGM || !html) return;
  if (!html.querySelector(".md-table-note")) {
    html.insertAdjacentHTML("afterbegin", `<p class="md-table-note"><i class="fa-solid fa-people-roof" aria-hidden="true"></i>
      <span><strong>Table play</strong> The music plays from the GM's speakers, so Foundry is quiet on this device.</span></p>`);
  }
  syncTableNotes();
}

function syncTableNotes(): void {
  const hidden = !silencedHere();
  for (const note of document.querySelectorAll<HTMLElement>(".md-table-note")) note.hidden = hidden;
}
