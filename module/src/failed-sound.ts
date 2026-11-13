/**
 * A sound whose file failed to load stays silent for good in Foundry 14: PlaylistSound#sync() returns early once
 * `sound.failed` is set, so the layer shows as playing and is never heard until a reload. Stacking scenes loads many
 * files at once, which makes a decode error or timeout more likely. Our PlaylistSound subclass calls this from
 * sync(): a sound asked to play whose Sound has failed gets a fresh one (as Foundry itself does when the path
 * changes), once per play request, so a file that keeps failing isn't retried in a loop.
 */

/** The PlaylistSounds already given a fresh Sound since they were last asked to play. */
const retried = new WeakSet<object>();

export interface RetryableSound {
  playing: boolean;
  path?: string;
  name?: string;
  sound?: { failed?: boolean } | null;
  _createSound(): any;
}

export function retryFailedSound(ps: RetryableSound): void {
  if (!ps.playing) {
    retried.delete(ps);
    return;
  }
  if (!ps.sound?.failed || retried.has(ps)) return;
  retried.add(ps);
  console.warn(`Music Deck | "${ps.name ?? ps.path}" (${ps.path}) failed to load; trying it again.`);
  ps.sound = ps._createSound();
}
