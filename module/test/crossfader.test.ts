import { describe, expect, it } from "vitest";
import { DEFAULT_MIX, battleGain, channelGains, deckGains, fadePosition, nudge, otherSide, silentDeck } from "../src/crossfader";

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("deckGains", () => {
  it("plays only deck A with the fader hard left", () => {
    const g = deckGains({ ...DEFAULT_MIX, fader: 0, musicVol: 1 });
    close(g.A, 1);
    close(g.B, 0);
  });

  it("plays only deck B with the fader hard right", () => {
    const g = deckGains({ ...DEFAULT_MIX, fader: 1, musicVol: 1 });
    close(g.A, 0);
    close(g.B, 1);
  });

  it("keeps total power constant across the fade (equal-power curve)", () => {
    for (const fader of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const g = deckGains({ ...DEFAULT_MIX, fader, musicVol: 1 });
      close(g.A ** 2 + g.B ** 2, 1);
    }
  });

  it("scales both decks by the music volume curve", () => {
    const g = deckGains({ ...DEFAULT_MIX, fader: 0, musicVol: 0.5 }, v => v * v);
    close(g.A, 0.25);
  });

  it("silences both decks when muted", () => {
    const g = deckGains({ ...DEFAULT_MIX, fader: 0.5, musicVol: 1, muted: true });
    expect(g).toEqual({ A: 0, B: 0 });
  });
});

describe("channelGains", () => {
  it("gives ambient its own level and mute, independent of the music", () => {
    const g = channelGains({ ...DEFAULT_MIX, muted: true, ambientVol: 0.5, ambientMuted: false }, v => v);
    expect(g.A).toBe(0);
    close(g.ambient, 0.5);
    expect(channelGains({ ...DEFAULT_MIX, ambientMuted: true }).ambient).toBe(0);
  });

  it("plays SFX at full trim", () => {
    expect(channelGains(DEFAULT_MIX).sfx).toBe(1);
  });

  it("silences every channel on panic", () => {
    expect(channelGains({ ...DEFAULT_MIX, panic: true })).toEqual({ A: 0, B: 0, battle: 0, ambient: 0, sfx: 0 });
  });
});

describe("the Battle deck blend", () => {
  it("is silent outside combat and leaves A and B alone", () => {
    const g = channelGains({ ...DEFAULT_MIX, musicVol: 1, battle: 0 });
    expect(g.battle).toBe(0);
    close(g.A, 1);
  });

  it("at full blend plays only the Battle deck, at its own level", () => {
    const g = channelGains({ ...DEFAULT_MIX, musicVol: 1, battle: 1, battleVol: 0.6, fader: 0.3 });
    close(g.battle, 0.6);
    close(g.A, 0);
    close(g.B, 0);
  });

  it("crosses over at equal power halfway", () => {
    const mix = { ...DEFAULT_MIX, musicVol: 1, battle: 0.5, battleVol: 1, fader: 0 };
    const g = channelGains(mix);
    close(g.A ** 2 + g.battle ** 2, 1);
  });

  it("goes quiet with the music mute, and with panic", () => {
    expect(battleGain({ ...DEFAULT_MIX, battle: 1, muted: true })).toBe(0);
    expect(channelGains({ ...DEFAULT_MIX, battle: 1, panic: true }).battle).toBe(0);
  });

  it("treats an old saved mix without battle fields as no combat", () => {
    const old: any = { ...DEFAULT_MIX };
    delete old.battle;
    delete old.battleVol;
    expect(battleGain(old)).toBe(0);
    close(deckGains({ ...old, musicVol: 1 }).A, 1);
  });
});

describe("nudge", () => {
  it("moves a value by delta and clamps it to 0..1", () => {
    expect(nudge(0.5, 0.1)).toBeCloseTo(0.6);
    expect(nudge(0.95, 0.1)).toBe(1);
    expect(nudge(0.05, -0.1)).toBe(0);
  });
});

describe("auto-fade", () => {
  it("heads for the side you are not hearing", () => {
    expect(otherSide(0)).toBe(1);
    expect(otherSide(0.3)).toBe(1);
    expect(otherSide(0.7)).toBe(0);
    expect(otherSide(1)).toBe(0);
  });

  it("interpolates the fader position over the fade time", () => {
    expect(fadePosition(0, 1, 0, 4000)).toBe(0);
    expect(fadePosition(0, 1, 2000, 4000)).toBeCloseTo(0.5);
    expect(fadePosition(1, 0, 1000, 4000)).toBeCloseTo(0.75);
    expect(fadePosition(0, 1, 9999, 4000)).toBe(1);
    expect(fadePosition(0, 1, 10, 0)).toBe(1);
  });
});

describe("silentDeck", () => {
  it("names the deck you can't hear when the fader is at an end", () => {
    expect(silentDeck(0)).toBe("B");
    expect(silentDeck(1)).toBe("A");
    expect(silentDeck(0.5)).toBeNull();
    expect(silentDeck(0.999)).toBeNull();
  });
});
