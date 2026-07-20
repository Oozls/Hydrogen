async function request(method, url, { json, formData } = {}) {
  const opts = { method, headers: {} };
  if (json !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
  } else if (formData !== undefined) {
    opts.body = formData;
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let message = `${method} ${url} 실패 (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch (_err) {
      /* 응답이 JSON이 아님 */
    }
    throw new Error(message);
  }
  const contentType = res.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) return res.json();
  return null;
}

export const api = {
  listPlaylists: () => request("GET", "/api/playlists"),
  createPlaylist: (name) => request("POST", "/api/playlists", { json: { name } }),
  getPlaylist: (name) => request("GET", `/api/playlists/${encodeURIComponent(name)}`),
  deletePlaylist: (name) => request("DELETE", `/api/playlists/${encodeURIComponent(name)}`),
  reorderPlaylist: (name, fromIndex, toIndex) =>
    request("POST", `/api/playlists/${encodeURIComponent(name)}/reorder`, {
      json: { from_index: fromIndex, to_index: toIndex },
    }),
  removeTracks: (name, trackIds) =>
    request("POST", `/api/playlists/${encodeURIComponent(name)}/tracks/remove-batch`, {
      json: { track_ids: trackIds },
    }),
  addTracksFromLibrary: (name, trackIds) =>
    request("POST", `/api/playlists/${encodeURIComponent(name)}/tracks`, {
      json: { track_ids: trackIds },
    }),
  getLibrary: () => request("GET", "/api/library"),
  uploadFiles: (fileList) => {
    const formData = new FormData();
    for (const file of fileList) formData.append("files[]", file);
    return request("POST", "/api/library/upload", { formData });
  },
  getSettings: () => request("GET", "/api/settings"),
  updateSettings: (patch) => request("PUT", "/api/settings", { json: patch }),
  getLyrics: (trackId) => request("GET", `/api/tracks/${trackId}/lyrics`),
  saveLyrics: (trackId, lines) =>
    request("PUT", `/api/tracks/${trackId}/lyrics`, { json: { lines } }),
  updateTrackMetadata: (trackId, patch) =>
    request("PUT", `/api/tracks/${trackId}/metadata`, { json: patch }),
  uploadTrackArt: (trackId, file) => {
    const formData = new FormData();
    formData.append("art", file);
    return request("POST", `/api/tracks/${trackId}/art`, { formData });
  },
  audioUrl: (trackId) => `/api/tracks/${trackId}/audio`,
  artUrl: (trackId) => `/api/tracks/${trackId}/art`,
};
