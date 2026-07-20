"""표준 LRC([mm:ss.xx]가사) 포맷 파싱/직렬화 및 사이드카 파일 탐색."""

from __future__ import annotations

import re
from pathlib import Path

from lyricstorage import storage

_LRC_LINE_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,2}))?\](.*)")


def parse_lrc(text: str) -> list[tuple[int, str]]:
    """LRC 텍스트를 (timestamp_ms, lyric_text) 리스트로 파싱, 시간순 정렬."""
    lines: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        match = _LRC_LINE_RE.match(raw_line.strip())
        if not match:
            continue
        minutes, seconds, fraction, content = match.groups()
        ms = int(minutes) * 60_000 + int(seconds) * 1000
        if fraction:
            ms += int(fraction.ljust(2, "0")[:2]) * 10
        lines.append((ms, content.strip().replace("\\n", "\n")))
    lines.sort(key=lambda item: item[0])
    return lines


def format_timestamp(ms: int) -> str:
    ms = max(0, ms)
    minutes, rest_ms = divmod(ms, 60_000)
    seconds, centis = divmod(rest_ms, 1000)
    return f"{minutes:02d}:{seconds:02d}.{centis // 10:02d}"


def to_lrc(lines: list[tuple[int, str]]) -> str:
    return (
        "\n".join(f"[{format_timestamp(ms)}]{text.replace(chr(10), '\\n')}" for ms, text in lines)
        + "\n"
    )


def sidecar_path(track_path: str) -> Path:
    return Path(track_path).with_suffix(".lrc")


def find_lyrics_path(track_path: str) -> Path | None:
    """트랙 옆 사이드카 .lrc 우선, 없으면 앱 캐시 폴더 폴백 경로 확인."""
    sidecar = sidecar_path(track_path)
    if sidecar.exists():
        return sidecar
    fallback = storage.fallback_lyrics_path(track_path)
    if fallback.exists():
        return fallback
    return None


def save_lyrics(track_path: str, lines: list[tuple[int, str]]) -> Path:
    """mp3 옆에 저장을 시도하고, 쓰기 실패 시 앱 캐시 폴더로 폴백."""
    content = to_lrc(lines)
    sidecar = sidecar_path(track_path)
    try:
        sidecar.write_text(content, encoding="utf-8")
        return sidecar
    except OSError:
        fallback = storage.fallback_lyrics_path(track_path)
        fallback.write_text(content, encoding="utf-8")
        return fallback


def load_lyrics(track_path: str) -> list[tuple[int, str]]:
    path = find_lyrics_path(track_path)
    if path is None:
        return []
    try:
        return parse_lrc(path.read_text(encoding="utf-8"))
    except OSError:
        return []
