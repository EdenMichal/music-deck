import { describe, expect, it } from "vitest";
import { MixStateSchema } from "@music-deck/shared/protocol";
import { DEFAULT_MIX, layerOwners, revivedSceneVols, sceneGain } from "../src/crossfader";

describe("scene levels", () => {
  it("leaves General layers and untouched scenes at full", () => {
    expect(sceneGain(DEFAULT_MIX, undefined)).toBe(1);
    expect(sceneGain(DEFAULT_MIX, "camp")).toBe(1);
  });

  it("scales a scene's layers by its level, through the volume curve", () => {
    const mix = { ...DEFAULT_MIX, sceneVols: { camp: 0.5 } };
    expect(sceneGain(mix, "camp")).toBe(0.5);
    expect(sceneGain(mix, "camp", v => v * v)).toBe(0.25);
    expect(sceneGain(mix, "town")).toBe(1);
  });

  it("is part of the mix every client receives", () => {
    expect(MixStateSchema.safeParse({ ...DEFAULT_MIX, sceneVols: { camp: 0.4 } }).success).toBe(true);
    expect(MixStateSchema.safeParse({ ...DEFAULT_MIX, sceneVols: { camp: 2 } }).success).toBe(false);
  });
});

describe("layerOwners", () => {
  it("maps each layer to the first scene that lists it, old bare ids included", () => {
    const owners = layerOwners([
      { id: "camp", layers: [{ id: "fire" }, { id: "crickets", off: true }] },
      { id: "old", layers: ["rain", "fire"] },
    ]);
    expect(Object.fromEntries(owners)).toEqual({ fire: "camp", crickets: "camp", rain: "old" });
  });

  it("is empty when there are no scenes", () => {
    expect(layerOwners(undefined).size).toBe(0);
  });
});

describe("revivedSceneVols", () => {
  it("brings a scene turned all the way down back to full", () => {
    expect(revivedSceneVols({ camp: 0, storm: 0.4 }, ["camp"])).toEqual({ camp: 1, storm: 0.4 });
    expect(revivedSceneVols({ camp: 0.001 }, ["camp"])).toEqual({ camp: 1 });
    expect(revivedSceneVols({ camp: NaN }, ["camp"])).toEqual({ camp: 1 });
  });

  it("leaves levels above 0, and scenes never turned down, as they are", () => {
    expect(revivedSceneVols({ camp: 0.2 }, ["camp"])).toBeNull();
    expect(revivedSceneVols({}, ["camp"])).toBeNull();
    expect(revivedSceneVols(undefined, ["camp"])).toBeNull();
    expect(revivedSceneVols({ camp: 0 }, ["storm"])).toBeNull();
  });
});
