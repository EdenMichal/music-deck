/**
 * Message schemas shared by the Foundry module and the Stream Deck plugin.
 * - The module socket message: the active GM's live mix, applied by every client.
 * - The deck link: the GM's Foundry window dials out to the plugin's WebSocket server on 127.0.0.1.
 */
import * as z from "zod/mini";

const unit = () => z.number().check(z.gte(0), z.lte(1));

export const MixStateSchema = z.object({
  fader: unit(),
  musicVol: unit(),
  muted: z.boolean(),
  ambientVol: unit(),
  ambientMuted: z.boolean(),
  sfxVol: unit(),
  sfxMuted: z.boolean(),
  panic: z.boolean(),
  /** Each sound scene's level by scene id (v2.34); a scene not listed is at full. */
  sceneVols: z.record(z.string(), unit()),
  /** The Battle deck (v2.39): the blend from A/B to it (0..1), and its own level. */
  battle: unit(),
  battleVol: unit(),
});

/** What a client says about its own sound, for the GM's "who can hear" line. */
export const HearingSchema = z.object({
  /** The browser hasn't had the click it needs before it may play sound. */
  locked: z.boolean(),
});

/** Messages on `module.music-deck`. A sender never receives its own emit. */
export const SocketMessageSchema = z.discriminatedUnion("type", [
  /** The active GM's live mix. `ramp` is the smoothing time constant in seconds: short for dial turns, longer for mute and panic. */
  z.object({ type: z.literal("mix"), mix: MixStateSchema, ramp: z.number().check(z.gte(0), z.lte(5)) }),
  /** Every client, whenever its sound state changes or a GM asks. */
  z.object({ type: z.literal("hearing"), userId: z.string(), hearing: HearingSchema }),
  /** A GM who just loaded asks everyone to report. */
  z.object({ type: z.literal("hearingQuery") }),
]);

export type Hearing = z.infer<typeof HearingSchema>;

export type SocketMessage = z.infer<typeof SocketMessageSchema>;

// ── Deck link ────────────────────────────────────────────────────────────────

export const DECK_PORT = 31420;
/** Bump when either side's messages change shape; the plugin refuses a mismatched module. */
export const DECK_PROTOCOL = 11;

/** WebSocket close codes the plugin uses. */
export const CLOSE = {
  helloTimeout: 4001,
  badMessage: 4002,
  protocolMismatch: 4003,
  replaced: 4004,
} as const;

const DeckIdSchema = z.enum(["A", "B"]);
const delta = () => z.number().check(z.gte(-1), z.lte(1));

const CueWhenSchema = z.enum(["now", "loopEnd"]);

/** A deck's track's cues: the list in start order, the one you hear, and a switch waiting for the end of the loop. */
export const DeckCueSchema = z.object({
  cues: z.array(z.object({ id: z.string(), name: z.string(), mode: z.enum(["loop", "once"]), pad: z.optional(z.number()), role: z.optional(z.string()), color: z.optional(z.string()) })),
  /** Id of the cue playing now (or that the track will start on, when stopped). */
  current: z.nullable(z.string()),
  pending: z.nullable(z.object({ id: z.string(), when: CueWhenSchema })),
});

export type DeckCue = z.infer<typeof DeckCueSchema>;

/** Everything the deck shows. Sent by Foundry on connect and whenever any of it changes. */
export const DeckStateSchema = z.object({
  ...MixStateSchema.shape,
  fading: z.boolean(),
  /**
   * `cue` (protocol 5): the track's cues, if its file has any (track editor). `path` (protocol 8): the
   * track's file, so a Set Track key knows when its track plays.
   */
  decks: z.array(z.object({ id: DeckIdSchema, track: z.nullable(z.string()), path: z.nullable(z.string()), playing: z.boolean(), cue: z.nullable(DeckCueSchema) })),
  /** `layers`: every ambient layer, for the Ambient Layer keys (protocol 3), with the scene that owns it, if any. */
  ambient: z.object({ on: z.boolean(), names: z.string(), layers: z.array(z.object({ id: z.string(), name: z.string(), on: z.boolean(), scene: z.optional(z.string()) })) }),
  /** `playing`: for the SFX Dial's strip (protocol 4). */
  sfx: z.array(z.object({ id: z.string(), name: z.string(), playing: z.boolean() })),
  /** Sound scenes (Phase 4, protocol 2), and (protocol 6) every scene with a layer playing: several when stacked. */
  scenes: z.array(z.object({ id: z.string(), name: z.string() })),
  scenesOn: z.array(z.string()),
  /**
   * The Battle deck while combat runs (protocol 9), else null: the Music dial and Next Track work on it then.
   * `path` (protocol 11): its track's file, so a Set Track key lights while its track plays there.
   */
  battleDeck: z.nullable(z.object({ track: z.nullable(z.string()), path: z.nullable(z.string()), playing: z.boolean(), cue: z.nullable(DeckCueSchema) })),
});

