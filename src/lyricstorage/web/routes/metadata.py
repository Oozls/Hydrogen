"""곡 메타데이터(제목/아티스트/앨범) 및 앨범아트 수정 API."""

from __future__ import annotations

from pathlib import Path

from flask import Blueprint, jsonify, request

from lyricstorage import applog
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
    applog.log_info("ACTION", f"곡 정보 수정: {track_id} -> title={title}, artist={artist}, album={album}")
    return jsonify(track_to_json(track))


@bp.put("/metadata/batch")
def update_metadata_batch():
    data = request.get_json(silent=True) or {}
    track_ids = data.get("track_ids") or []
    if not track_ids:
        return jsonify({"error": "곡을 선택하세요."}), 400

    fields: dict[str, str] = {}
    if "title" in data:
        title = str(data.get("title") or "").strip()
        if not title:
            return jsonify({"error": "제목을 입력하세요."}), 400
        fields["title"] = title
    if "artist" in data:
        fields["artist"] = str(data.get("artist") or "").strip()
    if "album" in data:
        fields["album"] = str(data.get("album") or "").strip()
    if not fields:
        return jsonify({"error": "적용할 항목을 선택하세요."}), 400

    updated = []
    errors = []
    for track_id in dict.fromkeys(track_ids):  # 중복 제거, 순서 유지
        track = find_track_by_id(track_id)
        if track is None:
            errors.append({"track_id": track_id, "reason": "트랙을 찾을 수 없습니다."})
            continue
        try:
            write_tags(
                track.path,
                title=fields.get("title", track.title),
                artist=fields.get("artist", track.artist),
                album=fields.get("album", track.album),
            )
        except OSError as exc:
            errors.append({"track_id": track_id, "reason": str(exc)})
            continue
        playlist_repo.update_track_in_all_playlists(track.path, **fields)
        for key, value in fields.items():
            setattr(track, key, value)
        updated.append(track_to_json(track))

    applog.log_info(
        "ACTION",
        f"곡 정보 일괄 수정: {len(updated)}곡 성공, {len(errors)}곡 실패 (필드={list(fields.keys())})",
    )
    return jsonify({"updated": updated, "errors": errors})


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

    applog.log_info("ACTION", f"곡 표지 이미지 변경: {track_id}")
    return jsonify(track_to_json(track))


@bp.delete("/<track_id>")
def delete_track(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404

    playlist_repo.remove_track_from_all_playlists(track.path)
    Path(track.path).unlink(missing_ok=True)
    applog.log_info("ACTION", f"곡 완전 삭제(파일 포함): {track_id} ({track.title})")
    return jsonify({"ok": True})
