/**
 * Live gains: crossfader, music and ambient levels, mutes and panic, applied on every client with Web Audio ramps.
 *
 * Each Music Deck sound gets its own GainNode in its `effects` chain. It can't be shared:
 * Foundry calls disconnect() on every node in a sound's chain when that sound stops.
 * The active GM broadcasts the mix on the module socket; a sender never receives its own emit,
 * so the GM applies it locally too. The mix is also saved to a world setting for late joiners.
 */
import { SocketMessageSchema, type SocketMessage } from "@music-deck/shared/protocol";
import { DEFAULT_MIX, channelGains, layerOwners, sceneGain, type ChannelId, type MixState } from "./crossfader";

export const MODULE_ID = "music-deck";
export const SOCKET = `module.${MODULE_ID}`;
const SETTING = "mix";

/** Smoothing time constants, in seconds. Dial messages arrive up to every 50 ms. */
export const RAMP = { dial: 0.03, mute: 0.08, panic: 0.4 } as const;
const BROADCAST_MS = 50;
const PERSIST_MS = 500;

/** Fired on every client after the mix changes, with the new mix. */
export const MIX_HOOK = "musicDeckMix";

let mix: MixState = { ...DEFAULT_MIX };
const nodes = new WeakMap<object, GainNode>();

const isActiveGM = () => !!game.users.activeGM?.isSelf;

/** Which Music Deck channel a playlist is. Phase 0 playlists only carry the older `deck` flag. */
export function channelOf(playlist: any): ChannelId | undefined {
  return playlist?.getFlag?.(MODULE_ID, "channel") ?? playlist?.getFlag?.(MODULE_ID, "deck");
}


/** Called from our PlaylistSound subclass right after Foundry creates the Sound, before it plays. */
export function attachGain(playlistSound: any, sound: any): void {
  const channel = channelOf(playlistSound.parent);
  if (!channel) return;
  const node = new GainNode(sound.context, { gain: targetGain(channel, playlistSound) });
  sound.effects.push(node);
  nodes.set(sound, node);
  // A stopped sound's node is out of the audio graph, so Chrome doesn't advance its ramps: it would
  // pick up from its old level when it plays again (e.g. a layer starting during Panic). Start it at the mix.
  sound.addEventListener("play", () => {
    const param = node.gain;
    param.cancelScheduledValues(0);
    param.setValueAtTime(targetGain(channel, playlistSound), node.context.currentTime);
  });
}

function rampTo(node: GainNode, value: number, ramp: number): void {
  const now = node.context.currentTime;
  const param = node.gain;
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
  else param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, ramp);
}

let duck = 1;

/**
 * Levels are plain multipliers (v2.35): 70% on any slider is 0.7 of the sound's matched level. Foundry's own
 * sliders use a curve (70% plays at 0.59), which made Music Deck's numbers mean less than they said.
 */
const toVolume = (v: number) => v;
const ownersOf = (playlist: any) => layerOwners(playlist?.getFlag?.(MODULE_ID, "scenes"));

/** Each file's loudness-matching gain (match.ts sets it, to keep imports one-way). */
let matchGainOf: (path: string | undefined) => number = () => 1;
export function setMatchGain(fn: (path: string | undefined) => number): void {
  matchGainOf = fn;
}

/** Re-apply every sound's gain, e.g. when a file's loudness has been measured. */
export function refreshGains(ramp: number = RAMP.dial): void {
  applyGains(ramp);
}

/**
 * A sound's gain: its file's loudness match, times its channel's level (ducked for music), and for an ambient
 * layer times its scene's level.
 */
function targetGain(channel: ChannelId, playlistSound?: any, owners?: Map<string, string>): number {
  const gain = channelGains(mix, toVolume)[channel] * matchGainOf(playlistSound?.path);
  if (channel === "A" || channel === "B" || channel === "battle") return gain * duck;
  if (channel !== "ambient" || !playlistSound) return gain;
  const owner = (owners ?? ownersOf(playlistSound.parent)).get(playlistSound.id);
  return gain * sceneGain(mix, owner, toVolume);
}

function applyGains(ramp: number): void {
  for (const playlist of game.playlists) {
    const channel = channelOf(playlist);
    if (!channel) continue;
    const owners = channel === "ambient" ? ownersOf(playlist) : undefined;
    for (const ps of playlist.sounds) {
      const node = ps.sound && nodes.get(ps.sound);
      if (node) rampTo(node, targetGain(channel, ps, owners), ramp);
    }
  }
}

function applyMix(ramp: number): void {
  applyGains(ramp);
  Hooks.callAll(MIX_HOOK, getMix());
}

/** This client's music duck (duck.ts): 1 = none. Only the music gains change; the mix itself doesn't. */
export function setDuck(factor: number, ramp: number): void {
  if (factor === duck) return;
  duck = factor;
  applyGains(ramp);
}
export const getDuck = () => duck;

let lastSent = 0;
let sendTimer: ReturnType<typeof setTimeout> | undefined;
let pendingRamp: number = RAMP.dial;
function broadcast(ramp: number): void {
  pendingRamp = Math.max(pendingRamp, ramp);
  const send = () => {
    lastSent = Date.now();
    sendTimer = undefined;
    game.socket.emit(SOCKET, { type: "mix", mix, ramp: pendingRamp } satisfies SocketMessage);
    pendingRamp = RAMP.dial;
  };
  const wait = BROADCAST_MS - (Date.now() - lastSent);
  if (wait <= 0) send();
  else sendTimer ??= setTimeout(send, wait);
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persist(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => game.settings.set(MODULE_ID, SETTING, mix), PERSIST_MS);
}

export function getMix(): MixState {
  return { ...mix };
}

/** GM only: change the mix, hear it now, and send it to everyone. */
export function setMix(change: Partial<MixState>, { ramp = RAMP.dial }: { ramp?: number } = {}): MixState {
  if (!isActiveGM()) throw new Error("Music Deck: only the active GM can change the mix.");
  mix = { ...mix, ...change };
  applyMix(ramp);
  broadcast(ramp);
  persist();
  return getMix();
}

export function registerLiveGainSettings(): void {
  game.settings.register(MODULE_ID, SETTING, {
    scope: "world",
    config: false,
    type: Object,
    default: { ...DEFAULT_MIX },
  });
}

export function startLiveGain(): void {
  mix = { ...DEFAULT_MIX, ...game.settings.get(MODULE_ID, SETTING) };
  applyMix(RAMP.dial);
  // A layer moved to another scene (or to General) takes that scene's level.
  Hooks.on("updatePlaylist", (playlist: any, change: any) => {
    if (channelOf(playlist) === "ambient" && change?.flags?.[MODULE_ID]?.scenes !== undefined) applyGains(RAMP.dial);
  });
  game.socket.on(SOCKET, (data: unknown) => {
    const msg = SocketMessageSchema.safeParse(data);
    if (!msg.success || msg.data.type !== "mix") return;
    mix = msg.data.mix;
    applyMix(msg.data.ramp);
  });
}

/** For tests and debugging: current gain of every Music Deck node on this client. */
export function readGains(): { channel: ChannelId; track: string; gain: number }[] {
  const out = [];
  for (const playlist of game.playlists) {
    const channel = channelOf(playlist);
    if (!channel) continue;
    for (const ps of playlist.sounds) {
      const node = ps.sound && nodes.get(ps.sound);
      if (node) out.push({ channel, track: ps.name, gain: node.gain.value });
    }
  }
  return out;
}
