/**
 * General ambient layers (v2.31): layers that aren't in a sound scene. They play alongside any scene (recalling a
 * scene never fades them), so a thunderstorm can sit on top of Forest Day and stay on through Forest (Night).
 *
 * General can follow a Library folder or playlist, the "general ambience" (right-click it in the Library): every
 * track in it is a General layer, flagged so syncing adds what's new and removes what left. Layers you put in General
 * yourself are never removed. With no choice made, it follows a playlist (or playlist folder) named "Ambience".
 * Syncing is the active GM's job: on ready, when the choice changes, and when the followed playlist changes.
 */
import { playlistFor, queueOf } from "./channels";
import { nodeFor, tracksFor } from "./library-sources";
import { MODULE_ID, channelOf } from "./live-gain";
import { GENERAL_FLAG, scenesOf } from "./scenes";

const SOURCE = "generalSource";
/** The setting's value once you've turned following off, so the "Ambience" default doesn't come back. */
const NONE = "none";
const DEFAULT_NAME = "ambience";
const NEW_LEVEL = 0.8;

export interface SyncTrack { path: string; name: string }
export interface SyncLayer { id: string; path: string; synced: boolean; cue: boolean }

/**
 * What to change so General matches the followed folder: add a layer for each track General doesn't have (a whole
 * file, not a cue), and remove followed layers whose file left the folder, or a second followed copy of a file.
 * `general` is the General layers only; ones you added yourself (not `synced`) are kept.
 */
export function syncPlan(tracks: readonly SyncTrack[], general: readonly SyncLayer[]): { add: SyncTrack[]; remove: string[] } {
  const wanted = new Map<string, SyncTrack>();
  for (const t of tracks) if (!wanted.has(t.path)) wanted.set(t.path, t);
  const have = new Set<string>();
  const remove: string[] = [];
  for (const l of general) {
    if (l.cue) continue;
    if (l.synced && (!wanted.has(l.path) || have.has(l.path))) remove.push(l.id);
    else have.add(l.path);
  }
  return { add: [...wanted.values()].filter(t => !have.has(t.path)), remove };
}

const isActiveGM = () => !!game.users.activeGM?.isSelf;

export function registerGeneralSettings(): void {
  game.settings.register(MODULE_ID, SOURCE, {
    scope: "world", config: false, type: String, default: "",
    onChange: () => {
      if (isActiveGM()) void syncGeneral();
      ui.playlists?.render({ parts: ["ambient", "libraryList"] });
    },
  });
}

/** The playlist, or else playlist folder, named "Ambience": what General follows until you choose. */
function defaultSource(): string {
  const playlist = game.playlists.find((p: any) => !channelOf(p) && p.name.trim().toLowerCase() === DEFAULT_NAME);
  if (playlist) return `playlist:${playlist.id}`;
  const folder = game.folders.find((f: any) => f.type === "Playlist" && f.name.trim().toLowerCase() === DEFAULT_NAME);
  return folder ? `folder:${folder.id}` : "";
}

/** The Library folder or playlist General follows, or "" for none. */
export function generalSource(): string {
  const chosen: string = game.settings.get(MODULE_ID, SOURCE);
  if (chosen === NONE) return "";
  if (chosen && nodeFor(chosen)) return chosen;
  return chosen ? "" : defaultSource();
}

/** The followed folder's name, for the Ambient tab. */
export const generalSourceName = (): string => nodeFor(generalSource())?.name ?? "";

export const setGeneralSource = (id: string) => game.settings.set(MODULE_ID, SOURCE, id || NONE);

/** True for a General layer that follows the folder (it comes and goes with it). */
export const followsFolder = (sound: any): boolean => !!sound?.getFlag(MODULE_ID, GENERAL_FLAG);

/** The ambient layers no scene owns. */
export function generalLayers(p: any = playlistFor("ambient")): any[] {
  const owned = new Set(scenesOf(p).flatMap(s => s.layers.map(l => l.id)));
  return queueOf(p).filter((s: any) => !owned.has(s.id));
}

let syncing: Promise<void> | null = null;
let again = false;

/** Make General match the followed folder. Runs one at a time; a call during a sync runs once more after it. */
export function syncGeneral(): Promise<void> {
  if (syncing) { again = true; return syncing; }
  syncing = (async () => {
    try {
      do { again = false; await syncOnce(); } while (again);
    } finally { syncing = null; }
  })();
  return syncing;
}

async function syncOnce(): Promise<void> {
  const p = playlistFor("ambient");
  if (!p || !isActiveGM()) return;
  const general = generalLayers(p).map((s: any) => ({ id: s.id, path: s.path, synced: followsFolder(s), cue: !!s.getFlag(MODULE_ID, "cue") }));
  const { add, remove } = syncPlan(tracksFor(generalSource()).map(t => ({ path: t.path, name: t.name })), general);
  // A layer that's playing stays until it's stopped; the next sync removes it.
  const gone = remove.filter(id => !p.sounds.get(id)?.playing);
  if (gone.length) await p.deleteEmbeddedDocuments("PlaylistSound", gone);
  if (!add.length) return;
  let sort = queueOf(p).at(-1)?.sort ?? 0;
  await p.createEmbeddedDocuments("PlaylistSound", add.map(t => ({
    name: t.name, path: t.path, volume: NEW_LEVEL, repeat: true, sort: (sort += 100_000),
    flags: { [MODULE_ID]: { [GENERAL_FLAG]: true } },
  })));
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Sync soon: a batch of changes to the followed playlist syncs once. */
function syncSoon(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void syncGeneral(), 300);
}

/** Ready: sync now, then whenever a Library playlist's tracks change (adding a file to Ambience adds a layer). */
export function startGeneral(): void {
  if (isActiveGM()) void syncGeneral();
  const watch = (doc: any) => {
    const playlist = doc?.parent;
    if (!isActiveGM() || !playlist || channelOf(playlist)) return;
    syncSoon();
  };
  Hooks.on("createPlaylistSound", watch);
  Hooks.on("deletePlaylistSound", watch);
  Hooks.on("updatePlaylistSound", (doc: any, change: any) => { if ("path" in (change ?? {}) || "name" in (change ?? {})) watch(doc); });
  // A playlist moved in or out of a followed folder, or the folder itself changed.
  for (const hook of ["createPlaylist", "deletePlaylist", "updatePlaylist", "updateFolder", "deleteFolder"]) {
    Hooks.on(hook, (doc: any) => { if (isActiveGM() && !channelOf(doc)) syncSoon(); });
  }
}
