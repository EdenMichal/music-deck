/**
 * Combat auto-cue (Phase 5; the Battle deck since v2.39). The Battle deck is a third deck, always shown under A
 * and B, holding your battle music in a random order. Begin Combat (or its ▶ / Play now, any time) blends to it:
 * A and B fade out and pause where they were. You see what plays and can skip, pick or level it like a deck.
 * When combat ends (or Back to A/B) it blends back: A and B resume where they paused, and the Battle deck stops,
 * keeping its queue for next time. Active GM only. The battle source is a Library folder or
 * playlist (right-click › Use for battle music), else the Music Deck – Combat playlist.
 *
 * A battle track whose cues have roles (track editor T5) starts on its intro, which chains into the
 * first battle loop; Next phase steps through the battle cues; ending combat plays the victory cue first, and
 * the blend back starts when it ends. A track without roles plays exactly as before.
 *
 * The run (which A/B tracks to resume) is a flag on the Battle deck's playlist, so a reload mid-combat keeps it.
 */
import { combatPlaylist, playlistFor, queueOf } from "./channels";
import { battleOrder, recovery, toResume } from "./combat-pick";
import type { DeckId, PlayDeck } from "./crossfader";
import * as decks from "./decks";
import { nodeFor, tracksFor } from "./library-sources";
import { MODULE_ID, getMix } from "./live-gain";
import * as mixer from "./mixer";
import { cueFade, defaultWhen, getSheet } from "./cue-sheets";
import { goToCue, playingCueOf } from "./cue-player";
import { combatPlan, cueEnd } from "./cues";
import { afterEnd, sortUpdates } from "./queue";

const ENABLED = "combatCue";
const SOURCE = "battleSource";
const RUN = "battleRun";
const START_VOL = "battleStartVol";
/** The most battle tracks put on the Battle deck at once. */
const MAX_TRACKS = 100;

/** A battle in progress: the A/B tracks that were playing, to resume afterwards; and whether combat started it. */
interface Run { held: { deck: DeckId; sound: string }[]; combat?: boolean }
const LAST = "battleLast";

/** Combat has ended and the victory cue is playing; the blend back waits for it (or this fallback timer). */
let ending: ReturnType<typeof setTimeout> | undefined;
/** The track the last combat started on, so the next one starts elsewhere. */
let lastStart: string | undefined;
/** Battles started on this client, so a wait can tell the battle it began in from a later one. */
let battles = 0;

const isActiveGM = () => !!game.users.activeGM?.isSelf;
const runOf = (): Run | null => playlistFor("battle")?.getFlag(MODULE_ID, RUN) ?? null;

export function registerCombatSettings(): void {
  game.settings.register(MODULE_ID, ENABLED, {
    name: "Combat auto-cue",
    hint: "Begin Combat loads your battle music onto the Battle deck and fades to it; A and B pause and pick up again when combat ends. Choose the battle music in the Library: right-click a folder or playlist.",
    scope: "world", config: true, type: Boolean, default: true,
  });
  game.settings.register(MODULE_ID, START_VOL, {
    name: "Battle deck starting level (%)",
    hint: "The Battle deck's level each time it comes in (Begin Combat, or its ▶). Turn it up or down from there as the fight goes.",
    scope: "world", config: true, type: Number, range: { min: 0, max: 100, step: 5 }, default: 30,
  });
  game.settings.register(MODULE_ID, SOURCE, { scope: "world", config: false, type: String, default: "",
    onChange: () => ui.playlists?.render({ parts: ["libraryList"] }) });
}

/** The Library folder or playlist chosen for battle music, else the Music Deck – Combat playlist. */
export function battleSource(): string {
  const chosen: string = game.settings.get(MODULE_ID, SOURCE);
  if (chosen && nodeFor(chosen)) return chosen;
  const combat = combatPlaylist();
  return combat ? `playlist:${combat.id}` : chosen;
}

/** True when battle music is the default Combat playlist rather than a folder or playlist the GM chose. */
export const battleIsDefault = (): boolean => { const c = combatPlaylist(); return !!c && battleSource() === `playlist:${c.id}`; };
export const setBattleSource = (id: string) => game.settings.set(MODULE_ID, SOURCE, id);

/** The deck the battle music plays on while a combat is running (null otherwise, or once victory has started). */
export const battleDeck = (): PlayDeck | null => (runOf() && !ending ? "battle" : null);

