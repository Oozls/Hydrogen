"""가사 조회/저장 API. 시간 형식(분:초:밀리초) 파싱/검증은 클라이언트에서 수행하고,
여기서는 이미 정수 ms로 정제된 값을 받아 방어적으로만 재검증한다."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage import albums as albums_repo
from lyricstorage import applog, circles, lyrics_io, lyrics_providers, translation
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
    applog.log_info("ACTION", f"가사 저장: {track_id} ({len(lines)}줄)")
    return jsonify(
        {
            "saved_count": len(lines),
            "path": str(saved_path) if saved_path else None,
            "lines": [_line_json(line) for line in lines],
        }
    )


@bp.post("/<track_id>/lyrics/external")
def fetch_external_lyrics(track_id: str):
    """LRCLIB/TouhouDB에서 찾을 수 있는 가사 후보를 전부 조회만 하고 저장은
    하지 않는다 — 두 제공처 모두 가사가 있을 수 있고 TouhouDB는 후보가
    여럿일 수 있으므로, 사용자가 후보를 보고 고른 뒤 PUT /lyrics로 저장한다."""
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404

    album = albums_repo.find_album_by_id(track.album_id) if track.album_id else None
    circle = circles.name_resolver().get(album.artist, album.artist) if album and album.artist else ""

    candidates = lyrics_providers.fetch_lyrics_candidates(track.title, track.artist, circle)
    if not candidates:
        return jsonify({"error": "가사를 찾지 못했습니다."}), 404

    applog.log_info("ACTION", f"외부 가사 후보 조회: {track_id} ({len(candidates)}개)")
    return jsonify(
        {
            "candidates": [
                {
                    "source": c["source"],
                    "synced": c["synced"],
                    "title": c.get("title", ""),
                    "artist": c.get("artist", ""),
                    "album": c.get("album", ""),
                    "lines": [_line_json(LyricLine(ms, text)) for ms, text in c["lines"]],
                }
                for c in candidates
            ]
        }
    )


@bp.post("/<track_id>/lyrics/translate")
def translate_lyrics(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404

    lyric_track = LyricTrack.load_for_track(track.path)
    if not lyric_track.lines:
        return jsonify({"error": "번역할 가사가 없습니다."}), 400

    # 저장된 한 줄(LyricLine)이 항상 실제 가사 한 줄인 건 아니다 — 타임스탬프
    # 없이 통째로 받아온 가사(TouhouDB 등)는 여러 실제 줄이 \n으로만 구분된
    # 채 "하나의 타임스탬프(00:00.00)"에 전부 들어 있다(그 저장 규칙 자체는
    # 그대로 유지한다 — 번역 후에도 LyricLine 개수·타임스탬프는 바뀌지 않는다).
    # 번역만 실제 가사 줄 단위로 해야 하므로, LyricLine 안에서만 펼쳐 번역하고
    # 결과는 그 LyricLine 하나에 다시 합쳐 넣는다. split_original_lines가
    # 발음/번역 줄은 표시 문자로 걸러내고 원문만 돌려주므로(빈 줄은 None),
    # 이미 번역된 가사에 다시 돌려도 항상 원문만 정확히 다시 뽑아 재번역한다.
    groups: list[tuple[int, list[str | None]]] = [
        (line.timestamp_ms, translation.split_original_lines(line.text)) for line in lyric_track.lines
    ]

    flat_originals = [text for _, items in groups for text in items if text is not None]
    try:
        translated = translation.translate_lines(flat_originals)
    except translation.TranslationError as exc:
        return jsonify({"error": str(exc)}), 502

    translated_iter = iter(translated)
    new_lines = []
    for ts, items in groups:
        rebuilt = []
        for text in items:
            if text is None:
                rebuilt.append("")
            else:
                rebuilt.append(translation.format_translated_line(text, next(translated_iter)))
        new_lines.append(LyricLine(ts, "\n".join(rebuilt)))
    saved_path = LyricTrack(track.path, new_lines).save()
    applog.log_info("ACTION", f"AI 가사 번역: {track_id} ({len(new_lines)}줄)")
    return jsonify(
        {
            "saved_count": len(new_lines),
            "path": str(saved_path) if saved_path else None,
            "lines": [_line_json(line) for line in new_lines],
        }
    )


@bp.get("/<track_id>/lyrics/backups")
def list_lyrics_backups(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404
    return jsonify({"backups": lyrics_io.list_backups(track.path)})


@bp.get("/<track_id>/lyrics/backups/<name>")
def get_lyrics_backup(track_id: str, name: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404
    try:
        raw = lyrics_io.read_backup(track.path, name)
    except FileNotFoundError:
        return jsonify({"error": "백업을 찾을 수 없습니다."}), 404
    lines = [LyricLine(ms, text) for ms, text in raw]
    return jsonify({"lines": [_line_json(line) for line in lines]})


@bp.post("/<track_id>/lyrics/backups/<name>/restore")
def restore_lyrics_backup(track_id: str, name: str):
    track = find_track_by_id(track_id)
    if track is None:
        return jsonify({"error": "트랙을 찾을 수 없습니다."}), 404
    try:
        lyrics_io.restore_backup(track.path, name)
    except FileNotFoundError:
        return jsonify({"error": "백업을 찾을 수 없습니다."}), 404
    lyric_track = LyricTrack.load_for_track(track.path)
    applog.log_info("ACTION", f"가사 백업 복원: {track_id} ({name})")
    return jsonify({"lines": [_line_json(line) for line in lyric_track.lines]})
