import { describe, expect, it } from "vitest";
import { folderOf, foldersIn, searchTracks, toTrack } from "../src/library";
import { trackName } from "../src/channels";

const tracks = [
  "music/Tavern/Hearth%20and%20Ale.mp3",
  "music/Tavern/quiet_inn.ogg",
  "music/Combat/Steel-and-Fury.mp3",
  "music/Combat/Bosses/Dragon%20Lair.mp3",
  "music/loose-track.mp3",
].map(p => toTrack(p, "music"));

describe("trackName", () => {
  it("turns a file path into a readable name", () => {
    expect(trackName("music/Tavern/Hearth%20and%20Ale.mp3")).toBe("Hearth and Ale");
    expect(trackName("music/x/quiet_inn-night.ogg")).toBe("quiet inn night");
  });
});

describe("folderOf", () => {
  it("is the first folder under the library root", () => {
    expect(folderOf("music/Combat/Bosses/Dragon%20Lair.mp3", "music")).toBe("Combat");
    expect(folderOf("music/loose-track.mp3", "music")).toBe("");
  });
});

describe("foldersIn", () => {
  it("lists top-level folders once, sorted", () => {
    expect(foldersIn(tracks)).toEqual(["Combat", "Tavern"]);
  });
});

describe("searchTracks", () => {
  it("returns everything for an empty query", () => {
    expect(searchTracks(tracks, "")).toHaveLength(5);
  });

  it("matches every word, in any order, ignoring case", () => {
    expect(searchTracks(tracks, "ale hearth").map(t => t.name)).toEqual(["Hearth and Ale"]);
  });

  it("matches folder names", () => {
    expect(searchTracks(tracks, "bosses").map(t => t.name)).toEqual(["Dragon Lair"]);
  });

  it("filters by top-level folder", () => {
    expect(searchTracks(tracks, "", "Combat").map(t => t.name)).toEqual(["Dragon Lair", "Steel and Fury"]);
  });

  it("sorts by name", () => {
    expect(searchTracks(tracks, "", "Tavern").map(t => t.name)).toEqual(["Hearth and Ale", "quiet inn"]);
  });
});
