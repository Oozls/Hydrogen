"""라이브러리(기본 플레이리스트) 조회 및 업로드 API. 오직 이 라우트만 파일 업로드를 허용한다."""

from __future__ import annotations

import json
import tempfile
import threading
from dataclasses import replace
from pathlib import Path

from flask import Blueprint, abort, jsonify, request, send_file

from lyricstorage import albums as albums_repo
from lyricstorage import applog, storage
from lyricstorage import circles as circles_repo
from lyricstorage.models import (
    GLOBAL_PLAYLIST_NAME,
    SUPPORTED_EXTENSIONS,
    PlaylistModel,
    Track,
    read_album_art,
    read_tags,
    write_tags,
)
from lyricstorage.web import library as library_adapter
from lyricstorage.web import playlist_repo
from lyricstorage.web.routes.media import _MIME_BY_EXT
from lyricstorage.web.serialize import playlist_to_json, track_to_json

bp = Blueprint("library", __name__, url_prefix="/api/library")


def _circle_name_for(track: Track, album_by_id: dict, circle_resolver: dict) -> str:
    album = album_by_id.get(track.album_id)
    artist = album.artist if album else track.artist
    return circle_resolver.get(artist, artist)


@bp.get("")
def get_library():
    playlist = playlist_repo.load_or_create_global()
    return jsonify(playlist_to_json(playlist))


@bp.post("/upload")
def upload_files():
    playlist = playlist_repo.load_or_create_global()
    target_name = (request.form.get("playlist") or "").strip()
    target_playlist = (
        playlist_repo.load_playlist(target_name)
        if target_name and target_name != GLOBAL_PLAYLIST_NAME
        else None
    )
    files = request.files.getlist("files[]") or request.files.getlist("files")

    # 이번 업로드로 새로 생겨난 앨범을 가려내려면, 파일을 추가하기 전(=아직 아무
    # 앨범도 새로 만들어지지 않은 시점)의 앨범 id 집합을 미리 찍어둬야 한다.
    existing_album_ids = {a.id for a in albums_repo.load_albums()}

    added, skipped = [], []
    for file_storage in files:
        if not file_storage or not file_storage.filename:
            continue
        try:
            track = library_adapter.add_uploaded_file(playlist, file_storage)
            added.append(track_to_json(track))
            if target_playlist is not None:
                target_playlist.tracks.append(replace(track))
        except (ValueError, OSError) as exc:
            skipped.append({"filename": file_storage.filename, "reason": str(exc)})

    albums_missing_art = []
    new_albums = []
    if added:
        playlist.save()
        if target_playlist is not None:
            target_playlist.save()
        touched_album_ids = list(dict.fromkeys(t["album_id"] for t in added if t.get("album_id")))
        for album_id in touched_album_ids:
            album = albums_repo.find_album_by_id(album_id)
            if album is None:
                continue
            # 이번 업로드로 새로 생긴 앨범은 앨범 아티스트를 곡 아티스트로
            # 추측해 채워둔 상태라, 프런트에 알려 사용자가 확인/수정하게 한다.
            if album_id not in existing_album_ids:
                new_albums.append(
                    {"album_id": album.id, "name": album.name, "artist": album.artist, "year": album.year}
                )
            # 이번에 곡이 추가된 앨범 중 아직 전용 표지가 없는 앨범을 찾아 프런트에
            # 알려준다(곡 내부 표지를 쓸지, 따로 업로드할지 사용자가 고를 수 있도록).
            if album.art_ext:
                continue
            member_tracks = [t for t in playlist.tracks if t.album_id == album_id]
            has_embedded_art = any(read_album_art(t.path) for t in member_tracks)
            albums_missing_art.append(
                {
                    "album_id": album.id,
                    "name": album.name,
                    "artist": album.artist,
                    "has_embedded_art": has_embedded_art,
                }
            )
    applog.log_info(
        "ACTION",
        f"곡 업로드: 총 {len(files)}개 중 성공 {len(added)}개, 스킵 {len(skipped)}개"
        + (f" (대상 재생목록={target_name})" if target_playlist is not None else ""),
    )
    return jsonify(
        {
            "added": added,
            "skipped": skipped,
            "albums_missing_art": albums_missing_art,
            "new_albums": new_albums,
        }
    )


_REBUILD_LOG_LIMIT = 200


def _write_rebuild_status(data: dict) -> None:
    storage.write_json_atomic(storage.rebuild_status_path(), data)


