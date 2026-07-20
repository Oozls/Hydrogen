"""Track / PlaylistModel -> JSON 직렬화 헬퍼."""

from __future__ import annotations

from lyricstorage import storage
from lyricstorage.models import GLOBAL_PLAYLIST_NAME, PlaylistModel, Track


def track_to_json(track: Track) -> dict:
    return {
        "track_id": storage.path_hash(track.path),
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "duration_ms": track.duration_ms,
        "has_lyrics": track.has_lyrics,
    }


def playlist_to_json(playlist: PlaylistModel) -> dict:
    return {
        "name": playlist.name,
        "is_global": playlist.name == GLOBAL_PLAYLIST_NAME,
        "tracks": [track_to_json(t) for t in playlist.tracks],
    }
