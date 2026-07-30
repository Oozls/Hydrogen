"""data 폴더 파일 트리 조회 API."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from flask import Blueprint, abort, jsonify, request

from lyricstorage import storage
from lyricstorage.models import SUPPORTED_EXTENSIONS
from lyricstorage.web import playlist_repo

bp = Blueprint("files", __name__, url_prefix="/api/files")

TEXT_EXTENSIONS = {".lrc", ".json", ".log"}


def _track_titles_by_path() -> dict[str, str]:
    """songs/ 폴더의 해시 파일명 옆에 실제 곡명을 보여주기 위한 경로 -> 제목 맵.
    글로벌 라이브러리에는 내용 해시가 같은 파일마다 정확히 한 Track만 존재하므로
    (models.PlaylistModel.add_file의 중복 방지) 이거 하나만 훑으면 충분하다."""
    playlist = playlist_repo.load_or_create_global()
    return {str(Path(t.path).resolve()): t.title for t in playlist.tracks if t.title}


def _build_tree(path: Path, titles: dict[str, str], rel_prefix: str = "") -> list[dict]:
    entries = []
    for entry in sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        rel = f"{rel_prefix}{entry.name}"
        if entry.is_dir():
            entries.append({
                "name": entry.name,
                "type": "dir",
                "path": rel,
                "children": _build_tree(entry, titles, f"{rel}/"),
            })
        else:
            try:
                stat = entry.stat()
                size = stat.st_size
                # Windows에서는 st_ctime이 생성 시각, 그 외에서는 메타데이터 변경
                # 시각이지만 이 앱은 로컬 전용이라 "추가된 날짜" 표시로 충분하다.
                created = datetime.fromtimestamp(stat.st_ctime).isoformat(timespec="seconds")
            except OSError:
                size = 0
                created = None
            item = {"name": entry.name, "type": "file", "path": rel, "size": size, "created": created}
            if entry.suffix.lower() in SUPPORTED_EXTENSIONS:
                title = titles.get(str(entry.resolve()))
                if title:
                    item["title"] = title
            entries.append(item)
    return entries


def _resolve_safe_path(rel_path: str) -> Path:
    root = storage.app_data_dir().resolve()
    target = (root / rel_path).resolve()
    if target != root and root not in target.parents:
        raise ValueError("잘못된 경로입니다.")
    return target


@bp.get("/tree")
def tree():
    root = storage.app_data_dir()
    return jsonify({"name": root.name, "type": "dir", "children": _build_tree(root, _track_titles_by_path())})


@bp.get("/content")
def content():
    try:
        target = _resolve_safe_path(request.args.get("path", ""))
    except ValueError:
        abort(400)
    if not target.is_file() or target.suffix.lower() not in TEXT_EXTENSIONS:
        abort(404)
    try:
        text = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return jsonify({"error": "텍스트로 표시할 수 없는 파일입니다."}), 400
    return jsonify({"content": text})


@bp.put("/content")
def save_content():
    try:
        target = _resolve_safe_path(request.args.get("path", ""))
    except ValueError:
        abort(400)
    if not target.is_file() or target.suffix.lower() not in TEXT_EXTENSIONS:
        abort(404)
    data = request.get_json(silent=True) or {}
    content = data.get("content")
    if not isinstance(content, str):
        abort(400)
    target.write_text(content, encoding="utf-8")
    return jsonify({"ok": True})


@bp.delete("/entry")
def delete_entry():
    try:
        target = _resolve_safe_path(request.args.get("path", ""))
    except ValueError:
        abort(400)
    if not target.is_file():
        abort(404)
    target.unlink()
    return jsonify({"ok": True})
