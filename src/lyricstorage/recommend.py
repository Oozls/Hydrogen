"""'오늘의 곡' 추천: 재생 기록이 적거나 없는 곡 중 취향(평점/아티스트·앨범 선호도)을
반영해 가중 무작위로 몇 곡을 골라준다.

요소별 가중치는 고정 상수가 아니라, 과거에 추천됐던 곡들이 실제로 재생되거나
높은 평점을 받았는지를 관찰해 배치 경사하강으로 조금씩 보정된다(아래
"가중치 학습" 절 참고) — 예를 들어 실제로는 아티스트 선호도보다 평점이 재청취를
더 잘 예측하는 사용자라면, 시간이 지날수록 rating 가중치가 자연히 커진다.

사용자가 원하면 자동 학습 대신 가중치를 직접 지정할 수도 있다(수동 모드,
resolve_weights 참고). 어느 모드든 실제로 쓰인 가중치는 새로고침/다시 뽑기마다
이력에 기록되어(_record_weight_history) 시간에 따른 변화를 그래프로 볼 수 있다.

취향 신호는 rating/artist/album/never_played 외에 두 가지가 더 있다: explicit(직접
플레이리스트에 담았거나 가사를 저장해둔, 확실한 관심 신호)와 freshness(같은 곡이
계속 추천만 되고 안 들리면 서서히 순위를 낮추는 "추천 피로도"의 역수). 학습 결과
신호(_track_outcome)도 이진 재생 여부 대신 실제로 얼마나 들었는지(끝까지 vs
턱걸이)를 보고, 평점이 낮으면 재생 여부와 무관하게 명확한 부정 신호로 취급한다.
아티스트/앨범 선호도는 오래된 재생일수록 영향력이 지수적으로 줄어들고(시간 감쇠),
같은 배치 안에서는 이미 뽑힌 곡과 아티스트/앨범이 같으면 다음 뽑힐 확률이 줄어든다
(다양성 페널티)."""

from __future__ import annotations

import random
from datetime import date, datetime
from typing import Any

from lyricstorage import storage
from lyricstorage.models import GLOBAL_PLAYLIST_NAME, PlaylistModel
from lyricstorage.stats import split_artists

DEFAULT_LIMIT = 8

# 점수 = BASE + Σ(요소별 학습된 가중치 * 해당 요소의 정규화 값)
# BASE는 취향 신호가 전혀 없는 곡(들어본 적 없는 아티스트 등)도 최소한의 확률로
# 뽑히게 해서 완전히 새로운 곡을 발견할 여지를 남겨둔다.
BASE_SCORE = 0.15

FEATURE_KEYS = ("rating", "artist", "album", "never_played", "explicit", "freshness")

# 노출(추천) 이력이 아직 부족할 때(콜드 스타트) 쓰는 초기 가중치. 학습이
# 진행되며 _learn_weights()가 돌려주는 값으로 대체된다.
DEFAULT_WEIGHTS: dict[str, float] = {
    "rating": 0.35,
    "artist": 0.3,
    "album": 0.2,
    "never_played": 0.25,
    "explicit": 0.3,
    "freshness": 0.2,
}

# -- 가중치 학습 -------------------------------------------------------------
# "오늘의 곡"으로 뽑힐 때마다 그 곡의 요소별 정규화 값(features)을 노출 이력에
# 남겨두고, 이후 그 곡을 얼마나 들었는지 / 평점이 어땠는지를 "결과"로 삼아 선형
# 회귀(배치 경사하강)로 가중치를 다시 맞춘다. 자세한 결과 점수 계산은
# _track_outcome 참고.
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

FEATURE_LABELS: dict[str, str] = {
    "rating": "평점",
    "artist": "아티스트",
    "album": "앨범",
    "never_played": "미청취",
    "explicit": "명시적 관심",
    "freshness": "신선도",
}

# 아티스트/앨범 선호도는 과거 재생을 전부 동일하게 취급하지 않고, 이 기간(일)마다
# 절반씩 영향력이 줄어드는 지수 감쇠를 적용한다 — 예전엔 좋아했지만 요즘 안 듣는
# 아티스트가 계속 1순위로 뽑히는 것을 막는다.
AFFINITY_HALF_LIFE_DAYS = 30.0

