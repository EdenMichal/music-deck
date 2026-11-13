import { describe, expect, it } from "vitest";
import type { DeckState } from "../../shared/protocol";
import type { DeckCue } from "../../shared/protocol";
import {
  COLOR, ambientFeedback, comboKeyFace, comboSceneIds, balance, nextAmbientTarget, nextSceneOn, sceneMixFeedback, sceneMixTarget, cueKeyFace, cueKeyImage, fadeTarget, findKeyCue, keyLines, musicFeedback, nextPhaseFace, sfxFeedback, trackItems, trackKeyFace,
} from "../src/feedback";

const state = (over: Partial<DeckState> = {}): DeckState => ({
  fader: 0, musicVol: 0.8, muted: false, ambientVol: 0.6, ambientMuted: false, sfxVol: 1, sfxMuted: false, panic: false, sceneVols: {}, battle: 0, battleVol: 0.8, battleDeck: null, fading: false,
  decks: [{ id: "A", track: "Tavern", path: "music/tavern.ogg", playing: true, cue: null }, { id: "B", track: "Ambush", path: "music/ambush.ogg", playing: false, cue: null }],
  ambient: { on: true, names: "Rain · Fire", layers: [] },
  sfx: [],
  scenes: [],
  scenesOn: [],
  ...over,
});
const online = (over?: Partial<DeckState>) => ({ status: "online" as const, code: null, state: state(over) });

describe("musicFeedback", () => {
  it("during combat shows the Battle deck and its level, in either mode", () => {
    const battleDeck = { track: "Clash", path: "music/clash.ogg", playing: true, cue: null };
    for (const mode of ["fade", "volume"] as const) {
      const f = musicFeedback(online({ battleDeck, battleVol: 0.65 }), mode);
      expect(f.title.value).toBe("BATTLE");
      expect(f.value.value).toBe("65%");
      expect(f.line1.value).toBe("⚔ ▶ Clash");
      expect(f.bar.value).toBe(65);
    }
    expect(musicFeedback(online({ battleDeck, muted: true }), "fade").value.value).toBe("MUTED");
  });

  it("crossfade mode shows both decks, the heard one bright", () => {
    const f = musicFeedback(online(), "fade");
    expect(f.title.value).toBe("CROSSFADE");
    expect(f.line1).toMatchObject({ value: "A ▶ Tavern", color: COLOR.text });
    expect(f.line2).toMatchObject({ value: "B Ambush", color: COLOR.muted });
    expect(f.value.value).toBe("A");
    expect(f.bar.value).toBe(0);
  });

  it("volume mode shows the music level in its own colour", () => {
    const f = musicFeedback(online({ musicVol: 0.42 }), "volume");
    expect(f.title).toMatchObject({ value: "MUSIC VOLUME", color: COLOR.accent });
    expect(f.value.value).toBe("42%");
    expect(f.bar).toMatchObject({ value: 42, bar_fill_c: COLOR.accent });
  });

  it("mute and panic win the top row", () => {
    expect(musicFeedback(online({ muted: true }), "fade").value.value).toBe("MUTED");
    expect(musicFeedback(online({ panic: true }), "fade").title.value).toBe("PANIC");
  });

  it("shows the pairing code while a browser waits", () => {
    const f = musicFeedback({ status: "pairing", code: "0482", state: null }, "fade");
    expect(f.line2.value).toBe("0 4 8 2");
  });

  it("says what to do while Foundry is away", () => {
    expect(musicFeedback({ status: "offline", code: null, state: null }, "fade").line1.value).toBe("Foundry not connected");
  });
});

