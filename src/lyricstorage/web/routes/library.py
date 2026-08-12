"""라이브러리(기본 플레이리스트) 조회 및 업로드 API. 오직 이 라우트만 파일 업로드를 허용한다."""

from __future__ import annotations

import tempfile
from dataclasses import replace
from pathlib import Path

from flask import Blueprint, jsonify, request

from lyricstorage import albums as albums_repo
from lyricstorage import applog, storage
from lyricstorage import circles as circles_repo
from lyricstorage.models import (
    GLOBAL_PLAYLIST_NAME,
    SUPPORTED_EXTENSIONS,
    PlaylistModel,
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


@bp.post("/rebuild")
def rebuild_global():
    """data/songs 폴더(음원 실 파일)를 다시 스캔해 글로벌 플레이리스트 인덱스를
    통째로 재구성한다. 인덱스 파일이 유실/손상됐을 때 쓰는 복구용 기능이라, 파일
    태그에 없는 레이팅만 기존 값에서 되살리고 나머지(재생목록 구성 등)는 각자
    다시 정리해야 한다."""
    old_playlist = playlist_repo.load_playlist(GLOBAL_PLAYLIST_NAME)
    old_ratings = {t.path: t.rating for t in old_playlist.tracks} if old_playlist else {}

    playlist = PlaylistModel(GLOBAL_PLAYLIST_NAME)
    skipped = []
    found = sorted(p for ext in SUPPORTED_EXTENSIONS for p in storage.songs_dir().glob(f"*{ext}"))
    for audio_path in found:
        try:
            track = playlist.add_file(str(audio_path))
        except (ValueError, OSError) as exc:
            skipped.append({"filename": audio_path.name, "reason": str(exc)})
            continue
        if track.path in old_ratings:
            track.rating = old_ratings[track.path]

    # 스캔 순서(해시 파일명)는 사실상 무작위라, 서클(앨범 아티스트) -> 앨범 ->
    # 곡 제목 순으로 다시 정렬해 브라우즈 화면의 그룹핑과 결이 맞게 만든다.
    circle_resolver = circles_repo.name_resolver()
    album_by_id = {a.id: a for a in albums_repo.load_albums()}

    def sort_key(track):
        album = album_by_id.get(track.album_id)
        artist = album.artist if album else track.artist
        album_name = album.name if album else track.album
        circle = circle_resolver.get(artist, artist)
        return (circle, album_name, track.title)

    playlist.tracks.sort(key=sort_key)
    playlist.save()

    applog.log_info(
        "ACTION",
        f"글로벌 플레이리스트 재작성: {len(playlist.tracks)}곡, 스킵 {len(skipped)}개",
    )
    return jsonify(
        {"playlist": playlist_to_json(playlist), "track_count": len(playlist.tracks), "skipped": skipped}
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
