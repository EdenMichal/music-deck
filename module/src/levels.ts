/**
 * Levels that mean what they say (v2.35). Run once per world by the active GM:
 * - The mix's levels were dial positions on Foundry's curve (70% played at 0.59). They're plain gains now, so each
 *   saved level is converted to the gain it already played at: nothing gets louder or quieter.
 * - Deck tracks and SFX pads played at a hidden 80%. They have no level of their own, so they now play at full and
 *   the Music and SFX levels are the whole story.
 * - Ambient and SFX were on Foundry's Ambient and Interface volume sliders, the decks on its Music slider, so each
 *   browser's three sliders tipped the balance. All of Music Deck now follows Foundry's Music volume.
 * Ambient layers keep their own levels: they are gains already, only their % changes on screen.
 */
import { playlistFor } from "./channels";
import { MODULE_ID, RAMP, getMix, setMix } from "./live-gain";

const VERSION = "levelsVersion";

export function registerLevelSettings(): void {
  game.settings.register(MODULE_ID, VERSION, { scope: "world", config: false, type: Number, default: 0 });
}

/** The gain a dial position played at on Foundry's curve. */
export const curveToGain = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) ** 1.5 * 1000) / 1000;

export async function migrateLevels(): Promise<void> {
  if (!game.users.activeGM?.isSelf || (game.settings.get(MODULE_ID, VERSION) as number) >= 1) return;
  const mix = getMix();
  setMix({
    musicVol: curveToGain(mix.musicVol),
    ambientVol: curveToGain(mix.ambientVol),
    sfxVol: curveToGain(mix.sfxVol),
    sceneVols: Object.fromEntries(Object.entries(mix.sceneVols ?? {}).map(([id, v]) => [id, curveToGain(v)])),
  }, { ramp: RAMP.mute });
  for (const channel of ["A", "B", "sfx"] as const) {
    const p = playlistFor(channel);
    const updates = p?.sounds.filter((s: any) => s.volume !== 1).map((s: any) => ({ _id: s.id, volume: 1 })) ?? [];
    if (updates.length) await p.updateEmbeddedDocuments("PlaylistSound", updates);
  }
  for (const channel of ["ambient", "sfx"] as const) {
    const p = playlistFor(channel);
    if (p && p.channel !== "music") await p.update({ channel: "music" });
  }
  await game.settings.set(MODULE_ID, VERSION, 1);
}
