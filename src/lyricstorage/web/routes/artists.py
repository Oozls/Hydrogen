"""곡 아티스트 이명(별칭)/대표 이름 관리 API. 구현은 _identity.py 공용."""

from __future__ import annotations

from lyricstorage import artists as artists_repo
from lyricstorage.web.routes._identity import make_identity_blueprint

bp = make_identity_blueprint("artist", "artists", artists_repo._registry)
