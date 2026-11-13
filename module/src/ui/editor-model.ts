/**
 * Track editor: pure helpers.
 * Times, cue edits, pads, snapping and waveform peaks; no DOM, no Foundry, unit-tested.
 */
import { MIN_CUE_S, cueEnd, type Cue } from "../cues";

/** Pads 1–8 match the Stream Deck's "Go to cue" keys. */
export const PAD_COUNT = 8;
export const MAX_CUES = 16;

/** Cue colours: a fixed set, always shown with the cue's number (DESIGN.md "Cue colours", the Letter Rule). */
export const CUE_COLORS = ["#4cc3cf", "#e57ab7", "#b5d16a", "#8e9bf0", "#e6d86e", "#f0a3a3", "#7fd4b8", "#d9c3a5"] as const;

export function colorOf(cue: Cue, index: number): string {
  return cue.color ?? CUE_COLORS[((cue.pad ?? index + 1) - 1 + CUE_COLORS.length) % CUE_COLORS.length];
}

/** "1:45.020"; hours roll into minutes ("72:03.500"). */
export function formatCueTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "end";
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${m}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`;
}

/** Reads "1:45.02", "1:45", "105.5", "105", "1:02:03.5"; "end" or "" means end of file (null). Undefined = not a time. */
export function parseCueTime(text: string): number | null | undefined {
  const t = text.trim().toLowerCase();
  if (t === "" || t === "end") return null;
  if (!/^\d+(:\d{1,2}){0,2}([.,]\d+)?$/.test(t)) return undefined;
  const [whole, frac = ""] = t.replace(",", ".").split(".");
  const parts = whole.split(":").map(Number);
  if (parts.slice(1).some(p => p >= 60)) return undefined;
  const secs = parts.reduce((acc, p) => acc * 60 + p, 0);
  return secs + (frac ? Number(`0.${frac}`) : 0);
}

export function nextId(cues: readonly Cue[]): string {
  let n = cues.length + 1;
  while (cues.some(c => c.id === `cue-${n}`)) n++;
  return `cue-${n}`;
}

export const cueOnPad = (cues: readonly Cue[], pad: number): Cue | undefined => cues.find(c => c.pad === pad);

export function freePad(cues: readonly Cue[]): number | undefined {
  for (let p = 1; p <= PAD_COUNT; p++) if (!cueOnPad(cues, p)) return p;
  return undefined;
}

/** Where a cue that starts at `t` should end by default: the next cue's start, else the end of the file. */
function defaultEnd(cues: readonly Cue[], t: number): number | null {
  const next = cues.map(c => c.start).filter(s => s > t + MIN_CUE_S).sort((a, b) => a - b)[0];
  return next ?? null;
}

/**
 * Listen-and-tap: an unused number drops a new cue starting at `t` on that pad. Returns the new list and the
 * new cue, or null when the pad is taken, the list is full, or `t` leaves no room before the end of the file.
 */
export function dropCue(cues: readonly Cue[], pad: number, t: number, duration: number): { cues: Cue[]; cue: Cue } | null {
  if (cueOnPad(cues, pad) || cues.length >= MAX_CUES) return null;
  const start = clampTime(t, duration);
  if (duration - start < MIN_CUE_S) return null;
  const cue: Cue = { id: nextId(cues), name: `Cue ${pad}`, start, end: defaultEnd(cues, start), mode: "loop", pad };
  // Tapping parts in order: the cue before this one, if it still ran to the end of the file, now ends here.
  const prev = cues.filter(c => c.start < start - MIN_CUE_S).sort((a, b) => b.start - a.start)[0];
  const rest = cues.map(c => (c === prev && c.end === null ? { ...c, end: start } : c));
  return { cues: sortCues([...rest, cue]), cue };
}

/** "Add cue from selection": a new cue on the first free pad (none after 8), named by its number. */
export function addCue(cues: readonly Cue[], start: number, end: number | null, duration: number): { cues: Cue[]; cue: Cue } | null {
  if (cues.length >= MAX_CUES) return null;
  const a = clampTime(start, duration);
  const b = end === null ? null : clampTime(end, duration);
  if ((b ?? duration) - a < MIN_CUE_S) return null;
  const pad = freePad(cues);
  const cue: Cue = { id: nextId(cues), name: pad ? `Cue ${pad}` : `Cue ${cues.length + 1}`, start: a, end: b !== null && duration - b < 0.001 ? null : b, mode: "loop", pad };
  return { cues: sortCues([...cues, cue]), cue };
}

/** Move one edge, keeping the cue at least MIN_CUE_S long and inside the file. */
export function setEdge(cue: Cue, edge: "start" | "end", t: number | null, duration: number): Cue {
  if (edge === "start") {
    const end = cueEnd(cue, duration);
    return { ...cue, start: Math.min(clampTime(t ?? 0, duration), end - MIN_CUE_S) };
  }
  if (t === null || t >= duration - 0.0005) return { ...cue, end: null };
  return { ...cue, end: Math.max(clampTime(t, duration), cue.start + MIN_CUE_S) };
}

export function sortCues(cues: Cue[]): Cue[] {
  return cues.sort((a, b) => a.start - b.start);
}

export function clampTime(t: number, duration: number): number {
  return Math.min(Math.max(0, t), duration);
}

/** The nearest beat to `t` for a BPM and the first beat's time. */
export function snapToBeat(t: number, bpm: number, offset = 0): number {
  if (!(bpm > 0)) return t;
  const beat = 60 / bpm;
  return offset + Math.round((t - offset) / beat) * beat;
}

/**
 * The nearest point within ±`windowS` of `t` where the signal crosses zero (sign change), so a cue edge there
 * doesn't click. Returns `t` unchanged when there is none.
 */
export function nearestZeroCrossing(data: Float32Array, sampleRate: number, t: number, windowS = 0.005): number {
  const i0 = Math.round(t * sampleRate);
  const w = Math.round(windowS * sampleRate);
  for (let d = 0; d <= w; d++) {
    for (const i of d ? [i0 - d, i0 + d] : [i0]) {
      if (i <= 0 || i >= data.length) continue;
      if (data[i - 1] === 0 || data[i] === 0 || (data[i - 1] < 0) !== (data[i] < 0)) return i / sampleRate;
    }
  }
  return t;
}

/** Waveform peaks: [min, max] pairs per bucket of `samplesPerBucket`, across all channels. */
export function computePeaks(channels: readonly Float32Array[], samplesPerBucket: number): Float32Array {
  const length = channels[0]?.length ?? 0;
  const buckets = Math.ceil(length / samplesPerBucket);
  const out = new Float32Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    let lo = 0, hi = 0;
    const end = Math.min(length, (b + 1) * samplesPerBucket);
    for (const ch of channels) {
      for (let i = b * samplesPerBucket; i < end; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}

/** Combine peaks buckets [from, to) into one [min, max]. */
export function peakRange(peaks: Float32Array, from: number, to: number): [number, number] {
  let lo = 0, hi = 0;
  const n = peaks.length / 2;
  for (let b = Math.max(0, Math.floor(from)); b < Math.min(n, Math.ceil(to)); b++) {
    if (peaks[b * 2] < lo) lo = peaks[b * 2];
    if (peaks[b * 2 + 1] > hi) hi = peaks[b * 2 + 1];
  }
  return [lo, hi];
}
