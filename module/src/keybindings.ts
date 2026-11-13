/**
 * Keyboard fallback for when the Stream Deck isn't plugged in. No default keys, so nothing clashes
 * with other modules; the GM assigns them in Configure Controls.
 */
import { musicDeck, next } from "./decks";
import { MODULE_ID } from "./live-gain";
import { autofade, nudgeBattleVol, nudgeFader, nudgeMusicVol, toggleMute, togglePanic } from "./mixer";

/** Music up/down: the Battle deck's level during combat (v2.39), else the Music level. */
const nudgeMusic = (delta: number) => (musicDeck() === "battle" ? nudgeBattleVol(delta) : nudgeMusicVol(delta));

const FADER_STEP = 0.05;
const VOLUME_STEP = 0.05;

const BINDINGS: Record<string, { name: string; onDown: () => unknown; repeat?: boolean }> = {
  autofade: { name: "Auto-fade to the other deck", onDown: () => autofade() },
  faderLeft: { name: "Crossfader toward deck A", onDown: () => nudgeFader(-FADER_STEP), repeat: true },
  faderRight: { name: "Crossfader toward deck B", onDown: () => nudgeFader(FADER_STEP), repeat: true },
  musicDown: { name: "Music volume down", onDown: () => nudgeMusic(-VOLUME_STEP), repeat: true },
  musicUp: { name: "Music volume up", onDown: () => nudgeMusic(VOLUME_STEP), repeat: true },
  mute: { name: "Mute or unmute music", onDown: () => toggleMute() },
  panic: { name: "Panic: fade all Music Deck audio", onDown: () => togglePanic() },
  next: { name: "Next track on the deck you're hearing (the Battle deck during combat)", onDown: () => next(musicDeck()) },
};

export function registerKeybindings(): void {
  for (const [action, { name, onDown, repeat }] of Object.entries(BINDINGS)) {
    game.keybindings.register(MODULE_ID, action, {
      name,
      editable: [],
      restricted: true,
      repeat: !!repeat,
      onDown: () => {
        if (!game.users.activeGM?.isSelf) return false;
        onDown();
        return true;
      },
    });
  }
}
