"""오디오 스트리밍(Range 지원 필수) 및 앨범아트 API."""

from __future__ import annotations

import re
from pathlib import Path

from flask import Blueprint, Response, abort, send_file

from lyricstorage.models import read_album_art
from lyricstorage.web.lookup import find_track_by_id

bp = Blueprint("media", __name__, url_prefix="/api/tracks")

_MIME_BY_EXT = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4"}
_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_filename(name: str) -> str:
    """다운로드 파일명으로 쓸 수 없는 문자를 치환한다(Windows 기준이 가장 엄격)."""
    cleaned = _INVALID_FILENAME_CHARS.sub("_", name).strip(" .")
    return cleaned or "untitled"


def _sniff_image_mimetype(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return "image/jpeg"


@bp.get("/<track_id>/audio")
def get_audio(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        abort(404)
    path = Path(track.path)
    if not path.exists():
        abort(404)
    mimetype = _MIME_BY_EXT.get(path.suffix.lower(), "application/octet-stream")
    # conditional=True -> Werkzeug가 Range 요청/206 Partial Content를 자동 처리한다.
    # <audio> 탐색바가 정상 동작하려면 필수.
    return send_file(path, mimetype=mimetype, conditional=True)


@bp.get("/<track_id>/art")
def get_art(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        abort(404)
    art_bytes = read_album_art(track.path)
    if not art_bytes:
        abort(404)
    return Response(art_bytes, mimetype=_sniff_image_mimetype(art_bytes))


@bp.get("/<track_id>/download")
def download_track(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        abort(404)
    path = Path(track.path)
    if not path.exists():
        abort(404)
    # 저장소의 실제 파일명은 해시라 그대로 내려주면 알아볼 수 없으므로,
    # 제목/아티스트로 사람이 알아볼 수 있는 다운로드 이름을 만든다.
    base = " - ".join(part for part in (track.title, track.artist) if part) or path.stem
    download_name = sanitize_filename(base) + path.suffix
    return send_file(path, as_attachment=True, download_name=download_name)
