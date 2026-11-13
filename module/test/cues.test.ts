import { describe, expect, it } from "vitest";
import {
  combatPlan, cueEnd, cueLabel, deckCueState, hasRoles, findCue, makeSegment, nextPhaseCue, nextBoundary, normalizePath, repeatEnd, resolveAfter, segmentFileTime,
  stepCue, validateSheet, type Cue, type CueSheet,
} from "../src/cues";

const cue = (c: Partial<Cue> & Pick<Cue, "id" | "start">): Cue => ({ name: c.id, end: null, mode: "loop", ...c });
const boss: CueSheet = {
  path: "music/boss.ogg",
  duration: 252,
  cues: [
    cue({ id: "intro", name: "Intro", start: 0, end: 12.4, mode: "once", after: "next", pad: 1, role: "intro" }),
    cue({ id: "p1", name: "Phase 1", start: 12.4, end: 105, pad: 2 }),
    cue({ id: "p2", name: "Phase 2", start: 105, end: 210, pad: 3 }),
    cue({ id: "win", name: "Victory", start: 210, end: null, mode: "once", pad: 4 }),
  ],
};

describe("normalizePath", () => {
  it("decodes and drops leading slashes", () => {
    expect(normalizePath("/music/Boss%20Theme.ogg")).toBe("music/Boss Theme.ogg");
    expect(normalizePath("music/a.ogg")).toBe("music/a.ogg");
    expect(normalizePath("music/100%.ogg")).toBe("music/100%.ogg");
  });
});

describe("validateSheet", () => {
  it("sorts, clamps to the file, and keeps a null end for end of file", () => {
    const { sheet, problems } = validateSheet({
      path: "/music/x.ogg", duration: 60,
      cues: [cue({ id: "b", start: 30, end: 90 }), cue({ id: "a", start: 0, end: 10 })],
    });
    expect(problems).toEqual([]);
    expect(sheet.path).toBe("music/x.ogg");
    expect(sheet.cues.map(c => c.id)).toEqual(["a", "b"]);
    expect(sheet.cues[1].end).toBeNull();
  });

  it("drops cues that are broken, too short, or past the end, and says why", () => {
    const { sheet, problems } = validateSheet({
      path: "x", duration: 60,
      cues: [cue({ id: "nan", start: NaN }), cue({ id: "tiny", start: 5, end: 5.05 }), cue({ id: "late", start: 70 }), cue({ id: "ok", start: 1, end: 2 })],
    });
    expect(sheet.cues.map(c => c.id)).toEqual(["ok"]);
    expect(problems).toHaveLength(3);
  });

  it("makes ids unique, defaults the mode to loop, and forgets a default cue that no longer exists", () => {
    const { sheet } = validateSheet({
      path: "x", duration: 60, defaultCue: "gone",
      cues: [{ id: "a", name: "A", start: 0, end: 10, mode: "weird" as any }, { id: "a", name: "A2", start: 20, end: 30, mode: "once" }],
    });
    expect(sheet.cues.map(c => c.id)).toEqual(["a", "a-2"]);
    expect(sheet.cues[0].mode).toBe("loop");
    expect(sheet.defaultCue).toBeUndefined();
  });

  it("drops a nonsense repeat count", () => {
    const { sheet } = validateSheet({ path: "x", duration: 60, cues: [cue({ id: "a", start: 0, end: 10, repeat: 0 })] });
    expect(sheet.cues[0].repeat).toBeUndefined();
  });
});

describe("findCue and stepCue", () => {
  it("finds by id, by name in any case, and by pad number", () => {
    expect(findCue(boss, "p2")?.name).toBe("Phase 2");
    expect(findCue(boss, "phase 2")?.id).toBe("p2");
    expect(findCue(boss, 4)?.id).toBe("win");
    expect(findCue(boss, "3")?.id).toBe("p2");
    expect(findCue(boss, "nope")).toBeUndefined();
    expect(findCue(undefined, "p1")).toBeUndefined();
  });

  it("falls back to the cue's position when no cue has that pad", () => {
    const sheet = { ...boss, cues: boss.cues.map(c => ({ ...c, pad: undefined })) };
    expect(findCue(sheet, 2)?.id).toBe("p1");
  });

  it("steps forward and back without wrapping", () => {
    expect(stepCue(boss, "p1", 1)?.id).toBe("p2");
    expect(stepCue(boss, "p1", -1)?.id).toBe("intro");
    expect(stepCue(boss, "win", 1)).toBeUndefined();
    expect(stepCue(boss, undefined, 1)?.id).toBe("intro");
  });
});

