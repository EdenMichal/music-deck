/**
 * Long files with cues (over CUE_BUFFER_MAX_S) are too big to decode whole, and streaming them makes every switch
 * depend on a second player fetching audio in time (the gap you heard). Instead we decode only the stretches the
 * cues use: read the file's own frame index, cut out the encoded frames for each stretch (plus a few warm-up
 * frames before it), and decode just those. The decoded audio lines up with a whole-file decode to the sample
 * (checked against ffmpeg and in the browser), so cues sit exactly where the editor put them.
 *
 * Pure parsing and planning, no DOM: M4A/MP4 AAC (plain and fragmented, e.g. YouTube downloads, even when the
 * file is named .mp3), MP3 (MPEG-1/2/2.5 Layer III) and WAV (PCM, float). Anything else keeps streaming.
 */

export interface EncodedFrame {
  /** Byte offset and size of one encoded frame. */
  offset: number;
  size: number;
}

export type AudioIndex =
  | {
    kind: "aac";
    sampleRate: number;
    channels: number;
    /** AAC object type (2 = LC) and the ADTS sampling-frequency index, for the ADTS headers we add. */
    objectType: number;
    sfIndex: number;
    samplesPerFrame: number;
    frames: EncodedFrame[];
  }
  | {
    kind: "mp3";
    sampleRate: number;
    channels: number;
    samplesPerFrame: number;
    frames: EncodedFrame[];
    /** The Xing/Info header frame, if any: prepended to every slice so the decoder trims the start as it does for the whole file. */
    header: EncodedFrame | null;
  }
  | {
    kind: "wav";
    sampleRate: number;
    channels: number;
    /** 1 = PCM integer, 3 = IEEE float. */
    format: number;
    bitsPerSample: number;
    dataOffset: number;
    dataSize: number;
  };

/** Frames decoded before a stretch and thrown away, so the decoder's overlap and bit reservoir are warm. */
export const WARMUP_FRAMES = 8;

