"""앨범 단위 정보(앨범명, 표지) 일괄 수정 및 다운로드 API."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from lyricstorage import applog
from lyricstorage.models import write_album_art, write_tags
from lyricstorage.web import playlist_repo
from lyricstorage.web.routes.media import _sniff_image_mimetype, sanitize_filename
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

    applog.log_info(
        "ACTION", f"앨범 정보 수정: {album} ({artist}) -> {new_album} ({len(updated_tracks)}곡)"
    )
    return jsonify({"tracks": updated_tracks})


@bp.get("/download")
def download_album():
    album = (request.args.get("album") or "").strip()
    artist = (request.args.get("artist") or "").strip()

    library = playlist_repo.load_or_create_global()
    matching = [t for t in library.tracks if t.album == album and t.artist == artist]
    if not matching:
        return jsonify({"error": "해당 앨범의 곡을 찾을 수 없습니다."}), 404

    buffer = io.BytesIO()
    seen_paths = set()
    used_names = set()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as zf:
        for track in matching:
            if track.path in seen_paths:
                continue
            seen_paths.add(track.path)
            path = Path(track.path)
            if not path.exists():
                continue
            # 저장소의 실제 파일명은 해시라 그대로 넣지 않고 곡 제목으로 담는다.
            # 제목이 같은 곡이 여러 개면 압축 파일 안에서 서로 덮어쓰지 않게 번호를 붙인다.
            name_base = sanitize_filename(track.title or path.stem)
            name = name_base + path.suffix
            if name in used_names:
                i = 2
                while f"{name_base} ({i}){path.suffix}" in used_names:
                    i += 1
                name = f"{name_base} ({i}){path.suffix}"
            used_names.add(name)
            zf.write(path, arcname=name)
    buffer.seek(0)

    zip_name = sanitize_filename(album or "(앨범 없음)") + ".zip"
    applog.log_info("ACTION", f"앨범 다운로드: {album} ({artist}), {len(used_names)}곡")
    return send_file(buffer, as_attachment=True, download_name=zip_name, mimetype="application/zip")
