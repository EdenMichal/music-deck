/**
 * Track editor audio: fetch a file with progress, decode it at full quality (the preview and zero-crossing snap
 * need real samples), and keep its waveform peaks in IndexedDB on this browser so a second open draws at once.
 */
import { computePeaks } from "./editor-model";

/** Samples per peaks bucket: fine enough for close zoom, small enough to store (30 min ≈ 2.6 MB). */
export const SAMPLES_PER_BUCKET = 256;

export interface LoadedTrack {
  buffer: AudioBuffer;
  peaks: Float32Array;
  samplesPerBucket: number;
}

export interface CachedPeaks {
  peaks: Float32Array;
  samplesPerBucket: number;
  sampleRate: number;
  duration: number;
}

const DB = "music-deck-peaks";
const STORE = "peaks";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise(resolve => {
    try {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export const cachedPeaks = (path: string) => idb<CachedPeaks>("readonly", s => s.get(path));
const storePeaks = (path: string, p: CachedPeaks) => idb("readwrite", s => s.put(p, path));

const decodeSegment = (s: string): string => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/**
 * A Data path made safe for a URL, whether it arrives plain ("Vibe Music/a.mp3") or already encoded the way
 * Foundry stores sound paths ("Vibe%20Music/a.mp3"). Encoding an encoded path again asks for "Vibe%2520Music",
 * which the server answers with 404.
 */
export const encodePath = (path: string): string => path.split("/").map(s => encodeURIComponent(decodeSegment(s))).join("/");

/** The URL Foundry serves a Data path from (handles a route prefix). */
export function fileUrl(path: string): string {
  if (/^https?:|^blob:|^data:/.test(path)) return path;
  return foundry.utils.getRoute(encodePath(path));
}

/**
 * Fetch and decode `path` into `ctx`'s sample rate. `onProgress(received, total)` follows the download
 * (total is 0 when the server doesn't say). Throws a readable Error on failure; aborts with `signal`.
 */
export async function loadTrack(
  path: string, ctx: BaseAudioContext, onProgress: (received: number, total: number) => void, signal?: AbortSignal,
): Promise<LoadedTrack> {
  let res: Response;
  try {
    res = await fetch(fileUrl(path), { signal });
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    throw new Error(`Couldn't reach ${path}.`);
  }
  if (!res.ok) throw new Error(res.status === 404 ? `${path} isn't there any more.` : `${path} couldn't be read (error ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, total);
    }
  } else {
    chunks.push(new Uint8Array(await res.arrayBuffer()));
  }
  const bytes = new Uint8Array(received || chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(bytes.buffer);
  } catch {
    throw new Error(`${path} isn't an audio file this browser can play.`);
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const peaks = computePeaks(channels, SAMPLES_PER_BUCKET);
  storePeaks(path, { peaks, samplesPerBucket: SAMPLES_PER_BUCKET, sampleRate: buffer.sampleRate, duration: buffer.duration });
  return { buffer, peaks, samplesPerBucket: SAMPLES_PER_BUCKET };
}
