import { describe, expect, it } from "vitest";
import type { Cue } from "../src/cues";
import {
  CUE_COLORS, MAX_CUES, addCue, colorOf, computePeaks, cueOnPad, dropCue, formatCueTime, freePad, nearestZeroCrossing,
  parseCueTime, peakRange, setEdge, snapToBeat,
} from "../src/ui/editor-model";

const cue = (c: Partial<Cue> & Pick<Cue, "id" | "start">): Cue => ({ name: c.id, end: null, mode: "loop", ...c });

describe("times", () => {
  it("formats minutes, seconds and milliseconds", () => {
    expect(formatCueTime(105.02)).toBe("1:45.020");
    expect(formatCueTime(0)).toBe("0:00.000");
    expect(formatCueTime(3723.5)).toBe("62:03.500");
    expect(formatCueTime(null)).toBe("end");
  });

  it("parses what people type", () => {
    expect(parseCueTime("1:45.02")).toBeCloseTo(105.02);
    expect(parseCueTime("1:45")).toBe(105);
    expect(parseCueTime("105.5")).toBe(105.5);
    expect(parseCueTime("1:02:03,5")).toBeCloseTo(3723.5);
    expect(parseCueTime("end")).toBeNull();
    expect(parseCueTime("")).toBeNull();
    expect(parseCueTime("1:75")).toBeUndefined();
    expect(parseCueTime("abc")).toBeUndefined();
  });
});

describe("pads and new cues", () => {
  const cues = [cue({ id: "a", start: 10, end: 20, pad: 1 }), cue({ id: "b", start: 30, pad: 3 })];

  it("drops a cue on an unused pad, ending where the next cue starts", () => {
    const r = dropCue(cues, 2, 22, 60)!;
    expect(r.cue).toMatchObject({ pad: 2, start: 22, end: 30, name: "Cue 2", mode: "loop" });
    expect(r.cues.map(c => c.pad)).toEqual([1, 2, 3]);
  });

  it("ends the cue before it, if that one still ran to the end of the file", () => {
    const first = dropCue([], 1, 2, 60)!;
    expect(first.cue.end).toBeNull();
    const second = dropCue(first.cues, 2, 5, 60)!;
    expect(second.cues.map(c => [c.pad, c.start, c.end])).toEqual([[1, 2, 5], [2, 5, null]]);
    // A cue with its own end is left alone (it may be a sting inside a longer part).
    expect(dropCue(cues, 4, 15, 60)!.cues.find(c => c.id === "a")!.end).toBe(20);
  });

  it("ends at the end of the file when nothing follows, and refuses a taken pad or no room", () => {
    expect(dropCue(cues, 4, 40, 60)!.cue.end).toBeNull();
    expect(dropCue(cues, 1, 40, 60)).toBeNull();
    expect(dropCue(cues, 4, 59.95, 60)).toBeNull();
  });

  it("adds from a selection on the first free pad, and stops at the maximum", () => {
    const r = addCue(cues, 40, 50, 60)!;
    expect(r.cue.pad).toBe(2);
    expect(addCue(cues, 40, 60, 60)!.cue.end).toBeNull();
    const full = Array.from({ length: MAX_CUES }, (_, i) => cue({ id: `c${i}`, start: i }));
    expect(addCue(full, 40, 50, 60)).toBeNull();
  });

  it("gives cues past pad 8 no pad", () => {
    const eight = Array.from({ length: 8 }, (_, i) => cue({ id: `c${i}`, start: i, pad: i + 1 }));
    expect(freePad(eight)).toBeUndefined();
    expect(addCue(eight, 40, 50, 60)!.cue.pad).toBeUndefined();
    expect(cueOnPad(eight, 3)?.id).toBe("c2");
  });
});

describe("setEdge", () => {
  const c = cue({ id: "a", start: 10, end: 20 });
  it("keeps the cue at least 0.1 s long and inside the file", () => {
    expect(setEdge(c, "start", 25, 60).start).toBeCloseTo(19.9);
    expect(setEdge(c, "end", 5, 60).end).toBeCloseTo(10.1);
    expect(setEdge(c, "start", -3, 60).start).toBe(0);
  });
  it("turns an end at the end of the file into 'end of file'", () => {
    expect(setEdge(c, "end", 60, 60).end).toBeNull();
    expect(setEdge(c, "end", null, 60).end).toBeNull();
  });
});

describe("snapping", () => {
  it("snaps to the nearest beat", () => {
    expect(snapToBeat(1.02, 120)).toBe(1);
    expect(snapToBeat(1.3, 120, 0.1)).toBeCloseTo(1.1);
    expect(snapToBeat(1.3, 0)).toBe(1.3);
  });

  it("finds the nearest zero crossing in the window, or leaves the time alone", () => {
    const sr = 1000;
    const data = Float32Array.from({ length: 100 }, (_, i) => (i < 52 ? 1 : -1));
    expect(nearestZeroCrossing(data, sr, 0.05, 0.005)).toBeCloseTo(0.052);
    expect(nearestZeroCrossing(new Float32Array(100).fill(1), sr, 0.05)).toBe(0.05);
  });
});

describe("peaks", () => {
  it("keeps the min and max of every bucket across channels", () => {
    const l = Float32Array.from([0.1, -0.5, 0.2, 0.9]);
    const r = Float32Array.from([-0.7, 0.3, 0, 0]);
    const p = computePeaks([l, r], 2);
    expect(Array.from(p)).toEqual([expect.closeTo(-0.7), expect.closeTo(0.3), 0, expect.closeTo(0.9)]);
    expect(peakRange(p, 0, 2)).toEqual([expect.closeTo(-0.7), expect.closeTo(0.9)]);
  });
});

describe("colours", () => {
  it("follows the pad number, so pad 3 is always the same colour", () => {
    expect(colorOf(cue({ id: "a", start: 0, pad: 3 }), 0)).toBe(CUE_COLORS[2]);
    expect(colorOf(cue({ id: "a", start: 0, color: "#123456" }), 0)).toBe("#123456");
  });
});
