"""플레이리스트 이름 -> PlaylistModel 조회 헬퍼. 여러 라우트 블루프린트가 공유한다."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from lyricstorage import albums as albums_repo
from lyricstorage import storage
from lyricstorage.web.image_utils import sniff_image_ext
from lyricstorage.models import GLOBAL_PLAYLIST_NAME, PlaylistModel, read_album_art

_OLD_GLOBAL_PLAYLIST_NAME = "기본 플레이리스트"


_old_global_name_checked = False


def _find_playlist_entry(name: str) -> Optional[tuple[Path, dict]]:
    # 찾으면서 이미 파싱한 dict를 함께 돌려줘, 로드할 때 파일을 다시 파싱하지 않는다.
    for saved_name, path, data in PlaylistModel.list_saved_with_data():
        if saved_name == name:
            return path, data
    return None


def find_playlist_path(name: str) -> Optional[Path]:
    entry = _find_playlist_entry(name)
    return entry[0] if entry is not None else None


def load_playlist(name: str) -> Optional[PlaylistModel]:
    entry = _find_playlist_entry(name)
    if entry is None:
        return None
    return PlaylistModel.from_dict(entry[1])


def _migrate_old_global_name() -> None:
    """예전 이름("기본 플레이리스트")으로 저장된 파일이 있으면 새 이름으로 옮긴다."""
    global _old_global_name_checked
    if _old_global_name_checked:
        return
    if find_playlist_path(GLOBAL_PLAYLIST_NAME) is not None:
        # 새 이름 파일이 이미 있으면 더 이상 옮길 게 없다(프로세스당 한 번만 확인).
        _old_global_name_checked = True
        return
    old_path = find_playlist_path(_OLD_GLOBAL_PLAYLIST_NAME)
    if old_path is None:
        return
    playlist = PlaylistModel.load(old_path)
    playlist.name = GLOBAL_PLAYLIST_NAME
    playlist.save()
    old_path.unlink(missing_ok=True)
    _old_global_name_checked = True


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
                ext = sniff_image_ext(art_bytes)
                albums_repo.write_album_cover(album.id, art_bytes, ext)
            album_id = album.id
            album_id_by_key[key] = album_id
        album_id_by_path[track.path] = album_id

    for _name, path, data in PlaylistModel.list_saved_with_data():
        changed_playlist = PlaylistModel.from_dict(data)
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


_global_json_cache: tuple[tuple, list[dict]] | None = None
_global_json_path: Path | None = None


def global_tracks_json() -> list[dict]:
    """글로벌 플레이리스트의 트랙을 track_to_json 형태로 돌려준다(읽기 전용으로
    다룰 것). load_or_create_global()은 저장된 모든 플레이리스트 JSON을 파싱해
    이름을 찾고 곡마다 해시/가사 존재 확인까지 하므로, 홈 화면 API 여러 개가
    요청마다 반복하면 느리다. 글로벌 파일의 mtime/size와 가사 폴더 mtime이 같으면
    직전 결과를 재사용한다(gunicorn workers=1 전제의 모듈 전역 캐시)."""
    global _global_json_cache, _global_json_path
    from lyricstorage import lyrics_io
    from lyricstorage.web.serialize import track_to_json

    path = _global_json_path
    if path is None or not path.exists():
        load_or_create_global()
        path = find_playlist_path(GLOBAL_PLAYLIST_NAME)
        _global_json_path = path
    if path is None:
        return []
    try:
        st = path.stat()
        lyrics_mtime = storage.lyrics_dir().stat().st_mtime_ns
    except OSError:
        _global_json_cache = None
        return [track_to_json(t, lyrics_io.lyrics_stems()) for t in load_or_create_global().tracks]
    sig = (str(path), st.st_mtime_ns, st.st_size, lyrics_mtime)
    cached = _global_json_cache
    if cached is not None and cached[0] == sig:
        return cached[1]
    playlist = load_or_create_global()
    stems = lyrics_io.lyrics_stems()
    tracks = [track_to_json(t, stems) for t in playlist.tracks]
    _global_json_cache = (sig, tracks)
    return tracks


def update_tracks_in_all_playlists(updates: dict[str, dict]) -> None:
    """update_track_in_all_playlists의 배치 버전. updates는 {track_path: {필드: 값}}.
    플레이리스트당 로드/저장을 한 번만 한다."""
    if not updates:
        return
    for _name, path, data in PlaylistModel.list_saved_with_data():
        playlist = PlaylistModel.from_dict(data)
        changed = False
        for track in playlist.tracks:
            fields = updates.get(track.path)
            if fields is not None:
                for key, value in fields.items():
                    setattr(track, key, value)
                changed = True
        if changed:
            playlist.save()


def update_track_in_all_playlists(track_path: str, **fields) -> None:
    """같은 음원 파일(경로)이 여러 플레이리스트에 독립된 Track 사본으로 존재하므로,
    곡 정보 수정이 모든 사본에 일관되게 반영되도록 전체 플레이리스트를 훑어 갱신한다."""
    update_tracks_in_all_playlists({track_path: fields})


def find_tracks_by_album_id(album_id: str) -> list:
    playlist = load_or_create_global()
    return [t for t in playlist.tracks if t.album_id == album_id]


def update_tracks_by_album_id(album_id: str, **fields) -> None:
    """앨범명이 바뀌었을 때, 그 앨범에 속한 모든 트랙 사본(전체 플레이리스트)의
    캐시된 필드(예: album)를 일괄 갱신한다."""
    for _name, path, data in PlaylistModel.list_saved_with_data():
        playlist = PlaylistModel.from_dict(data)
        changed = False
        for track in playlist.tracks:
            if track.album_id == album_id:
                for key, value in fields.items():
                    setattr(track, key, value)
                changed = True
        if changed:
            playlist.save()


def remove_tracks_from_all_playlists(track_paths) -> None:
    """remove_track_from_all_playlists의 배치 버전. 플레이리스트당 로드/저장을 한 번만
    한다. 물리 파일 삭제는 호출자 책임."""
    paths = set(track_paths)
    if not paths:
        return
    for _name, path, data in PlaylistModel.list_saved_with_data():
        playlist = PlaylistModel.from_dict(data)
        before = len(playlist.tracks)
        playlist.tracks = [t for t in playlist.tracks if t.path not in paths]
        if len(playlist.tracks) != before:
            playlist.save()


def remove_track_from_all_playlists(track_path: str) -> None:
    """완전 삭제 시, 같은 파일을 가리키는 모든 플레이리스트(글로벌 포함)의
    Track 사본을 전부 제거한다. 물리 파일 삭제는 호출자 책임."""
    remove_tracks_from_all_playlists([track_path])
