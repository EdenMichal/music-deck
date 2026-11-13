/** The Library's two sources as trees (library-tree.ts), from Foundry's playlists and the Data/music/ index. */
import { libraryTracks } from "./library";
import { filesTree, findNode, playlistsTree, trackChoices, tracksUnder, type LibFolder, type LibSource, type LibTrack } from "./library-tree";
import { channelOf } from "./live-gain";

export function libraryRoot(source: LibSource): LibFolder {
  if (source === "files") return filesTree(libraryTracks());
  return playlistsTree(
    game.folders.filter((f: any) => f.type === "Playlist").map((f: any) => ({ id: f.id, name: f.name, folder: f.folder?.id ?? null, sort: f.sort })),
    // Music Deck's own playlists are the decks, not the Library.
    game.playlists.filter((p: any) => !channelOf(p)).map((p: any) => ({
      id: p.id, name: p.name, folder: p.folder?.id ?? null, sort: p.sort,
      sounds: p.sounds.map((s: any) => ({ name: s.name, path: s.path, sort: s.sort })),
    })),
  );
}

/** Every track a Set Track key can pick: both Library sources, each file once (protocol 8). */
export function deckTrackChoices(): { path: string; name: string; where: string }[] {
  return trackChoices(libraryRoot("playlists"), libraryRoot("files"));
}

/** Which source a node id belongs to. */
export const sourceOf = (id: string): LibSource => (id.startsWith("files:") ? "files" : "playlists");

/** A folder or playlist anywhere in the Library, e.g. the battle source. */
export function nodeFor(id: string): LibFolder | undefined {
  return id ? findNode(libraryRoot(sourceOf(id)), id) : undefined;
}

export function tracksFor(id: string): LibTrack[] {
  const node = nodeFor(id);
  return node ? tracksUnder(node) : [];
}

/** The source to open on: Playlists if there's any playlist of your own, otherwise Files. */
export function defaultSource(): LibSource {
  return game.playlists.some((p: any) => !channelOf(p)) ? "playlists" : "files";
}
