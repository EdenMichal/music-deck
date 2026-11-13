import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for the "Music Deck – Ambient" playlist. Like Foundry, `update` only changes the document once the
 * server has answered, so two commands sent close together both start from the state before either landed.
 */
type FakeSound = { id: string; playing: boolean; volume: number };
const fake = vi.hoisted(() => ({ playlist: null as any, mix: { sceneVols: {} as Record<string, number> } }));

vi.mock("../src/channels", () => ({
  playlistFor: (channel: string) => (channel === "ambient" ? fake.playlist : undefined),
  queueOf: (p: any) => (p ? [...p.sounds] : []),
}));

vi.mock("../src/live-gain", () => ({
  MODULE_ID: "music-deck",
  getMix: () => ({ ...fake.mix }),
  setMix: (change: any) => Object.assign(fake.mix, change),
}));

import { toggleAmbient, toggleLayer } from "../src/layers";
import { playCombo, recallScene, stackScene, toggleScene } from "../src/scenes";

/** `general`: layers no scene owns. */
function ambientPlaylist(scenes: { id: string; name: string; layers: { id: string }[] }[], playing: string[], general: string[] = []) {
  const all: FakeSound[] = [...scenes.flatMap(s => s.layers).map(({ id }) => id), ...general].map(id => ({ id, playing: playing.includes(id), volume: 0.5 }));
  const sounds = Object.assign(all, { has: (id: string) => all.some(s => s.id === id), get: (id: string) => all.find(s => s.id === id) });
  const p = {
    playing: playing.length > 0,
    flags: { scenes } as Record<string, unknown>,
    sounds,
    getFlag: (_scope: string, key: string) => p.flags[key],
    async setFlag(_scope: string, key: string, value: unknown) { p.flags[key] = value; },
    async playSound(sound: FakeSound) {
      return p.update({ playing: true, sounds: [{ _id: sound.id, playing: true }] });
    },
    // Foundry's own: whether the playlist stays on is worked out from the sounds as they are now.
    async stopSound(sound: FakeSound) {
      return p.update({ playing: all.some(s => s.id !== sound.id && s.playing), sounds: [{ _id: sound.id, playing: false }] });
    },
    async update(change: any) {
      await new Promise(r => setTimeout(r, 5));
      if ("playing" in change) p.playing = change.playing;
      for (const [key, value] of Object.entries(change)) if (key.startsWith("flags.")) p.flags[key.split(".").at(-1)!] = value;
      for (const s of change.sounds ?? []) Object.assign(sounds.get(s._id)!, s);
    },
  };
  return p;
}

const playingNow = () => fake.playlist.sounds.filter((s: FakeSound) => s.playing).map((s: FakeSound) => s.id);

describe("scene commands sent close together", () => {
  const scenes = [
    { id: "camp", name: "Camp", layers: [{ id: "fire" }] },
    { id: "storm", name: "Storm", layers: [{ id: "rain" }] },
    { id: "town", name: "Town", layers: [{ id: "tavern" }] },
  ];

  beforeEach(() => {
    fake.playlist = ambientPlaylist(scenes, ["fire", "rain"]);
    fake.mix = { sceneVols: {} };
  });

  it("fading out both stacked scenes at once leaves the ambient stopped, with something to bring back", async () => {
    await Promise.all([stackScene("camp"), stackScene("storm")]);
    expect(playingNow()).toEqual([]);
    expect(fake.playlist.playing).toBe(false);
    // The same as one after the other: the last one out is what a tap on the Ambient Dial brings back.
    expect(fake.playlist.flags.resume).toEqual(["rain"]);
  });

  it("two scene keys pressed quickly end on the second scene alone", async () => {
    fake.playlist = ambientPlaylist(scenes, ["fire"]);
    await Promise.all([toggleScene("storm"), toggleScene("town")]);
    expect(playingNow()).toEqual(["tavern"]);
  });

  it("a recall that lands after a stack still sees the stacked scene", async () => {
    await Promise.all([stackScene("town"), recallScene("camp")]);
    expect(playingNow()).toEqual(["fire"]);
  });

  it("a layer toggle sent with a scene key waits for it, so the playlist doesn't stay on with nothing playing", async () => {
    // Fading Camp out counts Rain as still on; Foundry's stopSound for Rain counts Fire as still on.
    await Promise.all([stackScene("camp"), toggleLayer("rain")]);
    expect(playingNow()).toEqual([]);
    expect(fake.playlist.playing).toBe(false);
  });

  it("an Ambient Dial tap sent with a scene key waits for it", async () => {
    // Stacking Town, then pausing: everything is off, and the tap remembers all three to bring back.
    await Promise.all([stackScene("town"), toggleAmbient()]);
    expect(playingNow()).toEqual([]);
    expect(fake.playlist.flags.resume).toEqual(["fire", "rain", "tavern"]);
  });

  it("turns the playlist off when a command leaves it on with no layer playing", async () => {
    fake.playlist = ambientPlaylist([...scenes, { id: "empty", name: "Empty", layers: [] }], []);
    fake.playlist.playing = true;
    await stackScene("empty");
    expect(fake.playlist.playing).toBe(false);
  });

  it("keeps going after a command fails", async () => {
    const update = fake.playlist.update;
    fake.playlist.update = () => Promise.reject(new Error("server said no"));
    await expect(stackScene("camp")).rejects.toThrow("server said no");
    fake.playlist.update = update;
    await stackScene("camp");
    expect(playingNow()).toEqual(["rain"]);
  });
});

