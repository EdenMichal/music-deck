/**
 * The four Music Deck playlists, created on first launch by the active GM.
 * Each carries `flags.music-deck.channel`; decks also store their current track, play mode and end mode.
 */
import type { ChannelId, DeckId, PlayDeck } from "./crossfader";
import { MODULE_ID, channelOf } from "./live-gain";
import type { EndMode } from "./queue";
import { SCENE_FADE_MS } from "./scenes";

export type PlayMode = "inOrder" | "shuffle" | "repeat";

export const DECKS: DeckId[] = ["A", "B"];

/** Every Music Deck channel is on Foundry's Music volume, so one Foundry slider sets all of it (v2.35, levels.ts). */
const DEFINITIONS: Record<ChannelId, { name: string; mode: string; channel: string }> = {
  A: { name: "Music Deck – A", mode: "SEQUENTIAL", channel: "music" },
  B: { name: "Music Deck – B", mode: "SEQUENTIAL", channel: "music" },
  battle: { name: "Music Deck – Battle Deck", mode: "SEQUENTIAL", channel: "music" },
  ambient: { name: "Music Deck – Ambient", mode: "SIMULTANEOUS", channel: "music" },
  sfx: { name: "Music Deck – SFX", mode: "DISABLED", channel: "music" },
};

export function playlistFor(channel: ChannelId): any {
  return game.playlists.find((p: any) => channelOf(p) === channel);
}

const COMBAT_NAME = "Music Deck – Combat";

/**
 * The default battle music: a playlist of its own that the GM fills (＋⚔ in the Library, or Foundry's playlist
 * tools). It isn't a channel, so it shows in the Library like any playlist; combat picks from it at random.
 */
export function combatPlaylist(): any {
  return game.playlists.find((p: any) => p.getFlag(MODULE_ID, "combat"));
}

/** Add a track to the Combat playlist, unless it's already there. False if there's no Combat playlist. */
export async function addToCombat(path: string, name?: string): Promise<boolean> {
  const p = combatPlaylist();
  if (!p) return false;
  if (!p.sounds.some((s: any) => s.path === path)) {
    await p.createEmbeddedDocuments("PlaylistSound", [{ name: name ?? trackName(path), path }]);
  }
  return true;
}

export async function ensurePlaylists(): Promise<void> {
  // Phase 0 playlists only have the `deck` flag; give them the `channel` flag too.
  for (const p of game.playlists) {
    const deck = p.getFlag(MODULE_ID, "deck");
    if (deck && !p.getFlag(MODULE_ID, "channel")) await p.setFlag(MODULE_ID, "channel", deck);
  }
  // Ambient layers fade in and out (sound scenes, Phase 4) unless the GM has set a fade of their own.
  const amb = playlistFor("ambient");
  if (amb && !amb.fade) await amb.update({ fade: SCENE_FADE_MS });
  if (!combatPlaylist()) {
    await foundry.documents.Playlist.create({
      name: COMBAT_NAME,
      mode: CONST.PLAYLIST_MODES.DISABLED,
      channel: "music",
      sorting: CONST.PLAYLIST_SORT_MODES.ALPHABETICAL,
      flags: { [MODULE_ID]: { combat: true } },
    });
  }
  const missing = (Object.keys(DEFINITIONS) as ChannelId[]).filter(c => !playlistFor(c));
  if (!missing.length) return;
  await foundry.documents.Playlist.createDocuments(missing.map(channel => ({
    name: DEFINITIONS[channel].name,
    mode: CONST.PLAYLIST_MODES[DEFINITIONS[channel].mode],
    channel: DEFINITIONS[channel].channel,
    sorting: CONST.PLAYLIST_SORT_MODES.MANUAL,
    ...(channel === "ambient" ? { fade: SCENE_FADE_MS } : {}),
    flags: { [MODULE_ID]: { channel } },
  })));
}

/** A playlist's sounds in queue order (manual sort). */
export function queueOf(playlist: any): any[] {
  return playlist ? playlist.sounds.contents.sort((a: any, b: any) => a.sort - b.sort) : [];
}

/** What a deck plays next: what's playing, else its cued track, else the first in playback order. */
export function currentSound(deck: PlayDeck): any {
  const p = playlistFor(deck);
  if (!p) return undefined;
  return p.sounds.find((s: any) => s.playing)
    ?? p.sounds.get(p.getFlag(MODULE_ID, "current"))
    ?? p.sounds.get(p.playbackOrder[0]);
}

export function playModeOf(deck: PlayDeck): PlayMode {
  const p = playlistFor(deck);
  if (p?.getFlag(MODULE_ID, "playMode") === "repeat") return "repeat";
  return p?.mode === CONST.PLAYLIST_MODES.SHUFFLE ? "shuffle" : "inOrder";
}

export function endModeOf(deck: PlayDeck): EndMode {
  return playlistFor(deck)?.getFlag(MODULE_ID, "endMode") === "stop" ? "stop" : "loop";
}

/** Turn a file path into a track name: "music/tavern/hearth_and-ale.mp3" → "hearth and ale". */
export function trackName(path: string): string {
  const file = decodeURIComponent(path.split("/").pop() ?? path);
  return file.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
}
