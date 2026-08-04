"""앱 데이터 경로 관리: 설정, 플레이리스트, 가사 캐시 폴더."""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def app_data_dir() -> Path:
    path = PROJECT_ROOT / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def app_data_dir_size_bytes() -> int:
    total = 0
    for entry in app_data_dir().rglob("*"):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


def playlists_dir() -> Path:
    path = app_data_dir() / "playlists"
    path.mkdir(parents=True, exist_ok=True)
    return path


def lyrics_cache_dir() -> Path:
    path = app_data_dir() / "lyrics_cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def lyrics_dir() -> Path:
    path = app_data_dir() / "lyrics"
    path.mkdir(parents=True, exist_ok=True)
    return path


def lyrics_backups_dir() -> Path:
    path = app_data_dir() / "lyrics_backups"
    path.mkdir(parents=True, exist_ok=True)
    return path


def songs_dir() -> Path:
    path = app_data_dir() / "songs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def logs_dir() -> Path:
    path = app_data_dir() / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def album_art_dir() -> Path:
    path = app_data_dir() / "album_art"
    path.mkdir(parents=True, exist_ok=True)
    return path


def albums_path() -> Path:
    return app_data_dir() / "albums.json"


def artists_path() -> Path:
    return app_data_dir() / "artists.json"


def settings_path() -> Path:
    return app_data_dir() / "settings.json"


def play_history_dir() -> Path:
    path = app_data_dir() / "play_history"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _legacy_play_history_path() -> Path:
    return app_data_dir() / "play_history.json"


def _play_history_file_for(day: date) -> Path:
    return play_history_dir() / f"{day.isoformat()}.jsonl"


def _entry_day(entry: dict[str, Any]) -> date:
    try:
        return datetime.fromisoformat(entry.get("played_at") or "").date()
    except ValueError:
        return date.today()


def _append_jsonl(path: Path, entries: list[dict[str, Any]]) -> None:
    with path.open("a", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, ensure_ascii=False))
            f.write("\n")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    entries: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            entries.append(obj)
    return entries


def _migrate_legacy_play_history() -> None:
    """예전엔 재생 기록 전체를 play_history.json 한 파일에 담았다. 재생마다 그
    파일 전체를 읽고 다시 쓰는 게 기록이 쌓일수록 느려져서, 날짜별 파일(하루
    한 개)로 나누고 기록은 그날 파일에 한 줄만 추가하는 방식으로 바꿨다.
    이 함수는 기존 파일이 남아있으면 날짜별로 쪼개 옮기고 원본은 지운다."""
    legacy_path = _legacy_play_history_path()
    if not legacy_path.exists():
        return
    try:
        data = json.loads(legacy_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = []
    if isinstance(data, list):
        by_day: dict[date, list[dict[str, Any]]] = {}
        for entry in data:
            if isinstance(entry, dict):
                by_day.setdefault(_entry_day(entry), []).append(entry)
        for day, entries in by_day.items():
            _append_jsonl(_play_history_file_for(day), entries)
    legacy_path.unlink(missing_ok=True)


def append_play_history(entry: dict[str, Any]) -> None:
    _migrate_legacy_play_history()
    _append_jsonl(_play_history_file_for(_entry_day(entry)), [entry])


def load_play_history() -> list[dict[str, Any]]:
    _migrate_legacy_play_history()
    entries: list[dict[str, Any]] = []
    for path in sorted(play_history_dir().glob("*.jsonl")):
        entries.extend(_read_jsonl(path))
    return entries


def load_play_history_range(start: datetime, end: datetime) -> list[dict[str, Any]]:
    """[start, end) 구간과 겹치는 날짜 파일만 읽어 그 구간에 속한 엔트리만 돌려준다
    (day/week/month 통계처럼 전체 기록이 아니라 좁은 기간만 필요할 때, 몇 년치
    기록 전체를 읽지 않아도 되게 한다)."""
    _migrate_legacy_play_history()
    entries: list[dict[str, Any]] = []
    if end <= start:
        return entries
    day = start.date()
    last_day = (end - timedelta(microseconds=1)).date()
    while day <= last_day:
        for raw in _read_jsonl(_play_history_file_for(day)):
            try:
                played_at = datetime.fromisoformat(raw.get("played_at") or "")
            except ValueError:
                continue
            if start <= played_at < end:
                entries.append(raw)
        day += timedelta(days=1)
    return entries


def recommend_exposures_path() -> Path:
    return app_data_dir() / "recommend_exposures.json"


def load_recommend_exposures() -> list[dict[str, Any]]:
    path = recommend_exposures_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_recommend_exposures(exposures: list[dict[str, Any]]) -> None:
    recommend_exposures_path().write_text(
        json.dumps(exposures, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def recommend_config_path() -> Path:
    return app_data_dir() / "recommend_config.json"


def load_recommend_config() -> dict[str, Any]:
    path = recommend_config_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_recommend_config(config: dict[str, Any]) -> None:
    recommend_config_path().write_text(
        json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def recommend_weight_history_path() -> Path:
    return app_data_dir() / "recommend_weight_history.json"


def load_recommend_weight_history() -> list[dict[str, Any]]:
    path = recommend_weight_history_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_recommend_weight_history(history: list[dict[str, Any]]) -> None:
    recommend_weight_history_path().write_text(
        json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def load_settings() -> dict[str, Any]:
    path = settings_path()
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save_settings(settings: dict[str, Any]) -> None:
    settings_path().write_text(
        json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def path_hash(path: str) -> str:
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:16]


def to_relative_path(path: str | Path) -> str:
    """저장(JSON)용: 프로젝트 루트 기준 상대경로로 변환(이식성)."""
    p = Path(path)
    try:
        return p.relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        return p.as_posix()


def to_absolute_path(path: str) -> str:
    """런타임용: 저장된 경로(상대 또는 과거 데이터의 절대경로)를 절대경로로 복원."""
    p = Path(path)
    if p.is_absolute():
        return str(p)
    return str(PROJECT_ROOT / p)


def file_content_hash(path: Path | str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fallback_lyrics_path(track_path: str) -> Path:
    return lyrics_cache_dir() / f"{path_hash(track_path)}.lrc"
