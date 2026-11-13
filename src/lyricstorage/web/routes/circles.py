"""서클(앨범 아티스트) 이명(별칭)/대표 이름 관리 API. 구현은 _identity.py 공용."""

from __future__ import annotations

import tempfile
import zipfile
from collections import defaultdict

from flask import jsonify, send_file

from lyricstorage import albums as albums_repo
from lyricstorage import applog
from lyricstorage import circles as circles_repo
from lyricstorage.web import playlist_repo
from lyricstorage.web.purge import purge_circle
from lyricstorage.web.routes._identity import make_identity_blueprint
from lyricstorage.web.routes.albums import add_tracks_to_zip
from lyricstorage.web.routes.media import sanitize_filename

bp = make_identity_blueprint("circle", "circles", circles_repo._registry)


@bp.get("/<circle_id>/download")
def download_circle(circle_id: str):
    """서클의 모든 앨범(공동 참여 포함)을 앨범명 폴더별로 나눠 zip 하나로 내려준다."""
    circle = circles_repo.find_circle_by_id(circle_id)
    if circle is None:
        return jsonify({"error": "서클을 찾을 수 없습니다."}), 404

    names = {circle.name, *circle.aliases}
    # 앨범마다 find_tracks_by_album_id를 부르면 글로벌 플레이리스트 JSON을 매번
    # 다시 읽으므로, 한 번만 불러와 앨범별로 묶는다.
    tracks_by_album: dict[str, list] = defaultdict(list)
    for track in playlist_repo.load_or_create_global().tracks:
        tracks_by_album[track.album_id].append(track)

    # 서클 전체는 수 GB가 될 수 있어 메모리 대신 임시 파일에 쓴다(닫히면 자동 삭제).
    tmp = tempfile.TemporaryFile()
    used_names: set[str] = set()
    used_folders: set[str] = set()
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as zf:
            for album in albums_repo.load_albums():
                if not any(n in names for n in circles_repo.split_names(album.artist)):
                    continue
                tracks = tracks_by_album.get(album.id, [])
                if not tracks:
                    continue
                # 같은 이름의 앨범이 여럿이면 폴더가 섞이지 않게 번호를 붙인다.
                base = sanitize_filename(album.name or "(앨범 없음)")
                folder, i = base, 2
                while folder in used_folders:
                    folder = f"{base} ({i})"
                    i += 1
                used_folders.add(folder)
                add_tracks_to_zip(zf, tracks, folder, used_names)
        if not used_names:
            tmp.close()
            return jsonify({"error": "해당 서클의 곡을 찾을 수 없습니다."}), 404
        tmp.seek(0)
    except Exception:
        tmp.close()
        raise

    applog.log_info("ACTION", f"서클 다운로드: {circle.name}, {len(used_folders)}앨범/{len(used_names)}곡")
    zip_name = sanitize_filename(circle.name) + ".zip"
    return send_file(tmp, as_attachment=True, download_name=zip_name, mimetype="application/zip")


@bp.delete("/<circle_id>")
def delete_circle(circle_id: str):
    """서클 삭제: 단독 앨범은 곡 파일까지 완전 삭제, 공동 참여 앨범은 이 서클 이름만 뺀다."""
    circle = circles_repo.find_circle_by_id(circle_id)
    if circle is None:
        return jsonify({"error": "서클을 찾을 수 없습니다."}), 404
    result = purge_circle(circle)
    applog.log_info(
        "ACTION",
        f"서클 삭제: {circle.name}, 앨범 {result['deleted_albums']}개/{len(result['deleted_tracks'])}곡 삭제, "
        f"공동 앨범 {result['trimmed_albums']}개에서 이름 제거, 실패 {len(result['errors'])}곡",
    )
    if result["errors"]:
        return jsonify({"error": f"{len(result['errors'])}곡은 삭제하지 못했습니다.", **result}), 500
    return jsonify({"ok": True, **result})
