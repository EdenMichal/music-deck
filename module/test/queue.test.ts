import { describe, expect, it } from "vitest";
import { SORT_STEP, afterEnd, insert, move, rewindUpdates, sortUpdates } from "../src/queue";

describe("move", () => {
  it("moves an item down the queue", () => {
    expect(move(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item up the queue", () => {
    expect(move(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("clamps out-of-range targets and leaves the input untouched", () => {
    const ids = ["a", "b", "c"];
    expect(move(ids, 0, 99)).toEqual(["b", "c", "a"]);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("insert", () => {
  it("inserts at an index", () => {
    expect(insert(["a", "b"], "x", 0)).toEqual(["x", "a", "b"]);
    expect(insert(["a", "b"], "x", 1)).toEqual(["a", "x", "b"]);
  });

  it("appends by default", () => {
    expect(insert(["a", "b"], "x")).toEqual(["a", "b", "x"]);
  });
});

describe("sortUpdates", () => {
  it("assigns evenly spaced sort values in queue order", () => {
    expect(sortUpdates(["b", "a"])).toEqual([{ _id: "b", sort: SORT_STEP }, { _id: "a", sort: 2 * SORT_STEP }]);
  });
});

describe("afterEnd", () => {
  const order = ["a", "b", "c"];

  it("plays the next track", () => {
    expect(afterEnd(order, "a", "loop")).toBe("b");
    expect(afterEnd(order, "b", "stop")).toBe("c");
  });

  it("wraps to the start when looping", () => {
    expect(afterEnd(order, "c", "loop")).toBe("a");
  });

  it("stops after the last track when set to stop", () => {
    expect(afterEnd(order, "c", "stop")).toBeNull();
  });

  it("starts from the top if the track isn't in the queue", () => {
    expect(afterEnd(order, "zzz", "stop")).toBe("a");
    expect(afterEnd([], "zzz", "loop")).toBeNull();
  });
});

describe("rewindUpdates", () => {
  it("stops the playing track and clears paused positions, so the deck reads as cued", () => {
    expect(rewindUpdates([
      { id: "a", playing: true, pausedTime: null },
      { id: "b", playing: false, pausedTime: 6.7 },
      { id: "c", playing: false, pausedTime: null },
      { id: "d", playing: false },
    ])).toEqual([
      { _id: "a", playing: false, pausedTime: null },
      { _id: "b", playing: false, pausedTime: null },
    ]);
  });

  it("clears a track paused at the very start", () => {
    expect(rewindUpdates([{ id: "a", playing: false, pausedTime: 0 }])).toEqual([{ _id: "a", playing: false, pausedTime: null }]);
  });

  it("has nothing to do on a deck that's already cued", () => {
    expect(rewindUpdates([{ id: "a", playing: false, pausedTime: null }])).toEqual([]);
  });
});
