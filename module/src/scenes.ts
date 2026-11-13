/**
 * Sound scenes: a named group of ambient layers, recalled with a fade. Since v2.29 each
 * scene owns its layers: the Ambient tab shows them under the scene, a layer's level is its own volume, and two
 * scenes that want rain each have their own rain layer. "Night Camp" might be a quiet campfire + crickets;
 * recalling it fades those in and every other scene's layers out. Layers no scene owns are General (v2.31): they
 * play alongside any scene, and can follow a Library folder (general.ts).
 *
 * Scenes are a flag on "Music Deck – Ambient", so world backups keep them. GM only.
 * The fade is the Ambient playlist's own `fade` (set by ensurePlaylists), which Foundry applies on every
 * client when a layer starts or stops; the Ambient Dial's level, mute and Panic still apply on top as live gains.
 */
import { playlistFor, queueOf } from "./channels";
import { layerOwners, revivedSceneVols } from "./crossfader";
import { MODULE_ID, getMix, setMix } from "./live-gain";

export interface SceneLayer {
  /** Ambient layer (PlaylistSound) id. */
  id: string;
  /**
   * A level to give the layer. Stored scenes no longer keep one (since v2.29 a layer's level is its own volume);
   * it's read from scenes saved before then, and the scene editor passes it to setScene.
   */
  volume?: number;
  /** Turned off in this scene (v2.31): recalling the scene leaves it off until you turn it on again. */
  off?: boolean;
}

export interface SoundScene {
  id: string;
  name: string;
  layers: SceneLayer[];
}

const FLAG = "scenes";
/** Flag on a General layer that follows the General folder (general.ts), so syncing can add and remove it. */
export const GENERAL_FLAG = "general";
export const SCENE_FADE_MS = 2000;
/** Foundry stores a layer's volume in steps of 0.01, so anything closer than half a step is the same level. */
const LEVEL_EPSILON = 0.005;

/** A level as Foundry will store it on the layer. */
export const roundLevel = (volume: number) => Math.round(volume * 100) / 100;

/** Scenes saved before v2.14 listed layer ids only. */
export function normalizeScene(raw: any): SoundScene {
  return {
    id: String(raw.id),
    name: String(raw.name ?? "Scene"),
    layers: (raw.layers ?? []).map((l: any) => (typeof l === "string" ? { id: l } : { id: String(l.id), volume: l.volume, ...(l.off ? { off: true } : {}) })),
  };
}

/**
 * What to change so exactly the scene's layers play at its levels. `volumes` holds every existing layer's
 * current volume; layers the scene names that no longer exist are ignored.
 */
export function recallPlan(scene: readonly SceneLayer[], playing: readonly string[], volumes: Readonly<Record<string, number>>) {
  const target = scene.filter(l => l.id in volumes);
  const ids = new Set(target.map(l => l.id));
  return {
    start: target.filter(l => !playing.includes(l.id)).map(l => l.id),
    stop: playing.filter(id => !ids.has(id)),
    levels: target
      .filter(l => l.volume !== undefined && Math.abs(volumes[l.id] - l.volume) > LEVEL_EPSILON)
      .map(l => ({ id: l.id, volume: l.volume! })),
  };
}

/** Which scene owns each layer: the first scene that lists it (scenes saved before v2.29 could share one). */
function owners(scenes: readonly SoundScene[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const scene of scenes) for (const { id } of scene.layers) if (!owner.has(id)) owner.set(id, scene.id);
  return owner;
}

/**
 * The Ambient tab's groups: each scene with the layers it owns, in the Ambient playlist's order (`layerIds`),
 * and the layers no scene owns. A layer a scene names that no longer exists is left out.
 */
export function groupLayers(scenes: readonly SoundScene[], layerIds: readonly string[]) {
  const owner = owners(scenes);
  return {
    groups: scenes.map(scene => ({ id: scene.id, layers: layerIds.filter(id => owner.get(id) === scene.id) })),
    unsorted: layerIds.filter(id => !owner.has(id)),
  };
}

