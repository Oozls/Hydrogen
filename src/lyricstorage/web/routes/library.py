"""라이브러리(기본 플레이리스트) 조회 및 업로드 API. 오직 이 라우트만 파일 업로드를 허용한다."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage.web import library as library_adapter
from lyricstorage.web import playlist_repo
from lyricstorage.web.serialize import playlist_to_json, track_to_json

bp = Blueprint("library", __name__, url_prefix="/api/library")


@bp.get("")
def get_library():
    playlist = playlist_repo.load_or_create_global()
    return jsonify(playlist_to_json(playlist))


@bp.post("/upload")
def upload_files():
    playlist = playlist_repo.load_or_create_global()
    files = request.files.getlist("files[]") or request.files.getlist("files")

    added, skipped = [], []
    for file_storage in files:
        if not file_storage or not file_storage.filename:
            continue
        try:
            track = library_adapter.add_uploaded_file(playlist, file_storage)
            added.append(track_to_json(track))
        except (ValueError, OSError) as exc:
            skipped.append({"filename": file_storage.filename, "reason": str(exc)})

    if added:
        playlist.save()
    return jsonify({"added": added, "skipped": skipped})
