// 곡 아티스트 문자열을 쉼표로 나눠 여러 아티스트로 분리한다(예: "A, B" -> ["A", "B"]).
// stats.py의 split_artists와 동일한 규칙 — 재생 순위 집계, 브라우즈, 재생 통계
// 화면이 모두 같은 기준으로 아티스트를 나눠야 하기 때문.
export function splitArtists(artist) {
  return (artist || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 등록된 이명(별칭)을 대표 이름으로 바꿔주는 조회 함수를 만든다. 곡 파일의
// artist 문자열이나 재생 기록에는 옛 이름이 그대로 남아있을 수 있으므로,
// 콜라주/집계 화면에서 같은 사람으로 묶어 보여줄 때 이 함수를 거친다.
export function buildArtistNameResolver(artists) {
  const lookup = new Map();
  for (const artist of artists) {
    lookup.set(artist.name, artist.name);
    for (const alias of artist.aliases) lookup.set(alias, artist.name);
  }
  return (name) => lookup.get(name) || name;
}
