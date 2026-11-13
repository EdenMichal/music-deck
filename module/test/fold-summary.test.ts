import { describe, expect, it } from "vitest";
import { battleSummary, decksSummary, sceneSummary, volumesSummary } from "../src/ui/view-model";

const mix = { musicVol: 0.81, muted: false, ambientVol: 0.72, ambientMuted: false, sfxVol: 0.88, sfxMuted: false };
const card = (id: string, playing: boolean, audible: boolean) => ({ id, title: `Track ${id}`, playing, audible });

describe("folded section summaries", () => {
  it("lists each channel's level, or muted", () => {
    expect(volumesSummary(mix)).toBe("Music 81 · Ambient 72 · SFX 88");
    expect(volumesSummary({ ...mix, ambientMuted: true })).toBe("Music 81 · Ambient muted · SFX 88");
  });

  it("names the deck the players hear", () => {
    expect(decksSummary([card("A", true, true), card("B", false, false)], false)).toBe("A on air · Track A");
    expect(decksSummary([card("A", true, true), card("B", true, true)], false)).toBe("A and B on air");
    expect(decksSummary([card("A", true, false), card("B", false, true)], false)).toBe("Nothing on air");
    expect(decksSummary([card("A", true, true), card("B", false, false)], true)).toBe("Faded out");
  });
});

describe("sceneSummary", () => {
  it("says how many of a closed scene's layers play", () => {
    expect(sceneSummary(0, 0)).toBe("No layers");
    expect(sceneSummary(1, 0)).toBe("1 layer");
    expect(sceneSummary(3, 2)).toBe("2 of 3 layers on");
    expect(sceneSummary(3, 0, 1)).toBe("3 layers, 1 off");
  });
});

describe("battleSummary", () => {
  it("says whether the Battle deck is in, what plays and its level", () => {
    expect(battleSummary(true, "Clash", 12, 0.3, false)).toBe("On · Clash · 30%");
    expect(battleSummary(true, null, 12, 0.3, true)).toBe("On · muted");
    expect(battleSummary(false, null, 12, 0.3, false)).toBe("Ready · 12 tracks");
    expect(battleSummary(false, null, 1, 0.3, false)).toBe("Ready · 1 track");
    expect(battleSummary(false, null, 0, 0.3, false)).toBe("Empty");
  });
});
