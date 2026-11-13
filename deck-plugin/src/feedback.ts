/**
 * What the touch strip and keys show, as pure functions of the link (unit-tested).
 * Item keys match com.edenmichal.musicdeck.sdPlugin/layouts/strip.json, which both dials use.
 */
import type { DeckCue, DeckState, LibraryTrack } from "../../shared/protocol";
import type { DialMode } from "./gesture";
import type { LinkStatus } from "./link";

export interface LinkView {
  status: LinkStatus;
  code: string | null;
  state: DeckState | null;
}

/** The Playlists tab's palette, so the deck and the tab read as one instrument. */
export const COLOR = {
  text: "#e8e6e3",
  muted: "#a3a1ad",
  dim: "#5d5c66",
  a: "#6fb1e8",
  b: "#c58be8",
  accent: "#e0a65a",
  ambient: "#7cc79a",
  sfx: "#e0a65a",
  danger: "#e0625e",
} as const;

type Feedback = Record<string, any>;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const bar = (value: number, color: string) => ({ value: Math.round(value * 100), bar_fill_c: color });
/** Always sends the font too: the strip keeps the last one it was given. */
const text = (value: string, color: string = COLOR.text, size = 14) => ({ value, color, font: { size, weight: size > 14 ? 700 : 500 } });
/** The strip's top row: title on the left, value on the right. */
const head = (value: string, color: string = COLOR.text) => ({ value, color, font: { size: 13, weight: 600 } });

/** Offline and pairing look the same on every dial. Returns null once Foundry is linked. */
function linkFeedback(view: LinkView, title: string): Feedback | null {
  if (view.status === "pairing" && view.code) {
    return {
      title: head("PAIRING", COLOR.accent),
      value: head(""),
      line1: text("Type this code in Foundry:", COLOR.muted),
      line2: text(view.code.split("").join(" "), COLOR.text, 20),
      bar: bar(0, COLOR.dim),
    };
  }
  if (view.status !== "online" || !view.state) {
    return {
      title: head(title, COLOR.muted),
      value: head(""),
      line1: text("Foundry not connected", COLOR.muted),
      line2: text("Open your world as GM", COLOR.dim),
      bar: bar(0, COLOR.dim),
    };
  }
  return null;
}

/** Fader position as "A", "B" or the balance, e.g. "70|30". */
export function balance(fader: number): string {
  const b = Math.round(fader * 100);
  return b <= 0 ? "A" : b >= 100 ? "B" : `${100 - b}|${b}`;
}

export function musicFeedback(view: LinkView, mode: DialMode): Feedback {
  const offline = linkFeedback(view, "MUSIC");
  if (offline) return offline;
  const s = view.state!;
  if (s.battleDeck) return battleFeedback(s, s.battleDeck);
  const fade = mode === "fade";
  const heard = s.fader < 0.5 ? "A" : "B";
  const deckLine = (id: "A" | "B") => {
    const d = s.decks.find(x => x.id === id);
    const name = d?.track ?? "(empty)";
    // A cue switch waiting for the end of the loop: "A ▶ Boss · Phase 1 → Phase 2".
    const next = d?.cue?.pending && d.cue.cues.find(c => c.id === d.cue!.pending!.id);
    return text(`${id} ${d?.playing ? "▶ " : ""}${name}${next ? ` → ${next.name}` : ""}`, id === heard ? COLOR.text : COLOR.muted);
  };
  const title = s.panic ? head("PANIC", COLOR.danger)
    : s.fading ? head("FADING…", COLOR.b)
    : fade ? head("CROSSFADE", COLOR.a)
    : head("MUSIC VOLUME", COLOR.accent);
  const value = s.muted ? head("MUTED", COLOR.danger)
    : fade ? head(balance(s.fader), COLOR.muted)
    : head(pct(s.musicVol), COLOR.text);
  const fill = s.muted || s.panic ? COLOR.dim : fade ? `0:${COLOR.a},1:${COLOR.b}` : COLOR.accent;
  return {
    title,
    value,
    line1: deckLine("A"),
    line2: deckLine("B"),
    bar: bar(fade ? s.fader : s.musicVol, fill),
  };
}

