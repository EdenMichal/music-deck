/**
 * Decoded stretches ("clips") of a long file with cues, so its cues play from memory like a short file's do:
 * sample-exact loops and switches, no streaming (audio-regions.ts has the why). Each clip covers one or more
 * cues plus room for their seams and ring-outs, and knows the file time it starts at.
 */
import { indexAudio, planRegions, sliceFor, wavRange } from "./audio-regions";
import { cueEnd, type CueSheet } from "./cues";
import { fileUrl } from "./ui/peaks";

export interface Clip {
  buffer: AudioBuffer;
  /** File time of the buffer's first sample. */
  offset: number;
}

/** Room around each cue: the longest loop seam (2 s) before it, the longest ring-out (4 s) plus a seam after it. */
const BEFORE_S = 2.1;
const AFTER_S = 6.1;
/** Clip sets kept, most recent last (each new set of cues for a file makes a new one). */
const KEEP = 4;

const cache = new Map<string, Promise<Clip[] | null>>();

/**
 * The clips for a sheet's cues, decoded on `ctx` (shared by every sound of the same file and cues). Null when the
 * file's format can't be cut (it then streams). Rejects only if the file can't be fetched.
 */
export function clipsFor(path: string, sheet: CueSheet, ctx: BaseAudioContext): Promise<Clip[] | null> {
  const duration = sheet.duration;
  const regions = planRegions(sheet.cues.map(c => ({ start: c.start, end: cueEnd(c, duration) })), duration, BEFORE_S, AFTER_S);
  const key = `${path}|${regions.map(([a, z]) => `${a.toFixed(3)}-${z.toFixed(3)}`).join(",")}`;
  let p = cache.get(key);
  if (p) { cache.delete(key); cache.set(key, p); return p; }
  p = load(path, regions, ctx);
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value!);
  return p;
}

async function load(path: string, regions: [number, number][], ctx: BaseAudioContext): Promise<Clip[] | null> {
  if (!regions.length) return null;
  const res = await fetch(fileUrl(path));
  if (!res.ok) throw new Error(`${path}: error ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const index = indexAudio(bytes);
  if (!index) return null;
  const clips: Clip[] = [];
  for (const [from, to] of regions) {
    if (index.kind === "wav") {
      const channels = wavRange(bytes, index, from, to);
      const buffer = new AudioBuffer({ length: Math.max(1, channels[0].length), numberOfChannels: index.channels, sampleRate: index.sampleRate });
      channels.forEach((ch, c) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, c));
      clips.push({ buffer, offset: Math.floor(from * index.sampleRate) / index.sampleRate });
      continue;
    }
    const { bytes: slice, startTime } = sliceFor(bytes, index, from, to);
    const decoded = await ctx.decodeAudioData(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer);
    // Keep [from, to): drop the warm-up frames in front, and anything past the end.
    const sr = decoded.sampleRate;
    const a = Math.max(0, Math.round((from - startTime) * sr));
    const n = Math.max(1, Math.min(decoded.length - a, Math.round((to - from) * sr)));
    const buffer = new AudioBuffer({ length: n, numberOfChannels: decoded.numberOfChannels, sampleRate: sr });
    for (let c = 0; c < decoded.numberOfChannels; c++) buffer.copyToChannel(decoded.getChannelData(c).subarray(a, a + n) as Float32Array<ArrayBuffer>, c);
    clips.push({ buffer, offset: startTime + a / sr });
  }
  return clips;
}

/** The clip holding [from, to) of the file, if any. */
export function clipCovering(clips: readonly Clip[] | null | undefined, from: number, to: number): Clip | undefined {
  return clips?.find(c => c.offset <= from + 1e-6 && c.offset + c.buffer.duration >= to - 1e-6);
}
