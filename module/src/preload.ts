/**
 * Preload the track a stopped deck will play, on every client, so a crossfade starts it at once
 * everywhere instead of waiting for each player to fetch it.
 *
 * A playing deck needs nothing: Foundry already loads a playlist's next track on every client
 * `CONFIG.Playlist.autoPreloadSeconds` before the current one ends. Each client works this out from
 * the playlists themselves, so nothing is sent over the socket.
 */
import { DECKS, currentSound, playlistFor } from "./channels";
import { channelOf } from "./live-gain";
import { silencedHere } from "./players";

const DEBOUNCE_MS = 250;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The deck tracks that should be loaded now: the cued track of each stopped deck. */
export function cuedSounds(): any[] {
  return DECKS.filter(d => !playlistFor(d)?.playing).map(currentSound).filter(Boolean);
}

function preloadCued(): void {
  // A player's device in Table play doesn't play, so it needn't download anything.
  if (game.audio.locked || silencedHere()) return;
  for (const sound of cuedSounds()) {
    if (sound.sound?.loaded || sound.sound?.failed) continue;
    sound.load().catch((e: unknown) => console.warn(`Music Deck | couldn't preload ${sound.path}`, e));
  }
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(preloadCued, DEBOUNCE_MS);
}

const isDeck = (playlist: any) => {
  const c = channelOf(playlist);
  return c === "A" || c === "B";
};

export function startPreload(): void {
  Hooks.on("updatePlaylist", (p: any) => isDeck(p) && schedule());
  for (const hook of ["updatePlaylistSound", "createPlaylistSound"]) {
    Hooks.on(hook, (s: any) => isDeck(s.parent) && schedule());
  }
  game.audio.unlock.then(schedule);
}
