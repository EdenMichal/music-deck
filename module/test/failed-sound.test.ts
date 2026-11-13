import { afterEach, describe, expect, it, vi } from "vitest";
import { retryFailedSound } from "../src/failed-sound";

/** A stand-in for Foundry 14's PlaylistSound: sync() gives up on a Sound that failed to load. */
class FakePlaylistSound {
  playing = false;
  path = "sounds/rain.ogg";
  name = "Rain";
  sound: { failed: boolean; loads: number } | null = null;
  created = 0;
  /** Whether the next Sound made fails to load. */
  failNext = true;

  _createSound() {
    this.created++;
    return { failed: false, loads: 0 };
  }

  sync() {
    if (!this.playing) return;
    this.sound ||= this._createSound();
    if (this.sound.failed) return;
    this.sound.loads++;
    // Loading fails (or not) after sync returns, as Foundry's does.
    this.sound.failed = this.failNext;
  }
}

/** Ours: what MusicDeckPlaylistSound adds in main.ts. */
class OurPlaylistSound extends FakePlaylistSound {
  sync() {
    retryFailedSound(this);
    super.sync();
  }
}

describe("a sound whose file failed to load", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it("stays silent in Foundry's own PlaylistSound", () => {
    const ps = new FakePlaylistSound();
    ps.playing = true;
    ps.sync();
    ps.failNext = false;
    ps.playing = false; ps.sync();
    ps.playing = true; ps.sync();
    expect(ps.created).toBe(1);
    expect(ps.sound!.failed).toBe(true);
  });

  it("gets a fresh Sound the next time it's asked to play, and logs which file", () => {
    const ps = new OurPlaylistSound();
    ps.playing = true;
    ps.sync();
    expect(ps.sound!.failed).toBe(true);
    ps.failNext = false;
    ps.playing = false; ps.sync();
    ps.playing = true; ps.sync();
    expect(ps.created).toBe(2);
    expect(ps.sound!.failed).toBe(false);
    expect(ps.sound!.loads).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sounds/rain.ogg"));
  });

  it("is retried once per play request, not on every sync", () => {
    const ps = new OurPlaylistSound();
    ps.playing = true;
    ps.sync(); // fails
    ps.sync(); // a volume change while it's on: one fresh try, which fails too
    ps.sync();
    ps.sync();
    expect(ps.created).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    ps.playing = false; ps.sync();
    ps.playing = true; ps.sync();
    expect(ps.created).toBe(3);
  });

  it("leaves a sound that loaded alone", () => {
    const ps = new OurPlaylistSound();
    ps.failNext = false;
    ps.playing = true;
    ps.sync();
    ps.sync();
    expect(ps.created).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
