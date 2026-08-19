"""Track / PlaylistModel -> JSON 직렬화 헬퍼."""

from __future__ import annotations

from pathlib import Path

from lyricstorage import lyrics_io, storage
from lyricstorage.albums import Album
from lyricstorage.models import GLOBAL_PLAYLIST_NAME, PlaylistModel, Track


def track_to_json(track: Track, lyrics_stems: set[str] | None = None) -> dict:
    # lyrics_stems가 넘어오면(플레이리스트 전체를 직렬화하는 호출자가 한 번만
    # 계산해 재사용) 트랙마다 파일 존재 여부를 stat()하는 track.has_lyrics 대신
    # 메모리에서 집합 조회로 끝낸다.
    has_lyrics = (
        Path(track.path).stem in lyrics_stems if lyrics_stems is not None else track.has_lyrics
    )
    return {
        "track_id": storage.path_hash(track.path),
        "title": track.title,
        "artist": track.artist,
        "album": track.album,
        "album_id": track.album_id,
        "duration_ms": track.duration_ms,
        "has_lyrics": has_lyrics,
        "rating": track.rating,
        "added_at": track.added_at,
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
    stems = lyrics_io.lyrics_stems()
    return {
        "name": playlist.name,
        "is_global": playlist.name == GLOBAL_PLAYLIST_NAME,
        "tracks": [track_to_json(t, stems) for t in playlist.tracks],
    }
