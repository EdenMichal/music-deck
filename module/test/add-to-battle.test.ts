import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ＋⚔ in the Library (addToBattle): the track lands on the Battle deck's queue at once, not only in the
 * Music Deck – Combat playlist, and an empty Battle deck gets the whole shuffle rather than just that track.
 */
type FakeSound = { id: string; path: string; name: string; sort: number };
const fake = vi.hoisted(() => ({
  combat: [] as { path: string; name: string }[],
  battle: [] as FakeSound[],
  source: "",
  hasCombatPlaylist: true,
  /** The battle playlist's run flag (a battle is on) and Foundry's play order (shuffled when Shuffle is on). */
  run: null as unknown,
  order: undefined as string[] | undefined,
  stopped: false,
  played: [] as string[],
}));

let cached: { all: FakeSound[]; p: any } | undefined;
function playlist(all: FakeSound[]) {
  let n = 0;
  const sounds = Object.assign(all, { has: (id: string) => all.some(s => s.id === id), get size() { return all.length; } });
  return {
    sounds,
    getFlag: (_scope: string, key: string) => (key === "battleRun" ? fake.run : undefined),
    get playbackOrder() { return fake.order; },
    async createEmbeddedDocuments(_type: string, data: any[]) {
      const made = data.map(d => ({ id: `b${n++}`, sort: 0, ...d }));
      all.push(...made);
      return made;
    },
    async updateEmbeddedDocuments() {},
  };
}

vi.mock("../src/channels", () => ({
  combatPlaylist: () => (fake.hasCombatPlaylist ? { id: "combat" } : undefined),
  addToCombat: async (path: string, name?: string) => {
    if (!fake.hasCombatPlaylist) return false;
    if (!fake.combat.some(t => t.path === path)) fake.combat.push({ path, name: name ?? path });
    return true;
  },
  // One stand-in per test's battle list, so the track-end check (`playlist === playlistFor("battle")`) holds.
  playlistFor: (channel: string) => {
    if (channel !== "battle") return undefined;
    if (cached?.all !== fake.battle) cached = { all: fake.battle, p: playlist(fake.battle) };
    return cached.p;
  },
  queueOf: (p: any) => [...p.sounds],
}));
vi.mock("../src/decks", () => ({
  trackData: (path: string, name?: string) => ({ path, name: name ?? path }),
  onDeckTrackEnd: async () => fake.stopped,
  playTrack: async (_deck: string, id: string) => { fake.played.push(id); },
  addTrack: async (_deck: string, path: string, { name }: { name?: string } = {}) => {
    fake.battle.push({ id: `b-added-${path}`, path, name: name ?? path, sort: 0 });
  },
}));
vi.mock("../src/library-sources", () => ({
  nodeFor: (id: string) => (id === "folder:mine" ? {} : undefined),
  // The default source is the Combat playlist; a chosen folder holds one other track.
  tracksFor: (id: string) => (id === "playlist:combat" ? fake.combat : id === "folder:mine" ? [{ path: "mine.ogg", name: "Mine" }] : []),
}));
vi.mock("../src/live-gain", () => ({ MODULE_ID: "music-deck", getMix: () => ({ battle: 0 }) }));
vi.mock("../src/mixer", () => ({}));
vi.mock("../src/cue-sheets", () => ({ getSheet: () => undefined, cueFade: () => 0, defaultWhen: () => "now" }));
vi.mock("../src/cue-player", () => ({ goToCue: async () => false, playingCueOf: () => undefined }));

(globalThis as any).game = { settings: { get: () => fake.source }, users: { activeGM: { isSelf: true } } };
(globalThis as any).ui = { notifications: { warn: () => {}, info: () => {} } };

import { addToBattle, onBattleTrackEnd } from "../src/combat";
import { playlistFor } from "../src/channels";

beforeEach(() => {
  fake.combat = [{ path: "old.ogg", name: "Old" }];
  fake.battle = [];
  fake.source = "";
  fake.hasCombatPlaylist = true;
  fake.run = null;
  fake.order = undefined;
  fake.stopped = false;
  fake.played = [];
});

describe("addToBattle", () => {
  it("puts the track on a loaded Battle deck's queue and in the Combat playlist", async () => {
    fake.battle.push({ id: "b-old", path: "old.ogg", name: "Old", sort: 0 });
    expect(await addToBattle("new.ogg", "New")).toBe("added");
    expect(fake.battle.map(s => s.path)).toEqual(["old.ogg", "new.ogg"]);
    expect(fake.combat.map(t => t.path)).toContain("new.ogg");
  });

  it("fills an empty Battle deck with the whole battle music, the new track included", async () => {
    expect(await addToBattle("new.ogg", "New")).toBe("added");
    expect(fake.battle.map(s => s.path).sort()).toEqual(["new.ogg", "old.ogg"]);
  });

  it("adds the track even when the battle music is a folder that doesn't hold it", async () => {
    fake.source = "folder:mine";
    expect(await addToBattle("new.ogg", "New")).toBe("added");
    expect(fake.battle.map(s => s.path).sort()).toEqual(["mine.ogg", "new.ogg"]);
  });

  it("doesn't add a track twice", async () => {
    fake.battle.push({ id: "b-new", path: "new.ogg", name: "New", sort: 0 });
    expect(await addToBattle("new.ogg", "New")).toBe("already");
    expect(fake.battle).toHaveLength(1);
  });

  it("does nothing without the Combat playlist", async () => {
    fake.hasCombatPlaylist = false;
    expect(await addToBattle("new.ogg", "New")).toBeNull();
    expect(fake.battle).toHaveLength(0);
  });
});

describe("onBattleTrackEnd", () => {
  const three = () => ["x", "y", "z"].forEach((id, i) => fake.battle.push({ id, path: `${id}.ogg`, name: id, sort: i }));

  it("plays the next track in Foundry's play order, so Shuffle reaches the Battle deck", async () => {
    three();
    fake.run = { held: [] };
    fake.order = ["x", "z", "y"];
    expect(await onBattleTrackEnd(playlistFor("battle"), { id: "z" })).toBe(true);
    expect(fake.played).toEqual(["y"]);
  });

  it("leaves the end to the deck's Repeat setting when it stops after the last track", async () => {
    three();
    fake.run = { held: [] };
    fake.stopped = true;
    expect(await onBattleTrackEnd(playlistFor("battle"), { id: "z" })).toBe(true);
    expect(fake.played).toEqual([]);
  });
});
