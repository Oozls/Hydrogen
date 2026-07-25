"""Flask 앱 팩토리."""

from __future__ import annotations

import time
import traceback
from pathlib import Path

from flask import Flask, g, request

from lyricstorage import applog

_PACKAGE_ROOT = Path(__file__).resolve().parent


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=str(_PACKAGE_ROOT / "templates"),
        static_folder=str(_PACKAGE_ROOT / "static"),
    )

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
