/**
 * CueSound: a foundry.audio.Sound that plays cue ranges.
 *
 * Foundry's own loop options can't place a pause or resume inside a cue, report the file time, or overlap two
 * sources for a crossfade. So with a cue set, CueSound leaves Foundry's source node unused and schedules its own
 * AudioBufferSourceNodes into Foundry's pipeline (the effects, i.e. our live-gain node, then the gainNode). Every
 * switch is scheduled on the audio clock, so "at the end of the loop" is sample-exact. With no cue it is a plain
 * Foundry Sound. Every client runs the same code from the same document data, so everyone hears the same thing.
 *
 * How joins sound (all three lengths are settings):
 * - A loop's seam: the music after the cue rings out while its head comes back in, and the loop stays exactly
 *   as long as the cue (loop.ts cueLoopCopy).
 * - A switch at the end of the loop: the new cue starts on the boundary, and the old one rings on past its end
 *   and fades out over `ringOut`. Cues that meet (one ends where the next starts) simply run on.
 * - A switch now: an equal-power crossfade.
 *
 * Files too long to decode whole (over CUE_BUFFER_MAX_S) get just their cues' stretches decoded ("clips",
 * cue-clips.ts) and play from those exactly the same way. A format we can't cut streams instead, through two
 * audio elements of our own that take turns; their timing comes from a timer, so they land within a few tens of
 * ms rather than on the sample.
 */
import {
  HEAD_IN_S, MICRO_XFADE_S, MUSIC_BLEND_S, RING_OUT_S, SCHEDULE_LEAD_S, cueEnd, makeSegment, nextBoundary, repeatEnd,
  resolveAfter, segmentFileTime, type Cue, type CueChain, type CueSheet, type CueWhen, type Segment,
} from "./cues";
import { seamlessRange } from "./loop";
import { clipCovering, type Clip } from "./cue-clips";

interface Live {
  seg: Segment;
  cue: Cue | null;
  /** The decoded audio this segment plays from (the whole file, or a clip of it). */
  clip: Clip;
  node: AudioBufferSourceNode;
  gain: GainNode;
  dead?: boolean;
}

/** Streamed mode: what a cue's end does when it moves on, running straight on or jumping to `fileAt`. */
interface Step {
  kind: "run" | "jump";
  fileAt: number;
  next: Cue;
  xfade: number;
  changed: boolean;
}

/** Streamed mode: one of our two audio elements. */
interface Player {
  el: HTMLAudioElement;
  gain: GainNode;
}

export interface CueSoundApi {
  sheet: CueSheet;
  cue: Cue | null;
  /** Seam at a loop's wrap, seconds. */
  blend: number;
  /** How long the old cue rings on after a switch at the end of the loop, seconds. */
  ringOut: number;
  /** Per-sound overrides of each cue's `after` (combat's intro → battle, victory → stop). */
  chain: CueChain | null;
  readonly playingCue: Cue | null;
  readonly playing: boolean;
  readonly fileDuration: number;
  /** Switch to another cue of this file. Returns the audio-clock time the switch happens (or null if not playing). */
  goTo(cue: Cue, when: CueWhen, fade: number): number | null;
  /** Called on every client when the playing cue changes by itself (an after-chain). */
  onCueChange?: (cue: Cue) => void;
  /** Called on every client when a cue with `after: "hold"` reaches its end, with the file time it stopped at. */
  onHold?: (fileTime: number) => void;
}

let CueSoundClass: any;

/**
 * Create and start the source node for one segment: a loop plays a looping copy of just the cue range with its
 * seam built in (and records how much of its tail differs from the file in `seg.seam`); a once-cue plays the
 * original range. Shared by CueSound and the track editor's preview, so what the GM previews is what the table
 * hears.
 */