# 같은 곡이 몇 번 연속 추천되고도 안 들리면 freshness가 0으로 수렴하는 기준.
FATIGUE_EXPOSURE_CAP = 5

# 한 배치 안에서 이미 뽑힌 곡과 아티스트/앨범이 같으면, 다음 뽑기 확률에 이 값을
# 거듭제곱으로 곱해 서서히 낮춘다(완전히 배제하지는 않음 — 좋아하는 아티스트가
# 여러 곡 뽑히는 것 자체는 자연스럽다).
DIVERSITY_ARTIST_PENALTY = 0.5
DIVERSITY_ALBUM_PENALTY = 0.6

# 그래프용 가중치 이력은 새로고침(다시 뽑기 포함)마다 한 점씩 쌓인다. 무한정
# 늘어나지 않도록 최근 N개만 남긴다.
MAX_WEIGHT_HISTORY = 500


def clamp_weight(value: float) -> float:
    return min(WEIGHT_MAX, max(WEIGHT_MIN, value))


def _play_counts(history: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in history:
        track_id = entry.get("track_id")
        if not track_id:
            continue
        counts[track_id] = counts.get(track_id, 0) + 1
    return counts


def _affinity_by(
    history: list[dict[str, Any]], key: str, *, now: datetime | None = None, split: bool = False
) -> dict[str, float]:
    """아티스트/앨범별 선호도. 재생일이 오래될수록 AFFINITY_HALF_LIFE_DAYS마다
    영향력이 절반으로 줄어드는 지수 감쇠를 적용해, 최근 취향 변화를 더 잘 따라간다.
    split=True(아티스트 전용)면 "A, B"처럼 쉼표로 묶인 값을 여러 이름으로 나눠
    각각에 같은 가중치를 더한다(한 곡에 아티스트가 여럿이어도 개별로 선호도가 쌓이게)."""
    now = now or datetime.now()
    counts: dict[str, float] = {}
    for entry in history:
        value = entry.get(key)
        if not value:
            continue
        weight = 1.0
        played_at = entry.get("played_at")
        if played_at:
            try:
                days_ago = (now - datetime.fromisoformat(played_at)).total_seconds() / 86400
                weight = 0.5 ** (days_ago / AFFINITY_HALF_LIFE_DAYS)
            except ValueError:
                pass
        names = list(dict.fromkeys(split_artists(value))) if split else [value]
        for name in names:
            counts[name] = counts.get(name, 0.0) + weight
    return counts


def _median(values: list[int]) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _last_played_at_by_track(history: list[dict[str, Any]]) -> dict[str, str]:
    last: dict[str, str] = {}
    for entry in history:
        track_id = entry.get("track_id")
        played_at = entry.get("played_at") or ""
        if not track_id:
            continue
        if played_at > last.get(track_id, ""):
            last[track_id] = played_at
    return last


def _fatigue_counts(exposures: list[dict[str, Any]], last_played_at_by_track: dict[str, str]) -> dict[str, int]:
    """마지막 재생 이후(한 번도 안 들었다면 전체 이력 중) 연속으로 노출된 횟수.
    계속 추천만 되고 안 들리는 곡을 서서히 후순위로 미루는 freshness 피처의 기반."""
    counts: dict[str, int] = {}
    for exp in exposures:
        track_id = exp.get("track_id")
        if not track_id:
            continue
        logged_at = exp.get("logged_at") or ""
        if logged_at <= last_played_at_by_track.get(track_id, ""):
            continue
        counts[track_id] = counts.get(track_id, 0) + 1
    return counts


def _explicit_track_ids() -> set[str]:
    """전체 라이브러리가 아니라 사용자가 직접 만든 재생목록에 담아둔 곡 = 확실한
    관심 신호로 취급한다(has_lyrics — 가사를 직접 저장해둔 곡 — 와 함께 explicit
    피처를 이룬다)."""
    ids: set[str] = set()
    for name, path in PlaylistModel.list_saved_names():
        if name == GLOBAL_PLAYLIST_NAME:
            continue
        try:
            playlist = PlaylistModel.load(path)
        except (OSError, ValueError):
            continue
        for track in playlist.tracks:
            ids.add(storage.path_hash(track.path))
    return ids


def _track_outcome(
    track_id: str,
    exposed_at: str,
    history: list[dict[str, Any]],
    rating_by_track: dict[str, float],
    duration_by_track: dict[str, int],
) -> float:
    """추천된 시점(exposed_at) 이후 실제로 얼마나 들었는지(완주율 — 재생 판정
    기준만 턱걸이로 넘겼는지 vs 끝까지 들었는지)와 평점을 섞어 0~1 사이 "결과
    점수"를 만든다. 평점을 아직 안 매겼으면(0) 평점은 배제하고 완주율만 본다 —
    반대로 평점을 매겼는데 낮으면, 재생 여부와 무관하게 명확한 부정 신호로
    취급해서(과거엔 재생만 됐으면 결과 점수가 무조건 올라가던 문제를 고친다)
    완주율에 반영하지 않고 별도로 섞는다."""
    plays_after = [
        entry
        for entry in history
        if entry.get("track_id") == track_id and (entry.get("played_at") or "") > exposed_at
    ]
    if plays_after:
        duration = duration_by_track.get(track_id) or 0
        best_listened_ms = max(entry.get("listened_ms") or 0 for entry in plays_after)
        play_score = min(1.0, best_listened_ms / duration) if duration > 0 else 1.0
    else:
        play_score = 0.0

    rating = rating_by_track.get(track_id) or 0
    if rating <= 0:
        return play_score
    # 1점(최저)을 0, 5점(최고)을 1로 매핑 — 낮은 평점일수록 결과 점수를 확실히 깎는다.
    rating_score = (rating - 1) / 4
    return max(0.0, min(1.0, OUTCOME_PLAY_WEIGHT * play_score + OUTCOME_RATING_WEIGHT * rating_score))


def _learn_weights(
    exposures: list[dict[str, Any]],
    history: list[dict[str, Any]],
    rating_by_track: dict[str, float],
    duration_by_track: dict[str, int],
) -> dict[str, float]:
    """과거 노출 로그 + 실제 재생/평점 결과로 요소별 가중치를 배치 경사하강으로
    다시 맞춘다. 표본이 부족하면(콜드 스타트) 기본 가중치를 그대로 돌려준다."""
    recent = exposures[-MAX_EXPOSURES_FOR_LEARNING:]
    if len(recent) < MIN_EXPOSURES_TO_LEARN:
        return dict(DEFAULT_WEIGHTS)

    samples = [
        (
            exp.get("features") or {},
            _track_outcome(exp.get("track_id"), exp.get("logged_at") or "", history, rating_by_track, duration_by_track),
        )
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


def resolve_weights(
    history: list[dict[str, Any]],
    rating_by_track: dict[str, float],
    duration_by_track: dict[str, int],
    manual_weights: dict[str, float] | None,
    exposures: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, float], str]:
    """manual_weights가 주어지면(수동 모드) 그 값을 범위 안으로 clamp해서 그대로
    쓰고, 아니면(자동 모드) 노출 이력으로 학습한 가중치를 쓴다. 어느 쪽을
    썼는지("manual"/"auto")도 같이 돌려줘서 그래프/UI에 표시할 수 있게 한다."""
    if manual_weights:
        weights = {
            k: clamp_weight(float(manual_weights.get(k, DEFAULT_WEIGHTS[k]))) for k in FEATURE_KEYS
        }
        return weights, "manual"
    if exposures is None:
        exposures = storage.load_recommend_exposures()
    weights = _learn_weights(exposures, history, rating_by_track, duration_by_track)
    return weights, "auto"


def _record_weight_history(weights: dict[str, float], source: str) -> None:
    """이번에 실제로 쓰인 가중치를 이력에 남긴다 — 새로고침/다시 뽑기마다 한
    점씩 쌓여서 "가중치가 시간에 따라 어떻게 바뀌었는지" 그래프로 볼 수 있다."""
    history = storage.load_recommend_weight_history()
    history.append(
        {
            "logged_at": datetime.now().isoformat(timespec="seconds"),
            "weights": weights,
            "source": source,
        }
    )
    storage.save_recommend_weight_history(history[-MAX_WEIGHT_HISTORY:])


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
    artist_affinity = _affinity_by(history, "artist", split=True)
    album_affinity = _affinity_by(history, "album")
    max_artist = max(artist_affinity.values(), default=0) or 1
    max_album = max(album_affinity.values(), default=0) or 1
    rating_by_track = {t.get("track_id"): t.get("rating") or 0 for t in tracks}
    duration_by_track = {t.get("track_id"): t.get("duration_ms") or 0 for t in tracks}
    exposures = storage.load_recommend_exposures()
    fatigue_counts = _fatigue_counts(exposures, _last_played_at_by_track(history))
    explicit_ids = _explicit_track_ids()

    today = date.today().isoformat()
    config = storage.load_recommend_config()
    manual_weights = config.get("manual_weights") if config.get("mode") == "manual" else None
    weights, source = resolve_weights(history, rating_by_track, duration_by_track, manual_weights, exposures)
    # 자동 모드든 수동 모드든, 이번 추천에 실제로 쓰인 가중치를 매 호출(새로고침/
    # 다시 뽑기 포함)마다 이력에 남겨 그래프로 추적할 수 있게 한다.
    _record_weight_history(weights, source)

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

    def artist_affinity_score(track_artist: str) -> float:
        # 아티스트가 여럿(쉼표 구분)이면 각자의 선호도 평균을 쓴다 — 공동 작업곡이
        # 유명 아티스트 한 명 덕에 과대평가되지 않게.
        names = split_artists(track_artist)
        if not names:
            return 0.0
        return sum(artist_affinity.get(name, 0) for name in names) / len(names) / max_artist

    def features(track: dict[str, Any]) -> dict[str, float]:
        track_id = track.get("track_id") or ""
        pc = play_counts.get(track_id, 0)
        fatigue = fatigue_counts.get(track_id, 0)
        is_explicit = bool(track.get("has_lyrics")) or track_id in explicit_ids
        return {
            "rating": (track.get("rating") or 0) / 5,
            "artist": artist_affinity_score(track.get("artist") or ""),
            "album": album_affinity.get(track.get("album") or "", 0) / max_album,
            "never_played": 1.0 if pc == 0 else 0.0,
            "explicit": 1.0 if is_explicit else 0.0,
            "freshness": 1.0 - min(fatigue, FATIGUE_EXPOSURE_CAP) / FATIGUE_EXPOSURE_CAP,
        }

    feats_by_id = {t["track_id"]: features(t) for t in candidates}

    def score(track: dict[str, Any]) -> float:
        feats = feats_by_id[track["track_id"]]
        return BASE_SCORE + sum(weights[k] * feats.get(k, 0.0) for k in FEATURE_KEYS)

    rng = random.Random(seed if seed is not None else today)

    pool = list(candidates)
    score_by_id = {t["track_id"]: max(0.01, score(t)) for t in pool}
    picked: list[dict[str, Any]] = []
    # 같은 배치 안에서 이미 뽑힌 아티스트/앨범이 다시 뽑힐 확률을 점점 낮춰서
    # (완전히 배제하지는 않고) 하루 추천이 한두 아티스트로 쏠리는 것을 완화한다.
    picked_artist_counts: dict[str, int] = {}
    picked_album_counts: dict[str, int] = {}
    n = min(limit, len(pool))
    for _ in range(n):
        current_weights = []
        for t in pool:
            w = score_by_id[t["track_id"]]
            # 아티스트가 여럿이면 이미 뽑힌 곡과 하나라도 겹칠 때마다 페널티를 곱한다.
            for name in split_artists(t.get("artist") or ""):
                w *= DIVERSITY_ARTIST_PENALTY ** picked_artist_counts.get(name, 0)
            w *= DIVERSITY_ALBUM_PENALTY ** picked_album_counts.get(t.get("album") or "", 0)
            current_weights.append(max(0.001, w))
        chosen = rng.choices(pool, weights=current_weights, k=1)[0]
        picked.append(chosen)
        pool.remove(chosen)
        for name in list(dict.fromkeys(split_artists(chosen.get("artist") or ""))):
            picked_artist_counts[name] = picked_artist_counts.get(name, 0) + 1
        album = chosen.get("album") or ""
        if album:
            picked_album_counts[album] = picked_album_counts.get(album, 0) + 1

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