export type DeckState = z.infer<typeof DeckStateSchema>;

/** A track a Set Track key can pick (protocol 8): its file, its name, and the playlist or folder it's in. */
export const LibraryTrackSchema = z.object({ path: z.string(), name: z.string(), where: z.string() });

export type LibraryTrack = z.infer<typeof LibraryTrackSchema>;

/** Foundry → plugin. */
export const FoundryMessageSchema = z.discriminatedUnion("type", [
  /** First message. `token` is what an earlier pairing handed this browser. */
  z.object({ type: z.literal("hello"), protocol: z.number(), token: z.optional(z.string()), world: z.string(), user: z.string() }),
  /** The 4-digit code the GM read off the deck. */
  z.object({ type: z.literal("pair"), code: z.string() }),
  z.object({ type: z.literal("state"), state: DeckStateSchema }),
  /**
   * The Library's tracks, for the Set Track key's picker (protocol 8). Kept out of `state` because it can be long
   * and rarely changes: sent after linking and whenever the Library changes.
   */
  z.object({ type: z.literal("library"), tracks: z.array(LibraryTrackSchema) }),
]);

export type FoundryMessage = z.infer<typeof FoundryMessageSchema>;

/** Plugin → Foundry: link handshake replies plus one message per dial or key gesture. */
export const PluginMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome") }),
  z.object({ type: z.literal("needPairing") }),
  z.object({ type: z.literal("paired"), token: z.string() }),
  z.object({ type: z.literal("pairFailed"), reason: z.string() }),

  z.object({ type: z.literal("fader.nudge"), delta: delta() }),
  z.object({ type: z.literal("music.vol.nudge"), delta: delta() }),
  /** The Battle deck's level (protocol 9): the Music dial during combat. */
  z.object({ type: z.literal("battle.vol.nudge"), delta: delta() }),
  z.object({ type: z.literal("music.mute") }),
  z.object({ type: z.literal("music.autofade") }),
  /** No deck means the deck you're hearing. */
  z.object({ type: z.literal("deck.next"), deck: z.optional(DeckIdSchema) }),
  z.object({ type: z.literal("ambient.vol.nudge"), delta: delta() }),
  z.object({ type: z.literal("ambient.mute") }),
  z.object({ type: z.literal("ambient.toggle") }),
  z.object({ type: z.literal("sfx.play"), soundId: z.string() }),
  /** The SFX Dial (protocol 4): level, mute, and a tap on its strip stops every pad that's playing. */
  z.object({ type: z.literal("sfx.vol.nudge"), delta: delta() }),
  z.object({ type: z.literal("sfx.mute") }),
  z.object({ type: z.literal("sfx.stop") }),
  z.object({ type: z.literal("panic") }),
  z.object({ type: z.literal("scene.recall"), sceneId: z.string() }),
  /** The Scene Mix dial (protocol 6): one scene's level. */
  z.object({ type: z.literal("scene.vol.nudge"), sceneId: z.string(), delta: delta() }),
  /** A held Sound Scene key (protocol 6): add its scene on top of what's playing, or fade just that scene out. */
  z.object({ type: z.literal("scene.stack"), sceneId: z.string() }),
  /**
   * A Scene Combo key (protocol 7): play these scenes together and fade out everything else, General layers too.
   * Sent while exactly these scenes are on, it fades them out. Scenes that no longer exist are skipped.
   */
  z.object({ type: z.literal("scene.combo"), sceneIds: z.array(z.string()).check(z.minLength(1), z.maxLength(64)) }),
  /** An Ambient Layer key: switch that layer on or off. */
  z.object({ type: z.literal("layer.toggle"), soundId: z.string() }),
  /**
   * Cues (protocol 5). `cue` is a pad number 1–8 or a cue name; no `when` means the default from Foundry's
   * settings. No deck means the deck you're hearing.
   */
  z.object({ type: z.literal("cue.go"), deck: z.optional(DeckIdSchema), cue: z.union([z.number(), z.string()]), when: z.optional(CueWhenSchema) }),
  z.object({ type: z.literal("cue.next"), deck: z.optional(DeckIdSchema) }),
  z.object({ type: z.literal("cue.prev"), deck: z.optional(DeckIdSchema) }),
  /** The next battle cue of the track you're hearing (combat phases). */
  z.object({ type: z.literal("combat.nextPhase") }),
  /**
   * A Set Track key (protocol 8): fade the deck that's playing to this file, adding it to that deck's queue unless
   * it's there already; during a battle, that's the Battle deck. `name` is how the key's picker named it.
   */
  z.object({ type: z.literal("track.set"), path: z.string().check(z.minLength(1)), name: z.optional(z.string()) }),
]);

export type PluginMessage = z.infer<typeof PluginMessageSchema>;
export type DeckCommand = Exclude<PluginMessage, { type: "welcome" | "needPairing" | "paired" | "pairFailed" }>;