/** The layers a scene plays when you recall it: all of its own but the ones you turned off in it. */
export const layersOn = (scene: SoundScene): SceneLayer[] => scene.layers.filter(l => !l.off);

/**
 * A scene layer turned on or off: its scene remembers it, so recalling the scene brings back that mix.
 * Returns `scenes` itself when the layer is in no scene (a General layer).
 */
export function remember(scenes: SoundScene[], layerId: string, on: boolean): SoundScene[] {
  const owner = owners(scenes).get(layerId);
  if (!owner) return scenes;
  return scenes.map(s => (s.id !== owner ? s : {
    ...s,
    layers: s.layers.map(l => (l.id !== layerId ? l : on ? { id: l.id, ...(l.volume === undefined ? {} : { volume: l.volume }) } : { ...l, off: true })),
  }));
}

/** The layers among `ids` that some scene owns: everything but the General layers. */
export function sceneLayers(scenes: readonly SoundScene[], ids: readonly string[]): string[] {
  const owner = owners(scenes);
  return ids.filter(id => owner.has(id));
}

/**
 * The scene that's on: the one that owns every scene layer playing, even if some of its own are stopped.
 * General layers (in no scene) play alongside any scene, so they don't count.
 */
export function sceneForPlaying(scenes: readonly SoundScene[], playing: readonly string[]): string | null {
  const inScenes = sceneLayers(scenes, playing);
  if (!inScenes.length) return null;
  const owner = owners(scenes);
  const scene = owner.get(inScenes[0]);
  return scene && inScenes.every(id => owner.get(id) === scene) ? scene : null;
}

/** Every scene with at least one of its own layers playing, in the scenes' order. Scenes can stack (v2.33). */
export function scenesPlaying(scenes: readonly SoundScene[], playing: readonly string[]): string[] {
  const owner = owners(scenes);
  const on = new Set(playing.map(id => owner.get(id)).filter(Boolean));
  return scenes.filter(s => on.has(s.id)).map(s => s.id);
}

/**
 * A held Sound Scene key, or Shift-click on a scene's play button: stack the scene on top of whatever plays.
 * A scene that's on fades just its own layers out; one that's off fades its layers in at their levels, leaving
 * every other scene and General as they are. `null` when the scene doesn't exist.
 */
export function stackPlan(sceneId: string, scenes: readonly SoundScene[], playing: readonly string[], volumes: Readonly<Record<string, number>>) {
  const scene = scenes.find(s => s.id === sceneId);
  if (!scene) return null;
  const owner = owners(scenes);
  const mine = playing.filter(id => owner.get(id) === sceneId);
  if (mine.length) return { start: [] as string[], stop: mine, levels: [] as { id: string; volume: number }[] };
  const { start, levels } = recallPlan(layersOn(scene), [], volumes);
  return { start, stop: [] as string[], levels };
}

/**
 * A Scene Combo key (v2.37, protocol 7): several scenes with one press. Every chosen scene plays its mix and
 * everything else fades out: the other scenes and the General layers too. Pressed while exactly these scenes are on
 * (all of them, and no other scene), it fades them out instead, as a press on the only scene playing does.
 * `sceneIds` are the scenes that still exist, in the key's order, and `off` whether this press fades them out.
 * Chosen scenes that no longer exist are skipped; `null` when none do.
 */
export function comboPlan(chosen: readonly string[], scenes: readonly SoundScene[], playing: readonly string[], volumes: Readonly<Record<string, number>>) {
  const mine = [...new Set(chosen)].map(id => scenes.find(s => s.id === id)).filter((s): s is SoundScene => !!s);
  if (!mine.length) return null;
  const sceneIds = mine.map(s => s.id);
  const on = scenesPlaying(scenes, playing);
  if (on.length === sceneIds.length && sceneIds.every(id => on.includes(id))) {
    const owner = owners(scenes);
    return { sceneIds, off: true, start: [] as string[], stop: playing.filter(id => sceneIds.includes(owner.get(id)!)), levels: [] as { id: string; volume: number }[] };
  }
  // A layer two old scenes share is played once.
  const seen = new Set<string>();
  const target = mine.flatMap(layersOn).filter(l => !seen.has(l.id) && !!seen.add(l.id));
  return { sceneIds, off: false, ...recallPlan(target, playing, volumes) };
}

