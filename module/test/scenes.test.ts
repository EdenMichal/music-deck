import { describe, expect, it } from "vitest";
import { PluginMessageSchema } from "@music-deck/shared/protocol";
import { adoptPlan, groupLayers, layersOn, migrationPlan, remember, sceneLayers, nameFor, normalizeScene, recallPlan, roundLevel, sceneCandidates, sceneForPlaying, scenesPlaying, soundKey, stackPlan, comboPlan } from "../src/scenes";

/** Every layer's current volume. */
const volumes = { fire: 0.5, crickets: 0.5, rain: 0.5, tavern: 0.5 };
const all = Object.keys(volumes);
const layer = (id: string, volume?: number) => ({ id, volume });

describe("recallPlan", () => {
  it("fades the scene's layers in and the others out", () => {
    expect(recallPlan([layer("fire"), layer("crickets")], ["rain"], volumes))
      .toEqual({ start: ["fire", "crickets"], stop: ["rain"], levels: [] });
  });

  it("leaves a layer that's in both scenes playing, so it doesn't restart", () => {
    expect(recallPlan([layer("fire"), layer("crickets")], ["fire", "rain"], volumes))
      .toEqual({ start: ["crickets"], stop: ["rain"], levels: [] });
  });

  it("sets the scene's levels, including on a layer that stays on", () => {
    expect(recallPlan([layer("fire", 0.2), layer("crickets", 0.9)], ["fire"], volumes))
      .toEqual({ start: ["crickets"], stop: [], levels: [{ id: "fire", volume: 0.2 }, { id: "crickets", volume: 0.9 }] });
  });

  it("does nothing when the scene is already on at its levels", () => {
    expect(recallPlan([layer("fire", 0.5), layer("crickets")], ["crickets", "fire"], volumes))
      .toEqual({ start: [], stop: [], levels: [] });
  });

  it("turns everything off for an empty scene", () => {
    expect(recallPlan([], ["fire", "rain"], volumes)).toEqual({ start: [], stop: ["fire", "rain"], levels: [] });
  });

  it("skips a layer that has since been deleted", () => {
    expect(recallPlan([layer("fire"), layer("gone", 1)], [], volumes)).toEqual({ start: ["fire"], stop: [], levels: [] });
  });
});

