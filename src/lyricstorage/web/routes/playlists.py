"""플레이리스트 CRUD, 순서변경, 트랙 삭제/라이브러리에서 추가 API."""

from __future__ import annotations

from dataclasses import replace

from flask import Blueprint, jsonify, request

from lyricstorage import applog
from lyricstorage.models import GLOBAL_PLAYLIST_NAME, PlaylistModel
from lyricstorage.web import playlist_repo
from lyricstorage.web.lookup import find_track_by_id
from lyricstorage.web.serialize import playlist_to_json

bp = Blueprint("playlists", __name__, url_prefix="/api/playlists")


@bp.get("")
def list_playlists():
    result = []
    for name, path in PlaylistModel.list_saved_names():
        playlist = PlaylistModel.load(path)
        result.append(
            {
                "name": name,
                "is_global": name == GLOBAL_PLAYLIST_NAME,
                "track_count": len(playlist.tracks),
            }
        )
    return jsonify(result)


@bp.post("")
def create_playlist():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "이름을 입력하세요."}), 400
    if name == GLOBAL_PLAYLIST_NAME:
        return jsonify({"error": "해당 이름은 예약되어 있습니다."}), 400
    if playlist_repo.find_playlist_path(name) is not None:
        return jsonify({"error": "이미 존재하는 이름입니다."}), 400
    playlist = PlaylistModel(name)
    playlist.save()
    applog.log_info("ACTION", f"플레이리스트 생성: {name}")
    return jsonify(playlist_to_json(playlist)), 201


@bp.get("/<name>")
def get_playlist(name: str):
    playlist = playlist_repo.load_playlist(name)
    if playlist is None:
        return jsonify({"error": "플레이리스트를 찾을 수 없습니다."}), 404
    return jsonify(playlist_to_json(playlist))


@bp.delete("/<name>")
def delete_playlist(name: str):
    if name == GLOBAL_PLAYLIST_NAME:
        return jsonify({"error": "라이브러리는 삭제할 수 없습니다."}), 403
    path = playlist_repo.find_playlist_path(name)
    if path is None:
        return jsonify({"error": "플레이리스트를 찾을 수 없습니다."}), 404
    path.unlink(missing_ok=True)
    applog.log_info("ACTION", f"플레이리스트 삭제: {name}")
    return jsonify({"ok": True})


@bp.post("/<name>/rename")
def rename_playlist(name: str):
    if name == GLOBAL_PLAYLIST_NAME:
        return jsonify({"error": "라이브러리는 이름을 변경할 수 없습니다."}), 403
    playlist = playlist_repo.load_playlist(name)
    if playlist is None:
        return jsonify({"error": "플레이리스트를 찾을 수 없습니다."}), 404
    data = request.get_json(silent=True) or {}
    new_name = (data.get("name") or "").strip()
    if not new_name:
        return jsonify({"error": "이름을 입력하세요."}), 400
    if new_name == GLOBAL_PLAYLIST_NAME:
        return jsonify({"error": "해당 이름은 예약되어 있습니다."}), 400
    if new_name != name and playlist_repo.find_playlist_path(new_name) is not None:
        return jsonify({"error": "이미 존재하는 이름입니다."}), 400
    old_path = playlist_repo.find_playlist_path(name)
    playlist.name = new_name
    new_path = playlist.save()
    if old_path is not None and old_path != new_path:
        old_path.unlink(missing_ok=True)
    applog.log_info("ACTION", f"플레이리스트 이름 변경: {name} -> {new_name}")
    return jsonify(playlist_to_json(playlist))


@bp.post("/<name>/reorder")
def reorder_playlist(name: str):
    playlist = playlist_repo.load_playlist(name)
    if playlist is None:
        return jsonify({"error": "플레이리스트를 찾을 수 없습니다."}), 404
    data = request.get_json(silent=True) or {}
    from_index, to_index = data.get("from_index"), data.get("to_index")
    if not isinstance(from_index, int) or not isinstance(to_index, int):
        return jsonify({"error": "from_index/to_index가 필요합니다."}), 400
    playlist.move(from_index, to_index)
    playlist.save()
    applog.log_info("ACTION", f"플레이리스트 순서 변경: {name} ({from_index} -> {to_index})")
    return jsonify(playlist_to_json(playlist))


@bp.post("/<name>/reorder-full")
def reorder_playlist_full(name: str):
    """브라우즈의 앨범/앨범 상세 곡 목록처럼, 여러 트랙(그룹) 순서를 한 번에
    새로 정해야 하는 드래그 결과를 전체 track_id 순서로 통째로 반영한다."""
    playlist = playlist_repo.load_playlist(name)
    if playlist is None:
        return jsonify({"error": "플레이리스트를 찾을 수 없습니다."}), 404
    data = request.get_json(silent=True) or {}
    track_ids = data.get("track_ids")
    if not isinstance(track_ids, list) or not all(isinstance(t, str) for t in track_ids):
        return jsonify({"error": "track_ids가 필요합니다."}), 400
    try:
        playlist.reorder(track_ids)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    playlist.save()
    applog.log_info("ACTION", f"플레이리스트 순서 재배열: {name}")
    return jsonify(playlist_to_json(playlist))


@bp.post("/<name>/tracks/remove-batch")
def remove_tracks(name: str):
    playlist = playlist_repo.load_playlist(name)
    if playlist is None:
        return jsonify({"error": "플레이리스트를 찾을 수 없습니다."}), 404
    data = request.get_json(silent=True) or {}
    indices = sorted(
        {i for i in (data.get("indices") or []) if isinstance(i, int)}, reverse=True
    )
    for i in indices:
        if 0 <= i < len(playlist.tracks):
            playlist.remove(i)
    if indices:
        playlist.save()
        applog.log_info("ACTION", f"플레이리스트 곡 제거: {name} ({len(indices)}곡)")
    return jsonify(playlist_to_json(playlist))


@bp.post("/<name>/tracks")
def add_tracks_from_library(name: str):
    if name == GLOBAL_PLAYLIST_NAME:
        return jsonify({"error": "라이브러리에는 이 방법으로 추가할 수 없습니다."}), 403
    playlist = playlist_repo.load_playlist(name)
    if playlist is None:
        return jsonify({"error": "플레이리스트를 찾을 수 없습니다."}), 404
    data = request.get_json(silent=True) or {}
    track_ids = data.get("track_ids") or []
    for track_id in track_ids:
        track = find_track_by_id(track_id)
        if track is None:
            continue
        playlist.tracks.append(replace(track))
    playlist.save()
    applog.log_info("ACTION", f"플레이리스트에 라이브러리 곡 추가: {name} ({len(track_ids)}곡 요청)")
    return jsonify(playlist_to_json(playlist))
