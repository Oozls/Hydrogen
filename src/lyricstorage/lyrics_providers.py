"""외부 가사 제공처(LRCLIB, TouhouDB)에서 가사 후보를 가져온다.

둘 다 공개 API고 인증이 필요 없다:
- LRCLIB(lrclib.net): 동기화 가사를 .lrc와 동일한 [mm:ss.xx] 포맷으로 제공 —
  parse_lrc()로 그대로 파싱된다.
- TouhouDB(touhoudb.com): VocaDB 계열 동방 음악 데이터베이스. 가사는 타임스탬프
  없는 평문만 제공하므로, 00:00.00 한 줄에 전체 가사를 그대로 담는다(embedded
  \n 포함 — lyrics_io.to_lrc()가 이미 이런 멀티라인 단일 항목을 지원한다).

두 제공처 모두 가사가 있을 수 있고, TouhouDB는 같은 제목의 곡이 여럿(다른
서클/보컬 버전 등) 등록돼 있을 수 있어서, 자동으로 하나를 골라 저장하지 않고
fetch_lyrics_candidates()가 찾을 수 있는 후보를 전부 모아 반환한다 — 최종
선택은 호출자(사용자)에게 맡긴다.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

from lyricstorage import lyrics_io

_TIMEOUT_SEC = 8

# 로컬 트랙 제목은 참여 아티스트를 "곡명 feat. A,B" 식으로 제목 자체에 적어두는
# 관행이 흔하다(이 라이브러리도 "Dreamy Noise feat. AO" 등 다수 — 공백 없이
# "곡명feat.A"로 붙어있거나 대소문자가 Feat/FEAT인 것도 있다). 이 구간을
# 그대로 검색어에 넣으면 실제로 등록된(참여 아티스트 표기 없는) 제목과 안
# 맞아 검색이 통째로 실패한다("nameMatchMode=Words"는 검색어의 모든 단어가
# 후보 이름에 있어야 하는데, 후보 제목엔 애초에 "feat. ..." 부분이 없다).
# "(리믹스명)"처럼 feat. 뒤에 이어지는 진짜 제목의 일부는 보존한다.
# 앞에 라틴 문자가 바로 붙어있으면(예: "defeat") 매칭하지 않는다 — 그 앞이
# 공백이든 한글/한자든 문자열 시작이든 다 매칭된다("남몰래feat.김철수"도 포함).
_FEAT_RE = re.compile(r"(?<![A-Za-z])feat\.?\s*[^(]*?(?=\s*\(|$)", re.IGNORECASE)


def _strip_feat_credits(title: str) -> str:
    cleaned = _FEAT_RE.sub("", title)
    # 원문에 "feat." 앞뒤로 공백이 있었으면 그 구간을 지우고 나서 공백이
    # 두 칸 남거나(중간에서 지운 경우) 끝에 남을(맨 끝에서 지운 경우) 수 있다.
    return re.sub(r"\s{2,}", " ", cleaned).strip()
_USER_AGENT = "lyric-storage/1.0"


def _get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT_SEC) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_lrclib(title: str, artist: str) -> dict | None:
    """반환: {"source", "synced", "lines", "title", "artist", "album"} 또는 못 찾으면 None.
    title/artist/album은 LRCLIB에 등록된 실제 표기 — 후보 목록에 보여줄 라벨용."""
    if not title:
        return None
    params = {"track_name": title}
    if artist:
        params["artist_name"] = artist
    url = "https://lrclib.net/api/search?" + urllib.parse.urlencode(params)
    try:
        results = _get_json(url)
    except (urllib.error.URLError, ValueError, OSError, TimeoutError):
        return None
    for item in results or []:
        if item.get("instrumental"):
            continue
        label = {
            "title": item.get("trackName") or title,
            "artist": item.get("artistName") or artist,
            "album": item.get("albumName") or "",
        }
        synced = item.get("syncedLyrics")
        if synced:
            lines = lyrics_io.parse_lrc(synced)
            if lines:
                return {"source": "LRCLIB", "synced": True, "lines": lines, **label}
        plain = (item.get("plainLyrics") or "").strip()
        if plain:
            return {"source": "LRCLIB", "synced": False, "lines": [(0, plain)], **label}
    return None


def _split_names(value: str) -> list[str]:
    """쉼표로 구분된 다중 아티스트 문자열(예: "たま, ytr, AO")을 개별 이름으로
    나눈다 — songArtist.js가 곡 아티스트 칸을 쪼갤 때 쓰는 것과 동일한 구분자.
    보컬이 여럿인 곡은 로컬 artist 필드가 이렇게 합쳐져 있는데, 이 통짜
    문자열을 그대로 TouhouDB 아티스트 이름 정확매칭에 넘기면(어느 개별
    아티스트 이름과도 안 같으니) 항상 실패한다."""
    return [n.strip() for n in value.split(",") if n.strip()]


def _resolve_touhoudb_artist_id(name: str) -> int | None:
    """이름으로 TouhouDB 아티스트를 정확매칭으로 찾아 id를 반환, 없으면 None.
    곡 검색을 좁히는 보조 신호일 뿐이라 여기서 실패(네트워크 오류 등)해도
    조용히 None을 돌려주고, 전체 조회를 실패시키지 않는다."""
    if not name:
        return None
    params = {"query": name, "maxResults": 1, "nameMatchMode": "Exact"}
    url = "https://touhoudb.com/api/artists?" + urllib.parse.urlencode(params)
    try:
        data = _get_json(url)
    except (urllib.error.URLError, ValueError, OSError, TimeoutError):
        return None
    items = data.get("items") or []
    return items[0]["id"] if items else None


def _extract_lyrics(item: dict) -> str | None:
    entries = item.get("lyrics") or []
    if not entries:
        return None
    chosen = next((e for e in entries if e.get("translationType") == "Original"), entries[0])
    value = (chosen.get("value") or "").strip()
    return value or None


def _touhoudb_candidate(item: dict) -> dict | None:
    value = _extract_lyrics(item)
    if not value:
        return None
    # 한 곡이 여러 앨범(정규/편집반/이벤트 한정반 등)에 실려 있을 수 있는데,
    # 여기서는 후보 구분용 라벨 한 줄이면 충분하므로 첫 앨범명만 쓴다.
    albums = item.get("albums") or []
    return {
        "source": "TouhouDB",
        "synced": False,
        "lines": [(0, value)],
        "title": item.get("name") or "",
        "artist": item.get("artistString") or "",
        "album": albums[0].get("name", "") if albums else "",
    }


def _search_touhoudb_songs(title: str, artist_ids: list[int]) -> list[dict]:
    """artist_ids로 서버 쪽에서 이미 걸러진 검색 — 결과는 신뢰하고 가사가 있는
    곡을 전부 후보로 돌려준다(요청자가 이미 특정 아티스트로 좁혀 보냈으므로)."""
    params = [("query", title), ("maxResults", 10), ("fields", "Lyrics,Albums"), ("nameMatchMode", "Words")]
    for aid in artist_ids:
        params.append(("artistId[]", aid))
    url = "https://touhoudb.com/api/songs?" + urllib.parse.urlencode(params)
    try:
        data = _get_json(url)
    except (urllib.error.URLError, ValueError, OSError, TimeoutError):
        return []
    candidates = [_touhoudb_candidate(item) for item in data.get("items") or []]
    return [c for c in candidates if c is not None]


def _credited_names(item: dict) -> set[str]:
    """곡 하나의 크레딧 이름을 전부 모은다. artistString은 협업자가 많으면
    "Coro feat. various"처럼 개별 이름을 생략해버리므로(겹치는지 확인하는
    용도로는 못 믿는다), fields=Artists로 받은 개별 아티스트 이름과
    별칭(additionalNames)까지 다 모아야 실제로 크레딧된 사람을 놓치지 않는다."""
    names: set[str] = set()
    s = (item.get("artistString") or "").strip().lower()
    if s:
        names.add(s)
    for a in item.get("artists") or []:
        name = (a.get("name") or "").strip().lower()
        if name:
            names.add(name)
        add_names = ((a.get("artist") or {}).get("additionalNames")) or ""
        for n in add_names.split(","):
            n = n.strip().lower()
            if n:
                names.add(n)
    return names


def _search_touhoudb_songs_verified(title: str, artist: str, circle: str) -> list[dict]:
    """artist/circle 중 어느 것도 TouhouDB에 정확매칭 등록돼 있지 않을 때(표기
    차이 등)만 쓰는 마지막 수단. 서버 쪽 필터 없이 제목만으로 후보를 여러 개
    모은 뒤, 후보의 크레딧 이름들에 로컬 아티스트/서클 이름이 조금이라도
    겹치는지 직접 대조해서 통과한 것만 후보로 돌려준다 — 동방 원곡명은
    완전히 다른 서클/보컬의 곡과 흔히 겹치므로, 겹치는 게 하나도 없으면 그냥
    후보에서 뺀다(엉뚱한 곡의 가사를 후보로 섞는 것보다 낫다)."""
    needles = [n.lower() for n in (_split_names(artist) + _split_names(circle))]
    if not needles:
        return []
    params = [("query", title), ("maxResults", 20), ("fields", "Lyrics,Artists,Albums"), ("nameMatchMode", "Words")]
    url = "https://touhoudb.com/api/songs?" + urllib.parse.urlencode(params)
    try:
        data = _get_json(url)
    except (urllib.error.URLError, ValueError, OSError, TimeoutError):
        return []
    matched = []
    for item in data.get("items") or []:
        credited = _credited_names(item)
        if credited and any(needle in c or c in needle for needle in needles for c in credited):
            matched.append(item)
    candidates = [_touhoudb_candidate(item) for item in matched]
    return [c for c in candidates if c is not None]


def fetch_touhoudb_candidates(title: str, artist: str, circle: str = "") -> list[dict]:
    """반환: [{"source": "TouhouDB", "synced": False, "lines": [(0, text)], "title", "artist"}, ...].

    동방 동인 음악은 같은 제목("竹取飛翔" 등 원곡명을 그대로 쓰는 어레인지)의
    곡이 서로 다른 서클/보컬로 수십 곡씩 등록돼 있어서, 제목만으로 검색하면
    원하는 버전이 상위 결과에 아예 안 잡히는 경우가 흔하다(query에 아티스트를
    같이 넣으면 nameMatchMode=Words가 AND로 묶어버려 표기가 조금만 달라도
    통째로 0건이 되니 그 방법도 못 쓴다 — 예: 태그엔 "96"인데 TouhouDB엔
    "void feat. >>96"). 대신 곡 아티스트/서클명을 TouhouDB 아티스트로 먼저
    정확매칭해 id를 얻고, artistId[]로 "그 아티스트가 참여한 곡"만 서버
    쪽에서 걸러서 검색한다.

    아티스트와 서클을 한 번에 artistId[]=A&artistId[]=B로 같이 넘기면 안 된다
    — VocaDB는 여러 값을 OR가 아니라 AND로 묶어서 "둘 다 참여한 곡"만 찾는데,
    실제로는 개별 곡이 서클 전체가 아니라 멤버 개인으로만 크레딧되는 경우가
    흔해 서클 id를 같이 넣으면 오히려 못 찾게 된다. 대신 아티스트 → 서클
    순서로 하나씩 따로 시도해 먼저 후보가 나오는 걸 쓴다.

    곡 아티스트는 보컬이 여럿이면 로컬에서 "たま, ytr, AO"처럼 쉼표로 합쳐
    저장돼 있다(songArtist.js와 동일 규칙). 이 통짜 문자열 그대로 정확매칭에
    넘기면 어차피 그런 이름의 아티스트는 TouhouDB에 없으니 항상 실패한다
    — 반드시 개별 이름으로 나눠 하나씩 시도해야 한다.

    아티스트/서클 개별 이름 전부가 TouhouDB에 정확매칭되는 게 없으면(표기
    차이로 못 찾은 것뿐일 수 있다) 제목만으로 무필터 검색하되, 후보의
    크레딧과 로컬 아티스트/서클 이름이 하나도 안 겹치는 것들은 후보에서
    뺀다."""
    if not title:
        return []
    for name in _split_names(artist) + _split_names(circle):
        artist_id = _resolve_touhoudb_artist_id(name)
        if artist_id is None:
            continue
        candidates = _search_touhoudb_songs(title, [artist_id])
        if candidates:
            return candidates
    return _search_touhoudb_songs_verified(title, artist, circle)


def fetch_lyrics_candidates(title: str, artist: str, circle: str = "") -> list[dict]:
    """LRCLIB과 TouhouDB에서 찾을 수 있는 가사 후보를 전부 모아 반환한다 —
    어느 한쪽을 자동으로 우선하지 않고, 최종 선택은 호출자(사용자)에게 맡긴다."""
    search_title = _strip_feat_credits(title)
    candidates = []
    lrclib = fetch_lrclib(search_title, artist)
    if lrclib:
        candidates.append(lrclib)
    candidates.extend(fetch_touhoudb_candidates(search_title, artist, circle))
    return candidates