describe("each scene owns its layers", () => {
  const scenes = [
    { id: "camp", name: "Night Camp", layers: [layer("fire"), layer("crickets")] },
    { id: "town", name: "Town", layers: [layer("tavern")] },
    { id: "quiet", name: "Off-Play", layers: [] },
  ];

  describe("groupLayers", () => {
    it("puts each layer under its scene, in the Ambient playlist's order, and the rest in Unsorted", () => {
      expect(groupLayers(scenes, ["rain", "crickets", "tavern", "fire"])).toEqual({
        groups: [{ id: "camp", layers: ["crickets", "fire"] }, { id: "town", layers: ["tavern"] }, { id: "quiet", layers: [] }],
        unsorted: ["rain"],
      });
    });

    it("leaves out a layer a scene names that no longer exists", () => {
      expect(groupLayers(scenes, ["fire"]).groups[0]).toEqual({ id: "camp", layers: ["fire"] });
    });

    it("shows a layer two old scenes shared under the first one only", () => {
      const shared = [...scenes, { id: "late", name: "Late", layers: [layer("fire")] }];
      expect(groupLayers(shared, ["fire"]).groups.find(g => g.id === "late")).toEqual({ id: "late", layers: [] });
    });
  });

  describe("stacking scenes", () => {
    const volumes = { fire: 0.5, crickets: 0.3, tavern: 0.8, rain: 0.6 };

    it("lists every scene with a layer playing, ignoring General layers", () => {
      expect(scenesPlaying(scenes, ["tavern", "fire", "rain"])).toEqual(["camp", "town"]);
      expect(scenesPlaying(scenes, ["rain"])).toEqual([]);
    });

    it("adds a scene on top without stopping the others", () => {
      expect(stackPlan("town", scenes, ["fire", "crickets", "rain"], volumes)).toEqual({ start: ["tavern"], stop: [], levels: [] });
    });

    it("fades just that scene out when it's already on", () => {
      expect(stackPlan("camp", scenes, ["fire", "tavern", "rain"], volumes)).toEqual({ start: [], stop: ["fire"], levels: [] });
    });

    it("keeps a layer turned off in the scene off", () => {
      const withOff = scenes.map(s => (s.id === "camp" ? { ...s, layers: [layer("fire"), { id: "crickets", off: true }] } : s));
      expect(stackPlan("camp", withOff, ["tavern"], volumes)).toEqual({ start: ["fire"], stop: [], levels: [] });
    });

    it("does nothing for a scene that's gone", () => {
      expect(stackPlan("nope", scenes, [], volumes)).toBeNull();
    });
  });

  describe("comboPlan: a Scene Combo key", () => {
    // Rain is a General layer; Storm is a third scene.
    const withStorm = [...scenes, { id: "storm", name: "Storm", layers: [layer("thunder")] }];
    const v = { ...volumes, thunder: 0.4 };

    it("plays every chosen scene and fades out every other scene and the General layers", () => {
      expect(comboPlan(["camp", "town"], withStorm, ["thunder", "rain", "fire"], v))
        .toEqual({ sceneIds: ["camp", "town"], off: false, start: ["crickets", "tavern"], stop: ["thunder", "rain"], levels: [] });
    });

    it("leaves layers of the chosen scenes that are already on playing, so they don't restart", () => {
      expect(comboPlan(["camp", "town"], withStorm, ["fire", "thunder"], v))
        .toEqual({ sceneIds: ["camp", "town"], off: false, start: ["crickets", "tavern"], stop: ["thunder"], levels: [] });
    });

    it("fades the combo out when exactly its scenes are on", () => {
      expect(comboPlan(["camp", "town"], withStorm, ["fire", "tavern"], v))
        .toEqual({ sceneIds: ["camp", "town"], off: true, start: [], stop: ["fire", "tavern"], levels: [] });
    });

    it("leaves General playing when it fades the combo out", () => {
      expect(comboPlan(["camp", "town"], withStorm, ["fire", "crickets", "tavern", "rain"], v))
        .toEqual({ sceneIds: ["camp", "town"], off: true, start: [], stop: ["fire", "crickets", "tavern"], levels: [] });
    });

    it("switches instead of fading out when another scene is on too, or one of its scenes isn't", () => {
      expect(comboPlan(["camp", "town"], withStorm, ["fire", "tavern", "thunder"], v))
        .toMatchObject({ off: false, start: ["crickets"], stop: ["thunder"] });
      expect(comboPlan(["camp", "town"], withStorm, ["fire"], v)).toMatchObject({ off: false, start: ["crickets", "tavern"], stop: [] });
    });

    it("skips scenes that are gone, and does nothing when they all are", () => {
      expect(comboPlan(["nope", "town"], withStorm, ["fire"], v))
        .toEqual({ sceneIds: ["town"], off: false, start: ["tavern"], stop: ["fire"], levels: [] });
      expect(comboPlan(["nope", "gone"], withStorm, ["fire"], v)).toBeNull();
      expect(comboPlan([], withStorm, ["fire"], v)).toBeNull();
    });

    it("counts a scene chosen twice once", () => {
      expect(comboPlan(["town", "town"], withStorm, ["tavern"], v)).toMatchObject({ sceneIds: ["town"], off: true, stop: ["tavern"] });
    });

    it("keeps a layer turned off in its scene off", () => {
      const withOff = withStorm.map(s => (s.id === "camp" ? { ...s, layers: [layer("fire"), { id: "crickets", off: true }] } : s));
      expect(comboPlan(["camp", "town"], withOff, ["crickets"], v)).toMatchObject({ start: ["fire", "tavern"], stop: ["crickets"] });
    });
  });

  describe("sceneForPlaying", () => {
    it("is the scene that owns everything playing, even with some of its layers stopped", () => {
      expect(sceneForPlaying(scenes, ["fire"])).toBe("camp");
      expect(sceneForPlaying(scenes, ["crickets", "fire"])).toBe("camp");
    });

    it("is none when nothing plays", () => {
      expect(sceneForPlaying(scenes, [])).toBeNull();
    });

    it("is none when layers from two scenes play", () => {
      expect(sceneForPlaying(scenes, ["fire", "tavern"])).toBeNull();
    });

    it("ignores General layers, which play alongside any scene", () => {
      expect(sceneForPlaying(scenes, ["fire", "rain"])).toBe("camp");
      expect(sceneForPlaying(scenes, ["rain"])).toBeNull();
    });
  });

  describe("remembering which layers are on", () => {
    it("plays every layer of a scene that hasn't had one turned off", () => {
      expect(layersOn(scenes[0])).toEqual([{ id: "fire" }, { id: "crickets" }]);
    });

    it("turning a layer off is remembered by its scene, and recalling it leaves that layer off", () => {
      const next = remember(scenes, "crickets", false);
      expect(next[0].layers).toEqual([{ id: "fire" }, { id: "crickets", off: true }]);
      expect(layersOn(next[0])).toEqual([{ id: "fire" }]);
      expect(recallPlan(layersOn(next[0]), sceneLayers(next, ["crickets", "tavern"]), volumes)).toEqual({ start: ["fire"], stop: ["crickets", "tavern"], levels: [] });
    });

    it("turning it back on forgets the off", () => {
      expect(remember(remember(scenes, "crickets", false), "crickets", true)[0].layers).toEqual([{ id: "fire" }, { id: "crickets" }]);
    });

    it("changes nothing for a General layer", () => {
      expect(remember(scenes, "rain", false)).toBe(scenes);
    });
  });

  describe("sceneLayers", () => {
    it("keeps only layers some scene owns, so recalling a scene leaves General layers playing", () => {
      expect(sceneLayers(scenes, ["rain", "fire", "tavern", "thunder"])).toEqual(["fire", "tavern"]);
    });
  });

  describe("adoptPlan", () => {
    it("moves unsorted layers in and copies another scene's", () => {
      expect(adoptPlan("camp", scenes, ["rain", "tavern"])).toEqual([{ id: "rain", how: "move" }, { id: "tavern", how: "copy" }]);
    });

    it("skips layers the scene already owns, and repeats", () => {
      expect(adoptPlan("camp", scenes, ["fire", "rain", "rain"])).toEqual([{ id: "rain", how: "move" }]);
    });

    it("copies a General layer that follows a folder, so General keeps it", () => {
      expect(adoptPlan("camp", scenes, ["rain", "storm"], new Set(["storm"]))).toEqual([{ id: "rain", how: "move" }, { id: "storm", how: "copy" }]);
    });
  });

  describe("migrationPlan (scenes saved when layers were shared)", () => {
    const volumes = { fire: 0.5, crickets: 0.5, tavern: 0.5 };

    it("changes nothing for scenes that already own their layers", () => {
      expect(migrationPlan(scenes, volumes)).toEqual({ changed: false, levels: [], copies: [] });
    });

    it("gives the second scene its own copy of a shared layer, at that scene's level", () => {
      const old = [scenes[0], { id: "late", name: "Late", layers: [layer("fire", 0.3), layer("tavern")] }, scenes[1]];
      expect(migrationPlan(old, volumes)).toEqual({
        changed: true,
        levels: [],
        copies: [{ sceneId: "late", layerId: "fire", volume: 0.3 }, { sceneId: "town", layerId: "tavern", volume: undefined }],
      });
    });

    it("moves a saved level onto the layer itself", () => {
      const old = [{ id: "camp", name: "Night Camp", layers: [layer("fire", 0.2), layer("crickets", 0.5)] }];
      expect(migrationPlan(old, volumes)).toEqual({ changed: true, levels: [{ id: "fire", volume: 0.2 }], copies: [] });
    });

    it("drops layers that no longer exist", () => {
      const old = [{ id: "camp", name: "Night Camp", layers: [layer("fire"), layer("gone")] }];
      expect(migrationPlan(old, volumes).changed).toBe(true);
    });
  });
});

