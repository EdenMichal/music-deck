import { describe, expect, it } from "vitest";
import { DEFAULT_MIX, channelGains, duckFactor } from "../src/crossfader";

describe("SFX level", () => {
  it("defaults to full, as before Phase 5", () => expect(channelGains(DEFAULT_MIX).sfx).toBe(1));
  it("follows the level, and goes to 0 when muted or in panic", () => {
    expect(channelGains({ ...DEFAULT_MIX, sfxVol: 0.5 }).sfx).toBe(0.5);
    expect(channelGains({ ...DEFAULT_MIX, sfxMuted: true }).sfx).toBe(0);
    expect(channelGains({ ...DEFAULT_MIX, panic: true }).sfx).toBe(0);
  });
});

describe("duckFactor", () => {
  const on = { enabled: true, depth: 0.5, sfxPlaying: true };
  it("dips to the depth while an SFX plays", () => expect(duckFactor(DEFAULT_MIX, on)).toBe(0.5));
  it("doesn't dip when off, when nothing plays, or when SFX can't be heard", () => {
    expect(duckFactor(DEFAULT_MIX, { ...on, enabled: false })).toBe(1);
    expect(duckFactor(DEFAULT_MIX, { ...on, sfxPlaying: false })).toBe(1);
    expect(duckFactor({ ...DEFAULT_MIX, sfxMuted: true }, on)).toBe(1);
    expect(duckFactor({ ...DEFAULT_MIX, sfxVol: 0 }, on)).toBe(1);
    expect(duckFactor({ ...DEFAULT_MIX, panic: true }, on)).toBe(1);
  });
});
