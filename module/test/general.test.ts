import { describe, expect, it } from "vitest";
import { syncPlan } from "../src/general";

const track = (path: string, name = path) => ({ path, name });
const layer = (id: string, path: string, synced = true, cue = false) => ({ id, path, synced, cue });

describe("syncPlan (General follows a Library folder)", () => {
  it("adds a layer for each track in the folder that General doesn't have yet", () => {
    expect(syncPlan([track("rain.ogg", "Rain"), track("wind.ogg", "Wind")], [layer("r", "rain.ogg")]))
      .toEqual({ add: [{ path: "wind.ogg", name: "Wind" }], remove: [] });
  });

  it("removes a followed layer whose file left the folder", () => {
    expect(syncPlan([track("rain.ogg")], [layer("r", "rain.ogg"), layer("w", "wind.ogg")])).toEqual({ add: [], remove: ["w"] });
  });

  it("keeps a General layer you added yourself, and doesn't add the same file again", () => {
    expect(syncPlan([track("rain.ogg")], [layer("mine", "rain.ogg", false), layer("x", "other.ogg", false)])).toEqual({ add: [], remove: [] });
  });

  it("ignores cue layers when matching files, and drops a second followed copy of a file", () => {
    expect(syncPlan([track("rain.ogg")], [layer("c", "rain.ogg", false, true), layer("a", "rain.ogg"), layer("b", "rain.ogg")]))
      .toEqual({ add: [], remove: ["b"] });
  });

  it("removes every followed layer when there's no folder", () => {
    expect(syncPlan([], [layer("a", "rain.ogg"), layer("mine", "wind.ogg", false)])).toEqual({ add: [], remove: ["a"] });
  });

  it("lists a file only once even if the folder has it twice", () => {
    expect(syncPlan([track("rain.ogg"), track("rain.ogg")], [])).toEqual({ add: [{ path: "rain.ogg", name: "rain.ogg" }], remove: [] });
  });
});
