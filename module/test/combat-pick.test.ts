import { describe, expect, it } from "vitest";
import { battleOrder, pickNext, recovery, toResume } from "../src/combat-pick";

describe("pickNext", () => {
  it("picks at random, never the same one twice in a row", () => {
    expect(pickNext(["a", "b"], "a", () => 0)).toBe("b");
    expect(pickNext(["a", "b", "c"], "b", () => 0.99)).toBe("c");
  });
  it("repeats only when there's one track, and gives nothing for none", () => {
    expect(pickNext(["a"], "a")).toBe("a");
    expect(pickNext([], undefined)).toBeUndefined();
  });
});

describe("battleOrder", () => {
  it("puts every track on the Battle deck once, starting somewhere other than last time", () => {
    const order = battleOrder(["a", "b", "c", "d"], "a", 100, () => 0);
    expect(order[0]).not.toBe("a");
    expect([...order].sort()).toEqual(["a", "b", "c", "d"]);
  });
  it("caps the queue, and gives nothing for no tracks", () => {
    expect(battleOrder(["a", "b", "c"], undefined, 2)).toHaveLength(2);
    expect(battleOrder([], undefined)).toEqual([]);
    expect(battleOrder(["a"], "a")).toEqual(["a"]);
  });
});

describe("toResume", () => {
  const held = [{ deck: "A" as const, sound: "a1" }, { deck: "B" as const, sound: "b1" }];
  it("resumes every paused deck the fader still has on air", () => {
    expect(toResume(held, 0.5)).toEqual(held);
    expect(toResume([held[0]], 0)).toEqual([held[0]]);
  });
  it("leaves a deck paused once the fader has moved off it during the battle, so it isn't playing unheard", () => {
    expect(toResume([held[0]], 1)).toEqual([]);
    expect(toResume(held, 0)).toEqual([held[0]]);
  });
});

describe("recovery", () => {
  it("blends back from a combat's battle once its combat is over", () => {
    expect(recovery({ combat: true }, false, 1)).toBe("back");
    expect(recovery({ combat: true }, false, 0.4)).toBe("back");
  });
  it("finishes a blend in that a reload cut short", () => {
    expect(recovery({ combat: true }, true, 0.4)).toBe("in");
    expect(recovery({}, false, 0)).toBe("in");
  });
  it("fades out a blend left on with no battle, and otherwise leaves things be", () => {
    expect(recovery(null, false, 0.6)).toBe("out");
    expect(recovery(null, true, 0)).toBeNull();
    expect(recovery({ combat: true }, true, 1)).toBeNull();
    expect(recovery({}, false, 1)).toBeNull();
  });
});
