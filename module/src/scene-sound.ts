/**
 * A Foundry map scene can name a sound scene (Phase 5). Activating that map for the players recalls it,
 * as if its Sound Scene key were pressed. The field sits in the scene's Misc tab, under Foundry's own Audio.
 */
import { MODULE_ID } from "./live-gain";
import { recallScene, scenesOf } from "./scenes";

const FLAG = "soundScene";
const isActiveGM = () => !!game.users.activeGM?.isSelf;

function addField(app: any, html: HTMLElement): void {
  if (!game.user.isGM) return;
  const audio = html.querySelector('select[name="playlist"]')?.closest("fieldset");
  if (!audio || audio.querySelector(".md-scene-sound")) return;
  const current = app.document.getFlag(MODULE_ID, FLAG) ?? "";
  const esc = foundry.utils.escapeHTML;
  const options = [{ id: "", name: "None" }, ...scenesOf()]
    .map(s => `<option value="${esc(s.id)}" ${s.id === current ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  audio.insertAdjacentHTML("beforeend", `<div class="form-group md-scene-sound">
    <label>Music Deck sound scene</label>
    <div class="form-fields"><select name="flags.${MODULE_ID}.${FLAG}">${options}</select></div>
    <p class="hint">Activating this scene for the players fades in this sound scene.</p>
  </div>`);
}

/** Init: Foundry v14 activates a scene without an updateScene hook, so watch Scene#_onActivate (every client). */
export function registerSceneSound(): void {
  const BaseScene = CONFIG.Scene.documentClass;
  CONFIG.Scene.documentClass = class MusicDeckScene extends BaseScene {
    _onActivate(active: boolean, operation: any) {
      super._onActivate(active, operation);
      if (active) recallFor(this);
    }
  };
}

function recallFor(scene: any): void {
  if (!isActiveGM()) return;
  const id = scene.getFlag(MODULE_ID, FLAG);
  // Queued with the other scene commands (scenes.ts), so a key pressed as the map activates can't race it.
  if (id && scenesOf().some(s => s.id === id)) recallScene(id).catch(e => console.error("Music Deck | couldn't recall the map's sound scene", e));
}

export function startSceneSound(): void {
  Hooks.on("renderSceneConfig", (app: any, html: HTMLElement) => addField(app, html));
}