describe("ambientFeedback", () => {
  it("names the layers that are on", () => {
    const f = ambientFeedback(online());
    expect(f.line1.value).toBe("Rain · Fire");
    expect(f.value.value).toBe("60%");
  });

  it("invites a tap when the layers are off", () => {
    expect(ambientFeedback(online({ ambient: { on: false, names: "", layers: [] } })).line1.value).toBe("Off · tap to play");
  });

  describe("scene levels on the Ambient Dial", () => {
    const stacked = () => online({
      scenes: [{ id: "forest", name: "Forest Day" }, { id: "storm", name: "Thunderstorm" }],
      scenesOn: ["forest", "storm"], sceneVols: { storm: 0.4 },
    });

    it("presses from Ambient through each scene playing and back", () => {
      expect(nextAmbientTarget(["forest", "storm"], null)).toBe("forest");
      expect(nextAmbientTarget(["forest", "storm"], "forest")).toBe("storm");
      expect(nextAmbientTarget(["forest", "storm"], "storm")).toBeNull();
      expect(nextAmbientTarget([], null)).toBeNull();
    });

    it("goes back to Ambient from a scene that stopped", () => {
      expect(nextAmbientTarget(["storm"], "forest")).toBe("storm");
    });

    it("shows the scene's name and level, and where it is in the stack", () => {
      const f = ambientFeedback(stacked(), "storm");
      expect(f.title.value).toBe("SCENE");
      expect(f.line1.value).toBe("Thunderstorm");
      expect(f.value.value).toBe("40%");
      expect(f.line2.value).toBe("2 of 2 · press: next");
    });

    it("hints at the press on the Ambient level while scenes play", () => {
      expect(ambientFeedback(stacked()).line2.value).toBe("Press: scene levels");
      expect(ambientFeedback(online()).line2.value).toBe("");
    });
  });
});

describe("helpers", () => {
  it("balance", () => {
    expect([balance(0), balance(0.3), balance(1)]).toEqual(["A", "70|30", "B"]);
  });
  it("fadeTarget is the deck you're not hearing", () => {
    expect(fadeTarget(state({ fader: 0 }))).toBe("B");
    expect(fadeTarget(state({ fader: 1 }))).toBe("A");
  });
});

describe("sfxFeedback", () => {
  it("shows the level and what's playing", () => {
    const f = sfxFeedback(online({ sfxVol: 0.8, sfx: [{ id: "1", name: "Bell", playing: true }, { id: "2", name: "Door", playing: false }] }));
    expect(f.value.value).toBe("80%");
    expect(f.line1.value).toBe("Bell");
  });
  it("shows MUTED, and a hint when nothing plays", () => {
    const f = sfxFeedback(online({ sfxMuted: true }));
    expect(f.value.value).toBe("MUTED");
    expect(f.line1.value).toBe("Tap: stop SFX");
  });
});