/** True while the Battle deck has the music: from Begin Combat (or ▶) until the blend back starts. */
export const inBattle = (): boolean => !!runOf();
/** Which battle is on (null when none): changes whenever one ends or another starts. */
export const battleId = (): number | null => (runOf() ? battles : null);
/** True when the battle running now was started by a combat, not by hand. */
export const combatBattle = (): boolean => !!runOf()?.combat;

/** Put the battle music on the Battle deck, shuffled, each track on its intro if it has one. Returns the first. */
async function loadBattleTracks(): Promise<string | undefined> {
  if (!battleSource() || !tracksFor(battleSource()).length) return void warnNoMusic();
  const p = playlistFor("battle");
  if (!p) return undefined;
  const tracks = tracksFor(battleSource());
  const order = battleOrder(tracks.map(t => t.path), lastStart, MAX_TRACKS);
  const byPath = new Map(tracks.map(t => [t.path, t]));
  const data = order.map(path => {
    const plan = combatPlan(getSheet(path));
    const d: any = decks.trackData(path, byPath.get(path)?.name, plan?.start.id);
    if (plan) (d.flags ??= { [MODULE_ID]: {} })[MODULE_ID].chain = plan.chain;
    return d;
  });
  if (!data.length) return undefined;
  const created = await p.createEmbeddedDocuments("PlaylistSound", data);
  await p.updateEmbeddedDocuments("PlaylistSound", sortUpdates(created.map((c: any) => c.id)), { render: false });
  lastStart = order[0];
  return created[0]?.id;
}

function warnNoMusic(): void {
  if (!battleSource()) {
    return void ui.notifications.warn("Music Deck: no battle music chosen, so the Battle deck is empty. In the Library, right-click a playlist or folder › Use for battle music.");
  }
  ui.notifications.warn(battleIsDefault()
    ? "Music Deck: the Music Deck – Combat playlist is empty, so the Battle deck is empty. Add tracks with ＋⚔ in the Library."
    : "Music Deck: the battle music folder is empty or gone.");
}

/** Shuffle the Battle deck afresh from the battle music. While it's playing, it goes straight to the new first. */
export async function reloadBattle(): Promise<void> {
  if (!isActiveGM()) return;
  const playing = decks.isPlaying("battle");
  await decks.clearDeck("battle");
  const first = await loadBattleTracks();
  if (first && playing) await decks.playTrack("battle", first);
}

/**
 * Where a battle starts: the track you picked, else one you cued with ⏭ since, else the one after the last
 * battle's, else the top.
 */
function startTrack(p: any, pick?: string): string | undefined {
  if (pick && p.sounds.has(pick)) return pick;
  const order = queueOf(p).map((s: any) => s.id);
  const last = p.getFlag(MODULE_ID, LAST);
  const cued = p.getFlag(MODULE_ID, "current");
  if (cued && cued !== last && order.includes(cued)) return cued;
  return (last && order.includes(last) ? afterEnd(order, last, "loop") : null) ?? order[0];
}

/**
 * Bring in the Battle deck: A and B fade out and pause where they were. Begin Combat does this, and so do the
 * Battle deck's ▶ and Play now (`pick`). An empty Battle deck loads the battle music first.
 */
export async function startBattle({ pick, combat = false }: { pick?: string; combat?: boolean } = {}): Promise<void> {
  if (ending) await fadeBack();
  if (!isActiveGM()) return;
  const p = playlistFor("battle");
  if (!p) return;
  if (runOf()) {
    // Already in: Play now just switches track; Begin Combat marks the battle as the combat's.
    if (pick) await decks.playTrack("battle", pick);
    if (combat && !runOf()!.combat) await p.setFlag(MODULE_ID, RUN, { ...runOf()!, combat: true });
    return;
  }
  if (!p.sounds.size && !(await loadBattleTracks())) return;
  const first = startTrack(p, pick);
  if (!first) return;
  // What A and B are playing, to pause once they're silent and resume afterwards.
  const held = (["A", "B"] as DeckId[]).flatMap(deck => {
    const sound = playlistFor(deck)?.sounds.find((s: any) => s.playing);
    return sound ? [{ deck, sound: sound.id }] : [];
  });
  battles++;
  await p.setFlag(MODULE_ID, RUN, { held, combat } satisfies Run);
  // It comes in at the starting level every time (30% unless set otherwise), whatever it was left at.
  mixer.setBattleVol((game.settings.get(MODULE_ID, START_VOL) as number) / 100);
  await decks.playTrack("battle", first);
  await blendIn(held);
}

