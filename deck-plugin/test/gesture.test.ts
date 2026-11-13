import { describe, expect, it } from "vitest";
import { PressTurn, otherMode } from "../src/gesture";

describe("PressTurn", () => {
  it("a plain press is a press", () => {
    const g = new PressTurn();
    g.down();
    expect(g.up()).toBe("press");
  });

  it("press + turn switches once, however many clicks", () => {
    const g = new PressTurn();
    g.down();
    expect([g.rotate(true), g.rotate(true), g.rotate(true)]).toEqual(["switch", "ignore", "ignore"]);
    expect(g.up()).toBe("none");
  });

  it("each new press can switch again", () => {
    const g = new PressTurn();
    g.down(); g.rotate(true); g.up();
    g.down();
    expect(g.rotate(true)).toBe("switch");
  });

  it("unpressed turns are plain turns", () => {
    const g = new PressTurn();
    expect(g.rotate(false)).toBe("turn");
    expect(g.up()).toBe("none");
  });

  it("a held turn without its dialDown still switches only once", () => {
    const g = new PressTurn();
    expect(g.rotate(true)).toBe("switch");
    expect(g.rotate(true)).toBe("ignore");
    expect(g.up()).toBe("none");
  });

  it("modes alternate", () => {
    expect(otherMode("fade")).toBe("volume");
    expect(otherMode("volume")).toBe("fade");
  });
});
