/**
 * Glue between PlaylistSound documents and CueSound.
 *
 * A PlaylistSound refers to a cue with the flag `music-deck.cue` (a cue id in its file's sheet). A switch is the
 * flag `music-deck.cueNext = {cue, when, fade, n}`, written by the GM; every client sees the change and runs the
 * same switch on its own CueSound. `n` is a nonce, so asking for the same switch twice still counts.
 */
import { channelOf, MODULE_ID } from "./live-gain";
import { CUE_TIMING_HOOK, cueFade, cueRingOut, cueSeam, defaultWhen, getSheet } from "./cue-sheets";
import { cueSoundClass, isCueSound } from "./cue-sound";
import { clipsFor } from "./cue-clips";
import { AMBIENT_BLEND_S, CUE_BUFFER_MAX_S, cueLabel, findCue, type Cue, type CueWhen } from "./cues";
import { trackName } from "./channels";

const isActiveGM = () => !!game.users.activeGM?.isSelf;

/** Called from our PlaylistSound subclass instead of Foundry's _createSound when the file has cues. */
export function createCueSound(doc: any): any | null {
  if (!(doc.id && doc.path) || !channelOf(doc.parent)) return null;
  const sheet = getSheet(doc.path);
  if (!sheet) return null;
  if (game.audio.locked) throw new Error("You may not call PlaylistSound#_createSound until after game audio is unlocked.");
  const CueSound = cueSoundClass();
  const sound = new CueSound(doc.path, { context: doc.context, forceBuffer: !(sheet.duration > CUE_BUFFER_MAX_S) });
  sound.sheet = sheet;
  sound.cue = findCue(sheet, doc.getFlag(MODULE_ID, "cue")) ?? null;
  sound.chain = doc.getFlag(MODULE_ID, "chain") ?? null;
  // Too long to decode whole: decode just the cues' stretches when Foundry loads it (cue-clips.ts).
  if (sheet.duration > CUE_BUFFER_MAX_S) {
    sound.clipLoader = () => {
      const now = getSheet(doc.path);
      return now ? clipsFor(doc.path, now, sound.context ?? game.audio.music) : Promise.resolve(null);
    };
  }
  setTiming(sound, doc);
  sound.addEventListener("play", doc._onStart.bind(doc));
  sound.addEventListener("end", doc._onEnd.bind(doc));
  sound.addEventListener("stop", doc._onStop.bind(doc));
  sound.onCueChange = (cue: Cue) => {
    if (isActiveGM()) doc.update({ name: cueLabel(trackName(doc.path), cue), [`flags.${MODULE_ID}.cue`]: cue.id });
  };
  sound.onHold = (fileTime: number) => {
    if (isActiveGM()) doc.update({ playing: false, pausedTime: fileTime });
  };
  return sound;
}

/** Seam and ring-out from the settings: ambient cues always get the long, soft seam. */
function setTiming(sound: any, doc: any): void {
  sound.blend = channelOf(doc.parent) === "ambient" ? AMBIENT_BLEND_S : cueSeam();
  sound.ringOut = cueRingOut();
}

/** The cue a PlaylistSound is set to (its flag, else its sheet's default), or undefined for the whole file. */
export function cueOf(doc: any): Cue | undefined {
  const sheet = getSheet(doc?.path);
  return findCue(sheet, doc?.getFlag?.(MODULE_ID, "cue") ?? sheet?.defaultCue);
}

/**
 * Switch a PlaylistSound to another cue of its file (GM). Playing: on every client, now or at the end of the
 * loop. Not playing: it starts from that cue next time. Returns false if the file has no such cue.
 */
export async function goToCue(doc: any, ref: string | number, when?: CueWhen, fade?: number): Promise<boolean> {
  const sheet = getSheet(doc?.path);
  const cue = findCue(sheet, ref);
  if (!cue) return false;
  const update: Record<string, unknown> = { name: cueLabel(trackName(doc.path), cue), [`flags.${MODULE_ID}.cue`]: cue.id };
  if (doc.playing) {
    if (doc.sound && !isCueSound(doc.sound)) {
      ui.notifications.warn(`Music Deck: "${doc.name}" started before it had cues. Stop and play it again to use them.`);
      return false;
    }
    update[`flags.${MODULE_ID}.cueNext`] = {
      cue: cue.id,
      when: when ?? defaultWhen(channelOf(doc.parent) === "ambient"),
      fade: fade ?? cueFade(),
      n: foundry.utils.randomID(),
    };
  } else {
    update.pausedTime = null;
  }
  await doc.update(update);
  return true;
}

