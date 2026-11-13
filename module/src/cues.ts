/**
 * Cues: named ranges inside one audio file.
 * Pure data and timing maths, unit-tested. Foundry-facing code lives in cue-sound.ts and cue-player.ts.
 */

export type CueMode = "loop" | "once";
/** What happens when a once-cue ends, or a loop-cue has played `repeat` times. */
export type CueAfter = "stop" | "next" | "hold" | { cue: string };
export type CueRole = "intro" | "battle" | "victory";
export type CueWhen = "now" | "loopEnd";

export interface Cue {
  id: string;
  name: string;
  /** Seconds, file time. */
  start: number;
  /** Seconds, file time; null = end of file. */
  end: number | null;
  mode: CueMode;
  /** Loop cues only: how many times it plays in total; undefined = forever. */
  repeat?: number;
  after?: CueAfter;
  color?: string;
  /** 1–8: its slot on "Go to cue" keys and the deck card. */
  pad?: number;
  role?: CueRole;
}

export interface CueSheet {
  path: string;
  /** Seconds, measured when the editor first decodes the file. */
  duration: number;
  bpm?: number;
  beatOffset?: number;
  cues: Cue[];
  /** What "add this track" uses; none = the whole file. */
  defaultCue?: string;
}

/** Files at most this long are decoded into memory so cue loops are sample-exact. */
export const CUE_BUFFER_MAX_S = 20 * 60;
/**
 * Default seam at a cue's loop point (seconds; the "Cue loops: seam" setting changes the music one). The loop
 * keeps its exact length either way (loop.ts cueLoopCopy), so a longer music seam stays in time.
 */
export const MUSIC_BLEND_S = 0.5;
export const AMBIENT_BLEND_S = 3;
/** Default for how long the old cue rings on past its end when a switch at the end of the loop starts the next. */
export const RING_OUT_S = 2;
/** How quickly a new cue's head comes in under a seam or ring-out, so its downbeat still lands. */
export const HEAD_IN_S = 0.06;
/** Sources are always scheduled this far ahead, so the playhead model and the audio agree exactly. */
export const SCHEDULE_LEAD_S = 0.05;
/** A jump between cues that don't meet gets this short crossfade, so it never clicks. */
export const MICRO_XFADE_S = 0.01;
/** Shortest cue the editor and the player accept. */
export const MIN_CUE_S = 0.1;

/** Paths as Foundry stores them, so a sheet is found whichever way the path was written. */
export function normalizePath(path: string): string {
  let p = String(path ?? "").trim();
  try { p = decodeURI(p); } catch { /* keep as is */ }
  return p.replace(/^\/+/, "");
}

export function cueEnd(cue: Cue, duration: number): number {
  return cue.end === null || !Number.isFinite(cue.end) ? duration : Math.min(cue.end, duration);
}

/**
 * Clean a sheet: drop broken cues, clamp to the file, sort by start, make ids unique.
 * Returns the cleaned copy plus human-readable problems (empty when it was already fine).
 */
export function validateSheet(sheet: CueSheet): { sheet: CueSheet; problems: string[] } {
  const problems: string[] = [];
  const duration = Number.isFinite(sheet.duration) && sheet.duration > 0 ? sheet.duration : Infinity;
  const seen = new Set<string>();
  const cues: Cue[] = [];
  for (const raw of sheet.cues ?? []) {
    const name = String(raw.name ?? "").trim() || "Cue";
    const start = Math.max(0, Number(raw.start));
    const end = raw.end === null || raw.end === undefined ? null : Number(raw.end);
    if (!Number.isFinite(start)) { problems.push(`${name}: start isn't a number`); continue; }
    if (end !== null && !Number.isFinite(end)) { problems.push(`${name}: end isn't a number`); continue; }
    const realEnd = end === null ? duration : Math.min(end, duration);
    if (start >= duration) { problems.push(`${name}: starts after the end of the file`); continue; }
    if (realEnd - start < MIN_CUE_S) { problems.push(`${name}: shorter than ${MIN_CUE_S} s`); continue; }
    let id = String(raw.id ?? "") || name.toLowerCase().replace(/\W+/g, "-");
    while (seen.has(id)) id += "-2";
    seen.add(id);
    const cue: Cue = { ...raw, id, name, start, end: end === null || end >= duration ? null : end, mode: raw.mode === "once" ? "once" : "loop" };
    if (cue.mode === "loop" && cue.repeat !== undefined && !(cue.repeat >= 1)) delete cue.repeat;
    cues.push(cue);
  }
  cues.sort((a, b) => a.start - b.start || cueEnd(a, duration) - cueEnd(b, duration));
  const defaultCue = cues.some(c => c.id === sheet.defaultCue) ? sheet.defaultCue : undefined;
  return { sheet: { ...sheet, path: normalizePath(sheet.path), cues, defaultCue }, problems };
}

