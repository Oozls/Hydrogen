"""라이브러리(기본 플레이리스트) 조회 및 업로드 API. 오직 이 라우트만 파일 업로드를 허용한다."""

from __future__ import annotations

import tempfile
from dataclasses import replace
from pathlib import Path

from flask import Blueprint, jsonify, request

from lyricstorage import albums as albums_repo
from lyricstorage import applog
from lyricstorage.models import (
    GLOBAL_PLAYLIST_NAME,
    SUPPORTED_EXTENSIONS,
    read_album_art,
    read_tags,
    write_tags,
)
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

    # 이번 업로드로 새로 생겨난 앨범을 가려내려면, 파일을 추가하기 전(=아직 아무
    # 앨범도 새로 만들어지지 않은 시점)의 앨범 id 집합을 미리 찍어둬야 한다.
    existing_album_ids = {a.id for a in albums_repo.load_albums()}

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
    new_albums = []
    if added:
        playlist.save()
        if target_playlist is not None:
            target_playlist.save()
        touched_album_ids = list(dict.fromkeys(t["album_id"] for t in added if t.get("album_id")))
        for album_id in touched_album_ids:
            album = albums_repo.find_album_by_id(album_id)
            if album is None:
                continue
            # 이번 업로드로 새로 생긴 앨범은 앨범 아티스트를 곡 아티스트로
            # 추측해 채워둔 상태라, 프런트에 알려 사용자가 확인/수정하게 한다.
            if album_id not in existing_album_ids:
                new_albums.append(
                    {"album_id": album.id, "name": album.name, "artist": album.artist, "year": album.year}
                )
            # 이번에 곡이 추가된 앨범 중 아직 전용 표지가 없는 앨범을 찾아 프런트에
            # 알려준다(곡 내부 표지를 쓸지, 따로 업로드할지 사용자가 고를 수 있도록).
            if album.art_ext:
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
    return jsonify(
        {
            "added": added,
            "skipped": skipped,
            "albums_missing_art": albums_missing_art,
            "new_albums": new_albums,
        }
    )


@bp.post("/reimport-artists")
def reimport_artists():
    """앨범 아티스트 개념이 생기기 전, 곡 아티스트를 전부 앨범 아티스트로 덮어써
    통일했던 라이브러리를 위한 일회성 복구 도구. 아직 원본 태그가 살아있는 원본
    파일들을(라이브러리에 새로 추가하는 게 아니라 읽기 전용으로) 받아 (제목, 앨범)이
    일치하는 기존 곡을 찾고, 그 곡의 아티스트만 원본 파일의 아티스트 태그로 되돌린다."""
    playlist = playlist_repo.load_or_create_global()

    by_key: dict[tuple[str, str], list] = {}
    for track in playlist.tracks:
        by_key.setdefault((track.title.strip(), track.album.strip()), []).append(track)

    files = request.files.getlist("files[]") or request.files.getlist("files")

    updated, unmatched, ambiguous = [], [], []
    for file_storage in files:
        if not file_storage or not file_storage.filename:
            continue
        suffix = Path(file_storage.filename).suffix.lower()
        if suffix not in SUPPORTED_EXTENSIONS:
            continue

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp_path = tmp.name
        try:
            file_storage.save(tmp_path)
            tags = read_tags(tmp_path)
        finally:
            Path(tmp_path).unlink(missing_ok=True)

        new_artist = tags["artist"].strip()
        if not new_artist:
            continue

        candidates = by_key.get((tags["title"].strip(), tags["album"].strip())) or []
        track = None
        if len(candidates) == 1:
            track = candidates[0]
        elif len(candidates) > 1:
            # 같은 (제목, 앨범)의 곡이 여럿이면(예: 컴필레이션 중복) 재생시간이
            # 가장 근접한 하나만 명확히 특정되는 경우에 한해 매칭한다.
            close = [t for t in candidates if abs(t.duration_ms - tags["duration_ms"]) <= 2000]
            if len(close) == 1:
                track = close[0]

        if track is None:
            (ambiguous if candidates else unmatched).append(file_storage.filename)
            continue
        if track.artist == new_artist:
            continue

        try:
            write_tags(track.path, title=track.title, artist=new_artist, album=track.album)
        except OSError as exc:
            unmatched.append(f"{file_storage.filename} ({exc})")
            continue
        playlist_repo.update_track_in_all_playlists(track.path, artist=new_artist)
        track.artist = new_artist
        updated.append({"title": track.title, "album": track.album, "artist": new_artist})

    applog.log_info(
        "ACTION",
        f"곡 아티스트 재가져오기: {len(updated)}곡 갱신, 매칭 실패 {len(unmatched)}개, 모호 {len(ambiguous)}개",
    )
    return jsonify({"updated": updated, "unmatched": unmatched, "ambiguous": ambiguous})