export function startSegmentNode(ctx: BaseAudioContext, clip: Clip, seg: Segment): AudioBufferSourceNode {
  let node: AudioBufferSourceNode;
  const { buffer, offset: o } = clip;
  if (seg.loop) {
    const copy = seg.seam > 0 ? seamlessRange(buffer, seg.start - o, seg.end - o, seg.seam, HEAD_IN_S) : null;
    if (copy) {
      node = new AudioBufferSourceNode(ctx, { buffer: copy.buffer });
      node.loop = true;
      node.loopStart = copy.loopStart;
      node.loopEnd = copy.loopEnd;
      node.start(seg.when, seg.fileAt - seg.start);
      seg.loopStart = seg.start + copy.shrink;
      seg.seam = copy.seam;
    } else {
      node = new AudioBufferSourceNode(ctx, { buffer });
      node.loop = true;
      node.loopStart = seg.start - o;
      node.loopEnd = seg.end - o;
      node.start(seg.when, seg.fileAt - o);
      seg.loopStart = seg.start;
      seg.seam = 0;
    }
  } else {
    node = new AudioBufferSourceNode(ctx, { buffer });
    node.start(seg.when, seg.fileAt - o, seg.end - seg.fileAt);
  }
  return node;
}

/**
 * Hand over from a playing segment to `cue` at the boundary `t`, on the audio clock (CueSound and the editor's
 * preview). The old cue's real audio plays from `t − seam` (its loop copy's tail differs from the file there)
 * and, unless the cues meet, rings on past its end, fading out over `ringOut`. Returns the new segment's node,
 * gain and segment, started at `t`.
 */
export function scheduleSwitch(
  ctx: BaseAudioContext, cur: { seg: Segment; node: AudioBufferSourceNode; gain: GainNode; clip: Clip },
  cue: Cue, next: Clip, t: number, opts: { seam: number; ringOut: number; head: AudioNode; fileDuration: number },
): { seg: Segment; node: AudioBufferSourceNode; gain: GainNode; ringEnd: number; bridge: AudioBufferSourceNode | null } {
  const meet = Math.abs(cue.start - cur.seg.end) < 0.002;
  const seam = cur.seg.loop ? cur.seg.seam : 0;
  // The old cue can only ring on as far as its decoded audio (and the file) goes.
  const room = cur.clip.offset + cur.clip.buffer.duration - cur.seg.end;
  const ring = meet ? 0 : Math.min(Math.max(opts.ringOut, MICRO_XFADE_S), Math.max(0, room));
  cur.node.onended = null;
  let bridge: AudioBufferSourceNode | null = null;
  if (seam > 0 || ring > 0) {
    bridge = new AudioBufferSourceNode(ctx, { buffer: cur.clip.buffer });
    const g = new GainNode(ctx, { gain: 1 });
    bridge.connect(g).connect(cur.gain);
    bridge.start(t - seam, cur.seg.end - seam - cur.clip.offset, seam + ring);
    if (ring > 0) g.gain.setValueCurveAtTime(curves().down, t, ring);
    cur.node.stop(t - seam);
  } else cur.node.stop(t);
  const seg = makeSegment(cue, opts.fileDuration, t, cue.start, opts.seam);
  const gain = new GainNode(ctx, { gain: meet ? 1 : 0 });
  gain.connect(opts.head);
  const node = startSegmentNode(ctx, next, seg);
  node.connect(gain);
  if (!meet) gain.gain.setValueCurveAtTime(curves().up, t, Math.min(HEAD_IN_S, Math.max(ring, MICRO_XFADE_S)));
  return { seg, node, gain, ringEnd: t + ring, bridge };
}

export const isCueSound = (sound: any): sound is CueSoundApi => !!CueSoundClass && sound instanceof CueSoundClass;