const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const tag = (b: Uint8Array, i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/** Read a file's frame index, or null for a format we don't cut (it keeps streaming). */
export function indexAudio(b: Uint8Array): AudioIndex | null {
  if (b.length < 12) return null;
  if (tag(b, 4) === "ftyp") return indexMp4(b);
  if (tag(b, 0) === "RIFF" && tag(b, 8) === "WAVE") return indexWav(b);
  return indexMp3(b);
}

// ── MP4 / M4A ────────────────────────────────────────────────────────────────

interface Box { type: string; start: number; body: number; end: number }

function* boxes(b: Uint8Array, start: number, end: number): Generator<Box> {
  let i = start;
  while (i + 8 <= end) {
    let size = u32(b, i);
    let body = i + 8;
    if (size === 1) { size = u32(b, i + 8) * 2 ** 32 + u32(b, i + 12); body = i + 16; }
    else if (size === 0) size = end - i;
    if (size < 8 || i + size > end) return;
    yield { type: tag(b, i + 4), start: i, body, end: i + size };
    i += size;
  }
}

const child = (b: Uint8Array, box: Box | undefined, type: string, skip = 0): Box | undefined => {
  if (!box) return undefined;
  for (const c of boxes(b, box.body + skip, box.end)) if (c.type === type) return c;
  return undefined;
};

function indexMp4(b: Uint8Array): AudioIndex | null {
  const top = [...boxes(b, 0, b.length)];
  const moov = top.find(x => x.type === "moov");
  if (!moov) return null;
  // The first sound track.
  const trak = [...boxes(b, moov.body, moov.end)].find(t => {
    if (t.type !== "trak") return false;
    const hdlr = child(b, child(b, t, "mdia"), "hdlr");
    return !!hdlr && tag(b, hdlr.body + 8) === "soun";
  });
  if (!trak) return null;
  const tkhd = child(b, trak, "tkhd");
  const trackId = tkhd ? u32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12)) : 1;
  const stbl = child(b, child(b, child(b, trak, "mdia"), "minf"), "stbl");
  const stsd = child(b, stbl, "stsd");
  if (!stbl || !stsd) return null;
  // stsd: version/flags + entry count, then the sample entry (8-byte box header + 28 bytes of audio fields).
  const entry = stsd.body + 8;
  if (tag(b, entry + 4) !== "mp4a") return null;
  const channels = u16(b, entry + 8 + 16);
  const esds = child(b, { type: "mp4a", start: entry, body: entry + 8 + 28, end: entry + u32(b, entry) }, "esds");
  const asc = esds ? audioSpecificConfig(b, esds.body + 4, esds.end) : null;
  if (!asc) return null;
  const sampleRate = SAMPLE_RATES[asc.sfIndex] ?? u32(b, entry + 8 + 24) >>> 16;

  let frames = sampleTable(b, stbl);
  if (!frames.length) frames = fragments(b, top, moov, trackId);
  if (!frames.length) return null;
  return { kind: "aac", sampleRate, channels: asc.channels || channels, objectType: asc.objectType, sfIndex: asc.sfIndex, samplesPerFrame: 1024, frames };
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** The AudioSpecificConfig inside an esds box's descriptors (ES → DecoderConfig → DecoderSpecificInfo). */
function audioSpecificConfig(b: Uint8Array, start: number, end: number): { objectType: number; sfIndex: number; channels: number } | null {
  const desc = (p: number) => {
    const t = b[p++];
    let len = 0;
    for (let k = 0; k < 4; k++) { const x = b[p++]; len = (len << 7) | (x & 0x7f); if (!(x & 0x80)) break; }
    return { t, p, len };
  };
  let d = desc(start);
  if (d.t !== 0x03) return null;
  let p = d.p + 2;
  const flags = b[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + b[p];
  if (flags & 0x20) p += 2;
  d = desc(p);
  if (d.t !== 0x04) return null;
  d = desc(d.p + 13);
  if (d.t !== 0x05 || d.p + 2 > end) return null;
  const objectType = b[d.p] >> 3;
  const sfIndex = ((b[d.p] & 7) << 1) | (b[d.p + 1] >> 7);
  const channels = (b[d.p + 1] >> 3) & 0xf;
  return { objectType, sfIndex, channels };
}

/** A plain MP4's sample table (stsz, stsc, stco/co64). */
function sampleTable(b: Uint8Array, stbl: Box): EncodedFrame[] {
  const stsz = child(b, stbl, "stsz"), stsc = child(b, stbl, "stsc");
  const stco = child(b, stbl, "stco") ?? child(b, stbl, "co64");
  if (!stsz || !stsc || !stco) return [];
  const fixed = u32(b, stsz.body + 4), count = u32(b, stsz.body + 8);
  if (!count) return [];
  const size = (i: number) => (fixed || u32(b, stsz.body + 12 + 4 * i));
  const wide = stco.type === "co64";
  const chunks = u32(b, stco.body + 4);
  const chunkAt = (i: number) => (wide ? u32(b, stco.body + 8 + 8 * i) * 2 ** 32 + u32(b, stco.body + 12 + 8 * i) : u32(b, stco.body + 8 + 4 * i));
  const runs = u32(b, stsc.body + 4);
  const run = (k: number) => ({ first: u32(b, stsc.body + 8 + 12 * k), perChunk: u32(b, stsc.body + 12 + 12 * k) });
  const frames: EncodedFrame[] = [];
  let s = 0;
  for (let k = 0; k < runs && s < count; k++) {
    const { first, perChunk } = run(k);
    const last = k + 1 < runs ? run(k + 1).first - 1 : chunks;
    for (let c = first; c <= last && s < count; c++) {
      let off = chunkAt(c - 1);
      for (let n = 0; n < perChunk && s < count; n++, s++) { const z = size(s); frames.push({ offset: off, size: z }); off += z; }
    }
  }
  return frames;
}

/** A fragmented MP4's samples: every moof's traf runs, in file order. */
function fragments(b: Uint8Array, top: Box[], moov: Box, trackId: number): EncodedFrame[] {
  const trex = [...boxes(b, child(b, moov, "mvex")?.body ?? 0, child(b, moov, "mvex")?.end ?? 0)]
    .find(x => x.type === "trex" && u32(b, x.body + 4) === trackId);
  const trexSize = trex ? u32(b, trex.body + 16) : 0;
  const frames: EncodedFrame[] = [];
  for (const moof of top) {
    if (moof.type !== "moof") continue;
    for (const traf of boxes(b, moof.body, moof.end)) {
      if (traf.type !== "traf") continue;
      let base = moof.start, defSize = trexSize, id = trackId;
      for (const x of boxes(b, traf.body, traf.end)) {
        if (x.type === "tfhd") {
          const fl = u32(b, x.body) & 0xffffff;
          let p = x.body + 4;
          id = u32(b, p); p += 4;
          if (fl & 0x1) { base = u32(b, p) * 2 ** 32 + u32(b, p + 4); p += 8; }
          if (fl & 0x2) p += 4;
          if (fl & 0x8) p += 4;
          if (fl & 0x10) { defSize = u32(b, p); p += 4; }
        } else if (x.type === "trun" && id === trackId) {
          const fl = u32(b, x.body) & 0xffffff;
          const n = u32(b, x.body + 4);
          let p = x.body + 8;
          let off = base;
          if (fl & 0x1) { off = base + (u32(b, p) | 0); p += 4; }
          if (fl & 0x4) p += 4;
          for (let i = 0; i < n; i++) {
            if (fl & 0x100) p += 4;
            let z = defSize;
            if (fl & 0x200) { z = u32(b, p); p += 4; }
            if (fl & 0x400) p += 4;
            if (fl & 0x800) p += 4;
            frames.push({ offset: off, size: z });
            off += z;
          }
        }
      }
    }
  }
  return frames;
}

/** Wrap raw AAC frames in ADTS headers: a stream the browser's decoder reads directly. */
export function adts(b: Uint8Array, frames: EncodedFrame[], objectType: number, sfIndex: number, channels: number): Uint8Array {
  const total = frames.reduce((n, f) => n + f.size + 7, 0);
  const out = new Uint8Array(total);
  const profile = Math.max(0, Math.min(3, objectType - 1));
  let p = 0;
  for (const f of frames) {
    const len = f.size + 7;
    out[p] = 0xff; out[p + 1] = 0xf1;
    out[p + 2] = (profile << 6) | (sfIndex << 2) | ((channels >> 2) & 1);
    out[p + 3] = ((channels & 3) << 6) | ((len >> 11) & 3);
    out[p + 4] = (len >> 3) & 0xff;
    out[p + 5] = ((len & 7) << 5) | 0x1f;
    out[p + 6] = 0xfc;
    out.set(b.subarray(f.offset, f.offset + f.size), p + 7);
    p += len;
  }
  return out;
}

// ── MP3 ──────────────────────────────────────────────────────────────────────

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Header(b: Uint8Array, i: number): { size: number; sampleRate: number; channels: number; samples: number } | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
  if (version === 1 || layer !== 1) return null; // Layer III only
  const br = (b[i + 2] >> 4) & 0xf, sr = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (br === 0 || br === 15 || sr === 3) return null;
  const v1 = version === 3;
  const kbps = (v1 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[br];
  const sampleRate = MP3_RATES[version][sr];
  const samples = v1 ? 1152 : 576;
  const size = Math.floor(((samples / 8) * kbps * 1000) / sampleRate) + pad;
  const channels = ((b[i + 3] >> 6) & 3) === 3 ? 1 : 2;
  return { size, sampleRate, channels, samples };
}

function indexMp3(b: Uint8Array): AudioIndex | null {
  let i = 0;
  if (tag(b, 0).startsWith("ID3")) {
    i = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
    if (b[5] & 0x10) i += 10;
  }
  // Find the first of three headers in a row (a lone 0xFFE match can be data).
  let first: ReturnType<typeof mp3Header> = null;
  for (let tries = 0; i < b.length - 4 && tries < 65536; i++, tries++) {
    const h = mp3Header(b, i);
    if (!h) continue;
    const h2 = mp3Header(b, i + h.size);
    if (h2 && mp3Header(b, i + h.size + h2.size)) { first = h; break; }
  }
  if (!first) return null;
  const frames: EncodedFrame[] = [];
  let header: EncodedFrame | null = null;
  while (i < b.length) {
    const h = mp3Header(b, i);
    if (!h || h.sampleRate !== first.sampleRate) break;
    const frame = { offset: i, size: Math.min(h.size, b.length - i) };
    // A Xing/Info frame carries no audio; the decoder uses it to trim the encoder's delay and padding.
    const probe = tag(b, i + 36) + tag(b, i + 21) + tag(b, i + 13);
    if (!frames.length && !header && /Xing|Info/.test(probe)) header = frame;
    else frames.push(frame);
    i += h.size;
  }
  if (frames.length < 2) return null;
  return { kind: "mp3", sampleRate: first.sampleRate, channels: first.channels, samplesPerFrame: first.samples, frames, header };
}

// ── WAV ──────────────────────────────────────────────────────────────────────

function indexWav(b: Uint8Array): AudioIndex | null {
  let p = 12, fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (p + 8 <= b.length) {
    const id = tag(b, p), size = le32(b, p + 4);
    if (id === "fmt ") {
      let format = le16(b, p + 8);
      if (format === 0xfffe && size >= 40) format = le16(b, p + 8 + 24);
      fmt = { format, channels: le16(b, p + 10), sampleRate: le32(b, p + 12), bits: le16(b, p + 22) };
    } else if (id === "data" && fmt) {
      if (!((fmt.format === 1 && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && fmt.bits === 32))) return null;
      return { kind: "wav", sampleRate: fmt.sampleRate, channels: fmt.channels, format: fmt.format, bitsPerSample: fmt.bits, dataOffset: p + 8, dataSize: Math.min(size, b.length - p - 8) };
    }
    p += 8 + size + (size & 1);
  }
  return null;
}

/** WAV samples [from, to) (seconds) as one Float32Array per channel. */
export function wavRange(b: Uint8Array, w: Extract<AudioIndex, { kind: "wav" }>, from: number, to: number): Float32Array[] {
  const bytes = w.bitsPerSample / 8, frame = bytes * w.channels;
  const total = Math.floor(w.dataSize / frame);
  const a = Math.max(0, Math.floor(from * w.sampleRate)), z = Math.min(total, Math.ceil(to * w.sampleRate));
  const out = Array.from({ length: w.channels }, () => new Float32Array(Math.max(0, z - a)));
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let s = a; s < z; s++) {
    for (let c = 0; c < w.channels; c++) {
      const i = w.dataOffset + s * frame + c * bytes;
      let v: number;
      if (w.format === 3) v = view.getFloat32(i, true);
      else if (bytes === 1) v = (b[i] - 128) / 128;
      else if (bytes === 2) v = view.getInt16(i, true) / 32768;
      else if (bytes === 3) v = (((b[i + 2] << 24) | (b[i + 1] << 16) | (b[i] << 8)) >> 8) / 8388608;
      else v = view.getInt32(i, true) / 2147483648;
      out[c][s - a] = v;
    }
  }
  return out;
}

