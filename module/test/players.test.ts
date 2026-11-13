import { describe, expect, it } from "vitest";
import { SocketMessageSchema } from "@music-deck/shared/protocol";
import { hearingSummary } from "../src/players";

const hears = { locked: false };
const locked = { locked: true };

describe("hearingSummary, Online play", () => {
  it("says when no players are online", () => {
    expect(hearingSummary([], "online")).toEqual({ text: "No players online", cantHear: [] });
  });

  it("says everyone can hear", () => {
    expect(hearingSummary([{ name: "Ana", hearing: hears }, { name: "Ben", hearing: hears }], "online"))
      .toEqual({ text: "2 players, all hearing", cantHear: [] });
  });

  it("names players whose browser hasn't had its first click", () => {
    expect(hearingSummary([{ name: "Ana", hearing: hears }, { name: "Ben", hearing: locked }], "online"))
      .toEqual({ text: "2 players", cantHear: ["Ben"] });
  });

  it("counts a player who hasn't reported yet as not hearing", () => {
    expect(hearingSummary([{ name: "Ana" }], "online").cantHear).toEqual(["Ana"]);
  });

  it("uses the singular for one player", () => {
    expect(hearingSummary([{ name: "Ana", hearing: hears }], "online").text).toBe("1 player, all hearing");
  });
});

describe("hearingSummary, Table play", () => {
  it("doesn't flag players who haven't clicked: they aren't meant to hear Foundry", () => {
    expect(hearingSummary([{ name: "Ana", hearing: locked }, { name: "Ben" }], "table"))
      .toEqual({ text: "2 players at the table", cantHear: [] });
  });

  it("says when no players are online", () => {
    expect(hearingSummary([], "table").text).toBe("No players online");
  });
});

describe("socket messages", () => {
  it("accepts hearing reports and queries", () => {
    expect(SocketMessageSchema.safeParse({ type: "hearing", userId: "u1", hearing: hears }).success).toBe(true);
    expect(SocketMessageSchema.safeParse({ type: "hearingQuery" }).success).toBe(true);
  });

  it("rejects a malformed report", () => {
    expect(SocketMessageSchema.safeParse({ type: "hearing", userId: "u1", hearing: { locked: "no" } }).success).toBe(false);
  });
});
