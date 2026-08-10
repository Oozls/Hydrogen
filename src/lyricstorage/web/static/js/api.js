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
  reorderPlaylistFull: (name, trackIds) =>
    request("POST", `/api/playlists/${encodeURIComponent(name)}/reorder-full`, {
      json: { track_ids: trackIds },
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
  // 라이브러리에 곡을 새로 추가하지 않고, 넘긴 파일들의 태그만 읽어 (제목, 앨범)이
  // 일치하는 기존 곡의 아티스트를 되돌리는 일회성 복구 도구.
  reimportArtists: (fileList, onProgress) => {
    const formData = new FormData();
    for (const file of fileList) formData.append("files[]", file);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/library/reimport-artists");
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
          reject(
            new Error((data && data.error) || `POST /api/library/reimport-artists 실패 (${xhr.status})`)
          );
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
  getLyricsBackups: (trackId) => request("GET", `/api/tracks/${trackId}/lyrics/backups`),
  getLyricsBackup: (trackId, name) =>
    request("GET", `/api/tracks/${trackId}/lyrics/backups/${encodeURIComponent(name)}`),
  restoreLyricsBackup: (trackId, name) =>
    request("POST", `/api/tracks/${trackId}/lyrics/backups/${encodeURIComponent(name)}/restore`),
  setRating: (trackId, rating) =>
    request("PUT", `/api/tracks/${trackId}/rating`, { json: { rating } }),
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
  downloadUrl: (trackId) => `/api/tracks/${trackId}/download`,
  getAlbums: () => request("GET", "/api/albums"),
  getAlbum: (albumId) => request("GET", `/api/albums/${albumId}`),
  updateAlbum: (albumId, { name, artist, year }) =>
    request("PUT", `/api/albums/${albumId}`, { json: { name, artist, year } }),
  uploadAlbumArt: (albumId, file) => {
    const formData = new FormData();
    formData.append("art", file);
    return request("POST", `/api/albums/${albumId}/art`, { formData });
  },
  albumArtUrl: (albumId) => `/api/albums/${albumId}/art`,
  useTrackArtForAlbum: (albumId) => request("POST", `/api/albums/${albumId}/art/from-track`),
  albumDownloadUrl: (albumId) => `/api/albums/${albumId}/download`,
  getArtists: () => request("GET", "/api/artists"),
  resolveArtist: (name) => request("POST", "/api/artists/resolve", { json: { name } }),
  renameArtist: (artistId, name) => request("PUT", `/api/artists/${artistId}`, { json: { name } }),
  addArtistAlias: (artistId, alias) =>
    request("POST", `/api/artists/${artistId}/aliases`, { json: { alias } }),
  removeArtistAlias: (artistId, alias) =>
    request("DELETE", `/api/artists/${artistId}/aliases?alias=${encodeURIComponent(alias)}`),
  getCircles: () => request("GET", "/api/circles"),
  resolveCircle: (name) => request("POST", "/api/circles/resolve", { json: { name } }),
  renameCircle: (circleId, name) => request("PUT", `/api/circles/${circleId}`, { json: { name } }),
  addCircleAlias: (circleId, alias) =>
    request("POST", `/api/circles/${circleId}/aliases`, { json: { alias } }),
  removeCircleAlias: (circleId, alias) =>
    request("DELETE", `/api/circles/${circleId}/aliases?alias=${encodeURIComponent(alias)}`),
  logPlay: (trackId, title, artist, album, listenedMs) =>
    request("POST", "/api/stats/plays", {
      json: { track_id: trackId, title, artist, album, listened_ms: listenedMs },
    }),
  getRecentPlays: (limit) => request("GET", `/api/stats/recent?limit=${limit || 12}`),
  getTrackTotals: (trackId) => request("GET", `/api/stats/track/${encodeURIComponent(trackId)}/totals`),
  getTopStats: (period, group, offset, limit) =>
    request(
      "GET",
      `/api/stats/top?period=${period}&group=${group}&offset=${offset}` +
        (limit == null ? "" : `&limit=${limit}`)
    ),
  getTodaySongs: (limit, reroll, record) =>
    request(
      "GET",
      `/api/recommendations/today?limit=${limit || 8}${reroll ? `&reroll=${encodeURIComponent(reroll)}` : ""}` +
        (record === false ? "&record=0" : "")
    ),
  getQueueSongs: ({ seedTrackId, count, familiarCount, excludeIds }) =>
    request(
      "GET",
      `/api/recommendations/queue?seed_track_id=${encodeURIComponent(seedTrackId)}&count=${count || 1}` +
        (familiarCount ? `&familiar_count=${familiarCount}` : "") +
        (excludeIds && excludeIds.length ? `&exclude=${excludeIds.map(encodeURIComponent).join(",")}` : "")
    ),
  getTodayWeights: () => request("GET", "/api/recommendations/weights"),
  updateTodayWeights: (patch) => request("PUT", "/api/recommendations/weights", { json: patch }),
};
