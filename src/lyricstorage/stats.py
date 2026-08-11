"""재생 이력 기록 및 기간별 통계 집계."""

from __future__ import annotations

import random
from datetime import datetime, timedelta
from typing import Any

from lyricstorage import albums as albums_repo
from lyricstorage import artists as artists_repo
from lyricstorage import storage

PERIODS = {"day", "week", "month"}
GROUPS = {"track", "artist", "album"}


def split_artists(artist: str) -> list[str]:
    """곡 아티스트 문자열을 쉼표로 나눠 여러 아티스트로 분리한다(예: "A, B" -> ["A", "B"])."""
    return [part.strip() for part in (artist or "").split(",") if part.strip()]


def log_play(
    track_id: str,
    title: str,
    artist: str,
    album: str,
    *,
    listened_ms: int = 0,
    when: datetime | None = None,
) -> dict[str, Any]:
    entry = {
        "track_id": track_id,
        "title": title,
        "artist": artist,
        "album": album,
        "listened_ms": listened_ms,
        "played_at": (when or datetime.now()).isoformat(timespec="seconds"),
    }
    storage.append_play_history(entry)
    return entry


def _period_bounds(period: str, offset: int, *, now: datetime | None = None) -> tuple[datetime, datetime]:
    now = now or datetime.now()
    if period == "day":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=offset)
        end = start + timedelta(days=1)
    elif period == "week":
        today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        monday = today - timedelta(days=today.weekday())
        start = monday - timedelta(weeks=offset)
        end = start + timedelta(days=7)
    elif period == "month":
        total_months = now.year * 12 + (now.month - 1) - offset
        year, month = divmod(total_months, 12)
        month += 1
        start = datetime(year, month, 1)
        end = datetime(year + 1, 1, 1) if month == 12 else datetime(year, month + 1, 1)
    else:
        raise ValueError(f"unknown period: {period}")
    return start, end


# recent_tracks()가 무작위로 뽑을 "최근 재생" 후보 풀의 크기 기준.
POOL_MULTIPLIER = 3
MIN_RECENT_POOL = 24


