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
  renamePlaylist: (name, newName) =>
    request("POST", `/api/playlists/${encodeURIComponent(name)}/rename`, {
      json: { name: newName },
    }),
  reorderPlaylist: (name, fromIndex, toIndex) =>
    request("POST", `/api/playlists/${encodeURIComponent(name)}/reorder`, {
      json: { from_index: fromIndex, to_index: toIndex },
    }),
  removeTracks: (name, indices) =>
    request("POST", `/api/playlists/${encodeURIComponent(name)}/tracks/remove-batch`, {
      json: { indices },
    }),
  addTracksFromLibrary: (name, trackIds) =>
    request("POST", `/api/playlists/${encodeURIComponent(name)}/tracks`, {
      json: { track_ids: trackIds },
    }),
  getLibrary: () => request("GET", "/api/library"),
  // onProgress(fraction): 업로드 바이트 전송 진행률(0~1)을 실시간으로 받고 싶을 때만
  // 넘긴다. 서버 응답을 기다리는 구간(해시 계산/태그 읽기)은 진행률을 알 수 없으므로
  // 전송이 끝나면 onProgress(1)까지만 호출되고, 이후는 호출자가 알아서 처리한다.
  uploadFiles: (fileList, playlistName, onProgress) => {
    const formData = new FormData();
    for (const file of fileList) formData.append("files[]", file);
    if (playlistName) formData.append("playlist", playlistName);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/library/upload");
      if (onProgress) {
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        });
      }
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (_err) {
          /* 응답이 JSON이 아님 */
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error((data && data.error) || `POST /api/library/upload 실패 (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error("업로드 중 네트워크 오류가 발생했습니다."));
      xhr.send(formData);
    });
  },
  getSettings: () => request("GET", "/api/settings"),
  updateSettings: (patch) => request("PUT", "/api/settings", { json: patch }),
  getDataSize: () => request("GET", "/api/settings/data-size"),
  getLyrics: (trackId) => request("GET", `/api/tracks/${trackId}/lyrics`),
  saveLyrics: (trackId, lines) =>
    request("PUT", `/api/tracks/${trackId}/lyrics`, { json: { lines } }),
  updateTrackMetadata: (trackId, patch) =>
    request("PUT", `/api/tracks/${trackId}/metadata`, { json: patch }),
  updateTrackMetadataBatch: (trackIds, patch) =>
    request("PUT", "/api/tracks/metadata/batch", { json: { track_ids: trackIds, ...patch } }),
  deleteTrackEntirely: (trackId) => request("DELETE", `/api/tracks/${trackId}`),
  deleteTracksBatch: (trackIds) =>
    request("DELETE", "/api/tracks/metadata/batch", { json: { track_ids: trackIds } }),
  uploadTrackArt: (trackId, file) => {
    const formData = new FormData();
    formData.append("art", file);
    return request("POST", `/api/tracks/${trackId}/art`, { formData });
  },
  audioUrl: (trackId) => `/api/tracks/${trackId}/audio`,
  artUrl: (trackId) => `/api/tracks/${trackId}/art`,
  logPlay: (trackId, title, artist, album, listenedMs) =>
    request("POST", "/api/stats/plays", {
      json: { track_id: trackId, title, artist, album, listened_ms: listenedMs },
    }),
  getTopStats: (period, group, offset) =>
    request("GET", `/api/stats/top?period=${period}&group=${group}&offset=${offset}`),
  updateAlbum: (album, artist, newAlbum, artFile) => {
    const formData = new FormData();
    formData.append("album", album);
    formData.append("artist", artist);
    formData.append("new_album", newAlbum);
    if (artFile) formData.append("art", artFile);
    return request("POST", "/api/albums/update", { formData });
  },
};
