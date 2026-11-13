/**
 * The music library: every audio file under Data/music/, indexed once and cached in the GM's browser.
 * Durations load lazily for the rows on screen. The 🎧 preview plays on this client only.
 */
import { trackName } from "./channels";

export const LIBRARY_ROOT = "music";
const INDEX_KEY = "music-deck.library";
/** Fired after a rescan of Data/music/, so the deck link can send the new track list. */
export const LIBRARY_HOOK = "musicDeck.library";
const DURATIONS_KEY = "music-deck.durations";
const MAX_DEPTH = 8;
const MAX_FILES = 10_000;

export interface LibraryTrack {
  path: string;
  name: string;
  /** First folder under the library root ("" for loose files): the folder chips. */
  folder: string;
  /** Lower-cased name and folders, for search. */
  haystack: string;
}

export function folderOf(path: string, root = LIBRARY_ROOT): string {
  const rest = path.slice(root.length + 1).split("/");
  return rest.length > 1 ? decodeURIComponent(rest[0]) : "";
}

export function toTrack(path: string, root = LIBRARY_ROOT): LibraryTrack {
  const name = trackName(path);
  const dirs = decodeURIComponent(path.slice(root.length + 1)).split("/").slice(0, -1).join(" ");
  return { path, name, folder: folderOf(path, root), haystack: `${name} ${dirs}`.toLowerCase() };
}

export function foldersIn(tracks: readonly LibraryTrack[]): string[] {
  return [...new Set(tracks.map(t => t.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function searchTracks(tracks: readonly LibraryTrack[], query: string, folder = ""): LibraryTrack[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tracks
    .filter(t => (!folder || t.folder === folder) && words.every(w => t.haystack.includes(w)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------- */
/*  Index (Foundry + browser storage)           */
/* -------------------------------------------- */

let index: { scannedAt: number; tracks: LibraryTrack[] } | undefined;

function readStore<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writeStore(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the index still works for this session.
  }
}

export function libraryTracks(): LibraryTrack[] {
  index ??= readStore(INDEX_KEY);
  return index?.tracks ?? [];
}

export function libraryScannedAt(): number | undefined {
  libraryTracks();
  return index?.scannedAt;
}

/** Walk Data/music/ and rebuild the index. Creates the folder if it doesn't exist yet. */
export async function scanLibrary(): Promise<LibraryTrack[]> {
  const FP = foundry.applications.apps.FilePicker.implementation;
  const audio = new Set(Object.keys(CONST.AUDIO_FILE_EXTENSIONS).map(e => `.${e}`));
  const paths: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || paths.length >= MAX_FILES) return;
    const result = await FP.browse("data", dir);
    for (const file of result.files) {
      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      if (audio.has(ext)) paths.push(file);
    }
    for (const sub of result.dirs) await walk(sub, depth + 1);
  };
  try {
    await walk(LIBRARY_ROOT, 0);
  } catch {
    await FP.createDirectory("data", LIBRARY_ROOT).catch(() => {});
  }
  index = { scannedAt: Date.now(), tracks: paths.slice(0, MAX_FILES).map(p => toTrack(p)) };
  writeStore(INDEX_KEY, index);
  Hooks.callAll(LIBRARY_HOOK);
  return index.tracks;
}

/* -------------------------------------------- */
/*  Durations                                   */
/* -------------------------------------------- */

let durations: Record<string, number> | undefined;
const loading = new Map<string, Promise<number | undefined>>();

export function cachedDuration(path: string): number | undefined {
  durations ??= readStore(DURATIONS_KEY) ?? {};
  return durations[path];
}

/** Read a file's duration from its metadata, without downloading the whole file. */
export function loadDuration(path: string): Promise<number | undefined> {
  const known = cachedDuration(path);
  if (known !== undefined) return Promise.resolve(known);
  if (!loading.has(path)) {
    loading.set(path, new Promise(resolve => {
      const el = new Audio();
      el.preload = "metadata";
      el.onloadedmetadata = () => {
        durations![path] = el.duration;
        writeStore(DURATIONS_KEY, durations);
        resolve(el.duration);
      };
      el.onerror = () => resolve(undefined);
      el.src = path;
    }));
  }
  return loading.get(path)!;
}

/* -------------------------------------------- */
/*  Private preview                             */
/* -------------------------------------------- */

let preview: { path: string; sound: any } | undefined;

export function previewingPath(): string | undefined {
  return preview?.path;
}

/** Play a file on this client only; pressing it again (or previewing another) stops it. */
export async function togglePreview(path: string): Promise<void> {
  const was = preview;
  preview = undefined;
  was?.sound.stop({ fade: 200 });
  if (was?.path === path) return;
  const sound = await foundry.audio.AudioHelper.play({ src: path, volume: 0.8 }, false);
  preview = { path, sound };
  sound.addEventListener("end", () => {
    if (preview?.sound === sound) preview = undefined;
  });
}
