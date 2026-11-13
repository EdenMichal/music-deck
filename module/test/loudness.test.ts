import { describe, expect, it } from "vitest";
import { TARGET_LUFS, matchGain, measure, measureStretches } from "../src/loudness";

const SR = 48000;
const sine = (amplitude: number, seconds = 5, hz = 997) =>
  Float32Array.from({ length: SR * seconds }, (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / SR));

describe("measure (BS.1770)", () => {
  it("reads a full-scale 997 Hz sine on both channels as 0 LUFS, and on one as -3", () => {
    const tone = sine(1);
    expect(measure([[tone, tone]], SR).lufs).toBeCloseTo(0, 1);
    expect(measure([[tone, new Float32Array(tone.length)]], SR).lufs).toBeCloseTo(-3.01, 1);
  });

  it("follows the level: half the amplitude is 6 dB quieter", () => {
    const loud = measure([[sine(1), sine(1)]], SR).lufs;
    const half = measure([[sine(0.5), sine(0.5)]], SR).lufs;
    expect(loud - half).toBeCloseTo(6.02, 1);
  });

  it("pools stretches and reads the sample peak", () => {
    const m = measure([[sine(0.5), sine(0.5)], [sine(0.5), sine(0.5)]], SR);
    expect(m.lufs).toBeCloseTo(-6.02, 1);
    expect(m.peak).toBeCloseTo(-6.02, 1);
  });

  it("calls silence -Infinity", () => {
    const quiet = new Float32Array(SR * 2);
    expect(measure([[quiet, quiet]], SR).lufs).toBe(-Infinity);
  });
});

describe("matchGain", () => {
  const db = (g: number) => 20 * Math.log10(g);

  it("brings a loud file down to the target", () => {
    expect(db(matchGain({ lufs: -14, peak: -0.1 }))).toBeCloseTo(TARGET_LUFS + 14);
  });

  it("raises a quiet file to the target when its peaks allow", () => {
    expect(db(matchGain({ lufs: -41.7, peak: -32.3 }))).toBeCloseTo(21.7);
  });

  it("stops raising at -1 dBFS peaks", () => {
    expect(db(matchGain({ lufs: -25.3, peak: 0 }))).toBeCloseTo(0);
    expect(db(matchGain({ lufs: -41.6, peak: -16.9 }))).toBeCloseTo(15.9);
  });

  it("never raises more than 24 dB, and leaves silence and unmeasured files alone", () => {
    expect(db(matchGain({ lufs: -60, peak: -50 }))).toBeCloseTo(24);
    expect(matchGain({ lufs: -Infinity, peak: -Infinity })).toBe(1);
    expect(matchGain(undefined)).toBe(1);
  });
});

describe("measureStretches", () => {
  it("measures a short file whole", () => expect(measureStretches(95)).toEqual([[0, 95]]));

  it("samples four stretches through a long one", () => {
    const parts = measureStretches(3600);
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual([435, 465]);
    expect(parts[3]).toEqual([3135, 3165]);
  });

  it("measures nothing for an unknown duration", () => expect(measureStretches(NaN)).toEqual([]));
});