/**
 * What adding layers to a scene does with each: a General layer moves in, another scene's is copied (so that
 * scene keeps its own), and one the scene already owns is skipped. A General layer that follows a Library folder
 * (`keep`) is copied too, so General keeps it.
 */
export function adoptPlan(
  sceneId: string, scenes: readonly SoundScene[], ids: readonly string[], keep: ReadonlySet<string> = new Set(),
): { id: string; how: "move" | "copy" }[] {
  const owner = owners(scenes);
  const plan: { id: string; how: "move" | "copy" }[] = [];
  for (const id of new Set(ids)) {
    const from = owner.get(id);
    if (from !== sceneId) plan.push({ id, how: from || keep.has(id) ? "copy" : "move" });
  }
  return plan;
}

/**
 * Bringing scenes saved before v2.29 (shared layers, a level per scene) over to scenes that own their layers:
 * a layer a later scene shares becomes that scene's own copy at its level, the owner's saved level moves onto
 * the layer itself, and layers that no longer exist are dropped. `volumes` holds every layer's current volume.
 */
export function migrationPlan(scenes: readonly SoundScene[], volumes: Readonly<Record<string, number>>) {
  const owner = owners(scenes);
  const levels: { id: string; volume: number }[] = [];
  const copies: { sceneId: string; layerId: string; volume?: number }[] = [];
  let changed = false;
  for (const scene of scenes) {
    for (const { id, volume } of scene.layers) {
      if (!(id in volumes)) { changed = true; continue; }
      if (volume !== undefined) changed = true;
      if (owner.get(id) !== scene.id) copies.push({ sceneId: scene.id, layerId: id, volume });
      else if (volume !== undefined && Math.abs(volumes[id] - volume) > LEVEL_EPSILON) levels.push({ id, volume });
    }
  }
  return { changed: changed || copies.length > 0, levels, copies };
}

/** A name for a scene saved from the deck: its layers, e.g. "campfire + crickets". */
export function nameFor(layerNames: readonly string[]): string {
  if (!layerNames.length) return "Quiet";
  const name = layerNames.join(" + ");
  return name.length > 32 ? `${name.slice(0, 31)}…` : name;
}

/**
 * A sound the scene editor can add: an ambient layer by `id`, or a Library file by `path`, optionally one of its
 * cues (it becomes a layer on save).
 */
export interface SceneCandidate {
  id?: string;
  path?: string;
  cue?: string;
  name: string;
  /** "Ambient layer", or the Library folder. */
  where: string;
}

/** How the scene editor tells sounds apart: a file, or one cue of it ("path#cue"). */
export const soundKey = (path: string, cue?: string | null): string => (cue ? `${path}#${cue}` : path);

/**
 * What the editor's "Add a sound" search offers: ambient layers not in the scene first, then Library files
 * that aren't layers yet, each followed by its cues (track editor T5). With no query, only the layers (so a
 * sound you just removed is one click away). A cue matches on its track or on its own name.
 */
