import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * decks.setTrack against stand-ins for the three deck playlists, to check which deck a press works on and that
 * a battle leaves A and B as it found them.
 */
type FakeSound = { id: string; path: string; name: string; sort: number; playing: boolean; pausedTime?: number | null };
const fake = vi.hoisted(() => ({
  playlists: {} as Record<string, any>, battle: false, battleNo: 1, fader: 0, sheets: {} as Record<string, any>,
  /** The next track load, when a test holds it (holdLoad); else loads finish at once. */
  load: undefined as undefined | (() => Promise<void>),
}));

vi.mock("../src/channels", () => ({
  DECKS: ["A", "B"],
  playlistFor: (channel: string) => fake.playlists[channel],
  queueOf: (p: any) => (p ? [...p.sounds].sort((a: FakeSound, b: FakeSound) => a.sort - b.sort) : []),
  currentSound: (deck: string) => {
    const p = fake.playlists[deck];
    return p?.sounds.get(p.flags.current) ?? p?.sounds[0];
  },
  endModeOf: () => "loop",
  trackName: (path: string) => path.split("/").pop()!.replace(/\.[^.]+$/, ""),
}));
vi.mock("../src/live-gain", () => ({ MODULE_ID: "music-deck", getMix: () => ({ fader: fake.fader, battle: fake.battle ? 1 : 0 }) }));
vi.mock("../src/combat", () => ({ inBattle: () => fake.battle, battleId: () => (fake.battle ? fake.battleNo : null) }));
vi.mock("../src/cue-sheets", () => ({ getSheet: (path?: string) => (path ? fake.sheets[path] : undefined) }));
vi.mock("../src/cue-player", () => ({ goToCue: async () => false, playingCueOf: () => undefined }));
vi.mock("../src/mixer", () => ({ autofade: async () => undefined }));

import { setTrack } from "../src/decks";

let nextId = 0;
function deck(tracks: { path: string; playing?: boolean; pausedTime?: number }[]) {
  const all: FakeSound[] = tracks.map((t, i) => ({ id: `s${nextId++}`, path: t.path, name: t.path, sort: (i + 1) * 100_000, playing: !!t.playing, pausedTime: t.pausedTime ?? null }));
  const sounds = Object.assign(all, { get: (id: string) => all.find(s => s.id === id), has: (id: string) => all.some(s => s.id === id), contents: all });
  const p = {
    flags: {} as Record<string, unknown>,
    sounds,
    get playing() { return all.some(s => s.playing); },
    getFlag: (_scope: string, key: string) => p.flags[key],
    async setFlag(_scope: string, key: string, value: unknown) { p.flags[key] = value; },
    async unsetFlag(_scope: string, key: string) { delete p.flags[key]; },
    async createEmbeddedDocuments(_type: string, data: any[]) {
      const made = data.map(d => ({ id: `s${nextId++}`, sort: 0, playing: false, pausedTime: null, ...d, load: () => fake.load?.() ?? Promise.resolve() }));
      all.push(...made);
      return made;
    },
    async deleteEmbeddedDocuments(_type: string, ids: string[]) {
      for (const id of ids) all.splice(all.findIndex(s => s.id === id), 1);
    },
    async updateEmbeddedDocuments(_type: string, updates: { _id: string; sort: number }[]) {
      for (const u of updates) Object.assign(sounds.get(u._id)!, { sort: u.sort });
    },
    // Foundry's playSound on a playlist with a fade: the new track plays, the old one fades out and stops.
    async playSound(sound: FakeSound) {
      for (const s of all) s.playing = s.id === sound.id;
    },
  };
  return p;
}

const playingOn = (d: string) => fake.playlists[d].sounds.filter((s: FakeSound) => s.playing).map((s: FakeSound) => s.path);
const queue = (d: string) => [...fake.playlists[d].sounds].sort((a: FakeSound, b: FakeSound) => a.sort - b.sort).map((s: FakeSound) => s.path);

