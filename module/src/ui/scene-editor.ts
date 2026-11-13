/**
 * The sound scene editor (Phase 4): a scene's name, its layers and each one's level, set without anything
 * having to play. A new scene starts empty. "Add a sound" searches the other ambient layers and the Library,
 * cues included (track editor T5): a General layer moves into the scene (one that follows the General folder is
 * copied), another scene's is copied, and a
 * Library file or cue becomes a new layer when you save. Since v2.29 the scene owns its layers, so removing
 * one here deletes it.
 */
import { playlistFor, queueOf } from "../channels";
import { addToChannel } from "../layers";
import { libraryTracks, scanLibrary } from "../library";
import * as scenes from "../scenes";
import { getSheet } from "../cue-sheets";
import { MODULE_ID } from "../live-gain";
import { followsFolder } from "../general";

const pct = (volume: number) => Math.round(volume * 100);
const esc = (s: string) => foundry.utils.escapeHTML(s);
const NEW_LEVEL = 0.8;

/** One sound in the editor: an existing layer (`id`) or a Library file to add (`path`, maybe on a `cue`). */
interface Row { id?: string; path?: string; cue?: string; name: string; level: number }

function rowHtml(r: Row): string {
  const key = r.id ? `data-id="${esc(r.id)}"` : `data-path="${esc(r.path!)}"${r.cue ? ` data-cue="${esc(r.cue)}"` : ""}`;
  const icon = r.id ? "fa-cloud-rain" : r.cue ? "fa-scissors" : "fa-file-audio";
  return `<li class="md-ed-row" ${key} data-name="${esc(r.name)}">
    <span class="md-ed-sound" data-tooltip="${esc(r.name)}"><i class="fa-solid ${icon}" aria-hidden="true"></i> ${esc(r.name)}</span>
    <input type="range" min="0" max="100" value="${r.level}" aria-label="${esc(r.name)} level">
    <output>${r.level}%</output>
    <button type="button" class="md-ed-remove" data-tooltip="Remove from this scene" aria-label="Remove ${esc(r.name)}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
  </li>`;
}

/** Open the editor for a scene, or for a new one when `id` is undefined. */
export async function editScene(id?: string): Promise<void> {
  const p = playlistFor("ambient");
  if (!p) return;
  const layers = queueOf(p);
  const existing = id ? scenes.scenesOf(p).find(s => s.id === id) : undefined;
  if (id && !existing) return;
  if (!libraryTracks().length) await scanLibrary();

  const byId = new Map(layers.map((s: any) => [s.id, s]));
  const start: Row[] = (existing?.layers ?? [])
    .map(l => byId.get(l.id))
    .filter(Boolean)
    .map((s: any) => ({ id: s.id, name: s.name, level: pct(s.volume) }));

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: existing ? "Edit sound scene" : "New sound scene", icon: "fa-solid fa-layer-group" },
    position: { width: 400 },
    classes: ["md-scene-editor"],
    content: `<label class="md-ed-name">Name <input name="name" type="text" maxlength="40" autocomplete="off" autofocus
        value="${esc(existing?.name ?? "")}" placeholder="e.g. Night Camp"></label>
      <p class="md-ed-hint">Playing this scene fades these layers in and every other layer out.
        Removing a layer here deletes it. A layer you add from another scene is copied, so that scene keeps its own.</p>
      <ul class="md-ed-list">${start.map(rowHtml).join("")}</ul>
      <p class="md-ed-empty" ${start.length ? "hidden" : ""}>No sounds yet. A scene with none means quiet.</p>
      <div class="md-ed-add">
        <i class="fa-solid fa-magnifying-glass md-ed-search-icon" aria-hidden="true"></i>
        <input type="search" class="md-ed-search" autocomplete="off" placeholder="Add a sound: search layers or Library…"
          aria-label="Add a sound">
        <ul class="md-ed-results" role="listbox"></ul>
      </div>`,
    ok: {
      label: "Save",
      callback: (_event: Event, button: any) => {
        const form = button.form as HTMLFormElement;
        return {
          name: String(new FormData(form).get("name") ?? ""),
          rows: [...form.querySelectorAll<HTMLElement>(".md-ed-row")].map(row => ({
            id: row.dataset.id,
            path: row.dataset.path,
            cue: row.dataset.cue,
            name: row.dataset.name ?? "",
            level: Number(row.querySelector<HTMLInputElement>("input[type=range]")!.value),
          })),
        };
      },
    },
    render: (_event: Event, dialog: any) => wire(dialog.element, layers, existing?.id),
    rejectClose: false,
  });
  if (!result) return;

  const sceneLayers: scenes.SceneLayer[] = [];
  for (const row of result.rows as Row[]) {
    const volume = scenes.roundLevel(row.level / 100);
    const layerId = row.id ?? await addToChannel("ambient", row.path!, row.name, volume, row.cue);
    if (layerId) sceneLayers.push({ id: layerId, volume });
  }
  const name = result.name.trim() || scenes.nameFor((result.rows as Row[]).map(r => r.name));
  await scenes.setScene({ id: existing?.id ?? foundry.utils.randomID(), name, layers: sceneLayers });
}

