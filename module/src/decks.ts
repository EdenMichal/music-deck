/**
 * LocalDeck operations: a deck is a playlist of local files with a queue.
 * GM only. Every update passes render:false where nothing visible changes.
 */
import { DECKS, currentSound, endModeOf, playlistFor, queueOf, trackName, type PlayMode } from "./channels";
import type { DeckId, PlayDeck } from "./crossfader";
import { MODULE_ID } from "./live-gain";
import { afterEnd, insert, move, rewindUpdates, sortUpdates, type EndMode } from "./queue";
import { getSheet } from "./cue-sheets";
import { goToCue as switchCue, playingCueOf } from "./cue-player";
import { combatPlan, cueLabel, findCue, nextPhaseCue, stepCue, type CueChain, type CueWhen } from "./cues";
import { getMix } from "./live-gain";
import { autofade } from "./mixer";
import { oneAtATime, setTrackDeck, setTrackPlan } from "./set-track";
import { battleId } from "./combat";

export const otherDeck = (deck: DeckId): DeckId => (deck === "A" ? "B" : "A");

/**
 * The deck the music controls work on: the Battle deck while combat has it on (v2.39), else the deck you're
 * hearing more of.
 */
export const musicDeck = (): PlayDeck => {
  const mix = getMix();
  if ((mix.battle ?? 0) > 0 && !!playlistFor("battle")?.sounds.size) return "battle";
  return mix.fader < 0.5 ? "A" : "B";
};

const TRACK_FADE = "trackFade";
/** Longest wait for a track to load before switching to it anyway (a very large file). */
const LOAD_WAIT_MS = 8000;

/**
 * Fade between tracks on the same deck. It's the decks' own Foundry playlist fade, so every client applies it:
 * the old track fades out while the new one fades in (and a track that ends fades out over its last seconds).
 */
export function registerDeckSettings(): void {
  game.settings.register(MODULE_ID, TRACK_FADE, {
    name: "Fade between tracks (seconds)",
    hint: "When a deck goes to another track (Play now, Next, or a track ending), the old one fades out while the new one fades in. 0 switches straight away.",
    scope: "world", config: true, type: Number, range: { min: 0, max: 10, step: 0.5 }, default: 3,
    onChange: () => void applyTrackFade(),
  });
}

/** Give both decks' playlists the fade from settings. Active GM only. */
export async function applyTrackFade(): Promise<void> {
  if (!game.users.activeGM?.isSelf) return;
  const ms = Math.round((game.settings.get(MODULE_ID, TRACK_FADE) as number) * 1000);
  for (const deck of [...DECKS, "battle"] as const) {
    const p = playlistFor(deck);
    if (p && (p.fade ?? 0) !== ms) await p.update({ fade: ms || null });
  }
}

/**
 * Load a track on this client before switching to it, so the track that's playing carries on until the new one
 * can start, and the two crossfade instead of leaving a gap while a large file loads.
 */
async function loadFirst(sound: any): Promise<void> {
  if (!sound || game.audio.locked || sound.sound?.loaded) return;
  await Promise.race([sound.load().catch(() => undefined), new Promise(r => setTimeout(r, LOAD_WAIT_MS))]);
}

export function isPlaying(deck: PlayDeck): boolean {
  return !!playlistFor(deck)?.playing;
}

async function setCurrent(deck: PlayDeck, soundId: string): Promise<void> {
  await playlistFor(deck)?.setFlag(MODULE_ID, "current", soundId);
}

/** Start (or resume) the deck's current track. */
export async function play(deck: PlayDeck): Promise<void> {
  const p = playlistFor(deck);
  const sound = currentSound(deck);
  if (!p || !sound) return;
  await p.playSound(sound);
}

/**
 * Stop and rewind, playing or paused. The track stays cued, so playing again starts it from the top.
 * Not `stopAll()`: that keeps each sound's paused position, so the deck would still read "Paused".
 */
export async function stop(deck: PlayDeck): Promise<void> {
  const p = playlistFor(deck);
  if (!p) return;
  const sound = currentSound(deck);
  if (sound) await setCurrent(deck, sound.id);
  await rewind(p);
}

