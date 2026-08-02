"""라이브러리(기본 플레이리스트) 조회 및 업로드 API. 오직 이 라우트만 파일 업로드를 허용한다."""

from __future__ import annotations

from dataclasses import replace

from flask import Blueprint, jsonify, request

from lyricstorage import albums as albums_repo
from lyricstorage import applog
from lyricstorage.models import GLOBAL_PLAYLIST_NAME, read_album_art
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
    target_name = (request.form.get("playlist") or "").strip()
    target_playlist = (
        playlist_repo.load_playlist(target_name)
        if target_name and target_name != GLOBAL_PLAYLIST_NAME
        else None
    )
    files = request.files.getlist("files[]") or request.files.getlist("files")

    added, skipped = [], []
    for file_storage in files:
        if not file_storage or not file_storage.filename:
            continue
        try:
            track = library_adapter.add_uploaded_file(playlist, file_storage)
            added.append(track_to_json(track))
            if target_playlist is not None:
                target_playlist.tracks.append(replace(track))
        except (ValueError, OSError) as exc:
            skipped.append({"filename": file_storage.filename, "reason": str(exc)})

    albums_missing_art = []
    if added:
        playlist.save()
        if target_playlist is not None:
            target_playlist.save()
        # 이번에 곡이 추가된 앨범 중 아직 전용 표지가 없는 앨범을 찾아 프런트에
        # 알려준다(곡 내부 표지를 쓸지, 따로 업로드할지 사용자가 고를 수 있도록).
        touched_album_ids = list(dict.fromkeys(t["album_id"] for t in added if t.get("album_id")))
        for album_id in touched_album_ids:
            album = albums_repo.find_album_by_id(album_id)
            if album is None or album.art_ext:
                continue
            member_tracks = [t for t in playlist.tracks if t.album_id == album_id]
            has_embedded_art = any(read_album_art(t.path) for t in member_tracks)
            albums_missing_art.append(
                {
                    "album_id": album.id,
                    "name": album.name,
                    "artist": album.artist,
                    "has_embedded_art": has_embedded_art,
                }
            )
    applog.log_info(
        "ACTION",
        f"곡 업로드: 총 {len(files)}개 중 성공 {len(added)}개, 스킵 {len(skipped)}개"
        + (f" (대상 재생목록={target_name})" if target_playlist is not None else ""),
    )
    return jsonify({"added": added, "skipped": skipped, "albums_missing_art": albums_missing_art})
