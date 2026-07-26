"""data 폴더 파일 트리 조회 API."""

from __future__ import annotations

from pathlib import Path

from flask import Blueprint, abort, jsonify, request

from lyricstorage import storage

bp = Blueprint("files", __name__, url_prefix="/api/files")

TEXT_EXTENSIONS = {".lrc", ".json", ".log"}


def _build_tree(path: Path, rel_prefix: str = "") -> list[dict]:
    entries = []
    for entry in sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        rel = f"{rel_prefix}{entry.name}"
        if entry.is_dir():
            entries.append({
                "name": entry.name,
                "type": "dir",
                "path": rel,
                "children": _build_tree(entry, f"{rel}/"),
            })
        else:
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            entries.append({"name": entry.name, "type": "file", "path": rel, "size": size})
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
    return jsonify({"name": root.name, "type": "dir", "children": _build_tree(root)})


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
