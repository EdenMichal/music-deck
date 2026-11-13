import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CLOSE, DECK_PROTOCOL, type DeckState } from "../../shared/protocol";
import { FoundryLink } from "../src/link";

let port = 31500 + Math.floor(Math.random() * 400);
const links: FoundryLink[] = [];
const sockets: WebSocket[] = [];
let lastCode = "";
const logs: string[] = [];

afterEach(() => {
  sockets.splice(0).forEach(s => s.terminate());
  links.splice(0).forEach(l => l.close());
});

async function makeLink(tokens: string[] = [], samePort = false) {
  const saved: string[][] = [];
  if (!samePort) port++;
  const link = new FoundryLink({ load: async () => tokens, save: async t => void saved.push(t) }, port, msg => {
    logs.push(msg);
    const m = /pairing code (\d{4})/.exec(msg);
    if (m) lastCode = m[1];
  }, 100);
  links.push(link);
  await link.start();
  await new Promise(r => setTimeout(r, 20));
  return { link, saved };
}

/** A fake Foundry window: collects every message from the plugin. */
async function foundry(token?: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const got: any[] = [];
  let closed: number | undefined;
  ws.on("message", d => got.push(JSON.parse(String(d))));
  ws.on("close", code => { closed = code; });
  await new Promise(r => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", protocol: DECK_PROTOCOL, token, world: "Test", user: "GM" }));
  await tick();
  return { ws, got, closed: () => closed, send: (m: object) => ws.send(JSON.stringify(m)) };
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

const state: DeckState = {
  fader: 0.5, musicVol: 0.8, muted: false, ambientVol: 0.6, ambientMuted: false, sfxVol: 1, sfxMuted: false, panic: false, sceneVols: {}, battle: 0, battleVol: 0.8, battleDeck: null, fading: false,
  decks: [], ambient: { on: false, names: "", layers: [] }, sfx: [], scenes: [], scenesOn: [],
};

describe("FoundryLink", () => {
  it("pairs with the code on the dials, then knows the token", async () => {
    const { link, saved } = await makeLink();
    const f = await foundry();
    expect(f.got).toEqual([{ type: "needPairing" }]);
    expect(link.status).toBe("pairing");
    expect(link.code).toBe(lastCode);

    f.send({ type: "pair", code: lastCode });
    await tick();
    const token = f.got[1].token;
    expect(f.got[1].type).toBe("paired");
    expect(saved.at(-1)).toEqual([token]);
    expect(link.status).toBe("online");
    expect(link.code).toBeNull();

    const again = await foundry(token);
    expect(again.got).toEqual([{ type: "welcome" }]);
  });

  it("a wrong code fails, and five wrong codes change it", async () => {
    const { link } = await makeLink();
    const f = await foundry();
    const first = link.code!;
    const wrong = first === "0000" ? "0001" : "0000";
    for (let i = 0; i < 5; i++) f.send({ type: "pair", code: wrong });
    await tick();
    expect(f.got.filter(m => m.type === "pairFailed")).toHaveLength(5);
    expect(link.code).not.toBe(first);
    expect(link.status).toBe("pairing");
  });

  it("refuses a different protocol version", async () => {
    await makeLink();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    const code = await new Promise<number>(r => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocol: 99, world: "x", user: "y" })));
      ws.on("close", c => r(c));
    });
    expect(code).toBe(CLOSE.protocolMismatch);
  });

  it("the newest window wins", async () => {
    const { link } = await makeLink(["t"]);
    const old = await foundry("t");
    const fresh = await foundry("t");
    await tick();
    expect(old.closed()).toBe(CLOSE.replaced);
    expect(fresh.got).toEqual([{ type: "welcome" }]);
    expect(link.status).toBe("online");
  });

  it("coalesces fast turns and shows them before Foundry answers", async () => {
    const { link } = await makeLink(["t"]);
    const f = await foundry("t");
    f.send({ type: "state", state });
    await tick();
    for (let i = 0; i < 5; i++) link.nudge("fader.nudge", 0.03);
    expect(link.state!.fader).toBeCloseTo(0.65);
    await tick(80);
    const nudges = f.got.filter(m => m.type === "fader.nudge");
    expect(nudges.length).toBe(2);
    expect(nudges.reduce((s, m) => s + m.delta, 0)).toBeCloseTo(0.15);

    // Foundry's echo of an older position doesn't pull the strip back while the dial is moving.
    f.send({ type: "state", state: { ...state, fader: 0.53 } });
    await tick();
    expect(link.state!.fader).toBeCloseTo(0.65);
    await tick(450);
    f.send({ type: "state", state: { ...state, fader: 0.65 } });
    await tick();
    expect(link.state!.fader).toBeCloseTo(0.65);
  });

  it("keeps the track list Foundry sends for the Set Track keys", async () => {
    const { link } = await makeLink(["t"]);
    const f = await foundry("t");
    expect(link.library).toBeNull();
    const tracks = [{ path: "music/a.ogg", name: "A", where: "music" }];
    f.send({ type: "library", tracks });
    await tick();
    expect(link.library).toEqual(tracks);
    expect(f.closed()).toBeUndefined();
  });

  it("accepts a large track list", async () => {
    const { link } = await makeLink(["t"]);
    const f = await foundry("t");
    const tracks = Array.from({ length: 5000 }, (_, i) => ({ path: `music/some/long/folder/name/track-${i}.ogg`, name: `Track number ${i}`, where: "music/some/long/folder/name" }));
    f.send({ type: "library", tracks });
    await tick(100);
    expect(link.library).toHaveLength(5000);
    expect(f.closed()).toBeUndefined();
  });

  it("refuses gestures while Foundry is away", async () => {
    const { link } = await makeLink();
    expect(link.send({ type: "panic" })).toBe(false);
    expect(link.nudge("fader.nudge", 0.1)).toBe(false);
  });

  it("waits for a busy port instead of crashing, then takes it", async () => {
    const { link: first } = await makeLink(["t"]);
    const { link: second } = await makeLink(["t"], true);
    expect(logs.some(l => l.includes("EADDRINUSE"))).toBe(true);
    first.close();
    await tick(250);
    const f = await foundry("t");
    expect(f.got).toEqual([{ type: "welcome" }]);
    expect(second.status).toBe("online");
  });

  it("goes offline when the window closes", async () => {
    const { link } = await makeLink(["t"]);
    const f = await foundry("t");
    f.ws.close();
    await tick();
    expect(link.status).toBe("offline");
  });
});
