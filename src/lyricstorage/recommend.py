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

from lyricstorage import albums as albums_repo
from lyricstorage import artists as artists_repo
from lyricstorage import circles as circles_repo
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


def _prepare_scoring(tracks: list[dict[str, Any]]) -> dict[str, Any]:
    """pick_today_songs와 pick_queue_songs가 공유하는 준비 단계: 재생 기록 기반
    통계(재생 횟수, 아티스트/앨범 선호도, 피로도, 명시적 관심)와 학습된(또는 수동)
    가중치를 계산하고, 곡 하나를 넣으면 피처/점수를 돌려주는 함수를 만들어 돌려준다."""
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

    config = storage.load_recommend_config()
    manual_weights = config.get("manual_weights") if config.get("mode") == "manual" else None
    weights, source = resolve_weights(history, rating_by_track, duration_by_track, manual_weights, exposures)

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

    def score(feats: dict[str, float]) -> float:
        return BASE_SCORE + sum(weights[k] * feats.get(k, 0.0) for k in FEATURE_KEYS)

    return {
        "history": history,
        "play_counts": play_counts,
        "weights": weights,
        "source": source,
        "features": features,
        "score": score,
    }


def _weighted_pick_batch(
    pool: list[dict[str, Any]],
    score_by_id: dict[str, float],
    n: int,
    rng: random.Random,
    picked_artist_counts: dict[str, int],
    picked_album_counts: dict[str, int],
) -> list[dict[str, Any]]:
    """pool에서 score_by_id 가중치 기반으로 최대 n개를 가중 무작위로 뽑는다. 같은
    배치(및 호출자가 이어서 넘긴 picked_*_counts) 안에서 이미 뽑힌 아티스트/앨범과
    겹치면 다양성 페널티를 곱해 확률을 점점 낮춘다(완전히 배제하지는 않음).
    picked_artist_counts/picked_album_counts는 그 자리에서 갱신되므로, 여러 단계에
    걸쳐 같은 딕셔너리를 넘기면 단계를 넘나들며 다양성이 유지된다."""
    pool = list(pool)
    picked: list[dict[str, Any]] = []
    n = min(n, len(pool))
    for _ in range(n):
        current_weights = []
        for t in pool:
            w = score_by_id[t["track_id"]]
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
    return picked


def pick_today_songs(
    tracks: list[dict[str, Any]],
    *,
    limit: int = DEFAULT_LIMIT,
    seed: str | None = None,
    record_exposure: bool = True,
    record_weights: bool = True,
) -> list[dict[str, Any]]:
    """tracks: track_to_json() 결과 리스트. seed가 없으면 오늘 날짜로 고정되어
    하루 동안은 같은 결과를 준다(이름 그대로 '오늘의 곡'). record_exposure가
    참이면 이 추천 결과를 학습용 노출 로그에 남긴다(재뽑기 요청에는 꺼서, 임시로
    다시 뽑아본 결과가 '공식' 추천으로 학습되지 않게 한다). record_weights도 거짓이면
    가중치 변화 그래프에도 이번 호출을 남기지 않는다 — 홈 화면 "빠른 선곡"처럼
    화면을 열 때마다 조용히 미리보기만 가져오는 호출이 그래프를 도배하지 않게 한다."""
    if not tracks:
        return []

    ctx = _prepare_scoring(tracks)
    play_counts = ctx["play_counts"]
    weights, source = ctx["weights"], ctx["source"]
    # 자동 모드든 수동 모드든, 이번 추천에 실제로 쓰인 가중치를 매 호출(새로고침/
    # 다시 뽑기 포함)마다 이력에 남겨 그래프로 추적할 수 있게 한다.
    if record_weights:
        _record_weight_history(weights, source)

    today = date.today().isoformat()
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

    feats_by_id = {t["track_id"]: ctx["features"](t) for t in candidates}
    score_by_id = {tid: max(0.01, ctx["score"](feats)) for tid, feats in feats_by_id.items()}

    rng = random.Random(seed if seed is not None else today)
    picked = _weighted_pick_batch(candidates, score_by_id, limit, rng, {}, {})

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