describe("cue keys", () => {
  const boss = (over: Partial<DeckCue> = {}): DeckCue => ({
    cues: [
      { id: "i", name: "Intro", mode: "once", pad: 1, role: "intro" },
      { id: "p1", name: "Phase 1", mode: "loop", pad: 2, role: "battle" },
      { id: "p2", name: "Phase 2", mode: "loop", pad: 3, role: "battle" },
      { id: "v", name: "Victory", mode: "once", pad: 4, role: "victory" },
    ],
    current: "p1",
    pending: null,
    ...over,
  });
  const withCue = (cue: DeckCue | null, fader = 0) =>
    online({ fader, decks: [{ id: "A", track: "Boss · Phase 1", path: "music/boss.ogg", playing: true, cue }, { id: "B", track: "Tavern", path: "music/tavern.ogg", playing: false, cue: null }] });

  it("finds a cue by pad number, then position, or by name in any case", () => {
    expect(findKeyCue(boss(), "3")?.id).toBe("p2");
    expect(findKeyCue(boss(), "phase 2")?.id).toBe("p2");
    expect(findKeyCue(boss({ cues: boss().cues.map(({ pad, ...c }) => c) }), "2")?.id).toBe("p1");
    expect(findKeyCue(boss(), "Phase 9")).toBeUndefined();
  });

  it("shows the cue's name, lit while it plays, blinking while it waits", () => {
    expect(cueKeyFace(withCue(boss()), { cue: "Phase 1" })).toEqual({ title: "Phase 1", lit: true, blink: false });
    expect(cueKeyFace(withCue(boss()), { cue: "3" })).toEqual({ title: "Phase 2", lit: false, blink: false });
    const waiting = withCue(boss({ pending: { id: "p2", when: "loopEnd" } }));
    expect(cueKeyFace(waiting, { cue: "3" })).toMatchObject({ blink: true });
    expect(cueKeyFace(waiting, { cue: "2" })).toMatchObject({ lit: false, blink: false });
  });

  it("is drawn in its cue's colour, lit with a stronger wash of it", () => {
    const coloured = boss({ cues: boss().cues.map((c, i) => ({ ...c, color: ["#4cc3cf", "#e57ab7", "#b5d16a", "#8e9bf0"][i] })) });
    expect(cueKeyFace(withCue(coloured), { cue: "Phase 2" }).color).toBe("#b5d16a");
    expect(cueKeyFace(withCue(coloured), { mode: "next" }).color).toBe("#b5d16a");
    expect(cueKeyFace(withCue(boss()), { cue: "Phase 2" }).color).toBeUndefined();
    const lit = decodeURIComponent(cueKeyImage("#b5d16a", true)), off = decodeURIComponent(cueKeyImage("#b5d16a", false));
    expect(lit).toContain('fill="#b5d16a" fill-opacity=".6"');
    expect(off).toContain('fill="#b5d16a" fill-opacity=".22"');
    expect(decodeURIComponent(cueKeyImage('"><script>', false))).not.toContain("<script>");
  });

  it("follows the deck you're hearing unless the key names one", () => {
    expect(cueKeyFace(withCue(boss(), 1), { cue: "3" }).title).toBe("Cue 3\n—");
    expect(cueKeyFace(withCue(boss(), 1), { cue: "3", deck: "A" }).title).toBe("Phase 2");
  });

  it("says what it would do offline, unset or on a track without that cue", () => {
    expect(cueKeyFace({ status: "offline", code: null, state: null }, { cue: "Phase 2" }).title).toBe("Phase 2");
    expect(cueKeyFace(withCue(boss()), {}).title).toBe("Pick\ncue");
    expect(cueKeyFace(withCue(null), { cue: "Phase 2" }).title).toBe("Phase 2\n—");
  });

  it("next and previous name the cue they'd go to", () => {
    expect(cueKeyFace(withCue(boss()), { mode: "next" }).title).toBe("Next:\nPhase 2");
    expect(cueKeyFace(withCue(boss()), { mode: "prev" }).title).toBe("Prev:\nIntro");
    expect(cueKeyFace(withCue(boss({ current: "v" })), { mode: "next" }).title).toBe("Next\ncue");
  });

  it("Next phase skips to the next battle cue, or the next loop on a track without roles", () => {
    expect(nextPhaseFace(withCue(boss())).title).toBe("Next:\nPhase 2");
    expect(nextPhaseFace(withCue(boss({ current: "p2" }))).title).toBe("Next\nphase");
    const plain = boss({ cues: boss().cues.map(({ role, ...c }) => c), current: "i" });
    expect(nextPhaseFace(withCue(plain)).title).toBe("Next:\nPhase 1");
  });

  it("during combat, keys without a deck follow the Battle deck", () => {
    const view = { status: "online" as const, code: null, state: state({ battleDeck: { track: "Boss", path: "music/boss.ogg", playing: true, cue: boss() } }) };
    expect(nextPhaseFace(view).title).toBe("Next:\nPhase 2");
    expect(cueKeyFace(view, { cue: "3", deck: "A" }).title).toBe("Cue 3\n—");
  });

  it("wraps long names onto two lines", () => {
    expect(keyLines("Phase 2")).toBe("Phase 2");
    expect(keyLines("Final Battle")).toBe("Final\nBattle");
    expect(keyLines("Dragonfire Ascendant")).toBe("Dragonfi…\nAscendant");
    expect(keyLines("Thunderstorms")).toBe("Thunderst\norms");
  });

  it("the music strip shows a waiting switch", () => {
    const f = musicFeedback(withCue(boss({ pending: { id: "p2", when: "loopEnd" } })), "fade");
    expect(f.line1.value).toBe("A ▶ Boss · Phase 1 → Phase 2");
  });
});

