/**
 * Builds the template data for the Music Deck tab from the playlists, the mix and the library.
 */
import { DECKS, currentSound, endModeOf, playModeOf, playlistFor, queueOf } from "../channels";
import { channelGains, type DeckId, type PlayDeck } from "../crossfader";
import { otherDeck } from "../decks";
import { linkStatus } from "../deck-client";
import { ambientPlaying, randomSource } from "../layers";
import { battleDeck, battleSource, combatBattle, inBattle } from "../combat";
import { followsFolder, generalSource, generalSourceName } from "../general";
import { cachedDuration, libraryScannedAt, previewingPath } from "../library";
import { libraryRoot, tracksFor } from "../library-sources";
import { findNode, searchUnder, trail, type LibFolder, type LibSource, type LibTrack } from "../library-tree";
import { getMix } from "../live-gain";
import { fadeSeconds } from "../mixer";
import { hearingSummary, playMode, playersHearing } from "../players";
import { activeScene, activeScenes, groupLayers, scenesOf } from "../scenes";
import { getSheet } from "../cue-sheets";
import { pendingCue, playingCueOf } from "../cue-player";
import { colorOf } from "./editor-model";
import { nextPhaseCue } from "../cues";

export type View = "music" | "ambient" | "sfx" | "library";

export interface UiState {
  view: View;
  queue: DeckId;
  query: string;
  /** Library: which source, and the folder or playlist you're in ("" = the top). */
  source: LibSource;
  at: string;
  /** Library: the track whose cues are opened as sub-rows. */
  openCues?: string;
  /** Ambient: the scene a Library ＋Amb adds to, chosen with a scene's "Add a layer" button. */
  ambientTarget?: string;
}

const SOURCE_KEY = "music-deck.librarySource";
export function savedSource(): LibSource | undefined {
  try { const v = localStorage.getItem(SOURCE_KEY); return v === "files" || v === "playlists" ? v : undefined; } catch { return undefined; }
}
export function saveSource(source: LibSource): void {
  try { localStorage.setItem(SOURCE_KEY, source); } catch { /* private window: just don't remember */ }
}

