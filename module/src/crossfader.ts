/**
 * Pure crossfader math. No Foundry globals here, so it can be unit-tested.
 */

/**
 * The live mix every client applies. `fader` 0 = deck A, 1 = deck B.
 * Volumes are dial positions 0..1; `panic` silences every Music Deck channel.
 */
export interface MixState {
  fader: number;
  musicVol: number;
  muted: boolean;
  ambientVol: number;
  ambientMuted: boolean;
  /** SFX pads' level (Phase 5, the SFX Dial). */
  sfxVol: number;
  sfxMuted: boolean;
  panic: boolean;
  /**
   * Each sound scene's level (v2.34), a dial position 0..1 by scene id, so stacked scenes can be mixed.
   * A scene that isn't listed is at full. It multiplies into the Ambient level for that scene's layers.
   */
  sceneVols: Record<string, number>;
  /**
   * The Battle deck (v2.39): `battle` blends from decks A/B (0) to the Battle deck (1) as combat starts and ends;
   * `battleVol` is the Battle deck's own level. Music mute and panic silence it too.
   */
  battle: number;
  battleVol: number;
}

export type DeckId = "A" | "B";
/** A deck that plays tracks: A, B, or the Battle deck that combat brings in under them. */
export type PlayDeck = DeckId | "battle";
export type ChannelId = PlayDeck | "ambient" | "sfx";

export const DEFAULT_MIX: MixState = {
  fader: 0, musicVol: 0.8, muted: false, ambientVol: 0.6, ambientMuted: false, sfxVol: 1, sfxMuted: false, panic: false, sceneVols: {},
  battle: 0, battleVol: 0.8,
};

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function nudge(value: number, delta: number): number {
  return clamp01(value + delta);
}

/**
 * Gain for each deck. Equal-power curve (cos/sin) so loudness stays even mid-fade.
 * `toVolume` maps a level to a gain. Music Deck levels are plain gains (v2.35), so it is the identity there.
 */
export function deckGains(mix: MixState, toVolume: (v: number) => number = v => v): Record<DeckId, number> {
  if (mix.muted) return { A: 0, B: 0 };
  // Combat blends A and B out (equal power, like the crossfader) while the Battle deck comes in.
  const vol = toVolume(clamp01(mix.musicVol)) * Math.cos(clamp01(mix.battle ?? 0) * (Math.PI / 2));
  const angle = clamp01(mix.fader) * (Math.PI / 2);
  return { A: Math.cos(angle) * vol, B: Math.sin(angle) * vol };
}

/** The Battle deck's gain: its own level, brought in by the battle blend. */
export function battleGain(mix: MixState, toVolume: (v: number) => number = v => v): number {
  if (mix.muted) return 0;
  return toVolume(clamp01(mix.battleVol ?? DEFAULT_MIX.battleVol)) * Math.sin(clamp01(mix.battle ?? 0) * (Math.PI / 2));
}

/** Gain for every Music Deck channel. Panic silences them all. */
export function channelGains(mix: MixState, toVolume: (v: number) => number = v => v): Record<ChannelId, number> {
  if (mix.panic) return { A: 0, B: 0, battle: 0, ambient: 0, sfx: 0 };
  const ambient = mix.ambientMuted ? 0 : toVolume(clamp01(mix.ambientVol));
  const sfx = mix.sfxMuted ? 0 : toVolume(clamp01(mix.sfxVol));
  return { ...deckGains(mix, toVolume), battle: battleGain(mix, toVolume), ambient, sfx };
}

/** A scene's level as a gain: 1 for a layer in no scene (General) or a scene that was never turned down. */
export function sceneGain(mix: MixState, sceneId: string | undefined, toVolume: (v: number) => number = v => v): number {
  if (!sceneId) return 1;
  return toVolume(clamp01(mix.sceneVols?.[sceneId] ?? 1));
}

/** A scene level below this shows as 0% and can't be heard. */
const SILENT_SCENE = 0.005;

/**
 * Scene levels with each of `sceneIds` that's turned all the way down (or broken) put back at full, or null when
 * none is. Starting a scene you'd once turned to 0 on the Scene Mix dial would otherwise light it up and play
 * nothing you can hear. Levels above 0 are left as they are.
 */
export function revivedSceneVols(sceneVols: Readonly<Record<string, number>> | undefined, sceneIds: readonly string[]): Record<string, number> | null {
  const vols = sceneVols ?? {};
  const silent = sceneIds.filter(id => id in vols && !(vols[id] >= SILENT_SCENE));
  if (!silent.length) return null;
  return { ...vols, ...Object.fromEntries(silent.map(id => [id, 1])) };
}

/**
 * Which scene owns each ambient layer, from the scenes flag as stored: the first scene that lists it. Old scenes
 * listed bare ids. Kept here (pure) so live gains can use it without importing scenes.ts.
 */
export function layerOwners(rawScenes: unknown): Map<string, string> {
  const owner = new Map<string, string>();
  if (!Array.isArray(rawScenes)) return owner;
  for (const scene of rawScenes) {
    for (const l of scene?.layers ?? []) {
      const id = typeof l === "string" ? l : l?.id;
      if (id && !owner.has(String(id))) owner.set(String(id), String(scene.id));
    }
  }
  return owner;
}

/** Web Audio time constants for the duck: in over about 0.15 s, back over about 1 s. */
export const DUCK_RAMP = { attack: 0.05, release: 0.33 } as const;

/** How much of the music to let through: `depth` while an audible SFX plays, otherwise all of it. */
export function duckFactor(mix: MixState, o: { enabled: boolean; depth: number; sfxPlaying: boolean }): number {
  const audible = !mix.panic && !mix.sfxMuted && mix.sfxVol > 0;
  return o.enabled && o.sfxPlaying && audible ? clamp01(o.depth) : 1;
}


/** The deck you can't hear at all, which only happens with the fader at an end. */
export function silentDeck(fader: number): DeckId | null {
  if (fader <= 0) return "B";
  if (fader >= 1) return "A";
  return null;
}

/** Where an auto-fade goes: to whichever side you are not mostly hearing. */
export function otherSide(fader: number): number {
  return fader < 0.5 ? 1 : 0;
}

/** Fader position `elapsedMs` into a linear auto-fade from `from` to `to`. */
export function fadePosition(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return to;
  const t = clamp01(elapsedMs / durationMs);
  return from + (to - from) * t;
}
