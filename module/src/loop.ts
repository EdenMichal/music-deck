/**
 * Seamless ambient loops. Foundry loops a layer by jumping from the file's last sample back to its first,
 * which clicks or cuts unless the file was made to loop. Instead, each client plays a copy of the file whose
 * last few seconds fade into its first few (an equal-power crossfade), looping from just after that head.
 * The wrap point then lands on the very sample that follows the blended tail, so nothing jumps.
 *
 * Only files Foundry holds in memory (under 10 minutes) can be blended; longer ones loop as Foundry does.
 * The audio file itself is never changed.
 */

/** Seconds of crossfade at the loop point, capped at a quarter of the file. */
export const LOOP_CROSSFADE_S = 3;
const MIN_FADE_SAMPLES = 64;

export interface SeamlessLoop {
  /** One array per channel. */
  channels: Float32Array<ArrayBuffer>[];
  /** Loop region, in samples: play [loopStart, length) forever. */
  loopStart: number;
}

/**
 * Blend the tail of `channels` into its head over `fadeSamples` (capped at a quarter of the length).
 * Returns null when the file is too short to blend.
 */
export function crossfadeLoop(channels: readonly Float32Array[], fadeSamples: number): SeamlessLoop | null {
  const length = channels[0]?.length ?? 0;
  const n = Math.min(Math.round(fadeSamples), Math.floor(length / 4));
  if (n < MIN_FADE_SAMPLES) return null;
  const tail = length - n;
  return {
    loopStart: n,
    channels: channels.map(src => {
      const out = new Float32Array(src);
      for (let i = 0; i < n; i++) {
        const p = ((i + 1) / n) * (Math.PI / 2);
        out[tail + i] = src[tail + i] * Math.cos(p) + src[i] * Math.sin(p);
      }
      return out;
    }),
  };
}

const blended = new WeakMap<AudioBuffer, { buffer: AudioBuffer; loopStart: number } | null>();
/** Our blended copies, so a sound replaying one can find its original again. */
const originalOf = new WeakMap<AudioBuffer, AudioBuffer>();

function seamlessBuffer(original: AudioBuffer) {
  if (!blended.has(original)) {
    const sr = original.sampleRate;
    const src = Array.from({ length: original.numberOfChannels }, (_, c) => original.getChannelData(c));
    const loop = crossfadeLoop(src, LOOP_CROSSFADE_S * sr);
    let result = null;
    if (loop) {
      const buffer = new AudioBuffer({ length: original.length, numberOfChannels: original.numberOfChannels, sampleRate: sr });
      loop.channels.forEach((data, c) => buffer.copyToChannel(data, c));
      result = { buffer, loopStart: loop.loopStart / sr };
      originalOf.set(buffer, original);
    }
    blended.set(original, result);
  }
  return blended.get(original)!;
}

/** Make an ambient layer's Foundry Sound loop seamlessly. Call right after Foundry creates it. */
export function makeSeamless(sound: any): void {
  const play = sound.play.bind(sound);
  sound.play = (options: any = {}) => {
    // Foundry fills `buffer` from its cache when the sound loads; it's null for a streamed (long) file.
    const original: AudioBuffer | null = sound.buffer ? originalOf.get(sound.buffer) ?? sound.buffer : null;
    const loop = options.loop ?? sound.loop;
    const seamless = original && loop ? seamlessBuffer(original) : null;
    if (original) {
      sound.buffer = seamless?.buffer ?? original;
      options = seamless
        ? { ...options, loopStart: seamless.loopStart, loopEnd: original.duration }
        : { ...options, loopStart: 0, loopEnd: original.duration };
    }
    return play(options);
  };
}

/**
 * A looping copy of one cue range [a, b) (samples) with an `n`-sample seam that keeps the loop exactly b − a long,
 * so a music loop stays in time. Three ways, best first:
 * - "ring": the copy runs n past the cue's end. There the music that follows the cue fades out while the cue's
 *   head comes back in, and the loop wraps to n. The audio up to the cue's end is untouched.
 * - "pre": no room after the end. The cue's last n samples blend into the n samples before its start, so the
 *   wrap continues the music that leads into the head. The tail differs from the file (`seam`).
 * - "shrink": no room either side (a whole-file loop): the tail blends into the head and the loop is n shorter.
 * `headIn` is how many samples the head takes to come in under a "ring" seam (short, so its downbeat lands).
 * Returns null when the cue is too short for a seam; the caller loops the plain range.
 */
