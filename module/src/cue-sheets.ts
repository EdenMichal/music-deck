/**
 * Cue sheets, one per audio file, in a world setting keyed by normalised path. World scope, so every
 * client reads them; only a GM writes them.
 */
import { MUSIC_BLEND_S, RING_OUT_S, normalizePath, validateSheet, type CueSheet, type CueWhen } from "./cues";
import { MODULE_ID } from "./live-gain";

const SHEETS = "cueSheets";
export const MUSIC_WHEN = "cueMusicWhen";
export const AMBIENT_WHEN = "cueAmbientWhen";
export const CUE_FADE = "cueFade";
export const CUE_SEAM = "cueSeam";
export const CUE_RING = "cueRingOut";
/** Fired when a crossfade length changes, so playing cues pick it up from their next join. */
export const CUE_TIMING_HOOK = "musicDeck.cueTiming";

export function registerCueSettings(): void {
  game.settings.register(MODULE_ID, SHEETS, {
    scope: "world", config: false, type: Object, default: {},
    onChange: () => Hooks.callAll("musicDeck.cueSheets"),
  });
  const when = { now: "Now, with a crossfade", loopEnd: "At the end of the loop" };
  game.settings.register(MODULE_ID, MUSIC_WHEN, {
    name: "Go to cue: music", hint: "When a music deck switches to another cue of the same track. Holding a Go to cue key always switches now.",
    scope: "world", config: true, type: String, choices: when, default: "loopEnd",
  });
  game.settings.register(MODULE_ID, AMBIENT_WHEN, {
    name: "Go to cue: ambience", hint: "When an ambient layer switches to another cue.",
    scope: "world", config: true, type: String, choices: when, default: "now",
  });
  const timing = () => Hooks.callAll(CUE_TIMING_HOOK);
  game.settings.register(MODULE_ID, CUE_FADE, {
    name: "Go to cue now: crossfade (seconds)", hint: "How long a switch made now takes: the old cue fades out as the new one fades in.",
    scope: "world", config: true, type: Number, range: { min: 0.1, max: 6, step: 0.1 }, default: 2.5, onChange: timing,
  });
  game.settings.register(MODULE_ID, CUE_RING, {
    name: "Go to cue at the end of the loop: crossfade (seconds)",
    hint: "The new cue starts on the beat, and the old one plays on past its end, fading out over this long. Cues that meet (one ends where the next starts) just run on.",
    scope: "world", config: true, type: Number, range: { min: 0, max: 4, step: 0.1 }, default: RING_OUT_S, onChange: timing,
  });
  game.settings.register(MODULE_ID, CUE_SEAM, {
    name: "Music cue loops: seam crossfade (seconds)",
    hint: "Where a looping cue goes back to its start, the music after it fades out over this long as the start comes back in. The loop stays exactly in time. Ambient cues always use a long, soft seam.",
    scope: "world", config: true, type: Number, range: { min: 0, max: 2, step: 0.05 }, default: MUSIC_BLEND_S, onChange: timing,
  });
}

function all(): Record<string, CueSheet> {
  return game.settings.get(MODULE_ID, SHEETS) ?? {};
}

export function getSheet(path: string | undefined | null): CueSheet | undefined {
  if (!path) return undefined;
  const sheet = all()[normalizePath(path)];
  return sheet?.cues?.length ? sheet : undefined;
}

export function allSheets(): CueSheet[] {
  return Object.values(all());
}

/** Save a sheet (cleaned first). Returns the problems found while cleaning it. GM only. */
export async function saveSheet(sheet: CueSheet): Promise<string[]> {
  const { sheet: clean, problems } = validateSheet(sheet);
  await game.settings.set(MODULE_ID, SHEETS, { ...all(), [clean.path]: clean });
  return problems;
}

export async function removeSheet(path: string): Promise<void> {
  const next = { ...all() };
  delete next[normalizePath(path)];
  await game.settings.set(MODULE_ID, SHEETS, next);
}

export function defaultWhen(ambient: boolean): CueWhen {
  return game.settings.get(MODULE_ID, ambient ? AMBIENT_WHEN : MUSIC_WHEN) === "now" ? "now" : "loopEnd";
}

export const cueFade = (): number => Number(game.settings.get(MODULE_ID, CUE_FADE)) || 2.5;
const num = (key: string, fallback: number) => { const v = Number(game.settings.get(MODULE_ID, key)); return Number.isFinite(v) ? v : fallback; };
export const cueSeam = (): number => num(CUE_SEAM, MUSIC_BLEND_S);
export const cueRingOut = (): number => num(CUE_RING, RING_OUT_S);
