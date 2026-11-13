import { ensurePlaylists } from "./channels";
import { deckState, runCommand } from "./deck-handlers";
import { registerDuckSettings, startDuck } from "./duck";
import { onBattleTrackEnd, registerCombatSettings, startCombat } from "./combat";
import { registerGeneralSettings, startGeneral } from "./general";
import { registerDeckLinkSettings, updateDeckLink } from "./deck-client";
import { retryFailedSound } from "./failed-sound";
import * as decks from "./decks";
import { registerKeybindings } from "./keybindings";
import * as layers from "./layers";
import { migrateLevels, registerLevelSettings } from "./levels";
import { measureLater, registerMatchSettings, startMatching } from "./match";
import { MODULE_ID, attachGain, channelOf, getMix, readGains, registerLiveGainSettings, setMix, startLiveGain } from "./live-gain";
import { makeSeamless } from "./loop";
import { createCueSound, startCuePlayer } from "./cue-player";
import { clipsFor } from "./cue-clips";
import { getSheet, registerCueSettings, removeSheet, saveSheet } from "./cue-sheets";
import * as mixer from "./mixer";
import { registerPlayerSettings, startPlayers } from "./players";
import { startPreload } from "./preload";
import { registerSceneSound, startSceneSound } from "./scene-sound";
import * as scenes from "./scenes";
import { createTabClass, registerTabSettings } from "./ui/playlist-tab";
import { openTrackEditor } from "./ui/track-editor";

Hooks.once("init", () => {
  registerLiveGainSettings();
  registerLevelSettings();
  registerMatchSettings();
  registerKeybindings();
  registerTabSettings();
  registerDeckLinkSettings();
  mixer.registerMixerSettings();
  decks.registerDeckSettings();
  registerPlayerSettings();
  registerCombatSettings();
  registerGeneralSettings();
  registerDuckSettings();
  registerCueSettings();
  registerSceneSound();
  if (!game.settings.get(MODULE_ID, "useClassicTab")) CONFIG.ui.playlists = createTabClass(CONFIG.ui.playlists);

  // Foundry caches module.json until the world is relaunched; make sure the stylesheet is there either way.
  for (const file of ["music-deck.css", "track-editor.css"]) {
    const css = `modules/${MODULE_ID}/styles/${file}`;
    if (![...document.styleSheets].some(s => s.href?.endsWith(css))) {
      document.head.insertAdjacentHTML("beforeend", `<link rel="stylesheet" href="${css}">`);
    }
  }

  const BaseSound = CONFIG.PlaylistSound.documentClass;
  CONFIG.PlaylistSound.documentClass = class MusicDeckPlaylistSound extends BaseSound {
    _createSound() {
      // A file with cues plays through a CueSound (cue-sound.ts); anything else is Foundry's own Sound.
      const cueSound = createCueSound(this);
      const sound = cueSound ?? super._createSound();
      if (sound) attachGain(this, sound);
      if (sound && !cueSound && channelOf(this.parent) === "ambient") makeSeamless(sound);
      return sound;
    }

    sync() {
      // A file that failed to load gets one fresh try per play request (failed-sound.ts).
      retryFailedSound(this as any);
      return super.sync();
    }
  };

  const BasePlaylist = CONFIG.Playlist.documentClass;
  CONFIG.Playlist.documentClass = class MusicDeckPlaylist extends BasePlaylist {
    async _onSoundEnd(sound: any) {
      // Every GM's client hears a sound end. On Music Deck's playlists only the active GM acts on it: another GM
      // would otherwise start the next track too (Foundry's default), e.g. cutting combat's victory → fade back.
      if (channelOf(this) && !game.users.activeGM?.isSelf) return;
      if (await onBattleTrackEnd(this, sound)) return;
      if (await decks.onDeckTrackEnd(this, sound)) return;
      return super._onSoundEnd(sound);
    }
  };
});

Hooks.once("ready", async () => {
  startLiveGain();
  startDuck();
  startPlayers();
  startPreload();
  startCombat();
  startSceneSound();
  startCuePlayer();
  game.modules.get(MODULE_ID).api = { getMix, setMix, readGains, ...mixer, decks, layers, scenes,
    cues: { getSheet, saveSheet, removeSheet, goToCue: decks.goToCue, openEditor: openTrackEditor, loadClips: clipsFor },
    nextPhase: decks.nextPhase,
    // What a Stream Deck key press does, and what the deck is shown (for macros and tests).
    deck: { run: runCommand, state: deckState } };
  if (game.users.activeGM?.isSelf) {
    await ensurePlaylists();
    await decks.applyTrackFade();
    await scenes.migrateScenes();
    await migrateLevels();
  }
  startMatching();
  measureLater(layers.randomPadPaths());
  startGeneral();
  updateDeckLink();
  // Whoever runs the mixer holds the deck link; that changes as GMs come and go.
  Hooks.on("userConnected", () => updateDeckLink());
});
