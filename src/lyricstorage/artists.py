"""곡 아티스트 이명(별칭) 등록소.

곡(Track)의 artist 필드는 순수 문자열이라 같은 사람이 여러 이름으로 활동하면
통계/아티스트 상세 화면에서 서로 다른 사람처럼 갈라져 보인다. 이 모듈은 그
문자열들을 하나의 "정체성"(대표 이름 + 이명 목록)으로 묶어주는 가벼운 매핑
테이블만 관리한다 — 곡 파일이나 Track.artist 문자열 자체는 건드리지 않는다.

실제 저장/조회 로직은 identity_registry.py를 서클(circles.py)과 공유하고,
이 모듈은 "곡 아티스트용 저장 파일이 뭔지"만 안다.
"""

from __future__ import annotations

from typing import Optional

from lyricstorage import identity_registry as registry
from lyricstorage import storage
from lyricstorage.identity_registry import Identity as Artist

__all__ = [
    "Artist",
    "load_artists",
    "save_artists",
    "find_artist_by_id",
    "find_artist_by_name",
    "get_or_create_artist",
    "rename_artist",
    "add_alias",
    "remove_alias",
    "name_resolver",
]


def load_artists() -> list[Artist]:
    return registry.load(storage.artists_path())


def save_artists(artists: list[Artist]) -> None:
    registry.save(storage.artists_path(), artists)


def find_artist_by_id(artist_id: str) -> Optional[Artist]:
    return registry.find_by_id(storage.artists_path(), artist_id)


def find_artist_by_name(name: str) -> Optional[Artist]:
    return registry.find_by_name(storage.artists_path(), name)


def get_or_create_artist(name: str) -> Artist:
    return registry.get_or_create(storage.artists_path(), name)


def rename_artist(artist_id: str, new_name: str) -> Optional[Artist]:
    return registry.rename(storage.artists_path(), artist_id, new_name)


def add_alias(artist_id: str, alias: str) -> Optional[Artist]:
    return registry.add_alias(storage.artists_path(), artist_id, alias)


def remove_alias(artist_id: str, alias: str) -> Optional[Artist]:
    return registry.remove_alias(storage.artists_path(), artist_id, alias)


def name_resolver() -> dict[str, str]:
    return registry.name_resolver(storage.artists_path())
