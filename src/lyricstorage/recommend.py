"""'오늘의 곡' 추천: 재생 기록이 적거나 없는 곡 중 취향(평점/아티스트·앨범 선호도)을
반영해 가중 무작위로 몇 곡을 골라준다.

요소별 가중치는 고정 상수가 아니라, 과거에 추천됐던 곡들이 실제로 재생되거나
높은 평점을 받았는지를 관찰해 배치 경사하강으로 조금씩 보정된다(아래
"가중치 학습" 절 참고) — 예를 들어 실제로는 아티스트 선호도보다 평점이 재청취를
더 잘 예측하는 사용자라면, 시간이 지날수록 rating 가중치가 자연히 커진다."""

from __future__ import annotations

import random
from datetime import date, datetime
from typing import Any

from lyricstorage import storage

DEFAULT_LIMIT = 8

# 점수 = BASE + Σ(요소별 학습된 가중치 * 해당 요소의 정규화 값)
# BASE는 취향 신호가 전혀 없는 곡(들어본 적 없는 아티스트 등)도 최소한의 확률로
# 뽑히게 해서 완전히 새로운 곡을 발견할 여지를 남겨둔다.
BASE_SCORE = 0.15

FEATURE_KEYS = ("rating", "artist", "album", "never_played")

# 노출(추천) 이력이 아직 부족할 때(콜드 스타트) 쓰는 초기 가중치. 학습이
# 진행되며 _learn_weights()가 돌려주는 값으로 대체된다.
DEFAULT_WEIGHTS: dict[str, float] = {
    "rating": 0.35,
    "artist": 0.3,
    "album": 0.2,
    "never_played": 0.25,
}

# -- 가중치 학습 -------------------------------------------------------------
# "오늘의 곡"으로 뽑힐 때마다 그 곡의 요소별 정규화 값(features)을 노출 이력에
# 남겨두고, 이후 그 곡이 실제로 재생됐는지 / 평점이 어땠는지를 "결과"로 삼아
# 선형 회귀(배치 경사하강)로 가중치를 다시 맞춘다. 재생됐다는 사실과 평점을
# 6:4로 섞어 "결과 점수"를 만드는데, 재생 여부는 확실한 관심 신호인 반면
# 평점은 아직 안 매겼을 수도 있어(0) 완전히 대체하기보다 보조 신호로만 쓴다.
OUTCOME_PLAY_WEIGHT = 0.6
OUTCOME_RATING_WEIGHT = 0.4
LEARNING_RATE = 0.05
LEARNING_EPOCHS = 200
# 노출 표본이 이보다 적으면 아직 신뢰할 수 없다고 보고 기본 가중치를 그대로 쓴다.
MIN_EXPOSURES_TO_LEARN = 8
# 최근 취향 변화를 더 잘 반영하고 매 요청마다 재학습하는 비용을 억제하기 위해
# 가장 최근 노출 N개만 학습에 사용한다(오래 쓸수록 무한정 늘어나는 로그 전체를
# 매번 replay하지 않도록).
MAX_EXPOSURES_FOR_LEARNING = 400
WEIGHT_MIN, WEIGHT_MAX = 0.05, 0.6


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


def _track_outcome(track_id: str, exposed_at: str, history: list[dict[str, Any]], rating_by_track: dict[str, float]) -> float:
    """추천된 시점(exposed_at) 이후 실제로 재생됐는지(관심 신호)와, 지금 그
    곡의 평점(만족도 신호)을 6:4로 섞어 0~1 사이 "결과 점수"를 만든다."""
    played_after = any(
        entry.get("track_id") == track_id and (entry.get("played_at") or "") > exposed_at
        for entry in history
    )
    rating_norm = (rating_by_track.get(track_id) or 0) / 5
    return OUTCOME_PLAY_WEIGHT * (1.0 if played_after else 0.0) + OUTCOME_RATING_WEIGHT * rating_norm


