/**
 * Dial 1 (Music) and Dial 3 (Ambient).
 */
import {
  SingletonAction, type Action, type DialDownEvent, type DialRotateEvent, type DialUpEvent, type TouchTapEvent, type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { ambientFeedback, musicFeedback, nextAmbientTarget, nextSceneOn, sceneMixFeedback, sceneMixTarget, sfxFeedback } from "../feedback";
import { PressTurn, otherMode, type DialMode } from "../gesture";
import { link } from "../plugin-link";

const UUID = "com.edenmichal.musicdeck";
/** Change per detent. A full turn of the fader is about 33 detents. */
const FADER_STEP = 0.03;
const VOLUME_STEP = 0.02;

type Settings = { mode?: DialMode };

export class MusicDial extends SingletonAction<Settings> {
  override readonly manifestId = `${UUID}.music`;
  #gestures = new Map<string, PressTurn>();
  #modes = new Map<string, DialMode>();

  constructor() {
    super();
    link.on("change", () => this.#renderAll());
  }

  #gesture(id: string): PressTurn {
    let g = this.#gestures.get(id);
    if (!g) this.#gestures.set(id, (g = new PressTurn()));
    return g;
  }

  #render(action: Action<Settings>): void {
    if (action.isDial()) action.setFeedback(musicFeedback(link, this.#modes.get(action.id) ?? "fade")).catch(() => {});
  }

  #renderAll(): void {
    for (const a of this.actions) this.#render(a);
  }

  override onWillAppear(ev: WillAppearEvent<Settings>): void {
    this.#modes.set(ev.action.id, ev.payload.settings.mode ?? "fade");
    this.#render(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
    this.#gestures.delete(ev.action.id);
  }

  override onDialDown(ev: DialDownEvent<Settings>): void {
    this.#gesture(ev.action.id).down();
  }

  override onDialRotate(ev: DialRotateEvent<Settings>): void {
    const id = ev.action.id;
    const what = this.#gesture(id).rotate(ev.payload.pressed);
    if (what === "switch") {
      const mode = otherMode(this.#modes.get(id) ?? "fade");
      this.#modes.set(id, mode);
      ev.action.setSettings({ ...ev.payload.settings, mode });
      return this.#render(ev.action);
    }
    if (what === "ignore") return;
    const fade = (this.#modes.get(id) ?? "fade") === "fade";
    // During combat the dial levels the Battle deck in either mode (A and B are paused under it).
    const sent = link.state?.battleDeck
      ? link.nudge("battle.vol.nudge", ev.payload.ticks * VOLUME_STEP)
      : fade
      ? link.nudge("fader.nudge", ev.payload.ticks * FADER_STEP)
      : link.nudge("music.vol.nudge", ev.payload.ticks * VOLUME_STEP);
    if (!sent) ev.action.showAlert();
  }

  override onDialUp(ev: DialUpEvent<Settings>): void {
    if (this.#gesture(ev.action.id).up() === "press" && !link.send({ type: "music.mute" })) ev.action.showAlert();
  }

  /** Tap: fade to the other deck. Long touch: next track on the deck you're hearing. */
  override onTouchTap(ev: TouchTapEvent<Settings>): void {
    // During combat there's no A/B fade: a tap skips the battle track too.
    const ok = ev.payload.hold || link.state?.battleDeck ? link.send({ type: "deck.next" }) : link.send({ type: "music.autofade" });
    if (!ok) ev.action.showAlert();
  }
}

/** How long the Ambient Dial is held to mute instead of stepping to the next scene. */
const MUTE_HOLD_MS = 500;

/**
 * Ambient (v2.36): turn for the level of what the strip shows, the whole Ambient level or one scene's. Press: step
 * to the next scene playing, then back to Ambient, so one dial mixes stacked scenes. Hold: mute. Tap the strip:
 * pause the layers or bring them back.
 */
export class AmbientDial extends SingletonAction {
  override readonly manifestId = `${UUID}.ambient`;
  /** The scene each dial is on (null: the whole Ambient level). */
  #target = new Map<string, string | null>();
  /** Per dial: the pending hold timer, or "muted" once the hold has fired. */
  #holds = new Map<string, NodeJS.Timeout | "muted">();

  constructor() {
    super();
    link.on("change", () => { for (const a of this.actions) this.#render(a); });
  }

  /** The dial's scene while it still plays, else null (Ambient). */
  #scene(id: string): string | null {
    const scene = this.#target.get(id) ?? null;
    return scene && link.state?.scenesOn.includes(scene) ? scene : null;
  }

  #render(action: Action<any>): void {
    if (action.isDial()) action.setFeedback(ambientFeedback(link, this.#scene(action.id))).catch(() => {});
  }

  override onWillAppear(ev: WillAppearEvent): void {
    this.#render(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.#target.delete(ev.action.id);
    const hold = this.#holds.get(ev.action.id);
    if (hold && hold !== "muted") clearTimeout(hold);
    this.#holds.delete(ev.action.id);
  }

  override onDialRotate(ev: DialRotateEvent): void {
    const scene = this.#scene(ev.action.id);
    const delta = ev.payload.ticks * VOLUME_STEP;
    const sent = scene ? link.nudgeScene(scene, delta) : link.nudge("ambient.vol.nudge", delta);
    if (!sent) ev.action.showAlert();
  }

  override onDialDown(ev: DialDownEvent): void {
    const timer = setTimeout(() => {
      this.#holds.set(ev.action.id, "muted");
      if (!link.send({ type: "ambient.mute" })) ev.action.showAlert();
    }, MUTE_HOLD_MS);
    this.#holds.set(ev.action.id, timer);
  }

  override onDialUp(ev: DialUpEvent): void {
    const hold = this.#holds.get(ev.action.id);
    this.#holds.delete(ev.action.id);
    if (hold === "muted") return;
    clearTimeout(hold);
    if (!link.state) return void ev.action.showAlert();
    this.#target.set(ev.action.id, nextAmbientTarget(link.state.scenesOn, this.#scene(ev.action.id)));
    this.#render(ev.action);
  }

  /** Tap: pause the layers, or bring back the ones that were on. */
  override onTouchTap(ev: TouchTapEvent): void {
    if (!link.send({ type: "ambient.toggle" })) ev.action.showAlert();
  }
}

export class SfxDial extends SingletonAction {
  override readonly manifestId = `${UUID}.sfxdial`;

  constructor() {
    super();
    link.on("change", () => { for (const a of this.actions) this.#render(a); });
  }

  #render(action: Action<any>): void {
    if (action.isDial()) action.setFeedback(sfxFeedback(link)).catch(() => {});
  }

  override onWillAppear(ev: WillAppearEvent): void {
    this.#render(ev.action);
  }

  override onDialRotate(ev: DialRotateEvent): void {
    if (!link.nudge("sfx.vol.nudge", ev.payload.ticks * VOLUME_STEP)) ev.action.showAlert();
  }

  override onDialDown(ev: DialDownEvent): void {
    if (!link.send({ type: "sfx.mute" })) ev.action.showAlert();
  }

  /** Tap: stop every SFX that's playing. */
  override onTouchTap(ev: TouchTapEvent): void {
    if (!link.send({ type: "sfx.stop" })) ev.action.showAlert();
  }
}

/**
 * Scene Mix (v2.34): one dial mixes stacked sound scenes. Turn: the level of the scene it's on. Press, or tap the
 * strip: step to the next scene that's playing. It starts on the first scene playing, and moves on by itself when
 * its scene stops.
 */
export class SceneMixDial extends SingletonAction {
  override readonly manifestId = `${UUID}.scenemix`;
  /** The scene each dial was stepped to. */
  #picked = new Map<string, string | null>();

  constructor() {
    super();
    link.on("change", () => { for (const a of this.actions) this.#render(a); });
  }

  #target(id: string): string | null {
    return sceneMixTarget(link.state?.scenesOn ?? [], this.#picked.get(id));
  }

  #render(action: Action<any>): void {
    if (action.isDial()) action.setFeedback(sceneMixFeedback(link, this.#target(action.id))).catch(() => {});
  }

  #next(action: Action<any>): void {
    const next = nextSceneOn(link.state?.scenesOn ?? [], this.#target(action.id));
    if (!next) {
      if (action.isDial()) action.showAlert();
      return;
    }
    this.#picked.set(action.id, next);
    this.#render(action);
  }

  override onWillAppear(ev: WillAppearEvent): void {
    this.#render(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.#picked.delete(ev.action.id);
  }

  override onDialRotate(ev: DialRotateEvent): void {
    const scene = this.#target(ev.action.id);
    if (!scene || !link.nudgeScene(scene, ev.payload.ticks * VOLUME_STEP)) ev.action.showAlert();
  }

  override onDialDown(ev: DialDownEvent): void {
    this.#next(ev.action);
  }

  override onTouchTap(ev: TouchTapEvent): void {
    this.#next(ev.action);
  }
}
