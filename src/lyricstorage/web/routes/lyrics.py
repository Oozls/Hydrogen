"""가사 조회/저장 API. 시간 형식(분:초:밀리초) 파싱/검증은 클라이언트에서 수행하고,
여기서는 이미 정수 ms로 정제된 값을 받아 방어적으로만 재검증한다."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage.markdown_render import to_html
from lyricstorage.models import LyricLine, LyricTrack
from lyricstorage.web.lookup import find_track_by_id

bp = Blueprint("lyrics", __name__, url_prefix="/api/tracks")


def _line_json(line: LyricLine) -> dict:
    return {"timestamp_ms": line.timestamp_ms, "text": line.text, "html": to_html(line.text)}


@bp.get("/<track_id>/lyrics")
def get_lyrics(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404
    lyric_track = LyricTrack.load_for_track(track.path)
    return jsonify({"lines": [_line_json(line) for line in lyric_track.lines]})


@bp.put("/<track_id>/lyrics")
def save_lyrics(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404

    data = request.get_json(silent=True) or {}
    lines: list[LyricLine] = []
    for entry in data.get("lines") or []:
        try:
            ms = int(entry.get("timestamp_ms"))
        except (TypeError, ValueError):
            continue
        text = str(entry.get("text") or "").strip()
        if not text:
            continue
        # 텍스트 칸에 실제 Enter 대신 리터럴 "\n"을 직접 입력한 경우도 줄바꿈으로
        # 정규화한다. 그래야 저장 직후 응답(html)과 재조회 결과가 항상 일치한다.
        text = text.replace("\\n", "\n")
        lines.append(LyricLine(ms, text))
    lines.sort(key=lambda line: line.timestamp_ms)

    lyric_track = LyricTrack(track.path, lines)
    saved_path = lyric_track.save()
    return jsonify(
        {
            "saved_count": len(lines),
            "path": str(saved_path),
            "lines": [_line_json(line) for line in lines],
        }
    )