/** Which parts of the tab the GM has folded away: the Volumes, Decks and Battle deck sections, and the tab's list (view). */
export type Fold = "volumes" | "decks" | "battle" | "view";
export type Folds = Partial<Record<Fold, boolean>>;
const FOLDS_KEY = "music-deck.folds";
export function savedFolds(): Folds {
  try { const v = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
export function saveFolds(folds: Folds): void {
  try { localStorage.setItem(FOLDS_KEY, JSON.stringify(folds)); } catch { /* private window: just don't remember */ }
}

/** One line for a folded Volumes section: each channel's level, or "muted". */
export function volumesSummary(mix: { musicVol: number; muted: boolean; ambientVol: number; ambientMuted: boolean; sfxVol: number; sfxMuted: boolean }): string {
  const level = (name: string, v: number, muted: boolean) => `${name} ${muted ? "muted" : pct(v)}`;
  return [level("Music", mix.musicVol, mix.muted), level("Ambient", mix.ambientVol, mix.ambientMuted), level("SFX", mix.sfxVol, mix.sfxMuted)].join(" · ");
}

/** One line for a folded Decks section: what the players hear. */
export function decksSummary(cards: readonly { id: string; title: string; playing: boolean; audible: boolean }[], panic: boolean): string {
  if (panic) return "Faded out";
  const onAir = cards.filter(c => c.playing && c.audible);
  if (onAir.length === 1) return `${onAir[0].id} on air · ${onAir[0].title}`;
  if (onAir.length > 1) return `${onAir.map(c => c.id).join(" and ")} on air`;
  return "Nothing on air";
}

const LIBRARY_ROWS = 150;
const pct = (v: number) => Math.round(v * 100);

export function formatTime(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function durationOf(ps: any): number | undefined {
  // A CueSound reports the cue's end as its duration (Infinity while looping); the readout wants the file's.
  const d = ps?.sound?.fileDuration ?? ps?.sound?.duration;
  return Number.isFinite(d) ? d : cachedDuration(ps?.path);
}

/** What a deck is doing, for the card's look: playing, paused, cued (loaded, waiting) or empty. */
export type DeckState = "playing" | "paused" | "cued" | "empty";
export const STATE_ICONS: Record<DeckState, string> = {
  playing: "fa-play", paused: "fa-pause", cued: "fa-circle-dot", empty: "fa-circle",
};

/** Which deck the Fade button goes to: the far side from where the crossfader is. */
export const fadeTarget = (fader: number): DeckId => (fader < 0.5 ? "B" : "A");

export function deckCard(deck: PlayDeck) {
  const p = playlistFor(deck);
  const sound = currentSound(deck);
  const gain = channelGains(getMix())[deck];
  const playing = !!sound?.playing;
  const paused = !playing && !!sound?.pausedTime;
  const elapsed = playing ? sound.sound?.currentTime : sound?.pausedTime;
  const duration = durationOf(sound);
  let status = "Empty: add tracks from the Library";
  if (sound) status = playing ? `${formatTime(elapsed)} / ${formatTime(duration)}` : paused ? `Paused · ${formatTime(elapsed)}` : "Cued · ready";
  const state: DeckState = playing ? "playing" : paused ? "paused" : sound ? "cued" : "empty";
  const battle = deck === "battle";
  return {
    id: deck,
    css: deck.toLowerCase(),
    // The Battle deck's tag is a sword, and its play button never fades the A/B crossfader.
    tag: battle ? "⚔" : deck,
    label: battle ? "the Battle deck" : `deck ${deck}`,
    battle,
    // Matches deckPlay: a playing deck pauses; a stopped one plays if the fader has it on air (Music level aside).
    playTip: battle && !inBattle() ? "Fade to the Battle deck (A and B pause)"
      : playing ? "Pause"
      : battle || channelGains({ ...getMix(), musicVol: 1, muted: false, panic: false })[deck] > 0.001 ? "Play"
      : `Fade to deck ${deck}`,
    title: sound?.name ?? "No track",
    status,
    state,
    stateIcon: STATE_ICONS[state],
    playing,
    hasTrack: !!sound,
    audible: gain > 0.001,
    progress: duration && elapsed ? Math.min(100, (elapsed / duration) * 100) : 0,
    soundId: sound?.id,
    count: p?.sounds.size ?? 0,
    cues: cueChips(sound),
    phase: phaseChip(deck, sound),
  };
}

/**
 * The deck card's Next phase chip: on a track whose cues have combat roles, or on the battle deck
 * during a combat. It names the phase it would go to, and is off at the last one.
 */
export function phaseChip(deck: PlayDeck, sound: any) {
  const sheet = getSheet(sound?.path);
  if (!sound || !sheet?.cues.length) return null;
  if (!sheet.cues.some(c => c.role === "battle") && battleDeck() !== deck) return null;
  const next = nextPhaseCue(sheet, playingCueOf(sound)?.id);
  return {
    next: next?.name ?? null,
    tip: next ? `Next phase: ${next.name}, at the end of the loop` : "This is the last phase",
  };
}

/**
 * A deck card's cue chips (track editor T3): number, name and colour as in the editor, the cue you hear lit, a
 * switch waiting for the end of the loop pending. Null for a track without cues.
 */
export function cueChips(sound: any) {
  const sheet = getSheet(sound?.path);
  if (!sound || !sheet?.cues.length) return null;
  const heard = playingCueOf(sound);
  const waiting = pendingCue(sound);
  return sheet.cues.map((c, i) => {
    const pending = waiting?.id === c.id;
    const lit = heard?.id === c.id;
    const how = pending ? "Switching at the end of the loop" : lit ? (sound.playing ? "Playing" : "Starts here") : "Click: go to it. Shift-click: now";
    return { id: c.id, n: c.pad ?? i + 1, name: c.name, color: colorOf(c, i), lit, pending, once: c.mode === "once", tip: `${c.name} · ${how}. Right-click for more.` };
  });
}

/** The Stream Deck indicator in the status line; hidden when the link is off. */
function linkChip() {
  switch (linkStatus()) {
    case "connected": return { css: "on", label: "", tip: "Stream Deck connected" };
    case "pairing": return { css: "pair", label: "Pair deck", tip: "Type the code shown on your Stream Deck to link it" };
    case "connecting":
    case "offline": return { css: "off", label: "", tip: "Stream Deck not found. Open the Stream Deck app; Music Deck reconnects by itself." };
    default: return null;
  }
}

export function nowContext() {
  const mix = getMix();
  const ambient = playlistFor("ambient");
  const layersOn = ambient?.sounds.filter((s: any) => s.playing).map((s: any) => s.name) ?? [];
  const mode = playMode();
  const hearing = hearingSummary(playersHearing(), mode);
  // Only the active GM can drive the mix; say so if that's someone else.
  const driver = game.users.activeGM;
  const otherDriver = driver && !driver.isSelf ? ` · ${driver.name} is running the mixer` : "";
  const cards = DECKS.map(deckCard);
  return {
    decks: cards,
    battle: battleContext(),
    fold: savedFolds(),
    volumesSummary: volumesSummary(mix),
    decksSummary: decksSummary(cards, mix.panic),
    fader: pct(mix.fader),
    musicVol: pct(mix.musicVol),
    muted: mix.muted,
    panic: mix.panic,
    ambient: { names: layersOn.join(" · ") || "off", on: ambientPlaying(), vol: pct(mix.ambientVol), muted: mix.ambientMuted },
    sfx: { vol: pct(mix.sfxVol), muted: mix.sfxMuted },
    status: `${hearing.text}${otherDriver}`,
    // The status dot: none (no players), table (Table play), warn (someone can't hear), ok (all hearing).
    hear: mode === "table" ? "table" : hearing.cantHear.length ? "warn" : playersHearing().length ? "ok" : "none",
    fadeTo: fadeTarget(mix.fader),
    cantHear: hearing.cantHear.length ? {
      label: `${hearing.cantHear.length} can't hear`,
      who: `${hearing.cantHear.join(", ")} ${hearing.cantHear.length === 1 ? "needs" : "need"} to click once in Foundry.`,
      tip: `${hearing.cantHear.join(", ")} can't hear Foundry yet. Their browser needs one click first; they see a banner asking for it.`,
    } : null,
    fadeSeconds: fadeSeconds(),
    mode: mode === "table"
      ? { id: "table", next: "online", label: "Table play", icon: "fa-people-roof",
          tip: "Table play: only this computer plays sound, and the players' Foundry stays quiet. Click for Online play." }
      : { id: "online", next: "table", label: "Online play", icon: "fa-globe",
          tip: "Online play: everyone hears Foundry on their own device. Click for Table play." },
    link: linkChip(),
  };
}

/** One line for a folded Battle deck: in or not, what plays, and its level. */
export function battleSummary(on: boolean, playing: string | null, tracks: number, vol: number, muted: boolean): string {
  const level = muted ? "muted" : `${pct(vol)}%`;
  if (on) return playing ? `On · ${playing} · ${level}` : `On · ${level}`;
  return tracks ? `Ready · ${tracks} track${tracks === 1 ? "" : "s"}` : "Empty";
}

/**
 * The Battle deck under A and B (v2.39), always there: its card, its own level, and its queue, where a row plays
 * now (bringing the Battle deck in, outside combat).
 */
export function battleContext() {
  const p = playlistFor("battle");
  if (!p) return null;
  const mix = getMix();
  const current = currentSound("battle");
  return {
    card: deckCard("battle"),
    vol: pct(mix.battleVol),
    on: inBattle(),
    summary: battleSummary(inBattle(), current?.playing ? current.name : null, p.sounds.size, mix.battleVol, mix.muted),
    note: !inBattle() ? (p.sounds.size ? "Ready · ▶ or Play now brings it in" : "Empty · ▶ loads your battle music")
      : combatBattle() ? "Combat · A and B resume after" : "On · A and B resume after",
    rows: queueOf(p).map((s: any, i: number) => ({
      id: s.id, n: i + 1, name: s.name, playing: !!s.playing, current: s.id === current?.id, duration: formatTime(durationOf(s)),
    })),
  };
}

export function musicContext(state: UiState) {
  const deck = state.queue;
  const p = playlistFor(deck);
  const current = currentSound(deck);
  const rows = queueOf(p).map((s: any, i: number) => ({
    id: s.id,
    n: i + 1,
    name: s.name,
    duration: formatTime(durationOf(s)),
    playing: s.playing,
    current: s.id === current?.id,
    // The current track, waiting to start: not while it plays or sits paused.
    next: s.id === current?.id && !s.playing && !s.pausedTime,
  }));
  return {
    deck,
    other: otherDeck(deck),
    otherCss: otherDeck(deck).toLowerCase(),
    tabs: DECKS.map(d => ({ id: d, css: d.toLowerCase(), active: d === deck })),
    rows,
    modes: deckModes(deck),
  };
}

/** The queue's three toggles: Shuffle and Repeat one are play modes (one at a time); Repeat is the end mode. */
function deckModes(deck: DeckId) {
  const play = playModeOf(deck);
  const loop = endModeOf(deck) === "loop";
  return [
    { mode: "shuffle", on: play === "shuffle", icon: "fa-shuffle", label: "Shuffle", tip: play === "shuffle" ? "Shuffle is on: the queue plays in a random order" : "Shuffle: play the queue in a random order" },
    { mode: "repeat", on: loop, icon: "fa-repeat", label: "Repeat", tip: loop ? "Repeat is on: after the last track the queue starts over" : "Repeat the queue (off: the deck stops after the last track)" },
    { mode: "repeatOne", on: play === "repeat", icon: "fa-repeat", one: true, label: "Repeat one", tip: play === "repeat" ? "Repeat one is on: the current track plays again and again" : "Repeat one: play the current track again and again" },
  ];
}

const SCENE_FOLDS_KEY = "music-deck.sceneFolds";
/** Which scenes the GM has opened (true) or closed (false) in the Ambient tab, on this browser. */
/** The General section's key among the scene folds (scene ids are random, so it can't clash). */
export const GENERAL_FOLD = "general";

export function savedSceneFolds(): Record<string, boolean> {
  try { const v = JSON.parse(localStorage.getItem(SCENE_FOLDS_KEY) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
export function saveSceneFolds(folds: Record<string, boolean>): void {
  try { localStorage.setItem(SCENE_FOLDS_KEY, JSON.stringify(folds)); } catch { /* private window: just don't remember */ }
}

/** A scene's line: how many of its layers play, or, while it's not playing, how many you've turned off in it. */
export function sceneSummary(count: number, on: number, off = 0): string {
  if (!count) return "No layers";
  const layers = `${count} layer${count === 1 ? "" : "s"}`;
  return on ? `${on} of ${layers} on` : off ? `${layers}, ${off} off` : layers;
}

/**
 * The play button's tooltip. Click: the scene alone (or fade it out if it's the only one on). Shift-click: stack it
 * on top of the scenes playing, or fade just it out (v2.33).
 */
export function scenePlayTip(name: string, on: boolean, scenesOn: number): string {
  const click = on && scenesOn === 1 ? `Fade ${name} out` : on ? `Keep only ${name}: the other scenes fade out` : `Fade to ${name}: its layers in, every other scene out`;
  const shift = on ? `Shift-click: fade just ${name} out` : `Shift-click: add ${name} on top`;
  return `${click}. ${shift}.`;
}

export function ambientContext() {
  const p = playlistFor("ambient");
  const sounds = queueOf(p);
  const byId = new Map<string, any>(sounds.map((s: any) => [s.id, s]));
  const playing = activeScenes();
  const sceneVols = getMix().sceneVols ?? {};
  const folds = savedSceneFolds();
  const all = scenesOf(p);
  const { groups, unsorted } = groupLayers(all, sounds.map((s: any) => s.id));
  const layer = (id: string, off = false) => {
    const s = byId.get(id);
    return { id, name: s.name, on: s.playing, off, level: pct(s.volume) };
  };
  return {
    scenes: groups.map(({ id, layers }) => {
      const scene = all.find(s => s.id === id)!;
      const off = new Set(scene.layers.filter(l => l.off).map(l => l.id));
      const rows = layers.map(id => layer(id, off.has(id)));
      const on = rows.filter(r => r.on).length;
      const isActive = playing.includes(id);
      return {
        id,
        name: scene.name,
        active: isActive,
        level: pct(sceneVols[id] ?? 1),
        open: folds[id] ?? isActive,
        layers: rows,
        summary: sceneSummary(rows.length, on, rows.filter(r => r.off).length),
        playTip: scenePlayTip(scene.name, isActive, playing.length),
      };
    }),
    general: unsorted.map(id => ({ ...layer(id), follows: followsFolder(byId.get(id)) })),
    generalOpen: folds[GENERAL_FOLD] ?? true,
    generalSource: generalSourceName(),
  };
}

export function sfxContext() {
  return {
    pads: queueOf(playlistFor("sfx")).map((s: any) => {
      const source = randomSource(s);
      return { id: s.id, name: s.name, playing: s.playing, random: source ? tracksFor(source).length : 0 };
    }),
  };
}

export function libraryContext(state: UiState) {
  const root = libraryRoot(state.source);
  const crumbs = trail(root, state.at || root.id);
  const scanned = libraryScannedAt();
  return {
    query: state.query,
    sources: (["playlists", "files"] as LibSource[]).map(id => ({ id, label: id === "files" ? "Files" : "Playlists", active: id === state.source })),
    crumbs: (crumbs.length ? crumbs : [root]).map((n, i, all) => ({ id: n.id, label: n.name, last: i === all.length - 1 })),
    total: (findNode(root, state.at) ?? root).count,
    files: state.source === "files",
    scanned: scanned ? new Date(scanned).toLocaleString() : "never",
  };
}

/** The scene a Library ＋Amb adds to: the one whose "Add a layer" you pressed, else the scene that's on. */
export function ambientTargetOf(state: UiState): { id: string; name: string } | undefined {
  const all = scenesOf();
  const id = all.some(s => s.id === state.ambientTarget) ? state.ambientTarget : activeScene();
  const scene = id ? all.find(s => s.id === id) : undefined;
  return scene && { id: scene.id, name: scene.name };
}

export function libraryListContext(state: UiState) {
  const root = libraryRoot(state.source);
  const target = ambientTargetOf(state);
  const ambTo = target ? `to the ${target.name} scene` : "to General (plays alongside any scene)";
  const node = findNode(root, state.at) ?? root;
  const battle = battleSource();
  const general = generalSource();
  const previewing = previewingPath();
  const track = (t: LibTrack, showWhere: boolean) => {
    const cues = getSheet(t.path)?.cues ?? [];
    const open = !!cues.length && state.openCues === t.path;
    return {
      path: t.path, name: t.name, where: showWhere ? t.where : "", ambTo,
      duration: formatTime(cachedDuration(t.path)), previewing: t.path === previewing,
      cueCount: cues.length, open,
      cueRows: open ? cues.map((c, i) => ({ id: c.id, n: c.pad ?? i + 1, name: c.name, color: colorOf(c, i), once: c.mode === "once", ambTo })) : [],
    };
  };
  if (state.query) {
    const matches = searchUnder(node, state.query);
    return { folders: [], rows: matches.slice(0, LIBRARY_ROWS).map(t => track(t, true)), more: Math.max(0, matches.length - LIBRARY_ROWS), noMatch: !matches.length };
  }
  const folders = node.children.filter((c): c is LibFolder => c.kind !== "track").map(f => ({
    id: f.id, name: f.name, count: f.count, playlist: f.kind === "playlist", battle: f.id === battle, general: f.id === general,
  }));
  const tracks = node.children.filter((c): c is LibTrack => c.kind === "track");
  return {
    folders,
    rows: tracks.slice(0, LIBRARY_ROWS).map(t => track(t, false)),
    more: Math.max(0, tracks.length - LIBRARY_ROWS),
    empty: !root.count,
    emptyFiles: state.source === "files",
  };
}
