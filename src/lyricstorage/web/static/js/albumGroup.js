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

export function matchesAlbum(group, q) {
  return `${group.album} ${group.artist}`.toLowerCase().includes(q);
}