def _read_rebuild_status() -> dict:
    path = storage.rebuild_status_path()
    if not path.exists():
        return {"running": False, "done": False, "processed": 0, "total": 0, "log": [], "result": None}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {"running": False, "done": False, "processed": 0, "total": 0, "log": [], "result": None}


def _run_rebuild() -> None:
    """백그라운드 스레드에서 실제 재작성을 수행하며, 진행 중에도 다른 요청(상태
    폴링)이 값을 읽을 수 있도록 status 파일에 계속 진행 상황을 기록한다."""
    log: list[str] = []

    def emit(line: str, processed: int, total: int, done: bool = False, result=None) -> None:
        log.append(line)
        del log[:-_REBUILD_LOG_LIMIT]
        _write_rebuild_status(
            {"running": not done, "done": done, "processed": processed, "total": total, "log": list(log), "result": result}
        )

    try:
        old_playlist = playlist_repo.load_playlist(GLOBAL_PLAYLIST_NAME)
        old_ratings = {t.path: t.rating for t in old_playlist.tracks} if old_playlist else {}

        found = sorted(p for ext in SUPPORTED_EXTENSIONS for p in storage.songs_dir().glob(f"*{ext}"))
        total = len(found)
        emit(f"음원 파일 {total}개 발견, 태그 읽는 중...", 0, total)

        playlist = PlaylistModel(GLOBAL_PLAYLIST_NAME)
        skipped = []
        for i, audio_path in enumerate(found, start=1):
            # add_file()은 내용 해시를 다시 계산해 "이미 라이브러리에 있는 파일인지"
            # 확인하는데, 여기서 스캔하는 파일은 이미 그 해시 이름으로 songs_dir에
            # 자리잡고 있어 매번 다시 해시할 필요가 없다.
            try:
                track = Track.from_file(str(audio_path))
            except OSError as exc:
                skipped.append({"filename": audio_path.name, "reason": str(exc)})
                emit(f"[스킵] {audio_path.name}: {exc}", i, total)
                continue
            if track.path in old_ratings:
                track.rating = old_ratings[track.path]
            playlist.tracks.append(track)
            if i % 10 == 0 or i == total:
                emit(f"태그 읽는 중... ({i}/{total})", i, total)

        circle_resolver = circles_repo.name_resolver()
        album_by_id = {a.id: a for a in albums_repo.load_albums()}

        def circle_for(track: Track) -> str:
            return _circle_name_for(track, album_by_id, circle_resolver)

        # 제목/아티스트/서클/앨범이 전부 같은 곡이 여러 파일로 있으면 일단 "의심"
        # 후보로 묶는다. 태그만으로는 진짜 같은 파일인지 알 수 없으므로(예: 우연히
        # 태그가 겹치는 다른 곡), 후보 안에서만 내용 해시를 비교해 실제로 바이트가
        # 완전히 같은 것끼리만 진짜 중복으로 확정한다. 확정된 중복은 하나만 남기고
        # 나머지는 지우지 않고 data/trash로 옮긴다(복구 가능하게).
        by_key: dict[tuple[str, str, str, str], list[Track]] = {}
        for track in playlist.tracks:
            by_key.setdefault((track.title, track.artist, circle_for(track), track.album), []).append(track)

        tag_matched_groups = [g for g in by_key.values() if len(g) > 1]
        if tag_matched_groups:
            emit(
                f"제목/아티스트/서클/앨범이 같은 곡 {len(tag_matched_groups)}건 발견, "
                "실제 파일 내용이 같은지 확인 중...",
                total,
                total,
            )

        deduped: list[Track] = []
        duplicates = []
        distinct_despite_same_tags = 0
        for group in by_key.values():
            if len(group) == 1:
                deduped.append(group[0])
                continue
            by_hash: dict[str, list[Track]] = {}
            for t in group:
                by_hash.setdefault(storage.file_content_hash(t.path), []).append(t)
            for file_hash, sub in by_hash.items():
                if len(sub) == 1:
                    deduped.append(sub[0])
                    distinct_despite_same_tags += 1
                    continue
                kept = next((t for t in sub if t.path in old_ratings), sub[0])
                deduped.append(kept)
                removed = [t for t in sub if t is not kept]
                moved_files = []
                for t in removed:
                    size_bytes = Path(t.path).stat().st_size
                    storage.move_to_trash(Path(t.path))
                    moved_files.append({"filename": Path(t.path).name, "size_bytes": size_bytes, "duration_ms": t.duration_ms})
                emit(
                    f"[중복 확정] {kept.title} — 내용까지 동일한 파일 {len(sub)}개 중 "
                    f"{len(removed)}개를 data/trash로 이동",
                    total,
                    total,
                )
                duplicates.append(
                    {
                        "title": kept.title,
                        "artist": kept.artist,
                        "album": kept.album,
                        "circle": circle_for(kept),
                        "kept_file": {
                            "filename": Path(kept.path).name,
                            "size_bytes": Path(kept.path).stat().st_size,
                            "duration_ms": kept.duration_ms,
                        },
                        "moved_files": moved_files,
                    }
                )
        if distinct_despite_same_tags:
            emit(
                f"태그는 같지만 실제 파일 내용은 달라 그대로 둔 곡: {distinct_despite_same_tags}개",
                total,
                total,
            )
        if duplicates:
            emit(f"중복 확정 및 정리: {len(duplicates)}곡", total, total)
        playlist.tracks = deduped

        # 스캔 순서(해시 파일명)는 사실상 무작위라, 서클(앨범 아티스트) -> 앨범 ->
        # 곡 제목 순으로 다시 정렬해 브라우즈 화면의 그룹핑과 결이 맞게 만든다.
        emit("서클/앨범 순으로 정렬 중...", total, total)

        def sort_key(track):
            album = album_by_id.get(track.album_id)
            album_name = album.name if album else track.album
            # 태그에 트랙 번호가 있으면 그 순서를 따르고, 없거나(0) 같으면
            # 제목으로 묶어 정렬한다.
            return (circle_for(track), album_name, track.track_no, track.title)

        playlist.tracks.sort(key=sort_key)

        emit("저장 중...", total, total)
        playlist.save()

        applog.log_info(
            "ACTION",
            f"글로벌 플레이리스트 재작성: {len(playlist.tracks)}곡, 스킵 {len(skipped)}개, "
            f"중복 제거 {len(duplicates)}곡",
        )
        result = {"track_count": len(playlist.tracks), "skipped": skipped, "duplicates": duplicates}
        emit(f"완료: {len(playlist.tracks)}곡", total, total, done=True, result=result)
    except Exception as exc:  # noqa: BLE001 - 백그라운드 스레드라 예외를 그냥 두면 조용히 사라진다.
        applog.log_error("ACTION", f"글로벌 플레이리스트 재작성 실패: {exc}")
        emit(f"오류로 중단됨: {exc}", 0, 0, done=True, result={"error": str(exc)})


