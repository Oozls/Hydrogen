"""앱 데이터 경로 관리: 설정, 플레이리스트, 가사 캐시 폴더."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterator

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def app_data_dir() -> Path:
    path = PROJECT_ROOT / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path


_DATA_SIZE_TTL_SECONDS = 60.0
_data_size_lock = threading.Lock()
_data_size_cache: tuple[float, int] | None = None  # (계산 시각(monotonic), 바이트)


def invalidate_data_size_cache() -> None:
    """업로드/삭제처럼 data/ 용량이 크게 바뀐 직후 호출하면 다음 조회가 즉시 재계산한다."""
    global _data_size_cache
    with _data_size_lock:
        _data_size_cache = None


def app_data_dir_size_bytes() -> int:
    """data/ 전체 크기. 전체 순회 비용이 커서 결과를 60초 동안 캐시한다."""
    global _data_size_cache
    now = time.monotonic()
    with _data_size_lock:
        cached = _data_size_cache
    if cached is not None and now - cached[0] < _DATA_SIZE_TTL_SECONDS:
        return cached[1]
    total = 0
    for entry in app_data_dir().rglob("*"):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            continue
    with _data_size_lock:
        _data_size_cache = (time.monotonic(), total)
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


def trash_dir() -> Path:
    path = app_data_dir() / "trash"
    path.mkdir(parents=True, exist_ok=True)
    return path


def move_to_trash(path: Path) -> Path:
    """곡 파일을 완전히 지우지 않고 복구 가능하게 data/trash로 옮긴다(예: 재작성
    중 내용이 완전히 같다고 확인된 중복 파일 정리용)."""
    target = trash_dir() / path.name
    if target.exists():
        target = trash_dir() / f"{path.stem}_{int(time.time() * 1000)}{path.suffix}"
    shutil.move(str(path), str(target))
    return target


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


def circles_path() -> Path:
    return app_data_dir() / "circles.json"


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


_legacy_play_history_absent = False


def _migrate_legacy_play_history() -> None:
    """예전엔 재생 기록 전체를 play_history.json 한 파일에 담았다. 재생마다 그
    파일 전체를 읽고 다시 쓰는 게 기록이 쌓일수록 느려져서, 날짜별 파일(하루
    한 개)로 나누고 기록은 그날 파일에 한 줄만 추가하는 방식으로 바꿨다.
    이 함수는 기존 파일이 남아있으면 날짜별로 쪼개 옮기고 원본은 지운다."""
    global _legacy_play_history_absent
    if _legacy_play_history_absent:
        return
    legacy_path = _legacy_play_history_path()
    if not legacy_path.exists():
        # 한 번 없다고 확인되면 이 프로세스에선 다시 확인하지 않는다.
        _legacy_play_history_absent = True
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


def iter_play_history_desc() -> Iterator[dict[str, Any]]:
    """재생 기록을 최신순으로 하나씩 내어준다(제너레이터) — 홈 화면 "다시 듣기"처럼
    최근 몇 개만 필요할 때, 오래된 기록 파일까지 전부 읽지 않고 필요한 만큼만
    소비하고 멈출 수 있게 한다."""
    _migrate_legacy_play_history()
    for path in sorted(play_history_dir().glob("*.jsonl"), reverse=True):
        for entry in reversed(_read_jsonl(path)):
            yield entry


def _read_range(
    file_for: Callable[[date], Path], start: datetime, end: datetime
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    if end <= start:
        return entries
    day = start.date()
    last_day = (end - timedelta(microseconds=1)).date()
    while day <= last_day:
        for raw in _read_jsonl(file_for(day)):
            try:
                played_at = datetime.fromisoformat(raw.get("played_at") or "")
            except ValueError:
                continue
            if start <= played_at < end:
                entries.append(raw)
        day += timedelta(days=1)
    return entries


def load_play_history_range(start: datetime, end: datetime) -> list[dict[str, Any]]:
    """[start, end) 구간과 겹치는 날짜 파일만 읽어 그 구간에 속한 엔트리만 돌려준다
    (day/week/month 통계처럼 전체 기록이 아니라 좁은 기간만 필요할 때, 몇 년치
    기록 전체를 읽지 않아도 되게 한다). 돌려주는 엔트리의 played_at은 항상
    파싱 가능한 ISO 문자열이다."""
    _migrate_legacy_play_history()
    return _read_range(_play_history_file_for, start, end)


def usage_pings_dir() -> Path:
    path = app_data_dir() / "usage_pings"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _usage_ping_file_for(day: date) -> Path:
    return usage_pings_dir() / f"{day.isoformat()}.jsonl"


def append_usage_ping(entry: dict[str, Any]) -> None:
    """게임 플레이타임처럼, 웹앱이 열려 있던 시간을 재생 기록과 같은 방식(날짜별
    jsonl, 한 줄 추가)으로 쌓는다. entry는 play_history와 동일하게 "played_at"
    키를 쓴다 — _entry_day/_append_jsonl/_read_jsonl을 그대로 재사용하기 위함."""
    _append_jsonl(_usage_ping_file_for(_entry_day(entry)), [entry])


def load_usage_pings() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path in sorted(usage_pings_dir().glob("*.jsonl")):
        entries.extend(_read_jsonl(path))
    return entries


def load_usage_pings_range(start: datetime, end: datetime) -> list[dict[str, Any]]:
    return _read_range(_usage_ping_file_for, start, end)


def _load_json(path: Path, expected_type: type | None, default_factory: Callable[[], Any]) -> Any:
    """JSON 파일을 읽어 돌려준다. 파일이 없거나 깨졌거나 expected_type이 아니면
    default_factory()의 새 기본값을 돌려준다(expected_type이 None이면 타입 검사 생략)."""
    if not path.exists():
        return default_factory()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default_factory()
    if expected_type is not None and not isinstance(data, expected_type):
        return default_factory()
    return data


def recommend_exposures_path() -> Path:
    return app_data_dir() / "recommend_exposures.json"


def load_recommend_exposures() -> list[dict[str, Any]]:
    return _load_json(recommend_exposures_path(), list, list)


def save_recommend_exposures(exposures: list[dict[str, Any]]) -> None:
    recommend_exposures_path().write_text(
        json.dumps(exposures, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def recommend_config_path() -> Path:
    return app_data_dir() / "recommend_config.json"


def load_recommend_config() -> dict[str, Any]:
    return _load_json(recommend_config_path(), dict, dict)


def recommend_weight_history_path() -> Path:
    return app_data_dir() / "recommend_weight_history.json"


def load_recommend_weight_history() -> list[dict[str, Any]]:
    return _load_json(recommend_weight_history_path(), list, list)


def save_recommend_weight_history(history: list[dict[str, Any]]) -> None:
    recommend_weight_history_path().write_text(
        json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def load_settings() -> dict[str, Any]:
    return _load_json(settings_path(), None, dict)


def save_settings(settings: dict[str, Any]) -> None:
    settings_path().write_text(
        json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _retry_on_windows_lock(fn, attempts: int = 5, delay: float = 0.05) -> None:
    """Windows는 다른 스레드/커넥션이 파일을 마침 열어보고 있으면(방금 스트리밍한
    직후 등) 쓰기/삭제가 일시적으로 PermissionError를 낼 수 있다(POSIX에는 없는
    문제) — 잠깐 재시도한다."""
    for attempt in range(attempts):
        try:
            fn()
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)


def write_json_atomic(path: Path, data: Any) -> None:
    """쓰다가 프로세스가 죽어도(OOM, 워커 재시작 등) 기존 파일이 반쯤 잘린 채로
    남지 않도록, 임시 파일에 다 쓴 뒤 원자적으로 교체한다."""
    write_text_atomic(path, json.dumps(data, ensure_ascii=False, indent=2))


def write_text_atomic(path: Path, text: str) -> None:
    """write_json_atomic과 동일한 임시파일+교체 방식의 텍스트 버전. 임시파일명은
    호출마다 고유해야 한다 — 이름을 공유하면(예전엔 path+".tmp" 고정) 같은 파일을
    거의 동시에 저장하는 두 요청(디바운스 자동저장 + blur 등)이 서로의 임시파일을
    지우거나 빈 내용 위에 쓰게 되어, 있어야 할 요청 하나가 지고 잘린/빈 파일만
    남을 수 있다. mkstemp로 매번 새 임시파일을 받으면 각 쓰기가 완전히 독립적이고,
    마지막에 이기는 replace()만 원자적으로 순서를 정한다."""
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        _retry_on_windows_lock(lambda: tmp_path.replace(path))
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def unlink_retrying(path: Path, missing_ok: bool = False) -> None:
    """방금 send_file로 스트리밍한 음원 파일처럼, 다른 스레드/커넥션이 아직
    핸들을 들고 있을 수 있는 파일을 지울 때 쓴다(오디오 미리듣기 직후 삭제
    시나리오). 브라우저가 커넥션을 닫는 데도 시간이 걸릴 수 있어 넉넉하게 잡는다."""
    _retry_on_windows_lock(lambda: path.unlink(missing_ok=missing_ok), attempts=20, delay=0.15)


def rebuild_status_path() -> Path:
    return app_data_dir() / "rebuild_status.json"


def legacy_path_hash(path: str) -> str:
    """예전 방식: 절대경로를 그대로 해시. 서버를 옮겨 프로젝트 폴더 경로가 바뀌면 모든
    track_id가 달라져 재생 기록과 끊긴다(scripts/remap_track_ids.py가 이전용)."""
    return hashlib.sha1(str(path).encode("utf-8")).hexdigest()[:16]


def path_hash(path: str) -> str:
    # 프로젝트 루트 기준 상대경로로 해시해서, 서버/폴더 위치가 바뀌어도 ID가 같다.
    return legacy_path_hash(to_relative_path(path))


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
    # 구버전 폴백 위치 조회용 — 경로만 계산하고 폴더는 만들지 않는다(없으면 exists()가
    # False일 뿐이라 동작 동일, 호출마다 mkdir 하던 비용 제거).
    return app_data_dir() / "lyrics_cache" / f"{path_hash(track_path)}.lrc"