/** Sliders, × remove, and the "Add a sound" search. */
function wire(root: HTMLElement, layers: any[], sceneId?: string): void {
  const list = root.querySelector<HTMLElement>(".md-ed-list")!;
  const empty = root.querySelector<HTMLElement>(".md-ed-empty")!;
  const search = root.querySelector<HTMLInputElement>(".md-ed-search")!;
  const results = root.querySelector<HTMLElement>(".md-ed-results")!;
  const all = scenes.scenesOf();
  const ownerName = (id: string) => all.find(s => s.layers.some(l => l.id === id))?.name;
  // Offer every layer but this scene's own; say where each one is now.
  const layerInfo = layers
    .filter((s: any) => !sceneId || scenes.sceneOfLayer(s.id)?.id !== sceneId)
    .map((s: any) => {
      const owner = ownerName(s.id);
      const where = owner ? `In ${owner}: copied` : followsFolder(s) ? "General: copied" : "General: moves in";
      return { id: s.id, name: s.name, path: s.path, cue: s.getFlag(MODULE_ID, "cue") ?? null, where };
    });
  const cuesOf = (path: string) => getSheet(path)?.cues ?? [];
  let offered: scenes.SceneCandidate[] = [];

  const inScene = () => new Set([...list.querySelectorAll<HTMLElement>(".md-ed-row")].map(r => r.dataset.id ?? scenes.soundKey(r.dataset.path!, r.dataset.cue)));
  const refresh = () => {
    empty.hidden = !!list.querySelector(".md-ed-row");
    offered = document.activeElement === search || search.value
      ? scenes.sceneCandidates(layerInfo, inScene(), libraryTracks(), search.value, 8, cuesOf)
      : [];
    results.innerHTML = offered.map((c, i) => `<li role="option" data-index="${i}">
        <span>${esc(c.name)}</span><small>${esc(c.where)}</small></li>`).join("")
      || (search.value ? `<li class="md-ed-none">No matches in Ambient or the Library.</li>` : "");
  };
  const add = (c: scenes.SceneCandidate) => {
    const layer = c.id ? layers.find((s: any) => s.id === c.id) : undefined;
    list.insertAdjacentHTML("beforeend", rowHtml({ id: c.id, path: c.path, cue: c.cue, name: c.name, level: pct(layer?.volume ?? NEW_LEVEL) }));
    list.lastElementChild?.scrollIntoView({ block: "nearest" });
    search.value = "";
    refresh();
    search.focus();
  };

  list.addEventListener("input", e => {
    const range = e.target as HTMLInputElement;
    if (range.type === "range") range.nextElementSibling!.textContent = `${range.value}%`;
  });
  list.addEventListener("click", e => {
    const remove = (e.target as HTMLElement).closest(".md-ed-remove");
    if (!remove) return;
    remove.closest(".md-ed-row")!.remove();
    refresh();
  });
  search.addEventListener("input", refresh);
  search.addEventListener("focus", refresh);
  search.addEventListener("blur", () => setTimeout(refresh, 150));
  search.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    // Enter adds the top match instead of saving the dialog.
    e.preventDefault();
    if (offered[0]) add(offered[0]);
  });
  results.addEventListener("mousedown", e => {
    const item = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!item) return;
    e.preventDefault();
    add(offered[Number(item.dataset.index)]);
  });
}