/** Hold the next track load until `release`; `loading` resolves once the press is waiting on it. */
function holdLoad() {
  let started!: () => void, release!: () => void;
  const loading = new Promise<void>(r => (started = r));
  fake.load = () => {
    fake.load = undefined;
    started();
    return new Promise<void>(r => (release = r));
  };
  return { loading, release: () => release() };
}

beforeEach(() => {
  (globalThis as any).game = { audio: { locked: true } };
  fake.fader = 0;
  fake.sheets = {};
  fake.load = undefined;
  fake.battleNo = 1;
});

describe("Set Track during a battle", () => {
  beforeEach(() => {
    fake.battle = true;
    // A and B paused under the battle music, where they were.
    fake.playlists = {
      A: deck([{ path: "music/tavern.ogg", pausedTime: 42 }, { path: "music/road.ogg" }]),
      B: deck([{ path: "music/forest.ogg", pausedTime: 7 }]),
      battle: deck([{ path: "battle/clash.ogg", playing: true }, { path: "battle/drums.ogg" }]),
    };
  });

  it("fades the Battle deck to the track, right after what's playing", async () => {
    await setTrack("music/storm.ogg", "Storm");
    expect(playingOn("battle")).toEqual(["music/storm.ogg"]);
    expect(queue("battle")).toEqual(["battle/clash.ogg", "music/storm.ogg", "battle/drums.ogg"]);
  });

  it("leaves A and B paused where they were, with their queues untouched", async () => {
    const before = (d: string) => fake.playlists[d].sounds.map((s: FakeSound) => ({ ...s }));
    const a = before("A"), b = before("B");
    await setTrack("music/road.ogg");
    expect(fake.playlists.A.sounds.map((s: FakeSound) => ({ ...s }))).toEqual(a);
    expect(fake.playlists.B.sounds.map((s: FakeSound) => ({ ...s }))).toEqual(b);
    expect(fake.playlists.A.flags).toEqual({});
    expect(playingOn("battle")).toEqual(["music/road.ogg"]);
  });

  it("goes to a copy the Battle deck already has, and does nothing when it's already playing", async () => {
    await setTrack("battle/drums.ogg");
    expect(playingOn("battle")).toEqual(["battle/drums.ogg"]);
    expect(queue("battle")).toEqual(["battle/clash.ogg", "battle/drums.ogg"]);
    await setTrack("battle/drums.ogg");
    expect(queue("battle")).toHaveLength(2);
  });

  it("a battle track with roles joins on its intro, chained into battle and ending on victory, like the battle music", async () => {
    fake.sheets["music/boss.ogg"] = {
      path: "music/boss.ogg", duration: 120, defaultCue: "b",
      cues: [
        { id: "i", name: "Intro", start: 0, end: 10, mode: "once", role: "intro" },
        { id: "b", name: "Fight", start: 10, end: 100, mode: "loop", role: "battle" },
        { id: "v", name: "Victory", start: 100, end: null, mode: "once", role: "victory" },
      ],
    };
    await setTrack("music/boss.ogg", "Boss");
    const boss = fake.playlists.battle.sounds.find((s: FakeSound) => s.path === "music/boss.ogg");
    expect(boss.playing).toBe(true);
    expect(boss.flags["music-deck"]).toEqual({ cue: "i", chain: { i: "b", v: "stop" } });
  });

  it("still runs presses one at a time: a double press adds the track once", async () => {
    await Promise.all([setTrack("music/storm.ogg"), setTrack("music/storm.ogg")]);
    expect(queue("battle").filter(p => p === "music/storm.ogg")).toHaveLength(1);
  });
});

