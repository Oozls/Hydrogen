"""곡 아티스트 이명(별칭) 등록소.

곡(Track)의 artist 필드는 순수 문자열이라 같은 사람이 여러 이름으로 활동하면
통계/아티스트 상세 화면에서 서로 다른 사람처럼 갈라져 보인다. 이 모듈은 그
문자열들을 하나의 "정체성"(대표 이름 + 이명 목록)으로 묶어주는 가벼운 매핑
테이블만 관리한다 — 곡 파일이나 Track.artist 문자열 자체는 건드리지 않는다.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Optional

from lyricstorage import storage


@dataclass
class Artist:
    id: str
    name: str = ""
    aliases: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "aliases": list(self.aliases)}

    @classmethod
    def from_dict(cls, data: dict) -> "Artist":
        return cls(id=data["id"], name=data.get("name", ""), aliases=list(data.get("aliases") or []))


def load_artists() -> list[Artist]:
    path = storage.artists_path()
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return [Artist.from_dict(item) for item in data if isinstance(item, dict)]


def save_artists(artists: list[Artist]) -> None:
    storage.artists_path().write_text(
        json.dumps([a.to_dict() for a in artists], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def find_artist_by_id(artist_id: str) -> Optional[Artist]:
    for artist in load_artists():
        if artist.id == artist_id:
            return artist
    return None


def find_artist_by_name(name: str) -> Optional[Artist]:
    """name이 어떤 아티스트의 대표 이름이거나 이명 목록에 있으면 그 아티스트를 반환한다."""
    for artist in load_artists():
        if artist.name == name or name in artist.aliases:
            return artist
    return None


def get_or_create_artist(name: str) -> Artist:
    existing = find_artist_by_name(name)
    if existing is not None:
        return existing
    artists = load_artists()
    artist = Artist(id=uuid.uuid4().hex[:16], name=name, aliases=[])
    artists.append(artist)
    save_artists(artists)
    return artist


def rename_artist(artist_id: str, new_name: str) -> Optional[Artist]:
    """대표 이름을 바꾼다. 예전 대표 이름은 이명으로 남겨서, 이미 곡/기록에
    남아있는 옛 이름도 계속 이 정체성으로 인식되게 한다."""
    artists = load_artists()
    updated = None
    for artist in artists:
        if artist.id == artist_id:
            old_name = artist.name
            if old_name and old_name != new_name and old_name not in artist.aliases:
                artist.aliases.append(old_name)
            if new_name in artist.aliases:
                artist.aliases.remove(new_name)
            artist.name = new_name
            updated = artist
            break
    if updated is not None:
        save_artists(artists)
    return updated


def add_alias(artist_id: str, alias: str) -> Optional[Artist]:
    """이명을 추가한다. 그 이름이 이미 다른 정체성으로 등록돼 있으면(별개로
    처음 열어봐서 각자 빈 이명으로 자동 생성된 경우 등) 두 정체성을 하나로
    합친다 — 같은 이름이 두 레코드에 걸쳐 있으면 어느 쪽으로 풀릴지 애매해지기
    때문."""
    alias = alias.strip()
    artists = load_artists()
    target = next((a for a in artists if a.id == artist_id), None)
    if target is None:
        return None
    if not alias or alias == target.name:
        return target

    conflicting = next((a for a in artists if a.id != artist_id and (a.name == alias or alias in a.aliases)), None)
    if conflicting is not None:
        for name in [conflicting.name, *conflicting.aliases]:
            if name and name != target.name and name not in target.aliases:
                target.aliases.append(name)
        artists = [a for a in artists if a.id != conflicting.id]
    elif alias not in target.aliases:
        target.aliases.append(alias)

    save_artists(artists)
    return target


def remove_alias(artist_id: str, alias: str) -> Optional[Artist]:
    artists = load_artists()
    target = next((a for a in artists if a.id == artist_id), None)
    if target is None:
        return None
    if alias in target.aliases:
        target.aliases.remove(alias)
        save_artists(artists)
    return target


def name_resolver() -> dict[str, str]:
    """트랙에 적힌 아티스트 문자열 -> 대표 이름 매핑 전체를 한 번에 반환한다.
    통계 집계처럼 많은 이름을 반복해서 찾아볼 때 매번 파일을 다시 읽지
    않도록 일괄 조회용으로 쓴다."""
    resolver: dict[str, str] = {}
    for artist in load_artists():
        resolver[artist.name] = artist.name
        for alias in artist.aliases:
            resolver[alias] = artist.name
    return resolver