/** Fired (on this client) when a scheduled cue switch is heard, so the Stream Deck can stop blinking. */
export const CUE_PLAYING_HOOK = "musicDeck.cuePlaying";

/** Switches this client has scheduled but not yet heard, per PlaylistSound id. */
const pending = new Map<string, { id: string; when: CueWhen; timer: number }>();

/** The cue a sound is waiting to switch to at the end of its loop (or during a "now" crossfade). */
export function pendingCue(doc: any): { id: string; when: CueWhen } | null {
  const p = doc?.id ? pending.get(doc.id) : undefined;
  return p ? { id: p.id, when: p.when } : null;
}

/** The cue you hear on a PlaylistSound: what its CueSound is playing, else the one it's set to. */
export function playingCueOf(doc: any): Cue | undefined {
  const sound = doc?.sound;
  if (doc?.playing && isCueSound(sound) && sound.playingCue) return findCue(getSheet(doc.path), sound.playingCue.id) ?? sound.playingCue;
  return cueOf(doc);
}

function trackPending(doc: any, cue: Cue | null, when: CueWhen, at: number | null, ctx?: BaseAudioContext): void {
  window.clearTimeout(pending.get(doc.id)?.timer);
  pending.delete(doc.id);
  if (at === null || !cue || !ctx) return;
  const timer = window.setTimeout(() => {
    if (pending.get(doc.id)?.timer !== timer) return;
    pending.delete(doc.id);
    Hooks.callAll(CUE_PLAYING_HOOK, doc);
  }, Math.max(0, (at - ctx.currentTime) * 1000) + 20);
  pending.set(doc.id, { id: cue.id, when, timer });
  Hooks.callAll(CUE_PLAYING_HOOK, doc);
}

export function startCuePlayer(): void {
  Hooks.on("updatePlaylistSound", (doc: any, changed: any) => {
    const flags = changed.flags?.[MODULE_ID];
    const sound = doc.sound;
    if (changed.playing === false) trackPending(doc, null, "now", null);
    if (!flags || !isCueSound(sound)) return;
    // Combat's chain (intro → battle, victory → stop) can change while the track plays.
    if ("chain" in flags || "-=chain" in flags) sound.chain = doc.getFlag(MODULE_ID, "chain") ?? null;
    if (flags.cueNext && sound.sheet) {
      // `changed` only holds the fields that differ from the last switch (two "now"s in a row omit `when`), so
      // read the whole request from the document; the nonce `n` is what makes it a new one.
      const next = doc.getFlag(MODULE_ID, "cueNext") ?? {};
      const cue = findCue(sound.sheet, next.cue);
      const when: CueWhen = next.when === "now" ? "now" : "loopEnd";
      if (cue) trackPending(doc, cue, when, sound.goTo(cue, when, Number(next.fade) || cueFade()), (sound as any).context);
    } else if ("cue" in flags && !doc.playing) {
      sound.cue = findCue(sound.sheet, flags.cue) ?? null;
    }
  });

  Hooks.on(CUE_TIMING_HOOK, () => {
    for (const playlist of game.playlists) {
      if (!channelOf(playlist)) continue;
      for (const doc of playlist.sounds) if (isCueSound(doc.sound)) setTiming(doc.sound, doc);
    }
  });

  // A sheet was saved: playing sounds use the new times from their next segment; idle sounds are rebuilt on
  // their next play, so a file that just got its first cues becomes a CueSound (or stops being one).
  Hooks.on("musicDeck.cueSheets", () => {
    for (const playlist of game.playlists) {
      if (!channelOf(playlist)) continue;
      for (const doc of playlist.sounds) {
        const sound = doc.sound;
        if (!sound) continue;
        const sheet = getSheet(doc.path);
        if (isCueSound(sound) && sheet) {
          sound.sheet = sheet;
          if (!sound.playing) sound.cue = findCue(sheet, doc.getFlag(MODULE_ID, "cue")) ?? null;
          // A long file's clips follow its cues (new or moved cues get decoded).
          void (sound as any).refreshClips?.();
        }
        if (!sound.playing && !!sheet !== isCueSound(sound)) doc.sound = null;
      }
    }
  });
}
