"""곡/앨범/서클 완전 삭제.

"완전 삭제"는 음원 파일만 지우는 게 아니라 그 곡의 흔적을 기록에서도 전부 없앤다:
모든 플레이리스트의 사본, 가사와 가사 백업, 재생 기록, 추천 노출 이력, 그리고
곡이 하나도 안 남은 앨범(레코드+표지). 휴지통으로 옮기지 않으므로 되돌릴 수 없다.
곡/앨범/서클 삭제 라우트가 전부 이 모듈 하나를 거치게 해서 지우는 범위가
화면마다 달라지지 않게 한다.
"""

from __future__ import annotations

from pathlib import Path

from lyricstorage import albums as albums_repo
from lyricstorage import applog, circles, lyrics_io, storage
from lyricstorage.identity_registry import Identity
from lyricstorage.models import Track
from lyricstorage.web import playlist_repo


def purge_tracks(tracks: list[Track]) -> tuple[list[str], list[dict]]:
    """곡들을 완전 삭제한다. (삭제된 track_id 목록, 실패 목록)을 돌려준다.
    음원 파일을 못 지운 곡(Windows 파일 잠금 등)은 목록/기록을 그대로 두고 실패로
    보고한다 — 파일만 남고 기록이 사라지는 반쯤 지워진 상태를 피하기 위함."""
    done: list[Track] = []
    errors: list[dict] = []
    for track in tracks:
        try:
            storage.unlink_retrying(Path(track.path), missing_ok=True)
        except OSError as exc:
            errors.append({"track_id": storage.path_hash(track.path), "reason": str(exc)})
            continue
        done.append(track)

    ids = {storage.path_hash(t.path) for t in done}
    playlist_repo.remove_tracks_from_all_playlists([t.path for t in done])
    for track in done:
        try:
            lyrics_io.purge_lyrics(track.path)
        except OSError as exc:
            applog.log_info("ACTION", f"가사 파일 삭제 실패(무시): {track.path}: {exc}")
    storage.purge_play_history(ids)
    storage.purge_recommend_exposures(ids)

    # 곡이 하나도 안 남은 앨범은 레코드와 표지까지 지운다.
    touched_albums = {t.album_id for t in done if t.album_id}
    if touched_albums:
        remaining = {t.album_id for t in playlist_repo.load_or_create_global().tracks}
        for album_id in touched_albums - remaining:
            albums_repo.delete_album(album_id)

    storage.invalidate_data_size_cache()
    return sorted(ids), errors


def purge_album(album_id: str) -> tuple[list[str], list[dict]]:
    """앨범과 그 앨범의 모든 곡을 완전 삭제한다. 곡 삭제에 실패한 게 있으면 앨범
    레코드는 남긴다(남은 곡이 가리키는 앨범이 사라지면 안 되므로)."""
    ids, errors = purge_tracks(playlist_repo.find_tracks_by_album_id(album_id))
    if not errors:
        albums_repo.delete_album(album_id)
    return ids, errors


def purge_circle(circle: Identity) -> dict:
    """서클(대표 이름 + 이명)을 삭제한다. 그 서클 단독 앨범은 곡까지 완전 삭제하고,
    다른 서클과 함께 참여한 앨범은 앨범/곡은 남긴 채 앨범 아티스트에서 이 서클
    이름만 뺀다."""
    names = {circle.name, *circle.aliases}
    deleted_albums = 0
    trimmed_albums = 0
    deleted_tracks: list[str] = []
    errors: list[dict] = []
    for album in albums_repo.load_albums():
        album_circles = circles.split_names(album.artist)
        mine = [n for n in album_circles if n in names]
        if not mine:
            continue
        others = [n for n in album_circles if n not in names]
        if others:
            albums_repo.update_album(album.id, artist=", ".join(others))
            trimmed_albums += 1
        else:
            ids, errs = purge_album(album.id)
            deleted_tracks += ids
            errors += errs
            if not errs:
                deleted_albums += 1
    if not errors:
        circles.delete_circle(circle.id)
    return {
        "deleted_albums": deleted_albums,
        "trimmed_albums": trimmed_albums,
        "deleted_tracks": deleted_tracks,
        "errors": errors,
    }
