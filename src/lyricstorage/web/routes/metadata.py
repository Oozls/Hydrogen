"""곡 메타데이터(제목/아티스트/앨범) 및 앨범아트 수정 API."""

from __future__ import annotations

from pathlib import Path

from flask import Blueprint, jsonify, request

from lyricstorage import albums as albums_repo
from lyricstorage import applog, storage
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
    if not title:
        return jsonify({"error": "제목을 입력하세요."}), 400

    try:
        write_tags(track.path, title=title, artist=artist, album=track.album)
    except OSError as exc:
        return jsonify({"error": f"파일에 태그를 쓰지 못했습니다: {exc}"}), 500

    playlist_repo.update_track_in_all_playlists(track.path, title=title, artist=artist)
    track.title, track.artist = title, artist
    applog.log_info("ACTION", f"곡 정보 수정: {track_id} -> title={title}, artist={artist}(곡 아티스트)")
    return jsonify(track_to_json(track))


@bp.put("/<track_id>/rating")
def update_rating(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404

    data = request.get_json(silent=True) or {}
    rating = data.get("rating")
    if isinstance(rating, bool) or not isinstance(rating, (int, float)):
        return jsonify({"error": "레이팅은 0~5 사이 0.5 단위 숫자여야 합니다."}), 400
    rating = float(rating)
    # 0.5 단위인지 확인(부동소수 오차 감안): *2가 정수에 가까워야 한다.
    if not (0 <= rating <= 5) or abs(rating * 2 - round(rating * 2)) > 1e-6:
        return jsonify({"error": "레이팅은 0~5 사이 0.5 단위 숫자여야 합니다."}), 400
    rating = round(rating * 2) / 2

    playlist_repo.update_track_in_all_playlists(track.path, rating=rating)
    track.rating = rating
    applog.log_info("ACTION", f"곡 레이팅 변경: {track_id} -> {rating}")
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
        # "album"은 문자열 오버라이트가 아니라 앨범 이동을 의미한다: 같은 이름의
        # 앨범이 있으면 그 앨범으로, 없으면 새 앨범(아티스트 미지정)을 만들어 옮긴다.
        album_name = str(data.get("album") or "").strip()
        album_target = albums_repo.get_or_create_album(album_name)
        fields["album"] = album_target.name
        fields["album_id"] = album_target.id
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


@bp.delete("/metadata/batch")
def delete_tracks_batch():
    data = request.get_json(silent=True) or {}
    track_ids = data.get("track_ids") or []
    deleted, errors = [], []
    for track_id in dict.fromkeys(track_ids):  # 중복 제거, 순서 유지
        track = find_track_by_id(track_id)
        if track is None:
            errors.append({"track_id": track_id, "reason": "트랙을 찾을 수 없습니다."})
            continue
        playlist_repo.remove_track_from_all_playlists(track.path)
        storage.unlink_retrying(Path(track.path), missing_ok=True)
        deleted.append(track_id)
    applog.log_info("ACTION", f"곡 일괄 삭제: {len(deleted)}곡 성공, {len(errors)}곡 실패")
    return jsonify({"deleted": deleted, "errors": errors})


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
    storage.unlink_retrying(Path(track.path), missing_ok=True)
    applog.log_info("ACTION", f"곡 완전 삭제(파일 포함): {track_id} ({track.title})")
    return jsonify({"ok": True})
