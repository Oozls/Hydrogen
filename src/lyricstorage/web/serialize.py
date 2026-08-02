"""Track / PlaylistModel -> JSON 직렬화 헬퍼."""

from __future__ import annotations

from lyricstorage import storage
from lyricstorage.albums import Album
from lyricstorage.models import GLOBAL_PLAYLIST_NAME, PlaylistModel, Track


def track_to_json(track: Track) -> dict:
    return {
        "track_id": storage.path_hash(track.path),
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "album_id": track.album_id,
        "duration_ms": track.duration_ms,
        "has_lyrics": track.has_lyrics,
        "rating": track.rating,
    }


def album_to_json(album: Album, track_count: int = 0) -> dict:
    return {
        "id": album.id,
        "name": album.name,
        "artist": album.artist,
        "year": album.year,
        "has_art": bool(album.art_ext),
        "track_count": track_count,
    }


def playlist_to_json(playlist: PlaylistModel) -> dict:
    return {
        "name": playlist.name,
        "is_global": playlist.name == GLOBAL_PLAYLIST_NAME,
        "tracks": [track_to_json(t) for t in playlist.tracks],
    }