@bp.post("/rebuild")
def rebuild_global():
    """data/songs 폴더(음원 실 파일)를 다시 스캔해 글로벌 플레이리스트 인덱스를
    통째로 재구성한다. 인덱스 파일이 유실/손상됐을 때 쓰는 복구용 기능이라, 파일
    태그에 없는 레이팅만 기존 값에서 되살리고 나머지(재생목록 구성 등)는 각자
    다시 정리해야 한다.

    라이브러리가 크면 태그를 전부 다시 읽는 데 리버스 프록시 타임아웃을 넘길
    만큼 걸릴 수 있어(예전 504 원인), 백그라운드 스레드에서 돌리고 이 요청은
    바로 응답한다. 진행 상황은 GET /api/library/rebuild/status로 폴링한다."""
    current = _read_rebuild_status()
    if current.get("running"):
        return jsonify({**current, "error": "이미 재작성이 진행 중입니다."}), 409

    _write_rebuild_status(
        {"running": True, "done": False, "processed": 0, "total": 0, "log": ["재작성을 시작합니다..."], "result": None}
    )
    threading.Thread(target=_run_rebuild, daemon=True).start()
    return jsonify(_read_rebuild_status()), 202


@bp.get("/rebuild/status")
def rebuild_status():
    return jsonify(_read_rebuild_status())


def _resolve_song_path(filename: str) -> Path:
    """data/songs 또는 data/trash 밖으로 못 나가게 막고, 실제 존재하는 파일만
    돌려준다(없으면 404). trash도 뒤지는 이유는 재작성이 중복 확정 파일을 거기로
    옮기는데, 결과 다이얼로그에서 그 파일도 미리듣기할 수 있어야 하기 때문."""
    for base in (storage.songs_dir(), storage.trash_dir()):
        path = base / filename
        if path.resolve().parent == base.resolve() and path.is_file():
            return path
    abort(404)


