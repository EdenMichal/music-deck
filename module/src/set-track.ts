/**
 * The Set Track key's rules (protocol 8), pure so they can be unit-tested. decks.setTrack applies them.
 */
import { silentDeck, type DeckId, type PlayDeck } from "./crossfader";

/**
 * The deck a Set Track key plays on: the one playing now. That's the deck you're hearing if it plays; else the
 * other deck if it plays and the fader lets you hear it; with nothing playing, the deck you're hearing.
 */
export function liveDeck(fader: number, playing: Record<DeckId, boolean>): DeckId {
  const heard: DeckId = fader < 0.5 ? "A" : "B";
  const other: DeckId = heard === "A" ? "B" : "A";
  return !playing[heard] && playing[other] && silentDeck(fader) !== other ? other : heard;
}

/**
 * The deck a Set Track press works on: the Battle deck while a battle is on (v2.42), so the track takes over the
 * battle music and A and B stay paused under it, ready to resume; else the deck that's playing now (liveDeck).
 */
export function setTrackDeck(battle: boolean, fader: number, playing: Record<DeckId, boolean>): PlayDeck {
  return battle ? "battle" : liveDeck(fader, playing);
}

export type SetTrackPlan = { kind: "playing" } | { kind: "switch"; id: string } | { kind: "add" };

/**
 * What a Set Track press does on a deck, from its sounds in queue order: nothing when the track is already
 * playing; else go to the copy the deck already has (its cued one, `current`, if it has the file twice); else add it.
 */
export function setTrackPlan(sounds: readonly { id: string; path: string; playing: boolean }[], path: string, current?: string): SetTrackPlan {
  const copies = sounds.filter(s => s.path === path);
  if (copies.some(s => s.playing)) return { kind: "playing" };
  const copy = copies.find(s => s.id === current) ?? copies[0];
  return copy ? { kind: "switch", id: copy.id } : { kind: "add" };
}

/**
 * Runs an async function one call at a time, in order; each call waits for the one before it, failed or not.
 * Deck commands aren't awaited (deck-client.ts), so without this a double press reads the deck before the first
 * press has added the track, and adds it twice; and two quick presses could finish in the wrong order.
 */
export function oneAtATime<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let last: Promise<void> = Promise.resolve();
  return (...args: A) => {
    const run = last.then(() => fn(...args));
    last = run.catch(() => undefined);
    return run;
  };
}
