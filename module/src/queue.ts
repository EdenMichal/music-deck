/**
 * Pure queue helpers. A deck's queue is its playlist's sounds in manual sort order;
 * these work on the ordered list of sound ids and turn it back into sort values.
 */

export const SORT_STEP = 100_000;

export type EndMode = "loop" | "stop";

/** Move the item at `from` to index `to`. Returns a new array. */
export function move<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

/** Insert `item` at `index`, or at the end. Returns a new array. */
export function insert<T>(items: readonly T[], item: T, index = items.length): T[] {
  const out = [...items];
  out.splice(index, 0, item);
  return out;
}

/** Sort values that put the sounds in this order. */
export function sortUpdates(ids: readonly string[]): { _id: string; sort: number }[] {
  return ids.map((_id, i) => ({ _id, sort: (i + 1) * SORT_STEP }));
}

/** What plays after `id` ends: the next track, the first again when looping, or nothing. */
export function afterEnd(order: readonly string[], id: string, end: EndMode): string | null {
  if (!order.length) return null;
  const i = order.indexOf(id);
  if (i === -1) return order[0];
  if (i < order.length - 1) return order[i + 1];
  return end === "loop" ? order[0] : null;
}

/**
 * Sound updates that stop a deck and rewind it, so its current track reads as cued: nothing playing and no
 * paused position kept. Foundry's own `stopAll()` leaves `pausedTime` set, which makes the deck read "Paused".
 */
export function rewindUpdates(
  sounds: readonly { id: string; playing?: boolean; pausedTime?: number | null }[],
): { _id: string; playing: false; pausedTime: null }[] {
  return sounds.filter(s => s.playing || s.pausedTime != null).map(s => ({ _id: s.id, playing: false, pausedTime: null }));
}