describe("normalizeScene", () => {
  it("reads scenes saved before levels existed", () => {
    expect(normalizeScene({ id: "camp", name: "Night Camp", layers: ["fire", "crickets"] }))
      .toEqual({ id: "camp", name: "Night Camp", layers: [{ id: "fire" }, { id: "crickets" }] });
  });
});

describe("nameFor", () => {
  it("names a scene saved from the deck after its layers", () => {
    expect(nameFor(["campfire", "crickets"])).toBe("campfire + crickets");
    expect(nameFor([])).toBe("Quiet");
    expect(nameFor(["a very long layer name", "and another long one"]).length).toBe(32);
  });
});

describe("deck commands", () => {
  it("accepts scene recall, scene stack and layer toggle, and no longer scene save", () => {
    expect(PluginMessageSchema.safeParse({ type: "scene.recall", sceneId: "camp" }).success).toBe(true);
    expect(PluginMessageSchema.safeParse({ type: "scene.stack", sceneId: "camp" }).success).toBe(true);
    expect(PluginMessageSchema.safeParse({ type: "scene.save", sceneId: "camp" }).success).toBe(false);
    expect(PluginMessageSchema.safeParse({ type: "scene.multi", sceneId: "camp" }).success).toBe(false);
    expect(PluginMessageSchema.safeParse({ type: "layer.toggle", soundId: "fire" }).success).toBe(true);
    expect(PluginMessageSchema.safeParse({ type: "scene.recall" }).success).toBe(false);
  });

  it("accepts a Scene Combo with one or more scenes", () => {
    expect(PluginMessageSchema.safeParse({ type: "scene.combo", sceneIds: ["camp", "town"] }).success).toBe(true);
    expect(PluginMessageSchema.safeParse({ type: "scene.combo", sceneIds: ["camp"] }).success).toBe(true);
    expect(PluginMessageSchema.safeParse({ type: "scene.combo", sceneIds: [] }).success).toBe(false);
    expect(PluginMessageSchema.safeParse({ type: "scene.combo", sceneIds: "camp" }).success).toBe(false);
    expect(PluginMessageSchema.safeParse({ type: "scene.combo", sceneIds: [1] }).success).toBe(false);
    expect(PluginMessageSchema.safeParse({ type: "scene.combo" }).success).toBe(false);
  });
});