/** Stop a deck and take every track off it (the Battle deck, once combat is over). */
export async function clearDeck(deck: PlayDeck): Promise<void> {
  const p = playlistFor(deck);
  if (!p) return;
  await rewind(p);
  const ids = p.sounds.map((s: any) => s.id);
  if (ids.length) await p.deleteEmbeddedDocuments("PlaylistSound", ids);
  await p.unsetFlag(MODULE_ID, "current");
}

/** Stop every sound on a deck's playlist and drop their paused positions. */
async function rewind(p: any): Promise<void> {
  const sounds = rewindUpdates(p.sounds.contents);
  if (p.playing || sounds.length) await p.update({ playing: false, sounds });
}

export async function pause(deck: PlayDeck): Promise<void> {
  const sound = playlistFor(deck)?.sounds.find((s: any) => s.playing);
  if (sound) await sound.update({ playing: false, pausedTime: sound.sound?.currentTime ?? 0 });
}

/** Skip to the next track: plays it if the deck is playing, otherwise cues it. */
export async function next(deck: PlayDeck): Promise<void> {
  const p = playlistFor(deck);
  const current = currentSound(deck);
  if (!p || !current) return;
  const nextId = afterEnd(p.playbackOrder, current.id, "loop");
  if (!nextId) return;
  if (p.playing) {
    const sound = p.sounds.get(nextId);
    await loadFirst(sound);
    await p.playSound(sound);
  }
  else await setCurrent(deck, nextId);
}

/** Make a track the deck's current one and play it. */
export async function playTrack(deck: PlayDeck, soundId: string): Promise<void> {
  const p = playlistFor(deck);
  const sound = p?.sounds.get(soundId);
  if (!sound) return;
  // Switching on a playing deck: keep the current track going while this one loads, then crossfade.
  if (p.playing) await loadFirst(sound);
  await setCurrent(deck, soundId);
  await p.playSound(sound);
}

/**
 * A Set Track key (protocol 8): fade the deck that's playing now from its track to this file, with the deck's
 * own track fade. The file joins that deck's queue right after the playing track, unless the deck has it already.
 * With nothing playing, it starts on the deck you're hearing. The crossfader and the other deck don't move.
 * During a battle (v2.42) that deck is the Battle deck: A and B stay paused where they were, so Back to A/B or the
 * end of combat resumes them as usual. The deck is chosen when the press runs, after any press queued before it.
 * A track with combat roles joins the Battle deck as the battle music does: on its intro, chained into battle, and
 * ending on victory so the blend back follows.
 * A new deck sound is measured for loudness as it's created (match.ts), like any other. Presses run one at a time.
 * A battle can end or start while a large file loads; then the press lands on the deck you hear by then instead.
 */
export const setTrack = oneAtATime(async (path: string, name?: string): Promise<void> => {
  for (let tries = 0; tries < 3; tries++) if (await setTrackOnce(path, name)) return;
});

/** One go at a Set Track press. False when the battle changed before it could play, having undone what it added. */
async function setTrackOnce(path: string, name?: string): Promise<boolean> {
  const battle = battleId();
  const deck = setTrackDeck(battle !== null, getMix().fader, { A: isPlaying("A"), B: isPlaying("B") });
  const p = playlistFor(deck);
  if (!p) return true;
  const sounds = queueOf(p).map((s: any) => ({ id: s.id, path: s.path, playing: !!s.playing }));
  const cued = p.getFlag(MODULE_ID, "current");
  const plan = setTrackPlan(sounds, path, cued);
  if (plan.kind === "playing") return true;
  const combat = deck === "battle" ? combatPlan(getSheet(path)) : null;
  const id = plan.kind === "switch" ? plan.id : await cuePath(deck, path, name, combat?.start.id, combat?.chain);
  const sound = id ? p.sounds.get(id) : undefined;
  if (!sound) return true;
  // As playTrack: on a playing deck, keep the current track going while this one loads, then crossfade.
  if (p.playing) await loadFirst(sound);
  if (battleId() !== battle) {
    // Combat ended (or began) during the load, so this deck isn't the one you hear: take the track back off it.
    if (plan.kind === "add") {
      await p.deleteEmbeddedDocuments("PlaylistSound", [sound.id]);
      if (p.getFlag(MODULE_ID, "current") !== cued) await (cued ? setCurrent(deck, cued) : p.unsetFlag(MODULE_ID, "current"));
    }
    return false;
  }
  await setCurrent(deck, sound.id);
  await p.playSound(sound);
  return true;
}