/** Blend to the Battle deck; once A and B are silent, pause them where they are (unless it ended meanwhile). */
async function blendIn(held: Run["held"]): Promise<void> {
  await mixer.fadeBattle(1);
  if (runOf() && !ending && getMix().battle >= 1) for (const h of held) await decks.pause(h.deck);
}

async function onCombatStart(): Promise<void> {
  if (game.settings.get(MODULE_ID, ENABLED)) await startBattle({ combat: true });
}

/**
 * Back to A/B by hand (the Battle deck's button): blend back now, without waiting for a victory cue. The deck
 * you're hearing always plays afterwards, even if it wasn't playing when the Battle deck came in.
 */
export async function endBattle(): Promise<void> {
  if (isActiveGM()) await fadeBack({ playHeard: true });
}

async function onCombatEnd(): Promise<void> {
  if (!isActiveGM() || !runOf() || ending) return;
  if (await playVictory()) return;
  await fadeBack();
}

/**
 * Switch the battle track to its victory cue, if it has one. Its chain makes it stop at its end, and that end
 * (onBattleTrackEnd) starts the blend back; a timer covers a victory that never reports its end.
 */
async function playVictory(): Promise<boolean> {
  const sound = playlistFor("battle")?.sounds.find((s: any) => s.playing);
  const sheet = getSheet(sound?.path);
  const victory = combatPlan(sheet)?.victory;
  if (!sound || !sheet || !victory) return false;
  const when = defaultWhen(false);
  const now = playingCueOf(sound);
  if (!(await goToCue(sound, victory.id, when))) return false;
  const wait = (cueEnd(victory, sheet.duration) - victory.start)
    + (when === "loopEnd" && now ? cueEnd(now, sheet.duration) - now.start : 0) + cueFade() + 3;
  ending = setTimeout(() => void fadeBack(), wait * 1000);
  return true;
}

/**
 * Blend back to A and B: the tracks the battle paused resume where they were, the Battle deck fades out, and once
 * it's silent it stops. It keeps its queue; the next battle starts on the track after this one's. `playHeard`
 * (Back to A/B): also start the deck you're hearing if nothing was paused on it, so the music comes back.
 */
async function fadeBack({ playHeard = false }: { playHeard?: boolean } = {}): Promise<void> {
  const run = runOf();
  clearTimeout(ending);
  ending = undefined;
  if (!run) return;
  const p = playlistFor("battle");
  const playing = p?.sounds.find((s: any) => s.playing);
  await p?.update({ [`flags.${MODULE_ID}.-=${RUN}`]: null, ...(playing ? { [`flags.${MODULE_ID}.${LAST}`]: playing.id } : {}) });
  for (const h of toResume(run.held, getMix().fader)) {
    const sound = playlistFor(h.deck)?.sounds.get(h.sound);
    if (sound && !sound.playing) await decks.playTrack(h.deck, h.sound);
  }
  const heard: DeckId = getMix().fader < 0.5 ? "A" : "B";
  if (playHeard && !decks.isPlaying(heard)) await decks.play(heard);
  await mixer.fadeBattle(0);
  // A battle may have started again during the blend; then the deck is playing for it.
  if (!runOf() && getMix().battle <= 0) await decks.stop("battle");
}

/** From our Playlist subclass: a Battle deck track ended, so play the next one in its queue. True if handled. */
export async function onBattleTrackEnd(playlist: any, sound: any): Promise<boolean> {
  if (playlist !== playlistFor("battle")) return false;
  if (ending) { await fadeBack(); return true; }
  if (!runOf()) return true;
  const next = afterEnd(queueOf(playlist).map((s: any) => s.id), sound.id, "loop");
  if (next) await decks.playTrack("battle", next);
  return true;
}

/**
 * After a reload: a combat's battle with no combat running any more blends back, and so does a blend left on
 * with no battle. A battle started by hand, or a combat still running, keeps the Battle deck, finishing a blend
 * in that the reload cut short.
 */
function recover(): void {
  if (!isActiveGM()) return;
  const running = !!game.combats?.some((c: any) => c.started);
  const run = runOf();
  const action = recovery(run, running, getMix().battle);
  if (action === "back") void fadeBack();
  // A reload during the blend in left it part way, with A and B still playing under it: finish it.
  else if (action === "in") void (async () => { if (!decks.isPlaying("battle")) await decks.play("battle"); await blendIn(run!.held); })();
  else if (action === "out") void mixer.fadeBattle(0).then(() => decks.stop("battle"));
}

export function startCombat(): void {
  Hooks.on("combatStart", () => onCombatStart());
  Hooks.on("deleteCombat", (combat: any) => combat.started && onCombatEnd());
  recover();
}
