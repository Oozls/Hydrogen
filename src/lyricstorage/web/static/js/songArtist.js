import { createMarqueeClip } from "./marquee.js";

// 곡 아티스트 문자열을 쉼표로 나눠 여러 아티스트로 분리한다(예: "A, B" -> ["A", "B"]).
// stats.py의 split_artists와 동일한 규칙 — 재생 순위 집계, 브라우즈, 재생 통계
// 화면이 모두 같은 기준으로 아티스트를 나눠야 하기 때문.
export function splitArtists(artist) {
  return (artist || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 곡 목록 행/카드의 아티스트 칸을 만든다. 아티스트가 하나면 기존과 동일하게
// 마퀴 스크롤이 가능한 클릭 영역 하나로 만들고, 쉼표로 여럿이면 각 이름을
// 개별적으로 클릭 가능한 조각으로 나눠 렌더링한다 — 이 경우 마퀴 스크롤(둘 이상의
// 클릭 영역과 텍스트 복제 애니메이션을 동시에 지원하려면 marquee.js의 내부 구조를
// 다시 짜야 해서 배보다 배꼽이 큼)은 포기하고 그냥 말줄임표로 자른다.
// onOpenArtist(name)이 없으면 클릭 불가능한 일반 텍스트로 렌더링한다.
export function buildArtistCell(clipClassName, artistString, onOpenArtist) {
  const names = splitArtists(artistString);
  if (names.length <= 1) {
    const clip = createMarqueeClip(clipClassName, "", artistString || "");
    if (names.length === 1 && onOpenArtist) {
      clip.classList.add("playlist-row-artist-link");
      clip.title = "아티스트 보기";
      clip.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpenArtist(names[0]);
      });
    }
    return clip;
  }
  const clip = document.createElement("span");
  clip.className = `${clipClassName} marquee-clip`;
  names.forEach((name, i) => {
    if (i > 0) clip.appendChild(document.createTextNode(", "));
    const nameEl = document.createElement("span");
    nameEl.textContent = name;
    if (onOpenArtist) {
      nameEl.className = "playlist-row-artist-link";
      nameEl.title = "아티스트 보기";
      nameEl.addEventListener("click", (e) => {
        e.stopPropagation();
        onOpenArtist(name);
      });
    }
    clip.appendChild(nameEl);
  });
  return clip;
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

// 서클명과 곡 아티스트명이 같은 경우, 서클을 우선한다 — 이 함수는 이름(대표
// 이름 또는 별칭)이 서클 레지스트리에 등록돼 있는지 확인한다. 못 찾으면
// buildArtistNameResolver처럼 입력값을 그대로 돌려주지 않고 null을 돌려준다 —
// 여기선 "서클이 맞는지"를 구분해야 호출부가 곡 아티스트 쪽 로직을 계속 탈지
// 서클 쪽으로 넘길지 판단할 수 있다.
export function buildCircleNameFinder(circles) {
  const lookup = new Map();
  for (const circle of circles) {
    lookup.set(circle.name, circle.name);
    for (const alias of circle.aliases) lookup.set(alias, circle.name);
  }
  return (name) => lookup.get(name) || null;
}