describe("sceneCandidates", () => {
  const layers = [
    { id: "fire", name: "Campfire", path: "music/amb/campfire.ogg" },
    { id: "crk", name: "Crickets", path: "music/amb/crickets.ogg" },
  ];
  const track = (path: string, name: string, folder: string) => ({ path, name, folder, haystack: `${name} ${folder}`.toLowerCase() });
  const tracks = [
    track("music/amb/campfire.ogg", "Campfire", "amb"),
    track("music/amb/rain.ogg", "Rain", "amb"),
    track("music/town/tavern.ogg", "Tavern", "town"),
  ];

  it("offers only layers not in the scene when the search is empty", () => {
    expect(sceneCandidates(layers, new Set(["fire"]), tracks, "")).toEqual([{ id: "crk", name: "Crickets", where: "Ambient layer" }]);
  });

  it("searches layers first, then Library files that aren't layers yet", () => {
    expect(sceneCandidates(layers, new Set(), tracks, "a").map(c => c.name)).toEqual(["Campfire", "Rain", "Tavern"]);
    expect(sceneCandidates(layers, new Set(), tracks, "rain")).toEqual([{ path: "music/amb/rain.ogg", name: "Rain", where: "amb" }]);
  });

  it("leaves out Library files already added to the editor", () => {
    expect(sceneCandidates(layers, new Set(["music/amb/rain.ogg"]), tracks, "rain")).toEqual([]);
  });

  it("stops at the limit", () => {
    expect(sceneCandidates(layers, new Set(), tracks, "a", 2)).toHaveLength(2);
  });

  describe("cues (T5)", () => {
    const sheets: Record<string, { id: string; name: string }[]> = {
      "music/amb/rain.ogg": [{ id: "soft", name: "Soft" }, { id: "storm", name: "Storm" }],
    };
    const cuesOf = (path: string) => sheets[path] ?? [];

    it("lists a file's cues right after it", () => {
      expect(sceneCandidates(layers, new Set(), tracks, "rain", 8, cuesOf)).toEqual([
        { path: "music/amb/rain.ogg", name: "Rain", where: "amb" },
        { path: "music/amb/rain.ogg", cue: "soft", name: "Rain · Soft", where: "Cue · amb" },
        { path: "music/amb/rain.ogg", cue: "storm", name: "Rain · Storm", where: "Cue · amb" },
      ]);
    });

    it("finds a cue by its own name", () => {
      expect(sceneCandidates(layers, new Set(), tracks, "storm", 8, cuesOf).map(c => c.name)).toEqual(["Rain · Storm"]);
    });

    it("leaves out cues already in the scene or already a layer, but keeps the whole file", () => {
      const withLayer = [...layers, { id: "r", name: "Rain · Soft", path: "music/amb/rain.ogg", cue: "soft" }];
      expect(sceneCandidates(withLayer, new Set(["r", soundKey("music/amb/rain.ogg", "storm")]), tracks, "rain", 8, cuesOf).map(c => c.name))
        .toEqual(["Rain"]);
    });
  });
});

describe("levels as Foundry stores them", () => {
  it("rounds to Foundry's 0.01 step", () => {
    expect(roundLevel(0.2529822)).toBe(0.25);
  });

  it("a scene saved with an unrounded level doesn't re-send it when the layer already holds the rounded one", () => {
    expect(recallPlan([{ id: "a", volume: 0.2529822 }], ["a"], { a: 0.25 }).levels).toEqual([]);
    expect(recallPlan([{ id: "a", volume: 0.3 }], ["a"], { a: 0.25 }).levels).toEqual([{ id: "a", volume: 0.3 }]);
  });
});
