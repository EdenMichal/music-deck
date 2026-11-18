/**
 * The redesigned Playlists sidebar tab. GMs get the Music Deck view; players and the
 * "Classic playlists view" toggle get core's parts. "Open big mixer" is core's renderPopout().
 */
import { DECKS, endModeOf, playModeOf, playlistFor, trackName } from "../channels";
import { LINK_HOOK, askForCode } from "../deck-client";
import { battleGain, channelGains, deckGains, type DeckId, type PlayDeck } from "../crossfader";
import * as decks from "../decks";
import { followsFolder, generalSource, setGeneralSource } from "../general";
import * as layers from "../layers";
import { addToBattle, battleIsDefault, battleSource, endBattle, inBattle, reloadBattle, setBattleSource, startBattle } from "../combat";
import { libraryScannedAt, loadDuration, scanLibrary, togglePreview } from "../library";
import { defaultSource, tracksFor } from "../library-sources";
import { MIX_HOOK, MODULE_ID, getMix } from "../live-gain";
import * as mixer from "../mixer";
import { HEARING_HOOK, setPlayMode, type PlayMode } from "../players";
import * as scenes from "../scenes";
import { HISTORY_HOOK, History } from "../history";
import { editScene } from "./scene-editor";
import { openTrackEditor } from "./track-editor";
import { getSheet } from "../cue-sheets";
import { CUE_PLAYING_HOOK, cueOf } from "../cue-player";
import {
  GENERAL_FOLD, ambientContext, ambientTargetOf, battleSummary, deckCard, saveSceneFolds, savedSceneFolds, decksSummary, fadeTarget, formatTime, saveFolds, savedFolds, volumesSummary, type Fold, libraryContext, libraryListContext, musicContext, nowContext, saveSource, savedSource, sfxContext,
  type UiState, type View,
} from "./view-model";

const T = (name: string) => `modules/${MODULE_ID}/templates/${name}.hbs`;
const CLASSIC_SETTING = "classicView";

const MD_PARTS = {
  now: { template: T("now"), scrollable: [""] },
  tabs: { template: T("tabs") },
  music: { template: T("music"), scrollable: [""] },
  ambient: { template: T("ambient"), scrollable: [""] },
  sfx: { template: T("sfx"), scrollable: [""] },
  library: { template: T("library") },
  libraryList: { template: T("library-list"), scrollable: [""] },
  footer: { template: T("footer") },
};
/** Each tab's icon matches its channel's icon in the level strips (Library has none). */
const VIEW_ICONS: Record<View, string> = { music: "fa-music", ambient: "fa-cloud-rain", sfx: "fa-bell", library: "fa-folder-open" };
const VIEW_PARTS: Record<View, string[]> = {
  music: ["music"], ambient: ["ambient"], sfx: ["sfx"], library: ["library", "libraryList"],
};

type Handler = (this: any, event: Event, target: HTMLElement) => unknown;
const act = (fn: (app: any, target: HTMLElement, event: Event) => unknown): Handler =>
  function (this: any, event, target) { return fn(this, target, event); };
const deckOf = (t: HTMLElement) => t.closest<HTMLElement>("[data-deck]")!.dataset.deck as PlayDeck;
/** A/B only, for what the Battle deck doesn't have (Cue on the other deck, the queue tabs). */
const abDeckOf = (t: HTMLElement): DeckId | null => { const d = deckOf(t); return d === "battle" ? null : d; };
const soundOf = (t: HTMLElement) => t.closest<HTMLElement>("[data-sound-id]")!.dataset.soundId!;
const pathOf = (t: HTMLElement) => t.closest<HTMLElement>("[data-path]")!.dataset.path!;
const sceneOf = (t: HTMLElement) => t.closest<HTMLElement>("[data-scene-id]")!.dataset.sceneId!;
const nodeOf = (t: HTMLElement) => t.closest<HTMLElement>("[data-node]")!.dataset.node!;
/** Open the track editor for a queue row (its sound's file) or a Library row (its path). */
function editCues(t: HTMLElement): void {
  const id = t.closest<HTMLElement>("[data-sound-id]")?.dataset.soundId;
  // A deck card, queue row, ambient layer or SFX pad knows its sound; a Library row knows its path.
  const sound = id && ([...DECKS, "ambient", "sfx"] as const).map(c => playlistFor(c)?.sounds.get(id)).find(Boolean);
  const path = sound ? sound.path : t.closest<HTMLElement>("[data-path]")?.dataset.path;
  if (path) openTrackEditor(path, trackName(path));
}

const cueIdOf = (t: HTMLElement) => t.closest<HTMLElement>("[data-cue]")!.dataset.cue!;

const nameOf = (t: HTMLElement) => t.closest<HTMLElement>("[data-name]")?.dataset.name;

export function registerTabSettings(): void {
  game.settings.register(MODULE_ID, "useClassicTab", {
    name: "Use classic Playlists tab",
    hint: "Turn off the Music Deck Playlists tab and use Foundry's own. The decks, Stream Deck and keybindings still work.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: true,
  });
  game.settings.register(MODULE_ID, CLASSIC_SETTING, { scope: "client", config: false, type: Boolean, default: false });
}