// ── Planning ─────────────────────────────────────────────────────────────────

/**
 * The stretches to decode for a sheet's cues: each cue widened by `before` and `after` seconds (room for loop
 * seams and ring-outs), clamped to the file, and merged where they touch or nearly do.
 */
export function planRegions(cues: readonly { start: number; end: number }[], duration: number, before: number, after: number): [number, number][] {
  const spans = cues
    .map(c => [Math.max(0, c.start - before), Math.min(duration, c.end + after)] as [number, number])
    .filter(([a, z]) => z > a)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/**
 * The encoded slice to decode for [from, to): frames from WARMUP_FRAMES before the stretch to a couple after it,
 * and the file time of the first sample the decoder will output.
 */
export function sliceFor(b: Uint8Array, index: Exclude<AudioIndex, { kind: "wav" }>, from: number, to: number): { bytes: Uint8Array; startTime: number } {
  const spf = index.samplesPerFrame, sr = index.sampleRate;
  const j0 = Math.max(0, Math.floor((from * sr) / spf) - WARMUP_FRAMES);
  const j1 = Math.min(index.frames.length, Math.ceil((to * sr) / spf) + 2);
  const frames = index.frames.slice(j0, j1);
  const startTime = (j0 * spf) / sr;
  if (index.kind === "aac") return { bytes: adts(b, frames, index.objectType, index.sfIndex, index.channels), startTime };
  const parts = index.header ? [index.header, ...frames] : frames;
  const bytes = new Uint8Array(parts.reduce((n, f) => n + f.size, 0));
  let p = 0;
  for (const f of parts) { bytes.set(b.subarray(f.offset, f.offset + f.size), p); p += f.size; }
  return { bytes, startTime };
}
