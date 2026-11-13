/**
 * Loudness matching (v2.35): every file is measured once (ITU-R BS.1770 / EBU R128 integrated loudness, in LUFS)
 * and played back at a gain that brings it to the same target, so two sounds at the same % are equally loud.
 * Recordings differ a lot: in this world's Ambience folder, from -20 LUFS (Medieval City) to -42 (Forest Night).
 *
 * Pure maths, no Foundry or DOM, so it can be unit-tested and checked against ffmpeg's ebur128 filter.
 */

/** What we keep per file. */
export interface Loudness {
  /** Integrated loudness, LUFS. -Infinity for silence. */
  lufs: number;
  /** Sample peak, dBFS. */
  peak: number;
}

/** Where every file is brought to. Quiet enough that most music only comes down a little. */
export const TARGET_LUFS = -20;
/** Headroom kept under full scale when a quiet file is raised. */
const PEAK_CEILING_DB = -1;
/** The most a file is raised, so a near-silent recording doesn't become all hiss. */
const MAX_BOOST_DB = 24;

const BLOCK_S = 0.4;
const STEP_S = 0.1;
const ABSOLUTE_GATE = -70;
const RELATIVE_GATE = -10;

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** The two K-weighting stages for a sample rate: BS.1770's filters, redesigned per rate as libebur128 does. */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: high shelf, about +4 dB above 1.5 kHz (the head's acoustic effect).
  let K = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  let Q = 0.7071752369554196;
  const Vh = 10 ** (3.999843853973347 / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: high pass at about 38 Hz (RLB weighting).
  K = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, highpass];
}

function filter(x: Float32Array, f: Biquad): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const out = f.b0 * v + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = out;
    y[i] = out;
  }
  return y;
}

/**
 * The mean square of every 400 ms block (75% overlap) of K-weighted audio, summed over the channels (front
 * channels weigh 1). One stretch of a file; blocks from several stretches can be pooled before gating.
 */
export function blockPowers(channels: readonly Float32Array[], sampleRate: number): number[] {
  const [shelf, highpass] = kWeighting(sampleRate);
  const weighted = channels.map(ch => filter(filter(ch, shelf), highpass));
  const block = Math.round(BLOCK_S * sampleRate);
  const step = Math.round(STEP_S * sampleRate);
  const length = channels[0]?.length ?? 0;
  if (length < block) return [];
  // Running sums of squares make each block O(1).
  const sums = weighted.map(ch => {
    const s = new Float64Array(ch.length + 1);
    for (let i = 0; i < ch.length; i++) s[i + 1] = s[i] + ch[i] * ch[i];
    return s;
  });
  const powers: number[] = [];
  for (let start = 0; start + block <= length; start += step) {
    let z = 0;
    for (const s of sums) z += (s[start + block] - s[start]) / block;
    powers.push(z);
  }
  return powers;
}

const lufsOf = (power: number) => -0.691 + 10 * Math.log10(power);

/** Gated integrated loudness of pooled block powers (BS.1770-4 §2.8). -Infinity when it's all silence. */
export function integratedLoudness(powers: readonly number[]): number {
  const loud = powers.filter(z => lufsOf(z) > ABSOLUTE_GATE);
  if (!loud.length) return -Infinity;
  const relative = lufsOf(loud.reduce((a, z) => a + z, 0) / loud.length) + RELATIVE_GATE;
  const gated = loud.filter(z => lufsOf(z) > relative);
  return lufsOf(gated.reduce((a, z) => a + z, 0) / gated.length);
}

/** Sample peak in dBFS. */
export function peakDb(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Measure stretches of one file (or the whole of it as one stretch). */
export function measure(stretches: readonly (readonly Float32Array[])[], sampleRate: number): Loudness {
  const powers = stretches.flatMap(chs => blockPowers(chs, sampleRate));
  const peak = Math.max(-Infinity, ...stretches.map(peakDb));
  return { lufs: integratedLoudness(powers), peak };
}

/**
 * The gain that brings a file to `target`: down for a loud file, up for a quiet one, but never so far up that
 * its peaks pass -1 dBFS, nor more than +24 dB. 1 for silence or a file not measured yet.
 */
export function matchGain(m: Loudness | undefined, target = TARGET_LUFS): number {
  if (!m || !Number.isFinite(m.lufs)) return 1;
  let db = target - m.lufs;
  if (db > 0) {
    if (Number.isFinite(m.peak)) db = Math.min(db, PEAK_CEILING_DB - m.peak);
    db = Math.max(0, Math.min(db, MAX_BOOST_DB));
  }
  return 10 ** (db / 20);
}

/**
 * Which stretches of a file to measure: all of a short one; four 30-second stretches spread through a long one,
 * so an hour-long ambience isn't decoded whole.
 */
export function measureStretches(duration: number, stretch = 30, count = 4): [number, number][] {
  if (!(duration > 0)) return [];
  if (duration <= stretch * count) return [[0, duration]];
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const centre = (duration * (i + 0.5)) / count;
    const from = Math.max(0, Math.min(duration - stretch, centre - stretch / 2));
    out.push([from, from + stretch]);
  }
  return out;
}
