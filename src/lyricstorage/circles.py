"""서클(앨범 아티스트) 이명 등록소.

Album.artist도 곡 아티스트와 같은 이유로 표기가 흔들릴 수 있다(앨범마다 서클명
표기가 조금씩 다른 경우 등). artists.py와 동일한 구조를 identity_registry.py를
통해 공유하되, 서클용 저장 파일(circles.json)에 따로 담는다.
"""

from __future__ import annotations

from typing import Optional

from lyricstorage import identity_registry as registry
from lyricstorage import storage
from lyricstorage.identity_registry import Identity as Circle

__all__ = [
    "Circle",
    "load_circles",
    "save_circles",
    "find_circle_by_id",
    "find_circle_by_name",
    "get_or_create_circle",
    "rename_circle",
    "add_alias",
    "remove_alias",
    "name_resolver",
]


def load_circles() -> list[Circle]:
    return registry.load(storage.circles_path())


def save_circles(circles: list[Circle]) -> None:
    registry.save(storage.circles_path(), circles)


def find_circle_by_id(circle_id: str) -> Optional[Circle]:
    return registry.find_by_id(storage.circles_path(), circle_id)


def find_circle_by_name(name: str) -> Optional[Circle]:
    return registry.find_by_name(storage.circles_path(), name)


def get_or_create_circle(name: str) -> Circle:
    return registry.get_or_create(storage.circles_path(), name)


def rename_circle(circle_id: str, new_name: str) -> Optional[Circle]:
    return registry.rename(storage.circles_path(), circle_id, new_name)


def add_alias(circle_id: str, alias: str) -> Optional[Circle]:
    return registry.add_alias(storage.circles_path(), circle_id, alias)


def remove_alias(circle_id: str, alias: str) -> Optional[Circle]:
    return registry.remove_alias(storage.circles_path(), circle_id, alias)


def name_resolver() -> dict[str, str]:
    return registry.name_resolver(storage.circles_path())