describe("resolveAfter", () => {
  it("chains a once-cue to the next one, and stops after the last", () => {
    expect(resolveAfter(boss, boss.cues[0])).toMatchObject({ id: "p1" });
    expect(resolveAfter(boss, boss.cues[3])).toBe("stop");
  });

  it("never ends a loop without a repeat count", () => {
    expect(resolveAfter(boss, boss.cues[1])).toBeNull();
  });

  it("follows a counted loop to a named cue, and treats a missing or self target as stop", () => {
    expect(resolveAfter(boss, cue({ id: "x", start: 0, end: 5, repeat: 2, after: { cue: "Victory" } }))).toMatchObject({ id: "win" });
    expect(resolveAfter(boss, cue({ id: "x", start: 0, end: 5, repeat: 2, after: { cue: "gone" } }))).toBe("stop");
    expect(resolveAfter(boss, cue({ id: "p1", start: 0, end: 5, repeat: 2, after: { cue: "p1" } }))).toBe("stop");
    expect(resolveAfter(boss, cue({ id: "x", start: 0, end: 5, mode: "once", after: "hold" }))).toBe("hold");
  });
});

describe("segments", () => {
  const p1 = boss.cues[1];

  it("reports file time through the first pass and every wrap", () => {
    const s = makeSegment(cue({ id: "a", start: 2, end: 4 }), 60, 10, 2);
    expect(segmentFileTime(s, 10)).toBe(2);
    expect(segmentFileTime(s, 11.5)).toBe(3.5);
    expect(segmentFileTime(s, 12.5)).toBeCloseTo(2.5);
    expect(segmentFileTime(s, 9)).toBe(2);
  });

  it("keeps each loop exactly as long as the cue, whatever the seam", () => {
    const s = makeSegment(cue({ id: "a", start: 2, end: 4 }), 60, 0, 2, 0.5);
    expect([s.loopStart, s.seam]).toEqual([2, 0.5]);
    expect(segmentFileTime(s, 2.25)).toBeCloseTo(2.25);
  });

  it("caps the seam at a quarter of the cue and never blends a once-cue", () => {
    expect(makeSegment(cue({ id: "a", start: 0, end: 4 }), 60, 0, 0, 3).seam).toBe(1);
    expect(makeSegment(cue({ id: "a", start: 0, end: 4, mode: "once" }), 60, 0, 0, 3).seam).toBe(0);
  });

  it("resumes mid-cue, and clamps a resume point outside the cue into it", () => {
    expect(makeSegment(p1, 252, 0, 50).fileAt).toBe(50);
    expect(makeSegment(p1, 252, 0, 3).fileAt).toBe(12.4);
    expect(makeSegment(p1, 252, 0, 400).fileAt).toBeLessThan(105);
  });

  it("stops a once-cue at its end", () => {
    const s = makeSegment(boss.cues[3], 252, 100, 210);
    expect(s.end).toBe(252);
    expect(segmentFileTime(s, 200)).toBe(252);
  });

  it("finds the next wrap at least the lead time ahead", () => {
    const s = makeSegment(cue({ id: "a", start: 2, end: 4 }), 60, 10, 3);
    expect(nextBoundary(s, 10.2)).toBe(11);
    expect(nextBoundary(s, 10.98)).toBe(13);
    expect(nextBoundary(s, 14.5)).toBe(15);
    const once = makeSegment(cue({ id: "o", start: 2, end: 4, mode: "once" }), 60, 10, 2);
    expect(nextBoundary(once, 11)).toBe(12);
  });

  it("knows when a counted loop has played its last time", () => {
    const s = makeSegment(cue({ id: "a", start: 2, end: 4 }), 60, 10, 2);
    expect(repeatEnd(s, 1)).toBe(12);
    expect(repeatEnd(s, 3)).toBe(16);
  });

  it("measures a cue's end against the file", () => {
    expect(cueEnd(boss.cues[3], 252)).toBe(252);
    expect(cueEnd(cue({ id: "a", start: 0, end: 300 }), 252)).toBe(252);
  });
});

describe("cueLabel", () => {
  it("names a track by its cue", () => {
    expect(cueLabel("Boss Theme", boss.cues[2])).toBe("Boss Theme · Phase 2");
    expect(cueLabel("Boss Theme", undefined)).toBe("Boss Theme");
  });
});

