/**
 * The track editor (T2): mark named cues inside one audio file.
 * One column: the list is the pads.
 *
 * One ApplicationV2 window, built once as plain DOM and updated in place: header, overview strip, zoomed
 * waveform with cue regions, transport, and the cue list edited inline. Preview plays on the editor's own
 * AudioContext, never Foundry's, so players can't hear it, through the same segment code the decks use.
 */
import { getSheet, saveSheet } from "../cue-sheets";
import { scheduleSwitch, startSegmentNode } from "../cue-sound";
import { cueRingOut, cueSeam } from "../cue-sheets";
import {
  CUE_BUFFER_MAX_S, cueEnd, makeSegment, resolveAfter, segmentFileTime,
  type Cue, type CueRole, type CueSheet, type Segment,
} from "../cues";
import { MODULE_ID, channelOf } from "../live-gain";
import {
  CUE_COLORS, MAX_CUES, PAD_COUNT, addCue, colorOf, cueOnPad, dropCue, formatCueTime, nearestZeroCrossing, parseCueTime,
  peakRange, setEdge, snapToBeat, sortCues,
} from "./editor-model";
import { cachedPeaks, loadTrack, type LoadedTrack } from "./peaks";

type Snap = "zero" | "beat" | "off";
type Status = { kind: "loading"; received: number; total: number } | { kind: "decoding" } | { kind: "error"; message: string } | { kind: "ready" };

const JOIN_S = 3;
const MAX_PPS = 2000;
const NUDGE_S = 0.01;
const editors = new Map<string, any>();

/** Open the editor for a file (GM). Re-uses the window if that file is already open. */
export function openTrackEditor(path: string, name?: string): void {
  if (!game.user.isGM) {
    ui.notifications.warn("Music Deck: only a GM can edit cues.");
    return;
  }
  const open = editors.get(path);
  if (open?.rendered) {
    open.bringToFront();
    return;
  }
  const Editor = editorClass();
  const app = new Editor(path, name);
  editors.set(path, app);
  app.render({ force: true });
}