describe("Set Track outside a battle", () => {
  beforeEach(() => {
    fake.battle = false;
    fake.playlists = {
      A: deck([{ path: "music/tavern.ogg", playing: true }]),
      B: deck([{ path: "music/forest.ogg" }]),
      battle: deck([{ path: "battle/clash.ogg" }]),
    };
  });

  it("a track with roles joins A or B on its default cue, without combat's chain, as before", async () => {
    fake.sheets["music/boss.ogg"] = {
      path: "music/boss.ogg", duration: 120, defaultCue: "b",
      cues: [
        { id: "i", name: "Intro", start: 0, end: 10, mode: "once", role: "intro" },
        { id: "b", name: "Fight", start: 10, end: 100, mode: "loop", role: "battle" },
      ],
    };
    await setTrack("music/boss.ogg", "Boss");
    const boss = fake.playlists.A.sounds.find((s: FakeSound) => s.path === "music/boss.ogg");
    expect(boss.flags["music-deck"]).toEqual({ cue: "b" });
  });

  it("fades the deck that's playing, as before, and leaves the Battle deck alone", async () => {
    await setTrack("music/storm.ogg");
    expect(playingOn("A")).toEqual(["music/storm.ogg"]);
    expect(queue("A")).toEqual(["music/tavern.ogg", "music/storm.ogg"]);
    expect(queue("B")).toEqual(["music/forest.ogg"]);
    expect(queue("battle")).toEqual(["battle/clash.ogg"]);
    expect(playingOn("battle")).toEqual([]);
  });

  it("with nothing playing, starts on the deck you're hearing", async () => {
    fake.playlists.A = deck([{ path: "music/tavern.ogg" }]);
    fake.fader = 1;
    await setTrack("music/storm.ogg");
    expect(playingOn("B")).toEqual(["music/storm.ogg"]);
    expect(queue("B")).toEqual(["music/storm.ogg", "music/forest.ogg"]);
    expect(playingOn("A")).toEqual([]);
  });
});

describe("Set Track while a large file loads", () => {
  beforeEach(() => {
    (globalThis as any).game.audio.locked = false;
  });

  it("combat ends during the load: the track goes to A/B as outside a battle, and the stopped Battle deck stays off", async () => {
    fake.battle = true;
    fake.playlists = {
      A: deck([{ path: "music/tavern.ogg", pausedTime: 42 }]),
      B: deck([{ path: "music/forest.ogg" }]),
      battle: deck([{ path: "battle/clash.ogg", playing: true }, { path: "battle/drums.ogg" }]),
    };
    const load = holdLoad();
    const press = setTrack("music/storm.ogg", "Storm");
    await load.loading;
    // Combat ends: the blend back resumes A and stops the Battle deck.
    fake.battle = false;
    for (const s of fake.playlists.battle.sounds) s.playing = false;
    fake.playlists.A.sounds[0].playing = true;
    load.release();
    await press;
    expect(playingOn("battle")).toEqual([]);
    expect(queue("battle")).toEqual(["battle/clash.ogg", "battle/drums.ogg"]);
    expect(playingOn("A")).toEqual(["music/storm.ogg"]);
    expect(queue("A")).toEqual(["music/tavern.ogg", "music/storm.ogg"]);
  });

  it("combat starts during the load: the track goes to the Battle deck, and A stays paused under it as it was", async () => {
    fake.battle = false;
    fake.playlists = {
      A: deck([{ path: "music/tavern.ogg", playing: true }]),
      B: deck([{ path: "music/forest.ogg" }]),
      battle: deck([{ path: "battle/clash.ogg" }, { path: "battle/drums.ogg" }]),
    };
    const load = holdLoad();
    const press = setTrack("music/storm.ogg", "Storm");
    await load.loading;
    // Begin Combat: the Battle deck comes in and A pauses where it was.
    fake.battle = true;
    fake.battleNo++;
    fake.playlists.battle.sounds[0].playing = true;
    Object.assign(fake.playlists.A.sounds[0], { playing: false, pausedTime: 42 });
    load.release();
    await press;
    expect(playingOn("A")).toEqual([]);
    expect(queue("A")).toEqual(["music/tavern.ogg"]);
    expect(fake.playlists.A.flags).toEqual({});
    expect(playingOn("battle")).toEqual(["music/storm.ogg"]);
    expect(queue("battle")).toEqual(["battle/clash.ogg", "music/storm.ogg", "battle/drums.ogg"]);
  });
});