/** The Music dial during combat (v2.39): the Battle deck's track and level; A and B wait paused. */
export function battleFeedback(s: DeckState, d: NonNullable<DeckState["battleDeck"]>): Feedback {
  const next = d.cue?.pending && d.cue.cues.find(c => c.id === d.cue!.pending!.id);
  const fill = s.muted || s.panic ? COLOR.dim : COLOR.danger;
  return {
    title: s.panic ? head("PANIC", COLOR.danger) : head("BATTLE", COLOR.danger),
    value: s.muted ? head("MUTED", COLOR.danger) : head(pct(s.battleVol), COLOR.text),
    line1: text(`⚔ ${d.playing ? "▶ " : ""}${d.track ?? "(empty)"}${next ? ` → ${next.name}` : ""}`, COLOR.text),
    line2: text("A/B paused · tap: next", COLOR.muted),
    bar: bar(s.battleVol, fill),
  };
}

/**
 * The Ambient Dial's strip. `sceneId` null: the whole Ambient level. A scene: that scene's level, after a press
 * stepped to it (v2.36), with where it sits among the scenes playing.
 */
export function ambientFeedback(view: LinkView, sceneId: string | null = null): Feedback {
  const offline = linkFeedback(view, "AMBIENT");
  if (offline) return offline;
  const s = view.state!;
  const dim = s.ambientMuted || s.panic;
  const scene = sceneId ? s.scenes.find(x => x.id === sceneId) : undefined;
  if (scene) {
    const level = s.sceneVols[scene.id] ?? 1;
    return {
      title: s.panic ? head("PANIC", COLOR.danger) : head("SCENE", COLOR.ambient),
      value: s.ambientMuted ? head("MUTED", COLOR.danger) : head(pct(level), COLOR.text),
      line1: text(scene.name, COLOR.text),
      line2: text(`${s.scenesOn.indexOf(scene.id) + 1} of ${s.scenesOn.length} · press: next`, COLOR.muted),
      bar: bar(level, dim ? COLOR.dim : COLOR.ambient),
    };
  }
  return {
    title: s.panic ? head("PANIC", COLOR.danger) : head("AMBIENT", COLOR.ambient),
    value: s.ambientMuted ? head("MUTED", COLOR.danger) : head(pct(s.ambientVol), COLOR.text),
    line1: s.ambient.on ? text(s.ambient.names, COLOR.text) : text("Off · tap to play", COLOR.muted),
    line2: text(s.scenesOn.length ? "Press: scene levels" : "", COLOR.muted),
    bar: bar(s.ambientVol, dim ? COLOR.dim : COLOR.ambient),
  };
}

/**
 * A press on the Ambient Dial: from the whole Ambient level to each scene playing, then back (null). A scene that
 * stopped playing counts as being back on Ambient.
 */
export function nextAmbientTarget(scenesOn: readonly string[], current: string | null): string | null {
  const stops = [null, ...scenesOn];
  const i = current && scenesOn.includes(current) ? stops.indexOf(current) : 0;
  return stops[(i + 1) % stops.length];
}

/**
 * The scene a Scene Mix dial is on: the one you picked while it still plays, else the first scene playing.
 * Null when no scene plays.
 */
export function sceneMixTarget(scenesOn: readonly string[], picked: string | null | undefined): string | null {
  if (picked && scenesOn.includes(picked)) return picked;
  return scenesOn[0] ?? null;
}

/** A press on the Scene Mix dial: the next scene playing after `current`, round and round. */
export function nextSceneOn(scenesOn: readonly string[], current: string | null): string | null {
  if (!scenesOn.length) return null;
  const i = current ? scenesOn.indexOf(current) : -1;
  return scenesOn[(i + 1) % scenesOn.length];
}

