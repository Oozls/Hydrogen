"""플레이리스트 CRUD, 순서변경, 트랙 삭제/라이브러리에서 추가 API."""

from __future__ import annotations

from dataclasses import replace

from flask import Blueprint, jsonify, request

from lyricstorage import storage
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
    return jsonify({"ok": True})


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
    return jsonify(playlist_to_json(playlist))


@bp.post("/<name>/tracks/remove-batch")
def remove_tracks(name: str):
    playlist = playlist_repo.load_playlist(name)
    if playlist is None:
        return jsonify({"error": "플레이리스트를 찾을 수 없습니다."}), 404
    data = request.get_json(silent=True) or {}
    track_ids = set(data.get("track_ids") or [])
    if track_ids:
        indices = [
            i
            for i, t in enumerate(playlist.tracks)
            if storage.path_hash(t.path) in track_ids
        ]
        for i in sorted(indices, reverse=True):
            playlist.remove(i)
        playlist.save()
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
    existing_paths = {t.path for t in playlist.tracks}
    for track_id in track_ids:
        track = find_track_by_id(track_id)
        if track is None or track.path in existing_paths:
            continue
        playlist.tracks.append(replace(track))
        existing_paths.add(track.path)
    playlist.save()
    return jsonify(playlist_to_json(playlist))
