/**
 * Ambient layers and SFX pads. GM only.
 * Ambient is one simultaneous playlist: each track is a layer with its own level (the track's volume).
 * SFX is a soundboard playlist: a pad plays its track once for everyone.
 */
import { playlistFor, queueOf, trackName } from "./channels";
import { pickNext } from "./combat-pick";
import type { ChannelId } from "./crossfader";
import { nodeFor, tracksFor } from "./library-sources";
import { MODULE_ID } from "./live-gain";
import { measureLater } from "./match";
import { oneAtATime, rememberLayer, reviveScenesOf } from "./scenes";
import { getSheet } from "./cue-sheets";
import { cueLabel, findCue } from "./cues";

/**
 * Add a track as a layer or pad. Returns the new sound's id. With `cue` (track editor T5) it plays just that cue
 * of the file: a layer loops it with the long ambient seam, a pad plays a once-cue. Without one it's the whole
 * file, as before.
 */
export async function addToChannel(
  channel: Extract<ChannelId, "ambient" | "sfx">, path: string, name?: string, volume = channel === "sfx" ? 1 : 0.8, cue?: string,
): Promise<string | undefined> {
  const p = playlistFor(channel);
  if (!p) return undefined;
  const chosen = cue ? findCue(getSheet(path), cue) : undefined;
  const base = name?.split(" · ")[0] ?? trackName(path);
  const sort = (queueOf(p).at(-1)?.sort ?? 0) + 100_000;
  const [sound] = await p.createEmbeddedDocuments("PlaylistSound", [{
    name: chosen ? cueLabel(base, chosen) : name ?? base, path, sort, volume, repeat: channel === "ambient",
    ...(chosen ? { flags: { [MODULE_ID]: { cue: chosen.id } } } : {}),
  }]);
  return sound?.id;
}

/**
 * Turn a layer on or off. A scene's layer is remembered that way by its scene, for the next time you play it.
 * Runs in turn with scene commands (see oneAtATime), so it acts on the layers as they are after them.
 */
export function toggleLayer(soundId: string): Promise<void> {
  return oneAtATime(async () => {
    const p = playlistFor("ambient");
    const sound = p?.sounds.get(soundId);
    if (!sound) return;
    const on = !sound.playing;
    if (on) reviveScenesOf([soundId], p);
    await (on ? p.playSound(sound) : p.stopSound(sound));
    await rememberLayer(soundId, on);
  });
}

/** Set a layer's own level: the slider's 0..1 is its gain (v2.35). Debounced by Foundry before it's saved. */
export function setLayerLevel(soundId: string, input: number): void {
  const sound = playlistFor("ambient")?.sounds.get(soundId);
  sound?.debounceVolume(input);
}

/** Pause all layers, remembering which were on; tap again to bring those back. Runs in turn with scene commands. */
export function toggleAmbient(): Promise<void> {
  return oneAtATime(pauseOrResumeAmbient);
}

async function pauseOrResumeAmbient(): Promise<void> {
  const p = playlistFor("ambient");
  if (!p) return;
  const on = p.sounds.filter((s: any) => s.playing).map((s: any) => s.id);
  if (on.length) {
    await p.update({ playing: false, [`flags.${MODULE_ID}.resume`]: on, sounds: on.map((_id: string) => ({ _id, playing: false })) });
    return;
  }
  const resume: string[] = (p.getFlag(MODULE_ID, "resume") ?? []).filter((id: string) => p.sounds.has(id));
  const ids = resume.length ? resume : p.sounds.map((s: any) => s.id);
  reviveScenesOf(ids, p);
  if (ids.length) await p.update({ playing: true, sounds: ids.map((_id: string) => ({ _id, playing: true })) });
}

export function ambientPlaying(): boolean {
  return !!playlistFor("ambient")?.sounds.some((s: any) => s.playing);
}

/** The Library folder or playlist a random pad draws from ("" for an ordinary pad). */
export const randomSource = (sound: any): string => sound?.getFlag(MODULE_ID, "random") ?? "";

/** Every file the random SFX pads can pick, so they're measured before they're first pressed. */
export function randomPadPaths(): string[] {
  return queueOf(playlistFor("sfx")).flatMap((s: any) => {
    const source = randomSource(s);
    return source ? tracksFor(source).map(t => t.path) : [];
  });
}

/** A pad that plays a random sound from a Library folder or playlist on each press. Returns the new sound's id. */
export async function addRandomPad(nodeId: string): Promise<string | undefined> {
  const p = playlistFor("sfx");
  const node = nodeFor(nodeId);
  const first = tracksFor(nodeId)[0];
  if (!p || !node || !first) return undefined;
  const sort = (queueOf(p).at(-1)?.sort ?? 0) + 100_000;
  const [sound] = await p.createEmbeddedDocuments("PlaylistSound", [{
    name: node.name, path: first.path, sort, volume: 1, repeat: false, flags: { [MODULE_ID]: { random: nodeId } },
  }]);
  measureLater(tracksFor(nodeId).map(t => t.path));
  return sound?.id;
}

/** Play an SFX pad for everyone. Pressing a pad that's still playing restarts it; a random pad picks another sound. */
export async function playPad(soundId: string): Promise<void> {
  const p = playlistFor("sfx");
  const sound = p?.sounds.get(soundId);
  if (!sound) return;
  if (sound.playing) await p.stopSound(sound);
  const source = randomSource(sound);
  if (source) {
    const next = pickNext(tracksFor(source).map(t => t.path), sound.path);
    if (!next) return void ui.notifications.warn(`Music Deck: "${sound.name}" has no sounds left in its folder.`);
    if (next !== sound.path) await sound.update({ path: next });
  }
  await p.playSound(sound);
}

/** Stop every SFX pad that's playing (a tap on the SFX Dial's strip). */
export async function stopPads(): Promise<void> {
  const p = playlistFor("sfx");
  const playing = p?.sounds.filter((s: any) => s.playing) ?? [];
  if (playing.length) await p.updateEmbeddedDocuments("PlaylistSound", playing.map((s: any) => ({ _id: s.id, playing: false, pausedTime: null })));
}
