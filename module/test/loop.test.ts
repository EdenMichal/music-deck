import { describe, expect, it } from "vitest";
import { crossfadeLoop, cueLoopCopy } from "../src/loop";

const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i);

describe("crossfadeLoop", () => {
  it("loops from just after the blended head, and the tail ends on the head's last sample", () => {
    const src = ramp(1000);
    const loop = crossfadeLoop([src], 100)!;
    expect(loop.loopStart).toBe(100);
    const out = loop.channels[0];
    // Before the tail nothing changes.
    expect(out[899]).toBe(899);
    // The tail starts as the original tail and ends exactly on the head, so wrapping to sample 100 is smooth.
    expect(out[900]).toBeCloseTo(900, -1);
    expect(out[999]).toBeCloseTo(99);
    // The original isn't touched.
    expect(src[999]).toBe(999);
  });

  it("is equal-power: a constant signal keeps its level through the blend's middle", () => {
    const loop = crossfadeLoop([new Float32Array(1000).fill(1)], 100)!;
    expect(loop.channels[0][950]).toBeCloseTo(Math.SQRT2, 1);
  });

  it("caps the fade at a quarter of the file and skips files too short to blend", () => {
    expect(crossfadeLoop([ramp(1000)], 5000)!.loopStart).toBe(250);
    expect(crossfadeLoop([ramp(100)], 50)).toBeNull();
  });

  it("blends every channel", () => {
    expect(crossfadeLoop([ramp(1000), ramp(1000)], 100)!.channels).toHaveLength(2);
  });
});

describe("cueLoopCopy", () => {
  const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i);
  // A "file" where every sample is its own index, so we can see where each copy sample came from.
  const file = ramp(10_000);

  it("rings out the music after the cue and keeps the loop exactly as long as the cue", () => {
    const c = cueLoopCopy([file], 2000, 4000, 200, 50)!;
    expect(c.method).toBe("ring");
    expect(c.loopEnd - c.loopStart).toBe(2000);
    expect(c.seam).toBe(0);
    // Up to the cue's end the copy is the file, untouched.
    expect(c.channels[0][0]).toBe(2000);
    expect(c.channels[0][1999]).toBe(3999);
    // Past the end: the head is fully in after `headIn`, the music after the end fades out across the seam.
    expect(c.channels[0][2000 + 60]).toBeCloseTo(2060 + 4060 * Math.cos((61 / 200) * Math.PI / 2), 3);
    // The wrap lands on the head's next sample: copy[loopEnd - 1] carries head 199, copy[loopStart] is head 200.
    expect(c.channels[0][c.loopEnd - 1]).toBeCloseTo(2199, 3);
    expect(c.channels[0][c.loopStart]).toBe(2200);
  });

  it("blends the tail into what leads up to the start when the cue ends at the end of the file", () => {
    const c = cueLoopCopy([file], 6000, 10_000, 200)!;
    expect(c.method).toBe("pre");
    expect([c.loopStart, c.loopEnd, c.seam]).toEqual([0, 4000, 200]);
    // The last sample before the wrap is (almost) the sample just before the start, so the wrap continues it.
    expect(c.channels[0][3999]).toBeCloseTo(5999, 3);
  });

  it("falls back to a slightly shorter loop for a whole-file loop, and refuses tiny cues", () => {
    const c = cueLoopCopy([file], 0, 10_000, 200)!;
    expect(c.method).toBe("shrink");
    expect(c.loopEnd - c.loopStart).toBe(9800);
    expect(cueLoopCopy([file], 100, 300, 200)).toBeNull();
  });
});
