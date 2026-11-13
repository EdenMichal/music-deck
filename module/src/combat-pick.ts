import { silentDeck, type DeckId } from "./crossfader";

/** The next battle track: random, but not the one that just played unless it's the only one. */
export function pickNext<T>(tracks: readonly T[], last: T | undefined, rand: () => number = Math.random): T | undefined {
  const pool = tracks.length > 1 && last !== undefined ? tracks.filter(t => t !== last) : tracks;
  return pool.length ? pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))] : undefined;
}

/**
 * The Battle deck's queue (v2.39): every battle track in a random order, up to `max`, starting on a track other
 * than the one the last combat started on (unless it's the only one).
 */
export function battleOrder<T>(tracks: readonly T[], last: T | undefined, max = 100, rand: () => number = Math.random): T[] {
  const first = pickNext(tracks, last, rand);
  if (first === undefined) return [];
  const rest = tracks.filter(t => t !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [first, ...rest].slice(0, Math.max(1, max));
}

/**
 * The A/B tracks a battle paused that resume when it ends: not one on a deck the crossfader has since made
 * silent (the Fade button or slider moved during the battle). That one stays paused where it was, so it isn't
 * left playing unheard; the fader resumes it when it comes back.
 */
export function toResume<T extends { deck: DeckId }>(held: readonly T[], fader: number): T[] {
  const silent = silentDeck(fader);
  return held.filter(h => h.deck !== silent);
}

/**
 * What a reload does with the Battle deck: `back` blends back from a combat's battle whose combat is over; `in`
 * finishes a blend in that the reload cut short (A and B would otherwise stay part-heard under it, never paused);
 * `out` fades out a blend left on with no battle. Null: leave it as it is.
 */
export function recovery(run: { combat?: boolean } | null, combatRunning: boolean, blend: number): "back" | "in" | "out" | null {
  if (run?.combat && !combatRunning) return "back";
  if (run && blend < 1) return "in";
  if (!run && blend > 0) return "out";
  return null;
}
