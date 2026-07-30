"""Flask 앱 팩토리."""

from __future__ import annotations

import time
import traceback
from pathlib import Path

from flask import Flask, g, request

from lyricstorage import applog, lyrics_io

_PACKAGE_ROOT = Path(__file__).resolve().parent


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=str(_PACKAGE_ROOT / "templates"),
        static_folder=str(_PACKAGE_ROOT / "static"),
    )

    moved = lyrics_io.migrate_legacy_lyrics()
    if moved:
        applog.log_info("STARTUP", f"가사 파일 {moved}개를 data/lyrics/로 이전했습니다.")
    # Werkzeug 3.1부터 multipart 요청의 파트 수 기본 상한이 1000개라, 폴더 업로드로
    # 곡을 1000개 넘게 한 번에 선택하면 파일 크기와 무관하게 413로 거부된다.
    # 로컬 개인용 라이브러리 앱이라 큰 폴더도 문제없이 올릴 수 있게 넉넉히 늘린다.
    app.config["MAX_FORM_PARTS"] = 20000
    # 업로드 요청 본문(폴더 통째 업로드 등) 최대 크기를 2048MB로 설정.
    app.config["MAX_CONTENT_LENGTH"] = 2048 * 1024 * 1024

    @app.before_request
    def _log_request_start():
        g._log_start = time.monotonic()

    @app.after_request
    def _log_request_end(response):
        started = getattr(g, "_log_start", None)
        duration_ms = int((time.monotonic() - started) * 1000) if started is not None else 0
        applog.log_info(
            "REQUEST", f"{request.method} {request.path} -> {response.status_code} ({duration_ms}ms)"
        )
        return response

    @app.teardown_request
    def _log_request_error(exc):
        if exc is None:
            return
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        applog.log_error("ERROR", f"{request.method} {request.path} 처리 중 예외 발생\n{tb}")

    from lyricstorage.web.routes import register_routes

    register_routes(app)
    return app
