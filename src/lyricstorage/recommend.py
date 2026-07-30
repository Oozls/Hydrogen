"""'오늘의 곡' 추천: 재생 기록이 적거나 없는 곡 중 취향(평점/아티스트·앨범 선호도)을
반영해 가중 무작위로 몇 곡을 골라준다."""

from __future__ import annotations

import random
from datetime import date
from typing import Any

from lyricstorage import storage

DEFAULT_LIMIT = 8

# 점수 = BASE + W_RATING*평점 정규화 + W_ARTIST*아티스트 선호도 + W_ALBUM*앨범 선호도
#        + (한 번도 안 들었으면 NEVER_PLAYED_BONUS)
# BASE는 취향 신호가 전혀 없는 곡(들어본 적 없는 아티스트 등)도 최소한의 확률로
# 뽑히게 해서 완전히 새로운 곡을 발견할 여지를 남겨둔다.
BASE_SCORE = 0.15
WEIGHT_RATING = 0.35
WEIGHT_ARTIST = 0.3
WEIGHT_ALBUM = 0.2
NEVER_PLAYED_BONUS = 0.25


def _play_counts(history: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in history:
        track_id = entry.get("track_id")
        if not track_id:
            continue
        counts[track_id] = counts.get(track_id, 0) + 1
    return counts


def _affinity_by(history: list[dict[str, Any]], key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in history:
        value = entry.get(key)
        if not value:
            continue
        counts[value] = counts.get(value, 0) + 1
    return counts


def _median(values: list[int]) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def pick_today_songs(
    tracks: list[dict[str, Any]], *, limit: int = DEFAULT_LIMIT, seed: str | None = None
) -> list[dict[str, Any]]:
    """tracks: track_to_json() 결과 리스트. seed가 없으면 오늘 날짜로 고정되어
    하루 동안은 같은 결과를 준다(이름 그대로 '오늘의 곡')."""
    if not tracks:
        return []

    history = storage.load_play_history()
    play_counts = _play_counts(history)
    artist_affinity = _affinity_by(history, "artist")
    album_affinity = _affinity_by(history, "album")
    max_artist = max(artist_affinity.values(), default=0) or 1
    max_album = max(album_affinity.values(), default=0) or 1

    # 결정적 재현을 위해 track_id로 정렬한 뒤 진행한다.
    ordered_tracks = sorted(tracks, key=lambda t: t.get("track_id") or "")

    # 재생 기록이 라이브러리 평균에 비해 낮거나 없는 곡만 후보로 남긴다. 기준선은
    # 전체 트랙의 재생 횟수 중앙값 — 서비스 초기(대부분 미청취)엔 자연히 0이 되어
    # "한 번도 안 들은 곡" 위주로 좁혀지고, 청취 이력이 쌓일수록 같이 올라간다.
    counts_all = [play_counts.get(t.get("track_id") or "", 0) for t in ordered_tracks]
    threshold = max(_median(counts_all), 1)
    candidates = [t for t in ordered_tracks if play_counts.get(t.get("track_id") or "", 0) <= threshold]
    if not candidates:
        candidates = ordered_tracks

    def score(track: dict[str, Any]) -> float:
        rating_norm = (track.get("rating") or 0) / 5
        artist_score = artist_affinity.get(track.get("artist") or "", 0) / max_artist
        album_score = album_affinity.get(track.get("album") or "", 0) / max_album
        pc = play_counts.get(track.get("track_id") or "", 0)
        bonus = NEVER_PLAYED_BONUS if pc == 0 else 0
        return BASE_SCORE + WEIGHT_RATING * rating_norm + WEIGHT_ARTIST * artist_score + WEIGHT_ALBUM * album_score + bonus

    rng = random.Random(seed if seed is not None else date.today().isoformat())

    pool = list(candidates)
    weights = {t["track_id"]: max(0.01, score(t)) for t in pool}
    picked: list[dict[str, Any]] = []
    n = min(limit, len(pool))
    for _ in range(n):
        current_weights = [weights[t["track_id"]] for t in pool]
        chosen = rng.choices(pool, weights=current_weights, k=1)[0]
        picked.append(chosen)
        pool.remove(chosen)

    result = []
    for i, track in enumerate(picked):
        result.append(
            {
                **track,
                "rank": i + 1,
                "play_count": play_counts.get(track.get("track_id") or "", 0),
            }
        )
    return result
