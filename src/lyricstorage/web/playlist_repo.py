"""플레이리스트 이름 -> PlaylistModel 조회 헬퍼. 여러 라우트 블루프린트가 공유한다."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from lyricstorage import albums as albums_repo
from lyricstorage import storage
from lyricstorage.models import GLOBAL_PLAYLIST_NAME, PlaylistModel, read_album_art

_OLD_GLOBAL_PLAYLIST_NAME = "기본 플레이리스트"


def find_playlist_path(name: str) -> Optional[Path]:
    for saved_name, path in PlaylistModel.list_saved_names():
        if saved_name == name:
            return path
    return None


def load_playlist(name: str) -> Optional[PlaylistModel]:
    path = find_playlist_path(name)
    if path is None:
        return None
    return PlaylistModel.load(path)


def _migrate_old_global_name() -> None:
    """예전 이름("기본 플레이리스트")으로 저장된 파일이 있으면 새 이름으로 옮긴다."""
    if find_playlist_path(GLOBAL_PLAYLIST_NAME) is not None:
        return
    old_path = find_playlist_path(_OLD_GLOBAL_PLAYLIST_NAME)
    if old_path is None:
        return
    playlist = PlaylistModel.load(old_path)
    playlist.name = GLOBAL_PLAYLIST_NAME
    playlist.save()
    old_path.unlink(missing_ok=True)


def _migrate_track_albums() -> None:
    """앨범을 (album, artist) 문자열 쌍이 아닌 독립된 Album 객체로 승격시킨다.
    data/albums.json이 이미 있으면(=이미 마이그레이션됨) 아무 것도 하지 않는다."""
    if storage.albums_path().exists():
        return

    playlist = load_playlist(GLOBAL_PLAYLIST_NAME)
    if playlist is None:
        storage.albums_path().write_text("[]", encoding="utf-8")
        return

    album_id_by_path: dict[str, str] = {}
    album_id_by_key: dict[tuple[str, str], str] = {}
    for track in playlist.tracks:
        key = (track.album, track.artist)
        album_id = album_id_by_key.get(key)
        if album_id is None:
            album = albums_repo.create_album(name=track.album, artist=track.artist)
            art_bytes = read_album_art(track.path)
            if art_bytes:
                ext = albums_repo.sniff_image_ext(art_bytes)
                albums_repo.write_album_cover(album.id, art_bytes, ext)
            album_id = album.id
            album_id_by_key[key] = album_id
        album_id_by_path[track.path] = album_id

    for _name, path in PlaylistModel.list_saved_names():
        changed_playlist = PlaylistModel.load(path)
        changed = False
        for track in changed_playlist.tracks:
            album_id = album_id_by_path.get(track.path)
            if album_id and track.album_id != album_id:
                track.album_id = album_id
                changed = True
        if changed:
            changed_playlist.save()


def load_or_create_global() -> PlaylistModel:
    _migrate_old_global_name()
    playlist = load_playlist(GLOBAL_PLAYLIST_NAME)
    if playlist is None:
        playlist = PlaylistModel(GLOBAL_PLAYLIST_NAME)
        playlist.save()
    _migrate_track_albums()
    return playlist


def update_track_in_all_playlists(track_path: str, **fields) -> None:
    """같은 음원 파일(경로)이 여러 플레이리스트에 독립된 Track 사본으로 존재하므로,
    곡 정보 수정이 모든 사본에 일관되게 반영되도록 전체 플레이리스트를 훑어 갱신한다."""
    for _name, path in PlaylistModel.list_saved_names():
        playlist = PlaylistModel.load(path)
        changed = False
        for track in playlist.tracks:
            if track.path == track_path:
                for key, value in fields.items():
                    setattr(track, key, value)
                changed = True
        if changed:
            playlist.save()


def find_tracks_by_album_id(album_id: str) -> list:
    playlist = load_or_create_global()
    return [t for t in playlist.tracks if t.album_id == album_id]


def update_tracks_by_album_id(album_id: str, **fields) -> None:
    """앨범명이 바뀌었을 때, 그 앨범에 속한 모든 트랙 사본(전체 플레이리스트)의
    캐시된 필드(예: album)를 일괄 갱신한다."""
    for _name, path in PlaylistModel.list_saved_names():
        playlist = PlaylistModel.load(path)
        changed = False
        for track in playlist.tracks:
            if track.album_id == album_id:
                for key, value in fields.items():
                    setattr(track, key, value)
                changed = True
        if changed:
            playlist.save()


def remove_track_from_all_playlists(track_path: str) -> None:
    """완전 삭제 시, 같은 파일을 가리키는 모든 플레이리스트(글로벌 포함)의
    Track 사본을 전부 제거한다. 물리 파일 삭제는 호출자 책임."""
    for _name, path in PlaylistModel.list_saved_names():
        playlist = PlaylistModel.load(path)
        before = len(playlist.tracks)
        playlist.tracks = [t for t in playlist.tracks if t.path != track_path]
        if len(playlist.tracks) != before:
            playlist.save()