/** The class is built on first use: foundry.audio.Sound only exists once Foundry has loaded. */
export function cueSoundClass(): any {
  if (CueSoundClass) return CueSoundClass;
  const Sound = foundry.audio.Sound;
  const STATES = Sound.STATES;

  CueSoundClass = class CueSound extends Sound {
    sheet!: CueSheet;
    cue: Cue | null = null;
    blend = MUSIC_BLEND_S;
    ringOut = RING_OUT_S;
    chain: CueChain | null = null;
    onCueChange?: (cue: Cue) => void;
    onHold?: (fileTime: number) => void;
    /** A long file's decoded cue stretches, and how to (re)load them (set by cue-player). */
    clips: Clip[] | null = null;
    clipLoader?: () => Promise<Clip[] | null>;
    #lives: Live[] = [];
    #offset: number | undefined;
    #foundryStarted = false;
    /** Streamed mode: our two audio elements, the one you hear, and what happens at the cue's end. */
    #players: Player[] = [];
    #on: Player | null = null;
    #target: Cue | null = null;
    #plays = 0;
    #watch: ReturnType<typeof setTimeout> | undefined;
    #ready: { p: Player; fileAt: number } | null = null;
    #busy = false;

    /** Foundry loads the file (a buffer, or an element for a long one); a long file with cues also gets its clips. */
    async _load() {
      await super._load();
      if (!this.buffer && this.clipLoader) await this.refreshClips();
    }

    /** Load (or reload, after the cues changed) a long file's clips. Keeps streaming if they can't be made. */
    async refreshClips(): Promise<void> {
      if (this.buffer || !this.clipLoader) return;
      try {
        this.clips = (await this.clipLoader()) ?? this.clips;
      } catch (err) {
        console.warn("Music Deck | couldn't decode the cue stretches; streaming instead", err);
      }
    }

    /** The decoded audio holding a cue: the whole file, or the clip around it. */
    #clipFor(cue: Cue): Clip | undefined {
      if (this.buffer) return { buffer: this.buffer, offset: 0 };
      return clipCovering(this.clips, cue.start, cueEnd(cue, this.fileDuration));
    }

    get fileDuration(): number {
      return this.buffer?.duration ?? this.element?.duration ?? this.sheet?.duration;
    }

    /** Streaming, and we (not Foundry's element) are playing it. */
    get #streamed(): boolean {
      return !this.buffer && !!this.#on;
    }

    /**
     * Infinite while a cue plays. Foundry schedules a fade-out before the end of any finite sound; a cue ends
     * cleanly by itself, and Foundry's timer breaks on short cues (a zero-length AudioTimeout). The readouts
     * use `fileDuration`.
     */
    get duration(): number {
      if ((!this.cue && !this.#lives.length) || (!this.buffer && !this.element)) return super.duration;
      return Infinity;
    }

    /** The file time, wherever in the cue we are (Foundry's own would be cue-relative). */
    get currentTime(): number | undefined {
      if (this.#streamed) return this._state === STATES.PLAYING ? this.#on!.el.currentTime : this.pausedTime;
      if (!this.#lives.length) return super.currentTime;
      if (this._state !== STATES.PLAYING) return this.pausedTime;
      const now = this.context.currentTime;
      const live = this.#current(now);
      return live ? segmentFileTime(live.seg, now) : this.pausedTime;
    }

    get playingCue(): Cue | null {
      if (this.#streamed) return this.cue;
      return this.#current(this.context.currentTime)?.cue ?? this.cue;
    }

    play(options: any = {}) {
      this.#offset = Number.isFinite(options?.offset) ? options.offset : undefined;
      return super.play(options);
    }

    _play() {
      const at = this.#offset ?? (Number.isFinite(this.pausedTime) ? this.pausedTime : this.cue?.start);
      this.#offset = undefined;
      const clip = this.cue && this.#clipFor(this.cue);
      if (this.cue && !clip && this.element) {
        this.#foundryStarted = false;
        return this.#streamBegin(this.cue, at ?? this.cue.start);
      }
      if (!this.cue || !clip) {
        this.#foundryStarted = true;
        return super._play();
      }
      this.#killAll();
      this.#foundryStarted = false;
      this.#begin(this.cue, at!, this.context.currentTime + SCHEDULE_LEAD_S, 0);
    }

    _pause() {
      if (this.#foundryStarted) super._pause();
      this.#killAll();
      this.#streamPause();
    }

    _stop() {
      this.#streamPause();
      this.#on = null;
      if (this.#foundryStarted || !this.buffer) super._stop();
      else this.gain.cancelScheduledValues(this.context.currentTime);
      this.#foundryStarted = false;
      this.#killAll();
    }

    goTo(cue: Cue, when: CueWhen, fade: number): number | null {
      const playing = this._state === STATES.PLAYING;
      const clip = this.#clipFor(cue);
      // Streaming (a format we can't cut, or a cue outside the clips): the two-element engine.
      if (playing && (this.#on || (!clip && !this.buffer && this.element))) return this.#streamGoTo(cue, when, fade);
      if (!playing || !clip) {
        this.cue = cue;
        return null;
      }
      const ctx = this.context;
      const now = ctx.currentTime;
      if (!this.#lives.length) this.#adoptFoundryNode(now);
      // The whole of a long file was streaming through Foundry's element: hand over to the clip "now".
      if (!this.#lives.length && this.#foundryStarted && this.element) {
        const el = this.element;
        setTimeout(() => el.pause(), SCHEDULE_LEAD_S * 1000);
        this.#foundryStarted = false;
        when = "now";
      }
      const cur = this.#current(now);
      // A newer request replaces anything still waiting to start.
      for (const l of this.#lives.filter(l => l !== cur && l.seg.when > now)) this.#kill(l);
      this.#lives = this.#lives.filter(l => !l.dead);
      this.cue = cue;

      if (when === "now" || !cur) {
        const t = now + SCHEDULE_LEAD_S;
        const f = Math.max(0.01, fade);
        const next = this.#begin(cue, cue.start, t, f);
        const { up, down } = curves();
        for (const l of this.#lives) {
          if (l === next) continue;
          l.node.onended = null;
          l.gain.gain.cancelScheduledValues(t);
          l.gain.gain.setValueCurveAtTime(down.map(v => v * l.gain.gain.value), t, f);
          l.node.stop(t + f + 0.01);
          setTimeout(() => this.#drop(l), (t + f - now) * 1000 + 100);
        }
        next.gain.gain.setValueCurveAtTime(up, t, f);
        return t;
      }

      const t = nextBoundary(cur.seg, now, SCHEDULE_LEAD_S + this.#preRoll(cur));
      this.#switchAt(cur, cue, t);
      return t;
    }

    /** Seconds before the boundary that a switch away from `cur` starts working (the real tail under its seam). */
    #preRoll(cur: Live): number {
      return (cur.seg.loop ? cur.seg.seam : 0) + MICRO_XFADE_S;
    }

    /** Hand over from `cur` to `cue` at the boundary `t` (see scheduleSwitch). */
    #switchAt(cur: Live, cue: Cue, t: number): Live {
      const next = this.#clipFor(cue);
      if (!next) {
        // The cues changed while this played and the new one isn't decoded yet: stay on the current cue.
        console.warn(`Music Deck | "${cue.name}" isn't loaded yet; play the track again to use it.`);
        void this.refreshClips();
        return cur;
      }
      const { seg, node, gain, ringEnd } = scheduleSwitch(this.context, cur, cue, next, t, { seam: this.blend, ringOut: this.ringOut, head: this.#head(), fileDuration: this.fileDuration });
      setTimeout(() => this.#drop(cur), (ringEnd - this.context.currentTime) * 1000 + 100);
      const live: Live = { seg, cue, node, gain, clip: next };
      this.#lives.push(live);
      this.#afterStart(live);
      return live;
    }

    #head(): AudioNode {
      return this.effects[0] ?? this.gainNode;
    }

    #current(now: number): Live | undefined {
      let c: Live | undefined;
      for (const l of this.#lives) if (!l.dead && l.seg.when <= now + 1e-6) c = l;
      return c ?? this.#lives.find(l => !l.dead);
    }

    /** Start one segment of `cue` at audio time `when`, and plan what follows it. */
    #begin(cue: Cue, fileAt: number, when: number, fade: number): Live {
      const ctx = this.context;
      const seg = makeSegment(cue, this.fileDuration, when, fileAt, this.blend);
      const gain = new GainNode(ctx, { gain: fade ? 0 : 1 });
      gain.connect(this.#head());
      const clip = this.#clipFor(cue)!;
      const node = startSegmentNode(ctx, clip, seg);
      node.connect(gain);
      const live: Live = { seg, cue, node, gain, clip };
      this.#lives.push(live);
      this.#afterStart(live);
      return live;
    }

    /** Plan the next step once a segment is under way, so a chain of cues never schedules itself forever. */
    #afterStart(live: Live): void {
      const delay = Math.max(0, (live.seg.when - this.context.currentTime) * 1000);
      if (delay < 20) this.#planAfter(live);
      else setTimeout(() => !live.dead && this.#planAfter(live), delay);
    }

    /** What happens when a once-cue ends, or a loop-cue has played `repeat` times. */
    #planAfter(live: Live): void {
      const cue = live.cue;
      if (!cue || !this.sheet) return;
      const after = resolveAfter(this.sheet, cue, this.chain);
      if (after === null) return;
      const end = live.seg.loop ? repeatEnd(live.seg, cue.repeat ?? 1) : live.seg.when + (live.seg.end - live.seg.fileAt);
      const now = this.context.currentTime;
      if (typeof after === "object") {
        this.cue = after;
        const next = this.#switchAt(live, after, Math.max(end, now + SCHEDULE_LEAD_S + this.#preRoll(live)));
        setTimeout(() => {
          if (!next.dead) this.onCueChange?.(after);
        }, Math.max(0, (end - now) * 1000));
        return;
      }
      if (live.seg.loop) live.node.stop(end);
      const fileTime = live.seg.end;
      live.node.onended = () => {
        if (live.dead || this.#current(this.context.currentTime + 1) !== live) return;
        if (after === "hold") this.onHold?.(fileTime);
        else this.#ended();
      };
    }

    async #ended(): Promise<void> {
      await this.stop();
      this.dispatchEvent(new Event("end"));
    }

    /** Playing the whole file through Foundry's node, then asked to switch: take that node over as a segment. */
    #adoptFoundryNode(now: number): void {
      const node = this.sourceNode;
      if (!(node instanceof AudioBufferSourceNode) || !this.buffer) return;
      const gain = new GainNode(this.context, { gain: 1 });
      node.disconnect();
      node.connect(gain);
      gain.connect(this.#head());
      const duration = this.fileDuration;
      const fileNow = ((now - this.startTime) % duration + duration) % duration;
      const seg: Segment = { when: now - fileNow, fileAt: 0, start: 0, loopStart: 0, end: duration, loop: !!this.loop, seam: 0 };
      this.#lives.push({ seg, cue: null, node, gain, clip: { buffer: this.buffer, offset: 0 } });
    }

    #kill(l: Live): void {
      l.dead = true;
      l.node.onended = null;
      try { l.node.stop(); } catch { /* never started */ }
      try { l.gain.disconnect(); } catch { /* already */ }
    }

    #drop(l: Live): void {
      if (l.dead) return;
      this.#kill(l);
      this.#lives = this.#lives.filter(x => x !== l);
    }

    #killAll(): void {
      for (const l of this.#lives) {
        // Foundry stops its own node itself.
        if (l.node === this.sourceNode) { l.dead = true; try { l.gain.disconnect(); } catch { /* already */ } continue; }
        this.#kill(l);
      }
      this.#lives = [];
    }

    // ── Streamed mode ───────────────────────────────────────────────────────────

    /** One of our two elements that isn't the one you hear (made on first use, wired into Foundry's pipeline). */
    #idle(): Player {
      let p = this.#players.find(x => x !== this.#on);
      if (!p) {
        const el = new Audio();
        el.crossOrigin = "anonymous";
        el.preload = "auto";
        el.src = this.element?.currentSrc || this.element?.src || this.src;
        const gain = new GainNode(this.context, { gain: 0 });
        this.context.createMediaElementSource(el).connect(gain);
        p = { el, gain };
        this.#players.push(p);
      }
      try { p.gain.disconnect(); } catch { /* not connected */ }
      p.gain.connect(this.#head());
      return p;
    }

    /** Start `cue` streaming at file time `at` (Foundry's own element stays paused). */
    #streamBegin(cue: Cue, at: number): void {
      this.element?.pause();
      this.cue = cue;
      this.#target = null;
      this.#plays = 0;
      this.#ready = null;
      const end = cueEnd(cue, this.fileDuration);
      const p = this.#on ?? this.#idle();
      for (const x of this.#players) if (x !== p) { x.el.pause(); x.gain.gain.cancelScheduledValues(0); x.gain.gain.value = 0; }
      try { p.gain.disconnect(); } catch { /* not connected */ }
      p.gain.connect(this.#head());
      p.el.currentTime = at >= cue.start && at < end - 0.05 ? at : cue.start;
      this.#ramp(p, 1, 0.01);
      void p.el.play().catch(() => {});
      this.#on = p;
      this.#arm();
    }

    #streamGoTo(cue: Cue, when: CueWhen, fade: number): number {
      const now = this.context.currentTime;
      if (!this.#on) {
        // The whole file was playing through Foundry's element: start our own on the cue.
        this.#foundryStarted = false;
        this.#streamBegin(cue, cue.start);
        return now + SCHEDULE_LEAD_S;
      }
      if (when === "now" || !this.cue) {
        this.#target = null;
        void this.#crossTo(cue.start, Math.max(0.05, fade), "equal", () => { this.cue = cue; this.#plays = 0; });
        return now + SCHEDULE_LEAD_S;
      }
      this.#target = cue;
      this.#ready = null;
      this.#arm();
      const el = this.#on.el;
      return now + Math.max(0, cueEnd(this.cue, this.fileDuration) - el.currentTime) / (el.playbackRate || 1);
    }

    /** What the cue's end will do: run on, jump (seam or ring-out), stop or hold. */
    #plan(): Step | { kind: "stop" | "hold" } | null {
      const cue = this.cue;
      if (!cue || !this.sheet) return null;
      const end = cueEnd(cue, this.fileDuration);
      const move = (next: Cue, changed: boolean) => (Math.abs(next.start - end) < 0.002
        ? { kind: "run" as const, fileAt: next.start, next, xfade: 0, changed }
        : { kind: "jump" as const, fileAt: next.start, next, xfade: this.ringOut, changed });
      if (this.#target) return move(this.#target, false);
      const after = resolveAfter(this.sheet, cue, this.chain);
      const again = cue.mode === "loop" && (after === null || this.#plays + 1 < (cue.repeat ?? 1));
      if (again) return { kind: "jump", fileAt: cue.start, next: cue, xfade: this.blend, changed: false };
      if (after === null) return null;
      if (typeof after === "object") return move(after, true);
      return { kind: after };
    }

    /** Wait for the cue's end: coarse, then (with the next position ready) fine, then #boundary. */
    #arm(): void {
      clearTimeout(this.#watch);
      const p = this.#on;
      // _play runs while Foundry still says STARTING; it flips to PLAYING right after.
      if (!p || !this.cue || (this._state !== STATES.PLAYING && this._state !== STATES.STARTING)) return;
      const left = (cueEnd(this.cue, this.fileDuration) - p.el.currentTime) / (p.el.playbackRate || 1);
      // Load the next position a few seconds ahead: a streamed file may have to fetch it from the server.
      if (left < PREPARE_S) {
        const plan = this.#plan();
        if (plan?.kind === "jump" && this.#ready?.fileAt !== plan.fileAt) {
          const q = this.#idle();
          q.el.pause();
          q.el.currentTime = plan.fileAt;
          this.#ready = { p: q, fileAt: plan.fileAt };
        }
      }
      if (left <= 0.02) return void this.#boundary();
      this.#watch = setTimeout(() => this.#arm(), left > PREPARE_S + 0.3 ? (left - PREPARE_S) * 1000 : Math.min(5, left * 500));
    }

    #boundary(): void {
      if (this.#busy) return;
      const plan = this.#plan();
      const cue = this.cue!;
      if (!plan) return;
      if (plan.kind === "stop") return void this.#ended();
      if (plan.kind === "hold") {
        const p = this.#on!;
        this.#ramp(p, 0, 0.015);
        setTimeout(() => p.el.pause(), 30);
        this.onHold?.(cueEnd(cue, this.fileDuration));
        return;
      }
      this.#target = null;
      const { kind, next, changed, fileAt, xfade } = plan as Step;
      const done = () => {
        this.#plays = next === cue ? this.#plays + 1 : 0;
        this.cue = next;
        if (changed) this.onCueChange?.(next);
      };
      if (kind === "run") { done(); return void this.#arm(); }
      void this.#crossTo(fileAt, xfade, "ring", done);
    }

    /**
     * Bring the idle element in at `fileAt` and take the one you hear out. "ring": the new one comes straight in
     * (its downbeat lands) while the old rings on past the cue's end and fades over `x`. "equal": an equal-power
     * crossfade over `x` (a switch made now).
     */
    async #crossTo(fileAt: number, x: number, shape: "ring" | "equal", then: () => void): Promise<void> {
      const old = this.#on;
      if (!old) return;
      this.#busy = true;
      clearTimeout(this.#watch);
      const q = this.#ready?.fileAt === fileAt ? this.#ready.p : this.#idle();
      this.#ready = null;
      if (Math.abs(q.el.currentTime - fileAt) > 0.05) q.el.currentTime = fileAt;
      q.gain.gain.cancelScheduledValues(this.context.currentTime);
      q.gain.gain.value = 0;
      // The one you hear keeps going at full level (ringing on past the cue's end) until the new one is really
      // producing sound: a streamed element can take a moment after a seek, and fading out before it's there
      // leaves a gap.
      await q.el.play().catch(() => {});
      await audible(q.el, fileAt);
      if (this._state !== STATES.PLAYING || this.#on !== old) { q.el.pause(); this.#busy = false; return; }
      const xs = Math.max(MICRO_XFADE_S, x);
      this.#ramp(q, 1, shape === "ring" ? Math.min(HEAD_IN_S, xs) : xs, "up");
      this.#ramp(old, 0, xs, "down");
      setTimeout(() => { if (this.#on !== old) old.el.pause(); }, xs * 1000 + 60);
      this.#on = q;
      then();
      this.#busy = false;
      this.#arm();
    }

    #ramp(p: Player, to: number, seconds: number, shape?: "up" | "down"): void {
      const g = p.gain.gain;
      const now = this.context.currentTime;
      const from = g.value;
      g.cancelScheduledValues(now);
      if (shape) {
        const c = curves()[shape];
        g.setValueCurveAtTime(Float32Array.from(c, v => (shape === "up" ? v * to : v * from)), now, seconds);
      } else {
        g.setValueAtTime(from, now);
        g.linearRampToValueAtTime(to, now + seconds);
      }
    }

    #streamPause(): void {
      clearTimeout(this.#watch);
      this.#watch = undefined;
      this.#target = null;
      this.#ready = null;
      this.#busy = false;
      for (const p of this.#players) p.el.pause();
    }
  };
  return CueSoundClass;
}

/** Streamed mode: how far ahead of a cue's end the next position starts loading. */
const PREPARE_S = 3;

/** Resolves once `el` is playing and its time has moved past `from` (or after 3 s, whatever happens). */
function audible(el: HTMLAudioElement, from: number): Promise<void> {
  return new Promise(resolve => {
    const end = performance.now() + 3000;
    const check = () => {
      if ((!el.paused && !el.seeking && el.readyState >= 3 && el.currentTime > from + 0.01) || performance.now() > end) resolve();
      else setTimeout(check, 5);
    };
    check();
  });
}

let curveCache: { up: Float32Array; down: Float32Array } | null = null;
/** Equal-power fade curves (the T0 spike's choice). */
function curves() {
  if (!curveCache) {
    const n = 64, up = new Float32Array(n), down = new Float32Array(n);
    for (let k = 0; k < n; k++) { const x = (k / (n - 1)) * (Math.PI / 2); up[k] = Math.sin(x); down[k] = Math.cos(x); }
    curveCache = { up, down };
  }
  return curveCache;
}
