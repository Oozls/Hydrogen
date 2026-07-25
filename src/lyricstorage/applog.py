"""파일 기반 로깅. 자정~정오(AM) / 정오~자정(PM) 12시간 단위로 로그 파일을 나눠 기록한다.

한 줄짜리 항목은 "YYYY-MM-DD HH:MM:SS.mmm [LEVEL] [CATEGORY] message" 형식으로 쓰고,
메시지에 줄바꿈이 있으면(트레이스백 등) 이어지는 줄은 4칸 들여써서, 새 항목 시작을
타임스탬프 패턴으로 구분할 수 있게 한다(read_log_entries가 이 규칙으로 파싱한다).
"""

from __future__ import annotations

import re
import threading
from datetime import datetime
from pathlib import Path

from lyricstorage import storage

_lock = threading.Lock()

_FILENAME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})_(AM|PM)\.log$")
_ENTRY_START_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(\w+)\] \[([^\]]+)\] (.*)$"
)


def _half_for(now: datetime) -> str:
    return "AM" if now.hour < 12 else "PM"


def _log_path_for(now: datetime) -> Path:
    return storage.logs_dir() / f"{now:%Y-%m-%d}_{_half_for(now)}.log"


def log_event(level: str, category: str, message: str) -> None:
    now = datetime.now()
    lines = message.splitlines() or [""]
    text = f"{now:%Y-%m-%d %H:%M:%S.%f}"[:-3] + f" [{level}] [{category}] {lines[0]}\n"
    for extra in lines[1:]:
        text += f"    {extra}\n"
    path = _log_path_for(now)
    with _lock:
        with path.open("a", encoding="utf-8") as f:
            f.write(text)


def log_info(category: str, message: str) -> None:
    log_event("INFO", category, message)


def log_error(category: str, message: str) -> None:
    log_event("ERROR", category, message)


def list_log_files() -> list[dict[str, str]]:
    """존재하는 로그 파일 목록을 최신순으로 반환한다."""
    files = []
    for path in storage.logs_dir().glob("*.log"):
        m = _FILENAME_RE.match(path.name)
        if not m:
            continue
        files.append({"date": m.group(1), "half": m.group(2)})
    files.sort(key=lambda f: (f["date"], f["half"]), reverse=True)
    return files


def read_log_entries(date: str, half: str) -> list[dict[str, str]]:
    """지정한 12시간 구간의 로그 항목을 시간순(파일에 쓰인 순서)으로 반환한다."""
    path = storage.logs_dir() / f"{date}_{half}.log"
    if not path.exists():
        return []
    entries: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    with path.open("r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.rstrip("\n")
            m = _ENTRY_START_RE.match(line)
            if m:
                if current is not None:
                    entries.append(current)
                current = {
                    "timestamp": m.group(1),
                    "level": m.group(2),
                    "category": m.group(3),
                    "message": m.group(4),
                }
            elif current is not None and line.startswith("    "):
                current["message"] += "\n" + line[4:]
    if current is not None:
        entries.append(current)
    return entries
