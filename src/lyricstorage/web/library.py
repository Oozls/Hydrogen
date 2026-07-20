"""업로드된 파일 스트림을 기존 PlaylistModel.add_file(경로 기반) API로 연결하는 어댑터.

원본 데스크톱 앱은 로컬 파일 경로를 참조했지만, 웹에서는 브라우저가 보낸
업로드 스트림만 있다. 임시 파일로 받아쓴 뒤 기존의 검증된 해시-복사-태그읽기
로직(models.PlaylistModel.add_file)을 그대로 재사용하고, 임시 파일은 정리한다.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from werkzeug.datastructures import FileStorage

from lyricstorage.models import SUPPORTED_EXTENSIONS, PlaylistModel, Track


def add_uploaded_file(playlist: PlaylistModel, file_storage: FileStorage) -> Track:
    suffix = Path(file_storage.filename or "").suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"지원하지 않는 파일 형식입니다: {suffix or '(확장자 없음)'}")

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
    try:
        file_storage.save(tmp_path)
        return playlist.add_file(tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)
