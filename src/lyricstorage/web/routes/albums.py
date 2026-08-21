"""앨범 객체(앨범명/앨범 아티스트/연도/전용 표지) CRUD 및 다운로드 API."""

from __future__ import annotations

import io
import zipfile
from collections import Counter
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file

from lyricstorage import albums as albums_repo
from lyricstorage import applog
from lyricstorage.models import read_album_art, write_tags
from lyricstorage.web import playlist_repo
from lyricstorage.web.routes.media import _sniff_image_mimetype, sanitize_filename
from lyricstorage.web.serialize import album_to_json, track_to_json

bp = Blueprint("albums", __name__, url_prefix="/api/albums")

_ALLOWED_ART_MIME = {"image/jpeg", "image/png"}


def _track_count(album_id: str) -> int:
    return len(playlist_repo.find_tracks_by_album_id(album_id))


@bp.get("")
def list_albums():
    albums = albums_repo.load_albums()
    # _track_count(a.id)를 앨범마다 부르면 find_tracks_by_album_id가 매번 글로벌
    # 플레이리스트 JSON을 통째로 다시 읽어 앨범 수만큼 디스크 I/O가 반복된다
    # (라이브러리가 크면 이게 접속 시 로딩이 느려지는 주범이었다). 여기선 한 번만
    # 불러와 앨범당 트랙 수를 세어 재사용한다.
    playlist = playlist_repo.load_or_create_global()
    counts = Counter(t.album_id for t in playlist.tracks)
    return jsonify({"albums": [album_to_json(a, counts.get(a.id, 0)) for a in albums]})


@bp.get("/<album_id>")
def get_album(album_id: str):
    album = albums_repo.find_album_by_id(album_id)
    if album is None:
        return jsonify({"error": "앨범을 찾을 수 없습니다."}), 404
    tracks = playlist_repo.find_tracks_by_album_id(album_id)
    return jsonify(
        {
            "album": album_to_json(album, len(tracks)),
            "tracks": [track_to_json(t) for t in tracks],
        }
    )


@bp.put("/<album_id>")
def update_album(album_id: str):
    album = albums_repo.find_album_by_id(album_id)
    if album is None:
        return jsonify({"error": "앨범을 찾을 수 없습니다."}), 404

    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    artist = str(data.get("artist") or "").strip()
    year_raw = data.get("year")
    if year_raw in (None, ""):
        year = None
    else:
        try:
            year = int(year_raw)
        except (TypeError, ValueError):
            return jsonify({"error": "연도는 숫자여야 합니다."}), 400

    if not name:
        return jsonify({"error": "앨범명을 입력하세요."}), 400

    name_changed = name != album.name
    updated = albums_repo.update_album(album_id, name=name, artist=artist, year=year)

    if name_changed:
        for track in playlist_repo.find_tracks_by_album_id(album_id):
            try:
                write_tags(track.path, title=track.title, artist=track.artist, album=name)
            except OSError as exc:
                return jsonify({"error": f"파일을 수정하지 못했습니다: {exc}"}), 500
        playlist_repo.update_tracks_by_album_id(album_id, album=name)

    applog.log_info("ACTION", f"앨범 정보 수정: {album_id} -> name={name}, artist={artist}, year={year}")
    tracks = playlist_repo.find_tracks_by_album_id(album_id)
    return jsonify(
        {
            "album": album_to_json(updated, len(tracks)),
            "tracks": [track_to_json(t) for t in tracks],
        }
    )


@bp.post("/<album_id>/art")
def upload_album_art(album_id: str):
    album = albums_repo.find_album_by_id(album_id)
    if album is None:
        return jsonify({"error": "앨범을 찾을 수 없습니다."}), 404

    file_storage = request.files.get("art")
    if not file_storage or not file_storage.filename:
        return jsonify({"error": "이미지 파일이 필요합니다."}), 400

    image_bytes = file_storage.read()
    mime = _sniff_image_mimetype(image_bytes)
    if mime not in _ALLOWED_ART_MIME:
        return jsonify({"error": "JPEG 또는 PNG 이미지만 지원합니다."}), 400

    ext = "png" if mime == "image/png" else "jpg"
    albums_repo.write_album_cover(album_id, image_bytes, ext)
    applog.log_info("ACTION", f"앨범 표지 이미지 변경: {album_id}")
    return jsonify(album_to_json(albums_repo.find_album_by_id(album_id), _track_count(album_id)))


@bp.post("/<album_id>/art/from-track")
def use_track_art_for_album(album_id: str):
    album = albums_repo.find_album_by_id(album_id)
    if album is None:
        return jsonify({"error": "앨범을 찾을 수 없습니다."}), 404

    for track in playlist_repo.find_tracks_by_album_id(album_id):
        art_bytes = read_album_art(track.path)
        if art_bytes:
            ext = albums_repo.sniff_image_ext(art_bytes)
            albums_repo.write_album_cover(album_id, art_bytes, ext)
            applog.log_info("ACTION", f"앨범 표지를 곡 내부 표지로 설정: {album_id}")
            return jsonify(album_to_json(albums_repo.find_album_by_id(album_id), _track_count(album_id)))

    return jsonify({"error": "표지가 있는 곡을 찾을 수 없습니다."}), 404


@bp.get("/<album_id>/art")
def get_album_art(album_id: str):
    album = albums_repo.find_album_by_id(album_id)
    if album is None or not album.art_ext:
        abort(404)
    path = albums_repo.album_art_path(album.id, album.art_ext)
    if not path.exists():
        abort(404)
    mimetype = "image/png" if album.art_ext == "png" else "image/jpeg"
    # conditional=True -> 파일이 안 바뀌었으면 304로 응답해 매번 다시 안 받게 한다.
    # 느린 네트워크에서 목록을 오갈 때마다 표지를 재다운로드하던 게 체감 지연의
    # 큰 부분이었다.
    return send_file(path, mimetype=mimetype, conditional=True, max_age=604800)


@bp.get("/<album_id>/download")
def download_album(album_id: str):
    album = albums_repo.find_album_by_id(album_id)
    if album is None:
        return jsonify({"error": "앨범을 찾을 수 없습니다."}), 404

    matching = playlist_repo.find_tracks_by_album_id(album_id)
    if not matching:
        return jsonify({"error": "해당 앨범의 곡을 찾을 수 없습니다."}), 404

    buffer = io.BytesIO()
    used_names = set()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as zf:
        for track in matching:
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

    zip_name = sanitize_filename(album.name or "(앨범 없음)") + ".zip"
    applog.log_info("ACTION", f"앨범 다운로드: {album.name} ({album.artist}), {len(used_names)}곡")
    return send_file(buffer, as_attachment=True, download_name=zip_name, mimetype="application/zip")
