import streamDeck from "@elgato/streamdeck";
import { AmbientDial, MusicDial, SceneMixDial, SfxDial } from "./actions/dials";
import { AmbientLayer, AutoFade, DeckNext, GoToCue, NextPhase, Panic, SceneCombo, SetTrack, SfxPad, SoundScene } from "./actions/keys";
import { link } from "./plugin-link";

streamDeck.logger.setLevel("info");

for (const action of [new MusicDial(), new AmbientDial(), new SfxDial(), new SceneMixDial(), new SfxPad(), new AutoFade(), new Panic(), new DeckNext(), new SetTrack(), new AmbientLayer(), new SoundScene(), new SceneCombo(), new GoToCue(), new NextPhase()]) {
  streamDeck.actions.registerAction(action);
}

await streamDeck.connect();
await link.start();
