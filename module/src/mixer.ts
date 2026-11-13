/**
 * The GM's mixer: crossfader, auto-fade, volumes, mutes and panic, plus the rule that a deck only plays
 * while you can hear it. Everything here runs on the active GM's client only.
 */
import { clamp01, fadePosition, nudge, otherSide, silentDeck, type DeckId, type MixState } from "./crossfader";
import { isPlaying, pause, play, stop } from "./decks";
import { MODULE_ID, RAMP, getMix, setMix } from "./live-gain";

const FADE_SETTING = "fadeSeconds";
const AUTOFADE_STEP_MS = 50;
/** How long the fader must rest at an end before the silent deck stops. */
const SETTLE_MS = 1000;

let fadeTimer: ReturnType<typeof setInterval> | undefined;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
const starting = new Set<DeckId>();

/** Start a deck the fader just brought in from silence. A deck you paused stays paused, and so does a quiet one. */
function startRevealedDeck(before: number, after: number): void {
  // During combat A and B are paused under the Battle deck; moving the fader mustn't start one underneath.
  if (getMix().battle > 0) return;
  const deck = silentDeck(before);
  if (!deck || silentDeck(after) === deck || isPlaying(deck) || starting.has(deck) || quiet.has(deck)) return;
  starting.add(deck);
  play(deck).finally(() => starting.delete(deck));
}

const held = new Set<DeckId>();
const quiet = new Set<DeckId>();
/** Combat that began in silence: fading back to this deck mustn't start the track queued on it. */
export function keepQuiet(deck: DeckId, on: boolean): void {
  if (on) quiet.add(deck); else quiet.delete(deck);
}

/** Combat: keep this deck's place when the fader leaves it, so it can resume later. */
export function holdDeck(deck: DeckId, on: boolean): void {
  if (on) held.add(deck); else held.delete(deck);
}

function stopSilentDeck(): void {
  const deck = silentDeck(getMix().fader);
  if (!deck || !isPlaying(deck)) return;
  if (held.has(deck)) pause(deck);
  else stop(deck);
}

function moveFader(fader: number): MixState {
  const before = getMix().fader;
  const mix = setMix({ fader: clamp01(fader) });
  startRevealedDeck(before, mix.fader);
  clearTimeout(settleTimer);
  settleTimer = setTimeout(stopSilentDeck, SETTLE_MS);
  return mix;
}

export function registerMixerSettings(): void {
  game.settings.register(MODULE_ID, FADE_SETTING, {
    name: "Crossfade time (seconds)",
    hint: "How long Auto-fade takes to move from one deck to the other: the Fade button, a tap on the Stream Deck strip, and the Auto-fade key.",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 1, max: 20, step: 0.5 },
    default: 4,
  });
}

/** The crossfade time, in seconds. */
export const fadeSeconds = (): number => game.settings.get(MODULE_ID, FADE_SETTING);

export function isFading(): boolean {
  return fadeTimer !== undefined;
}

/** Resolves the running auto-fade's promise; a fade that's cancelled or replaced still settles. */
let fadeDone: (() => void) | undefined;

function cancelFade(): void {
  clearInterval(fadeTimer);
  fadeTimer = undefined;
  fadeDone?.();
  fadeDone = undefined;
}

/** Set the fader directly, e.g. from the tab's slider. Cancels a running auto-fade. */
export function setFader(fader: number): MixState {
  cancelFade();
  return moveFader(fader);
}

export function nudgeFader(delta: number): MixState {
  return setFader(nudge(getMix().fader, delta));
}

/**
 * Fade to the other deck (or to the fader position `to`) by streaming fader positions, the same path a dial
 * turn takes. Starting another fade replaces this one, and this one's promise resolves then.
 */