def recent_tracks(limit: int = 12, tracks: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """최근에 재생한 곡 중 곡별로 한 번씩만 중복 없이 골라 돌려준다(홈 화면
    "다시 듣기" 카드용). 최신순 상위 limit개를 그대로 고정해서 보여주는 대신,
    조금 더 넓은 최근 재생 풀(POOL_MULTIPLIER배)에서 무작위로 뽑아 매번 볼
    때마다(새로고침 등) 구성이 조금씩 바뀌게 한다. 라이브러리에서 이미 지워진
    곡은 다시 재생할 수 없으니 건너뛴다."""
    pool_size = max(limit * POOL_MULTIPLIER, MIN_RECENT_POOL)
    current_by_id = {t.get("track_id"): t for t in (tracks or [])}
    seen: set[str] = set()
    pool: list[dict[str, Any]] = []
    for entry in storage.iter_play_history_desc():
        track_id = entry.get("track_id")
        if not track_id or track_id in seen:
            continue
        seen.add(track_id)
        live = current_by_id.get(track_id)
        if not live:
            continue
        pool.append(
            {
                "track_id": track_id,
                "title": live.get("title") or entry.get("title") or "",
                "artist": live.get("artist") or entry.get("artist") or "",
                "album": live.get("album") or entry.get("album") or "",
                "album_id": live.get("album_id"),
                "played_at": entry.get("played_at"),
            }
        )
        if len(pool) >= pool_size:
            break
    return random.sample(pool, min(limit, len(pool)))


def track_totals(track_id: str, period: str = "all", offset: int = 0) -> dict[str, Any]:
    """트랙 하나의 누적 재생 횟수/감상 시간. period가 "all"이면 전체 기간, 아니면
    (day/week/month) 해당 구간만."""
    if period == "all":
        history = storage.load_play_history()
    else:
        start, end = _period_bounds(period, offset)
        history = storage.load_play_history_range(start, end)
    count = 0
    listened_ms = 0
    for entry in history:
        if entry.get("track_id") == track_id:
            count += 1
            listened_ms += entry.get("listened_ms") or 0
    return {"track_id": track_id, "count": count, "listened_ms": listened_ms}


def top(
    period: str,
    group: str,
    offset: int = 0,
    limit: int | None = 20,
    tracks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """tracks: track_to_json() 결과 리스트(현재 라이브러리). 넘겨주면 재생 기록의
    title/artist/album을 그 당시 스냅샷 대신 track_id로 찾은 현재 값으로 보여준다
    — 그래야 재생 후 곡/앨범/아티스트 이름을 바꿔도 과거 기록이 예전 이름 기준으로
    따로 집계되지 않는다. 트랙이 나중에 삭제됐으면(track_id를 못 찾으면) 기록에
    남은 스냅샷으로 대체한다."""
    if period not in PERIODS:
        raise ValueError(f"unknown period: {period}")
    if group not in GROUPS:
        raise ValueError(f"unknown group: {group}")

    start, end = _period_bounds(period, offset)
    history = storage.load_play_history_range(start, end)
    current_by_id = {t.get("track_id"): t for t in (tracks or [])}
    # 이명(별칭)으로 등록된 아티스트는 대표 이름으로 묶어서 집계한다.
    artist_resolver = artists_repo.name_resolver() if group == "artist" else {}

    buckets: dict[Any, dict[str, Any]] = {}
    for entry in history:
        try:
            datetime.fromisoformat(entry["played_at"])
        except (KeyError, TypeError, ValueError):
            continue

        live = current_by_id.get(entry.get("track_id"))
        title = (live.get("title") if live else None) or entry.get("title") or ""
        artist = (live.get("artist") if live else None) or entry.get("artist") or ""
        album = (live.get("album") if live else None) or entry.get("album") or ""
        album_id = live.get("album_id") if live else None
        listened_ms = entry.get("listened_ms") or 0
        played_at_str = entry["played_at"]

        def bump(bucket: dict[str, Any]) -> None:
            bucket["count"] += 1
            bucket["listened_ms"] += listened_ms
            if played_at_str > bucket["last_played_at"]:
                bucket["last_played_at"] = played_at_str

        if group == "track":
            key = entry.get("track_id")
            bucket = buckets.setdefault(
                key,
                {
                    "track_id": key,
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "count": 0,
                    "listened_ms": 0,
                    "last_played_at": played_at_str,
                },
            )
            bucket["title"] = title
            bucket["artist"] = artist
            bucket["album"] = album
            bump(bucket)
        elif group == "artist":
            # 한 곡에 아티스트가 여럿(쉼표 구분)이면 각 아티스트에게 개별로 집계하되,
            # 이명이 등록된 이름은 대표 이름으로 바꿔서 같은 사람으로 묶는다.
            raw_names = list(dict.fromkeys(split_artists(artist))) or ["(아티스트 없음)"]
            names = list(dict.fromkeys(artist_resolver.get(n, n) for n in raw_names))
            for name in names:
                bucket = buckets.setdefault(
                    name, {"artist": name, "count": 0, "listened_ms": 0, "last_played_at": played_at_str}
                )
                bump(bucket)
        else:  # album
            album_label = album or "(앨범 없음)"
            # 아직 라이브러리에 있는 트랙이면 album_id(불변)로 묶어서, 앨범명을
            # 바꿔도 예전 기록과 새 기록이 갈라지지 않게 한다. 트랙이 삭제됐으면
            # (album_id를 모르면) 예전처럼 이름 조합으로만 묶는다.
            key = album_id or (album_label, artist)
            bucket = buckets.setdefault(
                key,
                {
                    "album": album_label,
                    "artist": artist,
                    "track_id": entry.get("track_id"),
                    "album_id": album_id,
                    "count": 0,
                    "listened_ms": 0,
                    "last_played_at": played_at_str,
                },
            )
            bucket["album"] = album_label
            bucket["artist"] = artist
            bump(bucket)

    # "곡" 그룹은 재생 횟수가 많은 순으로 보여주되, 횟수가 같으면 최근에 들은 곡을 먼저 보여준다.
    sort_key = (lambda b: (b["count"], b["last_played_at"])) if group == "track" else (lambda b: b["count"])
    items = sorted(buckets.values(), key=sort_key, reverse=True)
    if limit is not None:
        items = items[:limit]
    if group == "album":
        # 위에서 album_id를 이미 못 채운 항목만(=삭제된 트랙 기반) 이름으로 다시
        # 찾아본다 — 앨범이 이름 변경/삭제됐으면 못 찾을 수 있고, 그때는 표지 없이 보여준다.
        for item in items:
            if item.get("album_id"):
                continue
            album = albums_repo.find_album_by_name(item["album"])
            item["album_id"] = album.id if album else None
    return {
        "period": period,
        "group": group,
        "offset": offset,
        "range_start": start.isoformat(timespec="seconds"),
        "range_end": end.isoformat(timespec="seconds"),
        "items": items,
    }
