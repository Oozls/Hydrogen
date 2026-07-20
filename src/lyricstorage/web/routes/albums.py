"""앨범 단위 정보(앨범명, 표지) 일괄 수정 API."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage.models import write_album_art, write_tags
from lyricstorage.web import playlist_repo
from lyricstorage.web.routes.media import _sniff_image_mimetype
from lyricstorage.web.serialize import track_to_json

bp = Blueprint("albums", __name__, url_prefix="/api/albums")

_ALLOWED_ART_MIME = {"image/jpeg", "image/png"}


@bp.post("/update")
def update_album():
    album = (request.form.get("album") or "").strip()
    artist = (request.form.get("artist") or "").strip()
    new_album = (request.form.get("new_album") or "").strip()
    if not new_album:
        return jsonify({"error": "앨범명을 입력하세요."}), 400

    library = playlist_repo.load_or_create_global()
    matching = [t for t in library.tracks if t.album == album and t.artist == artist]
    if not matching:
        return jsonify({"error": "해당 앨범의 곡을 찾을 수 없습니다."}), 404

    art_bytes = None
    mime = None
    file_storage = request.files.get("art")
    if file_storage and file_storage.filename:
        art_bytes = file_storage.read()
        mime = _sniff_image_mimetype(art_bytes)
        if mime not in _ALLOWED_ART_MIME:
            return jsonify({"error": "JPEG 또는 PNG 이미지만 지원합니다."}), 400

    seen_paths = set()
    updated_tracks = []
    for track in matching:
        if track.path in seen_paths:
            continue
        seen_paths.add(track.path)
        try:
            write_tags(track.path, title=track.title, artist=track.artist, album=new_album)
            if art_bytes is not None:
                write_album_art(track.path, art_bytes, mime)
        except OSError as exc:
            return jsonify({"error": f"파일을 수정하지 못했습니다: {exc}"}), 500
        playlist_repo.update_track_in_all_playlists(track.path, album=new_album)
        track.album = new_album
        updated_tracks.append(track_to_json(track))

    return jsonify({"tracks": updated_tracks})
