"""data 폴더 파일 트리 조회 API."""

from __future__ import annotations

from pathlib import Path

from flask import Blueprint, jsonify

from lyricstorage import storage

bp = Blueprint("files", __name__, url_prefix="/api/files")


def _build_tree(path: Path) -> list[dict]:
    entries = []
    for entry in sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if entry.is_dir():
            entries.append({
                "name": entry.name,
                "type": "dir",
                "children": _build_tree(entry),
            })
        else:
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            entries.append({"name": entry.name, "type": "file", "size": size})
    return entries


@bp.get("/tree")
def tree():
    root = storage.app_data_dir()
    return jsonify({"name": root.name, "type": "dir", "children": _build_tree(root)})