/** The Scene Mix dial's strip: the scene it's on, its level, and which of the playing scenes it is. */
export function sceneMixFeedback(view: LinkView, sceneId: string | null): Feedback {
  const offline = linkFeedback(view, "SCENE MIX");
  if (offline) return offline;
  const s = view.state!;
  const on = s.scenesOn;
  const scene = sceneId ? s.scenes.find(x => x.id === sceneId) : undefined;
  if (!scene) {
    return {
      title: head("SCENE MIX", COLOR.muted),
      value: head(""),
      line1: text("No scene playing", COLOR.muted),
      line2: text(""),
      bar: bar(0, COLOR.dim),
    };
  }
  const level = s.sceneVols[scene.id] ?? 1;
  const dim = s.panic || s.ambientMuted;
  return {
    title: s.panic ? head("PANIC", COLOR.danger) : head("SCENE MIX", COLOR.ambient),
    value: head(pct(level), COLOR.text),
    line1: text(scene.name, COLOR.text),
    line2: text(on.length > 1 ? `${on.indexOf(scene.id) + 1} of ${on.length} · press: next` : "", COLOR.muted),
    bar: bar(level, dim ? COLOR.dim : COLOR.ambient),
  };
}

export function sfxFeedback(view: LinkView): Feedback {
  const offline = linkFeedback(view, "SFX");
  if (offline) return offline;
  const s = view.state!;
  const now = s.sfx.filter(p => p.playing).map(p => p.name).join(" · ");
  return {
    title: s.panic ? head("PANIC", COLOR.danger) : head("SFX", COLOR.sfx),
    value: s.sfxMuted ? head("MUTED", COLOR.danger) : head(pct(s.sfxVol), COLOR.text),
    line1: now ? text(now, COLOR.text) : text("Tap: stop SFX", COLOR.muted),
    line2: text(""),
    bar: bar(s.sfxVol, s.sfxMuted || s.panic ? COLOR.dim : COLOR.sfx),
  };
}

/** The deck the Auto-fade key would fade to. */
export function fadeTarget(state: DeckState | null): "A" | "B" {
  return state && state.fader >= 0.5 ? "A" : "B";
}

// ── Cue keys (protocol 5) ─────────────────────────────────────────────────────

type DeckId = "A" | "B";
type CueEntry = DeckCue["cues"][number];

/** What a key shows: its title, whether it's lit, and whether it blinks (a switch waiting for the loop's end). */
export interface KeyFace {
  title: string;
  lit: boolean;
  blink: boolean;
  /** The cue's colour (Go to Cue keys): the key is drawn in it instead of the manifest's images. */
  color?: string;
}

/**
 * A Go to Cue key's image in its cue's colour, as a data URL, like the cue's chip in Foundry: always a wash and
 * frame of the colour; lit (or blinking on) the wash is much stronger and the frame thicker.
 */
