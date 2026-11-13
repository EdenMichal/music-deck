/**
 * Duck music under SFX (Phase 5): while any SFX pad plays, the music decks dip to the duck level and come
 * back after. Every client works this out alone from Foundry's synced `playing` state, so no messages are sent.
 */
import { DUCK_RAMP, duckFactor } from "./crossfader";
import { playlistFor } from "./channels";
import { MIX_HOOK, MODULE_ID, channelOf, getDuck, getMix, setDuck } from "./live-gain";

export function registerDuckSettings(): void {
  game.settings.register(MODULE_ID, "duck", {
    name: "Duck music under SFX",
    hint: "While an SFX pad plays, the music dips, then comes back about a second after it ends. Ambience isn't ducked.",
    scope: "world", config: true, type: Boolean, default: true, onChange: () => updateDuck(),
  });
  game.settings.register(MODULE_ID, "duckLevel", {
    name: "Duck music to (%)",
    hint: "How loud the music stays while an SFX plays. 50% is about half as loud.",
    scope: "world", config: true, type: Number, range: { min: 0, max: 100, step: 5 }, default: 50, onChange: () => updateDuck(),
  });
}

const sfxPlaying = () => !!playlistFor("sfx")?.sounds.some((s: any) => s.playing);

export function updateDuck(): void {
  const factor = duckFactor(getMix(), {
    enabled: game.settings.get(MODULE_ID, "duck"),
    depth: game.settings.get(MODULE_ID, "duckLevel") / 100,
    sfxPlaying: sfxPlaying(),
  });
  setDuck(factor, factor < getDuck() ? DUCK_RAMP.attack : DUCK_RAMP.release);
}

export function startDuck(): void {
  const isSfx = (p: any) => channelOf(p) === "sfx";
  Hooks.on("updatePlaylistSound", (s: any) => isSfx(s.parent) && updateDuck());
  Hooks.on("deletePlaylistSound", (s: any) => isSfx(s.parent) && updateDuck());
  Hooks.on("updatePlaylist", (p: any) => isSfx(p) && updateDuck());
  Hooks.on(MIX_HOOK, () => updateDuck());
  updateDuck();
}
