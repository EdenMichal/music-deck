/**
 * Loudness matching in Foundry (v2.35, maths in loudness.ts). The active GM's browser measures every file the
 * Music Deck playlists use, once, and keeps the results in a world setting; every client turns them into a gain
 * on that sound (live-gain.ts), so 70% of a quiet recording is as loud as 70% of a loud one.
 *
 * Long files aren't decoded whole: four 30-second stretches are cut out of them (audio-regions.ts) and measured.
 */
import { indexAudio, sliceFor, wavRange, type AudioIndex } from "./audio-regions";
import { channelOf, MODULE_ID, refreshGains, setMatchGain } from "./live-gain";
import { matchGain, measure, measureStretches, type Loudness } from "./loudness";
import { fileUrl } from "./ui/peaks";

const STORE = "loudness";
const ENABLED = "matchLoudness";
/** Decode rate for measuring; any rate works, the filters are designed per rate. */
const MEASURE_RATE = 48000;
/** A file we can't cut into stretches is decoded whole only up to this size. */
const WHOLE_MAX_BYTES = 40 * 1024 * 1024;
/** Fade to a file's matched level when its measurement arrives (time constant, s). */
const MATCH_RAMP = 0.3;

/** Stored per path. JSON can't hold -Infinity, so silence or an unreadable file comes back as null. */
type Stored = Record<string, { lufs: number | null; peak: number | null }>;

const stored = (): Stored => (game.settings.get(MODULE_ID, STORE) as Stored) ?? {};
const enabled = (): boolean => !!game.settings.get(MODULE_ID, ENABLED);

export function registerMatchSettings(): void {
  game.settings.register(MODULE_ID, STORE, { scope: "world", config: false, type: Object, default: {}, onChange: () => refreshGains(MATCH_RAMP) });
  game.settings.register(MODULE_ID, ENABLED, {
    name: "Match loudness",
    hint: "Measure every track, layer and SFX once and play each at the same loudness, so 70% of a quiet recording is as loud as 70% of a loud one. Off plays files as they were recorded.",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => refreshGains(MATCH_RAMP),
  });
}

/** The gain that matches a file's loudness: 1 while it's not measured yet, or with matching off. */
export function matchGainFor(path: string | undefined): number {
  if (!path || !enabled()) return 1;
  const m = stored()[path];
  return m ? matchGain({ lufs: m.lufs ?? NaN, peak: m.peak ?? NaN }) : 1;
}

/* -------------------------------------------- */
/*  Measuring (active GM)                       */
/* -------------------------------------------- */

const queue: string[] = [];
let running = false;

/** Measure a path later, unless it's measured or waiting already. */
function want(path: string | undefined): void {
  if (!path || path in stored() || queue.includes(path)) return;
  queue.push(path);
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const path = queue.shift()!;
      if (path in stored()) continue;
      let m: Loudness | null = null;
      try { m = await measureFile(path); } catch (err) { console.warn(`Music Deck | couldn't measure ${path}`, err); }
      const fin = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
      await game.settings.set(MODULE_ID, STORE, { ...stored(), [path]: { lufs: fin(m?.lufs), peak: fin(m?.peak) } });
    }
  } finally {
    running = false;
  }
}

const durationOf = (index: AudioIndex): number =>
  index.kind === "wav"
    ? index.dataSize / (index.channels * (index.bitsPerSample / 8)) / index.sampleRate
    : (index.frames.length * index.samplesPerFrame) / index.sampleRate;

/** A mono file plays on both speakers, so it's measured as two equal channels, as it's heard. */
const asHeard = (channels: Float32Array[]): Float32Array[] => (channels.length === 1 ? [channels[0], channels[0]] : channels);

const channelsOf = (b: AudioBuffer, from = 0, length = b.length): Float32Array[] =>
  Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).subarray(from, from + length));

/** Fetch and measure one file. Null when its format can't be cut and it's too big to decode whole. */
async function measureFile(path: string): Promise<Loudness | null> {
  const res = await fetch(fileUrl(path));
  if (!res.ok) throw new Error(`error ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ctx = new OfflineAudioContext(2, 1, MEASURE_RATE);
  const decode = (b: Uint8Array) => ctx.decodeAudioData(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  const index = indexAudio(bytes);
  if (!index) {
    if (bytes.length > WHOLE_MAX_BYTES) return null;
    const whole = await decode(bytes);
    return measure([asHeard(channelsOf(whole))], whole.sampleRate);
  }
  const stretches = measureStretches(durationOf(index));
  if (index.kind === "wav") return measure(stretches.map(([a, z]) => asHeard(wavRange(bytes, index, a, z))), index.sampleRate);
  const parts: Float32Array[][] = [];
  for (const [from, to] of stretches) {
    const { bytes: slice, startTime } = sliceFor(bytes, index, from, to);
    const decoded = await decode(slice);
    // Drop the warm-up frames in front, as the cue clips do.
    const a = Math.max(0, Math.round((from - startTime) * decoded.sampleRate));
    const n = Math.max(0, Math.min(decoded.length - a, Math.round((to - from) * decoded.sampleRate)));
    parts.push(asHeard(channelsOf(decoded, a, n)));
  }
  return measure(parts, MEASURE_RATE);
}

/** Measure these files ahead of use, e.g. every sound a random SFX pad can pick. Active GM only. */
export function measureLater(paths: readonly string[]): void {
  if (game.users.activeGM?.isSelf) for (const path of paths) want(path);
}

/** Every client: use the stored measurements. The active GM also measures what's missing, now and as sounds arrive. */
export function startMatching(): void {
  setMatchGain(matchGainFor);
  refreshGains(MATCH_RAMP);
  if (!game.users.activeGM?.isSelf) return;
  for (const p of game.playlists) if (channelOf(p)) for (const s of p.sounds) want(s.path);
  const watch = (sound: any) => { if (channelOf(sound.parent)) want(sound.path); };
  Hooks.on("createPlaylistSound", watch);
  Hooks.on("updatePlaylistSound", (sound: any, change: any) => { if ("path" in (change ?? {})) watch(sound); });
}