/** Find a cue by id, by name (any case), or by pad number (falling back to its 1-based position). */
export function findCue(sheet: CueSheet | undefined, ref: string | number | undefined | null): Cue | undefined {
  if (!sheet || ref === undefined || ref === null || ref === "") return undefined;
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) {
    const n = Number(ref);
    return sheet.cues.find(c => c.pad === n) ?? sheet.cues[n - 1];
  }
  const s = String(ref);
  return sheet.cues.find(c => c.id === s) ?? sheet.cues.find(c => c.name.toLowerCase() === s.toLowerCase());
}

/** The cue after (dir 1) or before (dir -1) this one, in start order; no wrap-around. */
export function stepCue(sheet: CueSheet, id: string | undefined, dir: 1 | -1): Cue | undefined {
  const i = sheet.cues.findIndex(c => c.id === id);
  if (i < 0) return dir === 1 ? sheet.cues[0] : sheet.cues.at(-1);
  return sheet.cues[i + dir];
}

/**
 * Per-sound overrides of what follows a cue, by cue id: another cue's id, or "stop". Combat sets these on its
 * battle track, so the intro always chains into the first battle loop and victory always ends.
 */
export type CueChain = Record<string, string>;

/**
 * What follows a cue that has finished: another cue, "stop", "hold", or null (a loop that never ends).
 * A `chain` entry for the cue wins over its own `after`, and also ends a loop that would otherwise run forever.
 */
export function resolveAfter(sheet: CueSheet, cue: Cue, chain?: CueChain | null): Cue | "stop" | "hold" | null {
  const forced = chain?.[cue.id];
  if (forced === "stop") return "stop";
  if (forced) {
    const next = findCue(sheet, forced);
    if (next && next.id !== cue.id) return cue.mode === "loop" && cue.repeat === undefined ? null : next;
  }
  if (cue.mode === "loop" && cue.repeat === undefined) return null;
  const after = cue.after ?? "stop";
  if (after === "stop" || after === "hold") return after;
  const next = after === "next" ? stepCue(sheet, cue.id, 1) : findCue(sheet, after.cue);
  return next && next.id !== cue.id ? next : "stop";
}

/** One scheduled stretch of playback: a source started at audio-clock `when`, from file time `fileAt`. */
export interface Segment {
  when: number;
  fileAt: number;
  /** File time the cue starts at. */
  start: number;
  /** File time a loop wraps back to: the start, so each loop is exactly the cue (later than it on a whole-file loop). */
  loopStart: number;
  /** File time the cue ends (or wraps) at. */
  end: number;
  loop: boolean;
  /** Seam to blend at the wrap, seconds; once playing, the seconds before `end` where the audio differs from the file. */
  seam: number;
}

export function makeSegment(cue: Cue, duration: number, when: number, fileAt: number, blendS = 0): Segment {
  const end = cueEnd(cue, duration);
  const loop = cue.mode === "loop";
  const seam = loop ? Math.max(0, Math.min(blendS, (end - cue.start) / 4)) : 0;
  const at = Math.min(Math.max(fileAt, cue.start), end - MIN_CUE_S / 2);
  return { when, fileAt: at, start: cue.start, loopStart: cue.start, end, loop, seam };
}