export function autofade(durationMs = fadeSeconds() * 1000, to?: number): Promise<void> {
  cancelFade();
  const from = getMix().fader;
  to ??= otherSide(from);
  const start = Date.now();
  return new Promise(resolve => {
    fadeDone = resolve;
    fadeTimer = setInterval(() => {
      const elapsed = Date.now() - start;
      moveFader(fadePosition(from, to!, elapsed, durationMs));
      if (elapsed >= durationMs) {
        cancelFade();
        clearTimeout(settleTimer);
        stopSilentDeck();
        resolve();
      }
    }, AUTOFADE_STEP_MS);
  });
}

/**
 * Fade to a specific deck, unless you're already hearing only it. It goes to that deck even while another fade
 * is under way (combat ending during its own fade-in used to fade to the battle deck again).
 */
export async function fadeTo(deck: DeckId): Promise<void> {
  const target = deck === "A" ? 0 : 1;
  if (getMix().fader !== target || isFading()) await autofade(undefined, target);
}

export function setMusicVol(v: number): MixState {
  return setMix({ musicVol: clamp01(v) });
}

export function nudgeMusicVol(delta: number): MixState {
  return setMusicVol(getMix().musicVol + delta);
}

export function toggleMute(): MixState {
  return setMix({ muted: !getMix().muted }, { ramp: RAMP.mute });
}

export function setAmbientVol(v: number): MixState {
  return setMix({ ambientVol: clamp01(v) });
}

export function nudgeAmbientVol(delta: number): MixState {
  return setAmbientVol(getMix().ambientVol + delta);
}

export function toggleAmbientMute(): MixState {
  return setMix({ ambientMuted: !getMix().ambientMuted }, { ramp: RAMP.mute });
}

export function setSfxVol(v: number): MixState { return setMix({ sfxVol: clamp01(v) }); }
export function nudgeSfxVol(delta: number): MixState { return setSfxVol(getMix().sfxVol + delta); }
export function toggleSfxMute(): MixState { return setMix({ sfxMuted: !getMix().sfxMuted }, { ramp: RAMP.mute }); }

/** One sound scene's level (v2.34), for everyone. Mixes stacked scenes against each other. */
export function setSceneVol(sceneId: string, v: number): MixState {
  return setMix({ sceneVols: { ...getMix().sceneVols, [sceneId]: clamp01(v) } });
}

export function nudgeSceneVol(sceneId: string, delta: number): MixState {
  return setSceneVol(sceneId, (getMix().sceneVols?.[sceneId] ?? 1) + delta);
}

/** The Battle deck's own level (v2.39): the Battle slider, and the Music dial during combat. */
export function setBattleVol(v: number): MixState {
  return setMix({ battleVol: clamp01(v) });
}
export function nudgeBattleVol(delta: number): MixState {
  return setBattleVol(getMix().battleVol + delta);
}

let battleTimer: ReturnType<typeof setInterval> | undefined;
let battleDone: (() => void) | undefined;

/**
 * Blend between decks A/B (0) and the Battle deck (1) over the crossfade time, streaming the blend like
 * autofade streams the fader. A new blend replaces a running one, whose promise resolves then.
 */
export function fadeBattle(to: 0 | 1, durationMs = fadeSeconds() * 1000): Promise<void> {
  clearInterval(battleTimer);
  battleDone?.();
  const from = getMix().battle;
  if (from === to) return Promise.resolve();
  const start = Date.now();
  return new Promise(resolve => {
    battleDone = resolve;
    battleTimer = setInterval(() => {
      const elapsed = Date.now() - start;
      setMix({ battle: clamp01(fadePosition(from, to, elapsed, durationMs)) });
      if (elapsed >= durationMs) {
        clearInterval(battleTimer);
        battleTimer = undefined;
        battleDone = undefined;
        resolve();
      }
    }, AUTOFADE_STEP_MS);
  });
}

/** Fade every Music Deck channel to silence for everyone; press again to bring it all back. */
export function togglePanic(): MixState {
  return setMix({ panic: !getMix().panic }, { ramp: RAMP.panic });
}
