import { describe, expect, it } from "vitest";
import { FoundryMessageSchema, PluginMessageSchema } from "@music-deck/shared/protocol";
import { liveDeck, oneAtATime, setTrackDeck, setTrackPlan } from "../src/set-track";
import { filesTree, playlistsTree, trackChoices } from "../src/library-tree";

describe("liveDeck: the deck a Set Track key plays on", () => {
  it("is the deck you're hearing when it's playing", () => {
    expect(liveDeck(0.2, { A: true, B: true })).toBe("A");
    expect(liveDeck(0.8, { A: true, B: true })).toBe("B");
  });

  it("is the other deck when only that one plays and you can hear it", () => {
    expect(liveDeck(0.3, { A: false, B: true })).toBe("B");
    expect(liveDeck(0.7, { A: true, B: false })).toBe("A");
  });

  it("isn't a deck that plays but the fader has silenced", () => {
    expect(liveDeck(0, { A: false, B: true })).toBe("A");
    expect(liveDeck(1, { A: true, B: false })).toBe("B");
  });

  it("is the deck you're hearing when nothing plays", () => {
    expect(liveDeck(0, { A: false, B: false })).toBe("A");
    expect(liveDeck(0.5, { A: false, B: false })).toBe("B");
  });
});

describe("setTrackDeck: a battle takes the press", () => {
  it("is the Battle deck during a battle, whatever A and B are doing", () => {
    expect(setTrackDeck(true, 0.2, { A: false, B: false })).toBe("battle");
    expect(setTrackDeck(true, 0.8, { A: true, B: true })).toBe("battle");
  });

  it("is the deck that's playing outside a battle, as before", () => {
    expect(setTrackDeck(false, 0.3, { A: false, B: true })).toBe("B");
    expect(setTrackDeck(false, 0.2, { A: true, B: true })).toBe("A");
    expect(setTrackDeck(false, 1, { A: false, B: false })).toBe("B");
  });
});

describe("setTrackPlan", () => {
  const sound = (id: string, path: string, playing = false) => ({ id, path, playing });

  it("adds a track the deck doesn't have", () => {
    expect(setTrackPlan([sound("a", "music/a.ogg", true)], "music/b.ogg")).toEqual({ kind: "add" });
    expect(setTrackPlan([], "music/b.ogg")).toEqual({ kind: "add" });
  });

  it("does nothing when the track is already playing", () => {
    expect(setTrackPlan([sound("a", "music/a.ogg"), sound("b", "music/b.ogg", true)], "music/b.ogg")).toEqual({ kind: "playing" });
  });

  it("switches to the copy already on the deck instead of adding another", () => {
    expect(setTrackPlan([sound("a", "music/a.ogg", true), sound("b", "music/b.ogg")], "music/b.ogg")).toEqual({ kind: "switch", id: "b" });
  });

  it("prefers the deck's cued copy when it has the track twice", () => {
    const sounds = [sound("b1", "music/b.ogg"), sound("a", "music/a.ogg", true), sound("b2", "music/b.ogg")];
    expect(setTrackPlan(sounds, "music/b.ogg", "b2")).toEqual({ kind: "switch", id: "b2" });
    expect(setTrackPlan(sounds, "music/b.ogg", "a")).toEqual({ kind: "switch", id: "b1" });
  });
});

describe("oneAtATime: Set Track presses don't overlap", () => {
  const tick = () => new Promise(r => setTimeout(r, 1));
  /** A deck like decks.setTrack sees it: each step awaits Foundry. */
  const deck = () => {
    const sounds: { id: string; path: string; playing: boolean }[] = [];
    const press = async (path: string) => {
      const plan = setTrackPlan(sounds, path);
      if (plan.kind === "playing") return;
      await tick();
      const id = plan.kind === "switch" ? plan.id : `s${sounds.length}`;
      if (plan.kind === "add") sounds.push({ id, path, playing: false });
      await tick();
      for (const s of sounds) s.playing = s.id === id;
    };
    return { sounds, press };
  };

  it("adds a double-pressed track once", async () => {
    const d = deck();
    const press = oneAtATime(d.press);
    await Promise.all([press("music/a.ogg"), press("music/a.ogg")]);
    expect(d.sounds).toEqual([{ id: "s0", path: "music/a.ogg", playing: true }]);
  });

  it("ends on the track pressed last", async () => {
    const d = deck();
    const press = oneAtATime(d.press);
    await Promise.all([press("music/a.ogg"), press("music/b.ogg")]);
    expect(d.sounds.find(s => s.playing)?.path).toBe("music/b.ogg");
  });

  it("keeps going after a press fails", async () => {
    const ran: string[] = [];
    const press = oneAtATime(async (p: string) => { if (p === "bad") throw new Error("no"); ran.push(p); });
    await expect(press("bad")).rejects.toThrow("no");
    await press("ok");
    expect(ran).toEqual(["ok"]);
  });
});

