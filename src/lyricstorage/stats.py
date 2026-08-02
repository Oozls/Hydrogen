"""재생 이력 기록 및 기간별 통계 집계."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from lyricstorage import albums as albums_repo
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
    history = storage.load_play_history()
    history.append(entry)
    storage.save_play_history(history)
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


def top(period: str, group: str, offset: int = 0, limit: int | None = 20) -> dict[str, Any]:
    if period not in PERIODS:
        raise ValueError(f"unknown period: {period}")
    if group not in GROUPS:
        raise ValueError(f"unknown group: {group}")

    start, end = _period_bounds(period, offset)
    history = storage.load_play_history()

    buckets: dict[Any, dict[str, Any]] = {}
    for entry in history:
        try:
            played_at = datetime.fromisoformat(entry["played_at"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (start <= played_at < end):
            continue

        title = entry.get("title") or ""
        artist = entry.get("artist") or ""
        album = entry.get("album") or ""
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
            # 한 곡에 아티스트가 여럿(쉼표 구분)이면 각 아티스트에게 개별로 집계한다.
            names = list(dict.fromkeys(split_artists(artist))) or ["(아티스트 없음)"]
            for name in names:
                bucket = buckets.setdefault(
                    name, {"artist": name, "count": 0, "listened_ms": 0, "last_played_at": played_at_str}
                )
                bump(bucket)
        else:  # album
            album_label = album or "(앨범 없음)"
            key = (album_label, artist)
            bucket = buckets.setdefault(
                key,
                {
                    "album": album_label,
                    "artist": artist,
                    "track_id": entry.get("track_id"),
                    "count": 0,
                    "listened_ms": 0,
                    "last_played_at": played_at_str,
                },
            )
            bump(bucket)

    # "곡" 그룹은 재생 횟수가 많은 순으로 보여주되, 횟수가 같으면 최근에 들은 곡을 먼저 보여준다.
    sort_key = (lambda b: (b["count"], b["last_played_at"])) if group == "track" else (lambda b: b["count"])
    items = sorted(buckets.values(), key=sort_key, reverse=True)
    if limit is not None:
        items = items[:limit]
    if group == "album":
        # 재생 이력엔 재생 당시의 앨범명만 남아있으므로, 현재 앨범 객체를 이름으로
        # 찾아 album_id를 붙여준다(프런트가 전용 표지를 가져오려면 필요) — 그
        # 사이 앨범이 이름 변경/삭제됐으면 못 찾을 수 있고, 그때는 표지 없이 보여준다.
        for item in items:
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
