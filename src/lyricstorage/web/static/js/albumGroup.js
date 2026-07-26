// 곡 목록을 앨범(앨범명+아티스트명) 단위로 묶는다. 브라우즈 "앨범" 탭과
// 재생목록의 "라이브러리에서 추가" 앨범 선택 화면이 공용으로 사용한다.
export function groupAlbums(tracks) {
  const map = new Map();
  for (const track of tracks) {
    const key = `${track.album} ${track.artist}`;
    if (!map.has(key)) {
      map.set(key, { album: track.album, artist: track.artist, track_id: track.track_id, tracks: [] });
    }
    map.get(key).tracks.push(track);
  }
  return [...map.values()];
}

// field: "all"(기본) | "album" | "artist" — 검색창 옆 범위 선택에 맞춰 특정
// 필드만 대상으로 검색할 수 있게 한다. "title"은 앨범 단위엔 없는 필드라
// 호출하는 쪽(브라우즈 앨범 탭 등)에서 애초에 선택지에서 빼둔다.
export function matchesAlbum(group, q, field = "all") {
  if (field === "album") return (group.album || "").toLowerCase().includes(q);
  if (field === "artist") return (group.artist || "").toLowerCase().includes(q);
  return `${group.album} ${group.artist}`.toLowerCase().includes(q);
}