describe("trackChoices: what a Set Track key can pick", () => {
  const playlists = playlistsTree(
    [{ id: "f1", name: "Campaign", folder: null, sort: 0 }],
    [
      { id: "p1", name: "Tavern", folder: "f1", sort: 0, sounds: [{ name: "Lute", path: "music/tavern/lute.ogg", sort: 0 }] },
      { id: "p2", name: "Battle", folder: null, sort: 1, sounds: [{ name: "Drums of War", path: "music/battle/drums.ogg", sort: 0 }] },
    ],
  );
  const files = filesTree([
    { path: "music/battle/drums.ogg", name: "drums" },
    { path: "music/Calm%20Night/wind.ogg", name: "wind" },
    { path: "music/loose.ogg", name: "loose" },
  ]);

  it("lists your playlists' tracks in sidebar order, then the Data/music files, each once", () => {
    expect(trackChoices(playlists, files)).toEqual([
      { path: "music/tavern/lute.ogg", name: "Lute", where: "Tavern" },
      { path: "music/battle/drums.ogg", name: "Drums of War", where: "Battle" },
      { path: "music/Calm%20Night/wind.ogg", name: "wind", where: "music/Calm Night" },
      { path: "music/loose.ogg", name: "loose", where: "music" },
    ]);
  });

  it("skips a playlist sound with no file, which would fail the plugin's schema and lose the whole list", () => {
    const withBlank = playlistsTree([], [{
      id: "p3", name: "Drafts", folder: null, sort: 0,
      sounds: [{ name: "Empty", path: null as unknown as string, sort: 0 }, { name: "Blank", path: "", sort: 1 }, { name: "Lute", path: "music/tavern/lute.ogg", sort: 2 }],
    }]);
    const tracks = trackChoices(withBlank, filesTree([]));
    expect(tracks).toEqual([{ path: "music/tavern/lute.ogg", name: "Lute", where: "Drafts" }]);
    expect(FoundryMessageSchema.safeParse({ type: "library", tracks }).success).toBe(true);
  });

  it("stops at a maximum, so a huge library can't swamp the link", () => {
    expect(trackChoices(playlists, files, 2).map(t => t.name)).toEqual(["Lute", "Drums of War"]);
  });
});

describe("protocol 8", () => {
  it("carries a Set Track press with the track's file", () => {
    expect(PluginMessageSchema.safeParse({ type: "track.set", path: "music/a.ogg", name: "A" }).success).toBe(true);
    expect(PluginMessageSchema.safeParse({ type: "track.set", path: "music/a.ogg" }).success).toBe(true);
    expect(PluginMessageSchema.safeParse({ type: "track.set", path: "" }).success).toBe(false);
    expect(PluginMessageSchema.safeParse({ type: "track.set" }).success).toBe(false);
  });

  it("protocol 11: keeps the Battle deck's track file, so a Set Track key can light during a battle", () => {
    const state = {
      fader: 0, musicVol: 0.8, muted: false, ambientVol: 0.6, ambientMuted: false, sfxVol: 1, sfxMuted: false, panic: false, sceneVols: {}, battle: 1, battleVol: 0.3, fading: false,
      decks: [], ambient: { on: false, names: "", layers: [] }, sfx: [], scenes: [], scenesOn: [],
      battleDeck: { track: "Storm", path: "music/storm.ogg", playing: true, cue: null },
    };
    const parsed = FoundryMessageSchema.parse({ type: "state", state });
    expect(parsed.type === "state" && parsed.state.battleDeck?.path).toBe("music/storm.ogg");
  });

  it("carries the tracks a key can pick from Foundry", () => {
    const tracks = [{ path: "music/a.ogg", name: "A", where: "music" }];
    expect(FoundryMessageSchema.safeParse({ type: "library", tracks }).success).toBe(true);
    expect(FoundryMessageSchema.safeParse({ type: "library", tracks: [{ path: "music/a.ogg" }] }).success).toBe(false);
  });
});
