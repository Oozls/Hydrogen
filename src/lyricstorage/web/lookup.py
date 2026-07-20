"""트랙 id(경로 해시) -> Track 조회.

모든 플레이리스트를 훑어 일치하는 트랙을 찾는다. 콘텐츠 해시 기반 저장 덕분에
같은 곡은 어느 플레이리스트에 있든 동일한 path를 가지므로, 전역 라이브러리
하나만 훑어도 충분하지만 견고성을 위해 전체 플레이리스트를 대상으로 한다.
"""

from __future__ import annotations

from typing import Optional

from lyricstorage import storage
from lyricstorage.models import PlaylistModel, Track


def find_track_by_id(track_id: str) -> Optional[Track]:
    for _name, path in PlaylistModel.list_saved_names():
        try:
            playlist = PlaylistModel.load(path)
        except (OSError, ValueError, KeyError):
            continue
        for track in playlist.tracks:
            if storage.path_hash(track.path) == track_id:
                return track
    return None