describe("Scene Mix dial", () => {
  const online = (over: Partial<DeckState> = {}) => ({ status: "online" as const, code: null, state: state({
    scenes: [{ id: "forest", name: "Forest Day" }, { id: "storm", name: "Thunderstorm" }, { id: "town", name: "Town" }],
    scenesOn: ["forest", "storm"], sceneVols: { storm: 0.4 }, ...over,
  }) });

  it("stays on the scene you stepped to while it plays, else takes the first one playing", () => {
    expect(sceneMixTarget(["forest", "storm"], "storm")).toBe("storm");
    expect(sceneMixTarget(["forest", "storm"], "town")).toBe("forest");
    expect(sceneMixTarget([], "storm")).toBeNull();
  });

  it("steps round the scenes that are playing", () => {
    expect(nextSceneOn(["forest", "storm"], "forest")).toBe("storm");
    expect(nextSceneOn(["forest", "storm"], "storm")).toBe("forest");
    expect(nextSceneOn(["forest"], null)).toBe("forest");
    expect(nextSceneOn([], "forest")).toBeNull();
  });

  it("shows the scene, its level and where it is among the stack", () => {
    const f = sceneMixFeedback(online(), "storm");
    expect(f.line1.value).toBe("Thunderstorm");
    expect(f.value.value).toBe("40%");
    expect(f.line2.value).toBe("2 of 2 · press: next");
    expect(sceneMixFeedback(online(), "forest").value.value).toBe("100%");
  });

  it("says when no scene is playing", () => {
    expect(sceneMixFeedback(online({ scenesOn: [] }), null).line1.value).toBe("No scene playing");
  });
});

describe("Scene Combo key", () => {
  const scenes = [{ id: "camp", name: "Night Camp" }, { id: "storm", name: "Thunderstorm" }, { id: "town", name: "Town" }];
  const offline = { status: "offline" as const, code: null, state: null };

  it("sends the chosen scenes that still exist, each once; with none left there's nothing to send", () => {
    const s = state({ scenes });
    expect(comboSceneIds(s, { sceneIds: ["storm", "gone", "camp", "storm"] })).toEqual(["storm", "camp"]);
    expect(comboSceneIds(s, { sceneIds: ["gone"] })).toEqual([]);
    expect(comboSceneIds(s, {})).toEqual([]);
    // Without Foundry's state there's nothing to check against.
    expect(comboSceneIds(null, { sceneIds: ["gone", "camp"] })).toEqual(["gone", "camp"]);
  });

  it("lights while every one of its scenes plays, even with another scene on too", () => {
    const settings = { sceneIds: ["camp", "storm"] };
    expect(comboKeyFace(online({ scenes, scenesOn: ["camp", "storm"] }), settings).lit).toBe(true);
    expect(comboKeyFace(online({ scenes, scenesOn: ["camp", "storm", "town"] }), settings).lit).toBe(true);
    expect(comboKeyFace(online({ scenes, scenesOn: ["camp"] }), settings).lit).toBe(false);
    expect(comboKeyFace(online({ scenes, scenesOn: [] }), settings).lit).toBe(false);
  });

  it("ignores a deleted scene when lighting", () => {
    expect(comboKeyFace(online({ scenes, scenesOn: ["town"] }), { sceneIds: ["town", "gone"] }).lit).toBe(true);
  });

  it("shows the scenes' names, or your own title", () => {
    expect(comboKeyFace(online({ scenes }), { sceneIds: ["camp", "town"] }).title).toBe("Night Ca…\n+ Town");
    expect(comboKeyFace(online({ scenes }), { sceneIds: ["town", "camp", "storm"] }).title).toBe("Town\n+ 2 more");
    expect(comboKeyFace(online({ scenes }), { sceneIds: ["town"] }).title).toBe("Town");
    expect(comboKeyFace(online({ scenes }), { sceneIds: ["camp", "town"], title: "Storm Night" }).title).toBe("Storm\nNight");
  });

  it("asks for scenes when none are picked, and shows a dash when they're all gone", () => {
    expect(comboKeyFace(online({ scenes }), {}).title).toBe("Pick\nscenes");
    expect(comboKeyFace(online({ scenes }), { sceneIds: ["gone"] })).toEqual({ title: "Combo\n—", lit: false, blink: false });
  });

  it("keeps the names it last saw while Foundry is offline, unlit", () => {
    const face = comboKeyFace(offline, { sceneIds: ["camp", "town"], names: { camp: "Camp", town: "Town" } });
    expect(face).toEqual({ title: "Camp\n+ Town", lit: false, blink: false });
  });
});