@bp.get("/trash")
def list_trash():
    """휴지통(data/trash)의 파일들을, 현재 라이브러리에 남아있는 대응 곡과 나란히
    비교해볼 수 있게 목록으로 돌려준다. 재작성 중 자동 확정된 중복 정리가 맞는지
    사용자가 직접 들어보고 확인하고 싶을 때 쓴다."""
    playlist = playlist_repo.load_or_create_global()
    by_key: dict[tuple[str, str, str], Track] = {}
    for t in playlist.tracks:
        by_key.setdefault((t.title, t.artist, t.album), t)

    circle_resolver = circles_repo.name_resolver()
    album_by_id = {a.id: a for a in albums_repo.load_albums()}

    trash_files = sorted(p for ext in SUPPORTED_EXTENSIONS for p in storage.trash_dir().glob(f"*{ext}"))
    items = []
    for path in trash_files:
        tags = read_tags(str(path))
        match = by_key.get((tags["title"], tags["artist"], tags["album"]))
        kept_file = None
        if match is not None and Path(match.path).is_file():
            kept_file = {
                "filename": Path(match.path).name,
                "size_bytes": Path(match.path).stat().st_size,
                "duration_ms": match.duration_ms,
                "circle": _circle_name_for(match, album_by_id, circle_resolver),
            }
        items.append(
            {
                "trash_file": {
                    "filename": path.name,
                    "size_bytes": path.stat().st_size,
                    "duration_ms": tags["duration_ms"],
                    "title": tags["title"],
                    "artist": tags["artist"],
                    "album": tags["album"],
                },
                "kept_file": kept_file,
            }
        )
    return jsonify({"items": items})


@bp.get("/songs/<filename>/audio")
def get_song_file_audio(filename: str):
    """data/songs 안의 파일을 파일명(내용 해시)만으로 바로 스트리밍한다. 재작성
    중복 검토처럼, 아직 어느 플레이리스트에도 속하지 않은(그래서 track_id로는
    못 찾는) 파일을 미리듣기할 때 쓴다."""
    path = _resolve_song_path(filename)
    mimetype = _MIME_BY_EXT.get(path.suffix.lower(), "application/octet-stream")
    return send_file(path, mimetype=mimetype, conditional=True)


@bp.post("/reimport-artists")
def reimport_artists():
    """앨범 아티스트 개념이 생기기 전, 곡 아티스트를 전부 앨범 아티스트로 덮어써
    통일했던 라이브러리를 위한 일회성 복구 도구. 아직 원본 태그가 살아있는 원본
    파일들을(라이브러리에 새로 추가하는 게 아니라 읽기 전용으로) 받아 (제목, 앨범)이
    일치하는 기존 곡을 찾고, 그 곡의 아티스트만 원본 파일의 아티스트 태그로 되돌린다."""
    playlist = playlist_repo.load_or_create_global()

    by_key: dict[tuple[str, str], list] = {}
    for track in playlist.tracks:
        by_key.setdefault((track.title.strip(), track.album.strip()), []).append(track)

    files = request.files.getlist("files[]") or request.files.getlist("files")

    updated, unmatched, ambiguous = [], [], []
    for file_storage in files:
        if not file_storage or not file_storage.filename:
            continue
        suffix = Path(file_storage.filename).suffix.lower()
        if suffix not in SUPPORTED_EXTENSIONS:
            continue

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp_path = tmp.name
        try:
            file_storage.save(tmp_path)
            tags = read_tags(tmp_path)
        finally:
            Path(tmp_path).unlink(missing_ok=True)

        new_artist = tags["artist"].strip()
        if not new_artist:
            continue

        candidates = by_key.get((tags["title"].strip(), tags["album"].strip())) or []
        track = None
        if len(candidates) == 1:
            track = candidates[0]
        elif len(candidates) > 1:
            # 같은 (제목, 앨범)의 곡이 여럿이면(예: 컴필레이션 중복) 재생시간이
            # 가장 근접한 하나만 명확히 특정되는 경우에 한해 매칭한다.
            close = [t for t in candidates if abs(t.duration_ms - tags["duration_ms"]) <= 2000]
            if len(close) == 1:
                track = close[0]

        if track is None:
            (ambiguous if candidates else unmatched).append(file_storage.filename)
            continue
        if track.artist == new_artist:
            continue

        try:
            write_tags(track.path, title=track.title, artist=new_artist, album=track.album)
        except OSError as exc:
            unmatched.append(f"{file_storage.filename} ({exc})")
            continue
        playlist_repo.update_track_in_all_playlists(track.path, artist=new_artist)
        track.artist = new_artist
        updated.append({"title": track.title, "album": track.album, "artist": new_artist})

    applog.log_info(
        "ACTION",
        f"곡 아티스트 재가져오기: {len(updated)}곡 갱신, 매칭 실패 {len(unmatched)}개, 모호 {len(ambiguous)}개",
    )
    return jsonify({"updated": updated, "unmatched": unmatched, "ambiguous": ambiguous})