/** Add a file to a deck's queue, at the end or at `index`. Returns the new sound's id. */
export async function addTrack(
  deck: PlayDeck, path: string, { index, name, cue, chain }: { index?: number; name?: string; cue?: string; chain?: CueChain } = {},
): Promise<string | undefined> {
  const p = playlistFor(deck);
  if (!p) return undefined;
  const data = trackData(path, name, cue);
  if (chain && data.flags) data.flags[MODULE_ID].chain = chain;
  const [created] = await p.createEmbeddedDocuments("PlaylistSound", [data]);
  const ids = insert(queueOf(p).map((s: any) => s.id).filter((id: string) => id !== created.id), created.id, index);
  await p.updateEmbeddedDocuments("PlaylistSound", sortUpdates(ids), { render: false });
  return created.id;
}

/** Add many tracks to the end of a deck's queue, in order (Library "＋A all"). Returns their ids. */
export async function addTracks(deck: PlayDeck, tracks: readonly { path: string; name: string }[]): Promise<string[]> {
  const p = playlistFor(deck);
  if (!p || !tracks.length) return [];
  const created = await p.createEmbeddedDocuments("PlaylistSound", tracks.map(t => trackData(t.path, t.name)));
  const newIds = created.map((c: any) => c.id);
  const ids = [...queueOf(p).map((s: any) => s.id).filter((id: string) => !newIds.includes(id)), ...newIds];
  await p.updateEmbeddedDocuments("PlaylistSound", sortUpdates(ids), { render: false });
  return newIds;
}

/**
 * Copy a track to the other deck. If that deck is stopped it becomes its cued track at the top of the queue;
 * if it's playing, the copy goes right after what's playing so it comes up next.
 */
export async function cueOnOther(fromDeck: DeckId, soundId: string): Promise<void> {
  const source = playlistFor(fromDeck)?.sounds.get(soundId);
  if (source) await cuePath(otherDeck(fromDeck), source.path, source.name, source.getFlag(MODULE_ID, "cue"));
}

export async function cuePath(deck: PlayDeck, path: string, name?: string, cue?: string, chain?: CueChain): Promise<string | undefined> {
  const p = playlistFor(deck);
  if (!p) return undefined;
  if (p.playing) {
    const at = queueOf(p).findIndex((s: any) => s.playing) + 1;
    return addTrack(deck, path, { index: at, name, cue, chain });
  }
  const id = await addTrack(deck, path, { index: 0, name, cue, chain });
  if (id) await setCurrent(deck, id);
  return id;
}

export async function moveTrack(deck: PlayDeck, from: number, to: number): Promise<void> {
  const p = playlistFor(deck);
  if (!p) return;
  const ids = move(queueOf(p).map((s: any) => s.id), from, to);
  await p.updateEmbeddedDocuments("PlaylistSound", sortUpdates(ids));
}

export async function removeTrack(deck: PlayDeck, soundId: string): Promise<void> {
  await playlistFor(deck)?.sounds.get(soundId)?.delete();
}

/** "In order", "Shuffle once" or "Repeat this track". Repeat loops whatever track is current. */
export async function setPlayMode(deck: PlayDeck, mode: PlayMode): Promise<void> {
  const p = playlistFor(deck);
  if (!p) return;
  const { SEQUENTIAL, SHUFFLE } = CONST.PLAYLIST_MODES;
  const repeat = mode === "repeat";
  await p.update({
    mode: mode === "shuffle" ? SHUFFLE : SEQUENTIAL,
    [`flags.${MODULE_ID}.playMode`]: mode,
    sounds: p.sounds.map((s: any) => ({ _id: s.id, repeat })),
  });
}

export async function setEndMode(deck: PlayDeck, end: EndMode): Promise<void> {
  await playlistFor(deck)?.setFlag(MODULE_ID, "endMode", end);
}

