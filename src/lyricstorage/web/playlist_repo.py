"""플레이리스트 이름 -> PlaylistModel 조회 헬퍼. 여러 라우트 블루프린트가 공유한다."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from lyricstorage.models import GLOBAL_PLAYLIST_NAME, PlaylistModel


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


def load_or_create_global() -> PlaylistModel:
    playlist = load_playlist(GLOBAL_PLAYLIST_NAME)
    if playlist is None:
        playlist = PlaylistModel(GLOBAL_PLAYLIST_NAME)
        playlist.save()
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