export function createTabClass(Base: any) {
  return class MusicDeckDirectory extends Base {
    static DEFAULT_OPTIONS = {
      classes: ["music-deck-tab"],
      renderUpdateKeys: ["flags", "volume"],
      actions: {
        mdView: act((app, t) => app.showView(t.dataset.view as View)),
        mdFold: act((app, t) => app.toggleFold(t.dataset.fold as Fold)),
        mdQueue: act((app, t) => { app.ui.queue = t.dataset.deck as DeckId; app.render({ parts: ["music"] }); }),
        mdPanic: act(() => mixer.togglePanic()),
        mdFade: act(() => mixer.autofade()),
        mdMute: act(() => mixer.toggleMute()),
        mdDeckPlay: act((_app, t) => deckPlay(deckOf(t))),
        mdDeckNext: act((_app, t) => decks.next(deckOf(t))),
        mdBattleBack: act(() => endBattle()),
        mdBattleReload: act(() => reloadBattle()),
        mdPlayNow: act((_app, t) => playNow(deckOf(t), soundOf(t))),
        mdCue: act((_app, t) => { const d = abDeckOf(t); return d && decks.cueOnOther(d, soundOf(t)); }),
        mdRemove: act((app, t) => removeUndoably(app, deckOf(t), soundOf(t), deckOf(t) === "battle" ? "the Battle deck" : `Deck ${deckOf(t)}`)),
        mdEditCues: act((_app, t) => editCues(t)),
        mdNextPhase: act((_app, t) => decks.nextPhase(deckOf(t))),
        mdGoCue: act((_app, t, e) => decks.goToCue(deckOf(t), cueIdOf(t), (e as MouseEvent).shiftKey ? "now" : undefined)),
        mdLibCues: act((app, t) => { const path = pathOf(t); app.ui.openCues = app.ui.openCues === path ? undefined : path; app.render({ parts: ["libraryList"] }); }),
        mdLibAddCue: act((app, t) => libraryAdd(app, t.dataset.channel!, pathOf(t), nameOf(t), cueIdOf(t))),
        mdAmbToggle: act(() => layers.toggleAmbient()),
        mdAmbMute: act(() => mixer.toggleAmbientMute()),
        mdSfxMute: act(() => mixer.toggleSfxMute()),
        mdLayer: act((_app, t) => layers.toggleLayer(soundOf(t))),
        mdRemoveSound: act((app, t) => removeSound(app, t)),
        mdUndo: act((app) => undoOrRedo(app, "undo")),
        mdRedo: act((app) => undoOrRedo(app, "redo")),
        mdPad: act((_app, t) => layers.playPad(soundOf(t))),
        mdPreview: act(async (app, t) => { await togglePreview(pathOf(t)); app.render({ parts: ["libraryList"] }); }),
        mdSource: act((app, t) => { app.ui.source = t.dataset.source; app.ui.at = ""; app.ui.query = ""; saveSource(app.ui.source); app.render({ parts: ["library", "libraryList"] }); }),
        mdCrumb: act((app, t) => app.openNode(t.dataset.node)),
        mdOpen: act((app, t) => app.openNode(nodeOf(t))),
        mdAddAll: act((_app, t) => addAll(t.dataset.deck as DeckId, nodeOf(t))),
        mdRandomPad: act((_app, t) => randomPad(nodeOf(t))),
        mdLibAdd: act((app, t) => libraryAdd(app, t.dataset.channel!, pathOf(t), nameOf(t))),
        mdRescan: act(async (app) => { await scanLibrary(); app.render({ parts: ["library", "libraryList"] }); }),
        mdGoLibrary: act((app) => app.showView("library")),
        mdClassic: act((app) => app.setClassic(true)),
        mdDeckView: act((app) => app.setClassic(false)),
        mdPopout: act((app) => app.renderPopout()),
        mdPairDeck: act(() => askForCode()),
        mdPlayMode: act((_app, t) => setPlayMode(t.dataset.mode as PlayMode)),
        mdDeckMode: act((_app, t) => toggleDeckMode(deckOf(t), t.dataset.mode!)),
        mdScene: act((_app, t, e) => ((e as MouseEvent).shiftKey ? scenes.stackScene(sceneOf(t)) : scenes.toggleScene(sceneOf(t)))),
        mdSceneFold: act((app, t) => app.toggleScene(sceneOf(t))),
        mdGeneralFold: act(app => app.toggleGeneral()),
        mdSceneAdd: act((app, t) => { app.ui.ambientTarget = sceneOf(t); return app.showView("library"); }),
        mdSaveScene: act(() => editScene()),
        mdEditScene: act((_app, t) => editScene(sceneOf(t))),
      },
    };

    ui: UiState = { view: "music", queue: "A", query: "", source: savedSource() ?? defaultSource(), at: "" };
    #dragging = false;
    #pendingRender = false;
    #mixHook?: number;
    #linkHook?: number;
    #hearingHook?: number;
    #historyHook?: number;
    #undoHadFocus = false;
    #cueHooks: [string, number][] = [];
    #ticker?: ReturnType<typeof setInterval>;

    get deckView(): boolean {
      return game.user.isGM && !game.settings.get(MODULE_ID, CLASSIC_SETTING);
    }

    get title(): string {
      return this.isPopout && this.deckView ? "Music Deck" : super.title;
    }

    _configureRenderParts(options: any) {
      if (!this.deckView) return super._configureRenderParts(options);
      const parts: any = foundry.utils.deepClone(MD_PARTS);
      Object.values(parts).forEach((p: any) => (p.templates ??= []));
      return parts;
    }

    /** Hold re-renders while a slider is being dragged, so the drag isn't cut off. */
    render(options: any = {}, _options?: any) {
      if (this.#dragging && this.rendered && this.deckView) {
        this.#pendingRender = true;
        return this;
      }
      return super.render(options, _options);
    }

    async _preparePartContext(partId: string, context: any, options: any) {
      context = await super._preparePartContext(partId, context, options);
      if (!this.deckView) return context;
      const viewOf = (Object.keys(VIEW_PARTS) as View[]).find(v => VIEW_PARTS[v].includes(partId));
      const part = (() => {
        switch (partId) {
          case "now": return nowContext();
          case "tabs": return { folded: !!savedFolds().view, views: (["music", "ambient", "sfx", "library"] as View[]).map(id => ({ id, label: id === "sfx" ? "SFX" : id[0].toUpperCase() + id.slice(1), icon: VIEW_ICONS[id], active: id === this.ui.view })) };
          case "music": return musicContext(this.ui);
          case "ambient": return ambientContext();
          case "sfx": return sfxContext();
          case "library": return libraryContext(this.ui);
          case "libraryList": return libraryListContext(this.ui);
          case "footer": return { popout: this.isPopout, ...historyContext() };
        }
      })();
      return Object.assign(context, part, { hidden: viewOf ? viewOf !== this.ui.view || !!savedFolds().view : false });
    }

    async _onFirstRender(context: any, options: any) {
      await super._onFirstRender(context, options);
      this.#mixHook = Hooks.on(MIX_HOOK, () => this.syncLive());
      this.#linkHook = Hooks.on(LINK_HOOK, () => this.deckView && this.render({ parts: ["now"] }));
      this.#hearingHook = Hooks.on(HEARING_HOOK, () => this.deckView && this.render({ parts: ["now"] }));
      this.#historyHook = Hooks.on(HISTORY_HOOK, () => this.deckView && this.render({ parts: ["footer"] }));
      // ⌘Z / Ctrl+Z (and ⇧ for redo) while focus is in the tab. Stops here so Foundry's canvas undo doesn't also run.
      this.element.addEventListener("keydown", (e: KeyboardEvent) => {
        if (!this.deckView || !(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "z") return;
        if ((e.target as HTMLElement).closest("input:not([type=range]), textarea, [contenteditable]")) return;
        e.preventDefault();
        e.stopPropagation();
        undoOrRedo(this, e.shiftKey ? "redo" : "undo");
      });
      this.#ticker = setInterval(() => this.syncLive(), 1000);
      const menu = (selector: string, items: any[], onOpen?: (t: HTMLElement) => void) =>
        new foundry.applications.ux.ContextMenu.implementation(this.element, selector, items, { jQuery: false, fixed: true, onOpen });
      // A cue chip sits inside a deck card, so its menu is registered first and wins.
      menu(".md-cue[data-cue]", cueChipMenu());
      const queueItems: any[] = [];
      menu(".md-queue .md-row", queueItems, t => queueMenu(t, queueItems));
      menu(".md-deck[data-sound-id], .md-pad-wrap", [editCuesItem()]);
      const layerItems: any[] = [];
      menu(".md-layer", layerItems, t => layerMenu(t, layerItems));
      this.#cueHooks = [
        [CUE_PLAYING_HOOK, Hooks.on(CUE_PLAYING_HOOK, () => this.deckView && this.render({ parts: ["now"] }))],
        ["musicDeck.cueSheets", Hooks.on("musicDeck.cueSheets", () => this.deckView && this.render({ parts: ["now", "music", "libraryList"] }))],
      ];
      new foundry.applications.ux.ContextMenu.implementation(this.element, ".md-scene-group[data-scene-id] .md-scene-head", sceneMenu(), { jQuery: false, fixed: true });
      new foundry.applications.ux.ContextMenu.implementation(this.element, ".md-lib-folder", battleMenu(), { jQuery: false, fixed: true });
    }

    _onClose(options: any) {
      super._onClose(options);
      Hooks.off(MIX_HOOK, this.#mixHook);
      Hooks.off(LINK_HOOK, this.#linkHook);
      Hooks.off(HEARING_HOOK, this.#hearingHook);
      Hooks.off(HISTORY_HOOK, this.#historyHook);
      for (const [h, id] of this.#cueHooks) Hooks.off(h, id);
      this.#cueHooks = [];
      clearInterval(this.#ticker);
    }

    async _preRender(context: any, options: any) {
      await super._preRender(context, options);
      this.#undoHadFocus = !!this.element?.querySelector(".md-undo")?.contains(document.activeElement);
    }

    async _onRender(context: any, options: any) {
      await super._onRender(context, options);
      const el: HTMLElement = this.element;
      // Parts from the other view (classic ⇄ deck) linger after a switch; drop them.
      const parts = Object.keys(this._configureRenderParts(options));
      for (const child of el.querySelectorAll<HTMLElement>(":scope > [data-application-part]")) {
        if (!parts.includes(child.dataset.applicationPart!)) child.remove();
      }
      el.classList.toggle("md-deck-view", this.deckView);
      if (!this.deckView) {
        if (game.user.isGM && !el.querySelector(".md-back")) {
          el.insertAdjacentHTML("afterbegin", `<button type="button" class="md-back" data-action="mdDeckView"><i class="fa-solid fa-sliders" aria-hidden="true"></i> Music Deck view</button>`);
        }
        return;
      }
      el.querySelector(".md-back")?.remove();
      this.bindSliders(el);
      this.bindQueueDrag(el);
      this.bindLibraryInputs(el);
      // A remove re-renders the list and the footer, in either order, and later renders can replace the footer
      // again; each would drop focus to the page, where ⌘Z means Foundry's own undo. Keep it on Undo/Redo.
      const undoBtn = el.querySelector<HTMLElement>(".md-undo-btn:not(:disabled)") ?? el.querySelector<HTMLElement>(".md-redo-btn:not(:disabled)");
      const justActed = focusUndoIn?.app === this && Date.now() < focusUndoIn.until;
      if ((justActed || this.#undoHadFocus) && undoBtn) {
        const owner = document.activeElement;
        if (!owner || owner === document.body || el.contains(owner)) undoBtn.focus({ preventScroll: true });
      }
      this.loadVisibleDurations(el);
      this.syncLive();
    }

    /** Fold or unfold a section. Volumes and Decks fold in place; the tab's list needs its parts re-rendered. */
    toggleFold(fold: Fold) {
      const folds = savedFolds();
      folds[fold] = !folds[fold];
      saveFolds(folds);
      if (fold === "view") return this.render({ parts: ["tabs", ...Object.values(VIEW_PARTS).flat()] });
      const section = this.element.querySelector(`[data-fold-sec=${fold}]`);
      section?.classList.toggle("is-folded", folds[fold]);
      section?.querySelector(".md-fold")?.setAttribute("aria-expanded", String(!folds[fold]));
    }

    /** Open or close a scene in the Ambient tab, in place, and remember it on this browser. */
    toggleScene(id: string) {
      this.toggleGroup(this.element.querySelector(`.md-scene-group[data-scene-id="${id}"]`), id);
    }

    /** Open or close the Ambient tab's General section, like a scene. */
    toggleGeneral() {
      this.toggleGroup(this.element.querySelector(".md-scene-group[data-general]"), GENERAL_FOLD);
    }

    toggleGroup(group: HTMLElement | null, id: string) {
      if (!group) return;
      const open = !group.classList.contains("open");
      group.classList.toggle("open", open);
      group.querySelector(".md-scene-layers")?.toggleAttribute("hidden", !open);
      group.querySelector(".md-scene-fold")?.setAttribute("aria-expanded", String(open));
      saveSceneFolds({ ...savedSceneFolds(), [id]: open });
    }

    async showView(view: View) {
      this.ui.view = view;
      // Back in Ambient, ＋Amb goes back to adding to the scene that's on.
      if (view === "ambient") this.ui.ambientTarget = undefined;
      // Choosing a tab opens a folded list.
      const folds = savedFolds();
      if (folds.view) { folds.view = false; saveFolds(folds); }
      await this.render({ parts: ["tabs", ...Object.values(VIEW_PARTS).flat()] });
      // First visit on this browser: build the index without making the GM press Rescan.
      if (view === "library" && !libraryScannedAt()) {
        await scanLibrary();
        this.render({ parts: ["library", "libraryList"] });
      }
    }

    /** Library: open a folder or playlist (or go back up to one from the breadcrumb). */
    openNode(id: string) {
      this.ui.at = id;
      this.ui.query = "";
      return this.render({ parts: ["library", "libraryList"] });
    }

    async setClassic(classic: boolean) {
      await game.settings.set(MODULE_ID, CLASSIC_SETTING, classic);
      this.render({ force: true });
      this.popout?.render({ force: true });
    }

    /**
     * The open queue's playing row and "next" tag, kept in step with its deck. The queue part doesn't re-render
     * when a track starts, pauses or stops, so without this the tag can sit on the track that's playing.
     */
    syncQueue(el: HTMLElement) {
      const queue = el.querySelector<HTMLElement>(".md-queue[data-deck]");
      if (!queue) return;
      const info = deckCard(queue.dataset.deck as DeckId);
      for (const row of queue.querySelectorAll<HTMLElement>(".md-row")) {
        const current = row.dataset.soundId === info.soundId;
        const playing = current && info.state === "playing";
        row.classList.toggle("current", current);
        if (row.classList.contains("playing") !== playing) {
          row.classList.toggle("playing", playing);
          row.querySelector(".md-num")!.innerHTML = playing
            ? '<i class="fa-solid fa-volume-high" aria-label="Playing"></i>'
            : String(Number(row.dataset.index) + 1);
        }
        const tag = row.querySelector(".md-next");
        const next = current && info.state === "cued";
        if (next && !tag) row.querySelector(".md-name")!.insertAdjacentHTML("beforeend", '<span class="md-next">next</span>');
        else if (!next) tag?.remove();
      }
    }

    bindSliders(el: HTMLElement) {
      const sliders: Record<string, (v: number, input: HTMLInputElement) => unknown> = {
        fader: v => mixer.setFader(v),
        musicVol: v => mixer.setMusicVol(v),
        battleVol: v => mixer.setBattleVol(v),
        ambientVol: v => mixer.setAmbientVol(v),
        sfxVol: v => mixer.setSfxVol(v),
        layer: (v, input) => layers.setLayerLevel(soundOf(input), v),
        scene: (v, input) => mixer.setSceneVol(sceneOf(input), v),
      };
      for (const input of el.querySelectorAll<HTMLInputElement>("input[data-slider]")) {
        const set = sliders[input.dataset.slider!];
        input.addEventListener("pointerdown", () => (this.#dragging = true));
        input.addEventListener("input", () => set(Number(input.value) / 100, input));
        // Volume tracks fill with their channel's colour up to the cap.
        input.style.setProperty("--md-fill", `${input.value}%`);
        input.addEventListener("input", () => input.style.setProperty("--md-fill", `${input.value}%`));
        input.addEventListener("change", () => this.endDrag());
        input.addEventListener("pointerup", () => this.endDrag());
      }
    }

    endDrag() {
      this.#dragging = false;
      if (!this.#pendingRender) return;
      this.#pendingRender = false;
      this.render();
    }

    bindQueueDrag(el: HTMLElement) {
      const rows = [...el.querySelectorAll<HTMLElement>(".md-row[draggable]")];
      // Each queue (Deck A/B in the Music tab, the Battle deck) reorders within itself; a drop on another list is ignored.
      for (const row of rows) {
        const deck = deckOf(row);
        row.addEventListener("dragstart", e => {
          e.dataTransfer!.setData("text/plain", `${deck}:${row.dataset.index}`);
          row.classList.add("dragging");
        });
        row.addEventListener("dragend", () => row.classList.remove("dragging"));
        row.addEventListener("dragover", e => e.preventDefault());
        row.addEventListener("drop", e => {
          e.preventDefault();
          const [fromDeck, index] = e.dataTransfer!.getData("text/plain").split(":");
          const from = Number(index);
          const to = Number(row.dataset.index);
          if (fromDeck === deck && Number.isFinite(from) && from !== to) decks.moveTrack(deck, from, to);
        });
      }
    }

    bindLibraryInputs(el: HTMLElement) {
      const search = el.querySelector<HTMLInputElement>("input[name=md-search]");
      let timer: ReturnType<typeof setTimeout>;
      search?.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this.ui.query = search.value;
          this.render({ parts: ["libraryList"] });
        }, 150);
      });
    }

    /** Fetch durations for the library rows on screen, then fill them in without a re-render. */
    loadVisibleDurations(el: HTMLElement) {
      for (const row of el.querySelectorAll<HTMLElement>(".md-lib[data-path]")) {
        const cell = row.querySelector(".md-dur");
        if (!cell || cell.textContent) continue;
        loadDuration(row.dataset.path!).then(d => {
          if (d !== undefined) cell.textContent = formatTime(d);
        });
      }
    }

    /** Update the fader, levels and progress in place: called on every mix change and once a second. */
    syncLive() {
      const el: HTMLElement | undefined = this.element;
      if (!this.rendered || !this.deckView || !el) return;
      const mix = getMix();
      // How much of each deck the fader lets through (1 = all of it), for the card's brightness.
      const presence = deckGains({ ...mix, musicVol: 1, muted: false });
      const setSlider = (name: string, value: number) => {
        const input = el.querySelector<HTMLInputElement>(`input[data-slider=${name}]`);
        if (input && !(this.#dragging && document.activeElement === input)) {
          input.value = String(Math.round(value * 100));
          input.style.setProperty("--md-fill", `${input.value}%`);
        }
        const label = el.querySelector(`[data-label=${name}]`);
        if (label) label.textContent = `${Math.round(value * 100)}%`;
      };
      setSlider("fader", mix.fader);
      setSlider("musicVol", mix.musicVol);
      setSlider("battleVol", mix.battleVol);
      setSlider("ambientVol", mix.ambientVol);
      setSlider("sfxVol", mix.sfxVol);
      // Each scene's level (v2.34): there are several, so they go by their scene.
      for (const input of el.querySelectorAll<HTMLInputElement>("input[data-slider=scene]")) {
        const value = Math.round((mix.sceneVols?.[sceneOf(input)] ?? 1) * 100);
        if (!(this.#dragging && document.activeElement === input)) {
          input.value = String(value);
          input.style.setProperty("--md-fill", `${value}%`);
        }
        const label = input.parentElement?.querySelector("[data-scene-label]");
        if (label) label.textContent = `${value}%`;
      }
      el.querySelector(".md-panic")?.classList.toggle("on", mix.panic);
      const panicLabel = el.querySelector(".md-panic-label");
      if (panicLabel) panicLabel.textContent = mix.panic ? "Bring back" : "Fade all";
      el.querySelector(".md-now")?.classList.toggle("is-panic", mix.panic);
      const panicNote = el.querySelector<HTMLElement>(".md-panic-note");
      if (panicNote) panicNote.hidden = !mix.panic;
      const battleSum = el.querySelector<HTMLElement>("[data-sum=battle]");
      if (battleSum) {
        const playing = playlistFor("battle")?.sounds.find((s: any) => s.playing);
        battleSum.textContent = battleSum.dataset.tooltip = battleSummary(inBattle(), playing?.name ?? null, playlistFor("battle")?.sounds.size ?? 0, mix.battleVol, mix.muted);
      }
      const volSum = el.querySelector<HTMLElement>("[data-sum=volumes]");
      if (volSum) volSum.textContent = volSum.dataset.tooltip = volumesSummary(mix);
      const fadeTo = el.querySelector(".md-fade-to");
      if (fadeTo) fadeTo.textContent = fadeTarget(mix.fader);
      for (const [action, muted] of [["mdMute", mix.muted], ["mdAmbMute", mix.ambientMuted], ["mdSfxMute", mix.sfxMuted]] as const) {
        const button = el.querySelector(`[data-action=${action}]`);
        button?.classList.toggle("on", muted);
        button?.setAttribute("aria-pressed", String(muted));
        button?.closest(".md-level")?.classList.toggle("is-muted", muted);
      }
      const battleIn = battleGain({ ...mix, battleVol: 1, muted: false });
      for (const deck of [...DECKS, "battle"] as const) {
        const card = el.querySelector<HTMLElement>(`.md-deck[data-deck=${deck}]`);
        if (!card) continue;
        const info = deckCard(deck);
        card.style.setProperty("--md-presence", String(0.4 + 0.6 * (deck === "battle" ? battleIn : presence[deck])));
        card.classList.toggle("off-air", !info.audible);
        card.dataset.state = info.state;
        card.querySelector(".md-state")!.className = `md-state fa-solid ${info.stateIcon}`;
        card.querySelector(".md-status")!.textContent = info.status;
        card.querySelector<HTMLElement>(".md-bar i")!.style.width = `${info.progress}%`;
      }
      this.syncQueue(el);
      const deckSum = el.querySelector<HTMLElement>("[data-sum=decks]");
      if (deckSum) deckSum.textContent = deckSum.dataset.tooltip = decksSummary(DECKS.map(deckCard), mix.panic);
    }
  };
}

/**
 * ▶/⏸ on a deck card: a playing deck always pauses. A stopped deck plays if the fader has it on air, or fades
 * over to it if not. On air ignores the Music level, so at 0% the button still pauses and plays.
 */
async function deckPlay(deck: PlayDeck): Promise<void> {
  // The Battle deck comes in with combat or its own ▶, not the crossfader.
  if (deck === "battle") {
    if (!inBattle()) return startBattle();
    return deckCard(deck).playing ? decks.pause(deck) : decks.play(deck);
  }
  if (deckCard(deck).playing) return decks.pause(deck);
  const onAir = channelGains({ ...getMix(), musicVol: 1, muted: false, panic: false })[deck] > 0.001;
  if (!onAir) return mixer.fadeTo(deck);
  return decks.play(deck);
}

/** Play now: make it the deck's track and play it; if you can't hear that deck, fade over to it. */
async function playNow(deck: PlayDeck, soundId: string): Promise<void> {
  // The Battle deck: in a battle, switch track; outside one, bring it in on that track.
  if (deck === "battle") return startBattle({ pick: soundId });
  await decks.playTrack(deck, soundId);
  if (channelGains({ ...getMix(), muted: false, panic: false })[deck] <= 0.001) await mixer.fadeTo(deck);
}

/** The queue's Shuffle, Repeat and Repeat one toggles. Shuffle and Repeat one replace each other. */
async function toggleDeckMode(deck: PlayDeck, mode: string): Promise<void> {
  const play = playModeOf(deck);
  if (mode === "repeat") return decks.setEndMode(deck, endModeOf(deck) === "loop" ? "stop" : "loop");
  const target = mode === "shuffle" ? "shuffle" : "repeat";
  await decks.setPlayMode(deck, play === target ? "inOrder" : target);
}

async function libraryAdd(app: any, channel: string, path: string, name?: string, cue?: string): Promise<void> {
  if (channel === "combat") {
    const added = await addToBattle(path, name);
    if (added === "already") ui.notifications.info("Music Deck: that track is already on the Battle deck.");
    else if (added) {
      ui.notifications.info(battleIsDefault() ? "Music Deck: added to the Battle deck."
        : "Music Deck: added to the Battle deck. Your battle music is another folder, so the next shuffle drops it.");
    }
    return;
  }
  if (channel === "A" || channel === "B") await decks.addTrack(channel, path, { name, cue });
  else if (channel === "ambient") return addLayer(app, path, name, cue);
  else if (channel === "sfx") await layers.addToChannel(channel, path, name, undefined, cue);
  ui.notifications.info(`Music Deck: added to ${channel === "sfx" ? "SFX" : `Deck ${channel}`}.`);
}

/** ＋Amb: a new ambient layer in the scene whose "Add a layer" was pressed, else the scene that's on, else General. */
async function addLayer(app: any, path: string, name?: string, cue?: string): Promise<void> {
  const target = ambientTargetOf(app.ui);
  const id = await layers.addToChannel("ambient", path, name, undefined, cue);
  if (!id) return;
  if (target) await scenes.adoptLayers(target.id, [id]);
  ui.notifications.info(`Music Deck: added to ${target ? `the ${target.name} scene` : "General ambience"}.`);
}

async function addAll(deck: DeckId, nodeId: string): Promise<void> {
  const tracks = tracksFor(nodeId);
  await decks.addTracks(deck, tracks);
  ui.notifications.info(`Music Deck: added ${tracks.length} track${tracks.length === 1 ? "" : "s"} to Deck ${deck}.`);
}

async function randomPad(nodeId: string): Promise<void> {
  const count = tracksFor(nodeId).length;
  if (!count) return void ui.notifications.warn("Music Deck: that folder has no sounds.");
  if (await layers.addRandomPad(nodeId)) ui.notifications.info(`Music Deck: added a random SFX pad (${count} sounds).`);
}

function battleMenu() {
  const isBattle = (t: HTMLElement) => battleSource() === nodeOf(t);
  const isGeneral = (t: HTMLElement) => generalSource() === nodeOf(t);
  return [
    { label: "Use for general ambience", icon: '<i class="fa-solid fa-cloud-rain"></i>', visible: (t: HTMLElement) => !isGeneral(t), onClick: (_e: Event, t: HTMLElement) => setGeneralSource(nodeOf(t)) },
    { label: "Stop using for general ambience", icon: '<i class="fa-solid fa-xmark"></i>', visible: (t: HTMLElement) => isGeneral(t), onClick: () => setGeneralSource("") },
    { label: "Use for battle music", icon: '<i class="fa-solid fa-swords"></i>', visible: (t: HTMLElement) => !isBattle(t), onClick: (_e: Event, t: HTMLElement) => setBattleSource(nodeOf(t)) },
    { label: "Stop using for battle music", icon: '<i class="fa-solid fa-xmark"></i>', visible: (t: HTMLElement) => isBattle(t) && !battleIsDefault(), onClick: () => setBattleSource("") },
  ];
}

async function removeSound(app: unknown, target: HTMLElement): Promise<void> {
  const channel = target.closest<HTMLElement>("[data-channel]")!.dataset.channel as "ambient" | "sfx";
  await removeUndoably(app, channel, soundOf(target), channel === "sfx" ? "the SFX pads" : "Ambient");
}

/** Set by a remove, undo or redo: the tab whose Undo (or else Redo) should take focus over the next renders, if nothing else has it. */
let focusUndoIn: { app: unknown; until: number } | undefined;

/** This browser's undo history for removes. Every open Music Deck tab (sidebar and big mixer) shares it. */
const history = new History(25, () => Hooks.callAll(HISTORY_HOOK));

/**
 * Remove a sound from a deck queue, the ambient layers or the SFX pads, so Undo can put it back: same id
 * (sound scenes and Stream Deck keys keep pointing at it), same place in the list, and silent.
 */
async function removeUndoably(app: unknown, channel: PlayDeck | "ambient" | "sfx", soundId: string, where: string): Promise<void> {
  const playlist = playlistFor(channel);
  const sound = playlist?.sounds.get(soundId);
  if (!sound) return;
  const data = { ...sound.toObject(), playing: false, pausedTime: null };
  const playlistId = playlist.id;
  await sound.delete();
  const playlistNow = () => {
    const p = game.playlists.get(playlistId);
    if (!p) throw new Error("its playlist is gone");
    return p;
  };
  history.push({
    label: `“${data.name}” from ${where}`,
    undo: () => playlistNow().createEmbeddedDocuments("PlaylistSound", [data], { keepId: true }),
    redo: async () => playlistNow().sounds.get(data._id)?.delete(),
  });
  // The remove button goes with its row. Once this tab's footer re-renders, focus its Undo so ⌘Z reaches
  // the tab rather than Foundry's own undo.
  keepFocus(app);
}

function keepFocus(app: unknown): void {
  focusUndoIn = { app, until: Date.now() + 2000 };
}

async function undoOrRedo(app: unknown, which: "undo" | "redo"): Promise<void> {
  const step = which === "undo" ? history.nextUndo : history.nextRedo;
  if (!step) return;
  keepFocus(app);
  const ok = await history[which]();
  if (!ok) ui.notifications.warn(`Music Deck couldn't ${which} removing ${step.label}.`);
}

function historyContext() {
  const undo = history.nextUndo, redo = history.nextRedo;
  return {
    history: !!(undo || redo),
    undoLabel: undo && `Removed ${undo.label}`,
    redoLabel: redo && `Removed ${redo.label}`,
    lastLabel: undo ? `Removed ${undo.label}` : redo ? `Put back ${redo.label}` : "",
  };
}

/** "Edit cues…", for any row or card that knows its sound or path. */
function editCuesItem() {
  return { label: "Edit cues…", icon: '<i class="fa-solid fa-scissors"></i>', onClick: (_e: Event, t: HTMLElement) => editCues(t) };
}

/** Right-click on a deck card's cue chip. */
function cueChipMenu() {
  return [
    { label: "Go now", icon: '<i class="fa-solid fa-bolt"></i>', onClick: (_e: Event, t: HTMLElement) => decks.goToCue(deckOf(t), cueIdOf(t), "now") },
    { label: "At the end of the loop", icon: '<i class="fa-solid fa-rotate"></i>', onClick: (_e: Event, t: HTMLElement) => decks.goToCue(deckOf(t), cueIdOf(t), "loopEnd") },
    { label: "Cue on the other deck and fade", icon: '<i class="fa-solid fa-right-left"></i>', onClick: (_e: Event, t: HTMLElement) => { const d = abDeckOf(t); return d && decks.cueOnOtherAndFade(d, cueIdOf(t)); } },
    editCuesItem(),
  ];
}

/** Right-click on a queue row: pick which cue it plays (built when the menu opens, from that track's cues). */
function queueMenu(row: HTMLElement, items: any[]): void {
  const deck = deckOf(row);
  const sound = playlistFor(deck)?.sounds.get(soundOf(row));
  const sheet = getSheet(sound?.path);
  const current = sound && cueOf(sound);
  items.length = 0;
  for (const c of sheet?.cues ?? []) {
    items.push({
      label: `Cue: ${c.name}`, group: "cues",
      icon: `<i class="fa-solid ${c.id === current?.id ? "fa-circle-dot" : "fa-circle"}"></i>`,
      onClick: () => decks.setQueueCue(deck, sound.id, c.id),
    });
  }
  if (sheet?.cues.length) {
    items.push({ label: "Whole track", group: "cues", icon: `<i class="fa-solid ${current ? "fa-circle" : "fa-circle-dot"}"></i>`, onClick: () => decks.setQueueCue(deck, sound.id, null) });
  }
  items.push(editCuesItem());
}

/** Right-click on an ambient layer: edit its cues, or move it to another scene or out of its scene. */
function layerMenu(target: HTMLElement, items: any[]): void {
  items.length = 0;
  const id = soundOf(target);
  const owner = scenes.sceneOfLayer(id);
  // A General layer that follows the folder stays in General: a scene gets its own copy.
  const follows = followsFolder(playlistFor("ambient")?.sounds.get(id));
  for (const scene of scenes.scenesOf().filter(s => s.id !== owner?.id)) {
    items.push(follows
      ? { label: `Copy to ${scene.name}`, group: "move", icon: '<i class="fa-solid fa-copy"></i>', onClick: () => scenes.adoptLayers(scene.id, [id]) }
      : { label: `Move to ${scene.name}`, group: "move", icon: '<i class="fa-solid fa-arrow-right"></i>', onClick: () => scenes.moveLayer(id, scene.id) });
  }
  if (owner) items.push({ label: "Move to General", group: "move", icon: '<i class="fa-solid fa-cloud"></i>', onClick: () => scenes.moveLayer(id, null) });
  items.push(editCuesItem());
}

/** Right-click on a sound scene's header. */
function sceneMenu() {
  const scene = (t: HTMLElement) => scenes.scenesOf().find(s => s.id === sceneOf(t));
  return [
    {
      label: "Edit…", icon: '<i class="fa-solid fa-pen"></i>',
      onClick: (_e: Event, t: HTMLElement) => editScene(sceneOf(t)),
    },
    {
      label: "Add the layers playing now", icon: '<i class="fa-solid fa-plus"></i>',
      onClick: (_e: Event, t: HTMLElement) => scenes.updateScene(sceneOf(t)),
    },
    {
      label: "Delete", icon: '<i class="fa-solid fa-trash"></i>',
      onClick: async (_e: Event, t: HTMLElement) => {
        const s = scene(t);
        if (!s) return;
        const count = s.layers.filter(l => playlistFor("ambient")?.sounds.has(l.id)).length;
        const ok = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Delete sound scene" },
          content: `<p>Delete <strong>${foundry.utils.escapeHTML(s.name)}</strong>${count ? ` and its ${count} layer${count === 1 ? "" : "s"}` : ""}? Stream Deck keys set to it will stop working.</p>`,
          rejectClose: false,
        });
        if (ok) await scenes.deleteScene(s.id);
      },
    },
  ];
}