# -- 자동 생성 플레이리스트 -----------------------------------------------------
# 홈 화면 "빠른 선곡" 아래에서, 사이드바에는 노출되지 않는(저장되지도 않는)
# 테마별 플레이리스트를 보여준다. 현재 라이브러리 + 재생 기록만으로 매 요청마다
# 즉석 계산되는 가상 목록이라, 곡이 추가/삭제되거나 새로 재생될 때마다 저절로
# 최신 상태를 반영한다(별도 저장/무효화 로직이 필요 없다).

AUTO_PLAYLIST_MIN_PLAYS = 2  # 아티스트/서클 테마는 이만큼은 들어야 의미가 있다고 보고 후보에 넣는다
AUTO_PLAYLIST_MAX_PER_KIND = 3  # 아티스트/서클 테마는 최대 이 개수까지만 보여준다(취향 상위 몇 명)
AUTO_PLAYLIST_MAX_TOTAL = 8  # 홈 화면 카드 전체 개수 상한 — 서클/아티스트가 아무리 많아도 이 이상 나열하지 않는다
AUTO_PLAYLIST_TRACK_CAP = 20  # 테마 하나에 담기는 곡 수 상한(임시 조치 — 추후 조정 예정)
AUTO_PLAYLIST_CANDIDATE_CAP = AUTO_PLAYLIST_TRACK_CAP * 3  # "자주 듣는 곡"은 이 개수만큼 상위 후보를 추린 뒤 그 안에서만 무작위로 뽑는다


def _auto_playlist_context(tracks: list[dict[str, Any]]) -> dict[str, Any]:
    """list_auto_playlists()/get_auto_playlist()가 공유하는 준비 단계. 아티스트/
    서클별 트랙 목록(pool)은 여기서 만들지 않는다 — 카드 목록엔 몇 곡인지 보여줄
    필요가 없어졌으니(홈 화면은 순위만 알면 됨), 실제 트랙 목록은 사용자가 카드를
    눌러 get_auto_playlist를 부를 때만 그 테마 하나에 대해서만 계산한다."""
    play_counts = _play_counts(storage.load_play_history())
    artist_resolver = artists_repo.name_resolver()
    circle_resolver = circles_repo.name_resolver()
    circle_by_album_id = {a.id: a.artist for a in albums_repo.load_albums() if a.artist}

    def play_count(track: dict[str, Any]) -> int:
        return play_counts.get(track.get("track_id") or "", 0)

    def artist_names(track: dict[str, Any]) -> list[str]:
        raw = split_artists(track.get("artist") or "")
        return list(dict.fromkeys(artist_resolver.get(n, n) for n in raw))

    def circle_name(track: dict[str, Any]) -> str | None:
        raw = circle_by_album_id.get(track.get("album_id") or "")
        return circle_resolver.get(raw, raw) if raw else None

    has_unheard = False
    has_frequent = False
    artist_totals: dict[str, int] = {}
    circle_totals: dict[str, int] = {}
    # 홈 화면 카드에 앨범 커버를 보여주기 위한, 아티스트/서클별 대표 곡 하나.
    artist_sample_track: dict[str, str] = {}
    circle_sample_track: dict[str, str] = {}
    for t in tracks:
        pc = play_count(t)
        if pc == 0:
            has_unheard = True
            continue
        has_frequent = True
        track_id = t.get("track_id") or ""
        for name in artist_names(t):
            artist_totals[name] = artist_totals.get(name, 0) + pc
            artist_sample_track.setdefault(name, track_id)
        c_name = circle_name(t)
        if c_name:
            circle_totals[c_name] = circle_totals.get(c_name, 0) + pc
            circle_sample_track.setdefault(c_name, track_id)

    all_circle_names = {circle_resolver.get(raw, raw) for raw in circle_by_album_id.values()}

    return {
        "play_count": play_count,
        "artist_names": artist_names,
        "circle_name": circle_name,
        "has_unheard": has_unheard,
        "has_frequent": has_frequent,
        "artist_totals": artist_totals,
        "circle_totals": circle_totals,
        "all_circle_names": all_circle_names,
        "artist_sample_track": artist_sample_track,
        "circle_sample_track": circle_sample_track,
    }