describe("nextPhaseCue and deckCueState (protocol 5)", () => {
  const boss: CueSheet = {
    path: "music/boss.ogg", duration: 200,
    cues: [
      { id: "i", name: "Intro", start: 0, end: 10, mode: "once", role: "intro", after: "next" },
      { id: "p1", name: "Phase 1", start: 10, end: 60, mode: "loop", role: "battle", pad: 2 },
      { id: "s", name: "Sting", start: 60, end: 62, mode: "once" },
      { id: "p2", name: "Phase 2", start: 62, end: 120, mode: "loop", role: "battle" },
      { id: "v", name: "Victory", start: 120, end: null, mode: "once", role: "victory" },
    ],
  };

  it("goes to the next battle cue, skipping the rest, and stops at the last", () => {
    expect(nextPhaseCue(boss, "i")?.id).toBe("p1");
    expect(nextPhaseCue(boss, "p1")?.id).toBe("p2");
    expect(nextPhaseCue(boss, "p2")).toBeUndefined();
    expect(nextPhaseCue(boss, undefined)?.id).toBe("p1");
  });

  it("uses the next loop on a track without roles", () => {
    const plain = { ...boss, cues: boss.cues.map(({ role, ...c }) => c) };
    expect(nextPhaseCue(plain, "p1")?.id).toBe("p2");
    expect(nextPhaseCue(plain, "i")?.id).toBe("p1");
  });

  it("lists the cues, the current one, and a switch that's still waiting", () => {
    const st = deckCueState(boss, boss.cues[1], { id: "p2", when: "loopEnd" })!;
    expect(st.cues[1]).toEqual({ id: "p1", name: "Phase 1", mode: "loop", pad: 2, role: "battle" });
    expect(st.cues[2]).toEqual({ id: "s", name: "Sting", mode: "once" });
    expect(st.current).toBe("p1");
    expect(st.pending).toEqual({ id: "p2", when: "loopEnd" });
    expect(deckCueState(boss, boss.cues[3], { id: "p2", when: "loopEnd" })!.pending).toBeNull();
    expect(deckCueState(undefined, null, null)).toBeNull();
  });
});

describe("combat roles (T5)", () => {
  const roles: CueSheet = {
    path: "music/boss2.ogg",
    duration: 120,
    cues: [
      cue({ id: "i", name: "Intro", start: 0, end: 8, mode: "once", role: "intro" }),
      cue({ id: "calm", name: "Calm", start: 8, end: 20 }),
      cue({ id: "b1", name: "Battle 1", start: 20, end: 50, role: "battle" }),
      cue({ id: "b2", name: "Battle 2", start: 50, end: 90, role: "battle" }),
      cue({ id: "v", name: "Victory", start: 90, end: null, mode: "once", role: "victory", after: "hold" }),
    ],
  };

  it("starts on the intro, chains it into the first battle loop, and ends victory with a stop", () => {
    const plan = combatPlan(roles)!;
    expect(plan.start.id).toBe("i");
    expect(plan.chain).toEqual({ i: "b1", v: "stop" });
    expect(plan.victory?.id).toBe("v");
  });

  it("starts on the first battle cue when there's no intro", () => {
    const plan = combatPlan({ ...roles, cues: roles.cues.filter(c => c.id !== "i") })!;
    expect(plan.start.id).toBe("b1");
    expect(plan.chain).toEqual({ v: "stop" });
  });

  it("leaves a track without roles alone", () => {
    expect(hasRoles(boss)).toBe(true);
    const plain = { ...roles, cues: roles.cues.map(({ role, ...c }) => c) };
    expect(hasRoles(plain)).toBe(false);
    expect(combatPlan(plain)).toBeNull();
    expect(combatPlan(undefined)).toBeNull();
  });

  it("a chain wins over the cue's own after", () => {
    const intro = roles.cues[0];
    expect(resolveAfter(roles, intro)).toBe("stop");
    expect((resolveAfter(roles, intro, { i: "b1" }) as Cue).id).toBe("b1");
    expect(resolveAfter(roles, roles.cues[4])).toBe("hold");
    expect(resolveAfter(roles, roles.cues[4], { v: "stop" })).toBe("stop");
  });

  it("a chain to a cue doesn't end a loop that runs forever, but a chain to stop does", () => {
    expect(resolveAfter(roles, roles.cues[2], { b1: "b2" })).toBeNull();
    expect(resolveAfter(roles, roles.cues[2], { b1: "stop" })).toBe("stop");
  });

  it("ignores a chain to a cue that's gone, or to itself", () => {
    expect(resolveAfter(roles, roles.cues[0], { i: "nope" })).toBe("stop");
    expect(resolveAfter(roles, roles.cues[0], { i: "i" })).toBe("stop");
  });
});