describe("starting a scene you'd turned all the way down", () => {
  const scenes = [
    { id: "camp", name: "Camp", layers: [{ id: "fire" }] },
    { id: "storm", name: "Storm", layers: [{ id: "rain" }, { id: "wind" }] },
  ];

  beforeEach(() => {
    fake.playlist = ambientPlaylist(scenes, ["fire"]);
    fake.mix = { sceneVols: { storm: 0, camp: 0.3 } };
  });

  it("stacking it brings its level back to full", async () => {
    await stackScene("storm");
    expect(playingNow()).toEqual(["fire", "rain", "wind"]);
    expect(fake.mix.sceneVols).toEqual({ storm: 1, camp: 0.3 });
  });

  it("recalling or toggling it on does too", async () => {
    await recallScene("storm");
    expect(fake.mix.sceneVols.storm).toBe(1);
    fake.playlist = ambientPlaylist(scenes, ["fire"]);
    fake.mix = { sceneVols: { storm: 0 } };
    await toggleScene("storm");
    expect(fake.mix.sceneVols.storm).toBe(1);
  });

  it("turning on one of its layers while it's off does too", async () => {
    await toggleLayer("rain");
    expect(fake.mix.sceneVols.storm).toBe(1);
  });

  it("leaves a level above 0 alone, and a scene that's already on", async () => {
    await stackScene("storm");
    fake.mix = { sceneVols: { storm: 0, camp: 0.3 } };
    await toggleLayer("wind");
    await toggleLayer("wind");
    expect(fake.mix.sceneVols).toEqual({ storm: 0, camp: 0.3 });
    await recallScene("camp");
    expect(fake.mix.sceneVols.camp).toBe(0.3);
  });
});

describe("a Scene Combo key", () => {
  const scenes = [
    { id: "camp", name: "Camp", layers: [{ id: "fire" }] },
    { id: "storm", name: "Storm", layers: [{ id: "rain" }] },
    { id: "town", name: "Town", layers: [{ id: "tavern" }] },
  ];

  beforeEach(() => {
    // Wind is a General layer.
    fake.playlist = ambientPlaylist(scenes, ["tavern", "wind"], ["wind"]);
    fake.mix = { sceneVols: {} };
  });

  it("plays its scenes together and fades out every other scene and General", async () => {
    await playCombo(["camp", "storm"]);
    expect(playingNow()).toEqual(["fire", "rain"]);
    expect(fake.playlist.playing).toBe(true);
  });

  it("pressed again while just its scenes play, fades them out, with something to bring back", async () => {
    await playCombo(["camp", "storm"]);
    await playCombo(["camp", "storm"]);
    expect(playingNow()).toEqual([]);
    expect(fake.playlist.playing).toBe(false);
    expect(fake.playlist.flags.resume).toEqual(["fire", "rain"]);
  });

  it("skips a scene that's gone, and does nothing when they all are", async () => {
    await playCombo(["gone", "camp"]);
    expect(playingNow()).toEqual(["fire"]);
    await playCombo(["gone"]);
    expect(playingNow()).toEqual(["fire"]);
  });

  it("brings a scene you'd turned all the way down back to full", async () => {
    fake.mix = { sceneVols: { camp: 0, storm: 0.4, town: 0 } };
    await playCombo(["camp", "storm"]);
    expect(fake.mix.sceneVols).toEqual({ camp: 1, storm: 0.4, town: 0 });
  });

  it("leaves the level alone when it fades the combo out", async () => {
    fake.playlist = ambientPlaylist(scenes, ["fire", "rain"]);
    fake.mix = { sceneVols: { camp: 0 } };
    await playCombo(["camp", "storm"]);
    expect(playingNow()).toEqual([]);
    expect(fake.mix.sceneVols).toEqual({ camp: 0 });
  });

  it("waits its turn with other scene commands sent close together", async () => {
    // Each plans from what the one before left: the combo, then Town added on top, then Camp alone.
    await Promise.all([playCombo(["camp", "storm"]), stackScene("town"), toggleScene("camp")]);
    expect(playingNow()).toEqual(["fire"]);
  });

  it("a layer toggle sent with it waits for it", async () => {
    // The toggle sees what the combo left: Wind faded out, so the toggle turns it back on.
    await Promise.all([playCombo(["camp"]), toggleLayer("wind")]);
    expect(playingNow()).toEqual(["fire", "wind"]);
  });
});