def _learn_weights(
    exposures: list[dict[str, Any]], history: list[dict[str, Any]], rating_by_track: dict[str, float]
) -> dict[str, float]:
    """과거 노출 로그 + 실제 재생/평점 결과로 요소별 가중치를 배치 경사하강으로
    다시 맞춘다. 표본이 부족하면(콜드 스타트) 기본 가중치를 그대로 돌려준다."""
    recent = exposures[-MAX_EXPOSURES_FOR_LEARNING:]
    if len(recent) < MIN_EXPOSURES_TO_LEARN:
        return dict(DEFAULT_WEIGHTS)

    samples = [
        (exp.get("features") or {}, _track_outcome(exp.get("track_id"), exp.get("logged_at") or "", history, rating_by_track))
        for exp in recent
    ]

    weights = dict(DEFAULT_WEIGHTS)
    n = len(samples)
    for _ in range(LEARNING_EPOCHS):
        for feats, outcome in samples:
            predicted = sum(weights[k] * feats.get(k, 0.0) for k in FEATURE_KEYS)
            error = outcome - predicted
            for k in FEATURE_KEYS:
                weights[k] += (LEARNING_RATE / n) * error * feats.get(k, 0.0)
                weights[k] = min(WEIGHT_MAX, max(WEIGHT_MIN, weights[k]))
    return weights


def _record_exposures(today: str, picked: list[dict[str, Any]], feats_by_id: dict[str, dict[str, float]]) -> None:
    """오늘 이미 노출 기록을 남겼다면(같은 날 재요청 등) 중복 기록하지 않는다 —
    학습용 로그는 하루에 한 번, 그날의 '공식' 추천 결과만 남기면 충분하다."""
    exposures = storage.load_recommend_exposures()
    if any(exp.get("date") == today for exp in exposures):
        return
    logged_at = datetime.now().isoformat(timespec="seconds")
    for track in picked:
        track_id = track.get("track_id")
        exposures.append(
            {
                "date": today,
                "track_id": track_id,
                "features": feats_by_id.get(track_id, {}),
                "logged_at": logged_at,
            }
        )
    storage.save_recommend_exposures(exposures)


def pick_today_songs(
    tracks: list[dict[str, Any]],
    *,
    limit: int = DEFAULT_LIMIT,
    seed: str | None = None,
    record_exposure: bool = True,
) -> list[dict[str, Any]]:
    """tracks: track_to_json() 결과 리스트. seed가 없으면 오늘 날짜로 고정되어
    하루 동안은 같은 결과를 준다(이름 그대로 '오늘의 곡'). record_exposure가
    참이면 이 추천 결과를 학습용 노출 로그에 남긴다(재뽑기 요청에는 꺼서, 임시로
    다시 뽑아본 결과가 '공식' 추천으로 학습되지 않게 한다)."""
    if not tracks:
        return []

    history = storage.load_play_history()
    play_counts = _play_counts(history)
    artist_affinity = _affinity_by(history, "artist")
    album_affinity = _affinity_by(history, "album")
    max_artist = max(artist_affinity.values(), default=0) or 1
    max_album = max(album_affinity.values(), default=0) or 1
    rating_by_track = {t.get("track_id"): t.get("rating") or 0 for t in tracks}

    today = date.today().isoformat()
    exposures = storage.load_recommend_exposures()
    weights = _learn_weights(exposures, history, rating_by_track)

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

    def features(track: dict[str, Any]) -> dict[str, float]:
        pc = play_counts.get(track.get("track_id") or "", 0)
        return {
            "rating": (track.get("rating") or 0) / 5,
            "artist": artist_affinity.get(track.get("artist") or "", 0) / max_artist,
            "album": album_affinity.get(track.get("album") or "", 0) / max_album,
            "never_played": 1.0 if pc == 0 else 0.0,
        }

    feats_by_id = {t["track_id"]: features(t) for t in candidates}

    def score(track: dict[str, Any]) -> float:
        feats = feats_by_id[track["track_id"]]
        return BASE_SCORE + sum(weights[k] * feats.get(k, 0.0) for k in FEATURE_KEYS)

    rng = random.Random(seed if seed is not None else today)

    pool = list(candidates)
    score_by_id = {t["track_id"]: max(0.01, score(t)) for t in pool}
    picked: list[dict[str, Any]] = []
    n = min(limit, len(pool))
    for _ in range(n):
        current_weights = [score_by_id[t["track_id"]] for t in pool]
        chosen = rng.choices(pool, weights=current_weights, k=1)[0]
        picked.append(chosen)
        pool.remove(chosen)

    if record_exposure and picked:
        _record_exposures(today, picked, feats_by_id)

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
