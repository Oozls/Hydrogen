"""이름 문자열을 "대표 이름 + 이명" 정체성으로 묶는 범용 레지스트리.

곡 아티스트(artists.py)와 서클/앨범 아티스트(circles.py)가 저장 파일 경로만
다르게 넘겨 이 모듈 하나를 공유한다 — 표기 흔들림을 하나로 묶는 로직 자체는
"어떤 이름들을 묶을지"와 무관하게 동일하기 때문이다.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class Identity:
    id: str
    name: str = ""
    aliases: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "aliases": list(self.aliases)}

    @classmethod
    def from_dict(cls, data: dict) -> "Identity":
        return cls(id=data["id"], name=data.get("name", ""), aliases=list(data.get("aliases") or []))


def load(path: Path) -> list[Identity]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    return [Identity.from_dict(item) for item in data if isinstance(item, dict)]


def save(path: Path, identities: list[Identity]) -> None:
    path.write_text(
        json.dumps([i.to_dict() for i in identities], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def find_by_id(path: Path, identity_id: str) -> Optional[Identity]:
    for identity in load(path):
        if identity.id == identity_id:
            return identity
    return None


def find_by_name(path: Path, name: str) -> Optional[Identity]:
    """name이 어떤 정체성의 대표 이름이거나 이명 목록에 있으면 그 정체성을 반환한다."""
    for identity in load(path):
        if identity.name == name or name in identity.aliases:
            return identity
    return None


def get_or_create(path: Path, name: str) -> Identity:
    existing = find_by_name(path, name)
    if existing is not None:
        return existing
    identities = load(path)
    identity = Identity(id=uuid.uuid4().hex[:16], name=name, aliases=[])
    identities.append(identity)
    save(path, identities)
    return identity


def rename(path: Path, identity_id: str, new_name: str) -> Optional[Identity]:
    """대표 이름을 바꾼다. 예전 대표 이름은 이명으로 남겨서, 이미 곡/기록에
    남아있는 옛 이름도 계속 이 정체성으로 인식되게 한다."""
    identities = load(path)
    updated = None
    for identity in identities:
        if identity.id == identity_id:
            old_name = identity.name
            if old_name and old_name != new_name and old_name not in identity.aliases:
                identity.aliases.append(old_name)
            if new_name in identity.aliases:
                identity.aliases.remove(new_name)
            identity.name = new_name
            updated = identity
            break
    if updated is not None:
        save(path, identities)
    return updated


def add_alias(path: Path, identity_id: str, alias: str) -> Optional[Identity]:
    """이명을 추가한다. 그 이름이 이미 다른 정체성으로 등록돼 있으면 두 정체성을
    하나로 합친다 — 같은 이름이 두 레코드에 걸쳐 있으면 어느 쪽으로 풀릴지
    애매해지기 때문."""
    alias = alias.strip()
    identities = load(path)
    target = next((i for i in identities if i.id == identity_id), None)
    if target is None:
        return None
    if not alias or alias == target.name:
        return target

    conflicting = next(
        (i for i in identities if i.id != identity_id and (i.name == alias or alias in i.aliases)), None
    )
    if conflicting is not None:
        for name in [conflicting.name, *conflicting.aliases]:
            if name and name != target.name and name not in target.aliases:
                target.aliases.append(name)
        identities = [i for i in identities if i.id != conflicting.id]
    elif alias not in target.aliases:
        target.aliases.append(alias)

    save(path, identities)
    return target


def remove_alias(path: Path, identity_id: str, alias: str) -> Optional[Identity]:
    identities = load(path)
    target = next((i for i in identities if i.id == identity_id), None)
    if target is None:
        return None
    if alias in target.aliases:
        target.aliases.remove(alias)
        save(path, identities)
    return target


def name_resolver(path: Path) -> dict[str, str]:
    """이름 문자열 -> 대표 이름 매핑 전체를 한 번에 반환한다. 통계 집계처럼 많은
    이름을 반복해서 찾아볼 때 매번 파일을 다시 읽지 않도록 일괄 조회용으로 쓴다."""
    resolver: dict[str, str] = {}
    for identity in load(path):
        resolver[identity.name] = identity.name
        for alias in identity.aliases:
            resolver[alias] = identity.name
    return resolver


def _demo() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "identities.json"

        a = get_or_create(path, "AAA")
        b = get_or_create(path, "BBB")
        assert get_or_create(path, "AAA").id == a.id  # 같은 이름 재호출 -> 같은 정체성

        rename(path, a.id, "AAA (신)")
        resolved = find_by_name(path, "AAA")
        assert resolved is not None and resolved.name == "AAA (신)"  # 옛 이름도 여전히 찾아짐

        # 서로 다른 정체성으로 각자 등록됐던 이름을 이명으로 합치면 하나로 병합돼야 함
        add_alias(path, a.id, "BBB")
        assert find_by_id(path, b.id) is None
        merged = find_by_id(path, a.id)
        assert merged is not None and "BBB" in merged.aliases

        resolver = name_resolver(path)
        assert resolver["BBB"] == "AAA (신)"
        assert resolver["AAA (신)"] == "AAA (신)"

    print("identity_registry self-check OK")


if __name__ == "__main__":
    _demo()
