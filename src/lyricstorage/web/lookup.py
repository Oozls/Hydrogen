"""트랙 id(경로 해시) -> Track 조회.

모든 플레이리스트를 대상으로 한다(어느 플레이리스트에만 남은 고아 곡도 찾을 수
있도록). 매 요청마다 전 플레이리스트를 파싱하지 않도록 {track_id: Track} 인덱스를
메모리에 캐시하고, 플레이리스트 파일이 바뀌면(저장/삭제/이름변경/외부 수정) 다시
만든다. 캐시 유효성은 (PlaylistModel.save 카운터, playlists 폴더의 파일별
mtime/크기) 시그니처로 매 호출마다 값싸게 확인한다.
"""

from __future__ import annotations

import json
from dataclasses import replace
from typing import Optional

from lyricstorage import applog, storage
from lyricstorage.models import PlaylistModel, Track, playlist_save_generation

# (generation, signature, index) 튜플을 통째로 교체하는 방식이라 락 없이도 안전하다.
_cache: Optional[tuple[int, tuple, dict[str, Track]]] = None


def _signature() -> tuple:
    sig = []
    for path in sorted(storage.playlists_dir().glob("*.json")):
        try:
            st = path.stat()
        except OSError:
            continue
        sig.append((path.name, st.st_mtime_ns, st.st_size))
    return tuple(sig)


def _build_index() -> tuple[int, tuple, dict[str, Track]]:
    # 시그니처/카운터를 파일을 읽기 전에 찍어, 읽는 도중 변경이 있었다면 다음
    # 호출에서 불일치로 감지돼 다시 만들어지게 한다.
    generation = playlist_save_generation()
    signature = _signature()
    index: dict[str, Track] = {}
    for path in sorted(storage.playlists_dir().glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            applog.log_error("PLAYLIST", f"플레이리스트 파일을 읽지 못했습니다: {path} ({exc})")
            continue
        try:
            playlist = PlaylistModel.from_dict(data)
        except (OSError, ValueError, KeyError):
            continue
        for track in playlist.tracks:
            index.setdefault(storage.path_hash(track.path), track)  # 먼저 나온 사본 우선
    return generation, signature, index


def _is_fresh(cache) -> bool:
    return (
        cache is not None
        and cache[0] == playlist_save_generation()
        and cache[1] == _signature()
    )


def find_track_by_id(track_id: str) -> Optional[Track]:
    global _cache
    cache = _cache
    rebuilt = False
    if not _is_fresh(cache):
        cache = _cache = _build_index()
        rebuilt = True
    track = cache[2].get(track_id)
    if track is None and not rebuilt:
        # 캐시가 낡았을 가능성에 대비해 못 찾았을 때는 한 번 다시 만들어 확인한다.
        cache = _cache = _build_index()
        track = cache[2].get(track_id)
    # 호출자가 반환된 Track을 직접 수정하므로 캐시 원본 대신 사본을 돌려준다.
    return replace(track) if track is not None else None