let EditorClass: any;
function editorClass(): any {
  if (EditorClass) return EditorClass;
  const { ApplicationV2, DialogV2 } = foundry.applications.api;

  EditorClass = class TrackEditor extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      classes: ["md-track-editor"],
      window: { title: "Track editor", icon: "fa-solid fa-scissors", resizable: true },
      position: { width: 1000, height: 760 },
    };

    path: string;
    trackName: string;
    sheet: CueSheet;
    dirty = false;
    selected: string | null = null;
    drawer: string | null = null;
    range: { a: number; b: number } | null = null;
    pps = 0;
    viewStart = 0;
    playhead = 0;
    snap: Snap = "zero";
    status: Status = { kind: "loading", received: 0, total: 0 };
    track: LoadedTrack | null = null;
    peaks: { data: Float32Array; spb: number; sr: number } | null = null;
    ctx: AudioContext | null = null;
    out: GainNode | null = null;
    preview: { nodes: AudioBufferSourceNode[]; seg: Segment; label: string; stopAt?: number } | null = null;
    abort = new AbortController();
    root!: HTMLElement;
    el: Record<string, any> = {};
    raf = 0;
    resize?: ResizeObserver;

    constructor(path: string, name?: string) {
      super({ id: `md-track-editor-${foundry.utils.randomID()}` });
      this.path = path;
      this.trackName = name?.split(" · ")[0] ?? decodeURIComponent(path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
      const saved = getSheet(path);
      this.sheet = saved ? foundry.utils.deepClone(saved) : { path, duration: 0, cues: [] };
    }

    get title() {
      return `Track editor: ${this.trackName}`;
    }

    get duration(): number {
      return this.track?.buffer.duration ?? this.sheet.duration ?? 0;
    }

    /* ------------------------------------------------------------ */
    /*  Rendering                                                    */
    /* ------------------------------------------------------------ */

    async _renderHTML() {
      if (!this.root) this.build();
      return this.root;
    }

    _replaceHTML(result: HTMLElement, content: HTMLElement) {
      if (result.parentElement !== content) content.replaceChildren(result);
    }

    _onFirstRender() {
      this.resize = new ResizeObserver(() => this.layout());
      this.resize.observe(this.el.wave);
      this.load();
    }

    async close(options: any = {}) {
      if (this.dirty && !options.force) {
        const discard = await DialogV2.confirm({
          window: { title: "Unsaved cues" },
          content: `<p>Your changes to the cues of <strong>${foundry.utils.escapeHTML(this.trackName)}</strong> aren't saved.</p>`,
          yes: { label: "Discard changes", icon: "fa-solid fa-trash" },
          no: { label: "Keep editing", default: true },
        });
        if (!discard) return this;
      }
      return super.close(options);
    }

    _onClose(options: any) {
      super._onClose?.(options);
      this.abort.abort();
      this.stopPreview();
      cancelAnimationFrame(this.raf);
      this.resize?.disconnect();
      this.ctx?.close();
      editors.delete(this.path);
    }

    build(): void {
      const r = document.createElement("div");
      r.className = "mdte";
      r.tabIndex = -1;
      r.innerHTML = `
        <header class="mdte-head">
          <div class="mdte-id">
            <h2 class="mdte-title"></h2>
            <div class="mdte-meta"></div>
          </div>
          <label class="mdte-bpm">BPM <input type="number" min="0" max="300" step="0.01" placeholder="–" data-field="bpm"></label>
          <button type="button" class="mdte-btn" data-act="first-beat" data-tooltip="Set the first beat at the playhead (for Beat snap)"><i class="fa-solid fa-drum"></i><span>First beat here</span></button>
        </header>
        <p class="mdte-note" hidden></p>
        <div class="mdte-overview" data-zone="overview"><canvas></canvas><div class="mdte-bands"></div><div class="mdte-view"></div></div>
        <div class="mdte-wave" data-zone="wave">
          <canvas></canvas>
          <div class="mdte-regions"></div>
          <div class="mdte-range" hidden></div>
          <div class="mdte-playhead"></div>
          <div class="mdte-overlay"></div>
        </div>
        <div class="mdte-transport">
          <button type="button" class="mdte-btn mdte-play" data-act="play" data-tooltip="Play or pause (Space)"><i class="fa-solid fa-play"></i><span>Play</span></button>
          <span class="mdte-clock"><span class="mdte-now">0:00.000</span><span class="mdte-of"> / 0:00.000</span></span>
          <button type="button" class="mdte-btn" data-act="loop" data-tooltip="Loop the selected cue (L)"><i class="fa-solid fa-repeat"></i><span>Loop cue</span></button>
          <button type="button" class="mdte-btn" data-act="join" data-tooltip="Hear the loop point or the hand-over: the last 3 s, then the first 3 s (J)"><i class="fa-solid fa-link"></i><span>Preview join</span></button>
          <span class="mdte-spacer"></span>
          <label class="mdte-snap">Snap <select data-field="snap">
            <option value="zero">Zero crossing</option><option value="beat">Beat</option><option value="off">Off</option>
          </select></label>
          <div class="mdte-zoom">
            <button type="button" class="mdte-icon" data-act="zoom-out" data-tooltip="Zoom out (−)" aria-label="Zoom out"><i class="fa-solid fa-magnifying-glass-minus"></i></button>
            <button type="button" class="mdte-icon" data-act="zoom-fit" data-tooltip="Whole track" aria-label="Whole track"><i class="fa-solid fa-left-right"></i></button>
            <button type="button" class="mdte-icon" data-act="zoom-in" data-tooltip="Zoom in (+)" aria-label="Zoom in"><i class="fa-solid fa-magnifying-glass-plus"></i></button>
          </div>
        </div>
        <div class="mdte-list" role="list" aria-label="Cues"></div>
        <button type="button" class="mdte-add" data-act="add"><i class="fa-solid fa-plus"></i> Add cue from selection</button>
        <footer class="mdte-foot">
          <span class="mdte-status" aria-live="polite"></span>
          <button type="button" class="mdte-btn" data-act="cancel">Cancel</button>
          <button type="button" class="mdte-btn mdte-save" data-act="save"><i class="fa-solid fa-floppy-disk"></i><span>Save</span></button>
        </footer>`;
      const q = (s: string) => r.querySelector(s) as any;
      this.el = {
        title: q(".mdte-title"), meta: q(".mdte-meta"), bpm: q("[data-field=bpm]"), note: q(".mdte-note"),
        overview: q(".mdte-overview"), ovCanvas: q(".mdte-overview canvas"), bands: q(".mdte-bands"), view: q(".mdte-view"),
        wave: q(".mdte-wave"), canvas: q(".mdte-wave canvas"), regions: q(".mdte-regions"), range: q(".mdte-range"),
        playhead: q(".mdte-playhead"), overlay: q(".mdte-overlay"), play: q(".mdte-play"), now: q(".mdte-now"), of: q(".mdte-of"),
        snap: q("[data-field=snap]"), list: q(".mdte-list"), add: q(".mdte-add"), status: q(".mdte-status"), save: q(".mdte-save"),
      };
      this.el.title.textContent = this.trackName;
      this.el.bpm.value = this.sheet.bpm ? String(this.sheet.bpm) : "";
      this.root = r;
      this.wire();
      this.refresh();
    }

    /** Everything that depends on state, except the canvases' pixels (see layout/draw). */
    refresh(): void {
      const d = this.duration;
      this.el.meta.textContent = d ? `${formatCueTime(d)}${this.track ? ` · ${this.track.buffer.numberOfChannels === 1 ? "mono" : "stereo"} · ${Math.round(this.track.buffer.sampleRate / 100) / 10} kHz` : ""}` : "Reading…";
      this.el.of.textContent = ` / ${formatCueTime(d)}`;
      this.renderNote();
      this.renderOverlay();
      this.renderRegions();
      this.renderList();
      this.renderFoot();
      const ready = !!this.track;
      for (const b of this.root.querySelectorAll("[data-act=play],[data-act=loop],[data-act=join],[data-act=first-beat]")) (b as HTMLButtonElement).disabled = !ready;
      const sel = this.cue(this.selected);
      (this.root.querySelector("[data-act=loop]") as HTMLButtonElement).disabled = !ready || !sel;
      (this.root.querySelector("[data-act=join]") as HTMLButtonElement).disabled = !ready || !sel;
      this.el.add.disabled = !this.range || this.sheet.cues.length >= MAX_CUES;
      this.el.add.innerHTML = this.sheet.cues.length >= MAX_CUES
        ? `<i class="fa-solid fa-ban"></i> ${MAX_CUES} cues is the most a track can have`
        : `<i class="fa-solid fa-plus"></i> Add cue from selection${this.range ? ` (${formatCueTime(Math.min(this.range.a, this.range.b))} – ${formatCueTime(Math.max(this.range.a, this.range.b))})` : ": drag across the waveform first"}`;
      this.el.snap.value = this.snap;
      this.el.snap.querySelector("[value=beat]").disabled = !(this.sheet.bpm! > 0);
      this.draw();
    }

    renderNote(): void {
      const d = this.duration;
      const notes: string[] = [];
      if (d > CUE_BUFFER_MAX_S) notes.push(`Over ${CUE_BUFFER_MAX_S / 60} minutes: decks load only your cues' stretches (M4A, MP3 or WAV play them exactly; other formats stream, and their loops are approximate).`);
      else if (d > 600) notes.push(`Large file: a track this long uses about ${Math.round((d / 60) * 23)} MB of memory on each player's computer.`);
      const deck = this.playingOn();
      if (deck) notes.push(`Playing on ${deck} now: saved changes apply from its next loop.`);
      this.el.note.hidden = !notes.length;
      this.el.note.textContent = notes.join(" ");
    }

    playingOn(): string | null {
      for (const p of game.playlists) {
        const ch = channelOf(p);
        if (!ch) continue;
        if (p.sounds.some((s: any) => s.playing && s.path === this.path)) return ch === "A" || ch === "B" ? `Deck ${ch}` : ch === "ambient" ? "the ambient layers" : "an SFX pad";
      }
      return null;
    }

    renderOverlay(): void {
      const o = this.el.overlay as HTMLElement;
      const s = this.status;
      o.hidden = s.kind === "ready" || (!!this.peaks && s.kind !== "error");
      if (o.hidden) return;
      if (s.kind === "loading") {
        const mb = (n: number) => (n / 1e6).toFixed(1);
        const pct = s.total ? Math.round((s.received / s.total) * 100) : null;
        o.innerHTML = `<div class="mdte-loading"><span>Reading the waveform… ${s.total ? `${mb(s.received)} / ${mb(s.total)} MB` : `${mb(s.received)} MB`}</span>
          <div class="mdte-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" ${pct === null ? "" : `aria-valuenow="${pct}"`}><i style="width:${pct ?? 30}%"></i></div></div>`;
      } else if (s.kind === "decoding") {
        o.innerHTML = `<div class="mdte-loading"><span>Decoding the audio…</span><div class="mdte-bar mdte-bar-busy" role="progressbar"><i></i></div></div>`;
      } else if (s.kind === "error") {
        o.innerHTML = `<div class="mdte-error"><i class="fa-solid fa-triangle-exclamation"></i><span></span><button type="button" class="mdte-btn" data-act="retry"><i class="fa-solid fa-rotate-right"></i><span>Retry</span></button></div>`;
        o.querySelector("span")!.textContent = `${s.message} The cue list below can still be edited as numbers.`;
      }
    }

    renderFoot(): void {
      this.el.save.classList.toggle("dirty", this.dirty);
      this.el.save.disabled = !this.dirty || !this.duration;
      if (!this.el.status.dataset.sticky) {
        this.el.status.textContent = this.preview ? `Previewing ${this.preview.label}. Only you can hear this.`
          : !this.sheet.cues.length ? "" : this.dirty ? "Unsaved changes." : "";
      }
    }

    say(text: string): void {
      this.el.status.textContent = text;
      this.el.status.dataset.sticky = "1";
      clearTimeout((this as any).sayTimer);
      (this as any).sayTimer = setTimeout(() => { delete this.el.status.dataset.sticky; this.renderFoot(); }, 4000);
    }

    /* ---- Waveform ---- */

    x(t: number): number { return (t - this.viewStart) * this.pps; }
    t(x: number): number { return this.viewStart + x / this.pps; }
    get waveWidth(): number { return this.el.wave.clientWidth || 1; }
    fitPps(): number { return this.duration ? this.waveWidth / this.duration : 1; }

    layout(): void {
      if (!this.pps || this.pps < this.fitPps()) this.pps = this.fitPps();
      this.clampView();
      this.draw();
      this.renderRegions();
    }

    clampView(): void {
      const span = this.waveWidth / this.pps;
      this.viewStart = Math.min(Math.max(0, this.viewStart), Math.max(0, this.duration - span));
    }

    zoom(factor: number, at = this.playhead): void {
      if (!this.duration) return;
      const px = this.x(at);
      this.pps = Math.min(MAX_PPS, Math.max(this.fitPps(), this.pps * factor));
      this.viewStart = at - px / this.pps;
      this.clampView();
      this.draw();
      this.renderRegions();
    }

    draw(): void {
      this.drawCanvas(this.el.canvas, this.viewStart, this.pps, true);
      this.drawCanvas(this.el.ovCanvas, 0, this.el.overview.clientWidth / (this.duration || 1), false);
      const ov = this.el.overview.clientWidth / (this.duration || 1);
      Object.assign(this.el.view.style, { left: `${this.viewStart * ov}px`, width: `${Math.max(4, (this.waveWidth / this.pps) * ov)}px` });
      this.renderPlayhead();
    }

    drawCanvas(canvas: HTMLCanvasElement, start: number, pps: number, fine: boolean): void {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const g = canvas.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (!this.peaks || !pps || !Number.isFinite(pps)) return;
      const css = getComputedStyle(this.root);
      const mid = h / 2;
      g.fillStyle = css.getPropertyValue("--md-line").trim() || "#3a3b46";
      g.fillRect(0, mid, w, 1);
      g.fillStyle = css.getPropertyValue(fine ? "--mdte-wave" : "--mdte-wave-dim").trim() || "#c4c2cc";
      const { data, spb, sr } = this.peaks;
      const raw = fine && this.track && sr / spb / pps < 1 ? this.track.buffer : null;
      for (let px = 0; px < w; px++) {
        const t0 = start + px / pps, t1 = start + (px + 1) / pps;
        if (t0 > this.duration) break;
        let lo: number, hi: number;
        if (raw) {
          lo = 0; hi = 0;
          const a = Math.floor(t0 * sr), b = Math.max(a + 1, Math.floor(t1 * sr));
          for (let c = 0; c < raw.numberOfChannels; c++) {
            const ch = raw.getChannelData(c);
            for (let i = a; i < b && i < ch.length; i++) { const v = ch[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
          }
        } else {
          [lo, hi] = peakRange(data, (t0 * sr) / spb, (t1 * sr) / spb);
        }
        const top = mid - hi * (mid - 2), bottom = mid - lo * (mid - 2);
        g.fillRect(px, top, 1, Math.max(1, bottom - top));
      }
    }

    renderPlayhead(): void {
      const x = this.x(this.playhead);
      this.el.playhead.style.transform = `translateX(${x}px)`;
      this.el.playhead.hidden = x < 0 || x > this.waveWidth || !this.duration;
      this.el.now.textContent = formatCueTime(this.playhead);
      if (this.range) {
        const a = Math.min(this.range.a, this.range.b), b = Math.max(this.range.a, this.range.b);
        Object.assign(this.el.range.style, { left: `${this.x(a)}px`, width: `${Math.max(1, (b - a) * this.pps)}px` });
      }
      this.el.range.hidden = !this.range;
    }

    /** Overlapping cues go in a second, thinner lane. */
    lanes(): Map<string, number> {
      const lanes = new Map<string, number>();
      let lane0End = -1;
      for (const c of this.sheet.cues) {
        const lane = c.start < lane0End - 1e-6 ? 1 : 0;
        if (!lane) lane0End = cueEnd(c, this.duration);
        lanes.set(c.id, lane);
      }
      return lanes;
    }

    renderRegions(): void {
      const d = this.duration;
      const lanes = this.lanes();
      const ov = this.el.overview.clientWidth / (d || 1);
      const regions: string[] = [], bands: string[] = [];
      this.sheet.cues.forEach((c, i) => {
        if (!d) return;
        const end = cueEnd(c, d);
        const color = colorOf(c, i);
        const num = c.pad ? String(c.pad) : "–";
        const sel = c.id === this.selected ? " sel" : "";
        const lane = lanes.get(c.id) ? " lane2" : "";
        const left = this.x(c.start), width = (end - c.start) * this.pps;
        if (left + width >= -8 && left <= this.waveWidth + 8) {
          // The flag sticks to the left edge while the cue's start is scrolled out of view.
          const flagAt = Math.min(Math.max(0, -left), Math.max(0, width - 40));
          regions.push(`<div class="mdte-region${sel}${lane}${c.mode === "once" ? " once" : ""}" data-id="${c.id}" style="--cue:${color};left:${left}px;width:${width}px">
            <div class="mdte-flag" style="transform:translateX(${flagAt}px);max-width:${Math.max(20, width - flagAt)}px"><b>${num}</b><span>${foundry.utils.escapeHTML(c.name)}</span>${c.mode === "loop" ? `<i class="fa-solid fa-repeat" aria-label="loops"></i>` : ""}</div>
            <div class="mdte-edge start" data-edge="start" data-id="${c.id}" aria-hidden="true"></div>
            <div class="mdte-edge end" data-edge="end" data-id="${c.id}" aria-hidden="true"></div>
          </div>`);
        }
        bands.push(`<div class="mdte-band${sel}${lane}" style="--cue:${color};left:${c.start * ov}px;width:${Math.max(2, (end - c.start) * ov)}px"><b>${num}</b></div>`);
      });
      this.el.regions.innerHTML = regions.join("");
      this.el.bands.innerHTML = bands.join("");
    }

    /* ---- Cue list ---- */

    renderList(): void {
      const list = this.el.list as HTMLElement;
      const focus = document.activeElement as HTMLElement | null;
      const keep = focus && list.contains(focus) ? { id: focus.closest<HTMLElement>("[data-id]")?.dataset.id, field: focus.dataset.field } : null;
      if (!this.sheet.cues.length) {
        list.innerHTML = `<p class="mdte-empty"><i class="fa-solid fa-hand-pointer"></i> Play and press <kbd>1</kbd>–<kbd>${PAD_COUNT}</kbd> to drop cues, or drag across the waveform.</p>`;
        return;
      }
      const d = this.duration;
      const esc = foundry.utils.escapeHTML;
      list.innerHTML = this.sheet.cues.map((c, i) => {
        const color = colorOf(c, i);
        const end = d ? cueEnd(c, d) : c.end ?? 0;
        const after = c.after ?? "stop";
        const afterVal = typeof after === "object" ? `cue:${after.cue}` : after;
        const endless = c.mode === "loop" && c.repeat === undefined;
        const others = this.sheet.cues.filter(o => o.id !== c.id);
        const then = endless
          ? `<select data-field="after" disabled aria-label="Then"><option>Loops until you switch</option></select>`
          : `<select data-field="after" aria-label="Then">
              <option value="stop" ${afterVal === "stop" ? "selected" : ""}>Then stop</option>
              <option value="next" ${afterVal === "next" ? "selected" : ""}>Then the next cue</option>
              <option value="hold" ${afterVal === "hold" ? "selected" : ""}>Then pause</option>
              ${others.map(o => `<option value="cue:${o.id}" ${afterVal === `cue:${o.id}` ? "selected" : ""}>Then ${esc(o.name)}</option>`).join("")}
            </select>`;
        const open = this.drawer === c.id;
        return `<div class="mdte-row${c.id === this.selected ? " sel" : ""}" role="listitem" data-id="${c.id}" style="--cue:${color}">
          <button type="button" class="mdte-pad" data-act="pad" data-tooltip-direction="RIGHT" ${c.pad ? `data-tooltip="Pad ${c.pad}: jump to it and play (key ${c.pad})" aria-label="Pad ${c.pad}: play ${esc(c.name)}"` : `data-tooltip="No Stream Deck pad (only 1–${PAD_COUNT} have one)" aria-label="Play ${esc(c.name)}"`}>${c.pad ?? "–"}</button>
          <input type="text" class="mdte-name" data-field="name" value="${esc(c.name)}" aria-label="Cue name" maxlength="40">
          <div class="mdte-time">
            <button type="button" class="mdte-icon" data-act="nudge" data-edge="start" data-dir="-1" aria-label="Start 10 ms earlier"><i class="fa-solid fa-chevron-left"></i></button>
            <input type="text" data-field="start" value="${formatCueTime(c.start)}" aria-label="Start" spellcheck="false">
            <button type="button" class="mdte-icon" data-act="nudge" data-edge="start" data-dir="1" aria-label="Start 10 ms later"><i class="fa-solid fa-chevron-right"></i></button>
          </div>
          <div class="mdte-time">
            <button type="button" class="mdte-icon" data-act="nudge" data-edge="end" data-dir="-1" aria-label="End 10 ms earlier"><i class="fa-solid fa-chevron-left"></i></button>
            <input type="text" data-field="end" value="${c.end === null ? "end" : formatCueTime(c.end)}" aria-label="End (type end for the end of the file)" spellcheck="false">
            <button type="button" class="mdte-icon" data-act="nudge" data-edge="end" data-dir="1" aria-label="End 10 ms later"><i class="fa-solid fa-chevron-right"></i></button>
          </div>
          <span class="mdte-len" aria-label="Length">${formatCueTime(Math.max(0, end - c.start)).replace(/^0:/, "")}</span>
          <div class="mdte-seg" role="group" aria-label="Mode">
            <button type="button" data-act="mode" data-mode="loop" aria-pressed="${c.mode === "loop"}"><i class="fa-solid fa-repeat"></i>Loop</button>
            <button type="button" data-act="mode" data-mode="once" aria-pressed="${c.mode === "once"}"><i class="fa-solid fa-arrow-right-long"></i>Once</button>
          </div>
          ${then}
          <button type="button" class="mdte-icon" data-act="more" aria-expanded="${open}" aria-label="More for ${esc(c.name)}" data-tooltip="Repeat, role, colour, default"><i class="fa-solid fa-ellipsis"></i></button>
        </div>
        ${open ? `<div class="mdte-drawer" data-id="${c.id}" style="--cue:${color}">
          <label>Repeat <input type="number" min="1" max="99" step="1" data-field="repeat" placeholder="∞" value="${c.repeat ?? ""}" ${c.mode === "loop" ? "" : "disabled"} aria-label="Times it plays (empty: forever)"></label>
          <label>Role <select data-field="role">
            <option value="">None</option>
            ${(["intro", "battle", "victory"] as CueRole[]).map(r => `<option value="${r}" ${c.role === r ? "selected" : ""}>${r[0].toUpperCase() + r.slice(1)}</option>`).join("")}
          </select></label>
          <span class="mdte-swatches" role="radiogroup" aria-label="Colour">${CUE_COLORS.map((col, k) => `<button type="button" role="radio" data-act="color" data-color="${col}" aria-checked="${color === col}" aria-label="Colour ${k + 1}" style="--sw:${col}">${k + 1}</button>`).join("")}</span>
          <label class="mdte-check"><input type="checkbox" data-field="default" ${this.sheet.defaultCue === c.id ? "checked" : ""}> Start here when the track is added</label>
          <button type="button" class="mdte-btn mdte-danger" data-act="delete"><i class="fa-solid fa-trash"></i><span>Delete cue</span></button>
        </div>` : ""}`;
      }).join("");
      if (keep?.id && keep.field) (list.querySelector(`[data-id="${keep.id}"] [data-field="${keep.field}"]`) as HTMLElement | null)?.focus();
    }

    /* ------------------------------------------------------------ */
    /*  Loading                                                      */
    /* ------------------------------------------------------------ */

    async load(): Promise<void> {
      this.status = { kind: "loading", received: 0, total: 0 };
      const cached = await cachedPeaks(this.path);
      if (cached && !this.peaks) {
        this.peaks = { data: cached.peaks, spb: cached.samplesPerBucket, sr: cached.sampleRate };
        if (!this.sheet.duration) this.sheet.duration = cached.duration;
        this.layout();
      }
      this.refresh();
      try {
        this.ctx ??= new AudioContext();
        this.out ??= new GainNode(this.ctx, { gain: 0.8 });
        this.out.connect(this.ctx.destination);
        let last = 0;
        const track = await loadTrack(this.path, this.ctx, (received, total) => {
          this.status = received >= total && total ? { kind: "decoding" } : { kind: "loading", received, total };
          const now = performance.now();
          if (now - last > 120) { last = now; this.renderOverlay(); }
        }, this.abort.signal);
        this.status = { kind: "decoding" };
        this.track = track;
        this.peaks = { data: track.peaks, spb: track.samplesPerBucket, sr: track.buffer.sampleRate };
        this.sheet.duration = track.buffer.duration;
        this.status = { kind: "ready" };
        this.pps = 0;
        this.layout();
        this.refresh();
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        this.status = { kind: "error", message: err?.message ?? String(err) };
        this.refresh();
      }
    }

    /* ------------------------------------------------------------ */
    /*  Editing                                                      */
    /* ------------------------------------------------------------ */

    cue(id: string | null | undefined): Cue | undefined {
      return id ? this.sheet.cues.find(c => c.id === id) : undefined;
    }

    change(mutate: () => void, { list = true } = {}): void {
      mutate();
      sortCues(this.sheet.cues);
      this.dirty = true;
      if (list) this.refresh();
      else { this.renderRegions(); this.renderFoot(); }
    }

    replaceCue(next: Cue): void {
      this.sheet.cues = this.sheet.cues.map(c => (c.id === next.id ? next : c));
    }

    snapT(t: number): number {
      if (this.snap === "beat" && this.sheet.bpm) t = snapToBeat(t, this.sheet.bpm, this.sheet.beatOffset ?? 0);
      if (this.snap !== "off" && this.track) t = nearestZeroCrossing(this.track.buffer.getChannelData(0), this.track.buffer.sampleRate, t);
      return Math.min(Math.max(0, t), this.duration);
    }

    select(id: string | null, { reveal = false } = {}): void {
      this.selected = id;
      const c = this.cue(id);
      if (reveal && c) {
        const span = this.waveWidth / this.pps;
        if (c.start < this.viewStart || c.start > this.viewStart + span) { this.viewStart = c.start - span * 0.1; this.clampView(); }
      }
      this.refresh();
    }

    padKey(pad: number, mod: "plain" | "alt" | "shift"): void {
      const t = this.snapT(this.playhead);
      const existing = cueOnPad(this.sheet.cues, pad);
      if (mod === "shift") {
        if (existing) this.change(() => this.replaceCue(setEdge(existing, "end", t, this.duration)));
        return;
      }
      if (existing && mod === "plain") {
        this.select(existing.id, { reveal: true });
        this.playCue(existing, "cue");
        return;
      }
      if (existing) {
        this.change(() => this.replaceCue(setEdge(existing, "start", t, this.duration)));
        return;
      }
      const made = dropCue(this.sheet.cues, pad, t, this.duration);
      if (!made) { this.say(this.sheet.cues.length >= MAX_CUES ? `A track can have ${MAX_CUES} cues at most.` : "No room for a cue there."); return; }
      this.change(() => { this.sheet.cues = made.cues; });
      this.selected = made.cue.id;
      this.refresh();
      this.say(`Cue ${pad} starts at ${formatCueTime(t)}.`);
    }

    deleteCue(c: Cue): void {
      if (this.drawer === c.id) this.drawer = null;
      this.change(() => {
        this.sheet.cues = this.sheet.cues.filter(x => x.id !== c.id);
        if (this.sheet.defaultCue === c.id) delete this.sheet.defaultCue;
      });
      this.selected = null;
      this.refresh();
      this.say(`Deleted ${c.name}. Cancel to get it back.`);
    }

    async save(): Promise<void> {
      if (!this.dirty || !this.duration) return;
      if (this.sheet.bpm !== undefined && !(this.sheet.bpm > 0)) delete this.sheet.bpm;
      const problems = await saveSheet({ ...this.sheet, path: this.path });
      this.sheet = foundry.utils.deepClone(getSheet(this.path) ?? { ...this.sheet, cues: [] });
      this.dirty = false;
      this.refresh();
      if (problems.length) this.say(`Saved. Fixed on the way: ${problems.join("; ")}.`);
      else this.say(this.playingOn() ? "Saved. The playing track uses the new times from its next loop." : "Saved.");
    }

    /* ------------------------------------------------------------ */
    /*  Preview (local only)                                         */
    /* ------------------------------------------------------------ */

    stopPreview(): void {
      if (!this.preview) return;
      for (const n of this.preview.nodes) { n.onended = null; try { n.stop(); } catch { /* not started */ } }
      this.preview = null;
      this.el.play?.classList.remove("on");
      if (this.el.play) this.el.play.innerHTML = `<i class="fa-solid fa-play"></i><span>Play</span>`;
      cancelAnimationFrame(this.raf);
      this.root?.querySelectorAll(".mdte-btn.on").forEach(b => b.classList.remove("on"));
      this.renderFoot();
    }

    startPreview(nodes: AudioBufferSourceNode[], seg: Segment, label: string, button: string, stopAt?: number): void {
      this.preview = { nodes, seg, label, stopAt };
      const last = nodes.at(-1)!;
      last.onended = () => { if (this.preview?.nodes.includes(last)) this.stopPreview(); };
      this.root.querySelector(`[data-act=${button}]`)?.classList.add("on");
      if (button === "play") this.el.play.innerHTML = `<i class="fa-solid fa-pause"></i><span>Pause</span>`;
      this.renderFoot();
      const tick = () => {
        if (!this.preview || !this.ctx) return;
        const now = this.ctx.currentTime;
        let seg = this.preview.seg;
        if ((this.preview as any).next && now >= (this.preview as any).next.when) seg = (this.preview as any).next;
        this.playhead = segmentFileTime(seg, now);
        const span = this.waveWidth / this.pps;
        if (this.playhead > this.viewStart + span * 0.98 || this.playhead < this.viewStart) { this.viewStart = this.playhead - span * 0.05; this.clampView(); this.draw(); this.renderRegions(); }
        this.renderPlayhead();
        this.raf = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(tick);
    }

    async ready(): Promise<{ ctx: AudioContext; out: GainNode; buffer: AudioBuffer } | null> {
      if (!this.track || !this.ctx || !this.out) return null;
      if (this.ctx.state !== "running") await this.ctx.resume();
      return { ctx: this.ctx, out: this.out, buffer: this.track.buffer };
    }

    async playFromHead(): Promise<void> {
      if (this.preview) { this.stopPreview(); return; }
      const a = await this.ready();
      if (!a) return;
      const at = this.playhead >= this.duration - 0.05 ? 0 : this.playhead;
      const seg: Segment = { when: a.ctx.currentTime + 0.03, fileAt: at, start: 0, loopStart: 0, end: this.duration, loop: false, seam: 0 };
      const node = startSegmentNode(a.ctx, { buffer: a.buffer, offset: 0 }, seg);
      node.connect(a.out);
      this.startPreview([node], seg, "the track", "play");
    }

    /** Play a cue the way a deck plays it: from its start ("cue"), or its last 3 s into its loop point or next cue ("join"). */
    async playCue(cue: Cue, how: "cue" | "join"): Promise<void> {
      this.stopPreview();
      const a = await this.ready();
      if (!a) return;
      const d = this.duration;
      const end = cueEnd(cue, d);
      const when = a.ctx.currentTime + 0.03;
      const from = how === "join" ? Math.max(cue.start, end - JOIN_S) : cue.start;
      const seg = makeSegment(cue, d, when, from, cueSeam());
      const whole = { buffer: a.buffer, offset: 0 };
      const node = startSegmentNode(a.ctx, whole, seg);
      const g0 = new GainNode(a.ctx, { gain: 1 });
      node.connect(g0).connect(a.out);
      const label = how === "join" ? `the join of ${cue.name}` : cue.name;
      if (how === "cue" || cue.mode === "loop") {
        if (how === "join") node.stop(when + (end - from) + Math.min(JOIN_S, end - seg.loopStart));
        this.startPreview([node], seg, label, how === "join" ? "join" : "loop");
        return;
      }
      // A once-cue's join: its last seconds, then whatever follows it, handed over as a deck would.
      const next = this.sheet.cues.length ? resolveAfter(this.sheet, cue) : "stop";
      if (typeof next !== "object" || !next) { this.startPreview([node], seg, label, "join"); return; }
      // Handed over exactly as a deck does it (the same code), with the same ring-out.
      const t = when + (end - from);
      const sw = scheduleSwitch(a.ctx, { seg, node, gain: g0, clip: whole }, next, whole, t, { seam: cueSeam(), ringOut: cueRingOut(), head: a.out, fileDuration: d });
      sw.node.stop(t + JOIN_S);
      this.startPreview([node, sw.node, ...(sw.bridge ? [sw.bridge] : [])], seg, label, "join");
      (this.preview as any).next = sw.seg;
    }

    /* ------------------------------------------------------------ */
    /*  Events                                                       */
    /* ------------------------------------------------------------ */

    wire(): void {
      const r = this.root;
      r.addEventListener("click", ev => this.onClick(ev));
      r.addEventListener("change", ev => this.onChange(ev));
      r.addEventListener("keydown", ev => this.onKey(ev));
      r.addEventListener("pointerdown", ev => this.onPointer(ev));
      this.el.wave.addEventListener("wheel", (ev: WheelEvent) => this.onWheel(ev), { passive: false });
      r.addEventListener("focusin", ev => {
        const row = (ev.target as HTMLElement).closest<HTMLElement>(".mdte-row");
        if (row && row.dataset.id !== this.selected) { this.selected = row.dataset.id!; this.renderRegions(); this.root.querySelectorAll(".mdte-row").forEach(e => e.classList.toggle("sel", (e as HTMLElement).dataset.id === this.selected)); }
      });
    }

    onClick(ev: MouseEvent): void {
      const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      const id = btn.closest<HTMLElement>("[data-id]")?.dataset.id;
      const c = this.cue(id);
      switch (btn.dataset.act) {
        case "play": this.playFromHead(); break;
        case "loop": { const s = this.cue(this.selected); if (s) this.preview ? this.stopPreview() : this.playCue({ ...s, mode: "loop", repeat: undefined }, "cue"); break; }
        case "join": { const s = this.cue(this.selected); if (s) this.playCue(s, "join"); break; }
        case "zoom-in": this.zoom(2); break;
        case "zoom-out": this.zoom(0.5); break;
        case "zoom-fit": this.pps = this.fitPps(); this.viewStart = 0; this.draw(); this.renderRegions(); break;
        case "add": {
          if (!this.range) break;
          const a = this.snapT(Math.min(this.range.a, this.range.b)), b = this.snapT(Math.max(this.range.a, this.range.b));
          const made = addCue(this.sheet.cues, a, b, this.duration);
          if (!made) { this.say("That selection is too short for a cue."); break; }
          this.range = null;
          this.change(() => { this.sheet.cues = made.cues; });
          this.select(made.cue.id);
          break;
        }
        case "first-beat": this.change(() => { this.sheet.beatOffset = this.playhead; }); this.say(`First beat at ${formatCueTime(this.playhead)}.`); break;
        case "save": this.save(); break;
        case "cancel": this.close(); break;
        case "retry": this.load(); break;
        case "pad": if (c) { this.select(c.id, { reveal: true }); this.playCue(c, "cue"); } break;
        case "nudge": if (c) { const edge = btn.dataset.edge as "start" | "end"; const step = (ev.shiftKey ? 10 : 1) * NUDGE_S * Number(btn.dataset.dir); const cur = edge === "start" ? c.start : cueEnd(c, this.duration); this.change(() => this.replaceCue(setEdge(c, edge, cur + step, this.duration))); } break;
        case "mode": if (c) this.change(() => this.replaceCue({ ...c, mode: btn.dataset.mode as Cue["mode"] })); break;
        case "more": if (id) { this.drawer = this.drawer === id ? null : id; this.renderList(); } break;
        case "color": if (c) this.change(() => this.replaceCue({ ...c, color: btn.dataset.color })); break;
        case "delete": if (c) this.deleteCue(c); break;
      }
      if (btn.closest(".mdte-transport, .mdte-head")) this.root.focus({ preventScroll: true });
    }

    onChange(ev: Event): void {
      const input = ev.target as HTMLInputElement;
      const field = input.dataset.field;
      if (!field) return;
      if (field === "snap") { this.snap = input.value as Snap; return; }
      if (field === "bpm") { const v = Number(input.value); this.change(() => { if (v > 0) this.sheet.bpm = v; else delete this.sheet.bpm; }); return; }
      const c = this.cue(input.closest<HTMLElement>("[data-id]")?.dataset.id);
      if (!c) return;
      switch (field) {
        case "name": this.change(() => this.replaceCue({ ...c, name: input.value.trim() || c.name })); break;
        case "start": case "end": {
          const t = parseCueTime(input.value);
          if (t === undefined || (field === "start" && t === null)) { input.setCustomValidity("Type a time like 1:45.020"); input.reportValidity(); return; }
          input.setCustomValidity("");
          this.change(() => this.replaceCue(setEdge(c, field, t, this.duration)));
          break;
        }
        case "after": {
          const v = input.value;
          this.change(() => this.replaceCue({ ...c, after: v.startsWith("cue:") ? { cue: v.slice(4) } : (v as any) }));
          break;
        }
        case "repeat": { const n = Math.round(Number(input.value)); this.change(() => { const next = { ...c }; if (n >= 1) next.repeat = n; else delete next.repeat; this.replaceCue(next); }); break; }
        case "role": this.change(() => { const next = { ...c }; if (input.value) next.role = input.value as CueRole; else delete next.role; this.replaceCue(next); }); break;
        case "default": this.change(() => { if (input.checked) this.sheet.defaultCue = c.id; else if (this.sheet.defaultCue === c.id) delete this.sheet.defaultCue; }); break;
      }
    }

    onKey(ev: KeyboardEvent): void {
      const target = ev.target as HTMLElement;
      const typing = target.matches("input, select, textarea");
      const mod = ev.ctrlKey || ev.metaKey;
      const handled = () => { ev.preventDefault(); ev.stopPropagation(); };
      if (mod && ev.key.toLowerCase() === "s") {
        handled();
        // Commit a half-typed field first (its change event), without losing the editor's focus.
        if (typing) { (target as HTMLInputElement).blur(); this.root.focus({ preventScroll: true }); }
        this.save();
        return;
      }
      if (typing) {
        if (ev.key === "Enter") { handled(); (target as HTMLInputElement).blur(); this.root.focus({ preventScroll: true }); }
        else ev.stopPropagation(); // keep Foundry's shortcuts (e.g. the hotbar on 1–0) out of text fields
        return;
      }
      const digit = /^(Digit|Numpad)([1-8])$/.exec(ev.code);
      if (digit && !mod) { handled(); this.padKey(Number(digit[2]), ev.altKey ? "alt" : ev.shiftKey ? "shift" : "plain"); return; }
      const sel = this.cue(this.selected);
      switch (ev.key) {
        case " ": handled(); this.playFromHead(); return;
        case "i": case "I": if (sel) { handled(); this.change(() => this.replaceCue(setEdge(sel, "start", this.snapT(this.playhead), this.duration))); } return;
        case "o": case "O": if (sel) { handled(); this.change(() => this.replaceCue(setEdge(sel, "end", this.snapT(this.playhead), this.duration))); } return;
        case "l": case "L": if (sel) { handled(); this.preview ? this.stopPreview() : this.playCue({ ...sel, mode: "loop", repeat: undefined }, "cue"); } return;
        case "j": case "J": if (sel) { handled(); this.playCue(sel, "join"); } return;
        case "ArrowLeft": case "ArrowRight":
          handled();
          if (!this.preview) { this.playhead = Math.min(Math.max(0, this.playhead + (ev.key === "ArrowLeft" ? -1 : 1) * (ev.shiftKey ? 10 : 1) * NUDGE_S), this.duration); this.renderPlayhead(); }
          return;
        case "+": case "=": handled(); this.zoom(2); return;
        case "-": case "_": handled(); this.zoom(0.5); return;
        case "Delete": case "Backspace": if (sel) { handled(); this.deleteCue(sel); } return;
        case "Escape": if (this.range || this.selected) { handled(); this.range = null; this.selected = null; this.refresh(); } return;
      }
    }

    onWheel(ev: WheelEvent): void {
      if (!this.duration) return;
      ev.preventDefault();
      const rect = this.el.wave.getBoundingClientRect();
      if (ev.ctrlKey || ev.metaKey) { this.zoom(ev.deltaY < 0 ? 1.25 : 0.8, this.t(ev.clientX - rect.left)); return; }
      this.viewStart += (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY) / this.pps;
      this.clampView();
      this.draw();
      this.renderRegions();
    }

    onPointer(ev: PointerEvent): void {
      if (ev.button !== 0 || !this.duration) return;
      const target = ev.target as HTMLElement;
      const zone = target.closest<HTMLElement>("[data-zone]")?.dataset.zone;
      if (!zone) return;
      ev.preventDefault();
      this.root.focus({ preventScroll: true });
      const surface = zone === "wave" ? this.el.wave : this.el.overview;
      const rect = surface.getBoundingClientRect();
      const tAt = (cx: number) => (zone === "wave" ? this.t(cx - rect.left) : ((cx - rect.left) / rect.width) * this.duration);
      surface.setPointerCapture(ev.pointerId);
      const done = (fn: (e: PointerEvent) => void) => {
        surface.addEventListener("pointermove", fn);
        surface.addEventListener("pointerup", (e: PointerEvent) => { surface.removeEventListener("pointermove", fn); up(e); }, { once: true });
      };
      let up = (_e: PointerEvent) => {};

      if (zone === "overview") {
        const center = (e: PointerEvent) => { this.viewStart = tAt(e.clientX) - this.waveWidth / this.pps / 2; this.clampView(); this.draw(); this.renderRegions(); };
        center(ev);
        done(center);
        return;
      }

      const edge = target.closest<HTMLElement>("[data-edge]");
      if (edge) {
        const c = this.cue(edge.dataset.id);
        if (!c) return;
        this.selected = c.id;
        const which = edge.dataset.edge as "start" | "end";
        done(e => { this.replaceCue(setEdge(this.cue(c.id)!, which, this.snapT(tAt(e.clientX)), this.duration)); this.dirty = true; this.renderRegions(); });
        up = () => this.change(() => {});
        return;
      }

      const region = target.closest<HTMLElement>(".mdte-region");
      const x0 = ev.clientX, t0 = tAt(ev.clientX);
      let dragging = false;
      done(e => {
        if (!dragging && Math.abs(e.clientX - x0) < 4) return;
        dragging = true;
        this.range = { a: t0, b: tAt(e.clientX) };
        this.renderPlayhead();
      });
      up = e => {
        if (dragging) { this.refresh(); return; }
        this.range = null;
        if (!this.preview) this.playhead = this.snapT(tAt(e.clientX));
        if (region) this.select(region.dataset.id!);
        else this.refresh();
      };
    }
  };
  return EditorClass;
}