export function sceneCandidates(
  layers: readonly { id: string; name: string; path: string; cue?: string | null; where?: string }[],
  inScene: ReadonlySet<string>,
  tracks: readonly { path: string; name: string; folder: string; haystack: string }[],
  query: string,
  limit = 8,
  cuesOf: (path: string) => readonly { id: string; name: string }[] = () => [],
): SceneCandidate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every(w => text.includes(w));
  const layerKeys = new Set(layers.map(l => soundKey(l.path, l.cue)));
  const taken = (key: string) => layerKeys.has(key) || inScene.has(key);
  const fromLayers = layers
    .filter(l => !inScene.has(l.id) && !inScene.has(soundKey(l.path, l.cue)) && matches(l.name.toLowerCase()))
    .map(l => ({ id: l.id, name: l.name, where: l.where ?? "Ambient layer" }));
  const fromLibrary: SceneCandidate[] = [];
  if (words.length) {
    for (const t of [...tracks].sort((a, b) => a.name.localeCompare(b.name))) {
      const hit = matches(t.haystack);
      if (hit && !taken(t.path)) fromLibrary.push({ path: t.path, name: t.name, where: t.folder || "Library" });
      for (const c of cuesOf(t.path)) {
        if (taken(soundKey(t.path, c.id)) || !(hit || matches(`${t.haystack} ${c.name.toLowerCase()}`))) continue;
        fromLibrary.push({ path: t.path, cue: c.id, name: `${t.name} · ${c.name}`, where: `Cue · ${t.folder || "Library"}` });
      }
    }
  }
  return [...fromLayers, ...fromLibrary].slice(0, limit);
}

const ambient = () => playlistFor("ambient");
const playingIds = (p: any): string[] => p?.sounds.filter((s: any) => s.playing).map((s: any) => s.id) ?? [];
const volumesOf = (p: any): Record<string, number> => Object.fromEntries(p?.sounds.map((s: any) => [s.id, s.volume]) ?? []);

export function scenesOf(p: any = ambient()): SoundScene[] {
  return (p?.getFlag(MODULE_ID, FLAG) ?? []).map(normalizeScene);
}

/** The scene that owns a layer, if any. */
export function sceneOfLayer(layerId: string, p: any = ambient()): SoundScene | undefined {
  return scenesOf(p).find(s => s.layers.some(l => l.id === layerId));
}

/** The one scene that's on, or null when none is or several are stacked. */
export function activeScene(): string | null {
  const p = ambient();
  return p ? sceneForPlaying(scenesOf(p), playingIds(p)) : null;
}

/** Every scene that has a layer playing: more than one while scenes are stacked. */
export function activeScenes(): string[] {
  const p = ambient();
  return p ? scenesPlaying(scenesOf(p), playingIds(p)) : [];
}

/** Scenes keep only their layers' ids: a layer's level is its own volume. */
async function writeScenes(scenes: SoundScene[]): Promise<void> {
  await ambient()?.setFlag(MODULE_ID, FLAG, scenes.map(s => ({ ...s, layers: s.layers.map(({ id, off }) => (off ? { id, off } : { id })) })));
}

/** A layer's data for its copy in another scene: same file, cue and level, silent, at the end of the list. */
function copyOf(sound: any, sort: number, volume?: number): object {
  const { _id, ...data } = sound.toObject();
  // A copy is the scene's own layer: it doesn't follow General's folder.
  if (data.flags?.[MODULE_ID]) delete data.flags[MODULE_ID][GENERAL_FLAG];
  return { ...data, playing: false, pausedTime: null, sort, ...(volume === undefined ? {} : { volume }) };
}

/**
 * Give a scene these layers: unsorted ones move in, another scene's are copied, its own stay. Returns, for each
 * id given, the id of the layer the scene now owns for it (a copy's new id). Doesn't write the scenes.
 */
async function claim(p: any, all: SoundScene[], sceneId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const followed = new Set<string>(p.sounds.filter((s: any) => s.getFlag(MODULE_ID, GENERAL_FLAG)).map((s: any) => s.id));
  const copies = adoptPlan(sceneId, all, ids.filter(id => p.sounds.has(id)), followed).filter(c => c.how === "copy");
  let sort = queueOf(p).at(-1)?.sort ?? 0;
  const made = copies.length
    ? await p.createEmbeddedDocuments("PlaylistSound", copies.map(c => copyOf(p.sounds.get(c.id), (sort += 100_000))))
    : [];
  const ownId = new Map(ids.map(id => [id, id]));
  copies.forEach((c, i) => { if (made[i]) ownId.set(c.id, made[i].id); });
  return ownId;
}

