"""앨범 객체(앨범명/앨범 아티스트/연도/표지) 저장소.

곡(Track)과 달리 앨범은 곡 파일이 아니라 data/albums.json 인덱스 파일에
저장되고, 표지는 곡 파일 임베드 태그가 아닌 data/album_art/ 아래의 전용
이미지 파일로 관리한다.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

from lyricstorage import storage


@dataclass
class Album:
    id: str
    name: str = ""
    artist: str = ""  # 앨범 아티스트 (곡 아티스트와 별개)
    year: Optional[int] = None
    art_ext: Optional[str] = None  # 표지 파일 확장자("jpg"/"png"), 없으면 None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Album":
        return cls(
            id=data["id"],
            name=data.get("name", ""),
            artist=data.get("artist", ""),
            year=data.get("year"),
            art_ext=data.get("art_ext"),
        )


def load_albums() -> list[Album]:
    path = storage.albums_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return [Album.from_dict(item) for item in data if isinstance(item, dict)]


def save_albums(albums: list[Album]) -> None:
    storage.albums_path().write_text(
        json.dumps([a.to_dict() for a in albums], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def find_album_by_id(album_id: str) -> Optional[Album]:
    for album in load_albums():
        if album.id == album_id:
            return album
    return None


def find_album_by_name(name: str) -> Optional[Album]:
    for album in load_albums():
        if album.name == name:
            return album
    return None


def create_album(name: str, artist: str = "", year: Optional[int] = None) -> Album:
    albums = load_albums()
    album = Album(id=uuid.uuid4().hex[:16], name=name, artist=artist, year=year)
    albums.append(album)
    save_albums(albums)
    return album


def get_or_create_album(name: str, artist: str = "") -> Album:
    existing = find_album_by_name(name)
    if existing is not None:
        return existing
    return create_album(name=name, artist=artist)


def update_album(album_id: str, **fields) -> Optional[Album]:
    albums = load_albums()
    updated = None
    for album in albums:
        if album.id == album_id:
            for key, value in fields.items():
                setattr(album, key, value)
            updated = album
            break
    if updated is not None:
        save_albums(albums)
    return updated


def album_art_path(album_id: str, ext: str) -> Path:
    return storage.album_art_dir() / f"{album_id}.{ext}"


def read_album_cover(album: Album) -> Optional[bytes]:
    if not album.art_ext:
        return None
    path = album_art_path(album.id, album.art_ext)
    if not path.exists():
        return None
    return path.read_bytes()


def write_album_cover(album_id: str, image_bytes: bytes, ext: str) -> None:
    delete_album_cover(album_id)
    album_art_path(album_id, ext).write_bytes(image_bytes)
    update_album(album_id, art_ext=ext)


def delete_album_cover(album_id: str) -> None:
    for existing in storage.album_art_dir().glob(f"{album_id}.*"):
        existing.unlink(missing_ok=True)


def sniff_image_ext(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    return "jpg"