describe("Set Track key (protocol 8)", () => {
  const library = [
    { path: "music/tavern.ogg", name: "Tavern", where: "Inn" },
    { path: "music/ambush.ogg", name: "Ambush in the Woods", where: "Battle" },
    { path: "music/storm.ogg", name: "Storm", where: "Battle" },
  ];

  it("asks for a track until one is picked", () => {
    expect(trackKeyFace(online(), {}, library)).toEqual({ title: "Pick a\ntrack", lit: false, blink: false });
  });

  it("shows the track's name and lights while it plays on either deck", () => {
    expect(trackKeyFace(online(), { path: "music/tavern.ogg" }, library)).toEqual({ title: "Tavern", lit: true, blink: false });
    expect(trackKeyFace(online(), { path: "music/ambush.ogg" }, library)).toEqual({ title: "Ambush in\nthe Woods", lit: false, blink: false });
  });

  it("lights during a battle while its track plays on the Battle deck (protocol 11), not for A/B paused under it", () => {
    const paused = [{ id: "A" as const, track: "Tavern", path: "music/tavern.ogg", playing: false, cue: null }, { id: "B" as const, track: "Ambush", path: "music/ambush.ogg", playing: false, cue: null }];
    const battle = online({ battle: 1, decks: paused, battleDeck: { track: "Storm", path: "music/storm.ogg", playing: true, cue: null } });
    expect(trackKeyFace(battle, { path: "music/storm.ogg" }, library).lit).toBe(true);
    expect(trackKeyFace(battle, { path: "music/tavern.ogg" }, library).lit).toBe(false);
    // The Battle deck paused (its ⏸): nothing plays, so nothing lights.
    const stopped = online({ battle: 1, decks: paused, battleDeck: { track: "Storm", path: "music/storm.ogg", playing: false, cue: null } });
    expect(trackKeyFace(stopped, { path: "music/storm.ogg" }, library).lit).toBe(false);
  });

  it("uses the saved name while Foundry is away, or the file's name", () => {
    const offline = { status: "offline" as const, code: null, state: null };
    expect(trackKeyFace(offline, { path: "music/tavern.ogg", name: "Old Inn" }, null)).toMatchObject({ title: "Old Inn", lit: false });
    expect(trackKeyFace(offline, { path: "music/Sea%20Shanty_2.ogg" }, null).title).toBe("Sea\nShanty 2");
  });

  it("groups the picker by playlist or folder, in Foundry's order", () => {
    expect(trackItems(library)).toEqual([
      { label: "Inn", children: [{ label: "Tavern", value: "music/tavern.ogg" }] },
      { label: "Battle", children: [{ label: "Ambush in the Woods", value: "music/ambush.ogg" }, { label: "Storm", value: "music/storm.ogg" }] },
    ]);
  });
});
