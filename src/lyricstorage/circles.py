"""서클(앨범 아티스트) 이명 등록소.

Album.artist도 곡 아티스트와 같은 이유로 표기가 흔들릴 수 있다(앨범마다 서클명
표기가 조금씩 다른 경우 등). artists.py와 동일한 구조를 identity_registry.py를
통해 공유하되, 서클용 저장 파일(circles.json)에 따로 담는다.
"""

from __future__ import annotations

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


_registry = registry.Registry(lambda: storage.circles_path())

load_circles = _registry.load
save_circles = _registry.save
find_circle_by_id = _registry.find_by_id
find_circle_by_name = _registry.find_by_name
get_or_create_circle = _registry.get_or_create
rename_circle = _registry.rename
add_alias = _registry.add_alias
remove_alias = _registry.remove_alias
name_resolver = _registry.name_resolver
