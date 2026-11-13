/**
 * The Library's folder tree (Phase 5). Two sources become one shape: Foundry's Playlists sidebar
 * (folders → playlists → tracks) and the Data/music/ files. Pure, so it can be unit-tested.
 */
export interface LibTrack { kind: "track"; name: string; path: string; where: string }
export interface LibFolder { kind: "folder" | "playlist"; id: string; name: string; count: number; children: LibNode[] }
export type LibNode = LibFolder | LibTrack;
export type LibSource = "playlists" | "files";

export interface FolderInput { id: string; name: string; folder: string | null; sort: number }
export interface PlaylistInput { id: string; name: string; folder: string | null; sort: number; sounds: { name: string; path: string; sort: number }[] }

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
const bySort = (a: { sort: number; name: string }, b: { sort: number; name: string }) => a.sort - b.sort || byName(a, b);
const folder = (kind: LibFolder["kind"], id: string, name: string): LibFolder => ({ kind, id, name, count: 0, children: [] });

function finish(node: LibFolder): LibFolder {
  for (const child of node.children) if (child.kind !== "track") finish(child);
  node.count = node.children.reduce((n, c) => n + (c.kind === "track" ? 1 : c.count), 0);
  return node;
}

/** Data/music/ files. Folder ids are "files:<dirs>"; the root is "files:". */
export function filesTree(tracks: readonly { path: string; name: string }[], root = "music"): LibFolder {
  const top = folder("folder", "files:", "Files");
  const dirs = new Map<string, LibFolder>([["", top]]);
  const dirOf = (parts: string[]): LibFolder => {
    const key = parts.join("/");
    if (!dirs.has(key)) {
      const node = folder("folder", `files:${key}`, parts.at(-1)!);
      dirOf(parts.slice(0, -1)).children.push(node);
      dirs.set(key, node);
    }
    return dirs.get(key)!;
  };
  for (const t of tracks) {
    const parts = decodeURIComponent(t.path.slice(root.length + 1)).split("/").slice(0, -1);
    dirOf(parts).children.push({ kind: "track", name: t.name, path: t.path, where: parts.join(" / ") || "Data/music" });
  }
  for (const d of dirs.values()) d.children.sort((a, b) => (a.kind === "track") === (b.kind === "track") ? byName(a, b) : a.kind === "track" ? 1 : -1);
  return finish(top);
}

/** Foundry's Playlists sidebar. Ids are "folder:<id>" and "playlist:<id>"; the root is "playlists:". */
export function playlistsTree(folders: readonly FolderInput[], playlists: readonly PlaylistInput[]): LibFolder {
  const top = folder("folder", "playlists:", "Playlists");
  const nodes = new Map(folders.map(f => [f.id, folder("folder", `folder:${f.id}`, f.name)]));
  const parentOf = (id: string | null) => (id && nodes.get(id)) || top;
  for (const f of [...folders].sort(bySort)) parentOf(f.folder).children.push(nodes.get(f.id)!);
  for (const p of [...playlists].sort(bySort)) {
    const node = folder("playlist", `playlist:${p.id}`, p.name);
    node.children = [...p.sounds].sort(bySort).map(s => ({ kind: "track", name: s.name, path: s.path, where: p.name }));
    parentOf(p.folder).children.push(node);
  }
  return finish(top);
}

export function findNode(root: LibFolder, id: string): LibFolder | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    if (c.kind === "track") continue;
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}

/** The breadcrumb: root first, the node last. Empty if the node isn't in the tree. */
export function trail(root: LibFolder, id: string): LibFolder[] {
  if (root.id === id) return [root];
  for (const c of root.children) {
    if (c.kind === "track") continue;
    const rest = trail(c, id);
    if (rest.length) return [root, ...rest];
  }
  return [];
}

export function tracksUnder(node: LibFolder): LibTrack[] {
  return node.children.flatMap(c => (c.kind === "track" ? [c] : tracksUnder(c)));
}

export function searchUnder(node: LibFolder, query: string): LibTrack[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tracksUnder(node)
    .filter(t => words.every(w => `${t.name} ${t.where}`.toLowerCase().includes(w)))
    .sort(byName);
}

/** The most tracks a Set Track key's picker lists, so a huge Data/music/ can't swamp the deck link. */
export const MAX_TRACK_CHOICES = 5000;

/**
 * Every track a Set Track key can pick (protocol 8): your playlists' tracks in sidebar order, then the Data/music/
 * files, each file once. `where` is the playlist's name, or the file's folder ("music/Calm Night").
 */
export function trackChoices(playlists: LibFolder, files: LibFolder, max = MAX_TRACK_CHOICES): { path: string; name: string; where: string }[] {
  const seen = new Set<string>();
  const out: { path: string; name: string; where: string }[] = [];
  const add = (t: LibTrack, where: string) => {
    // A playlist sound saved without a file has no path (null): the plugin's schema would drop the whole list.
    if (out.length >= max || !t.path || seen.has(t.path)) return;
    seen.add(t.path);
    out.push({ path: t.path, name: t.name, where });
  };
  for (const t of tracksUnder(playlists)) add(t, t.where);
  for (const t of tracksUnder(files)) {
    let dir = t.path.slice(0, Math.max(0, t.path.lastIndexOf("/")));
    try { dir = decodeURIComponent(dir); } catch { /* keep it as it is */ }
    add(t, dir);
  }
  return out;
}