/** Add layers to a scene (moving unsorted ones in, copying another scene's). Returns the ids it owns for them. */
export async function adoptLayers(sceneId: string, ids: readonly string[]): Promise<string[]> {
  const p = ambient();
  const all = scenesOf(p);
  const scene = all.find(s => s.id === sceneId);
  if (!p || !scene) return [];
  const ownId = await claim(p, all, sceneId, ids);
  const mine = [...new Set(ids.map(id => ownId.get(id)!))].filter(id => p.sounds.has(id));
  const owned = new Set(scene.layers.map(l => l.id));
  const added = mine.filter(id => !owned.has(id));
  if (added.length) await writeScenes(all.map(s => (s.id === sceneId ? { ...s, layers: [...s.layers, ...added.map(id => ({ id }))] } : s)));
  return mine;
}

/** Make a new, empty scene. Returns its id. */
export async function createScene(name: string, id: string = foundry.utils.randomID()): Promise<string> {
  await writeScenes([...scenesOf(), { id, name: name.trim() || "Scene", layers: [] }]);
  return id;
}

/** Add the layers playing now to a scene, and remember its own layers as on or off as they are now. */
export async function updateScene(id: string): Promise<void> {
  const playing = playingIds(ambient());
  await adoptLayers(id, playing);
  const all = scenesOf();
  const on = new Set(playing);
  await writeScenes(all.map(s => (s.id !== id ? s : { ...s, layers: s.layers.map(l => (on.has(l.id) ? { id: l.id } : { id: l.id, off: true })) })));
}

/** A scene layer was turned on or off (its toggle or Ambient Layer key): its scene remembers that. */
export async function rememberLayer(layerId: string, on: boolean): Promise<void> {
  const all = scenesOf();
  const next = remember(all, layerId, on);
  if (next !== all && JSON.stringify(next) !== JSON.stringify(all)) await writeScenes(next);
}

/**
 * The scene editor's save: name, sounds in order and each one's level. A listed layer from elsewhere is moved in
 * or copied; the scene's own layers that aren't listed are deleted. Adds the scene if it's new.
 */
export async function setScene(scene: SoundScene): Promise<void> {
  const p = ambient();
  if (!p) return;
  let all = scenesOf(p);
  if (!all.some(s => s.id === scene.id)) all = [...all, { id: scene.id, name: scene.name, layers: [] }];
  const ownId = await claim(p, all, scene.id, scene.layers.map(l => l.id));
  const layers = scene.layers.map(l => ({ id: ownId.get(l.id) ?? l.id, volume: l.volume })).filter(l => p.sounds.has(l.id));
  const keep = new Set(layers.map(l => l.id));
  const dropped = (all.find(s => s.id === scene.id)?.layers ?? []).map(l => l.id).filter(id => !keep.has(id) && p.sounds.has(id));
  const levels = layers.filter(l => l.volume !== undefined && Math.abs(p.sounds.get(l.id).volume - roundLevel(l.volume)) > LEVEL_EPSILON);
  if (levels.length) await p.updateEmbeddedDocuments("PlaylistSound", levels.map(l => ({ _id: l.id, volume: roundLevel(l.volume!) })));
  if (dropped.length) await p.deleteEmbeddedDocuments("PlaylistSound", dropped);
  // Moving a layer in takes it out of whichever scene listed it before (an unsorted layer has none).
  // A layer you turned off in the scene stays off.
  const wasOff = new Set((all.find(s => s.id === scene.id)?.layers ?? []).filter(l => l.off).map(l => l.id));
  const next = { id: scene.id, name: scene.name.trim() || "Scene", layers: layers.map(({ id }) => (wasOff.has(id) ? { id, off: true } : { id })) };
  const others = all.filter(s => s.id !== scene.id).map(s => ({ ...s, layers: s.layers.filter(l => !keep.has(l.id)) }));
  const order = all.map(s => s.id);
  await writeScenes([...others, next].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)));
}

