import { describe, expect, it } from "vitest";
import { filesTree, findNode, playlistsTree, searchUnder, trail, tracksUnder } from "../src/library-tree";

const files = [
  { path: "music/battle/drums.ogg", name: "drums" },
  { path: "music/battle/boss/final.ogg", name: "final" },
  { path: "music/tavern.ogg", name: "tavern" },
];

describe("filesTree", () => {
  const root = filesTree(files);
  it("nests folders, folders before tracks, counting every track below", () => {
    expect(root.children.map(c => c.name)).toEqual(["battle", "tavern"]);
    const battle = findNode(root, "files:battle")!;
    expect(battle.count).toBe(2);
    expect(battle.children.map(c => c.name)).toEqual(["boss", "drums"]);
  });
  it("gives a breadcrumb trail from the root", () => {
    expect(trail(root, "files:battle/boss").map(n => n.name)).toEqual(["Files", "battle", "boss"]);
  });
});

describe("playlistsTree", () => {
  const root = playlistsTree(
    [{ id: "f1", name: "Campaign", folder: null, sort: 0 }, { id: "f2", name: "Taverns", folder: "f1", sort: 0 }],
    [
      { id: "p1", name: "Cozy", folder: "f2", sort: 0, sounds: [{ name: "Lute", path: "a.ogg", sort: 1 }, { name: "Fire", path: "b.ogg", sort: 0 }] },
      { id: "p2", name: "Loose", folder: null, sort: 0, sounds: [{ name: "Wind", path: "c.ogg", sort: 0 }] },
    ],
  );
  it("mirrors folders, then playlists, then their tracks in sort order", () => {
    expect(root.children.map(c => `${c.kind}:${c.name}`)).toEqual(["folder:Campaign", "playlist:Loose"]);
    const cozy = findNode(root, "playlist:p1")!;
    expect(cozy.children.map(c => c.name)).toEqual(["Fire", "Lute"]);
    expect(trail(root, "playlist:p1").map(n => n.name)).toEqual(["Playlists", "Campaign", "Taverns", "Cozy"]);
  });
  it("lists every track below a node, and searches below it", () => {
    expect(tracksUnder(findNode(root, "folder:f1")!).map(t => t.name)).toEqual(["Fire", "Lute"]);
    expect(searchUnder(root, "wind").map(t => t.where)).toEqual(["Loose"]);
    expect(searchUnder(findNode(root, "folder:f1")!, "wind")).toEqual([]);
  });
});
