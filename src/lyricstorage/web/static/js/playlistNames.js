import { api } from "./api.js";

export async function fetchNonGlobalPlaylistNames() {
  const items = await api.listPlaylists();
  return items.filter((p) => !p.is_global).map((p) => p.name);
}
