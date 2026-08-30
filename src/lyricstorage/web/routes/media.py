"""오디오 스트리밍(Range 지원 필수) 및 앨범아트 API."""

from __future__ import annotations

import re
from pathlib import Path

from flask import Blueprint, Response, abort, request, send_file

from lyricstorage.models import read_album_art, resize_image_bytes
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
    # <audio> 탐색바가 정상 동작하려면 필수. max_age를 줘서 같은 곡을 다시 재생할
    # 때(반복재생 등) 매번 새로 안 받고 캐시에서 바로 재생되게 한다.
    return send_file(path, mimetype=mimetype, conditional=True, max_age=3600)


@bp.get("/<track_id>/art")
def get_art(track_id: str):
    track = find_track_by_id(track_id)
    if track is None:
        abort(404)
    path = Path(track.path)
    # 재생바/목록처럼 작게 표시되는 자리는 ?size=로 축소본을 요청한다(원본을
    # 그대로 내려주면 모바일에서 트랙 전환마다 그 큰 파일이 오디오 스트림과
    # 대역폭을 다퉈 표지 로딩이 특히 느려진다).
    size = request.args.get("size", type=int)
    try:
        etag = f'"{track_id}-{path.stat().st_mtime_ns}-{size or "orig"}"'
    except OSError:
        abort(404)
    # 목록 화면 하나에 표지 요청이 수십 개씩 걸리는데, 태그를 매번 다시 읽지
    # 않고도(=디스크 IO 없이) 안 바뀌었으면 304로 끝낼 수 있어 저사양 VM/느린
    # 네트워크 양쪽에 다 도움이 된다.
    if request.headers.get("If-None-Match") == etag:
        return Response(status=304)
    art_bytes = read_album_art(track.path)
    if not art_bytes:
        abort(404)
    mimetype = _sniff_image_mimetype(art_bytes)
    if size:
        art_bytes, mimetype = resize_image_bytes(art_bytes, size)
    resp = Response(art_bytes, mimetype=mimetype)
    resp.headers["Cache-Control"] = "public, max-age=604800"
    resp.headers["ETag"] = etag
    return resp


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
