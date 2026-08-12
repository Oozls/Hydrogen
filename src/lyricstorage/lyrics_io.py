"""표준 LRC([mm:ss.xx]가사) 포맷 파싱/직렬화, 가사 파일 저장/백업 관리."""

from __future__ import annotations

import re
import shutil
from datetime import datetime
from pathlib import Path

from lyricstorage import storage

_LRC_LINE_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,2}))?\](.*)")

# 자동저장(디바운스)마다 백업이 쌓이는 걸 막기 위해, 같은 곡은 기본적으로 이
# 간격보다 최근 백업이 있으면 건너뛴다. 다만 가사가 통째로 사라지는(빈 자막
# 덮어쓰기) 경우엔 이 스로틀과 무관하게 항상 백업한다.
_BACKUP_THROTTLE_SECONDS = 10 * 60
_MAX_BACKUPS_PER_TRACK = 30
_BACKUP_TS_FORMAT = "%Y%m%d-%H%M%S"


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


def lyrics_path(track_path: str) -> Path:
    """가사 파일의 정본 저장 위치: data/lyrics/<트랙 파일명(확장자 제외)>.lrc.
    트랙 파일명 자체가 내용 해시라 곡 간 충돌 없이 고유하다."""
    return storage.lyrics_dir() / f"{Path(track_path).stem}.lrc"


def _legacy_paths(track_path: str) -> list[Path]:
    """구버전 저장 위치(음원 옆 사이드카, 쓰기 실패 시 캐시 폴백). 마이그레이션과
    과거 데이터 호환 조회용으로만 남겨둔다."""
    return [Path(track_path).with_suffix(".lrc"), storage.fallback_lyrics_path(track_path)]


def find_lyrics_path(track_path: str) -> Path | None:
    """새 위치 우선, 없으면 구버전 위치도 확인(마이그레이션 전 과거 데이터 대비)."""
    current = lyrics_path(track_path)
    if current.exists():
        return current
    for legacy in _legacy_paths(track_path):
        if legacy.exists():
            return legacy
    return None


def _backup_dir(track_path: str) -> Path:
    path = storage.lyrics_backups_dir() / Path(track_path).stem
    path.mkdir(parents=True, exist_ok=True)
    return path


def list_backups(track_path: str) -> list[dict]:
    """최신순 백업 목록: [{"name": "20260729-153000.lrc", "timestamp": "2026-07-29T15:30:00"}, ...]"""
    entries = []
    for file in _backup_dir(track_path).glob("*.lrc"):
        try:
            ts = datetime.strptime(file.stem, _BACKUP_TS_FORMAT)
        except ValueError:
            continue
        entries.append({"name": file.name, "timestamp": ts.isoformat()})
    entries.sort(key=lambda entry: entry["name"], reverse=True)
    return entries


def read_backup(track_path: str, name: str) -> list[tuple[int, str]]:
    backup_dir = _backup_dir(track_path).resolve()
    target = (backup_dir / name).resolve()
    if target.parent != backup_dir or not target.is_file():
        raise FileNotFoundError(name)
    return parse_lrc(target.read_text(encoding="utf-8"))


def _prune_backups(track_path: str) -> None:
    files = sorted(_backup_dir(track_path).glob("*.lrc"))
    excess = len(files) - _MAX_BACKUPS_PER_TRACK
    for file in files[:excess]:
        try:
            file.unlink()
        except OSError:
            pass


def _maybe_backup_current(track_path: str, *, force: bool = False) -> None:
    """저장/삭제로 기존 가사 파일을 덮어쓰기 직전, 백업 폴더에 스냅샷을 남긴다."""
    current = lyrics_path(track_path)
    if not current.exists():
        return
    try:
        content = current.read_text(encoding="utf-8")
    except OSError:
        return
    if not content.strip():
        return

    backup_dir = _backup_dir(track_path)
    existing = sorted(backup_dir.glob("*.lrc"))
    if not force and existing:
        try:
            last_ts = datetime.strptime(existing[-1].stem, _BACKUP_TS_FORMAT)
        except ValueError:
            last_ts = None
        if last_ts is not None and (datetime.now() - last_ts).total_seconds() < _BACKUP_THROTTLE_SECONDS:
            return

    target = backup_dir / f"{datetime.now().strftime(_BACKUP_TS_FORMAT)}.lrc"
    if target.exists():
        return
    shutil.copy2(current, target)
    _prune_backups(track_path)


def restore_backup(track_path: str, name: str) -> Path:
    """백업 내용을 정본 위치에 복원. 복원 전 현재 상태도 스로틀과 무관하게 백업한다."""
    lines = read_backup(track_path, name)
    _maybe_backup_current(track_path, force=True)
    target = lyrics_path(track_path)
    storage.write_text_atomic(target, to_lrc(lines))
    return target


def delete_lyrics(track_path: str) -> None:
    _maybe_backup_current(track_path, force=True)
    for candidate in (lyrics_path(track_path), *_legacy_paths(track_path)):
        try:
            candidate.unlink(missing_ok=True)
        except OSError:
            pass


def save_lyrics(track_path: str, lines: list[tuple[int, str]]) -> Path | None:
    """가사를 data/lyrics/에 저장. lines가 비어있으면 기존 파일을 새로 만드는 대신
    지운다(빈 사이드카 방지). 실제로 덮어쓰기/삭제하기 직전에는 이전 내용을
    백업 폴더에 남긴다."""
    if not lines:
        delete_lyrics(track_path)
        return None

    _maybe_backup_current(track_path)
    target = lyrics_path(track_path)
    storage.write_text_atomic(target, to_lrc(lines))
    for legacy in _legacy_paths(track_path):
        try:
            legacy.unlink(missing_ok=True)
        except OSError:
            pass
    return target


def load_lyrics(track_path: str) -> list[tuple[int, str]]:
    path = find_lyrics_path(track_path)
    if path is None:
        return []
    try:
        return parse_lrc(path.read_text(encoding="utf-8"))
    except OSError:
        return []


def migrate_legacy_lyrics() -> int:
    """구버전 저장 위치(음원 폴더 사이드카, lyrics_cache 폴백)에 남은 가사 파일을
    새 위치(data/lyrics/)로 옮긴다. 앱 시작 시 매번 호출되는 멱등 함수."""
    moved = 0
    for audio in storage.songs_dir().iterdir():
        if not audio.is_file() or audio.suffix.lower() not in (".mp3", ".wav", ".m4a"):
            continue
        target = lyrics_path(str(audio))
        if target.exists():
            continue
        for legacy in _legacy_paths(str(audio)):
            if legacy.exists():
                shutil.move(str(legacy), str(target))
                moved += 1
                break
    return moved
