/**
 * Key actions: SFX Pad, Auto-fade, Panic, Deck Next, Set Track, Ambient Layer, Sound Scene, Scene Combo,
 * Go to Cue and Next Phase.
 */
import {
  SingletonAction, type KeyAction, type KeyDownEvent, type KeyUpEvent, type SendToPluginEvent, type WillAppearEvent,
  type DidReceiveSettingsEvent, type DialAction,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import {
  comboKeyFace, comboSceneIds, cueKeyFace, cueKeyImage, fadeTarget, findKeyCue, keyDeck, nextPhaseFace, nextPhaseKeyCue,
  stepKeyCue, trackItems, trackKeyFace, type ComboSettings, type CueKeySettings, type KeyFace, type TrackKeySettings,
} from "../feedback";
import { link } from "../plugin-link";

const UUID = "com.edenmichal.musicdeck";
type AnyAction = KeyAction<any> | DialAction<any>;

/**
 * Base for keys whose face follows the link: re-render every visible key on each change.
 * While a browser waits to pair, every key shows the code, so it's visible whatever you placed first.
 */
abstract class LinkedKey<T extends Record<string, any> = Record<string, any>> extends SingletonAction<T> {
  constructor() {
    super();
    link.on("change", () => { for (const a of this.actions) if (a.isKey()) this.#show(a); });
  }

  abstract render(action: KeyAction<T>, settings?: T): void | Promise<void>;

  #show(action: KeyAction<T>, settings?: T): void {
    const shown = link.status === "pairing" && link.code ? action.setTitle(`Code\n${link.code}`) : this.render(action, settings);
    Promise.resolve(shown).catch(() => {});
  }

  override onWillAppear(ev: WillAppearEvent<T>): void {
    if (ev.action.isKey()) this.#show(ev.action, ev.payload.settings);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): void {
    if (ev.action.isKey()) this.#show(ev.action, ev.payload.settings);
  }

  protected alert(action: AnyAction): void {
    action.showAlert().catch(() => {});
  }
}

type PadSettings = { soundId?: string; name?: string };

export class SfxPad extends LinkedKey<PadSettings> {
  override readonly manifestId = `${UUID}.sfx`;

  async render(action: KeyAction<PadSettings>, settings?: PadSettings): Promise<void> {
    const s = settings ?? (await action.getSettings());
    const live = link.state?.sfx.find(x => x.id === s.soundId)?.name;
    // Keep the face after a rename in Foundry, and show the saved name while offline.
    if (live && live !== s.name) await action.setSettings({ ...s, name: live });
    await action.setTitle(s.soundId ? (live ?? s.name ?? "?") : "Pick\nsound");
  }

  override async onKeyDown(ev: KeyDownEvent<PadSettings>): Promise<void> {
    const { soundId } = ev.payload.settings;
    if (!soundId || !link.send({ type: "sfx.play", soundId })) this.alert(ev.action);
  }

  /** The property inspector's live dropdown (sdpi-select datasource="getSfx"). */
  override onSendToPlugin(ev: SendToPluginEvent<any, PadSettings>): void {
    const payload = ev.payload as { event?: string };
    if (payload?.event !== "getSfx") return;
    const items = link.state?.sfx.map(s => ({ label: s.name, value: s.id })) ?? [];
    streamDeck.ui.sendToPropertyInspector({
      event: "getSfx",
      items: items.length ? items : [{ label: link.status === "online" ? "No sounds in the SFX playlist yet" : "Connect Foundry first", value: "", disabled: true }],
    });
  }
}

export class AutoFade extends LinkedKey {
  override readonly manifestId = `${UUID}.autofade`;

  render(action: KeyAction<Record<string, any>>): Promise<void> {
    const s = link.state;
    return action.setTitle(link.status !== "online" ? "Fade" : s?.fading ? "Fading…" : `Fade\nto ${fadeTarget(s)}`);
  }

  override onKeyDown(ev: KeyDownEvent): void {
    if (!link.send({ type: "music.autofade" })) this.alert(ev.action);
  }
}

export class Panic extends LinkedKey {
  override readonly manifestId = `${UUID}.panic`;

  async render(action: KeyAction<Record<string, any>>): Promise<void> {
    const on = !!link.state?.panic;
    await action.setState(on ? 1 : 0);
    await action.setTitle(on ? "Bring\nback" : "Fade\nall");
  }

  override onKeyDown(ev: KeyDownEvent): void {
    if (!link.send({ type: "panic" })) this.alert(ev.action);
  }
}

type NextSettings = { deck?: "" | "A" | "B" };

export class DeckNext extends LinkedKey<NextSettings> {
  override readonly manifestId = `${UUID}.next`;

  async render(action: KeyAction<NextSettings>, settings?: NextSettings): Promise<void> {
    const deck = (settings ?? (await action.getSettings())).deck;
    await action.setTitle(deck ? `Next\n${deck}` : "Next\ntrack");
  }

  override onKeyDown(ev: KeyDownEvent<NextSettings>): void {
    const deck = ev.payload.settings.deck || undefined;
    if (!link.send({ type: "deck.next", deck })) this.alert(ev.action);
  }
}

/**
 * Set Track (protocol 8): fades the deck that's playing to one track from Foundry's Library, adding it to that
 * deck's queue unless it's there already; during a battle, the Battle deck. Lights while that track plays.
 */
export class SetTrack extends LinkedKey<TrackKeySettings> {
  override readonly manifestId = `${UUID}.track`;

  async render(action: KeyAction<TrackKeySettings>, settings?: TrackKeySettings): Promise<void> {
    const s = settings ?? (await action.getSettings());
    // Keep the name for the face while Foundry is away; the picker only saves the file.
    const live = s.path ? link.library?.find(t => t.path === s.path)?.name : undefined;
    if (live && live !== s.name) await action.setSettings({ ...s, name: live });
    const face = trackKeyFace(link, s, link.library);
    await action.setState(face.lit ? 1 : 0);
    await action.setTitle(face.title);
  }

  override onKeyDown(ev: KeyDownEvent<TrackKeySettings>): void {
    const { path, name } = ev.payload.settings;
    if (!path || !link.send({ type: "track.set", path, name })) this.alert(ev.action);
  }

  /** The property inspector's live dropdown (sdpi-select datasource="getTracks"), grouped by playlist or folder. */
  override onSendToPlugin(ev: SendToPluginEvent<any, TrackKeySettings>): void {
    const payload = ev.payload as { event?: string };
    if (payload?.event !== "getTracks") return;
    const items = trackItems(link.library ?? []);
    streamDeck.ui.sendToPropertyInspector({
      event: "getTracks",
      items: items.length ? items : [{ label: link.status === "online" ? "No tracks yet: add some to a playlist or to Data/music/" : "Connect Foundry first", value: "", disabled: true }],
    });
  }
}

type LayerSettings = { soundId?: string; name?: string };

/** Switches one ambient layer on or off (fading), and lights up while it plays, however it was started. */
export class AmbientLayer extends LinkedKey<LayerSettings> {
  override readonly manifestId = `${UUID}.layer`;

  async render(action: KeyAction<LayerSettings>, settings?: LayerSettings): Promise<void> {
    const s = settings ?? (await action.getSettings());
    const layer = link.state?.ambient.layers.find(x => x.id === s.soundId);
    if (layer && layer.name !== s.name) await action.setSettings({ ...s, name: layer.name });
    await action.setState(layer?.on ? 1 : 0);
    await action.setTitle(s.soundId ? (layer?.name ?? s.name ?? "?") : "Pick\nlayer");
  }

  override async onKeyDown(ev: KeyDownEvent<LayerSettings>): Promise<void> {
    const { soundId } = ev.payload.settings;
    const known = !link.state || link.state.ambient.layers.some(l => l.id === soundId);
    if (!soundId || !known || !link.send({ type: "layer.toggle", soundId })) this.alert(ev.action);
  }

  /** The property inspector's live dropdown (sdpi-select datasource="getLayers"). */
  override onSendToPlugin(ev: SendToPluginEvent<any, LayerSettings>): void {
    const payload = ev.payload as { event?: string };
    if (payload?.event !== "getLayers") return;
    const items = link.state?.ambient.layers.map(l => ({ label: l.scene ? `${l.scene} › ${l.name}` : l.name, value: l.id })) ?? [];
    streamDeck.ui.sendToPropertyInspector({
      event: "getLayers",
      items: items.length ? items : [{ label: link.status === "online" ? "No ambient layers yet: add some from the Library" : "Connect Foundry first", value: "", disabled: true }],
    });
  }
}

type SceneSettings = { sceneId?: string; name?: string };

/** How long a Sound Scene key is held to stack its scene on top instead of switching to it. */
const STACK_HOLD_MS = 500;

/**
 * Fades Foundry's ambient layers to a sound scene (Phase 4). Hold it to stack the scene on top of what's playing
 * (or, if it's on, fade just that scene out), so several scenes can play at once. Made to sit in a Stream Deck
 * Multi Action next to the Philips Hue "Set Scene", so one key sets the lights and the sound. A Multi Action only
 * presses, so there it switches at once.
 */
export class SoundScene extends LinkedKey<SceneSettings> {
  override readonly manifestId = `${UUID}.scene`;
  /** Per key: the pending hold timer, or "stacked" once the hold has fired. */
  #holds = new Map<string, NodeJS.Timeout | "stacked">();

  async render(action: KeyAction<SceneSettings>, settings?: SceneSettings): Promise<void> {
    const s = settings ?? (await action.getSettings());
    const live = link.state?.scenes.find(x => x.id === s.sceneId)?.name;
    if (live && live !== s.name) await action.setSettings({ ...s, name: live });
    await action.setState(s.sceneId && link.state?.scenesOn.includes(s.sceneId) ? 1 : 0);
    await action.setTitle(s.sceneId ? (live ?? s.name ?? "?") : "Pick a\nscene");
  }

  override onKeyDown(ev: KeyDownEvent<SceneSettings>): void {
    if (ev.action.isInMultiAction()) return this.#send(ev.action, ev.payload.settings, "scene.recall");
    const timer = setTimeout(() => {
      this.#holds.set(ev.action.id, "stacked");
      this.#send(ev.action, ev.payload.settings, "scene.stack");
    }, STACK_HOLD_MS);
    this.#holds.set(ev.action.id, timer);
  }

  override onKeyUp(ev: KeyUpEvent<SceneSettings>): void {
    if (ev.action.isInMultiAction()) return;
    const hold = this.#holds.get(ev.action.id);
    this.#holds.delete(ev.action.id);
    if (hold === "stacked") return;
    clearTimeout(hold);
    this.#send(ev.action, ev.payload.settings, "scene.recall");
  }

  #send(action: AnyAction, { sceneId }: SceneSettings, type: "scene.recall" | "scene.stack"): void {
    // A scene deleted in Foundry: warn instead of doing nothing.
    const known = !link.state || link.state.scenes.some(s => s.id === sceneId);
    if (!sceneId || !known || !link.send({ type, sceneId })) this.alert(action);
  }

  /** The property inspector's live dropdown (sdpi-select datasource="getScenes"). */
  override onSendToPlugin(ev: SendToPluginEvent<any, SceneSettings>): void {
    sendScenes(ev.payload);
  }
}

/** Foundry's sound scenes for a property inspector's list (datasource="getScenes"): Sound Scene and Scene Combo. */
function sendScenes(payload: unknown): void {
  if ((payload as { event?: string })?.event !== "getScenes") return;
  const items = link.state?.scenes.map(s => ({ label: s.name, value: s.id })) ?? [];
  streamDeck.ui.sendToPropertyInspector({
    event: "getScenes",
    items: items.length ? items : [{ label: link.status === "online" ? "No scenes yet: make one in Foundry's Ambient tab" : "Connect Foundry first", value: "", disabled: true }],
  });
}

/**
 * Scene Combo (v2.37): two or more sound scenes with one press, sent as one "scene.combo" command. Foundry plays them
 * together and fades out everything else, General layers too; pressed while exactly those scenes play, it fades them
 * out. Lit while all of its scenes play. In or out of a Multi Action it does the same, so a Multi Action holds the
 * Hue Set Scene plus one Scene Combo.
 */
export class SceneCombo extends LinkedKey<ComboSettings> {
  override readonly manifestId = `${UUID}.combo`;

  async render(action: KeyAction<ComboSettings>, settings?: ComboSettings): Promise<void> {
    const s = settings ?? (await action.getSettings());
    // Keep each scene's name, so the face survives a rename in Foundry and shows names while offline.
    const live = link.state?.scenes.filter(x => s.sceneIds?.includes(x.id)) ?? [];
    if (live.some(x => s.names?.[x.id] !== x.name)) {
      await action.setSettings({ ...s, names: { ...s.names, ...Object.fromEntries(live.map(x => [x.id, x.name])) } });
    }
    const face = comboKeyFace(link, s);
    await action.setState(face.lit ? 1 : 0);
    await action.setTitle(face.title);
  }

  override onKeyDown(ev: KeyDownEvent<ComboSettings>): void {
    // Scenes deleted in Foundry are skipped; with none left, warn instead of doing nothing.
    const sceneIds = comboSceneIds(link.state, ev.payload.settings);
    if (!sceneIds.length || !link.send({ type: "scene.combo", sceneIds })) this.alert(ev.action);
  }

  /** The property inspector's live checkbox list (sdpi-checkbox-list datasource="getScenes"). */
  override onSendToPlugin(ev: SendToPluginEvent<any, ComboSettings>): void {
    sendScenes(ev.payload);
  }
}

// ── Cues (protocol 5, track editor) ──────────────────────────────────

const BLINK_MS = 450;
/** How long a Go to Cue key is held to switch now instead of at the end of the loop. */
const NOW_HOLD_MS = 500;

/** A key whose face is a KeyFace: state 1 when lit, and blinking between 0 and 1 while a cue switch waits. */
abstract class FaceKey<T extends Record<string, any>> extends LinkedKey<T> {
  #blink: NodeJS.Timeout | undefined;
  #on = false;
  #shown = new Map<string, { action: KeyAction<T>; face: KeyFace }>();
  /** The colour each key is drawn in now ("" for the manifest's images). */
  #painted = new Map<string, string>();

  abstract face(settings: T): KeyFace;

  async render(action: KeyAction<T>, settings?: T): Promise<void> {
    const face = this.face(settings ?? (await action.getSettings()));
    this.#shown.set(action.id, { action, face });
    const color = face.color ?? "";
    if (this.#painted.get(action.id) !== color) {
      this.#painted.set(action.id, color);
      await action.setImage(color ? cueKeyImage(color, false) : undefined, { state: 0 });
      await action.setImage(color ? cueKeyImage(color, true) : undefined, { state: 1 });
    }
    await action.setTitle(face.title);
    await action.setState(face.blink ? (this.#on ? 1 : 0) : face.lit ? 1 : 0);
    this.#tick();
  }

  override onWillDisappear(ev: { action: { id: string } }): void {
    this.#shown.delete(ev.action.id);
    this.#painted.delete(ev.action.id);
    this.#tick();
  }

  /** Run the blink timer only while some visible key is blinking. */
  #tick(): void {
    const blinking = [...this.#shown.values()].some(x => x.face.blink);
    if (blinking && !this.#blink) {
      this.#blink = setInterval(() => {
        this.#on = !this.#on;
        for (const { action, face } of this.#shown.values()) if (face.blink) action.setState(this.#on ? 1 : 0).catch(() => {});
      }, BLINK_MS);
    } else if (!blinking && this.#blink) {
      clearInterval(this.#blink);
      this.#blink = undefined;
    }
  }
}

/**
 * Go to Cue: a pad number or a cue name, so a "Phase 2" key works on every track with a Phase 2. Press: the
 * transition set in Foundry (end of the loop for music). Hold: now, with a short crossfade. Or step to the
 * next or previous cue.
 */
export class GoToCue extends FaceKey<CueKeySettings> {
  override readonly manifestId = `${UUID}.cue`;
  #holds = new Map<string, NodeJS.Timeout | "sent">();

  face(settings: CueKeySettings): KeyFace {
    return cueKeyFace(link, settings);
  }

  override onKeyDown(ev: KeyDownEvent<CueKeySettings>): void {
    const s = ev.payload.settings;
    if ((s.mode ?? "cue") !== "cue" || ev.action.isInMultiAction()) {
      this.#go(ev.action, s);
      return;
    }
    const timer = setTimeout(() => {
      this.#holds.set(ev.action.id, "sent");
      if (this.#go(ev.action, s, "now")) ev.action.showOk().catch(() => {});
    }, NOW_HOLD_MS);
    this.#holds.set(ev.action.id, timer);
  }

  override onKeyUp(ev: KeyUpEvent<CueKeySettings>): void {
    const hold = this.#holds.get(ev.action.id);
    if (hold === undefined) return;
    this.#holds.delete(ev.action.id);
    if (hold === "sent") return;
    clearTimeout(hold);
    this.#go(ev.action, ev.payload.settings);
  }

  #go(action: AnyAction, s: CueKeySettings, when?: "now"): boolean {
    const mode = s.mode ?? "cue";
    const deck = s.deck || undefined;
    // With Foundry's state in hand, refuse a cue the track doesn't have instead of doing nothing.
    const cues = link.state ? keyDeck(link.state, s.deck).cue : undefined;
    const known = cues === undefined || !!(mode === "cue" ? findKeyCue(cues, s.cue) : stepKeyCue(cues, mode === "next" ? 1 : -1));
    const ref = s.cue?.trim() ?? "";
    const sent = known && (mode === "cue"
      ? !!ref && link.send({ type: "cue.go", deck, cue: /^\d+$/.test(ref) ? Number(ref) : ref, when })
      : link.send({ type: mode === "next" ? "cue.next" : "cue.prev", deck }));
    if (!sent) this.alert(action);
    return sent;
  }
}

/** Next Phase: the next battle cue of the track you're hearing, at the end of its loop. */
export class NextPhase extends FaceKey<Record<string, any>> {
  override readonly manifestId = `${UUID}.phase`;

  face(): KeyFace {
    return nextPhaseFace(link);
  }

  override onKeyDown(ev: KeyDownEvent): void {
    const known = !link.state || !!nextPhaseKeyCue(keyDeck(link.state).cue);
    if (!known || !link.send({ type: "combat.nextPhase" })) this.alert(ev.action);
  }
}