/** Delete a scene and the layers it owns. */
export async function deleteScene(id: string): Promise<void> {
  const p = ambient();
  const scene = scenesOf(p).find(s => s.id === id);
  if (!p || !scene) return;
  const own = scene.layers.map(l => l.id).filter(layerId => p.sounds.has(layerId));
  if (own.length) await p.deleteEmbeddedDocuments("PlaylistSound", own);
  await writeScenes(scenesOf(p).filter(s => s.id !== id));
}

/**
 * Scenes saved before v2.29 shared layers and kept a level per scene. Give each scene its own layers and move the
 * levels onto them (see migrationPlan). Run by the active GM on ready; does nothing when there's nothing to fix.
 */
export async function migrateScenes(): Promise<void> {
  const p = ambient();
  if (!p) return;
  const all = scenesOf(p);
  const { changed, levels, copies } = migrationPlan(all, volumesOf(p));
  if (!changed) return;
  if (levels.length) await p.updateEmbeddedDocuments("PlaylistSound", levels.map(l => ({ _id: l.id, volume: roundLevel(l.volume) })));
  let sort = queueOf(p).at(-1)?.sort ?? 0;
  const made = copies.length
    ? await p.createEmbeddedDocuments("PlaylistSound", copies.map(c => copyOf(p.sounds.get(c.layerId), (sort += 100_000), c.volume)))
    : [];
  const copyId = new Map(copies.map((c, i) => [`${c.sceneId}:${c.layerId}`, made[i]?.id as string | undefined]));
  await writeScenes(all.map(s => ({
    ...s,
    layers: s.layers.map(l => ({ id: copyId.get(`${s.id}:${l.id}`) ?? l.id })).filter(l => p.sounds.has(l.id)),
  })));
}

/**
 * A Sound Scene key press, or the play button on a scene in the Ambient tab: recall the scene, or fade it out if
 * it's the only one on now. Fading out remembers its layers, so the key again (or a tap on the Ambient Dial) brings
 * them back. With scenes stacked, a press on one of them keeps just that one.
 */
export function toggleScene(id: string): Promise<void> {
  return oneAtATime(() => (activeScene() !== id ? recall(id) : stack(id)));
}

/** Add a scene on top of what's playing, or fade just that scene out if it's on (see stackPlan). */
export function stackScene(id: string): Promise<void> {
  return oneAtATime(() => stack(id));
}

/** Fade the ambient layers to the scene's, at its levels. Recalling the scene that's already on changes nothing. */
export function recallScene(id: string): Promise<void> {
  return oneAtATime(() => recall(id));
}

/**
 * A Scene Combo key: play these scenes together, fading out every other scene and General, or fade them out if
 * they're exactly what's on (see comboPlan). A scene you'd turned all the way down comes back at full.
 */
export function playCombo(sceneIds: readonly string[]): Promise<void> {
  return oneAtATime(async () => {
    const p = ambient();
    const plan = p && comboPlan(sceneIds, scenesOf(p), playingIds(p), volumesOf(p));
    if (!plan) return;
    if (!plan.off) reviveScenes(plan.sceneIds);
    await apply(p, plan);
  });
}

/**
 * Scene commands run one after another. Each plans from what's playing, and Foundry only changes the playlist once
 * the server answers, so two sent close together (two keys, a key and a scene activation) would both plan from the
 * state before either: a quick switch would leave both scenes on, and fading out two stacked scenes at once would
 * leave the playlist "playing" with nothing on and nothing to bring back.
 */
let sceneQueue: Promise<unknown> = Promise.resolve();
/**
 * Run an ambient command after the ones before it. Scene keys and buttons, a scene map's activation, layer toggles
 * and the Ambient Dial's tap all go through here. Each must not call another: it would wait for itself.
 */
export function oneAtATime(run: () => Promise<void>): Promise<void> {
  const step = async () => {
    try {
      await run();
    } finally {
      await settleAmbient().catch(e => console.warn("Music Deck | couldn't settle the Ambient playlist", e));
    }
  };
  const next = sceneQueue.then(step, step);
  sceneQueue = next.catch(() => {});
  return next;
}

