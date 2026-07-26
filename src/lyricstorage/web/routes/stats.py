"""재생 통계 API."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage import stats

bp = Blueprint("stats", __name__, url_prefix="/api/stats")


@bp.post("/plays")
def log_play_event():
    data = request.get_json(silent=True) or {}
    track_id = str(data.get("track_id") or "").strip()
    if not track_id:
        return jsonify({"error": "track_id가 필요합니다."}), 400

    try:
        listened_ms = max(0, int(data.get("listened_ms") or 0))
    except (TypeError, ValueError):
        listened_ms = 0

    entry = stats.log_play(
        track_id,
        str(data.get("title") or ""),
        str(data.get("artist") or ""),
        str(data.get("album") or ""),
        listened_ms=listened_ms,
    )
    return jsonify(entry), 201


@bp.get("/top")
def get_top():
    period = request.args.get("period", "day")
    group = request.args.get("group", "track")
    if period not in stats.PERIODS:
        return jsonify({"error": "period는 day/week/month 중 하나여야 합니다."}), 400
    if group not in stats.GROUPS:
        return jsonify({"error": "group은 track/artist/album 중 하나여야 합니다."}), 400

    try:
        offset = max(0, int(request.args.get("offset", 0)))
    except ValueError:
        offset = 0

    # "곡" 그룹은 최근 재생 목록으로 쓰이므로 개수 제한을 두지 않고, 화면에서
    # 페이지 단위로 나눠 보여준다. 아티스트/앨범은 여전히 상위 20개만 보여준다.
    limit = None if group == "track" else 20
    return jsonify(stats.top(period, group, offset, limit=limit))
