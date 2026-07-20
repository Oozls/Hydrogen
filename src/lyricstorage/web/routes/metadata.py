"""곡 메타데이터(제목/아티스트/앨범) 및 앨범아트 수정 API."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage.models import write_album_art, write_tags
from lyricstorage.web import playlist_repo
from lyricstorage.web.lookup import find_track_by_id
from lyricstorage.web.routes.media import _sniff_image_mimetype
from lyricstorage.web.serialize import track_to_json

bp = Blueprint("metadata", __name__, url_prefix="/api/tracks")

_ALLOWED_ART_MIME = {"image/jpeg", "image/png"}


@bp.put("/<track_id>/metadata")
def update_metadata(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404

    data = request.get_json(silent=True) or {}
    title = str(data.get("title") or "").strip()
    artist = str(data.get("artist") or "").strip()
    album = str(data.get("album") or "").strip()
    if not title:
        return jsonify({"error": "제목을 입력하세요."}), 400

    try:
        write_tags(track.path, title=title, artist=artist, album=album)
    except OSError as exc:
        return jsonify({"error": f"파일에 태그를 쓰지 못했습니다: {exc}"}), 500

    playlist_repo.update_track_in_all_playlists(
        track.path, title=title, artist=artist, album=album
    )
    track.title, track.artist, track.album = title, artist, album
    return jsonify(track_to_json(track))


@bp.post("/<track_id>/art")
def upload_art(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404

    file_storage = request.files.get("art")
    if not file_storage or not file_storage.filename:
        return jsonify({"error": "이미지 파일이 필요합니다."}), 400

    image_bytes = file_storage.read()
    mime = _sniff_image_mimetype(image_bytes)
    if mime not in _ALLOWED_ART_MIME:
        return jsonify({"error": "JPEG 또는 PNG 이미지만 지원합니다."}), 400

    try:
        write_album_art(track.path, image_bytes, mime)
    except OSError as exc:
        return jsonify({"error": f"앨범아트를 저장하지 못했습니다: {exc}"}), 500

    return jsonify(track_to_json(track))
