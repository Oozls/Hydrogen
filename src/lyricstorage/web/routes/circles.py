"""서클(앨범 아티스트) 이명(별칭)/대표 이름 관리 API. 구현은 _identity.py 공용."""

from __future__ import annotations

from flask import jsonify

from lyricstorage import applog
from lyricstorage import circles as circles_repo
from lyricstorage.web.purge import purge_circle
from lyricstorage.web.routes._identity import make_identity_blueprint

bp = make_identity_blueprint("circle", "circles", circles_repo._registry)


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
