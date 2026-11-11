"""이미지/오디오 MIME 판별과 표지 업로드 검증 공용 헬퍼."""

from __future__ import annotations

from typing import Optional

from flask import jsonify, request

AUDIO_MIME_BY_EXT = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4"}

ALLOWED_ART_MIME = {"image/jpeg", "image/png"}


def sniff_image_mimetype(data: bytes) -> str:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return "image/jpeg"


def sniff_image_ext(data: bytes) -> str:
    """앨범 표지 파일 확장자: PNG면 "png", 그 외는 모두 "jpg"."""
    return "png" if sniff_image_mimetype(data) == "image/png" else "jpg"


def read_art_upload() -> tuple[Optional[bytes], Optional[str], Optional[tuple]]:
    """요청의 "art" 파일을 읽어 검증한다. (bytes, mime, None) 또는
    (None, None, (응답, 상태코드))를 돌려준다."""
    file_storage = request.files.get("art")
    if not file_storage or not file_storage.filename:
        return None, None, (jsonify({"error": "이미지 파일이 필요합니다."}), 400)

    image_bytes = file_storage.read()
    mime = sniff_image_mimetype(image_bytes)
    if mime not in ALLOWED_ART_MIME:
        return None, None, (jsonify({"error": "JPEG 또는 PNG 이미지만 지원합니다."}), 400)
    return image_bytes, mime, None
