/**
 * Turns Stream Deck gestures into mixer actions, and builds the state the deck displays.
 * Runs on the active GM's client only, behind the deck link (deck-client.ts).
 */
import type { DeckCommand, DeckState } from "../../shared/protocol";
import { DECKS, currentSound, playlistFor, queueOf, trackName } from "./channels";
import type { DeckId, PlayDeck } from "./crossfader";
import { inBattle } from "./combat";
import * as decks from "./decks";
import * as layers from "./layers";
import { getMix } from "./live-gain";
import { getSheet } from "./cue-sheets";
import { pendingCue, playingCueOf } from "./cue-player";
import { cueLabel, deckCueState } from "./cues";
import { colorOf } from "./ui/editor-model";
import * as mixer from "./mixer";
import * as scenes from "./scenes";

/** The deck you're hearing more of; a dial's "next" skips on this one. */
export const heardDeck = (fader: number): DeckId => (fader < 0.5 ? "A" : "B");

/** The deck a key or dial without a deck of its own works on: the Battle deck during combat (v2.39). */
const heard = (): PlayDeck => decks.musicDeck();

/** A deck's track for the Stream Deck: name (with the cue you hear), playing, and its cues. */
function deckEntry(id: PlayDeck) {
  const sound = currentSound(id);
  const sheet = getSheet(sound?.path);
  const cue = sheet ? playingCueOf(sound) : undefined;
  // A track with cues shows the cue you hear, not the one its name already points at while a switch waits.
  const track = sound ? (cue ? cueLabel(trackName(sound.path), cue) : sound.name) : null;
  const state = deckCueState(sheet, cue, pendingCue(sound));
  // Each cue's colour, so a Go to Cue key matches its chip in Foundry.
  state?.cues.forEach((c, i) => { (c as { color?: string }).color = colorOf(sheet!.cues[i], i); });
  return { track, path: sound?.path ?? null, playing: !!sound?.playing, cue: state };
}

export function deckState(): DeckState {
  const ambient = playlistFor("ambient");
  const layerList = queueOf(ambient);
  // Each layer's scene, so the Ambient Layer key's picker can tell two scenes' "Rain" apart.
  const owner = new Map<string, string>(scenes.scenesOf().flatMap(sc => sc.layers.map(l => [l.id, sc.name] as [string, string])));
  return {
    ...getMix(),
    fading: mixer.isFading(),
    decks: DECKS.map(id => ({ id, ...deckEntry(id) })),
    ambient: {
      on: layers.ambientPlaying(),
      names: layerList.filter((s: any) => s.playing).map((s: any) => s.name).join(" · "),
      layers: layerList.map((s: any) => ({ id: s.id, name: s.name, on: !!s.playing, scene: owner.get(s.id) ?? "General" })),
    },
    sfx: queueOf(playlistFor("sfx")).map((s: any) => ({ id: s.id, name: s.name, playing: !!s.playing })),
    scenes: scenes.scenesOf().map(({ id, name }) => ({ id, name })),
    scenesOn: scenes.activeScenes(),
    battleDeck: heard() === "battle" ? deckEntry("battle") : null,
  };
}

export async function runCommand(cmd: DeckCommand): Promise<void> {
  switch (cmd.type) {
    case "fader.nudge": mixer.nudgeFader(cmd.delta); return;
    // During combat the Music dial levels the Battle deck; A and B are paused under it, so no A/B fade.
    case "music.vol.nudge": if (heard() === "battle") mixer.nudgeBattleVol(cmd.delta); else mixer.nudgeMusicVol(cmd.delta); return;
    case "battle.vol.nudge": mixer.nudgeBattleVol(cmd.delta); return;
    case "music.mute": mixer.toggleMute(); return;
    case "music.autofade": if (!mixer.isFading() && !inBattle()) await mixer.autofade(); return;
    case "deck.next": await decks.next(cmd.deck ?? heard()); return;
    case "ambient.vol.nudge": mixer.nudgeAmbientVol(cmd.delta); return;
    case "ambient.mute": mixer.toggleAmbientMute(); return;
    case "ambient.toggle": await layers.toggleAmbient(); return;
    case "sfx.play": await layers.playPad(cmd.soundId); return;
    case "sfx.vol.nudge": mixer.nudgeSfxVol(cmd.delta); return;
    case "sfx.mute": mixer.toggleSfxMute(); return;
    case "sfx.stop": await layers.stopPads(); return;
    case "panic": mixer.togglePanic(); return;
    case "scene.recall": await scenes.toggleScene(cmd.sceneId); return;
    case "scene.stack": await scenes.stackScene(cmd.sceneId); return;
    case "scene.combo": await scenes.playCombo(cmd.sceneIds); return;
    case "scene.vol.nudge": mixer.nudgeSceneVol(cmd.sceneId, cmd.delta); return;
    case "layer.toggle": await layers.toggleLayer(cmd.soundId); return;
    case "cue.go": {
      // A Go to Cue key on a stopped deck starts it on that cue.
      const deck = cmd.deck ?? heard();
      if (await decks.goToCue(deck, cmd.cue, cmd.when) && !decks.isPlaying(deck)) await decks.play(deck);
      return;
    }
    case "cue.next": await decks.stepDeckCue(cmd.deck ?? heard(), 1); return;
    case "cue.prev": await decks.stepDeckCue(cmd.deck ?? heard(), -1); return;
    case "combat.nextPhase": await decks.nextPhase(); return;
    case "track.set": await decks.setTrack(cmd.path, cmd.name); return;
  }
}