/**
 * A command can leave the Ambient playlist "playing" with no layer on (Foundry works out whether a playlist stays
 * on from the layers as they were when the command was sent). Nothing would play, and the Ambient Dial's tap would
 * think there was something to pause; turn the playlist off.
 */
async function settleAmbient(): Promise<void> {
  const p = ambient();
  if (p?.playing && !playingIds(p).length) await p.update({ playing: false });
}

async function stack(id: string): Promise<void> {
  const p = ambient();
  if (!p) return;
  const plan = stackPlan(id, scenesOf(p), playingIds(p), volumesOf(p));
  if (!plan) return;
  if (plan.start.length) reviveScenes([id]);
  await apply(p, plan);
}

async function recall(id: string): Promise<void> {
  const p = ambient();
  const scene = scenesOf(p).find(s => s.id === id);
  if (!p || !scene) return;
  // Other scenes' layers fade out; General layers play alongside any scene, so they're left alone.
  // Its layers you turned off in it stay off (and fade out if they're on).
  reviveScenes([id]);
  await apply(p, recallPlan(layersOn(scene), sceneLayers(scenesOf(p), playingIds(p)), volumesOf(p)));
}

/**
 * Scenes about to start: one you'd turned all the way down on the Scene Mix (or Ambient) dial comes back at full,
 * so starting it is heard. The level is kept in the mix, so without this a scene you once turned to 0 would light up
 * and stay silent every time you played it again.
 */
function reviveScenes(sceneIds: readonly string[]): void {
  const sceneVols = revivedSceneVols(getMix().sceneVols, sceneIds);
  if (!sceneVols) return;
  try {
    setMix({ sceneVols });
  } catch (e) {
    console.warn("Music Deck | couldn't bring a silent scene's level back up", e);
  }
}

/**
 * Layers about to start (a layer toggle, the Ambient Dial bringing layers back): each scene among them that isn't
 * playing yet starts, so it's brought back up if it was silent (see reviveScenes).
 */
export function reviveScenesOf(layerIds: readonly string[], p: any = ambient()): void {
  const owner = layerOwners(p?.getFlag(MODULE_ID, FLAG));
  const on = new Set(playingIds(p).map(id => owner.get(id)));
  const starting = new Set(layerIds.map(id => owner.get(id)).filter((s): s is string => !!s && !on.has(s)));
  if (starting.size) reviveScenes([...starting]);
}

/** Start, stop and re-level ambient layers in one update, so Foundry fades them together on every client. */
async function apply(p: any, { start, stop, levels }: { start: string[]; stop: string[]; levels: { id: string; volume: number }[] }): Promise<void> {
  if (!start.length && !stop.length && !levels.length) return;
  const playing = playingIds(p);
  const level = new Map(levels.map(l => [l.id, l.volume]));
  const on = playing.length - stop.length + start.length;
  const sounds = [
    ...start.map(_id => ({ _id, playing: true, ...(level.has(_id) ? { volume: level.get(_id) } : {}) })),
    // A layer that stays on glides to its new level (Foundry fades a playing sound's volume change).
    ...levels.filter(l => !start.includes(l.id)).map(l => ({ _id: l.id, volume: l.volume })),
    ...stop.map(_id => ({ _id, playing: false })),
  ];
  await p.update({
    playing: on > 0,
    // Going quiet remembers what was on, so a tap on the Ambient Dial brings it back.
    ...(on === 0 ? { [`flags.${MODULE_ID}.resume`]: playing } : {}),
    sounds,
  });
}

/** Move a layer into another scene, or out of every scene (`null`: General). The layer itself doesn't change. */
export async function moveLayer(layerId: string, toSceneId: string | null): Promise<void> {
  const all = scenesOf();
  if (toSceneId && !all.some(s => s.id === toSceneId)) return;
  await writeScenes(all.map(s => {
    const layers = s.layers.filter(l => l.id !== layerId);
    return s.id === toSceneId ? { ...s, layers: [...layers, { id: layerId }] } : { ...s, layers };
  }));
}