def list_auto_playlists(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """홈 화면 카드 나열용 — {id, title}만. 실제 트랙 목록/개수는 카드를 눌러
    get_auto_playlist를 부를 때 계산한다."""
    if not tracks:
        return []
    ctx = _auto_playlist_context(tracks)
    themes: list[dict[str, Any]] = []

    if ctx["has_unheard"]:
        themes.append({"id": "unheard", "title": "안 들어본 곡"})
    if ctx["has_frequent"]:
        themes.append({"id": "frequent", "title": "자주 듣는 곡"})

    # 아티스트/서클 후보가 늘 몇 명(재생 횟수 상위)으로 고정되지 않도록, 기준을
    # 넘는 후보 전체 중에서 이번엔 누구를 보여줄지 매번 무작위로 뽑는다.
    # 서클명과 이름이 같은 아티스트는 별도 아티스트 테마를 만들지 않는다 — 서클
    # 테마가 사실상 동일한 곡을 이미 대표하므로 카드가 중복된다.
    artist_candidates = [
        name
        for name, total in ctx["artist_totals"].items()
        if total >= AUTO_PLAYLIST_MIN_PLAYS and name not in ctx["all_circle_names"]
    ]
    random.shuffle(artist_candidates)
    for name in artist_candidates[:AUTO_PLAYLIST_MAX_PER_KIND]:
        themes.append(
            {
                "id": f"artist:{name}",
                "title": f"아티스트 · {name}",
                "track_id": ctx["artist_sample_track"].get(name),
            }
        )

    circle_candidates = [name for name, total in ctx["circle_totals"].items() if total >= AUTO_PLAYLIST_MIN_PLAYS]
    random.shuffle(circle_candidates)
    for name in circle_candidates[:AUTO_PLAYLIST_MAX_PER_KIND]:
        themes.append(
            {
                "id": f"circle:{name}",
                "title": f"서클 · {name}",
                "track_id": ctx["circle_sample_track"].get(name),
            }
        )

    return themes[:AUTO_PLAYLIST_MAX_TOTAL]


def get_auto_playlist(auto_id: str, tracks: list[dict[str, Any]]) -> dict[str, Any] | None:
    """카드를 눌러 미리보기/재생/저장할 때만 그 테마 하나의 실제 트랙 목록을 계산한다."""
    if not tracks:
        return None
    kind, _, key = auto_id.partition(":")
    ctx = _auto_playlist_context(tracks)

    if kind == "unheard":
        pool = [t for t in tracks if ctx["play_count"](t) == 0]
        title = "안 들어본 곡"
    elif kind == "frequent":
        # 순위(재생 횟수)는 후보를 추리는 데만 쓰고, 그 후보 안에서는 무작위로 뽑아
        # 매번 다른 구성/순서가 나오게 한다.
        ranked = sorted((t for t in tracks if ctx["play_count"](t) > 0), key=ctx["play_count"], reverse=True)
        pool = ranked[:AUTO_PLAYLIST_CANDIDATE_CAP]
        title = "자주 듣는 곡"
    elif kind == "artist" and key:
        pool = [t for t in tracks if key in ctx["artist_names"](t)]
        title = f"아티스트 · {key}"
    elif kind == "circle" and key:
        pool = [t for t in tracks if ctx["circle_name"](t) == key]
        title = f"서클 · {key}"
    else:
        return None

    if not pool:
        return None
    random.shuffle(pool)
    return {"id": auto_id, "title": title, "tracks": pool[:AUTO_PLAYLIST_TRACK_CAP]}


# -- 재생 대기 목록(큐) -------------------------------------------------------
# 홈 화면 "다시 듣기"/"빠른 선곡"에서 재생을 시작하면, 클릭한 곡을 시드로 삼아
# 라디오처럼 계속 이어지는 재생 대기 목록을 만든다. "오늘의 곡"과 알고리즘 기반은
# 같지만(취향 신호 + 가중 무작위 + 다양성 페널티), 시드 곡과의 관련성(같은
# 아티스트/앨범, 시드 곡 바로 다음에 자주 이어 들은 곡)을 추가로 반영하고, 노출/
# 가중치 학습 이력은 전혀 남기지 않는다 — 하루짜리 '공식' 추천이 아니라 재생
# 흐름을 따라 계속 늘어나는 큐일 뿐이기 때문이다.

SESSION_GAP_SECONDS = 20 * 60

QUEUE_SEED_ARTIST_BONUS = 0.25
QUEUE_SEED_ALBUM_BONUS = 0.2
QUEUE_FOLLOWUP_BONUS = 0.5


def _next_track_counts(history: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """각 곡 바로 다음에 실제로 이어 재생된 곡의 횟수. 재생 기록을 시간순으로
    정렬한 뒤, 인접한 두 기록의 간격이 SESSION_GAP_SECONDS 이내면 '이어 들었다'고
    보고 센다 — 며칠 뒤 우연히 같은 순서로 재생된 것까지 이어듣기로 잡히지 않게."""
    ordered = sorted(
        (e for e in history if e.get("track_id") and e.get("played_at")),
        key=lambda e: e["played_at"],
    )
    counts: dict[str, dict[str, float]] = {}
    for prev, curr in zip(ordered, ordered[1:]):
        prev_id, curr_id = prev["track_id"], curr["track_id"]
        if prev_id == curr_id:
            continue
        try:
            gap = (
                datetime.fromisoformat(curr["played_at"]) - datetime.fromisoformat(prev["played_at"])
            ).total_seconds()
        except ValueError:
            continue
        if not (0 <= gap <= SESSION_GAP_SECONDS):
            continue
        bucket = counts.setdefault(prev_id, {})
        bucket[curr_id] = bucket.get(curr_id, 0.0) + 1.0
    return counts


def pick_queue_songs(
    tracks: list[dict[str, Any]],
    *,
    seed_track_id: str,
    exclude_ids: set[str] | None = None,
    count: int,
    familiar_count: int = 0,
) -> list[dict[str, Any]]:
    """재생 대기 목록을 채울 곡을 고른다. 앞쪽 familiar_count개는 이미 들어본 곡 중
    시드 곡과 아티스트/앨범이 겹치거나 시드 곡 바로 다음에 자주 이어 들은 곡을
    우대하고, 나머지(count - familiar_count)개는 안 들어본 곡 위주로 고른다.
    count=1, familiar_count=0으로 부르면 그대로 '다음 한 곡 추가'(큐 확장) 요청이
    된다 — 초기 배치와 확장 호출이 이 함수 하나를 공유한다."""
    exclude = set(exclude_ids or ())
    exclude.add(seed_track_id)
    pool = [t for t in tracks if (t.get("track_id") or "") not in exclude]
    if not pool:
        return []

    ctx = _prepare_scoring(tracks)
    play_counts = ctx["play_counts"]
    feats_by_id = {t["track_id"]: ctx["features"](t) for t in pool}
    score_by_id = {tid: max(0.01, ctx["score"](feats)) for tid, feats in feats_by_id.items()}

    seed_track = next((t for t in tracks if t.get("track_id") == seed_track_id), None)
    rng = random.Random()
    picked_artist_counts: dict[str, int] = {}
    picked_album_counts: dict[str, int] = {}
    picked: list[dict[str, Any]] = []

    if familiar_count > 0 and seed_track is not None:
        followup = _next_track_counts(ctx["history"]).get(seed_track_id, {})
        followup_total = sum(followup.values()) or 1
        seed_artists = set(split_artists(seed_track.get("artist") or ""))
        seed_album = seed_track.get("album") or ""

        familiar_pool = [t for t in pool if play_counts.get(t.get("track_id") or "", 0) > 0] or pool
        familiar_score_by_id = dict(score_by_id)
        for t in familiar_pool:
            tid = t.get("track_id") or ""
            bonus = 0.0
            if seed_artists & set(split_artists(t.get("artist") or "")):
                bonus += QUEUE_SEED_ARTIST_BONUS
            if seed_album and t.get("album") == seed_album:
                bonus += QUEUE_SEED_ALBUM_BONUS
            bonus += QUEUE_FOLLOWUP_BONUS * (followup.get(tid, 0.0) / followup_total)
            familiar_score_by_id[tid] = familiar_score_by_id.get(tid, 0.01) + bonus

        picked.extend(
            _weighted_pick_batch(
                familiar_pool, familiar_score_by_id, familiar_count, rng, picked_artist_counts, picked_album_counts
            )
        )

    picked_ids = {t.get("track_id") for t in picked}
    remaining = [t for t in pool if t.get("track_id") not in picked_ids]
    unheard_pool = [t for t in remaining if play_counts.get(t.get("track_id") or "", 0) == 0] or remaining
    picked.extend(
        _weighted_pick_batch(
            unheard_pool, score_by_id, count - len(picked), rng, picked_artist_counts, picked_album_counts
        )
    )

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