export interface CueLoopCopy {
  channels: Float32Array<ArrayBuffer>[];
  /** Copy-relative loop region, in samples. */
  loopStart: number;
  loopEnd: number;
  /** Samples before the cue's end where the copy differs from the file (a switch plays the real audio there). */
  seam: number;
  /** Samples by which each loop is shorter than the cue ("shrink" only). */
  shrink: number;
  method: "ring" | "pre" | "shrink";
}

export function cueLoopCopy(src: readonly Float32Array[], a: number, b: number, n: number, headIn = n): CueLoopCopy | null {
  const total = src[0]?.length ?? 0;
  const period = b - a;
  n = Math.min(Math.round(n), Math.floor(period / 4));
  if (n < MIN_FADE_SAMPLES || period <= 0) return null;
  const k = Math.max(1, Math.min(n, Math.round(headIn)));
  if (b + n <= total) {
    return {
      method: "ring", loopStart: n, loopEnd: period + n, seam: 0, shrink: 0,
      channels: src.map(ch => {
        const out = new Float32Array(ch.subarray(a, b + n));
        for (let i = 0; i < n; i++) {
          const down = Math.cos(((i + 1) / n) * (Math.PI / 2));
          const up = i < k ? Math.sin(((i + 1) / k) * (Math.PI / 2)) : 1;
          out[period + i] = ch[b + i] * down + ch[a + i] * up;
        }
        return out;
      }),
    };
  }
  if (a >= n) {
    return {
      method: "pre", loopStart: 0, loopEnd: period, seam: n, shrink: 0,
      channels: src.map(ch => {
        const out = new Float32Array(ch.subarray(a, b));
        for (let i = 0; i < n; i++) {
          const p = ((i + 1) / n) * (Math.PI / 2);
          out[period - n + i] = ch[b - n + i] * Math.cos(p) + ch[a - n + i] * Math.sin(p);
        }
        return out;
      }),
    };
  }
  const loop = crossfadeLoop(src.map(ch => ch.subarray(a, b)), n);
  return loop && { method: "shrink", channels: loop.channels, loopStart: loop.loopStart, loopEnd: period, seam: loop.loopStart, shrink: loop.loopStart };
}

/** Seamless copies of one cue range, per original buffer: key "start:end:seam:headIn" (seconds). */
const rangeCopies = new WeakMap<AudioBuffer, Map<string, SeamlessRange | null>>();

export interface SeamlessRange {
  buffer: AudioBuffer;
  /** Copy-relative loop region, seconds. */
  loopStart: number;
  loopEnd: number;
  /** Seconds before the cue's end where the copy differs from the file. */
  seam: number;
  /** Seconds each loop is shorter than the cue. */
  shrink: number;
}

/** A cached looping copy of [startS, endS) of `original` (see cueLoopCopy), or null when too short to blend. */
export function seamlessRange(original: AudioBuffer, startS: number, endS: number, seamS: number, headInS = 0.06): SeamlessRange | null {
  let byKey = rangeCopies.get(original);
  if (!byKey) rangeCopies.set(original, (byKey = new Map()));
  const key = `${startS}:${endS}:${seamS}:${headInS}`;
  if (!byKey.has(key)) {
    const sr = original.sampleRate;
    const a = Math.max(0, Math.round(startS * sr)), b = Math.min(original.length, Math.round(endS * sr));
    const src = Array.from({ length: original.numberOfChannels }, (_, c) => original.getChannelData(c));
    const copy = b > a ? cueLoopCopy(src, a, b, seamS * sr, headInS * sr) : null;
    let result: SeamlessRange | null = null;
    if (copy) {
      const buffer = new AudioBuffer({ length: copy.channels[0].length, numberOfChannels: original.numberOfChannels, sampleRate: sr });
      copy.channels.forEach((data, c) => buffer.copyToChannel(data, c));
      result = { buffer, loopStart: copy.loopStart / sr, loopEnd: copy.loopEnd / sr, seam: copy.seam / sr, shrink: copy.shrink / sr };
    }
    byKey.set(key, result);
  }
  return byKey.get(key)!;
}
