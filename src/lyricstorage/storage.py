"""앱 데이터 경로 관리: 설정, 플레이리스트, 가사 캐시 폴더."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def app_data_dir() -> Path:
    path = PROJECT_ROOT / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


def playlists_dir() -> Path:
    path = app_data_dir() / "playlists"
    path.mkdir(parents=True, exist_ok=True)
    return path


def lyrics_cache_dir() -> Path:
    path = app_data_dir() / "lyrics_cache"
    path.mkdir(parents=True, exist_ok=True)
    return path


def songs_dir() -> Path:
    path = app_data_dir() / "songs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def settings_path() -> Path:
    return app_data_dir() / "settings.json"


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
