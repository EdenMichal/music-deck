import { describe, expect, it } from "vitest";
import { curveToGain } from "../src/levels";

describe("curveToGain", () => {
  it("turns an old dial position into the gain it played at, so the mix sounds the same after the switch", () => {
    expect(curveToGain(1)).toBe(1);
    expect(curveToGain(0)).toBe(0);
    expect(curveToGain(0.8)).toBeCloseTo(0.716, 3);
    expect(curveToGain(0.7)).toBeCloseTo(0.586, 3);
  });
});