/**
 * Called from our Playlist subclass when a deck track ends naturally (owners only).
 * Returns true if we handled it: "stop" mode stops after the last track and cues the first.
 */
export async function onDeckTrackEnd(playlist: any, sound: any): Promise<boolean> {
  const deck = DECKS.find(d => playlistFor(d) === playlist);
  if (!deck || endModeOf(deck) !== "stop") return false;
  if (afterEnd(playlist.playbackOrder, sound.id, "stop") !== null) return false;
  await rewind(playlist);
  await setCurrent(deck, playlist.playbackOrder[0]);
  return true;
}

/**
 * A new deck track. With cues, it starts on `cue` (or the file's default cue) and is named "Track · Cue";
 * an explicit name wins, except a name that already carries a cue label is relabelled.
 */
export function trackData(path: string, name?: string, cue?: string) {
  const sheet = getSheet(path);
  const chosen = findCue(sheet, cue ?? sheet?.defaultCue);
  const base = name?.split(" · ")[0] ?? trackName(path);
  const data: any = { name: chosen ? cueLabel(base, chosen) : name ?? base, path, volume: 1 };
  if (chosen) data.flags = { [MODULE_ID]: { cue: chosen.id } };
  return data;
}

/** The deck's playing track, else its cued one. */
function activeSound(deck: PlayDeck): any {
  return playlistFor(deck)?.sounds.find((s: any) => s.playing) ?? currentSound(deck);
}

/**
 * Go to a cue of the track on `deck`: by id, name or pad number. Playing: now or at the end of
 * the loop (default from settings); stopped: it starts there next time. Returns false if there's no such cue.
 */
export async function goToCue(deck: PlayDeck, ref: string | number, when?: CueWhen): Promise<boolean> {
  const sound = activeSound(deck);
  return sound ? switchCue(sound, ref, when) : false;
}

/**
 * Queue › Cue: set which cue a queued track plays (`null`: the whole file). A playing track switches as with
 * goToCue; going back to the whole file only works while it's stopped.
 */
export async function setQueueCue(deck: PlayDeck, soundId: string, cueId: string | null): Promise<boolean> {
  const sound = playlistFor(deck)?.sounds.get(soundId);
  if (!sound) return false;
  if (cueId) return switchCue(sound, cueId);
  if (sound.playing) {
    ui.notifications.warn("Music Deck: stop the track first to play the whole file.");
    return false;
  }
  await sound.update({ name: trackName(sound.path), [`flags.${MODULE_ID}.-=cue`]: null, pausedTime: null });
  return true;
}

/** The cue after (1) or before (-1) the one you hear on `deck`. False at either end, or without cues. */
export async function stepDeckCue(deck: PlayDeck, dir: 1 | -1, when?: CueWhen): Promise<boolean> {
  const sound = activeSound(deck);
  const sheet = getSheet(sound?.path);
  const cue = sheet && stepCue(sheet, playingCueOf(sound)?.id, dir);
  return cue ? switchCue(sound, cue.id, when) : false;
}

/**
 * Combat's Next phase: on the deck you're hearing, the next battle cue (or the next loop, for a track
 * without roles), at the end of the loop. False when there's no later phase.
 */
export async function nextPhase(deck: PlayDeck = musicDeck()): Promise<boolean> {
  const sound = activeSound(deck);
  const sheet = getSheet(sound?.path);
  const cue = sheet && nextPhaseCue(sheet, playingCueOf(sound)?.id);
  return cue ? switchCue(sound, cue.id, "loopEnd") : false;
}

/**
 * The DJ fallback that works for any file: put the same track, on cue `ref`, on the other deck, and
 * auto-fade to it with the crossfader.
 */
export async function cueOnOtherAndFade(deck: DeckId, ref: string | number): Promise<boolean> {
  const sound = activeSound(deck);
  const cue = findCue(getSheet(sound?.path), ref);
  if (!sound || !cue) return false;
  const other = otherDeck(deck);
  const id = await cuePath(other, sound.path, sound.name, cue.id);
  if (!id) return false;
  await playTrack(other, id);
  await autofade();
  return true;
}
