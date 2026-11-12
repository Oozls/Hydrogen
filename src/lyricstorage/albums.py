"""앨범 객체(앨범명/앨범 아티스트/연도/표지) 저장소.

곡(Track)과 달리 앨범은 곡 파일이 아니라 data/albums.json 인덱스 파일에
저장되고, 표지는 곡 파일 임베드 태그가 아닌 data/album_art/ 아래의 전용
이미지 파일로 관리한다.
"""

from __future__ import annotations

import json
import threading
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


# albums.json 파싱 결과 캐시: (mtime_ns, size) -> 앨범 dict 리스트. 호출자가 반환된
# Album을 수정해도 캐시가 오염되지 않도록, 캐시에는 dict만 두고 호출마다 새 Album을 만든다.
_cache_lock = threading.Lock()
_cache: tuple[tuple[int, int], list[dict]] | None = None


def _file_signature(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def load_albums() -> list[Album]:
    global _cache
    path = storage.albums_path()
    signature = _file_signature(path)
    if signature is None:
        return []
    with _cache_lock:
        cached = _cache
    if cached is not None and cached[0] == signature:
        return [Album.from_dict(item) for item in cached[1]]
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    items = [item for item in data if isinstance(item, dict)]
    with _cache_lock:
        _cache = (signature, items)
    return [Album.from_dict(item) for item in items]


def save_albums(albums: list[Album]) -> None:
    global _cache
    path = storage.albums_path()
    path.write_text(
        json.dumps([a.to_dict() for a in albums], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    # 다음 load_albums()가 새 mtime/size로 파일을 다시 읽도록 캐시를 비운다.
    with _cache_lock:
        _cache = None


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


def write_album_cover(album_id: str, image_bytes: bytes, ext: str) -> None:
    delete_album_cover(album_id)
    album_art_path(album_id, ext).write_bytes(image_bytes)
    update_album(album_id, art_ext=ext)


def delete_album(album_id: str) -> bool:
    """앨범 레코드(albums.json)와 전용 표지 파일을 제거한다. 곡 정리는 호출자 몫."""
    albums = load_albums()
    kept = [a for a in albums if a.id != album_id]
    delete_album_cover(album_id)
    if len(kept) == len(albums):
        return False
    save_albums(kept)
    return True


def delete_album_cover(album_id: str) -> None:
    for existing in storage.album_art_dir().glob(f"{album_id}.*"):
        existing.unlink(missing_ok=True)