/** File time a segment is playing at audio-clock `now`. */
export function segmentFileTime(s: Segment, now: number): number {
  const elapsed = Math.max(0, now - s.when);
  const first = s.end - s.fileAt;
  if (!s.loop) return Math.min(s.fileAt + elapsed, s.end);
  if (elapsed < first) return s.fileAt + elapsed;
  return s.loopStart + ((elapsed - first) % (s.end - s.loopStart));
}

/** Audio-clock time of the segment's next wrap (loop) or its end (once), at least `lead` after `now`. */
export function nextBoundary(s: Segment, now: number, lead = SCHEDULE_LEAD_S): number {
  let t = s.when + (s.end - s.fileAt);
  if (s.loop) {
    const len = s.end - s.loopStart;
    if (t < now + lead) t += Math.ceil((now + lead - t) / len) * len;
  }
  return t;
}

/** Audio-clock time a loop segment finishes its `repeat`-th play (the first pass counts as one). */
export function repeatEnd(s: Segment, repeat: number): number {
  return s.when + (s.end - s.fileAt) + Math.max(0, repeat - 1) * (s.end - s.loopStart);
}

/** "Boss Theme · Phase 2". */
export function cueLabel(trackName: string, cue: Cue | undefined): string {
  return cue ? `${trackName} · ${cue.name}` : trackName;
}

/**
 * Combat's "Next phase": the next cue with the battle role after `currentId`. A sheet with no roles
 * steps to the next loop cue instead, so a plain "Phase 1, Phase 2" track works too. Undefined at the last one.
 */
export function nextPhaseCue(sheet: CueSheet, currentId: string | undefined | null): Cue | undefined {
  const i = sheet.cues.findIndex(c => c.id === currentId);
  const later = sheet.cues.slice(i + 1);
  const anyRoles = sheet.cues.some(c => c.role);
  return anyRoles ? later.find(c => c.role === "battle") : later.find(c => c.mode === "loop");
}

/** True when any cue of the sheet has a combat role (intro, battle or victory). */
export const hasRoles = (sheet: CueSheet | undefined): boolean => !!sheet?.cues.some(c => c.role);

/**
 * How combat plays a battle track whose cues have roles: start on the intro (else the first battle
 * cue), chain the intro into the first battle cue, and end victory with a stop so the fade back can follow.
 * Null for a track without roles, which plays as a whole file (or its default cue) exactly as before.
 */
export function combatPlan(sheet: CueSheet | undefined): { start: Cue; chain: CueChain; victory?: Cue } | null {
  if (!sheet || !hasRoles(sheet)) return null;
  const intro = sheet.cues.find(c => c.role === "intro");
  const battles = sheet.cues.filter(c => c.role === "battle");
  const battle = battles.find(c => c.mode === "loop") ?? battles[0];
  const victory = sheet.cues.find(c => c.role === "victory");
  const start = intro ?? battle;
  if (!start) return null;
  const chain: CueChain = {};
  if (intro && battle) chain[intro.id] = battle.id;
  if (victory) chain[victory.id] = "stop";
  return { start, chain, ...(victory ? { victory } : {}) };
}

/** What the Stream Deck shows for a track with cues (protocol 5 `decks[].cue`). */
export function deckCueState(
  sheet: CueSheet | undefined, current: Cue | null | undefined, pending: { id: string; when: CueWhen } | null,
): { cues: { id: string; name: string; mode: CueMode; pad?: number; role?: string }[]; current: string | null; pending: { id: string; when: CueWhen } | null } | null {
  if (!sheet?.cues.length) return null;
  return {
    cues: sheet.cues.map(c => ({ id: c.id, name: c.name, mode: c.mode, ...(c.pad ? { pad: c.pad } : {}), ...(c.role ? { role: c.role } : {}) })),
    current: current?.id ?? null,
    pending: pending && pending.id !== current?.id ? pending : null,
  };
}