export function cueKeyImage(color: string, lit: boolean): string {
  const c = /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#e0a65a";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 72 72">`
    + `<rect width="72" height="72" fill="#1f2026"/>`
    + (lit
      ? `<rect x="3.5" y="3.5" width="65" height="65" rx="8" fill="${c}" fill-opacity=".6" stroke="${c}" stroke-width="5"/>`
      : `<rect x="3" y="3" width="66" height="66" rx="8" fill="${c}" fill-opacity=".22" stroke="${c}" stroke-opacity=".85" stroke-width="2.5"/>`)
    + `<g transform="translate(0,-8)" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="3.5" stroke="${lit ? "#ffffff" : c}"><path d="M24 22h-6v28h6"/><path d="M48 22h6v28h-6"/></g>`
    + `<g transform="translate(0,-8)" stroke="${lit ? "#ffffff" : "#e8e6e3"}" stroke-width="3" stroke-linecap="round"><path d="M29 32v8M34 28v16M39 31v10M44 34v4"/></g></svg>`;
  return `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
}

export type CueKeySettings = {
  /** "cue": go to `cue`; "next"/"prev": step through the track's cues. */
  mode?: "cue" | "next" | "prev";
  /** A pad number 1–8 or a cue name. */
  cue?: string;
  /** Empty: the deck you're hearing. */
  deck?: "" | DeckId;
};

export const heardDeck = (s: DeckState): DeckId => (s.fader < 0.5 ? "A" : "B");

/** The deck a key acts on, and its cues (null when its track has none). Without a deck: the Battle deck during combat. */
export function keyDeck(s: DeckState, deck?: "" | DeckId): { id: DeckId | "battle"; cue: DeckCue | null } {
  if (!deck && s.battleDeck) return { id: "battle", cue: s.battleDeck.cue };
  const id = deck || heardDeck(s);
  return { id, cue: s.decks.find(d => d.id === id)?.cue ?? null };
}

/** Same rules as the module's findCue: a number is a pad (else a position), anything else a name in any case. */
export function findKeyCue(cue: DeckCue | null, ref: string | undefined): CueEntry | undefined {
  const r = ref?.trim();
  if (!cue || !r) return undefined;
  if (/^\d+$/.test(r)) {
    const n = Number(r);
    return cue.cues.find(c => c.pad === n) ?? cue.cues[n - 1];
  }
  return cue.cues.find(c => c.name.toLowerCase() === r.toLowerCase());
}

/** The cue after (1) or before (-1) the current one; no wrap-around, as in the module. */
export function stepKeyCue(cue: DeckCue | null, dir: 1 | -1): CueEntry | undefined {
  if (!cue) return undefined;
  const i = cue.cues.findIndex(c => c.id === cue.current);
  return i < 0 ? (dir === 1 ? cue.cues[0] : cue.cues.at(-1)) : cue.cues[i + dir];
}

/** Same rule as the module's nextPhaseCue: the next battle cue, or the next loop when the track has no roles. */
export function nextPhaseKeyCue(cue: DeckCue | null): CueEntry | undefined {
  if (!cue) return undefined;
  const later = cue.cues.slice(cue.cues.findIndex(c => c.id === cue.current) + 1);
  return cue.cues.some(c => c.role) ? later.find(c => c.role === "battle") : later.find(c => c.mode === "loop");
}

/** Up to two lines of about `width` characters for a 72 px key, breaking at a space where it can. */
export function keyLines(text: string, width = 9): string {
  const t = text.trim();
  if (t.length <= width) return t;
  const fit = (x: string) => (x.length > width ? `${x.slice(0, width - 1)}…` : x);
  const cut = t.lastIndexOf(" ", width);
  if (cut > 0) return `${t.slice(0, cut)}\n${fit(t.slice(cut + 1))}`;
  // A long first word: shorten it rather than split it, if there's a second word to show.
  const space = t.indexOf(" ");
  if (space > 0) return `${fit(t.slice(0, space))}\n${fit(t.slice(space + 1))}`;
  return `${t.slice(0, width)}\n${fit(t.slice(width))}`;
}

const offlineFace = (title: string): KeyFace => ({ title, lit: false, blink: false });

/** A Go to cue key: the cue's name on the deck's track, lit while you hear it, blinking while it waits. */
export function cueKeyFace(view: LinkView, settings: CueKeySettings): KeyFace {
  const mode = settings.mode ?? "cue";
  const verb = mode === "next" ? "Next" : "Prev";
  if (view.status !== "online" || !view.state) {
    return offlineFace(mode === "cue" ? (settings.cue ? keyLines(label(settings.cue)) : "Pick\ncue") : `${verb}\ncue`);
  }
  const { cue } = keyDeck(view.state, settings.deck);
  if (mode !== "cue") {
    const target = stepKeyCue(cue, mode === "next" ? 1 : -1);
    return { title: target ? `${verb}:\n${keyLines(target.name, 9).split("\n")[0]}` : `${verb}\ncue`, lit: false, blink: !!cue?.pending, color: target?.color };
  }
  if (!settings.cue) return offlineFace("Pick\ncue");
  const target = findKeyCue(cue, settings.cue);
  if (!target) return offlineFace(`${keyLines(label(settings.cue)).split("\n")[0]}\n—`);
  return { title: keyLines(target.name), lit: cue!.current === target.id && !cue!.pending, blink: cue!.pending?.id === target.id, color: target.color };
}

/** The Next phase key: the phase it would go to, blinking while a switch waits. */
export function nextPhaseFace(view: LinkView): KeyFace {
  if (view.status !== "online" || !view.state) return offlineFace("Next\nphase");
  const { cue } = keyDeck(view.state);
  const target = nextPhaseKeyCue(cue);
  return { title: target ? `Next:\n${keyLines(target.name, 9).split("\n")[0]}` : "Next\nphase", lit: false, blink: !!cue?.pending };
}

/** A setting of "3" reads "Cue 3" on the face. */
const label = (ref: string) => (/^\d+$/.test(ref.trim()) ? `Cue ${ref.trim()}` : ref.trim());

// ── Scene Combo key (protocol 7) ──────────────────────────────────────────────

export type ComboSettings = {
  /** The scenes it plays, picked in the property inspector. */
  sceneIds?: string[];
  /** Each scene's name as last seen, so the face keeps it while Foundry is offline. */
  names?: Record<string, string>;
  /** A title of your own instead of the scenes' names. */
  title?: string;
};

/** The chosen scenes that still exist in Foundry, each once, in the key's order; all of them while there's no state. */
export function comboSceneIds(state: DeckState | null, settings: ComboSettings): string[] {
  const ids = [...new Set((settings.sceneIds ?? []).filter(Boolean))];
  return state ? ids.filter(id => state.scenes.some(s => s.id === id)) : ids;
}

/** Cut to `width` characters, with an ellipsis. */
const fit = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);

/** Two or more names on a 72 px key: "Camp" over "+ Storm", or "+ 2 more". */
function comboTitle(names: readonly string[]): string {
  if (names.length === 1) return keyLines(names[0]);
  const rest = names.length === 2 ? fit(names[1].trim(), 7) : `${names.length - 1} more`;
  return `${fit(names[0].trim(), 9)}\n+ ${rest}`;
}

/**
 * A Scene Combo key: your title or its scenes' names, lit while every one of its scenes plays (as a Sound Scene key
 * lights while its scene does). "—" when none of its scenes exist any more.
 */
export function comboKeyFace(view: LinkView, settings: ComboSettings): KeyFace {
  const own = settings.title?.trim();
  const chosen = comboSceneIds(null, settings);
  if (!chosen.length) return offlineFace(own ? keyLines(own) : "Pick\nscenes");
  const state = view.status === "online" ? view.state : null;
  const ids = comboSceneIds(state, settings);
  if (!ids.length) return offlineFace(`${keyLines(own || "Combo").split("\n")[0]}\n—`);
  const names = ids.map(id => state?.scenes.find(s => s.id === id)?.name ?? settings.names?.[id] ?? "?");
  const lit = !!state && ids.every(id => state.scenesOn.includes(id));
  return { title: own ? keyLines(own) : comboTitle(names), lit, blink: false };
}

// ── Set Track keys (protocol 8) ──────────────────────────────────────────────

export type TrackKeySettings = {
  /** The track's file, as Foundry's Library lists it. */
  path?: string;
  /** Its name when last seen, for the face while Foundry is away. */
  name?: string;
};

/** A file path as a name, the module's way: "music/tavern/hearth_and-ale.mp3" → "hearth and ale". */
export function nameFromPath(path: string): string {
  let file = path.split("/").pop() ?? path;
  try { file = decodeURIComponent(file); } catch { /* keep it as it is */ }
  return file.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
}

/** A Set Track key: the track's name, lit while it plays on A, B or (protocol 11) the Battle deck. */
export function trackKeyFace(view: LinkView, settings: TrackKeySettings, library: readonly LibraryTrack[] | null): KeyFace {
  const path = settings.path;
  if (!path) return offlineFace("Pick a\ntrack");
  const name = library?.find(t => t.path === path)?.name ?? settings.name ?? nameFromPath(path);
  const s = view.status === "online" ? view.state : null;
  const lit = !!s && [...s.decks, ...(s.battleDeck ? [s.battleDeck] : [])].some(d => d.playing && d.path === path);
  return { title: keyLines(name), lit, blink: false };
}

/** The Set Track picker's dropdown: one group per playlist or folder, in the order Foundry sent them. */
export function trackItems(library: readonly LibraryTrack[]): { label: string; children: { label: string; value: string }[] }[] {
  const groups = new Map<string, { label: string; value: string }[]>();
  for (const t of library) {
    if (!groups.has(t.where)) groups.set(t.where, []);
    groups.get(t.where)!.push({ label: t.name, value: t.path });
  }
  return [...groups].map(([label, children]) => ({ label, children }));
}
